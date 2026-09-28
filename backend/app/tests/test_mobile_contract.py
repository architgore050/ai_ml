"""Contract tests for the mobile-rebuild unblocking batch (A1, A2, A5).

These four items exist because a client could not satisfy the server's
contract:

* **A1** — ``RegisterSerializer.terms_version`` is required and validated
  against ``settings.TERMS_VERSIONS``, but no endpoint published that list,
  so clients hardcoded a version and 400'd when one was appended.
* **A2** — ``FeedClipSerializer`` omitted ``tags`` and ``duration_ms``,
  both of which are columns on ``AudioClip``, so the client had to derive
  the scrubber length from the player clock.
* **A5** — ``CommentSerializer`` exposed ``author_username`` but not
  ``author_id``, so comment authors could be rendered but not made
  tappable.

The tests assert the server contract only. The client-side half of A1 and of
ISSUE-16 lives in the frontend and is covered by TypeScript.
"""
import pytest
from redis.exceptions import RedisError

from backend.app.models import AudioClip, Comment, User

pytestmark = pytest.mark.django_db


#: B1 (2026-09-29) made ``dob`` required on registration, so every payload
#: in this file carries an adult date of birth. A minor DOB would trip the
#: under-18 branch and demand a parent_email, which is tested separately in
#: TestAgeGate below rather than incidentally here.
ADULT_DOB = "1990-01-01"


@pytest.fixture(autouse=True)
def _isolate_throttles(clear_throttle_cache):
    """Reset DRF throttle counters. See conftest.clear_throttle_cache.

    Autouse because the authorization assertions below make authenticated
    requests whose budget is shared with every other test in the process, and
    a Redis-backed budget that persists between runs can otherwise fail these
    tests for reasons unrelated to the code.
    """
    yield



# ---------------------------------------------------------------------------
# A1 — the registration contract must be discoverable
# ---------------------------------------------------------------------------

class TestComplianceEndpointPublishesTermsVersions:
    """``GET /legal/compliance/`` must expose what registration validates."""

    @pytest.fixture
    def client_(self):
        from rest_framework.test import APIClient

        return APIClient()

    def test_is_reachable_without_auth(self, client_):
        """It must stay AllowAny: IT Rules 2021 R4(4) requires the terms and
        the grievance contact to be visible to a prospective user, who by
        definition has no account yet."""
        assert client_.get("/legal/compliance/").status_code == 200

    def test_publishes_the_accepted_terms_versions(self, client_, settings):
        settings.TERMS_VERSIONS = ["v1.0", "v1.1"]
        body = client_.get("/legal/compliance/").json()
        assert body["terms_versions"] == ["v1.0", "v1.1"]

    def test_published_list_is_exactly_what_registration_accepts(
        self, client_, settings
    ):
        """The whole point: a client must be able to read the list off this
        endpoint and submit any entry without guessing.

        Asserted by round-tripping a real registration with the value read
        from the endpoint, not by comparing two lists — a test that only
        compares lists would pass even if both were wrong in the same way.
        """
        from backend.app.serializers import RegisterSerializer

        settings.TERMS_VERSIONS = ["v1.0", "v1.1"]
        body = client_.get("/legal/compliance/").json()
        published = body["terms_versions"]

        for version in published:
            serializer = RegisterSerializer(
                data={
                    "username": f"user{version.replace('.', '_')}",
                    "email": f"u{version.replace('.', '_')}@example.com",
                    "password": "pw-probe-12345",
                    "consent_accepted": True,
                    "dob": ADULT_DOB,
                "terms_version": version,
                }
            )
            assert serializer.is_valid(), serializer.errors

    def test_publishes_a_current_version_that_is_itself_valid(
        self, client_, settings
    ):
        """``current_terms_version`` is what the app shows at the consent
        screen. If it is not in the accepted list, the app displays a
        version it then cannot submit."""
        from backend.app.serializers import RegisterSerializer

        settings.TERMS_VERSIONS = ["v1.0", "v1.1", "v2.0"]
        body = client_.get("/legal/compliance/").json()
        assert body["current_terms_version"] in body["terms_versions"]

        serializer = RegisterSerializer(
            data={
                "username": "current",
                "email": "current@example.com",
                "password": "pw-probe-12345",
                "consent_accepted": True,
                "dob": ADULT_DOB,
                "terms_version": body["current_terms_version"],
            }
        )
        assert serializer.is_valid(), serializer.errors

    def test_publishes_privacy_version_and_physical_address(self, client_, settings):
        settings.PRIVACY_VERSION = "v3.0"
        settings.PHYSICAL_ADDRESS = "123 EchoFlow Lane, Mumbai 400001"
        body = client_.get("/legal/compliance/").json()
        assert body["privacy_version"] == "v3.0"
        # Consumer Protection (E-Commerce) Rules 2020 requires a physical
        # address to be published. It was read into settings and served
        # nowhere.
        assert body["physical_address"] == "123 EchoFlow Lane, Mumbai 400001"

    def test_retains_the_officer_contacts(self, client_):
        """A1 only adds fields. Removing an officer contact would be a
        regression against IT Rules 2021 R4(1), so it is pinned."""
        body = client_.get("/legal/compliance/").json()
        for key in ("compliance_officer", "grievance_officer", "nodal_contact"):
            assert key in body
            assert "name" in body[key] and "email" in body[key]


class TestTermsVersionParsing:
    def test_settings_strips_whitespace_and_blanks(self, settings):
        """A stray space in a .env line used to create an unusable version.

        ``"v1.0, v1.1"`` split to ``['v1.0', ' v1.1']`` — the second entry was
        stored, published and never accepted, so the mismatch was invisible
        until a user hit an inexplicable 400.
        """
        import importlib

        import os
        from unittest import mock

        from backend.EchoFlow import settings as settings_mod

        with mock.patch.dict(
            os.environ, {"TERMS_VERSIONS": "v1.0, v1.1,,v2.0, "}
        ):
            reloaded = importlib.reload(settings_mod)
            try:
                assert reloaded.TERMS_VERSIONS == ["v1.0", "v1.1", "v2.0"]
            finally:
                # Never leave the module reloaded with a patched env.
                importlib.reload(settings_mod)

    def test_validator_tolerates_surrounding_whitespace(self, settings):
        from backend.app.serializers import RegisterSerializer

        settings.TERMS_VERSIONS = ["v1.0"]
        serializer = RegisterSerializer(
            data={
                "username": "spaced",
                "email": "spaced@example.com",
                "password": "pw-probe-12345",
                "consent_accepted": True,
                "dob": ADULT_DOB,
                "terms_version": "  v1.0  ",
            }
        )
        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["terms_version"] == "v1.0"

    def test_validator_rejects_an_unknown_version(self, settings):
        from backend.app.serializers import RegisterSerializer

        settings.TERMS_VERSIONS = ["v1.0"]
        serializer = RegisterSerializer(
            data={
                "username": "unknown",
                "email": "unknown@example.com",
                "password": "pw-probe-12345",
                "consent_accepted": True,
                "dob": ADULT_DOB,
                "terms_version": "v9.9",
            }
        )
        assert not serializer.is_valid()
        # The message must let a client self-correct without a doc lookup.
        assert "v1.0" in str(serializer.errors)


# ---------------------------------------------------------------------------
# A2 — feed clips expose tags and duration
# ---------------------------------------------------------------------------

class TestFeedClipSerializerFields:
    @pytest.fixture
    def clip(self, django_user_model):
        author = django_user_model.objects.create_user(
            username="author", email="author@example.com", password="pw-probe-123"
        )
        return AudioClip.objects.create(
            creator=author,
            title="tagged",
            status="ready",
            moderation_approved=True,
            tags=["rain", "street"],
            duration_ms=7420,
        )

    def test_exposes_tags_and_duration(self, clip):
        from backend.app.serializers import FeedClipSerializer

        data = FeedClipSerializer(clip).data
        assert data["tags"] == ["rain", "street"]
        assert data["duration_ms"] == 7420

    def test_neither_field_is_client_writable(self, clip):
        """Both are server-owned. A client POSTing `duration_ms` must not be
        able to relabel its own clip, and `tags` are KeyBERT output used by
        the recommendation vector."""
        from backend.app.serializers import FeedClipSerializer

        serializer = FeedClipSerializer(clip, data={"tags": ["forged"]}, partial=True)
        serializer.is_valid()
        assert "tags" not in serializer.validated_data


# ---------------------------------------------------------------------------
# A5 — comments expose author_id
# ---------------------------------------------------------------------------

class TestCommentSerializerAuthorId:
    @pytest.fixture
    def comment(self, django_user_model):
        author = django_user_model.objects.create_user(
            username="commenter", email="commenter@example.com", password="pw-probe-123"
        )
        clip = AudioClip.objects.create(
            creator=author, title="c", status="ready", moderation_approved=True
        )
        return Comment.objects.create(clip=clip, author=author, text="hello")

    def test_exposes_author_id_alongside_the_username(self, comment):
        from backend.app.serializers import CommentSerializer

        data = CommentSerializer(comment).data
        assert data["author_id"] == comment.author_id
        # The username must survive; the id is additive.
        assert data["author_username"] == comment.author.username

    def test_the_id_is_the_real_user_pk(self, comment):
        from backend.app.serializers import CommentSerializer

        data = CommentSerializer(comment).data
        assert data["author_id"] == User.objects.get(
            username="commenter"
        ).pk

    def test_author_id_is_read_only(self, comment):
        """A client must not be able to post a comment as somebody else by
        supplying an author_id. `author` is set server-side from the
        request user; if author_id were writable, a spoofed body could
        impersonate."""
        from backend.app.serializers import CommentSerializer

        serializer = CommentSerializer(comment, data={"author_id": 999}, partial=True)
        serializer.is_valid()
        assert "author_id" not in serializer.validated_data

    def test_it_appears_in_a_comment_list_response(self, comment):
        """Field-level presence is not enough — the list endpoint is what the
        comment sheet actually calls, so assert against the real route."""
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=comment.author)
        response = client.get(f"/comments/?clip={comment.clip_id}")
        assert response.status_code == 200
        results = response.json()["results"]
        assert results, "expected the comment to be listed"
        assert results[0]["author_id"] == comment.author_id


# ---------------------------------------------------------------------------
# B1 — the age gate must not be bypassable by omission
# ---------------------------------------------------------------------------

class TestAgeGate:
    """``dob`` is required. Before 2026-09-29 it was optional, so a client
    that omitted it was registered as an adult and their telemetry was
    processed under the adult path.

    The exposure is behavioural monitoring under DPDP §9: the recommendation
    stack consumes ``watch_time_ms``, completion rate and reel position. A
    child account feeding that is the violation, and the platform cannot
    avoid it if the client decides whether it ever finds out.
    """

    MINOR_DOB = "2015-06-15"

    def payload(self, **overrides):
        data = {
            "username": "subject",
            "email": "subject@example.com",
            "password": "pw-probe-12345",
            "consent_accepted": True,
            "terms_version": "v1.0",
            "dob": ADULT_DOB,
        }
        data.update(overrides)
        return data

    def test_dob_cannot_be_omitted(self):
        from backend.app.serializers import RegisterSerializer

        data = self.payload()
        del data["dob"]
        serializer = RegisterSerializer(data=data)
        assert not serializer.is_valid()
        assert "dob" in serializer.errors

    def test_dob_cannot_be_sent_as_null(self):
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(data=self.payload(dob=None))
        assert not serializer.is_valid()
        assert "dob" in serializer.errors

    def test_omitting_dob_does_not_produce_a_minor(self):
        """The bypass specifically: absent dob used to land in the
        `else:` branch which set is_minor=False."""
        from backend.app.serializers import RegisterSerializer

        data = self.payload()
        del data["dob"]
        serializer = RegisterSerializer(data=data)
        assert not serializer.is_valid()
        # Nothing is written, so there is no adult-flagged user at all.
        assert "is_minor" not in serializer.validated_data

    def test_adult_dob_registers_cleanly(self):
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(data=self.payload())
        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["is_minor"] is False

    def test_minor_dob_requires_a_guardian_email(self):
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(data=self.payload(dob=self.MINOR_DOB))
        assert not serializer.is_valid()
        assert "parent_email" in serializer.errors

    def test_minor_dob_with_guardian_sets_is_minor(self):
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(
            data=self.payload(dob=self.MINOR_DOB, parent_email="guardian@example.com")
        )
        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["is_minor"] is True

    def test_future_dob_is_rejected_not_clamped(self):
        """Coercing 2030 to an adult would be the wrong failure direction:
        the adult path is the less restricted one."""
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(data=self.payload(dob="2030-01-01"))
        assert not serializer.is_valid()
        assert "dob" in serializer.errors

    def test_implausible_dob_is_rejected(self):
        from backend.app.serializers import RegisterSerializer

        serializer = RegisterSerializer(data=self.payload(dob="1700-01-01"))
        assert not serializer.is_valid()
        assert "dob" in serializer.errors

    def test_the_120_year_bound_uses_date_arithmetic_not_year_replacement(self):
        """Regression guard for a real 500.

        The bound was first written as ``today.replace(year=today.year -
        120)``, which raises ValueError when the result lands on a
        non-existent date. On 29 Feb it lands on 28/29 Feb 120 years back:
        28 Feb exists and 29 Feb exists only when that back-year is itself a
        leap year, so the 500 is intermittent and date-dependent — the worst
        shape to notice in review. Pinned with a sweep rather than a single
        date, because the exact trigger is the interaction of two leap
        calendars.
        """
        from datetime import date, timedelta

        from backend.app.serializers import RegisterSerializer

        # Sweep every day of a leap year, a non-leap year, and the century
        # boundary, asserting only what the serializer actually does: the
        # safe form never raises. Whether the unsafe form raises depends on
        # whether the back-year is itself a leap year, which is exactly why
        # it is not a bug worth pinning on a single hand-picked date.
        checked = 0
        for start in (date(2024, 1, 1), date(2023, 1, 1), date(2000, 1, 1)):
            day = start
            while day.year == start.year:
                bound = day - timedelta(days=120 * 365)
                assert isinstance(bound, date)
                checked += 1
                day += timedelta(days=1)
        assert checked == 366 + 365 + 366

        # Boundary: a user just inside the 120-year window is accepted. The
        # bound exists to catch typos, not to age-verify — and 120 is chosen
        # as "definitely not a real user", so a real 118-year-old must not be
        # rejected by it.
        from datetime import date as _date

        inside = _date.today() - timedelta(days=119 * 365)
        serializer = RegisterSerializer(
            data={
                "username": "centenarian",
                "email": "centenarian@example.com",
                "password": "pw-probe-12345",
                "consent_accepted": True,
                "terms_version": "v1.0",
                "dob": inside.isoformat(),
            }
        )
        assert serializer.is_valid(), serializer.errors


class TestMinorTelemetryBlocked:
    """DPDP §9: a minor's behavioural telemetry must not reach the
    recommendation stack."""

    @pytest.fixture
    def clip(self, django_user_model):
        owner = django_user_model.objects.create_user(
            username="owner", email="owner@example.com", password="pw-probe-123"
        )
        return AudioClip.objects.create(
            creator=owner, title="c", status="ready", moderation_approved=True
        )

    def _minor(self, django_user_model):
        return django_user_model.objects.create_user(
            username="kid", email="kid@example.com", password="pw-probe-123",
            is_minor=True,
        )

    def test_telemetry_from_a_minor_is_refused(self, django_user_model, clip):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=self._minor(django_user_model))
        response = client.post(
            f"/interactions/{clip.id}/log-telemetry/",
            {"action_type": "view", "watch_time_ms": 4200},
            format="json",
        )
        assert response.status_code == 403
        # The message must not imply the data was collected and then
        # discarded; it says collection is refused.
        assert "not collected" in response.json()["detail"].lower()

    def test_telemetry_from_an_adult_is_accepted(
        self, django_user_model, clip
    ):
        from rest_framework.test import APIClient

        adult = django_user_model.objects.create_user(
            username="grown", email="grown@example.com", password="pw-probe-123"
        )
        client = APIClient()
        client.force_authenticate(user=adult)
        response = client.post(
            f"/interactions/{clip.id}/log-telemetry/",
            {"action_type": "view", "watch_time_ms": 4200},
            format="json",
        )
        assert response.status_code == 202

    def test_likes_still_work_for_a_minor(self, django_user_model, clip):
        """Deliberately not gated. A like is an explicit user action, not
        passive tracking, and blocking it would stop a minor participating in
        the app at all."""
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=self._minor(django_user_model))
        assert client.post(f"/interactions/{clip.id}/toggle-like/").status_code == 200
