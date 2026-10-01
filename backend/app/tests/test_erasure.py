"""Tests for data-subject erasure (ISSUE-06 / B3).

The endpoint used to mark a request ``completed`` and return "Data erasure
process initiated." while deleting nothing. A user told their data is gone has
no reason to keep a copy, and a regulator query would surface the claim as a
representation.

These tests pin the two halves, and the second matters as much as the first:

* the personal data is actually removed — including the parts a Postgres
  cascade does not reach (object storage, Redis); and
* the records the law requires be kept **survive**, with the pointer to the
  person removed.

The second is the one that is easy to break by "fixing" the first. Deleting a
`ConsentAudit` row because it has a `user` FK would destroy the evidence that
consent was collected.
"""
import pytest

from backend.app.models import (
    AudioClip,
    AuditLog,
    Comment,
    ConsentAudit,
    DataSubjectRequest,
    Grievance,
    Report,
    ShareEvent,
    User,
    UserInteraction,
)
from backend.app.services.erasure import execute_erasure

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _isolate_throttles(clear_throttle_cache):
    """Reset DRF throttle counters. See conftest.clear_throttle_cache.

    Needed here because `data_subject` is scoped at 5/hour and this file makes
    more than five requests, so the endpoint under test starts answering 429
    partway through — which reads as a bug in the erasure flow.
    """
    yield



@pytest.fixture
def user(django_user_model):
    return django_user_model.objects.create_user(
        username="leaver", email="leaver@example.com", password="pw-probe-123"
    )


@pytest.fixture
def other(django_user_model):
    return django_user_model.objects.create_user(
        username="stayer", email="stayer@example.com", password="pw-probe-123"
    )


def _clip(owner, **kwargs):
    clip = AudioClip.objects.create(
        creator=owner, title="c", status="ready", moderation_approved=True, **kwargs
    )
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


# ---------------------------------------------------------------------------
# The personal data actually goes
# ---------------------------------------------------------------------------

class TestPersonalDataIsDeleted:
    def test_the_user_row_is_gone(self, user):
        pk = user.pk
        execute_erasure(pk)
        assert not User.objects.filter(pk=pk).exists()

    def test_clips_comments_shares_and_interactions_are_gone(self, user):
        clip = _clip(user)
        Comment.objects.create(clip=clip, author=user, text="hi")
        ShareEvent.objects.create(sender=user, receiver=user, clip=clip)
        UserInteraction.objects.create(user=user, clip=clip, interaction_type="like")

        execute_erasure(user.pk)

        assert AudioClip.objects.count() == 0
        assert Comment.objects.count() == 0
        assert ShareEvent.objects.count() == 0
        assert UserInteraction.objects.count() == 0

    def test_another_users_data_is_untouched(self, user, other):
        """The blast radius is one account. A bug that deleted more would
        pass every other test here."""
        my_clip, their_clip = _clip(user), _clip(other)
        Comment.objects.create(clip=my_clip, author=user, text="mine")
        Comment.objects.create(clip=their_clip, author=other, text="theirs")

        execute_erasure(user.pk)

        assert AudioClip.objects.filter(pk=their_clip.pk).exists()
        assert Comment.objects.filter(author=other).exists()
        assert User.objects.filter(pk=other.pk).exists()

    def test_the_report_counts_what_it_removed(self, user):
        _clip(user)
        report = execute_erasure(user.pk)
        assert report["clips_deleted"] == 1
        assert report["already_erased"] is False


class TestProfilePictureIsDeleted:
    def test_the_avatar_object_is_removed_from_storage(self, user, tmp_path, settings):
        """Object storage is not reached by a database cascade.

        An avatar is personal data, so leaving it in the bucket while the
        account is gone means the DPDP half of the erasure is a lie.
        """
        from django.core.files.storage import default_storage

        settings.MEDIA_ROOT = str(tmp_path)
        name = "avatars/erasure_probe.png"
        with open(tmp_path / "probe.png", "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n")
        default_storage.save(name, __import__("io").BytesIO(b"\x89PNG\r\n\x1a\n"))
        assert default_storage.exists(name)

        user.profile_picture.name = name
        user.save(update_fields=["profile_picture"])

        execute_erasure(user.pk)
        assert not default_storage.exists(name), "avatar survived erasure"

    def test_a_missing_avatar_does_not_break_erasure(self, user):
        assert user.profile_picture.name in (None, "")
        report = execute_erasure(user.pk)
        assert report["already_erased"] is False


class TestCoverImageIsDeleted:
    def test_the_cover_object_is_removed(self, user, tmp_path, settings):
        """B3: the AudioClip post_delete signal handled original_file and
        the hls/ tree, but not cover_image — a user-supplied image left in
        the bucket."""
        import io

        from django.core.files.storage import default_storage

        settings.MEDIA_ROOT = str(tmp_path)
        name = "covers/probe.png"
        default_storage.save(name, io.BytesIO(b"\x89PNG\r\n\x1a\n"))

        clip = _clip(user)
        clip.cover_image.name = name
        clip.save(update_fields=["cover_image"])

        execute_erasure(user.pk)
        assert not default_storage.exists(name), "cover image survived erasure"


class TestRedisIsPurged:
    """Behavioural data is personal data, and a Postgres cascade does not
    reach Redis."""

    def test_feed_and_vector_keys_are_deleted(self, user):
        from django.core.cache import cache

        client = cache.client.get_client(write=True)
        client.set(f"user_feed:{user.pk}", "abc")
        client.set(f"user_vectors:{user.pk}", "def")

        execute_erasure(user.pk)

        assert not client.exists(f"user_feed:{user.pk}")
        assert not client.exists(f"user_vectors:{user.pk}")

    def test_completion_counters_for_this_user_are_deleted(self, user):
        from django.core.cache import cache

        client = cache.client.get_client(write=True)
        key = f"clip:11111111-1111-1111-1111-111111111111:user:{user.pk}:completion_sum"
        other_key = (
            f"clip:11111111-1111-1111-1111-111111111111:user:999999:completion_sum"
        )
        client.set(key, "5")
        client.set(other_key, "7")

        try:
            execute_erasure(user.pk)
            assert not client.exists(key)
            # Another user's counter must survive.
            assert client.exists(other_key)
        finally:
            client.delete(other_key)

    def test_a_redis_outage_does_not_fail_the_erasure(self, user, monkeypatch):
        """The account must still be deleted if the cache is down. A stale
        feed queue is a coherence problem, not a retained copy of the user.

        Patches the module's own ``cache`` reference rather than
        ``cache.client``: ``django.core.cache.cache`` is a lazy proxy whose
        ``client`` is a read-only property, so monkeypatching the attribute
        raises AttributeError instead of simulating the outage.
        """
        import backend.app.services.erasure as erasure

        class _DeadCache:
            @property
            def client(self):
                raise RuntimeError("redis down")

        monkeypatch.setattr(erasure, "cache", _DeadCache())
        pk = user.pk
        report = execute_erasure(pk)
        assert report["redis_keys_deleted"] == 0
        assert not User.objects.filter(pk=pk).exists()


# ---------------------------------------------------------------------------
# The records the law requires kept
# ---------------------------------------------------------------------------

class TestRegulatoryRecordsSurvive:
    def test_consent_audit_survives_and_is_anonymised(self, user):
        """DPDP §5(2) / §11: proof of consent must outlive the account.
        The FK was CASCADE, so deleting the user destroyed the evidence."""
        ConsentAudit.objects.create(
            user=user, terms_version_id="v1.0", privacy_version_id="v1.0"
        )
        execute_erasure(user.pk)

        audit = ConsentAudit.objects.get()
        assert audit.user is None
        # The evidence itself is intact.
        assert audit.terms_version_id == "v1.0"
        assert audit.consent_issued_at is not None

    def test_consent_is_marked_withdrawn(self, user):
        ConsentAudit.objects.create(user=user)
        execute_erasure(user.pk)
        assert ConsentAudit.objects.get().withdrawn_at is not None

    def test_audit_log_survives(self, user):
        """CERT-In 2022: 180-day identity retention. Was already SET_NULL;
        pinned so a future 'simplification' to CASCADE is caught."""
        AuditLog.objects.create(
            user=user, action="register", endpoint="/auth/register/",
            ip_address="203.0.113.5",
        )
        execute_erasure(user.pk)
        assert AuditLog.objects.filter(user__isnull=True).exists()

    def test_grievance_survives(self, user):
        Grievance.objects.create(
            user=user, subject="x", description="y",
        )
        execute_erasure(user.pk)
        assert Grievance.objects.filter(user__isnull=True).exists()

    def test_the_erasure_request_itself_survives(self, user):
        """The request row was CASCADE, so the request deleted itself —
        erasing the evidence that erasure was ever requested, and losing
        completed_at."""
        DataSubjectRequest.objects.create(
            user=user, request_type="erasure", status="in_progress"
        )
        execute_erasure(user.pk)

        req = DataSubjectRequest.objects.get()
        assert req.user is None
        assert req.status == "completed"
        assert req.completed_at is not None

    def test_reports_by_others_about_the_users_clips_are_cascaded(self, user, other):
        """A report about a clip that no longer exists is not triageable, so
        CASCADE is correct there — the opposite of the retention case."""
        clip = _clip(user)
        Report.objects.create(user=other, title="t", content="c", clip=clip)
        execute_erasure(user.pk)
        assert Report.objects.count() == 0


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

class TestIdempotency:
    def test_running_twice_is_safe(self, user):
        """Celery redelivers. A second run must not raise, and must not
        pretend to have deleted something."""
        pk = user.pk
        first = execute_erasure(pk)
        second = execute_erasure(pk)
        assert first["already_erased"] is False
        assert second["already_erased"] is True

    def test_a_partial_failure_can_be_resumed(self, user, monkeypatch):
        """If the user survives but the first run claimed to finish, a retry
        must still do the work."""
        import backend.app.services.erasure as erasure

        calls = {"n": 0}
        real = erasure._anonymise_retained_records

        def flaky(uid):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient")
            return real(uid)

        monkeypatch.setattr(erasure, "_anonymise_retained_records", flaky)
        pk = user.pk
        with pytest.raises(RuntimeError):
            execute_erasure(pk)
        assert User.objects.filter(pk=pk).exists()

        report = execute_erasure(pk)
        assert report["already_erased"] is False
        assert not User.objects.filter(pk=pk).exists()


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------

class TestErasureEndpoint:
    def _client(self, user):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_first_call_opens_the_cooling_off_window(self, user):
        response = self._client(user).post(
            "/data-subject/erasure/", {"confirm": True}, format="json"
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "pending"
        assert body["cooling_off_until"] is not None

    def test_confirmation_is_required(self, user):
        assert self._client(user).post(
            "/data-subject/erasure/", {}, format="json"
        ).status_code == 400

    def test_erasure_is_blocked_during_the_cooling_off_window(self, user):
        self._client(user).post("/data-subject/erasure/", {"confirm": True}, format="json")
        response = self._client(user).post(
            "/data-subject/erasure/", {"confirm": True}, format="json"
        )
        assert response.status_code == 403
        assert "Cooling-off" in response.json()["detail"]

    def test_after_the_window_it_schedules_rather_than_claiming_completion(
        self, user, monkeypatch
    ):
        """The fix in one assertion: the old code returned status
        'completed' and 'Data erasure process initiated' having deleted
        nothing."""
        from django.utils import timezone
        from datetime import timedelta

        published = []
        import backend.app.views.data_subject as view

        monkeypatch.setattr(
            view, "publish", lambda task, *a, **k: published.append((task, a))
        )

        self._client(user).post("/data-subject/erasure/", {"confirm": True}, format="json")
        DataSubjectRequest.objects.filter(user=user).update(
            cooling_off_until=timezone.now() - timedelta(days=1)
        )

        response = self._client(user).post(
            "/data-subject/erasure/", {"confirm": True}, format="json"
        )
        body = response.json()

        assert response.status_code == 200
        # Not "completed" — the task sets that when it finishes.
        assert body["status"] == "in_progress"
        assert "initiated" not in body["message"].lower()
        assert published, "the erasure task was never enqueued"

    def test_the_task_is_actually_routed(self, user):
        from backend.app.tasks import execute_data_erasure

        # Not heavy_media: this is a row sweep plus storage deletes, with no
        # model to load and no ffmpeg. Routing it there would put a DPDP
        # deadline behind an ML worker pool.
        assert execute_data_erasure.name == "backend.app.tasks.execute_data_erasure"
        routes = __import__(
            "django.conf", fromlist=["settings"]
        ).settings.CELERY_TASK_ROUTES
        target = routes.get(execute_data_erasure.name, {}).get("queue", "default")
        assert target != "heavy_media"

    def test_anonymous_cannot_request_erasure(self):
        from rest_framework.test import APIClient

        assert APIClient().post(
            "/data-subject/erasure/", {"confirm": True}, format="json"
        ).status_code in (401, 403)
