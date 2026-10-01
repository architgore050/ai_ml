"""R5-01 — ``GET /profile/{id}/clips/`` must apply the feed's own gate.

``ProfileViewSet.user_clips`` (``backend/app/views/profile.py:57-78``) was the
only clip-listing endpoint in the codebase that filtered on ``creator`` and
``status='ready'`` alone. It omitted **both** halves of the gate every other
listing path applies:

* ``moderation_approved=True`` — ``feed.py:111``/``:135``, ``feed.py:184``,
  ``social.py:166-172``, ``content.py:394-396``
* ``is_noncommercial=False, requires_share_alike=False`` — ``feed.py:115``/
  ``:137``, ``feed.py:186``

Net effect: any authenticated caller could enumerate another user's
NonCommercial and ShareAlike catalogue, plus clips that were never
approved, through ``FeedClipSerializer`` — which renders
``id, title, creator_name, category, hls_playlist_url, tags, ...`` for each
row. The audio itself is still gated (the HLS edge needs a token and
``resolve_clip_access`` would refuse), so this is a licensing-metadata and
catalogue disclosure, not a playback bypass — but it is exactly the partial
fix that the A4 licence work (``3042f20``, ``74c7ac9``) closed everywhere
else.

Why ``status='ready'`` is not a substitute for ``moderation_approved=True``
--------------------------------------------------------------------------
The two flags are independent. ``process_audio_to_hls`` sets
``status='ready'`` *after* the worker-side moderation check, so a retry of
the task can leave a clip ``ready`` while ``moderation_approved`` reads
``False``. Both must be checked, and these tests pin that they are.

The pre-existing coverage missed this entirely because it inspected source
text rather than the endpoint: ``test_adversarial_pass3.py:454-471`` asserts
``'user_has_liked=Exists' in inspect.getsource(user_clips)`` and
``test_is_following.py:349-357`` only asserts the ``is_following`` key is
present. Every test below drives the real endpoint and asserts on the real
response rows.
"""
from datetime import timedelta

import pytest
from django.utils import timezone


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def creator(django_user_model):
    return django_user_model.objects.create_user(
        username='profileclipcreator', email='pcc@example.com',
        password='test-pass-1234',
    )


@pytest.fixture
def make_clip(creator):
    """Build one AudioClip with fully explicit gate flags.

    ``owner`` defaults to the ``creator`` fixture but is overridable, because
    ``/profile/me/`` is only meaningful for the authenticated user and a test
    that gets that wrong asserts nothing.

    Every gate-relevant field is passed explicitly rather than relying on the
    model default, so a future change to a ``default=`` cannot silently turn
    an NC/SA/unapproved fixture into a clean one and make this file pass
    vacuously. Tests assert on clip *identity* (ids) as well as count, so a
    fixture that stopped being what it claims is caught rather than papered
    over.
    """
    from backend.app.models import AudioClip

    def _make(
        title,
        status='ready',
        moderation_approved=True,
        is_noncommercial=False,
        requires_share_alike=False,
        owner=None,
    ):
        return AudioClip.objects.create(
            title=title,
            category='comedy',
            creator=owner or creator,
            status=status,
            moderation_approved=moderation_approved,
            is_noncommercial=is_noncommercial,
            requires_share_alike=requires_share_alike,
            duration_ms=60_000,
            likes=0, shares=0, skips=0, comment_count=0,
            hls_playlist_url=f'hls/{title}/master.m3u8',
        )

    return _make


@pytest.fixture
def five_clips(make_clip):
    """The five cases from the finding.

    Returned as a dict so each test names the case it is asserting on
    instead of relying on positional index arithmetic over a list.
    """
    return {
        # 1 — the only shape that may be listed.
        'clean': make_clip('clean'),
        # 2 — approved and ready, but NonCommercial.
        'noncommercial': make_clip('nc', is_noncommercial=True),
        # 3 — approved and ready, but ShareAlike.
        'sharealike': make_clip('sa', requires_share_alike=True),
        # 4 — ready, license-clean, but never approved for distribution.
        'unapproved': make_clip('unapproved', moderation_approved=False),
        # 5 — guard: still encoding. Already excluded by status='ready';
        # kept so a future relaxation of the status filter is visible.
        'processing': make_clip(
            'processing', status='processing', moderation_approved=False,
        ),
    }


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------
class TestProfileClipsLicenseAndModerationGate:
    """R5-01. Exactly the clean clip is listed; the other four are not."""

    def _ids(self, response):
        assert response.status_code == 200, response.data
        return [row['id'] for row in response.data['results']]

    def test_only_the_clean_clip_is_returned(
        self, api_client, user, creator, five_clips,
    ):
        api_client.force_authenticate(user=user)
        r = api_client.get(f'/profile/{creator.id}/clips/')
        ids = self._ids(r)
        assert ids == [str(five_clips['clean'].id)], (
            "GET /profile/{id}/clips/ must list only the approved, "
            f"license-clean clip; got {ids}"
        )

    def test_noncommercial_clip_is_withheld(
        self, api_client, user, creator, five_clips,
    ):
        api_client.force_authenticate(user=user)
        ids = self._ids(api_client.get(f'/profile/{creator.id}/clips/'))
        assert str(five_clips['noncommercial'].id) not in ids, (
            "NonCommercial clip leaked through the profile clip listing"
        )

    def test_sharealike_clip_is_withheld(
        self, api_client, user, creator, five_clips,
    ):
        api_client.force_authenticate(user=user)
        ids = self._ids(api_client.get(f'/profile/{creator.id}/clips/'))
        assert str(five_clips['sharealike'].id) not in ids, (
            "ShareAlike clip leaked through the profile clip listing"
        )

    def test_unapproved_clip_is_withheld(
        self, api_client, user, creator, five_clips,
    ):
        api_client.force_authenticate(user=user)
        ids = self._ids(api_client.get(f'/profile/{creator.id}/clips/'))
        assert str(five_clips['unapproved'].id) not in ids, (
            "Clip with moderation_approved=False leaked through the "
            "profile clip listing"
        )

    def test_still_processing_clip_is_withheld(
        self, api_client, user, creator, five_clips,
    ):
        api_client.force_authenticate(user=user)
        ids = self._ids(api_client.get(f'/profile/{creator.id}/clips/'))
        assert str(five_clips['processing'].id) not in ids, (
            "Clip still in 'processing' leaked through the profile clip "
            "listing"
        )

    def test_gate_matches_the_primary_feed(
        self, api_client, user, creator, five_clips,
    ):
        """The whole point: the listing and the feed must agree.

        Asserting against a second endpoint rather than a restated copy of
        the rule is what stops the two "what is servable" filters from
        drifting apart again — which is how this bug existed in the first
        place.
        """
        api_client.force_authenticate(user=user)
        profile_ids = self._ids(api_client.get(f'/profile/{creator.id}/clips/'))
        feed_ids = [
            row['id']
            for row in api_client.get('/suggestions/').data['results']
        ]
        assert profile_ids == feed_ids, (
            "profile listing and the recommendation feed disagree about "
            f"what is servable: profile={profile_ids} feed={feed_ids}"
        )

    def test_no_returned_row_carries_a_license_flag(
        self, api_client, user, creator, five_clips,
    ):
        """Belt and braces, at the response layer.

        ``FeedClipSerializer`` does not currently serialize
        ``is_noncommercial`` / ``requires_share_alike``. This asserts the
        *outcome* — a restricted clip is absent — rather than the absence of
        a field, so if a future serializer change re-adds either flag the
        test still fails on the row being present. The explicit
        "not in fields" assertion is the second half of the same belt.
        """
        api_client.force_authenticate(user=user)
        r = api_client.get(f'/profile/{creator.id}/clips/')
        assert r.status_code == 200, r.data
        for row in r.data['results']:
            assert 'is_noncommercial' not in row, row
            assert 'requires_share_alike' not in row, row
        for restricted in ('noncommercial', 'sharealike'):
            assert str(five_clips[restricted].id) not in [
                x['id'] for x in r.data['results']
            ], f"{restricted} clip leaked to the client"


# ---------------------------------------------------------------------------
# The gate is per-row, not per-creator
# ---------------------------------------------------------------------------
class TestGateIsNotBypassedByACleanSibling:
    """One clean clip on a creator must not launder their restricted ones.

    Guards the "SELECT the clean one, then fall back to a looser query for
    the rest" shape, and the "the creator has *a* public clip so the whole
    page is fine" misreading.
    """

    def test_clean_clip_does_not_unlock_restricted_siblings(
        self, api_client, user, creator, make_clip,
    ):
        clean_a = make_clip('clean-a')
        clean_b = make_clip('clean-b')
        nc = make_clip('nc-sibling', is_noncommercial=True)
        sa = make_clip('sa-sibling', requires_share_alike=True)

        api_client.force_authenticate(user=user)
        r = api_client.get(f'/profile/{creator.id}/clips/')
        assert r.status_code == 200, r.data
        ids = {row['id'] for row in r.data['results']}
        assert str(nc.id) not in ids
        assert str(sa.id) not in ids
        assert ids == {str(clean_a.id), str(clean_b.id)}
        # Sanity: the clips really were persisted with the flags the test
        # believes they carry, so a green result cannot be an artefact of a
        # silently-ignored kwarg or a changed model default.
        nc.refresh_from_db()
        sa.refresh_from_db()
        assert nc.is_noncommercial is True and nc.requires_share_alike is False
        assert sa.is_noncommercial is False and sa.requires_share_alike is True


# ---------------------------------------------------------------------------
# Must-preserve behaviour
# ---------------------------------------------------------------------------
class TestProfileClipsPreservedBehaviour:
    """The gate is additive. None of the following may regress."""

    def test_404_for_unknown_user(self, api_client, user):
        api_client.force_authenticate(user=user)
        r = api_client.get('/profile/999999999/clips/')
        assert r.status_code == 404, r.status_code

    def test_requires_authentication(self, api_client, creator, make_clip):
        make_clip('clean')
        r = api_client.get(f'/profile/{creator.id}/clips/')
        assert r.status_code in (401, 403), r.status_code

    def test_ordering_is_newest_first_and_annotations_survive(
        self, api_client, user, creator, make_clip,
    ):
        """-created_at ordering plus the user_has_liked / is_following
        annotations, which exist to keep a page of clips at two queries
        instead of 2N. If the annotations are dropped, ``get_is_liked`` /
        ``get_is_following`` fall back to a per-row query and this view
        silently regresses to an N+1."""
        from backend.app.models import AudioClip, UserInteraction

        older = make_clip('older')
        newer = make_clip('newer')
        # auto_now_add ignores the value passed to create(), so age the rows
        # with a direct UPDATE.
        base = timezone.now()
        AudioClip.objects.filter(pk=older.pk).update(created_at=base - timedelta(hours=2))
        AudioClip.objects.filter(pk=newer.pk).update(created_at=base - timedelta(minutes=2))
        UserInteraction.objects.create(
            user=user, clip=newer, interaction_type='like', is_active=True,
        )

        api_client.force_authenticate(user=user)
        r = api_client.get(f'/profile/{creator.id}/clips/')
        assert r.status_code == 200, r.data
        rows = r.data['results']
        assert [row['id'] for row in rows] == [str(newer.id), str(older.id)], (
            "profile clips must stay ordered -created_at"
        )
        assert all('is_liked' in row for row in rows)
        assert all('is_following' in row for row in rows)
        assert [row['is_liked'] for row in rows] == [True, False]
        assert all(row['is_following'] is False for row in rows)

    def test_uploads_count_and_liked_clips_are_unchanged(
        self, api_client, auth_client, user, creator, make_clip,
    ):
        """``uploads_count`` is a catalogue total and ``liked_clips`` is the
        viewer's own history — neither is the public clip-listing surface, so
        the gate must not be applied to either.

        Two creators on purpose: ``creator`` owns the restricted clips (so
        the public profile total is a real number, not 0), and ``user`` owns
        clips too (so ``/profile/me/``'s total is not a vacuous 0).
        """
        from backend.app.models import UserInteraction

        make_clip('clean')
        make_clip('nc', is_noncommercial=True)
        liked = make_clip('sa', requires_share_alike=True)
        mine = make_clip('mine-nc', is_noncommercial=True, owner=user)
        UserInteraction.objects.create(
            user=user, clip=liked, interaction_type='like', is_active=True,
        )

        profile = api_client.get(f'/profile/{creator.id}/')
        assert profile.status_code == 200, profile.data
        assert profile.data['uploads_count'] == 3, (
            "uploads_count is a catalogue total, not the servable set"
        )

        me = auth_client.get('/profile/me/')
        assert me.status_code == 200, me.data
        assert me.data['uploads_count'] == 1
        assert [c['id'] for c in me.data['liked_clips']] == [str(liked.id)], (
            "liked_clips is the viewer's own history, not a public listing"
        )
        assert str(mine.id) not in [c['id'] for c in me.data['liked_clips']]
