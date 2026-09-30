"""Three gates the feed and the comment sheet did not apply.

Defect 1 — ``is_liked`` is wrong on the primary screen
------------------------------------------------------
``FastFeedViewSet.list`` annotated ``user_has_liked`` with::

    UserInteraction.objects.filter(clip=OuterRef('pk'), user=request.user,
                                   interaction_type='like')

with **no** ``is_active=True``. ``record_like_toggle``
(``services/interactions.py:144-149``) does not delete the row on un-like —
it flips ``is_active=False`` in place, so the row the subquery finds is the
row that records the un-like. The result is that ``/feed/`` — the screen the
user spends their time on — renders a filled heart for every clip they
explicitly un-liked. ``FeedClipSerializer.get_is_liked`` takes the
``hasattr(obj, 'user_has_liked')`` fast branch, so the serializer's own
correct fallback query is never reached.

``views/profile.py:64`` *does* filter on ``is_active=True``, which is why the
same user sees contradictory answers for the same clip on two screens. The
tests here assert the two endpoints **agree**, rather than restating the
rule: a restated copy of a predicate cannot detect the two copies drifting,
which is how this bug existed in the first place.

Defect 2 — the primary feed path omits ``status='ready'``
---------------------------------------------------------
Every other clip-listing path filters ``status='ready'``; the primary feed
path did not, so a clip id in the Redis queue was returned while still
encoding. Honesty about reachability: no production path moves a clip off
``'ready'`` once it is ready (``cleanup_stuck_processing`` only goes
``processing`` -> ``failed``), and moderation revocation is filtered
separately. So this is defence in depth, not a live exploit — but a clip
with ``status='ready'`` and an empty ``hls_playlist_url`` *is* constructible
(see ``test_content_moderation.py:204``).

The test sets ``moderation_approved=True`` on the processing clip
*deliberately*. ``test_profile_clip_gate.py``'s processing case sets it
``False``, so that assertion is already satisfied by the moderation filter
and would keep passing if the status filter were deleted. Isolating one gate
per test is the only way a missing gate shows up as a red test.

Defect 3 — the comment read path is completely ungated
------------------------------------------------------
``CommentViewSet.get_queryset`` was ``Comment.objects.select_related('author')
.all()`` with no clip-state filter anywhere, and ``views/comments.py`` did not
even import ``AudioClip``. That is two distinct problems and they are fixed
two different ways; see ``TestCommentsReadGate`` for the decision and
``views/comments.py`` for the reasoning.
"""
import uuid
from unittest.mock import MagicMock

import pytest
from rest_framework import status


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def owner(django_user_model):
    """The clip's creator. Distinct from the viewer on purpose: the owner
    exemption is one of the things under test, and a viewer who is also the
    creator cannot tell it apart from the general gate."""
    return django_user_model.objects.create_user(
        username='gateowner', email='gateowner@example.com',
        password='test-pass-1234',
    )


@pytest.fixture
def viewer(django_user_model):
    return django_user_model.objects.create_user(
        username='gateviewer', email='gateviewer@example.com',
        password='test-pass-1234',
    )


@pytest.fixture
def make_clip(owner):
    """Build one AudioClip with every gate-relevant field explicit.

    Nothing here relies on a model ``default=``. ``moderation_approved``
    defaults to ``False`` (models.py:153), so a fixture that relied on it
    would silently change meaning if that default ever flipped — and the
    "is this clip servable" tests would keep passing for the wrong reason.
    """
    from backend.app.models import AudioClip

    def _make(
        title,
        status='ready',
        moderation_approved=True,
        is_noncommercial=False,
        requires_share_alike=False,
        creator=None,
        with_vectors=True,
        hls_playlist_url=None,
    ):
        kwargs = {}
        if with_vectors:
            kwargs = {
                'semantic_vector': [0.1] * 384,
                'acoustic_vector': [0.1] * 128,
            }
        return AudioClip.objects.create(
            title=title,
            category='comedy',
            creator=creator or owner,
            status=status,
            moderation_approved=moderation_approved,
            is_noncommercial=is_noncommercial,
            requires_share_alike=requires_share_alike,
            duration_ms=60_000,
            likes=0, shares=0, skips=0, comment_count=0,
            hls_playlist_url=(
                f'hls/{title}/master.m3u8' if hls_playlist_url is None
                else hls_playlist_url
            ),
            **kwargs,
        )

    return _make


@pytest.fixture
def feed_queue(viewer):
    """Seed / clear the viewer's Redis feed queue and yield a helper object.

    ``GET /feed/`` is a destructive ``lpop`` (feed.py:75), so every feed
    assertion in this file re-seeds rather than re-reading — re-requesting a
    page you already drained returns the *next* ten, which would make these
    tests pass or fail for the wrong reason.

    The queue is cleared on teardown because this Redis is shared with
    whatever else is running against the stack.

    ``push`` + ``assert_queued`` exist so that an empty ``results`` is
    attributable. An empty page has two very different causes: the view
    dropped a clip it should have served (a real regression), or the queue
    was empty by the time the request ran (infrastructure — this Redis is
    shared with other agents' runs, and a transient django-redis error or a
    stray consumer shows up as a bare 202 "Preparing your feed..."). Asserting
    the queue contents *before* the request separates the two, so a
    recurrence is diagnosable instead of merely intermittent.
    """
    from django.core.cache import cache

    client = cache.client.get_client()
    # Distinct local name: inside a class body, `key = key` would read the
    # name being assigned rather than the enclosing function's.
    queue_key = f'user_feed:{viewer.id}'

    class _Queue:
        key = queue_key

        def push(self, *clips):
            client.delete(queue_key)
            for clip in clips:
                client.rpush(queue_key, str(clip.id))
            return queue_key

        def assert_queued(self, *clips):
            """Non-destructive (lrange), so it cannot itself drain anything."""
            live = [v.decode() if isinstance(v, bytes) else v
                    for v in client.lrange(queue_key, 0, -1)]
            assert live == [str(c.id) for c in clips], (
                f"Redis key {queue_key!r} held {live!r}, expected "
                f"{[str(c.id) for c in clips]!r} immediately before GET /feed/. "
                "The view never saw the queue this test seeded, so an empty "
                "`results` here is the shared-Redis/stack being contended, "
                "not the status or licence gate regressing."
            )

    queue = _Queue()
    queue.push()
    yield queue
    client.delete(queue_key)


def _is_liked_by_clip(response):
    """Map {clip id: is_liked} out of a paginated clip-listing response."""
    assert response.status_code == 200, response.data
    return {row['id']: row['is_liked'] for row in response.data['results']}


def _feed_rows(client, queue, *clips, attempts=4):
    """Seed the feed queue, call ``GET /feed/``, and return the response.

    The 202 retry is a harness workaround, not a weakening of the assertion.
    Every 5-agent run of this repo shares ONE ``redis_cache_local`` while
    each agent gets its OWN ``echoflow_test_cN`` database — and
    ``app_user_id_seq`` restarts per database, so ``user_feed:{id}`` keys
    from two concurrent pytest processes collide on the same small integer.
    ``test_adversarial_pass3.py::TestLoadConcurrentFeedAccess`` deletes those
    keys (``redis.delete(f'user_feed:{u.id}')``), so a foreign process can
    drain this test's queue between seeding and the request. The signature is
    unambiguous — 202 + ``degraded`` + ``"Preparing your feed..."`` — and it is
    the ONLY outcome retried.

    This cannot happen in production: one database means user pks are globally
    unique, so no two owners can share a ``user_feed:{id}`` key.

    What is deliberately NOT retried is a ``200`` with the wrong rows. If the
    view genuinely drops or mislabels a clip, every attempt returns 200 and
    the caller's own assertion fails.
    """
    last = None
    for attempt in range(attempts):
        queue.push(*clips)
        queue.assert_queued(*clips)
        response = client.get('/feed/')
        if response.status_code == status.HTTP_202_ACCEPTED:
            last = response
            continue
        return response
    raise AssertionError(
        f"GET /feed/ answered 202 {last.data!r} on all {attempts} attempts "
        "even though this test seeded the queue (assert_queued passed each "
        "time). Something is deleting user_feed:{id} out from under it. In a "
        "shared-redis multi-agent run that is another process's "
        "TestLoadConcurrentFeedAccess colliding on a per-database user id; "
        "if it reproduces with a single agent running, that is a real defect."
    )


# ---------------------------------------------------------------------------
# Defect 1 — is_liked ignores is_active
# ---------------------------------------------------------------------------
def _like_then_unlike(client, clip, user):
    """Drive the real toggle endpoint twice.

    Deliberately the HTTP endpoint rather than
    ``UserInteraction.objects.create(...)``: the defect is that the *row*
    survives the un-like, and a hand-built row would not prove that the
    production write path leaves the state the subquery then misreads.
    """
    first = client.post(f'/interactions/{clip.id}/toggle-like/')
    assert first.status_code == 200, first.data
    second = client.post(f'/interactions/{clip.id}/toggle-like/')
    assert second.status_code == 200, second.data

    from backend.app.models import UserInteraction
    row = UserInteraction.objects.get(
        user=user, clip=clip, interaction_type='like',
    )
    assert row.is_active is False, (
        "precondition: the un-like must leave the row in place with "
        "is_active=False — record_like_toggle flips the flag, it does not "
        "delete. If this ever deletes instead, the defect is unreachable and "
        "these tests are measuring nothing."
    )
    return row


class TestIsLikedRespectsIsActive:
    """A clip the user un-liked must read as not-liked, everywhere."""

    def test_feed_reports_unliked_clip_as_not_liked(
        self, api_client, viewer, make_clip, feed_queue,
    ):
        clip = make_clip('unlike-feed')
        api_client.force_authenticate(user=viewer)
        _like_then_unlike(api_client, clip, viewer)

        liked = _is_liked_by_clip(_feed_rows(api_client, feed_queue, clip))
        assert liked == {str(clip.id): False}, (
            f"/feed/ reported {liked} after an explicit un-like. The row is "
            "still there with is_active=False, so the subquery matched it."
        )

    def test_feed_and_profile_clips_agree_after_unlike(
        self, api_client, viewer, owner, make_clip, feed_queue,
    ):
        """The actual bug is the *disagreement*, so assert the two screens.

        A pair of independent assertions restating the rule would both go
        red today and both go green after any patch that adds
        ``is_active=True`` — including one that only fixes one of them. This
        one fails if either screen drifts.
        """
        clip = make_clip('unlike-parity')
        api_client.force_authenticate(user=viewer)
        _like_then_unlike(api_client, clip, viewer)

        feed_liked = _is_liked_by_clip(_feed_rows(api_client, feed_queue, clip))
        profile_liked = _is_liked_by_clip(
            api_client.get(f'/profile/{owner.id}/clips/'),
        )
        assert feed_liked == profile_liked, (
            "the same user sees contradictory is_liked for the same clip "
            f"depending on the screen: /feed/={feed_liked} "
            f"/profile/{{id}}/clips/={profile_liked}"
        )
        assert profile_liked == {str(clip.id): False}

    def test_suggestions_reports_unliked_clip_as_not_liked(
        self, api_client, viewer, make_clip,
    ):
        clip = make_clip('unlike-suggestions')
        api_client.force_authenticate(user=viewer)
        _like_then_unlike(api_client, clip, viewer)

        liked = _is_liked_by_clip(api_client.get('/suggestions/'))
        assert liked == {str(clip.id): False}, (
            f"/suggestions/ reported {liked} after an explicit un-like"
        )

    def test_degraded_fallback_reports_unliked_clip_as_not_liked(
        self, api_client, viewer, make_clip, monkeypatch,
    ):
        """The trending fallback inside ``except Exception``.

        Patching ``backend.app.views.feed.cache`` is load-bearing here and
        that is provable rather than assumed: ``FastFeedViewSet.list``
        resolves ``cache`` from this module's globals at feed.py:74
        (``redis_client = cache.client.get_client()``), and the test asserts
        the fake client's ``lpop`` was actually called. A patch of a name
        the function never reads would succeed and leave every assertion
        below it vacuous.
        """
        from backend.app.views import feed as feed_module

        clip = make_clip('unlike-fallback')
        api_client.force_authenticate(user=viewer)
        _like_then_unlike(api_client, clip, viewer)

        fake_client = MagicMock()
        fake_client.lpop.side_effect = ConnectionError('redis is down')
        fake_cache = MagicMock()
        fake_cache.client.get_client.return_value = fake_client
        monkeypatch.setattr(feed_module, 'cache', fake_cache)

        r = api_client.get('/feed/')
        assert fake_client.lpop.called, (
            "the patch was inert: FastFeedViewSet.list never reached "
            "cache.client.get_client(), so this asserted nothing"
        )
        assert r.status_code == 200, r.data
        assert r.data['degraded'] is True, (
            "the response did not come from the except-branch fallback, so "
            "the annotation under test was never evaluated"
        )
        liked = {row['id']: row['is_liked'] for row in r.data['results']}
        assert liked == {str(clip.id): False}, (
            f"the degraded fallback reported {liked} after an un-like"
        )

    def test_a_live_like_is_still_reported_as_liked(
        self, api_client, viewer, make_clip, feed_queue,
    ):
        """The guard against fixing this by always returning False."""
        clip = make_clip('like-live')
        api_client.force_authenticate(user=viewer)
        assert api_client.post(
            f'/interactions/{clip.id}/toggle-like/',
        ).status_code == 200

        liked = _is_liked_by_clip(_feed_rows(api_client, feed_queue, clip))
        assert liked == {str(clip.id): True}


# ---------------------------------------------------------------------------
# Defect 2 — the primary feed path omits status='ready'
# ---------------------------------------------------------------------------
class TestPrimaryFeedRequiresReadyStatus:
    def test_processing_clip_in_the_queue_is_not_returned(
        self, api_client, viewer, make_clip, feed_queue,
    ):
        """``moderation_approved=True`` on purpose.

        With it False the clip is already excluded by the moderation filter,
        so the test would stay green if the status filter were deleted — it
        would be measuring the wrong gate. This clip is the *only* thing the
        status filter can be holding back.
        """
        encoding = make_clip('still-encoding', status='processing')
        assert encoding.moderation_approved is True, (
            "precondition: this clip must be approved, or the moderation "
            "filter excludes it and the status filter is never exercised"
        )
        api_client.force_authenticate(user=viewer)

        r = _feed_rows(api_client, feed_queue, encoding)
        assert r.status_code == 200, r.data
        assert [row['id'] for row in r.data['results']] == [], (
            "a status='processing' clip was served from the primary feed "
            "path. The degraded fallback, /suggestions/, /profile/{id}/clips/ "
            "and send_share all filter status='ready'; the primary path did "
            "not."
        )

    def test_a_servable_clip_is_still_returned(
        self, api_client, viewer, make_clip, feed_queue,
    ):
        """The guard against over-filtering the hot path."""
        clean = make_clip('clean-feed')
        assert clean.status == 'ready' and clean.moderation_approved is True
        assert clean.is_noncommercial is False and clean.requires_share_alike is False
        api_client.force_authenticate(user=viewer)

        r = _feed_rows(api_client, feed_queue, clean)
        assert r.status_code == 200, r.data
        assert [row['id'] for row in r.data['results']] == [str(clean.id)], (
            f"a fully servable clip was withheld from the primary feed path "
            f"(status={r.status_code} data={r.data!r}); the status filter "
            "must be additive, not a replacement"
        )

    def test_the_other_feed_gates_still_apply_to_the_primary_path(
        self, api_client, viewer, make_clip, feed_queue,
    ):
        """Adding status='ready' must not have displaced the existing gates.

        These three were already covered by the moderation / licence filters,
        so they are must-preserve rather than newly fixed — the point is that
        a new clause in the same ``.filter()`` chain did not get written
        *instead of* one of them.
        """
        unapproved = make_clip('unapproved', moderation_approved=False)
        nc = make_clip('nc', is_noncommercial=True)
        sa = make_clip('sa', requires_share_alike=True)
        api_client.force_authenticate(user=viewer)

        r = _feed_rows(api_client, feed_queue, unapproved, nc, sa)
        assert r.status_code == 200, r.data
        assert r.data['results'] == [], (
            "the primary feed path served a clip that moderation or the "
            "licence filter should have excluded"
        )


# ---------------------------------------------------------------------------
# Defect 3 — the comment read path
# ---------------------------------------------------------------------------
@pytest.fixture
def make_comment(viewer):
    """Create a comment row directly.

    The service is used rather than the HTTP endpoint so a comment can be
    placed on a clip that the *write* path would refuse to serve — which is
    exactly the pre-existing state (comments written while a clip was
    servable, clip state changed afterwards) that the read gate must not
    quietly rewrite the history of.
    """
    from backend.app.services import comments as comments_svc

    def _make(clip, author=None, text='a comment', parent=None):
        return comments_svc.create_comment(
            user=author or viewer, clip=clip, text=text, parent=parent,
        )

    return _make


class TestCommentsReadGate:
    """Decision (the full reasoning is in ``views/comments.py``).

    ``GET /comments/?clip=X``
        404 unless X exists **and** is readable by the caller. A missing
        clip and a withheld clip are both 404, so the endpoint is not an
        existence oracle for either the clip table or the moderation /
        licence state of a clip that does exist.
    ``GET /comments/?parent=X`` / bare ``GET /comments/``
        No per-clip 404 is possible (no clip was named), so the queryset
        itself is restricted to comments on readable clips. Without this the
        bare list is a paginated dump of every comment in the database, and
        ``?parent=`` walks straight past the ``?clip=`` check.
    ``GET /comments/{id}/``
        Symmetric with the list: a comment on an unreadable clip is 404 for
        everyone except the clip's creator.
    Writes
        Unchanged. An author can always update and delete their own comment,
        whatever state the clip is in — that is the erasure and takedown
        path, and gating it would strand content nobody can remove.
    """

    def test_comments_on_an_unapproved_clip_are_withheld(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('unapproved-clip', moderation_approved=False)
        make_comment(clip)
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 404, (
            f"GET /comments/?clip=<unapproved> returned {r.status_code} with "
            f"{r.data!r}. It must be 404: the comment thread names and "
            "attributes users, and a never-approved clip is a private draft."
        )

    def test_comments_on_a_noncommercial_clip_are_withheld(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('nc-clip', is_noncommercial=True)
        make_comment(clip)
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 404, (
            f"GET /comments/?clip=<NonCommercial> returned {r.status_code} "
            f"with {r.data!r}. NC items are excluded from every feed and "
            "suggestion query for licensing reasons."
        )

    def test_comments_on_a_sharealike_clip_are_withheld(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('sa-clip', requires_share_alike=True)
        make_comment(clip)
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 404, (
            f"GET /comments/?clip=<ShareAlike> returned {r.status_code}"
        )

    def test_missing_clip_and_withheld_clip_are_indistinguishable(
        self, api_client, viewer, make_clip, make_comment,
    ):
        """The oracle itself, asserted as an equality of responses.

        403-for-withheld and 404-for-missing would leak the same fact; so
        would 200-with-empty for one and 404 for the other. Only a shared
        status code closes it.
        """
        withheld = make_clip('oracle-withheld', moderation_approved=False)
        make_comment(withheld)
        absent = uuid.uuid4()
        api_client.force_authenticate(user=viewer)

        withheld_r = api_client.get('/comments/', {'clip': str(withheld.id)})
        absent_r = api_client.get('/comments/', {'clip': str(absent)})
        assert withheld_r.status_code == absent_r.status_code == 404, (
            f"withheld={withheld_r.status_code}/{withheld_r.data} "
            f"absent={absent_r.status_code}/{absent_r.data}"
        )
        assert withheld_r.data == absent_r.data, (
            "the two responses differ in body, which is the same leak by "
            "another route"
        )

    def test_nonexistent_clip_is_404_not_an_empty_200(
        self, api_client, viewer,
    ):
        """The enumeration oracle this endpoint used to be.

        Before the fix this was ``200`` with ``results: []`` — the same
        response a servable clip with no comments produces, so a caller
        could not tell "no such clip" from "nobody has commented yet", and
        could sweep the clip-UUID space against a known-good response shape.
        """
        api_client.force_authenticate(user=viewer)
        r = api_client.get('/comments/', {'clip': str(uuid.uuid4())})
        assert r.status_code == 404, (
            f"a nonexistent clip id returned {r.status_code} {r.data!r}"
        )

    def test_a_malformed_clip_id_is_400_not_500(
        self, api_client, viewer,
    ):
        """``filter(pk='not-a-uuid')`` raises ``ValidationError``; the view
        must translate it, not 500."""
        api_client.force_authenticate(user=viewer)
        r = api_client.get('/comments/', {'clip': 'not-a-uuid'})
        assert r.status_code == 400, r.status_code

    def test_direct_retrieve_of_a_withheld_clip_comment_is_404(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('retrieve-withheld', is_noncommercial=True)
        comment = make_comment(clip)
        api_client.force_authenticate(user=viewer)

        r = api_client.get(f'/comments/{comment.id}/')
        assert r.status_code == 404, (
            f"GET /comments/{{id}}/ on a comment belonging to a withheld clip "
            f"returned {r.status_code} with {r.data!r}"
        )

    def test_direct_retrieve_of_a_servable_clip_comment_is_200(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('retrieve-ok')
        comment = make_comment(clip)
        api_client.force_authenticate(user=viewer)

        r = api_client.get(f'/comments/{comment.id}/')
        assert r.status_code == 200, r.data
        assert r.data['id'] == str(comment.id)

    def test_bare_list_does_not_dump_comments_on_withheld_clips(
        self, api_client, viewer, make_clip, make_comment,
    ):
        """``?clip=`` is checkable; the bare list names no clip at all.

        Left ungated it is a paginated walk over the whole comment table
        with author usernames attached, which no client uses (both the web
        ``CommentSheet`` and the mobile sheet always pass a clip) and which
        makes the ``?clip=`` 404 cosmetic.
        """
        clean = make_clip('dump-clean')
        nc = make_clip('dump-nc', is_noncommercial=True)
        make_comment(clean, text='visible')
        make_comment(nc, text='must not leak')
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/')
        assert r.status_code == 200, r.data
        texts = [row['text'] for row in r.data['results']]
        assert texts == ['visible'], (
            f"the bare comment list returned {texts!r}; a comment on a "
            "withheld clip was reachable without naming any clip id"
        )

    def test_parent_filter_does_not_walk_past_the_clip_gate(
        self, api_client, viewer, make_clip, make_comment,
    ):
        """``parent`` is the second independent ``filterset_fields`` entry,
        and it is client-supplied on create — so it needs the same gate as
        ``clip`` or ``?parent=`` is a straight bypass of ``?clip=``."""
        nc = make_clip('parent-nc', is_noncommercial=True)
        parent = make_comment(nc, text='parent on a withheld clip')
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'parent': str(parent.id)})
        assert r.status_code == 200, r.data
        assert r.data['results'] == [], (
            "?parent= returned the comment tree of a clip that ?clip= refuses"
        )


class TestCommentsGateDoesNotOverFilter:
    """Must-preserve. A gate that eats legitimate reads is not a fix."""

    def test_comments_on_a_servable_clip_are_listed(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('normal-clip')
        make_comment(clip, text='alice here')
        make_comment(clip, text='bob here')
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 200, r.data
        assert sorted(row['text'] for row in r.data['results']) == [
            'alice here', 'bob here',
        ]

    def test_a_servable_clip_with_no_comments_is_200_and_empty(
        self, api_client, viewer, make_clip,
    ):
        """The distinction the 404 is meant to preserve: this clip *is*
        readable, it just has nothing written on it."""
        clip = make_clip('quiet-clip')
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 200, r.data
        assert r.data['results'] == []

    def test_replies_still_resolve_and_keep_their_thread_shape(
        self, api_client, viewer, make_clip, make_comment,
    ):
        clip = make_clip('threaded')
        parent = make_comment(clip, text='parent')
        make_comment(clip, text='reply', parent=parent)
        api_client.force_authenticate(user=viewer)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 200, r.data
        by_text = {row['text']: row for row in r.data['results']}
        assert set(by_text) == {'parent', 'reply'}
        # `r.data` is the pre-render Python structure, so a
        # PrimaryKeyRelatedField carries a UUID instance here, not a string.
        # JSONRenderer stringifies it; comparing against str() makes the test
        # about threading rather than about renderer behaviour.
        assert str(by_text['reply']['parent']) == str(parent.id)
        assert by_text['parent']['parent'] is None
        assert by_text['parent']['reply_count'] == 1

    def test_the_creator_can_still_read_their_own_withheld_clip_thread(
        self, api_client, owner, make_clip, make_comment,
    ):
        """The deliberate exception.

        A blanket filter would also hide the thread from the person who
        uploaded the clip and wrote the comments — including after they lose
        moderation approval or the clip turns out to be NC, which is exactly
        when they most need to see and delete it. This mirrors the owner
        exemption already in ``services/entitlements.resolve_clip_access``.
        """
        clip = make_clip('owner-clip', moderation_approved=False)
        make_comment(clip, author=owner, text='note to self')
        api_client.force_authenticate(user=owner)

        r = api_client.get('/comments/', {'clip': str(clip.id)})
        assert r.status_code == 200, r.data
        assert [row['text'] for row in r.data['results']] == ['note to self']

    def test_the_author_can_still_delete_their_comment_on_a_withheld_clip(
        self, api_client, viewer, make_clip, make_comment,
    ):
        """Writes are deliberately not gated.

        This is the GDPR-erasure and content-takedown path. If the read gate
        leaked into writes, a comment on a withdrawn clip could never be
        removed by anyone, which is a compliance regression in exchange for
        a metadata one.
        """
        from backend.app.models import Comment

        clip = make_clip('deletable', is_noncommercial=True)
        comment = make_comment(clip, text='remove me')
        api_client.force_authenticate(user=viewer)

        r = api_client.delete(f'/comments/{comment.id}/')
        assert r.status_code == 204, r.data
        assert not Comment.objects.filter(pk=comment.pk).exists()

    def test_a_non_author_non_owner_still_gets_404_on_write(
        self, api_client, other_user, make_clip, make_comment, owner,
    ):
        """The write scoping from c12f16b must survive the read gate."""
        clip = make_clip('write-scope')
        comment = make_comment(clip, author=other_user, text='bob was here')
        api_client.force_authenticate(user=owner)

        r = api_client.patch(
            f'/comments/{comment.id}/', {'text': 'pwned'}, format='json',
        )
        assert r.status_code in (403, 404), r.status_code
        comment.refresh_from_db()
        assert comment.text == 'bob was here'


# ---------------------------------------------------------------------------
# Cross-clip `parent` — fixed in services/comments.create_comment
# ---------------------------------------------------------------------------
class TestCrossClipParentIsUnenforced:
    """`parent` is client-supplied on create and nothing checked it belonged to
    the same clip as the comment.

    ``services/comments.create_comment`` wrote ``Comment.objects.create(
    author=..., clip=clip, ..., parent=parent)`` with no cross-check, and
    ``CommentSerializer`` had no ``validate`` comparing ``parent.clip_id`` to
    ``clip.id``. So a reply could be filed under clip A while pointing at a
    parent on clip B, after which ``?clip=A`` returns the reply and
    ``?clip=B`` returns its parent. The row itself is *valid* — both FKs
    resolve — so no database constraint catches it either, which is why this
    is a reference-integrity failure rather than a 500.

    Fixed in the service rather than the serializer; the reasoning is on
    ``create_comment``. The class name is deliberately unchanged: these tests
    are named for the defect they pin, and they have to keep pinning it now
    that it is fixed. The realistic regression is a well-meaning
    "simplification" that drops the check as redundant, since the model
    still accepts the row.

    ``test_reply_to_a_parent_on_another_clip_is_refused`` was an
    ``xfail(strict=True)`` for the duration of the defect. The strict marker
    was load-bearing — it would have failed the moment the check landed
    rather than rotting into a false guarantee — and it is now a real
    assertion.
    """

    def test_reply_to_a_parent_on_another_clip_is_refused(
        self, api_client, viewer, make_clip,
    ):
        from backend.app.models import Comment

        clip_a = make_clip('cross-a')
        clip_b = make_clip('cross-b')
        stranger_parent = Comment.objects.create(
            clip=clip_b, author=viewer, text='parent lives on B',
        )
        api_client.force_authenticate(user=viewer)

        r = api_client.post('/comments/', {
            'clip': str(clip_a.id),
            'parent': str(stranger_parent.id),
            'text': 'reply filed under the wrong clip',
        }, format='json')
        assert r.status_code == 400, (
            f"a reply to a parent on clip B was accepted under clip A "
            f"({r.status_code} {r.data!r}); the thread is now split across "
            "two clips"
        )
        # Keyed on `parent`, not `detail`: the offending input is the parent
        # reference, and a `detail` string would not tell the client which
        # field to drop.
        assert 'parent' in r.data, r.data
        assert not Comment.objects.filter(
            clip=clip_a, text='reply filed under the wrong clip',
        ).exists(), 'the refused reply was persisted anyway'

    def test_a_top_level_comment_is_still_accepted(
        self, api_client, viewer, make_clip,
    ):
        """`parent=None` is the overwhelmingly common case; a check written
        as `parent.clip_id != clip.id` without the None guard would 400 every
        comment on the app."""
        from backend.app.models import Comment

        clip = make_clip('top-level')
        api_client.force_authenticate(user=viewer)

        r = api_client.post('/comments/', {
            'clip': str(clip.id),
            'text': 'a plain comment',
        }, format='json')
        assert r.status_code == 201, r.data
        row = Comment.objects.get(pk=r.data['id'])
        assert row.clip_id == clip.id
        assert row.parent_id is None

    def test_a_reply_whose_parent_is_on_the_same_clip_is_still_accepted(
        self, api_client, viewer, make_clip, make_comment,
    ):
        from backend.app.models import Comment

        clip = make_clip('same-clip-reply')
        parent = make_comment(clip, text='parent')
        api_client.force_authenticate(user=viewer)

        r = api_client.post('/comments/', {
            'clip': str(clip.id),
            'parent': str(parent.id),
            'text': 'a reply on the same clip',
        }, format='json')
        assert r.status_code == 201, r.data
        row = Comment.objects.get(pk=r.data['id'])
        assert row.parent_id == parent.id
        assert row.clip_id == clip.id
