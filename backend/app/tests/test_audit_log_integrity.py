"""Audit-trail integrity tests for ``CorrelationIdMiddleware``.

R5-05 (docs/frontend/RECON-05-security-abuse.md §A-5). The middleware wrote
``request_id`` — taken verbatim from the client-supplied ``X-Request-ID``
header — into ``AuditLog.correlation_id``, which is ``varchar(64)``:

    correlation_id=request_id,          # no bound
    ...
    except Exception:
        # SECURITY: Never break the request response for audit failure.
        pass

Postgres raises ``StringDataRightTruncation``/``DataError`` for a 65+ char
value, the bare ``except`` swallows it, and **no audit row is written at
all**. So one header from an unauthenticated caller suppressed the CERT-In /
DPDP §5(1) artefact record for a request, permanently, on demand. The
neighbouring fields were already bounded (``endpoint[:255]``,
``user_agent[:500]``) — ``correlation_id`` was the only unbounded one.

These tests pin the *security* property, not the implementation: an
``AuditLog`` row exists for every request whose DB write is attempted, and
the stored value never exceeds the column width.
"""
import logging

import pytest
from django.http import HttpResponse

from backend.EchoFlow.middleware import CorrelationIdMiddleware

pytestmark = pytest.mark.django_db

#: A length comfortably past ``varchar(64)`` and past any legitimate id.
OVERLONG = 'A' * 5000


def _column_width():
    """The real invariant: the width Postgres will accept.

    Read from the model rather than from a constant in the module under test,
    so the security assertions describe the *database* constraint and stay
    meaningful whatever the implementation happens to use.
    """
    from backend.app.models import AuditLog

    return AuditLog._meta.get_field('correlation_id').max_length


COLUMN_WIDTH = _column_width()

#: Scoped so caplog assertions cannot be satisfied by an unrelated logger
#: (``django.request`` logs a WARNING for every 4xx/5xx it handles).
MIDDLEWARE_LOGGER = 'backend.EchoFlow.middleware'


def _drive(**meta):
    """Run one request through the middleware and return ``(response, request)``.

    Mirrors ``test_group_c.py::test_an_audit_row_written_behind_nginx_names_the_client``
    (the existing pattern for exercising the ``finally``-block DB write with a
    ``RequestFactory`` request), but returns the response so the tests can
    assert on the echoed header too.
    """
    from rest_framework.test import APIRequestFactory

    request = APIRequestFactory().get('/probe/', **meta)
    response = CorrelationIdMiddleware(lambda r: HttpResponse('ok'))(request)
    return response, request


# ---------------------------------------------------------------------------
# 1. The normal path is unchanged
# ---------------------------------------------------------------------------
class TestNormalCorrelationId:
    def test_client_supplied_id_is_stored_verbatim(self):
        from backend.app.models import AuditLog

        _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.correlation_id == 'trace-abc-123'

    def test_exactly_one_row_per_request(self):
        from backend.app.models import AuditLog

        _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        assert AuditLog.objects.filter(endpoint='/probe/').count() == 1

    def test_absent_header_is_generated_and_still_audited(self):
        from backend.app.models import AuditLog

        response, _ = _drive()

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.correlation_id == response['X-Request-ID']
        assert row.correlation_id


# ---------------------------------------------------------------------------
# 2. R5-05 core: an over-length header must not suppress the audit row
# ---------------------------------------------------------------------------
class TestOverLengthCorrelationId:
    def test_audit_row_is_still_written(self):
        """The regression. Before the fix this raised DataError inside the
        ``try``, the ``except: pass`` swallowed it, and the count stayed 0."""
        from backend.app.models import AuditLog

        _drive(HTTP_X_REQUEST_ID=OVERLONG)

        assert AuditLog.objects.filter(endpoint='/probe/').count() == 1, (
            'an over-length X-Request-ID suppressed the audit record — this is '
            'R5-05: the CERT-In artefact-integrity control failing open on '
            'attacker input'
        )

    def test_stored_value_respects_the_column_width(self):
        from backend.app.models import AuditLog

        _drive(HTTP_X_REQUEST_ID=OVERLONG)

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.correlation_id
        assert len(row.correlation_id) <= COLUMN_WIDTH

    def test_it_is_a_prefix_of_what_the_client_sent(self):
        """Documents the truncate (not substitute) rule: the audit row keeps
        the first ``COLUMN_WIDTH`` characters of the client's id."""
        from backend.app.models import AuditLog

        _drive(HTTP_X_REQUEST_ID=OVERLONG)

        row = AuditLog.objects.get(endpoint='/probe/')
        assert OVERLONG.startswith(row.correlation_id)

    def test_other_fields_survive_the_over_length_header(self):
        """The row must be a complete audit record, not a stub."""
        from backend.app.models import AuditLog

        _drive(
            HTTP_X_REQUEST_ID=OVERLONG,
            HTTP_USER_AGENT='pytest-audit-agent',
            HTTP_X_REAL_IP='203.0.113.90',
        )

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.user_agent == 'pytest-audit-agent'
        assert row.ip_address == '203.0.113.90'
        assert row.action == 'view'

    def test_distinct_over_length_ids_stay_distinguishable(self):
        """Truncation must not collapse unrelated requests onto one row."""
        from backend.app.models import AuditLog

        prefix = 'B' * (COLUMN_WIDTH - 4)
        _drive(HTTP_X_REQUEST_ID=prefix + '1111')
        _drive(HTTP_X_REQUEST_ID=prefix + '2222')

        ids = set(
            AuditLog.objects.filter(endpoint='/probe/').values_list(
                'correlation_id', flat=True
            )
        )
        assert len(ids) == 2


# ---------------------------------------------------------------------------
# 3. Response correlation survives
# ---------------------------------------------------------------------------
class TestResponseCorrelation:
    def test_response_header_matches_what_was_stored(self):
        from backend.app.models import AuditLog

        response, _ = _drive(HTTP_X_REQUEST_ID=OVERLONG)

        header = response['X-Request-ID']
        assert header, 'the response must still carry a correlation id'
        row = AuditLog.objects.get(endpoint='/probe/')
        assert header == row.correlation_id, (
            'a client that logs the response id must be able to find the '
            'matching audit row'
        )

    def test_response_header_is_bounded_too(self):
        response, request = _drive(HTTP_X_REQUEST_ID=OVERLONG)

        assert len(response['X-Request-ID']) <= COLUMN_WIDTH
        # The value published on the request (what views/log filters read)
        # must be the same bounded string, not the raw header.
        assert request.correlation_id == response['X-Request-ID']

    def test_normal_length_header_is_echoed_unchanged(self):
        response, _ = _drive(HTTP_X_REQUEST_ID='my-trace-123')

        assert response['X-Request-ID'] == 'my-trace-123'

    def test_control_characters_do_not_500_the_request(self):
        """A CR/LF in the value is a header-injection payload, and setting
        such a value on the response raises ``BadHeaderError`` — outside the
        middleware's ``try/finally``, so the caller got an unhandled 500."""
        from backend.app.models import AuditLog

        response, _ = _drive(HTTP_X_REQUEST_ID='abc\r\nX-Injected: 1')

        assert response.status_code == 200
        echoed = response['X-Request-ID']
        assert '\r' not in echoed and '\n' not in echoed
        assert AuditLog.objects.filter(endpoint='/probe/').count() == 1


# ---------------------------------------------------------------------------
# 4. Non-string header values
# ---------------------------------------------------------------------------
class TestNonStringCorrelationId:
    @pytest.mark.parametrize(
        'value',
        [12345, 3.5, b'bytes-id', ['a', 'b'], True],
        ids=['int', 'float', 'bytes', 'list', 'bool'],
    )
    def test_non_string_header_does_not_raise(self, value):
        """WSGI guarantees a ``str``, but the normalisation must not *rely* on
        that: slicing a bare ``int`` with ``[:N]`` raises ``TypeError``."""
        from backend.app.models import AuditLog

        response, _ = _drive(HTTP_X_REQUEST_ID=value)

        assert response.status_code == 200
        row = AuditLog.objects.get(endpoint='/probe/')
        assert isinstance(row.correlation_id, str)
        assert row.correlation_id
        assert len(row.correlation_id) <= COLUMN_WIDTH

    def test_empty_header_falls_back_to_a_generated_id(self):
        from backend.app.models import AuditLog

        response, _ = _drive(HTTP_X_REQUEST_ID='')

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.correlation_id == response['X-Request-ID']
        assert row.correlation_id

    def test_control_characters_only_header_falls_back_rather_than_emptying(self):
        """Stripping the CR/LF must not produce a blank correlation id — an
        empty ``correlation_id`` is unindexable for the trace it exists for."""
        from backend.app.models import AuditLog

        response, _ = _drive(HTTP_X_REQUEST_ID='\r\n\t')

        row = AuditLog.objects.get(endpoint='/probe/')
        assert row.correlation_id
        assert row.correlation_id == response['X-Request-ID']


# ---------------------------------------------------------------------------
# 5. An audit failure still must not break the response — but must be visible
# ---------------------------------------------------------------------------
class TestAuditFailureIsNonFatalAndObservable:
    def test_create_raising_does_not_propagate(self, monkeypatch):
        from backend.app.models import AuditLog

        def boom(*args, **kwargs):
            raise RuntimeError('audit table unavailable')

        monkeypatch.setattr(AuditLog.objects, 'create', boom)

        response, _ = _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        assert response.status_code == 200
        assert response['X-Request-ID'] == 'trace-abc-123'

    def test_create_raising_is_logged_at_error(self, monkeypatch, caplog):
        """The original defect was silent. A swallowed audit failure that is
        not logged is indistinguishable from a healthy request."""
        from backend.app.models import AuditLog

        def boom(*args, **kwargs):
            raise RuntimeError('audit table unavailable')

        monkeypatch.setattr(AuditLog.objects, 'create', boom)

        with caplog.at_level(logging.DEBUG, logger=MIDDLEWARE_LOGGER):
            _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        records = [
            r for r in caplog.records
            if r.name == MIDDLEWARE_LOGGER and r.levelno >= logging.WARNING
        ]
        assert records, (
            'a failed audit write was swallowed with no log line; the next '
            'instance of this bug would be invisible'
        )
        assert any('audit' in r.getMessage().lower() for r in records)
        # exc_info, so the operator gets the actual cause rather than a
        # bare "something went wrong".
        assert any(r.exc_info for r in records), (
            'the log line must carry the traceback of the swallowed exception'
        )

    def test_failed_write_line_carries_the_correlation_id(self, monkeypatch, caplog):
        """The whole point of the id: find the request whose audit record is
        missing. ``clear_correlation_id()`` runs after this except clause, so
        the filter can still populate it."""
        from backend.app.models import AuditLog

        monkeypatch.setattr(
            AuditLog.objects, 'create',
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')),
        )

        with caplog.at_level(logging.DEBUG, logger=MIDDLEWARE_LOGGER):
            _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        line = next(
            r for r in caplog.records
            if r.name == MIDDLEWARE_LOGGER and 'AuditLog write failed' in r.getMessage()
        )
        assert line.correlation_id == 'trace-abc-123'

    def test_successful_write_logs_no_error(self, caplog):
        with caplog.at_level(logging.DEBUG, logger=MIDDLEWARE_LOGGER):
            _drive(HTTP_X_REQUEST_ID='trace-abc-123')

        records = [
            r for r in caplog.records
            if r.name == MIDDLEWARE_LOGGER and r.levelno >= logging.WARNING
        ]
        assert not records, f'healthy request logged a warning: {records}'


# ---------------------------------------------------------------------------
# 6. End-to-end through the real middleware stack
# ---------------------------------------------------------------------------
class TestEndToEnd:
    def test_unauthenticated_request_with_over_length_id_is_audited(self, api_client):
        from backend.app.models import AuditLog

        before = AuditLog.objects.count()
        r = api_client.get(
            '/legal/compliance/',
            HTTP_X_REQUEST_ID=OVERLONG,
            secure=True,
        )

        assert r.status_code == 200
        row = AuditLog.objects.exclude(pk__in=[]).order_by('-pk').first()
        assert AuditLog.objects.count() == before + 1
        assert row is not None
        assert len(row.correlation_id) <= COLUMN_WIDTH
        assert r['X-Request-ID'] == row.correlation_id

    def test_client_ip_attribution_is_preserved(self, rf):
        """Must not regress the R2 fix: nginx's ``X-Real-IP`` wins, and a
        client-supplied ``X-Forwarded-For`` is never preferred over it."""
        from backend.app.models import AuditLog

        _drive(
            HTTP_X_REQUEST_ID='trace-abc-123',
            HTTP_X_REAL_IP='203.0.113.11',
            HTTP_X_FORWARDED_FOR='198.51.100.1',
        )

        assert AuditLog.objects.get(endpoint='/probe/').ip_address == '203.0.113.11'


# ---------------------------------------------------------------------------
# 7. Drift guard
# ---------------------------------------------------------------------------
class TestColumnWidthContract:
    def test_max_length_constant_matches_the_model_field(self):
        """The bound is a module constant, so it can drift from
        ``models.AuditLog.correlation_id.max_length``. If it ever exceeds the
        column width the INSERT raises again and R5-05 returns."""
        from backend.app.models import AuditLog
        from backend.EchoFlow.middleware import MAX_CORRELATION_ID_LEN

        field = AuditLog._meta.get_field('correlation_id')
        assert MAX_CORRELATION_ID_LEN == field.max_length


# ---------------------------------------------------------------------------
# 8. The audit row records WHO made the request
# ---------------------------------------------------------------------------
class TestAuthenticatedRequestIsRecorded:
    """Regression: the row was written with ``user=<int>`` into a ForeignKey.

    ``AuditLog.user`` is a ``ForeignKey``, so passing the raw primary key
    raised ``ValueError: Cannot assign "N": "AuditLog.user" must be a "User"
    instance`` for **every authenticated request**. The surrounding
    ``except Exception`` swallowed it, so the audit table recorded
    anonymous traffic and nothing else. Anonymous requests were unaffected
    only because ``AnonymousUser.id`` is ``None``.

    This is invisible to any test that drives the middleware anonymously,
    which is why the original suite never caught it.
    """

    def _drive_authenticated(self, user):
        from rest_framework.test import APIRequestFactory

        def view(request):
            # AuthenticationMiddleware lives inside get_response, so the
            # middleware only sees request.user after this returns.
            request.user = user
            return HttpResponse('ok')

        request = APIRequestFactory().get('/probe/')
        response = CorrelationIdMiddleware(view)(request)
        return response, request

    def test_an_authenticated_request_is_actually_recorded(self, django_user_model):
        from backend.app.models import AuditLog

        user = django_user_model.objects.create_user(
            username='auditor', email='auditor@example.com', password='x',
        )
        self._drive_authenticated(user)

        rows = list(AuditLog.objects.filter(endpoint='/probe/'))
        assert len(rows) == 1, (
            'an authenticated request wrote no audit row at all -- the '
            'ValueError from passing an int to a ForeignKey is being swallowed'
        )
        assert rows[0].user_id == user.id

    def test_the_row_is_attributed_to_the_right_user(self, django_user_model):
        from backend.app.models import AuditLog

        alice = django_user_model.objects.create_user(
            username='alice-auditor', email='alice@example.com', password='x',
        )
        bob = django_user_model.objects.create_user(
            username='bob-auditor', email='bob@example.com', password='x',
        )
        self._drive_authenticated(alice)
        self._drive_authenticated(bob)

        by_user = {row.user_id for row in AuditLog.objects.filter(endpoint='/probe/')}
        assert by_user == {alice.id, bob.id}

    def test_an_anonymous_request_is_still_recorded_with_no_user(self):
        from django.contrib.auth.models import AnonymousUser
        from backend.app.models import AuditLog

        self._drive_authenticated(AnonymousUser())

        rows = list(AuditLog.objects.filter(endpoint='/probe/'))
        assert len(rows) == 1
        assert rows[0].user_id is None

    def test_no_audit_failure_is_logged_for_a_healthy_authenticated_request(
        self, django_user_model, caplog,
    ):
        from backend.app.models import AuditLog

        user = django_user_model.objects.create_user(
            username='quiet-auditor', email='quiet@example.com', password='x',
        )
        with caplog.at_level('ERROR', logger=MIDDLEWARE_LOGGER):
            self._drive_authenticated(user)

        assert not [
            r for r in caplog.records
            if r.name == MIDDLEWARE_LOGGER and 'AuditLog write failed' in r.getMessage()
        ], 'the write is failing for every authenticated request and being logged'
        assert AuditLog.objects.filter(endpoint='/probe/').exists()
