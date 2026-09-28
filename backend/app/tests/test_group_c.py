"""Tests for Group C — audit identity, and the approve-moderation scope.

Three of the four items are code; the fourth (``AWS_S3_REGION_NAME``) turned
out to need no change, and the reasoning is recorded in the commit message
rather than as a test.

1. **Client IP.** nginx is the only entrypoint, so ``REMOTE_ADDR`` is the
   nginx container's address. Both audit paths recorded it, so
   ``AuditLog`` and ``ConsentAudit`` attributed every action to the proxy
   rather than to a user. Verified against the running stack before fixing:
   ``AuditLog.ip_address`` held ``172.29.0.13`` and ``172.29.0.9``.

2. **approve-moderation** used an unscoped ``get_object_or_404(AudioClip)``,
   bypassing the creator-scoped ``get_queryset()``, so any authenticated user
   could approve anyone's clip.

3. **finalize_upload** carried a no-op ``on_commit(lambda: None)``. The
   "enqueue here instead" alternative is a trap, because the task skips
   immediately on ``moderation_approved=False``.
"""
import pytest

from backend.EchoFlow.client_ip import get_client_ip

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# 1. Client IP
# ---------------------------------------------------------------------------

class TestGetClientIP:
    def _request(self, **meta):
        """A bare stub with a META dict, not RequestFactory.

        RequestFactory injects ``REMOTE_ADDR='127.0.0.1'`` into every request,
        so it cannot express "no REMOTE_ADDR" — which is exactly the case
        several of these tests need. The function under test only reads
        ``request.META``, so a stub is both sufficient and honest about that.
        """

        class _Request:
            pass

        request = _Request()
        request.META = dict(meta)
        return request

    def test_prefers_x_real_ip_behind_nginx(self):
        """nginx sets X-Real-IP from $remote_addr, overwriting anything the
        client sent, so it is the authoritative client address."""
        request = self._request(
            REMOTE_ADDR="172.29.0.9",  # nginx container
            HTTP_X_REAL_IP="203.0.113.77",
            HTTP_X_FORWARDED_FOR="203.0.113.77",
        )
        assert get_client_ip(request) == "203.0.113.77"

    def test_falls_back_to_remote_addr_on_a_direct_connection(self):
        """Bare-metal dev, and the :8005 debug escape hatch, have no proxy."""
        assert get_client_ip(self._request(REMOTE_ADDR="127.0.0.1")) == "127.0.0.1"

    def test_a_spoofed_forwarded_for_is_ignored(self):
        """The security case, and the reason XFF is not first.

        nginx uses ``$proxy_add_x_forwarded_for``, which APPENDS. A client
        sending ``X-Forwarded-For: 9.9.9.9`` results in nginx forwarding
        ``9.9.9.9, <real client>``. Taking the first entry would record the
        attacker's chosen address as the victim's.
        """
        request = self._request(
            REMOTE_ADDR="172.29.0.9",
            HTTP_X_REAL_IP="203.0.113.77",
            HTTP_X_FORWARDED_FOR="9.9.9.9, 203.0.113.77",
        )
        assert get_client_ip(request) == "203.0.113.77"

    def test_uses_the_last_forwarded_hop_when_nothing_better_exists(self):
        """No X-Real-IP and no REMOTE_ADDR: a proxy forwarded the chain but
        set neither. The last entry is the one our own hop appended."""
        request = self._request(HTTP_X_FORWARDED_FOR="9.9.9.9, 203.0.113.77")
        assert get_client_ip(request) == "203.0.113.77"

    def test_malformed_values_do_not_raise(self):
        """An audit write must never 500 the request, and
        GenericIPAddressField would raise on a non-IP string."""
        assert get_client_ip(self._request(
            REMOTE_ADDR="not-an-ip", HTTP_X_REAL_IP="", HTTP_X_FORWARDED_FOR="junk",
        )) is None

    def test_blank_and_whitespace_values_are_ignored(self):
        assert get_client_ip(self._request(
            REMOTE_ADDR="   ", HTTP_X_REAL_IP="", HTTP_X_FORWARDED_FOR="",
        )) is None

    def test_ipv6_is_accepted(self):
        assert get_client_ip(self._request(HTTP_X_REAL_IP="2001:db8::1")) == "2001:db8::1"

    def test_no_request_is_none(self):
        assert get_client_ip(None) is None

    def test_a_garbage_forwarded_for_falls_through_to_a_valid_hop(self):
        assert get_client_ip(self._request(
            HTTP_X_FORWARDED_FOR="junk, 10.0.0.1",
        )) == "10.0.0.1"


class TestAuditRecordsTheClientNotTheProxy:
    """End-to-end: the value must actually reach the audit tables."""

    def _authed(self, user):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_consent_audit_records_the_forwarded_client(self, rf):
        from backend.app.models import ConsentAudit
        from backend.app.serializers import RegisterSerializer

        request = rf.post(
            "/auth/register/",
            REMOTE_ADDR="172.29.0.9",
            HTTP_X_REAL_IP="203.0.113.50",
            HTTP_X_FORWARDED_FOR="203.0.113.50",
        )
        serializer = RegisterSerializer(data={
            "username": "audited",
            "email": "audited@example.com",
            "password": "pw-probe-12345",
            "consent_accepted": True,
            "terms_version": "v1.0",
            "dob": "1990-01-01",
        }, context={"request": request})
        assert serializer.is_valid(), serializer.errors
        # save(), not just is_valid(): the ConsentAudit row is written in
        # create(), so validation alone writes nothing.
        serializer.save()

        audit = ConsentAudit.objects.get()
        assert audit.ip_address == "203.0.113.50", (
            "consent evidence must name the user, not the nginx container"
        )

    def test_middleware_attaches_the_forwarded_client(self, rf):
        from backend.EchoFlow.middleware import CorrelationIdMiddleware

        request = rf.get(
            "/probe/",
            REMOTE_ADDR="172.29.0.9",
            HTTP_X_REAL_IP="203.0.113.60",
            HTTP_X_FORWARDED_FOR="203.0.113.60",
        )
        middleware = CorrelationIdMiddleware(lambda r: {})
        middleware(request)
        assert request.client_ip == "203.0.113.60"

    def test_an_audit_row_written_behind_nginx_names_the_client(self, rf):
        """Exercise the middleware's finally-block DB write, not just the
        attribute it sets."""
        from backend.EchoFlow.middleware import CorrelationIdMiddleware
        from backend.app.models import AuditLog

        request = rf.get(
            "/probe/",
            REMOTE_ADDR="172.29.0.9",
            HTTP_X_REAL_IP="203.0.113.70",
            HTTP_X_FORWARDED_FOR="203.0.113.70",
        )
        CorrelationIdMiddleware(lambda r: {})(request)

        row = AuditLog.objects.filter(endpoint="/probe/").first()
        assert row is not None
        assert row.ip_address == "203.0.113.70"


# ---------------------------------------------------------------------------
# 2. approve-moderation scope
# ---------------------------------------------------------------------------

class TestApproveModerationScope:
    @pytest.fixture
    def owner(self, django_user_model):
        return django_user_model.objects.create_user(
            username="owner", email="owner@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def stranger(self, django_user_model):
        return django_user_model.objects.create_user(
            username="stranger", email="stranger@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def clip(self, owner):
        from backend.app.models import AudioClip

        return AudioClip.objects.create(
            creator=owner, title="mine", status="processing",
            hls_playlist_url="hls/00000000-0000-0000-0000-0000000000a1/master.m3u8",
        )

    def test_a_stranger_cannot_approve_someone_elses_clip(self, stranger, clip):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=stranger)
        response = client.post(f"/clips/{clip.id}/approve-moderation/", {}, format="json")
        # 404, not 403: a 403 would confirm the clip exists.
        assert response.status_code == 404
        clip.refresh_from_db()
        assert clip.moderation_approved is False

    def test_anonymous_cannot_approve(self, clip):
        from rest_framework.test import APIClient

        response = APIClient().post(f"/clips/{clip.id}/approve-moderation/", {}, format="json")
        assert response.status_code in (401, 403)
        clip.refresh_from_db()
        assert clip.moderation_approved is False

    def test_the_owner_may_approve_their_own_clip(self, owner, clip):
        """Required by the current v1 upload flow — denying it would leave
        every upload stuck in `processing` until a human looked at it."""
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=owner)
        response = client.post(f"/clips/{clip.id}/approve-moderation/", {}, format="json")
        assert response.status_code == 200
        assert response.json()["status"] == "approved"
        clip.refresh_from_db()
        assert clip.moderation_approved is True

    def test_staff_may_approve_any_clip(self, stranger, clip):
        """The moderation queue is useless if a moderator cannot reach other
        people's uploads — which is the entire point of a queue."""
        from rest_framework.test import APIClient

        stranger.is_staff = True
        stranger.save(update_fields=["is_staff"])

        client = APIClient()
        client.force_authenticate(user=stranger)
        response = client.post(f"/clips/{clip.id}/approve-moderation/", {}, format="json")
        assert response.status_code == 200
        clip.refresh_from_db()
        assert clip.moderation_approved is True

    def test_approval_actually_enqueues_hls_processing(
        self, owner, clip, monkeypatch, django_capture_on_commit_callbacks
    ):
        """Approval is the only trigger for HLS. If it stopped enqueuing,
        approved clips would sit in `processing` forever.

        `trigger_hls_processing` dispatches via `transaction.on_commit`, and
        on_commit callbacks are deferred and then discarded inside
        pytest-django's TestCase wrapper. Without
        `django_capture_on_commit_callbacks` the publish call never happens
        and this assertion is meaningless — it would pass (or fail) for a
        reason unrelated to the code under test.
        """
        published = []
        import backend.app.services.uploads as uploads

        monkeypatch.setattr(
            uploads, "publish", lambda task, *a, **k: published.append((task, a))
        )
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=owner)
        with django_capture_on_commit_callbacks(execute=True):
            assert client.post(
                f"/clips/{clip.id}/approve-moderation/", {}, format="json"
            ).status_code == 200
        assert published, "approve-moderation did not enqueue anything"


# ---------------------------------------------------------------------------
# 3. finalize_upload
# ---------------------------------------------------------------------------

class TestFinalizeUpload:
    def test_it_does_not_dispatch_a_task_that_would_immediately_skip(
        self, django_user_model, monkeypatch
    ):
        """The trap, pinned.

        process_audio_to_hls returns immediately when
        moderation_approved is False, and finalize_upload's job is to ensure
        it is False. So dispatching here would wake a worker per upload to do
        nothing. Asserted against the *task's* guard, not against a
        preference.
        """
        import inspect

        from backend.app.services.uploads import finalize_upload
        from backend.app import tasks

        source = inspect.getsource(tasks._process_audio_to_hls_impl)
        assert "if not clip.moderation_approved" in source, (
            "the task's moderation guard is gone; re-evaluate whether "
            "finalize_upload should dispatch"
        )
        # finalize_upload's source must not reference the publisher.
        assert "publish" not in inspect.getsource(finalize_upload)

    def test_it_clears_a_stale_approval(self, django_user_model):
        """Defensive path: a row created with moderation_approved=True must
        not be able to skip the gate by arriving here pre-approved."""
        from backend.app.models import AudioClip
        from backend.app.services.uploads import finalize_upload

        owner = django_user_model.objects.create_user(
            username="o", email="o@example.com", password="pw-probe-123"
        )
        clip = AudioClip.objects.create(
            creator=owner, title="t", status="processing", moderation_approved=True
        )
        finalize_upload(clip)
        clip.refresh_from_db()
        assert clip.moderation_approved is False

    def test_trigger_still_refuses_unapproved_clips(self, django_user_model):
        """The guard on the other side, so the two ends cannot be confused."""
        import pytest as _pytest

        from backend.app.models import AudioClip
        from backend.app.services.uploads import trigger_hls_processing

        owner = django_user_model.objects.create_user(
            username="o2", email="o2@example.com", password="pw-probe-123"
        )
        clip = AudioClip.objects.create(
            creator=owner, title="t", status="processing", moderation_approved=False
        )
        with _pytest.raises(ValueError):
            trigger_hls_processing(clip)
