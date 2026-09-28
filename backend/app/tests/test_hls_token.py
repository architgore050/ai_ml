"""Unit tests for backend.app.services.hls_token.

Tests:
  - Token generation produces a 2-part base64url string
  - Token validation accepts valid tokens, rejects tampered/expired/out-of-scope
  - Cookie extraction works for various Cookie header formats
  - HMAC verification is timing-safe (indirectly via hmac.compare_digest)
  - Clip key extraction from hls_playlist_url is correct

These tests do NOT require Docker/PostgreSQL — the token service is pure
Python + hashlib + hmac, so it's a fast unit test.
"""
import base64
import hashlib
import hmac
import json
import time

import pytest


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def token_secret(settings):
    settings.MEDIA_TOKEN_SECRET = "test-secret-key-for-unit-tests"
    return settings.MEDIA_TOKEN_SECRET


@pytest.fixture
def token_ttl(settings):
    settings.MEDIA_TOKEN_TTL_SECONDS = 600
    return 600


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

class TestGeneratePlaybackToken:
    def test_produces_two_part_base64url_string(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token

        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        assert "." in token
        parts = token.split(".")
        assert len(parts) == 2
        # Both parts should be valid base64url
        for part in parts:
            decoded = base64.urlsafe_b64decode(
                part + "=" * (4 - len(part) % 4) if len(part) % 4 else part
            )
            assert decoded  # non-empty

    def test_payload_contains_expected_fields(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, _b64url_decode

        token = generate_playback_token(user_id=42, clip_key="hls/abc-123")
        payload_b64 = token.split(".")[0]
        payload_json = _b64url_decode(payload_b64)
        payload = json.loads(payload_json)

        assert payload["u"] == 42
        assert payload["c"] == "hls/abc-123"
        assert payload["v"] == 1
        assert "exp" in payload
        assert "iat" in payload

    def test_exp_is_now_plus_ttl(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, _b64url_decode

        before = int(time.time())
        token = generate_playback_token(user_id=1, clip_key="hls/x")
        after = int(time.time())

        payload_b64 = token.split(".")[0]
        payload = json.loads(_b64url_decode(payload_b64))

        expected_min = before + token_ttl
        expected_max = after + token_ttl
        assert expected_min <= payload["exp"] <= expected_max
        assert payload["iat"] <= after

    def test_iat_is_current_time(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, _b64url_decode

        before = int(time.time())
        token = generate_playback_token(user_id=1, clip_key="hls/x")
        after = int(time.time())

        payload = json.loads(_b64url_decode(token.split(".")[0]))
        assert before <= payload["iat"] <= after

    def test_token_format_matches_doc_spec(self, token_secret, token_ttl):
        """Verify the token matches the exact format from the design doc."""
        from backend.app.services.hls_token import generate_playback_token

        token = generate_playback_token(
            user_id=123,
            clip_key="hls/abc-123-def",
        )
        # Format: base64url(payload_json).base64url(hmac_sha256(secret, base64url(payload_json)))
        payload_b64, sig_b64 = token.split(".")

        # Reconstruct payload and verify
        payload_json = json.loads(
            base64.urlsafe_b64decode(
                payload_b64 + "=" * (4 - len(payload_b64) % 4)
            ).decode("utf-8")
        )
        assert payload_json["u"] == 123
        assert payload_json["c"] == "hls/abc-123-def"

        # Verify signature
        expected_sig = hmac.new(
            token_secret.encode("utf-8"),
            payload_b64.encode("ascii"),
            hashlib.sha256,
        ).digest()
        expected_sig_b64 = base64.urlsafe_b64encode(expected_sig).rstrip(b"=").decode("ascii")
        assert sig_b64 == expected_sig_b64


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class TestValidatePlaybackToken:
    def test_valid_token_passes(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")
        payload = validate_playback_token(token, "/hls/abc-123/master.m3u8")

        assert payload is not None
        assert payload["u"] == 1
        assert payload["c"] == "hls/abc-123"

    def test_tampered_payload_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token, _b64url_encode
        import json

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")
        payload_b64, sig_b64 = token.split(".")

        # Tamper: change the user_id in the payload
        payload = json.loads(
            base64.urlsafe_b64decode(
                payload_b64 + "=" * (4 - len(payload_b64) % 4)
            ).decode("utf-8")
        )
        payload["u"] = 999  # forged user ID
        tampered_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        tampered_b64 = _b64url_encode(tampered_json.encode("utf-8"))

        result = validate_playback_token(f"{tampered_b64}.{sig_b64}", "/hls/abc-123/master.m3u8")
        assert result is None

    def test_expired_token_rejected(self, token_secret):
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token, _b64url_decode, _b64url_encode
        import json

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")
        payload_b64, sig_b64 = token.split(".")

        # Forge an expired payload
        payload = json.loads(_b64url_decode(payload_b64))
        payload["exp"] = int(time.time()) - 1  # expired 1 second ago
        expired_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        expired_b64 = _b64url_encode(expired_json.encode("utf-8"))

        # Re-sign with the same key (simulating a token that was valid but expired)
        import hmac as hmac_mod
        new_sig = hmac_mod.new(
            token_secret.encode("utf-8"),
            expired_b64.encode("ascii"),
            hashlib.sha256,
        ).digest()
        new_sig_b64 = _b64url_encode(new_sig)

        result = validate_playback_token(
            f"{expired_b64}.{new_sig_b64}",
            "/hls/abc-123/master.m3u8",
        )
        assert result is None

    def test_wrong_clip_scope_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")

        # Token is for clip "hls/abc-123" but request is for "hls/xyz-789"
        result = validate_playback_token(token, "/hls/xyz-789/master.m3u8")
        assert result is None

    def test_wrong_clip_scope_partial_match_rejected(self, token_secret, token_ttl):
        """A token for 'hls/abc-123' must NOT work on 'hls/abc-123-sub/'."""
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")

        # The clip key is "hls/abc-123" — the request path must start with
        # "/hls/abc-123/". "hls/abc-123-sub" does not match.
        result = validate_playback_token(token, "/hls/abc-123-sub/master.m3u8")
        assert result is None

    def test_correct_clip_scope_accepted(self, token_secret, token_ttl):
        """Token for 'hls/abc-123' should work on any path under /hls/abc-123/."""
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")

        result = validate_playback_token(token, "/hls/abc-123/master.m3u8")
        assert result is not None

        result = validate_playback_token(token, "/hls/abc-123/segment_1.ts")
        assert result is not None

        result = validate_playback_token(token, "/hls/abc-123/sub/variant.m3u8")
        assert result is not None

    def test_no_clipping_path_slash_accepted(self, token_secret, token_ttl):
        """Edge case: token for 'hls/abc-123' on path '/hls/abc-123' (no trailing slash)."""
        from backend.app.services.hls_token import generate_playback_token, validate_playback_token

        token = generate_playback_token(user_id=1, clip_key="hls/abc-123")

        # Without the trailing slash, the prefix "/hls/abc-123/" doesn't match
        # "/hls/abc-123" — this is correct: we require the path separator
        result = validate_playback_token(token, "/hls/abc-123")
        assert result is None

    def test_missing_token_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import validate_playback_token

        assert validate_playback_token("", "/hls/abc-123/master.m3u8") is None
        assert validate_playback_token(None, "/hls/abc-123/master.m3u8") is None

    def test_malformed_token_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import validate_playback_token

        assert validate_playback_token("not-a-token", "/hls/abc-123/master.m3u8") is None
        assert validate_playback_token("a.b.c", "/hls/abc-123/master.m3u8") is None
        assert validate_playback_token("a", "/hls/abc-123/master.m3u8") is None

    def test_bad_signature_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import validate_playback_token

        token = "eyJ1IjogMSwgImMiOiAiaGxzL2FiYy0xMjMifQ.signature_mismatch"
        result = validate_playback_token(token, "/hls/abc-123/master.m3u8")
        assert result is None

    def test_wrong_version_rejected(self, token_secret, token_ttl):
        from backend.app.services.hls_token import validate_playback_token, _b64url_encode
        import json

        # Craft a payload with version != 1
        payload = {"u": 1, "c": "hls/abc-123", "exp": int(time.time()) + 600,
                   "iat": int(time.time()), "v": 2}
        payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        payload_b64 = _b64url_encode(payload_json.encode("utf-8"))

        import hmac as hmac_mod
        sig = hmac_mod.new(
            token_secret.encode("utf-8"),
            payload_b64.encode("ascii"),
            hashlib.sha256,
        ).digest()
        sig_b64 = _b64url_encode(sig)

        result = validate_playback_token(
            f"{payload_b64}.{sig_b64}",
            "/hls/abc-123/master.m3u8",
        )
        assert result is None


# ---------------------------------------------------------------------------
# Cookie extraction
# ---------------------------------------------------------------------------

class TestExtractTokenFromCookie:
    def test_extracts_valid_cookie(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, extract_token_from_cookie

        token = generate_playback_token(user_id=1, clip_key="hls/x")
        cookie_header = f"session=abc; ef_hls_token={token}; other=def"

        result = extract_token_from_cookie(cookie_header)
        assert result == token

    def test_returns_none_when_no_cookie(self):
        from backend.app.services.hls_token import extract_token_from_cookie

        assert extract_token_from_cookie(None) is None
        assert extract_token_from_cookie("") is None
        assert extract_token_from_cookie("session=abc") is None

    def test_handles_whitespace_in_cookie_header(self, token_secret, token_ttl):
        from backend.app.services.hls_token import generate_playback_token, extract_token_from_cookie

        token = generate_playback_token(user_id=1, clip_key="hls/x")
        cookie_header = f"  session=abc  ;  ef_hls_token={token}  ;  other=def  "

        result = extract_token_from_cookie(cookie_header)
        assert result == token


# ---------------------------------------------------------------------------
# HLS URL shape
#
# The Worker's scope check requires the request path to start with "/<clip>/",
# where <clip> is the token's `c` field, and its own routing requires the path
# to start with "/hls/". A bucket-prefixed URL therefore 404s at the edge with
# nothing to do with auth. These lock the two shapes in place.
# ---------------------------------------------------------------------------

class TestHlsUrlShape:
    KEY = "hls/abc-123/master.m3u8"

    def test_edge_style_is_bucketless(self, settings):
        from backend.app.media_urls import get_hls_playback_url

        settings.HLS_URL_STYLE = "edge"
        settings.PUBLIC_HLS_ENDPOINT_URL = "https://localhost:19443"
        settings.PUBLIC_MEDIA_ENDPOINT_URL = "http://localhost:19000"

        url = get_hls_playback_url(self.KEY)
        assert url == "https://localhost:19443/hls/abc-123/master.m3u8"
        # The whole point: no bucket segment, so the path starts with /hls/.
        assert url.split("://", 1)[1].split("/", 1)[1].startswith("hls/")
        assert "echoflow-media" not in url

    def test_bucket_style_keeps_the_bucket_segment(self, settings):
        from backend.app.media_urls import get_hls_playback_url

        settings.HLS_URL_STYLE = "bucket"
        settings.PUBLIC_MEDIA_ENDPOINT_URL = "http://localhost:19000"
        settings.STORAGES = {
            **settings.STORAGES,
            "default": {
                **settings.STORAGES["default"],
                "OPTIONS": {**settings.STORAGES["default"]["OPTIONS"], "bucket_name": "echoflow-media"},
            },
        }

        assert get_hls_playback_url(self.KEY) == (
            "http://localhost:19000/echoflow-media/hls/abc-123/master.m3u8"
        )

    def test_edge_style_strips_a_trailing_slash_on_the_origin(self, settings):
        from backend.app.media_urls import get_hls_playback_url

        settings.HLS_URL_STYLE = "edge"
        settings.PUBLIC_HLS_ENDPOINT_URL = "https://media.echoflow.in/"

        assert get_hls_playback_url(self.KEY) == (
            "https://media.echoflow.in/hls/abc-123/master.m3u8"
        )

    def test_falsy_object_key_returns_none_in_both_styles(self, settings):
        from backend.app.media_urls import get_hls_playback_url

        for style in ("edge", "bucket"):
            settings.HLS_URL_STYLE = style
            assert get_hls_playback_url("") is None
            assert get_hls_playback_url(None) is None

    def test_signed_upload_urls_still_use_the_storage_origin(self, settings):
        """The edge must not leak into presigned uploads/ URLs.

        If these two settings are ever collapsed, uploads break while HLS
        keeps working — the kind of regression that is easy to miss because
        the HLS path is the one being actively tested.
        """
        from backend.app import media_urls

        settings.HLS_URL_STYLE = "edge"
        settings.PUBLIC_HLS_ENDPOINT_URL = "https://media.echoflow.in"
        settings.PUBLIC_MEDIA_ENDPOINT_URL = "https://storage.echoflow.in"
        settings.AWS_S3_QUERYSTRING_EXPIRE = 600
        settings.STORAGES = {
            **settings.STORAGES,
            "default": {
                **settings.STORAGES["default"],
                "OPTIONS": {
                    **settings.STORAGES["default"]["OPTIONS"],
                    "access_key": "ak",
                    "secret_key": "sk",
                    "region_name": "auto",
                    "addressing_style": "path",
                },
            },
        }

        url = media_urls.get_signed_media_url("uploads/original.mp3")
        assert url.startswith("https://storage.echoflow.in")
        assert "media.echoflow.in" not in url


# ---------------------------------------------------------------------------
# Clip key extraction
# ---------------------------------------------------------------------------

class TestExtractClipKey:
    def test_strips_the_playlist_filename(self):
        from backend.app.views.media import _extract_clip_key

        assert _extract_clip_key("hls/abc-123/master.m3u8") == "hls/abc-123"

    def test_returns_none_for_null_playlist_url(self):
        """hls_playlist_url is null=True.

        rsplit on None raised AttributeError, turning a not-yet-processed clip
        into a 500 instead of a 4xx.
        """
        from backend.app.views.media import _extract_clip_key

        assert _extract_clip_key(None) is None
        assert _extract_clip_key("") is None


# ---------------------------------------------------------------------------
# PlaybackTokenView
#
# The view is the token ISSUER — the Django half of the gate — and had no
# coverage at all. The cookie attributes below are the contract the Worker and
# the browser depend on; a silent change to any of them is a security or
# playback regression.
# ---------------------------------------------------------------------------

class TestPlaybackTokenView:
    @pytest.fixture
    def user(self, django_user_model):
        return django_user_model.objects.create_user(
            username="viewer", email="viewer@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def ready_clip(self, user):
        from backend.app.models import AudioClip

        return AudioClip.objects.create(
            creator=user,
            title="probe",
            moderation_approved=True,
            status="ready",
            hls_playlist_url="hls/00000000-0000-0000-0000-000000000001/master.m3u8",
        )

    @pytest.fixture
    def authed(self, user, token_secret, token_ttl):
        # DRF's APIClient, not the plain Django one: force_authenticate is a
        # DRF test helper, and issuing a real JWT would only add a second
        # thing that can be broken.
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def url(self, clip_id):
        return f"/media/playback-token/{clip_id}/"

    def test_issues_the_cookie_with_the_contract_attributes(
        self, authed, ready_clip, settings
    ):
        response = authed.post(self.url(ready_clip.id))
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

        cookie = response.cookies["ef_hls_token"]
        # Path must cover the whole clip, not just the master playlist.
        assert cookie["path"] == "/hls/"
        assert cookie["httponly"] is True
        assert cookie["secure"] is True
        # Lax, not Strict: the master playlist is fetched on a top-level
        # navigation, and Strict would withhold the cookie there.
        assert cookie["samesite"] == "Lax"
        # No Domain in local dev: both origins are `localhost`, which rejects
        # domain cookies. Omitting it keeps the cookie host-only.
        assert cookie["domain"] in ("", None)

    def test_max_age_tracks_media_token_ttl_seconds(self, authed, ready_clip, settings):
        settings.MEDIA_TOKEN_TTL_SECONDS = 60
        response = authed.post(self.url(ready_clip.id))
        assert response.cookies["ef_hls_token"]["max-age"] == 60

        settings.MEDIA_TOKEN_TTL_SECONDS = 1800
        response = authed.post(self.url(ready_clip.id))
        assert response.cookies["ef_hls_token"]["max-age"] == 1800

    def test_domain_is_set_when_media_token_cookie_domain_is(
        self, authed, ready_clip, settings
    ):
        # Required in production when the media origin is a different host
        # from the API; without it the cookie is host-only and never sent.
        settings.MEDIA_TOKEN_COOKIE_DOMAIN = ".echoflow.in"
        response = authed.post(self.url(ready_clip.id))
        assert response.cookies["ef_hls_token"]["domain"] == ".echoflow.in"

    def test_issued_cookie_validates_against_the_request_path(
        self, authed, ready_clip
    ):
        """End of the gate: the cookie the view sets must be accepted for the
        clip's own path and rejected for a different clip's."""
        from backend.app.services.hls_token import validate_playback_token

        response = authed.post(self.url(ready_clip.id))
        token = response.cookies["ef_hls_token"].value

        assert validate_playback_token(
            token, "/hls/00000000-0000-0000-0000-000000000001/master.m3u8",
        ) is not None
        assert validate_playback_token(
            token, "/hls/00000000-0000-0000-0000-000000000099/master.m3u8",
        ) is None

    def test_requires_authentication(self, user, token_secret, token_ttl, ready_clip):
        from rest_framework.test import APIClient

        response = APIClient().post(self.url(ready_clip.id))
        assert response.status_code in (401, 403)

    def test_unknown_clip_is_404(self, authed, token_secret, token_ttl):
        import uuid

        response = authed.post(self.url(uuid.uuid4()))
        assert response.status_code == 404

    def test_unmoderated_clip_is_403(self, authed, ready_clip, token_secret, token_ttl):
        ready_clip.moderation_approved = False
        ready_clip.save(update_fields=["moderation_approved"])

        response = authed.post(self.url(ready_clip.id))
        assert response.status_code == 403
        assert "ef_hls_token" not in response.cookies

    def test_clip_without_hls_output_is_409_not_500(self, authed, user, token_secret, token_ttl):
        """hls_playlist_url is null until media processing runs.

        _extract_clip_key used to rsplit(None) and raise, producing a 500
        and a stack trace in the logs for an entirely ordinary state.
        """
        from backend.app.models import AudioClip

        clip = AudioClip.objects.create(
            creator=user, title="unprocessed", moderation_approved=True, status="pending"
        )
        assert clip.hls_playlist_url is None

        response = authed.post(self.url(clip.id))
        assert response.status_code == 409
        assert "ef_hls_token" not in response.cookies


# ---------------------------------------------------------------------------
# Native transport
#
# A React Native client cannot use the cookie. AVPlayer (iOS) does not read
# NSHTTPCookieStorage, and ExoPlayer's DefaultHttpDataSource (Android) sends
# no Cookie header at all. The token is also HttpOnly and Secure, so the app
# cannot read it back out of the cookie jar either. Without a second
# transport there is no way for a mobile client to present a credential.
#
# These tests pin the opt-in: the token appears in the body ONLY for a caller
# that declares itself native, the cookie is still set either way, and the
# body token is the same credential the edge already validates.
# ---------------------------------------------------------------------------

# Passed as WSGI extra kwargs, NOT as APIClient's second positional argument:
# that position is `data`, which for a GET becomes the query string, so
# `client.get(url, HEADERS)` silently sends `?HTTP_X_ECHOFLOW_CLIENT=native`
# and the view never sees a header at all.
NATIVE_HEADERS = {"HTTP_X_ECHOFLOW_CLIENT": "native"}


class TestNativeTokenTransport:
    @pytest.fixture
    def user(self, django_user_model):
        return django_user_model.objects.create_user(
            username="native", email="native@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def ready_clip(self, user):
        from backend.app.models import AudioClip

        return AudioClip.objects.create(
            creator=user,
            title="native probe",
            moderation_approved=True,
            status="ready",
            hls_playlist_url="hls/00000000-0000-0000-0000-00000000000a/master.m3u8",
        )

    @pytest.fixture
    def authed(self, user, token_secret, token_ttl):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def url(self, clip_id):
        return f"/media/playback-token/{clip_id}/"

    def test_native_client_receives_the_token_in_the_body(self, authed, ready_clip):
        response = authed.post(self.url(ready_clip.id), **NATIVE_HEADERS)

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body.get("token"), "native client was not given the token value"

    def test_body_token_is_the_same_credential_as_the_cookie(
        self, authed, ready_clip
    ):
        """The two transports must not diverge.

        If these ever differ, a client that reads the body but the edge
        validates something else would 403 on every segment — and a client
        that reads the cookie but validates the body would 403 too. Pinning
        equality is what makes the two interchangeable.
        """
        response = authed.post(self.url(ready_clip.id), **NATIVE_HEADERS)

        assert response.json()["token"] == response.cookies["ef_hls_token"].value

    def test_body_token_validates_against_the_clips_own_path(self, authed, ready_clip):
        """End of the gate for the native transport: the body token must be
        accepted by the same validator the Worker uses, for this clip's path
        and rejected for a different clip's."""
        from backend.app.services.hls_token import validate_playback_token

        token = authed.post(self.url(ready_clip.id), **NATIVE_HEADERS).json()["token"]

        assert validate_playback_token(
            token, "/hls/00000000-0000-0000-0000-00000000000a/master.m3u8"
        ) is not None
        assert validate_playback_token(
            token, "/hls/00000000-0000-0000-0000-00000000000b/master.m3u8"
        ) is None

    def test_non_native_client_does_not_receive_the_token_in_the_body(
        self, authed, ready_clip
    ):
        """The default is unchanged. A bearer credential must not start
        appearing in response bodies for callers that did not ask for it —
        that is what HttpOnly is for."""
        response = authed.post(self.url(ready_clip.id))
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert "token" not in response.json()
        # The cookie is still issued, so the web path is untouched.
        assert "ef_hls_token" in response.cookies

    @pytest.mark.parametrize(
        "header_value",
        ["web", "NATIVE", "native ", "ios", "", "browser-native"],
    )
    def test_only_the_exact_native_value_opts_in(
        self, authed, ready_clip, header_value
    ):
        """The match is exact and case-sensitive.

        A prefix or case variant must not opt in, otherwise a client whose
        header handling is sloppy receives a credential in a body it may log.
        """
        response = authed.get(
            self.url(ready_clip.id), **{"HTTP_X_ECHOFLOW_CLIENT": header_value}
        )
        assert "token" not in response.json(), f"{header_value!r} was treated as native"

    def test_native_client_still_gets_the_cookie(self, authed, ready_clip):
        """Opting into the body must not remove the cookie. A native client
        is allowed to use either; giving it both keeps the web contract
        intact and makes the change additive rather than a replacement."""
        response = authed.post(self.url(ready_clip.id), **NATIVE_HEADERS)

        cookie = response.cookies["ef_hls_token"]
        assert cookie["httponly"] is True
        assert cookie["secure"] is True
        assert cookie["samesite"] == "Lax"
        assert cookie["path"] == "/hls/"

    def test_native_flag_does_not_bypass_moderation(self, authed, ready_clip):
        """The header is a transport opt-in, not a privilege. An unmoderated
        clip must stay a 403 for a native caller exactly as for a browser,
        and must carry neither a token nor a cookie."""
        ready_clip.moderation_approved = False
        ready_clip.save(update_fields=["moderation_approved"])

        response = authed.post(self.url(ready_clip.id), **NATIVE_HEADERS)

        assert response.status_code == 403
        assert "token" not in response.json()
        assert "ef_hls_token" not in response.cookies

    def test_native_flag_does_not_bypass_authentication(self, ready_clip, token_secret, token_ttl):
        from rest_framework.test import APIClient

        response = APIClient().post(self.url(ready_clip.id), **NATIVE_HEADERS)
        assert response.status_code in (401, 403)
        assert "token" not in response.json()


# ---------------------------------------------------------------------------
# Entitlement: who may be issued a playback token at all
# ---------------------------------------------------------------------------

class TestPlaybackTokenEntitlement:
    """PlaybackTokenView must not authorize on `moderation_approved` alone.

    FastFeedViewSet also filters is_noncommercial=False and
    requires_share_alike=False. Before resolve_clip_access() existed the
    token endpoint applied neither, so any authenticated user could mint a
    token for an NC/SA clip the feed never serves. These tests pin the
    licensing predicate specifically, because that is the part that was
    actually exploitable.
    """

    @pytest.fixture(autouse=True)
    def _clear_throttle_budget(self):
        """Reset the DRF throttle counters before each test.

        The cache backend is real Redis (``settings.CACHES`` uses
        ``django_redis.cache.RedisCache``), and ``conftest.py`` does not
        clear it. So throttle budgets accumulate across the whole suite and
        persist between runs. Without this, an authorization test can fail
        because an unrelated test file consumed the shared ``user``
        (1000/hour) budget — which is exactly what happened: these tests
        passed in isolation and failed in a larger combined run.
        """
        from django.core.cache import cache

        cache.clear()
        yield
        cache.clear()

    @pytest.fixture
    def viewer(self, django_user_model):
        return django_user_model.objects.create_user(
            username="viewer", email="viewer@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def author(self, django_user_model):
        return django_user_model.objects.create_user(
            username="author", email="author@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def authed(self, viewer, token_secret, token_ttl):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=viewer)
        return client

    def make_clip(self, author, **kwargs):
        from backend.app.models import AudioClip

        defaults = dict(
            creator=author,
            title="probe",
            moderation_approved=True,
            status="ready",
            hls_playlist_url="hls/00000000-0000-0000-0000-000000000009/master.m3u8",
        )
        defaults.update(kwargs)
        return AudioClip.objects.create(**defaults)

    def url(self, clip_id):
        return f"/media/playback-token/{clip_id}/"

    # --- the licensing bypass -------------------------------------------

    @pytest.mark.parametrize("field", ["is_noncommercial", "requires_share_alike"])
    def test_license_restricted_clip_is_refused_to_a_stranger(
        self, authed, author, field
    ):
        clip = self.make_clip(author, **{field: True})
        response = authed.post(self.url(clip.id))
        assert response.status_code == 403
        # The response must not tell an unauthorised caller which license
        # the clip carries.
        assert "noncommercial" not in response.json()["detail"].lower()
        assert "share_alike" not in response.json()["detail"].lower()
        assert "token" not in response.json()

    @pytest.mark.parametrize("field", ["is_noncommercial", "requires_share_alike"])
    def test_owner_may_still_play_their_own_restricted_clip(
        self, author, token_secret, token_ttl, field
    ):
        """NC/SA restrict redistribution; the uploader must hear their own clip."""
        from rest_framework.test import APIClient

        clip = self.make_clip(author, **{field: True})
        client = APIClient()
        client.force_authenticate(user=author)
        assert client.post(self.url(clip.id)).status_code == 200

    def test_interaction_does_not_launder_a_restricted_clip(
        self, authed, author, viewer
    ):
        """A prior interaction is not a licence to redistribute NC/SA audio."""
        from backend.app.models import UserInteraction

        clip = self.make_clip(author, is_noncommercial=True)
        UserInteraction.objects.create(
            user=viewer,
            clip=clip,
            interaction_type="view",
        )
        assert authed.post(self.url(clip.id)).status_code == 403

    def test_in_app_share_grants_access_to_a_restricted_clip(
        self, authed, author, viewer
    ):
        from backend.app.models import ShareEvent

        clip = self.make_clip(author, is_noncommercial=True)
        ShareEvent.objects.create(sender=author, receiver=viewer, clip=clip)
        assert authed.post(self.url(clip.id)).status_code == 200

    # --- the other access paths ----------------------------------------

    def test_following_the_author_allows_a_license_clean_clip(
        self, authed, author, viewer
    ):
        clip = self.make_clip(author)
        viewer.following.add(author)
        assert authed.post(self.url(clip.id)).status_code == 200

    def test_unmoderated_clip_is_refused_even_to_its_owner(
        self, author, token_secret, token_ttl
    ):
        """Existing behaviour preserved: nobody gets a token pre-approval."""
        from rest_framework.test import APIClient

        clip = self.make_clip(author, moderation_approved=False)
        client = APIClient()
        client.force_authenticate(user=author)
        assert client.post(self.url(clip.id)).status_code == 403

    def test_license_clean_clip_without_any_relationship_is_allowed(
        self, authed, author
    ):
        """Documents the accepted v1 residual, and guards the feed path.

        resolve_clip_access is a licensing gate, not a privacy gate: a
        moderated, license-clean clip is playable by any authenticated user.
        That is required, not merely tolerated — feed_pool.py builds both
        halves of the feed from AudioClip.objects.filter(status='ready')
        with no creator/following scoping, so most feed clips come from
        authors the user has no relationship with. Denying those would 403
        the primary playback path.
        """
        assert authed.post(self.url(self.make_clip(author).id)).status_code == 200

    def test_license_restriction_still_applies_when_the_feed_itself_is_empty(
        self, authed, author
    ):
        """The predicate is on the clip, not on feed state.

        Regression guard for the original bug, which was that feed filters
        were assumed to be the gate. If feed state ever leaks into this
        decision, a cold/empty feed would make restricted clips playable.
        """
        clip = self.make_clip(author, is_noncommercial=True)
        response = authed.post(self.url(clip.id))
        assert response.status_code == 403


# ---------------------------------------------------------------------------
# Unit tests for resolve_clip_access itself
# ---------------------------------------------------------------------------

class TestResolveClipAccess:
    @pytest.fixture
    def viewer(self, django_user_model):
        return django_user_model.objects.create_user(
            username="v", email="v@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def author(self, django_user_model):
        return django_user_model.objects.create_user(
            username="a", email="a@example.com", password="pw-probe-123"
        )

    def clip(self, author, **kwargs):
        from backend.app.models import AudioClip

        defaults = dict(
            creator=author,
            title="t",
            moderation_approved=True,
            status="ready",
            hls_playlist_url="hls/x/master.m3u8",
        )
        defaults.update(kwargs)
        return AudioClip.objects.create(**defaults)

    def test_unmoderated_short_circuits_before_ownership(self, viewer, author):
        """Owner check must not rescue an unmoderated clip."""
        from backend.app.services.entitlements import (
            DENY_NOT_MODERATED,
            resolve_clip_access,
        )

        clip = self.clip(author, moderation_approved=False)
        assert resolve_clip_access(author, clip) == (False, DENY_NOT_MODERATED)

    def test_owner_is_allowed(self, author):
        from backend.app.services.entitlements import (
            ACCESS_OWNER,
            resolve_clip_access,
        )

        assert resolve_clip_access(author, self.clip(author)) == (True, ACCESS_OWNER)

    def test_stranger_on_clean_clip_is_allowed_with_no_relationship(
        self, viewer, author
    ):
        from backend.app.services.entitlements import (
            ACCESS_PUBLIC_CLEAN,
            resolve_clip_access,
        )

        # A clean clip is allowed outright. Denying it would break the feed,
        # because feed_pool.py does not scope the pool to a social graph.
        assert resolve_clip_access(viewer, self.clip(author)) == (
            True,
            ACCESS_PUBLIC_CLEAN,
        )

    def test_stranger_on_restricted_clip_is_denied_with_the_license_reason(
        self, viewer, author
    ):
        from backend.app.services.entitlements import (
            DENY_LICENSED,
            resolve_clip_access,
        )

        clip = self.clip(author, requires_share_alike=True)
        assert resolve_clip_access(viewer, clip) == (False, DENY_LICENSED)

    def test_is_license_restricted_reads_both_flags(self, author):
        from backend.app.services.entitlements import is_license_restricted

        assert is_license_restricted(self.clip(author)) is False
        assert is_license_restricted(self.clip(author, is_noncommercial=True)) is True
        assert (
            is_license_restricted(self.clip(author, requires_share_alike=True)) is True
        )


class TestPlaybackTokenMethodContract:
    """The endpoint must be POST. GET was retired 2026-09-29.

    Minting a credential must not be a safe method: a GET is CSRF-able (the
    ef_hls_token cookie is SameSite=Lax), prefetchable by browsers and
    proxies, and cacheable by intermediaries. Any of those mints tokens
    nobody asked for and burns rate-limit budget.
    """

    @pytest.fixture
    def viewer(self, django_user_model):
        return django_user_model.objects.create_user(
            username="viewer", email="viewer@example.com", password="pw-probe-123"
        )

    @pytest.fixture
    def clip(self, viewer):
        from backend.app.models import AudioClip

        return AudioClip.objects.create(
            creator=viewer,
            title="probe",
            moderation_approved=True,
            status="ready",
            hls_playlist_url="hls/00000000-0000-0000-0000-00000000000f/master.m3u8",
        )

    @pytest.fixture
    def authed(self, viewer, token_secret, token_ttl):
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(user=viewer)
        return client

    def test_get_is_rejected_and_explains_why(self, authed, clip):
        response = authed.get(f"/media/playback-token/{clip.id}/")
        assert response.status_code == 405
        detail = response.json()["detail"]
        # An old client needs to know to switch to POST, not to conclude the
        # clip is unavailable.
        assert "POST" in detail
        # And it must not have leaked a token on the way out.
        assert "ef_hls_token" not in response.cookies

    def test_post_is_accepted(self, authed, clip):
        response = authed.post(f"/media/playback-token/{clip.id}/")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        assert "ef_hls_token" in response.cookies

    def test_get_is_rejected_before_any_authorization_work(self, authed, clip):
        """A 405 must not depend on the clip existing.

        If GET fell through to the entitlement check, a 403 vs 405 would
        leak whether a given clip UUID is real to an unauthorized caller.
        """
        import uuid

        response = authed.get(f"/media/playback-token/{uuid.uuid4()}/")
        assert response.status_code == 405
