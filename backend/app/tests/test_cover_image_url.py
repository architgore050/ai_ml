"""DEFECT B — `cover_image` was presigned against the Docker-internal hostname.

Both `get_cover_image` implementations did::

    request.build_absolute_uri(obj.cover_image.url)

`FieldFile.url` reaches django-storages' `S3Storage.url()`, and with
`"querystring_auth": True` in `STORAGES["default"]["OPTIONS"]` that calls
`generate_presigned_url` on a boto3 client built from
`AWS_S3_ENDPOINT_URL` — the *container-internal* endpoint, `http://minio:9000`,
a Docker-network-only DNS name. `build_absolute_uri()` returns an
already-absolute URL verbatim, so it does not repair the host.

The client therefore received a **validly-signed** URL, valid for
`querystring_expire` seconds (3600 by default), pointing at an internal
hostname that discloses the storage engine and the in-network DNS. That is
exactly the "ENDPOINT MISMATCH" that `backend/app/media_urls.py:1-11` exists to
document — and the file already contains the correct helper,
`get_signed_media_url()`, which signs against `PUBLIC_MEDIA_ENDPOINT_URL`.
`get_cover_image` bypassed it and called `default_storage` directly: a straight
copy of the bug the module was written to prevent.

Severity is higher than the feed case for two reasons: the pattern is
duplicated on an **unauthenticated** path (`GET /clips/{id}/public/`,
`AllowAny`), and the result is embedded in the `og:image` meta tag of the
public share card by `_render_share_card` in `views/content.py`, so any link
unfurler (Slack, WhatsApp, iMessage) receives the internal URL.

Why this is easy to miss, and how the tests below refuse to be fooled by it
-------------------------------------------------------------------------
`cover_image` is a `blank=True, null=True` `ImageField` with no default, and
it is NOT in `AudioUploadSerializer.Meta.fields`. No API route can set it, so
every clip in the live database has `cover_image IS NULL` and the buggy line
is never reached. It goes live silently the moment anyone adds cover upload.

So a test that builds a clip the way the fixtures everywhere else in this
suite do — `AudioClip.objects.create(...)` with no cover — exercises the
`None` branch and passes for the wrong reason. `assert_cover_fixture` below
asserts the fixture's own persisted state (non-null, non-empty name, correct
`upload_to` prefix, re-read from the DB) before any assertion about the URL,
and `test_a_clip_with_no_cover_still_returns_none` covers the other branch
separately so neither test can stand in for the other.
"""
from unittest.mock import patch
from urllib.parse import urlparse

import pytest
from django.test import RequestFactory
from rest_framework.test import APIClient

from backend.app.models import AudioClip

pytestmark = pytest.mark.django_db


#: Extra host fragments that would identify in-network object storage even if
#: `AWS_S3_ENDPOINT_URL` were reconfigured to something unremarkable. Checked
#: as "any of", not "all of": the local stack's endpoint is
#: `http://minio-local:9000` (hyphenated network alias — `minio_local` is not a
#: legal RFC 1123 hostname), while the brief's description of this defect said
#: `http://minio:9000`. The authoritative check is the configured
#: `STORAGES[...]["endpoint_url"]`; these are belt-and-braces.
INTERNAL_ENDPOINT_MARKERS = ("minio", ":9000", "localhost:9000", "127.0.0.1:9000")


def internal_netloc(settings):
    """The host `S3Storage.url()` signs against — the one that must not ship.

    Read from the storage options rather than hardcoded, so this file keeps
    working if the deployment renames its MinIO service, and so it fails loudly
    if the options are ever restructured.
    """
    endpoint = settings.STORAGES["default"]["OPTIONS"].get("endpoint_url")
    assert endpoint, (
        "AWS_S3_ENDPOINT_URL is unset, so there is no internal endpoint to "
        "compare against and this file cannot witness the regression"
    )
    return urlparse(endpoint).netloc


@pytest.fixture(autouse=True)
def _public_endpoint(settings):
    """Pin the browser-facing origin the fixed code must use.

    A distinctive host and port, so a URL that came from
    `AWS_S3_ENDPOINT_URL` is distinguishable from one that came from
    `PUBLIC_MEDIA_ENDPOINT_URL` even if both are set in the environment.
    """
    settings.PUBLIC_MEDIA_ENDPOINT_URL = "https://media.echoflow.test:9443"
    yield


@pytest.fixture
def creator(django_user_model):
    return django_user_model.objects.create_user(
        username='coverer', email='cover@example.com', password='pw-cover-1'
    )


def make_clip(creator, **overrides):
    """A ready, approved, servable clip — the state every surface here needs.

    `public_view` filters on `status='ready'`, `moderation_approved=True`,
    `is_noncommercial=False` and `requires_share_alike=False`
    (`views/content.py:580-588`). All four are set so a 404 from the public
    endpoint can only mean the cover-image assertion below failed.
    """
    fields = {
        "creator": creator,
        "title": "A clip with a cover",
        "category": "music",
        "status": "ready",
        "moderation_approved": True,
        "license_type": "CC-BY",
        "duration_ms": 4200,
    }
    fields.update(overrides)
    clip = AudioClip.objects.create(**fields)
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


def attach_cover(clip, name="covers/2026/09/30/artwork.jpg"):
    """Give the clip a real, non-null `cover_image` WITHOUT touching storage.

    Assigning `.name` and saving stores the string in the column; no object is
    ever written, because nothing here reads it back. The serializer signs the
    *key*, so that is all the production code needs — and it means the test
    cannot leave bytes in the real MinIO bucket. This is the same pattern
    `test_erasure.py:158` already uses.

    Returns the clip, so a test can chain it off `make_clip(...)`.
    """
    clip.cover_image.name = name
    clip.save(update_fields=["cover_image"])
    return clip


def assert_cover_fixture(clip, expected_name=None):
    """Prove the fixture is in the state the test is about, from the DATABASE.

    Not `clip.cover_image` (an in-memory attribute that could be truthy while
    the row says otherwise) — a fresh read, and the prefix from
    `upload_to='covers/%Y/%m/%d/'` is checked so a typo'd path cannot make the
    URL assertions pass for the wrong reason.
    """
    stored = AudioClip.objects.get(pk=clip.pk)
    assert stored.cover_image, "fixture has no cover_image; the test is vacuous"
    assert stored.cover_image.name, "cover_image name is empty"
    assert stored.cover_image.name.startswith("covers/"), stored.cover_image.name
    if expected_name is not None:
        assert stored.cover_image.name == expected_name
    return stored.cover_image.name


def assert_not_internal(url, where, settings):
    """The core assertion: the host is the public one, and it is demonstrably
    not the in-network storage endpoint."""
    assert url, f"{where}: expected a URL, got {url!r}"
    parsed = urlparse(url)
    assert parsed.netloc == "media.echoflow.test:9443", (
        f"{where}: host is {parsed.netloc!r}, expected the "
        f"PUBLIC_MEDIA_ENDPOINT_URL host"
    )
    assert parsed.netloc != internal_netloc(settings), where
    # A presigned URL, so assert the signature is present rather than merely
    # that the host looks right — a bare unsigned path would "pass" the host
    # check while being a different (and broken) defect.
    assert "X-Amz-Signature" in parsed.query, f"{where}: {url} is not presigned"
    assert parsed.path.startswith("/"), where
    return url


def assert_no_internal_marker(text, where):
    for marker in INTERNAL_ENDPOINT_MARKERS:
        assert marker not in text, f"{where}: leaks {marker!r}"


def _request():
    """A DRF-ish request object. The fixed code does not read `request` at all
    for the cover URL, so this exists only to prove that."""
    from rest_framework.request import Request

    return Request(RequestFactory().get("/feed/"))


# ---------------------------------------------------------------------------
# 1. FeedClipSerializer
# ---------------------------------------------------------------------------

def test_feed_serializer_cover_url_points_at_the_public_endpoint(creator, settings):
    from backend.app.serializers import FeedClipSerializer

    clip = attach_cover(make_clip(creator))
    key = assert_cover_fixture(clip, "covers/2026/09/30/artwork.jpg")

    url = FeedClipSerializer(clip, context={"request": _request()}).data["cover_image"]

    assert_not_internal(url, "FeedClipSerializer", settings)
    assert key in url, f"the signed URL does not carry the object key: {url}"


def test_feed_serializer_does_not_borrow_the_request_host(creator, settings):  # noqa: E501
    """`build_absolute_uri` used to be the whole mechanism, so the *request's*
    host used to decide the result. Signed URLs must not: the signature is
    computed over a canonical request against the storage endpoint, and
    re-hosting it produces a URL the origin will reject.

    Driven with a request on a deliberately alien host so a regression to
    `build_absolute_uri` is caught rather than accidentally satisfied.
    """
    from backend.app.serializers import FeedClipSerializer
    from rest_framework.request import Request

    alien = RequestFactory().get("/feed/", HTTP_HOST="internal-admin.corp:8000")
    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)

    url = FeedClipSerializer(
        clip, context={"request": Request(alien)}
    ).data["cover_image"]

    assert_not_internal(url, "FeedClipSerializer with an alien request host", settings)


# ---------------------------------------------------------------------------
# 2. PublicClipSerializer — the unauthenticated path
# ---------------------------------------------------------------------------

def test_public_serializer_cover_url_points_at_the_public_endpoint(creator, settings):
    from backend.app.serializers import PublicClipSerializer

    clip = attach_cover(make_clip(creator))
    key = assert_cover_fixture(clip, "covers/2026/09/30/artwork.jpg")

    url = PublicClipSerializer(clip, context={"request": _request()}).data["cover_image"]

    assert_not_internal(url, "PublicClipSerializer", settings)
    assert key in url


def test_the_public_endpoint_serves_no_internal_hostname(creator, settings):
    """The higher-severity one: `GET /clips/{id}/public/` is `AllowAny`, so
    this URL is handed to anonymous callers.

    The full HTTP path is used rather than the serializer alone, because the
    queryset filter in `public_view` is a second thing that has to be right for
    this assertion to mean anything — a 404 would also "not leak" the hostname.
    """
    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)

    response = APIClient().get(
        f"/clips/{clip.id}/public/", HTTP_ACCEPT="application/json"
    )

    assert response.status_code == 200, response.content
    url = response.json()["cover_image"]
    assert url, "the public page served no cover_image at all"
    assert_not_internal(url, "GET /clips/{id}/public/", settings)


# ---------------------------------------------------------------------------
# 3. The share card's og:image
# ---------------------------------------------------------------------------

def test_the_share_card_og_image_hides_the_internal_hostname(creator):
    """`_render_share_card` interpolates `data['cover_image']` into
    `<meta property="og:image">`. The value is HTML-escaped, so this is not an
    injection vector — but escaping an internal URL still hands it to every
    link unfurler, which is where the disclosure actually lands."""
    from backend.app.views.content import _render_share_card

    clip = attach_cover(make_clip(creator))
    key = assert_cover_fixture(clip)

    html = _render_share_card(
        {"title": clip.title, "creator_name": creator.username,
         "category": clip.category, "cover_image": None},
        _request(),
    )
    # Sanity: with no cover there is no tag, so a passing assertion below is
    # about the URL and not about an omitted tag.
    assert 'og:image' not in html

    from backend.app.serializers import PublicClipSerializer

    data = PublicClipSerializer(clip, context={"request": _request()}).data
    html = _render_share_card(data, _request())

    assert 'og:image' in html, "the card rendered no cover tag at all"
    assert key in html
    assert_no_internal_marker(html, "the share card")


def test_the_share_card_og_image_over_http(creator):
    """Rendered over a plaintext request (the local stack, and any deployment
    that has not put TLS in front yet). The fix must not make the scheme depend
    on how the card was reached."""
    from backend.app.serializers import PublicClipSerializer
    from backend.app.views.content import _render_share_card

    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)
    data = PublicClipSerializer(clip, context={"request": _request()}).data

    html = _render_share_card(data, _request())

    assert 'og:image' in html
    assert_no_internal_marker(html, "the share card over http")


# ---------------------------------------------------------------------------
# 4. No cover image
# ---------------------------------------------------------------------------

def test_a_clip_with_no_cover_still_returns_none(creator):
    """The other branch, pinned separately so it cannot stand in for the tests
    above. Also asserts the fixture really is the null case."""
    from backend.app.serializers import FeedClipSerializer, PublicClipSerializer

    clip = make_clip(creator)
    stored = AudioClip.objects.get(pk=clip.pk)
    assert stored.cover_image in (None, ""), (
        "fixture is supposed to have NO cover image"
    )

    context = {"request": _request()}
    assert FeedClipSerializer(clip, context=context).data["cover_image"] is None
    assert PublicClipSerializer(clip, context=context).data["cover_image"] is None


def test_a_clip_with_no_cover_renders_the_card_without_an_image_tag(creator):
    from backend.app.views.content import _render_share_card

    clip = make_clip(creator)
    assert AudioClip.objects.get(pk=clip.pk).cover_image in (None, "")

    response = APIClient().get(
        f"/clips/{clip.id}/public/", HTTP_ACCEPT="text/html"
    )
    assert response.status_code == 200, response.content
    assert 'og:image' not in response.content.decode()


def test_no_request_in_context_does_not_raise(creator, settings):
    """The old code returned `None` when there was no `request` — silently
    dropping a cover image. The fixed code does not read `request` at all, so
    the URL is produced either way. Asserted because a serializer that raises
    here takes down the whole page, not just the field."""
    from backend.app.serializers import FeedClipSerializer, PublicClipSerializer

    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)

    assert_not_internal(
        FeedClipSerializer(clip, context={}).data["cover_image"],
        "FeedClipSerializer with no request", settings,
    )
    assert_not_internal(
        PublicClipSerializer(clip, context={}).data["cover_image"],
        "PublicClipSerializer with no request", settings,
    )


# ---------------------------------------------------------------------------
# The regression itself
# ---------------------------------------------------------------------------

def test_the_unfixed_expression_would_really_have_leaked(creator, settings):
    """Witness test. Runs the OLD expression on the same fixture and asserts
    it produces the leak, so the tests above are not guarding a defect that
    `PUBLIC_MEDIA_ENDPOINT_URL` happened to be equal to the internal endpoint
    in this environment.

    `obj.cover_image.url` is read through `default_storage` exactly as the old
    code did, so this genuinely exercises `S3Storage.url()` with
    `querystring_auth: True` against the configured `AWS_S3_ENDPOINT_URL`.
    """
    from django.core.files.storage import default_storage

    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)

    leaked = default_storage.url(clip.cover_image.name)

    assert "X-Amz-Signature" in urlparse(leaked).query, (
        f"expected a presigned internal URL, got {leaked}"
    )
    assert urlparse(leaked).netloc == internal_netloc(settings), (
        "default_storage.url() did not sign against the internal endpoint, so "
        f"this file is not exercising the defect: {leaked}"
    )
    assert "media.echoflow.test" not in leaked, (
        f"PUBLIC_MEDIA_ENDPOINT_URL happens to equal the internal endpoint in "
        f"this environment, which would hide the defect: {leaked}"
    )
    # And it is a different URL from the one the fixed code produces.
    from backend.app.serializers import FeedClipSerializer

    fixed = FeedClipSerializer(
        clip, context={"request": _request()}
    ).data["cover_image"]
    assert fixed != leaked


def test_the_hls_url_helper_was_never_bypassed(creator):
    """The mirror-image check on the sibling field: `hls_playlist_url` goes
    through `get_hls_playback_url` and is bucket-less/edge-shaped. If the cover
    fix had been done by copying the HLS helper instead of the signed one, the
    bucket would be missing from the path and the origin would 404 — which no
    assertion above would catch, since the host is right either way."""
    from backend.app.serializers import FeedClipSerializer

    clip = attach_cover(make_clip(creator))
    assert_cover_fixture(clip)

    url = FeedClipSerializer(
        clip, context={"request": _request()}
    ).data["cover_image"]

    # A presigned `uploads/`-style object needs the bucket in the path: the
    # edge serves only /hls/*, so `{edge}/{key}` is the WRONG shape here.
    assert "X-Amz-Signature" in url
    assert url.count("/") >= 4, f"looks bucket-less (HLS-shaped): {url}"
