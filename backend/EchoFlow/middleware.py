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
import uuid

from .client_ip import get_client_ip
from .correlation import set_correlation_id, clear_correlation_id
from .logging_filters import set_audit_identity, clear_audit_identity


class CorrelationIdMiddleware:
    HEADER = 'HTTP_X_REQUEST_ID'
    RESPONSE_HEADER = 'X-Request-ID'

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = request.META.get(self.HEADER) or uuid.uuid4().hex
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
            # but DB write may fail silently if DB is down — acceptable tradeoff.
            try:
                from backend.app.models import AuditLog
                AuditLog.objects.create(
                    user=getattr(getattr(request, 'user', None), 'id', None) if getattr(request, 'user', None) is not None else None,
                    action='view',  # Default; refined by endpoint would require view-level hook
                    endpoint=request.path[:255],
                    ip_address=request.client_ip,
                    user_agent=request.META.get('HTTP_USER_AGENT', '')[:500],
                    correlation_id=request_id,
                )
            except Exception:
                # SECURITY: Never break the request response for audit failure.
                pass
            clear_audit_identity()
            clear_correlation_id()
        response[self.RESPONSE_HEADER] = request_id
        return response
