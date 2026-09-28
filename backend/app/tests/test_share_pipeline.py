"""Tests for the share pipeline (A4).

The design under test: a share token is **not** a new token type. It is an
ordinary HLS playback token minted with a longer TTL, and
``POST /clips/{id}/play/`` re-mints a short-lived one on the recipient's
explicit play intent.

That collapses a lot of machinery that a separate share-token type would have
needed — a second secret, a ``ShareLink`` table, a second validator that must
stay in step with the Cloudflare Worker and the nginx njs file. What it gives
up is per-token revocation, which is why ``SHARE_TOKEN_TTL_SECONDS`` is 30
days rather than unlimited: ``exp`` is the only automatic revocation
mechanism in this design, and an unlimited share token would mean a takedown
never takes effect for someone already holding the link.

The load-bearing security property, and the one most likely to regress:

    a valid share token must not unlock a clip it was not issued for.

Without the ``payload["c"] == clip_key`` comparison, anyone could take the
``?s=`` value from a link they were sent and swap the clip id in the path.
Most of this file is about that.
"""
import pytest

from backend.app.models import AudioClip

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _isolate_throttles(clear_throttle_cache):
    """See conftest.clear_throttle_cache. Autouse here because every test
    in this file makes unauthenticated, IP-keyed requests that all share
    127.0.0.1, so they pool a single per-scope budget."""
    yield


@pytest.fixture
def owner(django_user_model):
    return django_user_model.objects.create_user(
        username="owner", email="owner@example.com", password="pw-probe-123"
    )


@pytest.fixture
def stranger(django_user_model):
    return django_user_model.objects.create_user(
        username="stranger", email="stranger@example.com", password="pw-probe-123"
    )


@pytest.fixture
def clip(owner):
    clip = AudioClip.objects.create(
        creator=owner,
        title="Shared clip",
        category="music",
        status="ready",
        moderation_approved=True,
        duration_ms=4200,
        tags=["rain", "acoustic"],
    )
    # tasks.py:376 writes f"hls/{clip.id}", so the fixture must do the same.
    # Generating an unrelated random UUID here would make the token scope
    # disagree with the clip id, and the scope comparison would (correctly)
    # reject every share — a failure that looks like a security bug and is
    # actually a bad fixture.
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


def _clip_for(owner, title):
    """A ready, moderated clip whose HLS key matches its own id.

    Mirrors tasks.py:376 (``f"hls/{clip.id}"``) — the share scope check
    compares the token's ``c`` against exactly this value.
    """
    other = AudioClip.objects.create(
        creator=owner, title=title, status="ready", moderation_approved=True
    )
    other.hls_playlist_url = f"hls/{other.id}/master.m3u8"
    other.save(update_fields=["hls_playlist_url"])
    return other


def authed(user):
    from rest_framework.test import APIClient

    client = APIClient()
    client.force_authenticate(user=user)
    return client


# ---------------------------------------------------------------------------
# Minting a share link
# ---------------------------------------------------------------------------

class TestShareLinkIssuance:
    def test_the_owner_can_mint_a_link(self, owner, clip):
        response = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json")
        assert response.status_code == 201
        body = response.json()
        # str(), not ==: DRF renders a UUID as a JSON string, so comparing
        # against the raw UUID object would fail on a correct response.
        assert body["clip_id"] == str(clip.id)
        assert body["token"]
        assert body["path"].startswith(f"/clips/{clip.id}/public/?s=")

    def test_a_stranger_cannot_mint_a_link_for_someone_elses_clip(self, stranger, clip):
        response = authed(stranger).post(f"/clips/{clip.id}/share-link/", {}, format="json")
        # 404 not 403: a 403 would confirm the clip exists.
        assert response.status_code == 404

    def test_anonymous_cannot_mint_a_link(self, clip):
        from rest_framework.test import APIClient

        assert APIClient().post(
            f"/clips/{clip.id}/share-link/", {}, format="json"
        ).status_code in (401, 403)

    def test_staff_can_mint_a_link_for_any_clip(self, stranger, clip):
        stranger.is_staff = True
        stranger.save(update_fields=["is_staff"])
        assert authed(stranger).post(
            f"/clips/{clip.id}/share-link/", {}, format="json"
        ).status_code == 201

    def test_a_clip_with_no_media_cannot_be_shared(self, owner, clip):
        """No HLS output means there is nothing to grant a token for."""
        clip.hls_playlist_url = None
        clip.save(update_fields=["hls_playlist_url"])
        response = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json")
        assert response.status_code == 409

    def test_the_token_is_scoped_to_this_clip(self, owner, clip):
        """The whole design rests on this."""
        from backend.app.services.hls_token import verify_token

        response = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json")
        payload = verify_token(response.json()["token"])
        assert payload is not None
        assert payload["c"] == f"hls/{clip.id}"


class TestShareTokenLifetime:
    def test_the_share_token_outlives_the_media_token(self, owner, clip, settings):
        """30 days vs 600s. If these were ever equal, the two constants would
        be doing the same job and one should go."""
        from backend.app.services.hls_token import verify_token

        response = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json")
        payload = verify_token(response.json()["token"])
        assert payload["exp"] - payload["iat"] == settings.SHARE_TOKEN_TTL_SECONDS
        assert settings.SHARE_TOKEN_TTL_SECONDS > settings.MEDIA_TOKEN_TTL_SECONDS

    def test_the_default_is_thirty_days_and_not_unlimited(self):
        """A bounded lifetime is the only revocation mechanism available."""
        from django.conf import settings as s

        assert s.SHARE_TOKEN_TTL_SECONDS == 30 * 24 * 3600

    def test_the_exchange_mints_a_short_lived_token(self, owner, clip, settings):
        """The recipient's player gets a 600s credential, so the 30-day token
        never has to be attached to a player."""
        from backend.app.services.hls_token import verify_token

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        from rest_framework.test import APIClient

        response = APIClient().post(
            f"/clips/{clip.id}/play/", {"s": share["token"]}, format="json"
        )
        assert response.status_code == 200
        payload = verify_token(response.json()["token"])
        assert payload["exp"] - payload["iat"] == settings.MEDIA_TOKEN_TTL_SECONDS

    def test_the_exchange_does_not_honor_a_ttl_override_from_the_client(self, owner, clip):
        """The client cannot ask for a longer-lived media token."""
        from backend.app.services.hls_token import verify_token
        from django.conf import settings as s

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        from rest_framework.test import APIClient

        response = APIClient().post(
            f"/clips/{clip.id}/play/",
            {"s": share["token"], "ttl": 999999, "expires_in": 999999},
            format="json",
        )
        payload = verify_token(response.json()["token"])
        assert payload["exp"] - payload["iat"] == s.MEDIA_TOKEN_TTL_SECONDS


# ---------------------------------------------------------------------------
# The play gate
# ---------------------------------------------------------------------------

class TestPlayRequiresAValidShareToken:
    def test_no_token_is_refused(self, clip):
        from rest_framework.test import APIClient

        response = APIClient().post(f"/clips/{clip.id}/play/", {}, format="json")
        assert response.status_code == 403
        assert "ef_hls_token" not in response.cookies

    def test_a_garbage_token_is_refused(self, clip):
        from rest_framework.test import APIClient

        for value in ("not-a-token", "a.b", "....", "x" * 200):
            response = APIClient().post(
                f"/clips/{clip.id}/play/", {"s": value}, format="json"
            )
            assert response.status_code == 403, value

    def test_a_tampered_token_is_refused(self, owner, clip):
        """Flip a character in the signature."""
        from rest_framework.test import APIClient

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        payload_b64, sig_b64 = share["token"].split(".")
        tampered = f"{payload_b64}.{'A' if sig_b64[0] != 'A' else 'B'}{sig_b64[1:]}"
        response = APIClient().post(
            f"/clips/{clip.id}/play/", {"s": tampered}, format="json"
        )
        assert response.status_code == 403

    def test_an_expired_token_is_refused(self, owner, clip, settings):
        from rest_framework.test import APIClient
        from backend.app.services.hls_token import generate_playback_token

        expired = generate_playback_token(
            user_id=clip.creator_id, clip_key=f"hls/{clip.id}", ttl=-1
        )
        response = APIClient().post(
            f"/clips/{clip.id}/play/", {"s": expired}, format="json"
        )
        assert response.status_code == 403

    def test_an_unmoderated_clip_cannot_be_played_by_a_share_token(
        self, owner, clip
    ):
        """A takedown must win over a live share link.

        This is the reason the share token is bounded rather than permanent:
        the check is at play time, so revoking a clip stops *new* playback for
        anyone who has not already fetched a media token.
        """
        from rest_framework.test import APIClient

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        clip.moderation_approved = False
        clip.save(update_fields=["moderation_approved"])

        response = APIClient().post(
            f"/clips/{clip.id}/play/", {"s": share["token"]}, format="json"
        )
        assert response.status_code == 404

    def test_a_clip_with_no_media_conflicts(self, owner, clip):
        from rest_framework.test import APIClient

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        clip.hls_playlist_url = None
        clip.save(update_fields=["hls_playlist_url"])
        response = APIClient().post(
            f"/clips/{clip.id}/play/", {"s": share["token"]}, format="json"
        )
        assert response.status_code == 409


class TestShareTokenIsScopedToItsClip:
    """The load-bearing property.

    A recipient holds the ``?s=`` value from a link they were sent. Without
    the scope comparison, that value would unlock any clip on the platform.
    """

    def test_a_token_for_one_clip_does_not_unlock_another(
        self, owner, clip, django_user_model
    ):
        from rest_framework.test import APIClient

        other_owner = django_user_model.objects.create_user(
            username="other", email="other@example.com", password="pw-probe-123"
        )
        other = _clip_for(other_owner, "Not yours")

        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()

        response = APIClient().post(
            f"/clips/{other.id}/play/", {"s": share["token"]}, format="json"
        )
        assert response.status_code == 403
        assert "ef_hls_token" not in response.cookies

    def test_a_token_for_one_clip_does_not_unlock_another_via_query_param(
        self, owner, clip, django_user_model
    ):
        """Same attack with the token in the query string, which is how it
        arrives in a real link."""
        from rest_framework.test import APIClient

        other_owner = django_user_model.objects.create_user(
            username="other2", email="other2@example.com", password="pw-probe-123"
        )
        other = _clip_for(other_owner, "Also not yours")
        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()
        response = APIClient().post(
            f"/clips/{other.id}/play/?s={share['token']}", {}, format="json"
        )
        assert response.status_code == 403

    def test_the_refusal_does_not_distinguish_scope_mismatch_from_invalid(
        self, owner, clip, django_user_model
    ):
        """Telling them apart would confirm that some other clip exists."""
        from rest_framework.test import APIClient

        other_owner = django_user_model.objects.create_user(
            username="other3", email="other3@example.com", password="pw-probe-123"
        )
        other = _clip_for(other_owner, "x")
        share = authed(owner).post(f"/clips/{clip.id}/share-link/", {}, format="json").json()

        mismatch = APIClient().post(
            f"/clips/{other.id}/play/", {"s": share["token"]}, format="json"
        )
        invalid = APIClient().post(
            f"/clips/{other.id}/play/", {"s": "garbage"}, format="json"
        )
        assert mismatch.status_code == invalid.status_code == 403
        assert mismatch.json() == invalid.json()

    def test_the_owning_user_gets_a_normal_media_token_independently(
        self, owner, clip
    ):
        """The signed-in path is unaffected: no share token needed, and it is
        still POST."""
        response = authed(owner).post(
            f"/media/playback-token/{clip.id}/", {}, format="json"
        )
        assert response.status_code == 200
        assert "ef_hls_token" in response.cookies


# ---------------------------------------------------------------------------
# Public metadata view
# ---------------------------------------------------------------------------

class TestPublicMetadata:
    def test_json_is_served_to_api_clients(self, clip):
        from rest_framework.test import APIClient

        response = APIClient().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT="application/json")
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == str(clip.id)
        assert body["title"] == "Shared clip"
        assert body["duration_ms"] == 4200

    def test_an_unmoderated_clip_is_invisible(self, clip):
        from rest_framework.test import APIClient

        clip.moderation_approved = False
        clip.save(update_fields=["moderation_approved"])
        response = APIClient().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT="application/json"
        )
        assert response.status_code == 404

    def test_it_does_not_leak_engagement_or_the_media_url(self, clip):
        """Data minimisation. This used to be FeedClipSerializer, so an
        unauthenticated caller could read the counters and the per-viewer
        is_liked field."""
        from rest_framework.test import APIClient

        body = APIClient().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT="application/json"
        ).json()
        for leaked in ("likes", "shares", "skips", "comment_count", "is_liked",
                       "hls_playlist_url", "creator_id"):
            assert leaked not in body, f"{leaked} must not be in the public payload"

    def test_opening_a_link_grants_no_credential(self, clip):
        """The point of the play gate: loading a shared link mints nothing."""
        from rest_framework.test import APIClient

        response = APIClient().get(
            f"/clips/{clip.id}/public/?s=anything", HTTP_ACCEPT="application/json"
        )
        assert response.status_code == 200
        assert "ef_hls_token" not in response.cookies

    def test_a_browser_gets_open_graph_tags(self, clip):
        from rest_framework.test import APIClient

        response = APIClient().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT="text/html,application/xhtml+xml"
        )
        assert response.status_code == 200
        assert response["Content-Type"].startswith("text/html")
        assert 'property="og:title"' in response.content.decode()
        assert "Shared clip" in response.content.decode()

    def test_a_user_supplied_title_is_escaped_in_the_card(self, owner, clip):
        """The card is an unauthenticated page rendering free text, so an
        unescaped title is stored XSS against whoever opens the link."""
        from rest_framework.test import APIClient

        clip.title = '<script>alert("xss")</script>'
        clip.save(update_fields=["title"])
        body = APIClient().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT="text/html"
        ).content.decode()
        assert "<script>" not in body
        assert "&lt;script&gt;" in body


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

class TestVerifyToken:
    def test_a_valid_token_decodes(self, owner, clip, settings):
        from backend.app.services.hls_token import generate_playback_token, verify_token

        settings.MEDIA_TOKEN_SECRET = "unit-test-secret"
        token = generate_playback_token(user_id=1, clip_key="hls/x")
        payload = verify_token(token)
        assert payload["c"] == "hls/x"
        assert payload["u"] == 1

    def test_malformed_tokens_return_none_rather_than_raising(self, settings):
        from backend.app.services.hls_token import verify_token

        settings.MEDIA_TOKEN_SECRET = "unit-test-secret"
        for value in (None, "", "no-dot", "a.b.c", "!!!.???", "." * 5):
            assert verify_token(value) is None

    def test_a_signed_but_malformed_payload_does_not_raise(self, settings):
        """A token signed by us with a non-dict or missing exp must not turn
        an authorization path into a 500."""
        import base64
        import hashlib
        import hmac
        import json

        from backend.app.services.hls_token import verify_token

        secret = b"unit-test-secret"
        settings.MEDIA_TOKEN_SECRET = "unit-test-secret"
        for payload_obj in ({"v": 1}, {"v": 1, "exp": "soon", "c": "hls/x"},
                            {"v": 1, "exp": 99999999999}, [1, 2, 3], "string"):
            raw = json.dumps(payload_obj).encode()
            b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
            sig = hmac.new(secret, b64.encode(), hashlib.sha256).digest()
            token = f"{b64}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"
            assert verify_token(token) is None, payload_obj

    def test_the_ttl_override_does_not_change_the_payload_shape(self, owner, settings):
        """The Worker and nginx njs parsers must keep working. Verified here
        on the Python side; the TS side has its own suite."""
        from backend.app.services.hls_token import generate_playback_token, verify_token

        settings.MEDIA_TOKEN_SECRET = "unit-test-secret"
        payload = verify_token(generate_playback_token(1, "hls/x", ttl=99999))
        assert set(payload) == {"c", "exp", "iat", "u", "v"}
        assert payload["v"] == 1

    def test_the_default_ttl_is_unchanged_when_no_override(self, settings):
        from backend.app.services.hls_token import generate_playback_token, verify_token

        settings.MEDIA_TOKEN_SECRET = "unit-test-secret"
        settings.MEDIA_TOKEN_TTL_SECONDS = 600
        payload = verify_token(generate_playback_token(1, "hls/x"))
        assert payload["exp"] - payload["iat"] == 600
