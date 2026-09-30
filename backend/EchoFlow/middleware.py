"""Correlation-ID middleware.

Reads/generates an X-Request-ID header for every HTTP request, attaches
it to the request, and echoes it in the response. A logging filter
(see settings.LOGGING) injects the same id into every log line
emitted during the request so a worker crash can be traced back to
the originating request.

Why: when Celery's process_audio_to_hls fails for clip UUID X in
production, the worker log line currently has no link to the
originating HTTP request. Without a correlation id, debugging
requires grep + guesswork across the request_id-less JSON logs.

Companion: backend.EchoFlow.correlation module (contextvar store).
"""
import logging
import re
import uuid

from .client_ip import get_client_ip
from .correlation import set_correlation_id, clear_correlation_id
from .logging_filters import set_audit_identity, clear_audit_identity

logger = logging.getLogger(__name__)

#: Hard upper bound on any client-supplied correlation id. Must equal
#: ``models.AuditLog.correlation_id.max_length``; pinned by
#: ``tests/test_audit_log_integrity.py::TestColumnWidthContract`` so the two
#: cannot drift apart silently.
MAX_CORRELATION_ID_LEN = 64

#: C0 controls + DEL. Stripped from the id before it is published: these are
#: header-injection bytes, and ``response['X-Request-ID'] = <value>`` raises
#: ``BadHeaderError`` on CR/LF — outside the ``finally`` below, so the caller
#: got an unhandled 500 from a single header. They are also a log-injection
#: vector, since the id is interpolated into every JSON log line.
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')


def _bounded_correlation_id(raw):
    """Return a ``str`` correlation id that is safe to store, log and echo.

    DECISION: **truncate, do not substitute.** The over-length case keeps the
    first ``MAX_CORRELATION_ID_LEN`` characters of what the client sent.
    Substituting a freshly generated id was rejected because the response
    would then carry an id the client never sent, breaking the one thing the
    header is for: a client that logs the response id must be able to join its
    own log line to the server's. Truncation keeps request/response/audit
    correlation identical and, since real ids are ``uuid4().hex`` (32 chars) or
    short opaque tokens, is lossless for every legitimate caller.

    Truncation cannot let an attacker forge an audit trail they could not
    already forge: an attacker who wants a chosen ``correlation_id`` simply
    sends a chosen 64-character one. The bound is a *storage* and
    *log-amplification* control, not an anti-forgery one.

    Truncation at the write alone would NOT have been sufficient. This runs
    once at the source so the bounded value is what reaches the contextvar
    (hence every log line), ``request.correlation_id``, the response header and
    the INSERT — an 8 KB header would otherwise be replayed into every JSON log
    line emitted during the request.
    """
    if raw is not None and not isinstance(raw, str):
        # WSGI guarantees str, but slicing a bare int with [:N] raises
        # TypeError, and this must not become a 500. Coerce *before* the
        # falsy check so a non-str mirrors what the wire would have given.
        try:
            raw = str(raw)
        except Exception:
            logger.warning(
                'X-Request-ID could not be coerced to text; generating a new '
                'correlation id instead.', exc_info=True,
            )
            return uuid.uuid4().hex

    if not raw:
        return uuid.uuid4().hex

    cleaned = _CONTROL_CHARS.sub('', raw)
    if not cleaned:
        # A header of only control characters must not blank the id: an empty
        # correlation_id is useless for the trace it exists to provide.
        return uuid.uuid4().hex

    if len(cleaned) > MAX_CORRELATION_ID_LEN:
        # Logged, not echoed: the length is the useful signal, and logging the
        # value would let a client inject arbitrary bytes into the log stream.
        logger.warning(
            'X-Request-ID truncated from %d to %d characters for correlation '
            'and audit storage.', len(cleaned), MAX_CORRELATION_ID_LEN,
        )
        return cleaned[:MAX_CORRELATION_ID_LEN]

    return cleaned


class CorrelationIdMiddleware:
    HEADER = 'HTTP_X_REQUEST_ID'
    RESPONSE_HEADER = 'X-Request-ID'

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = _bounded_correlation_id(request.META.get(self.HEADER))
        # Bound to the request so views can read it.
        request.correlation_id = request_id
        # Make it available to the logging filter via contextvars.
        set_correlation_id(request_id)
        # DECISION: Attach audit identity (user_id, client_ip, path) to every request so the audit log captures complete identity context without relying on view-level hooks. Tradeoff: middleware runs for every request (including static files and 301 redirects), adding a small overhead per request. See models.py:290-312 (AuditLog) for the DB table design and settings.py:569-572 for the log formatter that consumes these fields.
        user_obj = getattr(request, 'user', None)
        request.user_id = getattr(user_obj, 'id', None) if user_obj is not None else None
        request.client_ip = get_client_ip(request)
        # ISSUE-07 / HACK: Audit identity is set here (before AuthenticationMiddleware runs), so the logging filter records user_id as '-' for logs emitted during request processing. The AuditLog DB entry (written in finally, after auth completes) captures the correct user ID. A production fix should move audit identity update to a process_request hook after AuthenticationMiddleware, or use Django signals (post_auth). Tradeoff: minimal change now vs. complete audit identity in all log lines.
        set_audit_identity(request.user_id, request.client_ip, request.path)
        request.path = request.path
        try:
            response = self.get_response(request)

        finally:
            # ISSUE-07: Write AuditLog entry for identity retention.
            # HACK: Writing in middleware finally ensures audit even on exceptions,
            # but the DB write may fail if the DB is down — accepted, but it is
            # now logged (see the except clause) instead of vanishing.
            try:
                from backend.app.models import AuditLog
                AuditLog.objects.create(
                    # SECURITY: ``user_id``, not ``user``. The column is a
                    # ForeignKey, so passing the raw integer raised
                    # ValueError: Cannot assign "140": "AuditLog.user" must be
                    # a "User" instance -- for EVERY authenticated request --
                    # and the except below swallowed it. The audit table
                    # therefore recorded anonymous traffic and nothing else,
                    # which is a CERT-In / DPDP 5(1) gap, not a cosmetic one.
                    # Anonymous requests were unaffected only because
                    # AnonymousUser.id is None.
                    user_id=getattr(getattr(request, 'user', None), 'id', None),
                    action='view',  # Default; refined by endpoint would require view-level hook
                    endpoint=request.path[:255],
                    ip_address=request.client_ip,
                    user_agent=request.META.get('HTTP_USER_AGENT', '')[:500],
                    # SECURITY (R5-05): bounded here as well as at the source.
                    # This value is client-supplied and the column is
                    # varchar(64): an over-length id raised
                    # StringDataRightTruncation, the bare ``except: pass``
                    # swallowed it, and NO audit row was written — so one
                    # unauthenticated header permanently suppressed the
                    # CERT-In / DPDP 5(1) record for that request. The column
                    # is deliberately NOT widened; an unbounded
                    # client-supplied string in an audit table is a storage
                    # growth vector and this table has no pruning task.
                    correlation_id=request_id[:MAX_CORRELATION_ID_LEN],
                )
            except Exception:
                # SECURITY: Never break the request response for audit failure.
                # Observed, not swallowed: a silent audit failure is
                # indistinguishable from a healthy request, which is how R5-05
                # hid for so long. Runs before clear_correlation_id() below, so
                # the line still carries the correlation id of the request whose
                # audit record is missing.
                logger.exception(
                    'AuditLog write failed for %s; this request is NOT recorded '
                    'in the audit trail.', request.path[:255],
                )
            clear_audit_identity()
            clear_correlation_id()
        response[self.RESPONSE_HEADER] = request_id
        return response
