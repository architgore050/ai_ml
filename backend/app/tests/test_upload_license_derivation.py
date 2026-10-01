"""DEFECT A — an honest NC/SA declaration was discarded, and the clip was served.

`AudioUploadSerializer.Meta.fields` did not include `is_noncommercial` or
`requires_share_alike`, so a client could not set them and they stayed at the
model default `False` for every user upload. `license_type` *was* writable and
validated against `LICENSE_CHOICES`, and its only reader in the whole tree was
a `logger.warning`. So:

    POST /clips/  license_type="CC-BY-NC"
    POST /clips/{id}/approve-moderation/        (owner self-approval is v1)
    -> is_noncommercial is still False
    -> the clip is in GET /feed/, GET /suggestions/,
       POST /media/playback-token/, POST /clips/{id}/share-link/

Two requests, no privileges beyond registering, deterministic. The server was
discarding a declaration it had already validated and then enforcing a gate on
two columns nothing wrote.

`services/entitlements.is_license_restricted` is a two-boolean predicate and is
deliberately NOT changed: the fix is to make the columns carry the truth, so
every feed filter, every credential issuer and the public page start working
with no edit to any of them.

WHY NOT THE GAP DOC'S OPTION
----------------------------
`docs/EXPLAIN/compliance/01-license-type-unknown-gap.md` recommends quarantining
`license_type == "Unknown"`. That leaves `license_type == "CC-BY-NC"` fully
servable, which is the honest-declarer case and the one that carries the real
Copyright Act exposure. Deriving the flags from the licence handles both, and
`Unknown` is addressed explicitly in `TestUnknownLicence` rather than left to
chance.

WHAT IS *NOT* FIXED HERE
------------------------
A uploader who declares `Owned` for audio that is actually NC is not caught by
this and cannot be: the server has no audio classifier on the upload path. That
residual is stated in the code comment on `LICENSE_RESTRICTION_FEATURES` too, so
it is visible at the point someone is tempted to call this "mitigated".
"""
import io
from unittest.mock import MagicMock, patch

import pytest
from rest_framework.test import APIClient

from backend.app.models import AudioClip

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _in_memory_storage(settings):
    """No test in this file may touch MinIO/S3.

    Overriding `STORAGES` (rather than patching a `default_storage` name) is
    what makes this hold for code paths that resolve storage lazily: Django's
    `storages_changed` receiver clears `default_storage._wrapped`, so the
    serializer's `super().create()` save lands here.
    """
    settings.STORAGES = {
        **settings.STORAGES,
        "default": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
    }
    yield


@pytest.fixture(autouse=True)
def _throttle_budget(settings):
    """These tests spend `upload`, `playback_token` and `user` budget.

    Copy of the fixture in `test_serializer_input_gates.py`, for the same
    reason: `clear_throttle_cache` wipes the shared Redis, which other agents'
    concurrent runs are using. A 429 read here as a policy failure.
    """
    rates = dict(settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES'])
    for scope in ('upload', 'playback_token', 'anon', 'user', 'clip_approve',
                  'share_link', 'clip_public', 'clip_play', 'clip_read'):
        rates[scope] = '10000/hour'
    settings.REST_FRAMEWORK = {
        **settings.REST_FRAMEWORK,
        'DEFAULT_THROTTLE_RATES': rates,
    }


@pytest.fixture
def wav_factory():
    """A genuinely decodable 1-second WAV, built by pydub.

    A hand-rolled RIFF header would make `validate_original_file`'s duration
    probe behave for a reason unrelated to the licence under test.
    """
    from django.core.files.uploadedfile import SimpleUploadedFile
    from pydub import AudioSegment

    buf = io.BytesIO()
    AudioSegment.silent(duration=1000, frame_rate=44100).export(buf, format='wav')
    payload = buf.getvalue()

    def _make(name='tone.wav'):
        return SimpleUploadedFile(name, payload, content_type='audio/wav')

    return _make


@pytest.fixture
def uploader(django_user_model):
    return django_user_model.objects.create_user(
        username='uploader', email='up@example.com', password='pw-derivation-1'
    )


@pytest.fixture
def uploader_client(uploader):
    return _authed(uploader), uploader


@pytest.fixture
def peer(django_user_model):
    """A second user. `resolve_clip_access` exempts the CREATOR from the
    licence gate (`entitlements.py:105-106`, `ACCESS_OWNER`), so an NC-clip
    playback-token assertion made as the uploader would 200 for the wrong
    reason. The gate only has teeth against somebody else."""
    return django_user_model.objects.create_user(
        username='peer', email='peer@example.com', password='pw-derivation-2'
    )


@pytest.fixture
def peer_client(peer):
    return _authed(peer), peer


def _authed(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def upload(client, wav_factory, **overrides):
    """POST /clips/ with a complete, otherwise-valid payload."""
    payload = {
        'title': 'Licence derivation clip',
        'category': 'music',
        'original_file': wav_factory(),
        'copyright_acknowledgement': 'true',
    }
    payload.update(overrides)
    return client.post('/clips/', payload, format='multipart')


def approve(client, clip, monkeypatch, on_commit):
    """Self-approve through the real endpoint, with Celery stubbed.

    `approve_moderation` -> `uploads_svc.trigger_hls_processing` ->
    `transaction.on_commit(lambda: publish(...))`. `publish` is a
    module-level name in `services/uploads.py` that that lambda closes over,
    so `monkeypatch.setattr(uploads, 'publish', ...)` is the seam the code
    actually reads.

    `on_commit` must be pytest-django's `django_capture_on_commit_callbacks`
    in `execute=True` mode. `pytest.mark.django_db` wraps each test in an
    atomic block, so deferred `on_commit` callbacks are DISCARDED at teardown
    and `publish` would never be reached at all — the same trap
    `test_group_c.py::test_approval_actually_enqueues_hls_processing`
    documents. Without it this test would silently stop exercising approval.

    Returns the list of published tasks, asserted non-empty, so the caller
    knows the enqueue path really ran.
    """
    import backend.app.services.uploads as uploads

    published = []
    monkeypatch.setattr(
        uploads, 'publish', lambda task, *a, **k: published.append(task)
    )
    with on_commit(execute=True):
        response = client.post(
            f"/clips/{clip.id}/approve-moderation/", {}, format='json'
        )
    assert response.status_code == 200, response.data
    assert published, (
        "the publish stub was never reached; approval did not enqueue HLS and "
        "this test's setup is wrong"
    )
    return response


def make_ready(clip):
    """Flip a freshly uploaded clip to the state HLS processing would leave.

    A direct `.update()`: the upload path writes `status='processing'`, and
    both the feed fallback and `/suggestions/` filter on `status='ready'`.
    Without this, every "absent from the feed" assertion below would pass for
    the wrong reason. Asserted, not assumed.
    """
    AudioClip.objects.filter(pk=clip.pk).update(
        status='ready',
        hls_playlist_url=f"hls/{clip.pk}/master.m3u8",
    )
    clip.refresh_from_db()
    assert clip.status == 'ready'
    assert clip.hls_playlist_url
    return clip


def feed_fallback(client, feed_view):
    """GET /feed/ driven down the trending-fallback branch.

    `FastFeedViewSet.list` reads the module-level `cache` (feed.py:74) to get
    its lpop client. Patching the NAME rather than the shared cache object is
    deliberate: touching the object also breaks DRF's throttle cache, which
    reads it in `initial()` — before the `try` that produces the fallback — so
    the error escapes as a 500. The fallback is the queryset that carries the
    same NC/SA filter, and the `called` assertion below is what proves the
    patch was load-bearing rather than a silent no-op.
    """
    fake_cache = MagicMock()
    fake_cache.client.get_client.side_effect = RuntimeError('forced fallback')
    with patch.object(feed_view, 'cache', fake_cache):
        response = client.get('/feed/')
    assert fake_cache.client.get_client.called, (
        "the fallback was never reached, so this is not measuring the "
        "fallback's NC/SA filter"
    )
    assert response.status_code == 200, response.data
    return {r['id'] for r in response.data['results']}


def suggestions(client, feed_view):
    """GET /suggestions/ with the vector ranking stubbed to cold start.

    `get_user_vectors` is a module-level name in `feed.py` read inside
    `SuggestionViewSet.get_queryset`, so this is the seam. `called` proves the
    stub was reached.
    """
    stub = MagicMock(return_value=(None, None))
    with patch.object(feed_view, 'get_user_vectors', stub):
        response = client.get('/suggestions/?category=music')
    assert stub.called, "the vector branch was not stubbed; assertions below " \
                        "would be measuring vector ranking, not the NC filter"
    assert response.status_code == 200, response.data
    return {r['id'] for r in response.data['results']}


# ---------------------------------------------------------------------------
# 1. The mapping itself
# ---------------------------------------------------------------------------

#: The expected `(is_noncommercial, requires_share_alike)` for every entry in
#: `AudioUploadSerializer.LICENSE_CHOICES`.
#:
#: This is a golden policy table rather than a dependency on an ingestion
#: subsystem; the upload serializer is now the sole active writer.
EXPECTED_FEATURES = {
    "Owned": (False, False),
    "CC0": (False, False),
    "CC-BY": (False, False),
    "CC-BY-SA": (False, True),
    "CC-BY-NC": (True, False),
    "Public_Domain": (False, False),
    "Unknown": (False, False),
}


def test_the_table_covers_every_license_choice_exactly_once():
    from backend.app.serializers import AudioUploadSerializer

    declared = {value for value, _ in AudioUploadSerializer.LICENSE_CHOICES}
    assert declared == set(EXPECTED_FEATURES), (
        "a LICENSE_CHOICES value has no expected derivation, and an unmapped "
        "choice silently means (False, False) — which is the whole defect in "
        f"miniature. declared={sorted(declared)} "
        f"expected={sorted(EXPECTED_FEATURES)}"
    )


@pytest.mark.parametrize("license_type", sorted(EXPECTED_FEATURES))
def test_upload_derives_the_restriction_flags(uploader_client, wav_factory,
                                              license_type):
    """The core of DEFECT A, one licence at a time.

    Asserts on the persisted row, not on a return value, because the row is
    what every consumer reads: `views/feed.py:115`,
    `services/entitlements.is_license_restricted`, `views/content.py`'s public
    page, and `share_link`.
    """
    client, _user = uploader_client
    before = AudioClip.objects.count()

    response = upload(client, wav_factory, license_type=license_type)

    assert response.status_code == 202, response.data
    clip = AudioClip.objects.get(pk=response.data['clip_id'])
    assert (clip.is_noncommercial, clip.requires_share_alike) == \
        EXPECTED_FEATURES[license_type], (
            f"license_type={license_type!r} derived "
            f"{(clip.is_noncommercial, clip.requires_share_alike)}, expected "
            f"{EXPECTED_FEATURES[license_type]}"
        )
    assert clip.license_type == license_type
    assert AudioClip.objects.count() == before + 1


def test_the_client_cannot_override_the_derivation(uploader_client, wav_factory):
    """Derivation is not a default the client can beat.

    `is_noncommercial` / `requires_share_alike` are absent from
    `AudioUploadSerializer.Meta.fields`, so DRF drops them before `create()`
    ever sees them. Sending them must change nothing in EITHER direction — a
    permissive value must not clear a real restriction.
    """
    client, _user = uploader_client

    response = upload(
        client, wav_factory,
        license_type='CC-BY-NC',
        is_noncommercial='false',
        requires_share_alike='false',
    )

    assert response.status_code == 202, response.data
    clip = AudioClip.objects.get(pk=response.data['clip_id'])
    assert clip.is_noncommercial is True
    assert clip.requires_share_alike is False


def test_an_upload_is_never_moderated_at_upload_time(uploader_client, wav_factory):
    """`moderation_approved` is forced False on create, so a newly uploaded
    clip is invisible to every surface even before the flags matter. Pinned
    because the derivation is computed in the same `create()` and would not
    notice if someone removed the `setdefault`."""
    client, _user = uploader_client

    response = upload(client, wav_factory, license_type='CC-BY-NC')

    clip = AudioClip.objects.get(pk=response.data['clip_id'])
    assert clip.moderation_approved is False


# ---------------------------------------------------------------------------
# 2. The gate, end to end
# ---------------------------------------------------------------------------

def test_a_self_declared_nc_clip_is_invisible_everywhere(uploader_client,
                                                         peer_client,
                                                         wav_factory,
                                                         monkeypatch,
                                                         django_capture_on_commit_callbacks):
    """The whole chain, with a servable control clip as the non-vacuity proof.

    The control matters. "The NC clip is absent from the feed" is also what a
    feed that returned nothing at all would produce. `control` is the same
    category, the same state, the same code path, declared `CC-BY`, and it MUST
    appear. If it does not, this test proves nothing and the exclusion
    assertions are failing for an unrelated reason.
    """
    from backend.app.views import feed as feed_view

    up_client, up_user = uploader_client
    other_client, _peer = peer_client

    # --- the NC clip, uploaded and self-approved through the real endpoints --
    nc_response = upload(up_client, wav_factory, license_type='CC-BY-NC')
    assert nc_response.status_code == 202, nc_response.data
    nc_clip = make_ready(AudioClip.objects.get(pk=nc_response.data['clip_id']))

    approve(up_client, nc_clip, monkeypatch, django_capture_on_commit_callbacks)
    nc_clip.refresh_from_db()
    assert nc_clip.moderation_approved is True
    assert nc_clip.is_noncommercial is True, (
        "the derivation did not run, so the rest of this test would be "
        "asserting that an UNRESTRICTED clip is unservable"
    )

    # --- the control: same everything, CC-BY instead -------------------------
    control = AudioClip.objects.create(
        creator=up_user, title='Control CC-BY', category='music',
        status='ready', moderation_approved=True, license_type='CC-BY',
        duration_ms=4200,
    )
    control.hls_playlist_url = f"hls/{control.id}/master.m3u8"
    control.save(update_fields=['hls_playlist_url'])
    assert control.is_noncommercial is False
    assert control.requires_share_alike is False

    # --- GET /feed/ ---------------------------------------------------------
    feed_ids = feed_fallback(other_client, feed_view)
    assert str(control.id) in feed_ids, (
        "the control clip is missing from the feed too, so 'NC absent' proves "
        "nothing about the NC filter"
    )
    assert str(nc_clip.id) not in feed_ids

    # --- GET /suggestions/ --------------------------------------------------
    sugg_ids = suggestions(other_client, feed_view)
    assert str(control.id) in sugg_ids, (
        "the control clip is missing from /suggestions/ too, so the exclusion "
        "assertion below is vacuous"
    )
    assert str(nc_clip.id) not in sugg_ids

    # --- POST /media/playback-token/ ---------------------------------------
    # Asked as `peer`, not the creator: `resolve_clip_access` grants the owner
    # `ACCESS_OWNER` before it ever reaches the licence gate.
    token_response = other_client.post(f"/media/playback-token/{nc_clip.id}/")
    assert token_response.status_code == 403, token_response.data

    # --- POST /clips/{id}/share-link/ --------------------------------------
    # `share_link` is creator-scoped and applies the licence check itself, so
    # the creator is the right (and only) caller for this one.
    share_response = up_client.post(
        f"/clips/{nc_clip.id}/share-link/", {}, format='json'
    )
    assert share_response.status_code == 403, share_response.data

    # --- POST /clips/{id}/play/ (the anonymous share-token exchange) --------
    # The licence check sits AFTER the media-key check, which is why
    # `make_ready()` sets `hls_playlist_url`; without it this would 409 for
    # the wrong reason and the 403 would never be reached.
    play_response = APIClient().post(
        f"/clips/{nc_clip.id}/play/", {'s': 'irrelevant'}, format='json'
    )
    assert play_response.status_code == 403, play_response.data


def test_a_share_alike_clip_is_also_unservable(
    uploader_client, peer_client, wav_factory, monkeypatch,
    django_capture_on_commit_callbacks,
):
    """SA is a redistribution *condition* rather than a commercial-use bar, but
    `is_license_restricted` treats it as a gate and so must the derivation:
    the feed filter is `.filter(is_noncommercial=False, requires_share_alike=False)`
    and nothing distinguishes which of the two booleans triggered it."""
    from backend.app.views import feed as feed_view

    up_client, _up_user = uploader_client
    other_client, _peer = peer_client

    response = upload(up_client, wav_factory, license_type='CC-BY-SA')
    assert response.status_code == 202, response.data
    sa_clip = make_ready(AudioClip.objects.get(pk=response.data['clip_id']))

    approve(up_client, sa_clip, monkeypatch, django_capture_on_commit_callbacks)
    sa_clip.refresh_from_db()
    assert sa_clip.requires_share_alike is True
    assert sa_clip.is_noncommercial is False

    assert str(sa_clip.id) not in feed_fallback(other_client, feed_view)
    assert other_client.post(
        f"/media/playback-token/{sa_clip.id}/"
    ).status_code == 403
    assert up_client.post(
        f"/clips/{sa_clip.id}/share-link/", {}, format='json'
    ).status_code == 403


# ---------------------------------------------------------------------------
# 3. + 4. license_type immutability
# ---------------------------------------------------------------------------

def test_patch_cannot_relabel_a_restricted_clip_as_owned(uploader_client,
                                                          wav_factory):
    """(A1) Pinned as a 409, not a silent ignore.

    Chosen: reject loudly. A silent strip (the N8 `original_file` pattern)
    returns 200 with the field quietly unchanged, so a client rendering a
    licence dropdown would display the value it just sent and have no way to
    know the server discarded it. The remedy is in the response body — delete
    and re-upload — which is the same remedy `original_file` already has.

    The bypass this closes is NOT closed by derivation alone. Upload as
    CC-BY-NC -> flags (True, False) -> PATCH the licence to Owned -> approve.
    If the flags were re-derived on update they would become (False, False) and
    the clip would be served commercially again. So the licence and the flags
    are both frozen at create, which is why there is deliberately NO
    re-derivation in `AudioUploadSerializer.update()`.
    """
    up_client, _up_user = uploader_client
    response = upload(up_client, wav_factory, license_type='CC-BY-NC')
    assert response.status_code == 202, response.data
    clip = AudioClip.objects.get(pk=response.data['clip_id'])

    patch = up_client.patch(
        f"/clips/{clip.id}/",
        {'license_type': 'Owned', 'copyright_acknowledgement': True},
        format='json',
    )

    assert patch.status_code == 409, patch.data
    assert 'license_type' in patch.data.get('immutable_fields', []), patch.data
    clip.refresh_from_db()
    assert clip.license_type == 'CC-BY-NC'
    assert clip.is_noncommercial is True, (
        "the clip is still restricted even though its declared licence was "
        "rewritten — a divergence between the declared and the enforced rights "
        "record, which is its own audit-integrity defect"
    )


def test_patch_licence_refusal_is_atomic_with_a_co_sent_title(uploader_client,
                                                              wav_factory):
    """A partial apply would leave the client unable to tell which half
    landed, and the half that landed is the dangerous one. Same rule
    `_refuse_post_approval_rights_change` already applies."""
    up_client, _up_user = uploader_client
    response = upload(up_client, wav_factory, license_type='CC-BY-SA',
                      title='Original')
    clip = AudioClip.objects.get(pk=response.data['clip_id'])

    patch = up_client.patch(
        f"/clips/{clip.id}/",
        {'title': 'Renamed', 'license_type': 'CC0',
         'copyright_acknowledgement': True},
        format='json',
    )

    assert patch.status_code == 409, patch.data
    clip.refresh_from_db()
    assert clip.title == 'Original'
    assert clip.license_type == 'CC-BY-SA'
    assert clip.requires_share_alike is True


def test_patch_echoing_the_same_licence_is_allowed(uploader_client, wav_factory):
    """The clip-edit form submits the whole object, so `license_type` comes
    back on every save. The guard compares VALUES, not key presence — the same
    reasoning as `_refuse_post_approval_rights_change`, and without it the
    shipped edit form breaks on every save."""
    up_client, _up_user = uploader_client
    response = upload(up_client, wav_factory, license_type='CC-BY',
                      title='A typo in the tittle')
    clip = AudioClip.objects.get(pk=response.data['clip_id'])

    patch = up_client.patch(
        f"/clips/{clip.id}/",
        {'title': 'A typo in the title', 'license_type': 'CC-BY',
         'copyright_acknowledgement': True},
        format='json',
    )

    assert patch.status_code == 200, patch.data
    clip.refresh_from_db()
    assert clip.title == 'A typo in the title'
    assert clip.license_type == 'CC-BY'


def test_patch_of_only_the_title_still_succeeds(uploader_client, wav_factory):
    """REGRESSION GUARD for the bug `a71a8c8` fixed: `validate()` used to
    demand `copyright_acknowledgement` on every update, so every
    `PATCH /clips/{id}/` was a 400 and clip editing could never have worked.
    The licence freeze composes with that `validate()` and must not re-break it.

    Two shapes, because clients send both: a bare title edit, and a title edit
    from a form that echoes the whole object (the one that carries
    `license_type` back)."""
    up_client, _up_user = uploader_client
    response = upload(up_client, wav_factory, license_type='Owned',
                      title='Before')
    clip = AudioClip.objects.get(pk=response.data['clip_id'])

    bare = up_client.patch(f"/clips/{clip.id}/", {'title': 'After bare'},
                           format='json')
    assert bare.status_code == 200, bare.data

    echoed = up_client.patch(
        f"/clips/{clip.id}/",
        {'title': 'After echoed', 'license_type': 'Owned',
         'copyright_owner_name': 'Someone', 'copyright_acknowledgement': True},
        format='json',
    )
    assert echoed.status_code == 200, echoed.data
    clip.refresh_from_db()
    assert clip.title == 'After echoed'


def test_a_stranger_cannot_relabel_someone_elses_clip(uploader_client,
                                                       peer_client,
                                                       wav_factory):
    """The freeze must not be reachable at all for a clip you do not own.
    `get_queryset()` is creator-scoped, so this is a 404, never a 409 — a 409
    would confirm the clip exists to somebody with no entitlement to ask."""
    up_client, _up_user = uploader_client
    other_client, _peer = peer_client
    response = upload(up_client, wav_factory, license_type='CC-BY-NC')
    clip = AudioClip.objects.get(pk=response.data['clip_id'])

    patch = other_client.patch(
        f"/clips/{clip.id}/", {'license_type': 'Owned'}, format='json'
    )

    assert patch.status_code == 404, patch.data
    clip.refresh_from_db()
    assert clip.license_type == 'CC-BY-NC'
    assert clip.is_noncommercial is True


# ---------------------------------------------------------------------------
# 5. Persisted rights flags remain authoritative
# ---------------------------------------------------------------------------

def test_a_row_with_restricted_rights_keeps_the_classifier_flags(
    uploader_client, peer_client
):
    """Persisted rights flags are never cleared by ordinary metadata edits.

    This covers legacy/imported rows without depending on the removed scraper.
    """
    from backend.app.serializers import license_restriction_features

    up_client, up_user = uploader_client
    other_client, _peer = peer_client

    nc, sa = license_restriction_features('CC-BY-NC')
    assert (nc, sa) == (True, False), (
        "the rights policy changed under this test — update the golden "
        "policy expectations before trusting the assertions below"
    )

    clip = AudioClip.objects.create(
        creator=up_user, title='Imported NC', category='music',
        status='ready', moderation_approved=True,
        license_type='CC-BY-NC', license_family='CC-BY-NC',
        is_noncommercial=nc, requires_share_alike=sa,
        imported_via_scraper=True,
    )

    # A metadata edit — the one thing a clip-edit form legitimately does.
    patch = up_client.patch(
        f"/clips/{clip.id}/",
        {'title': 'Imported NC, retitled', 'copyright_acknowledgement': True},
        format='json',
    )
    assert patch.status_code == 200, patch.data

    clip.refresh_from_db()
    assert clip.title == 'Imported NC, retitled'
    assert clip.is_noncommercial is True, "an API edit cleared a scraper flag"
    assert clip.requires_share_alike is False
    assert other_client.post(
        f"/media/playback-token/{clip.id}/"
    ).status_code == 403


def test_the_classifier_flags_are_still_not_writable_through_the_api(
    uploader_client, uploader
):
    """Must-preserve. The flags are derived, not client-supplied, so a PATCH
    naming them is ignored rather than applied. A future 'helpful' addition of
    these two to `Meta.fields` — much more tempting now that the serializer
    touches them — would be the actual vulnerability."""
    up_client, _up_user = uploader_client
    clip = AudioClip.objects.create(
        creator=uploader, title='Clean', category='music',
        status='ready', moderation_approved=True, license_type='CC-BY',
    )

    patch = up_client.patch(
        f"/clips/{clip.id}/",
        {'is_noncommercial': True, 'requires_share_alike': True,
         'copyright_acknowledgement': True},
        format='json',
    )
    assert patch.status_code == 200, patch.data
    clip.refresh_from_db()
    assert clip.is_noncommercial is False
    assert clip.requires_share_alike is False


# ---------------------------------------------------------------------------
# 6. The `Unknown` decision (A2)
# ---------------------------------------------------------------------------

def test_unknown_licence_derives_unrestricted_but_starts_unmoderated(
    uploader_client, wav_factory
):
    """(A2) THE DECISION, pinned: `Unknown` derives to (False, False) — the
    same answer `license_features('UNKNOWN')` gives the scraper — and the clip
    is NOT servable, because `moderation_approved` is forced False on create.

    Reasoning, briefly. A licence we do not know carries no obligation we can
    enforce, so refusing it would mean hiding every upload whose author left
    the dropdown alone. That is a product decision, not a technical one, and
    the gap doc parks it as "Option 2". What keeps it safe here is that
    `Unknown` is not self-evidently servable: it needs an approval it does not
    get for free. Concretely, nothing in `mobile/` or `frontend/` sends
    `license_type` at all, so quarantining `Unknown` would quarantine 100% of
    uploads and brick the upload flow. That trade is the owner's to make, and
    it is recorded here rather than taken silently.

    RESIDUAL, STATED PLAINLY: owner self-approval is permitted, so an
    `Unknown` upload becomes servable after one further request. Making that a
    real gate needs a review queue or a classifier (ISSUE-04); neither exists.
    """
    up_client, _up_user = uploader_client

    response = upload(up_client, wav_factory)  # no license_type at all

    assert response.status_code == 202, response.data
    clip = AudioClip.objects.get(pk=response.data['clip_id'])
    assert clip.license_type == 'Unknown', (
        "the field default is load-bearing for this test: an omitted "
        "license_type must land on Unknown, not on None"
    )
    assert (clip.is_noncommercial, clip.requires_share_alike) == (False, False)
    assert clip.moderation_approved is False, (
        "an Unknown clip must not be servable without an approval step"
    )


def test_an_explicit_unknown_is_treated_identically(uploader_client, wav_factory):
    """Spelled out is the same as omitted — otherwise a client could pick
    which of the two code paths its clip takes."""
    up_client, _up_user = uploader_client

    response = upload(up_client, wav_factory, license_type='Unknown')

    clip = AudioClip.objects.get(pk=response.data['clip_id'])
    assert clip.license_type == 'Unknown'
    assert (clip.is_noncommercial, clip.requires_share_alike) == (False, False)
    assert clip.moderation_approved is False


def test_unknown_is_logged_against_the_specific_clip(uploader_client,
                                                     wav_factory, caplog):
    """`validate()` already warned for `Unknown`, but it runs before the row
    exists, so its warning cannot name a clip. The derivation in `create()`
    is where the id is known, so the audit-grade warning is emitted there.
    Asserted via `caplog` rather than trusted."""
    up_client, _up_user = uploader_client

    with caplog.at_level('WARNING', logger='backend.app.serializers'):
        response = upload(up_client, wav_factory, license_type='Unknown')

    clip_id = response.data['clip_id']
    messages = [r.getMessage() for r in caplog.records]
    assert any('Unknown' in m and str(clip_id) in m for m in messages), (
        f"no audit-grade warning naming clip {clip_id}: {messages}"
    )


# ---------------------------------------------------------------------------
# 7. Golden rights-policy table
# ---------------------------------------------------------------------------

def test_rights_policy_table_is_explicit_and_complete():
    """The upload rights policy remains tested after scraper removal."""
    from backend.app.serializers import LICENSE_RESTRICTION_FEATURES

    for license_type, expected in sorted(EXPECTED_FEATURES.items()):
        assert LICENSE_RESTRICTION_FEATURES[license_type] == expected, license_type
    assert set(LICENSE_RESTRICTION_FEATURES) == set(EXPECTED_FEATURES)
