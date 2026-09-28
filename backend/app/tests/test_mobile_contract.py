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

from backend.app.models import AudioClip, Comment, User

pytestmark = pytest.mark.django_db


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
