"""Authorization tests for `ClipInteractionViewSet` (R5-02).

The finding
-----------
``backend/app/views/interactions.py`` shipped with

    class ClipInteractionViewSet(viewsets.GenericViewSet):
        queryset = AudioClip.objects.all()

and ``self.get_object()`` on all three actions. So any authenticated user who
learned a clip UUID could ``POST /interactions/{uuid}/register-skip/`` and land a
``skips`` increment plus a completion sample on **any** clip — including one
with ``moderation_approved=False``, which appears in no feed at all.

Measured damage on the unpatched code (red run of this file), for one request:

    POST /interactions/<unmoderated clip>/register-skip/
    -> 201, and the store holds  skips=1  completion_sum=1  completion_count=1

``flush_counters_to_pg`` folds those into ``AudioClip.skips`` and
``AudioClip.avg_completion_rate`` — the latter is **30%** of the recommendation
composite (``feed_pool.py:151-153``, ``:224-226``). A forged *like* moves
``engagement_velocity`` (25%) by the same path. So this is a write-IDOR and a
ranking-poisoning primitive against unpublished content, at 60 requests/min.

What is deliberately NOT asserted here
--------------------------------------
This is **not** an amplifier of the A4 licence gate. ``resolve_clip_access``
tests ``is_license_restricted`` at ``entitlements.py:112`` **before**
``_has_interaction`` at ``:118``, so forging an interaction does not unlock an
NC clip's audio. The damage is ranking and data integrity, not playback.
``services/entitlements.py`` is another agent's file and is not modified.

How "no damage" is asserted, and why not the obvious way
--------------------------------------------------------
The obvious assertion — "no ``UserInteraction`` row" — is **worthless on its own
for the skip path**. ``record_skip`` no longer writes a row synchronously; the
row is materialized later by ``flush_counters_to_pg`` from the Redis counter
store. So the row is absent against the vulnerable code too, and the assertion
would pass for the wrong reason. Only ``toggle_like`` writes its row inline.

Asserting that the Redis keys were untouched has the same problem in the other
direction: ``counter_store`` is Redis-backed in this stack (the default cache is
``django_redis``), the store is **shared with five other agents**, and its
``drain()`` is a ``KEYS clip:*`` read-and-reset of the entire keyspace
(``counter_store.py:140-196``). ``test_counter_store.py`` calls ``drain()`` in
several tests. Measured here: an identical positive-control assertion was green
in one run and red in the next with ``assert None == '1'`` and no code change in
between — another agent's drain had removed the key.

So this file installs ``counter_store``'s **own** ``_InMemoryBackend`` (its
documented test backend: identical key layout, identical ``drain()`` output
shape, no Redis) for the duration of every test, and then asserts the real
``flush_counters_to_pg`` path. That gives the strongest available evidence:

  * blocked  -> the flusher's own accounting says ``drained == 0`` (so
    ``counter_store.add_completion`` / ``increment`` were never called at all),
    and the ranking columns ``AudioClip.skips`` / ``avg_completion_rate`` /
    ``likes`` are unmoved;
  * servable -> the same flusher moves them, which is what makes the blocked
    assertions non-vacuous.

Failure mode
------------
**404, not 403.** ``get_object()`` raises ``Http404`` and DRF renders 404 with no
extra code, whereas 403 would confirm the clip exists — and a UUID is the only
identifier here, so a 403 is a clip-existence oracle. This is the choice Group C
already made for the same class of defect in ``views/content.py:255-258``
("404 rather than 403 for someone else's clip").
"""
import uuid
from types import SimpleNamespace

import pytest
from rest_framework.test import APIClient

from backend.app.models import AudioClip, ShareEvent, UserInteraction
from backend.app.services import interactions as interactions_svc
from backend.app.services import counter_store
from backend.app.views.interactions import ClipInteractionViewSet

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures. Usernames are prefixed `w2b_` so this file's INSERTs are unlikely to
# collide with another agent's concurrently running fixtures inside the shared
# rollback-per-test transactions.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def private_counter_store(monkeypatch):
    """Give this test a counter store of its own, restored afterwards.

    See the module docstring: the real store is the shared Redis, and any other
    agent running ``test_counter_store.py`` drains the whole ``clip:*`` keyspace
    out from under an in-flight assertion. ``_build_backend`` is patched rather
    than the cache settings, and the cached singleton is reset on both sides, so
    no other test file inherits this backend.
    """
    monkeypatch.setattr(
        counter_store, "_build_backend", lambda: counter_store._InMemoryBackend()
    )
    counter_store._reset_backend_for_tests()
    yield
    counter_store._reset_backend_for_tests()


@pytest.fixture
def attacker(django_user_model):
    """The caller. Never the creator of any clip under test."""
    return django_user_model.objects.create_user(
        username="w2b_attacker", email="w2b_attacker@example.com",
        password="pw-probe-12345",
    )


@pytest.fixture
def author(django_user_model):
    """A third party who owns the clips the attacker must not touch."""
    return django_user_model.objects.create_user(
        username="w2b_author", email="w2b_author@example.com",
        password="pw-probe-12345",
    )


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _make_clip(creator, *, moderation_approved=True, is_noncommercial=False,
               requires_share_alike=False, status="ready", title="clip"):
    return AudioClip.objects.create(
        creator=creator,
        title=title,
        category="music",
        status=status,
        moderation_approved=moderation_approved,
        is_noncommercial=is_noncommercial,
        requires_share_alike=requires_share_alike,
        duration_ms=30_000,
    )


@pytest.fixture
def servable_clip(author):
    """Exactly what `FastFeedViewSet` serves a stranger: ready, moderated,
    licence-clean, and not owned by the caller."""
    return _make_clip(author, title="servable")


@pytest.fixture
def unmoderated_clip(author):
    """Uploaded but not yet approved. Invisible in every feed."""
    return _make_clip(author, moderation_approved=False, title="unmoderated")


@pytest.fixture
def nc_clip(author):
    return _make_clip(author, is_noncommercial=True, title="nc")


@pytest.fixture
def sa_clip(author):
    return _make_clip(author, requires_share_alike=True, title="sa")


# ---------------------------------------------------------------------------
# Request payloads
# ---------------------------------------------------------------------------
def _skip_payload(**overrides):
    """The finding's payload: a completion-rate-maxing listen claim."""
    body = {
        "listen_duration_ms": 99_999,
        "reel_position_ms": 1,
        "reel_id": str(uuid.uuid4()),
    }
    body.update(overrides)
    return body


def _telemetry_payload(**overrides):
    body = {"action_type": "view", "watch_time_ms": 4200}
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Damage assertions
# ---------------------------------------------------------------------------
def _flush():
    """Run the real counter -> Postgres flusher, inside the test transaction."""
    from backend.app.tasks import flush_counters_to_pg

    return flush_counters_to_pg.run()


def _ranking_state(clip):
    """The persisted columns the recommendation composite reads.

    `feed_pool.py:151-153` / `:224-226`:
        0.45 * vector_similarity + 0.30 * avg_completion_rate
                                 + 0.25 * engagement_velocity
    `engagement_velocity` is recomputed from likes/shares only
    (`tasks.py:_apply_engagement_velocity`), so it is reported for
    completeness but is not moved by a skip.
    """
    clip.refresh_from_db()
    return {
        "skips": clip.skips,
        "likes": clip.likes,
        "avg_completion_rate": clip.avg_completion_rate,
    }


def _ranking_state_after_flush(clip):
    _flush()
    return _ranking_state(clip)


def _assert_no_damage(response, clip, user, stream_key=None):
    """Refused, and nothing anywhere: not in the store, not in Postgres.

    One combined assertion on purpose. Checking the status and then the side
    effects in sequence means a red run reports only the status, which is the
    least interesting facet — the counters are the actual damage. Gathering
    first and asserting once prints every facet, so a red run is evidence
    rather than a status code.
    """
    flushed = _flush()
    observed = {
        "status": response.status_code,
        # Proves the store was empty, i.e. counter_store.add_completion() and
        # counter_store.increment() were never reached.
        "drained_by_flusher": flushed["drained"],
        "user_interactions": sorted(
            UserInteraction.objects.filter(user=user, clip=clip).values_list(
                "interaction_type", flat=True
            )
        ),
        "ranking_columns": _ranking_state(clip),
    }
    if stream_key is not None:
        observed["telemetry_events"] = _stream_length(stream_key)
    expected = {
        "status": 404,
        "drained_by_flusher": 0,
        "user_interactions": [],
        "ranking_columns": {
            "skips": 0, "likes": 0, "avg_completion_rate": 0.0,
        },
    }
    if stream_key is not None:
        expected["telemetry_events"] = 0
    assert observed == expected, observed


@pytest.fixture
def private_telemetry_stream():
    """Redirect the telemetry stream to a key only this test writes.

    ``record_telemetry`` reads the module global ``STREAM_KEY`` at call time, so
    patching the attribute is enough. Without this, "no event was enqueued" could
    only be asserted against a stream the other agents are appending to.
    """
    key = f"test:w2b:interaction.events:{uuid.uuid4()}"
    original = interactions_svc.STREAM_KEY
    interactions_svc.STREAM_KEY = key
    try:
        yield key
    finally:
        interactions_svc.STREAM_KEY = original
        _redis_client().delete(key)


def _redis_client():
    from django.core.cache import cache

    return cache.client.get_client()


def _stream_length(key):
    return _redis_client().xlen(key)


# ---------------------------------------------------------------------------
# 1. moderation_approved=False — the core of the finding
# ---------------------------------------------------------------------------
class TestUnmoderatedClipIsOutOfScope:
    def test_toggle_like_is_refused(self, attacker, unmoderated_clip):
        r = _client_for(attacker).post(
            f"/interactions/{unmoderated_clip.id}/toggle-like/"
        )
        _assert_no_damage(r, unmoderated_clip, attacker)

    def test_register_skip_is_refused(self, attacker, unmoderated_clip):
        r = _client_for(attacker).post(
            f"/interactions/{unmoderated_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        _assert_no_damage(r, unmoderated_clip, attacker)

    def test_log_telemetry_is_refused(
        self, attacker, unmoderated_clip, private_telemetry_stream,
    ):
        r = _client_for(attacker).post(
            f"/interactions/{unmoderated_clip.id}/log-telemetry/",
            _telemetry_payload(), format="json",
        )
        _assert_no_damage(
            r, unmoderated_clip, attacker, stream_key=private_telemetry_stream,
        )

    def test_unknown_clip_id_is_also_404(self, attacker):
        """The denial must be indistinguishable from a clip that does not exist,
        or it is a clip-existence oracle (and a UUID is the only identifier
        here)."""
        r = _client_for(attacker).post(
            f"/interactions/{uuid.uuid4()}/register-skip/",
            _skip_payload(), format="json",
        )
        assert r.status_code == 404, r.data


# ---------------------------------------------------------------------------
# 2. Licence-restricted (NC / SA), owned by a third party and not shared
# ---------------------------------------------------------------------------
class TestLicenceRestrictedClipIsOutOfScope:
    @pytest.mark.parametrize("fixture_name", ["nc_clip", "sa_clip"])
    def test_register_skip_is_refused(self, attacker, request, fixture_name):
        clip = request.getfixturevalue(fixture_name)
        r = _client_for(attacker).post(
            f"/interactions/{clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        _assert_no_damage(r, clip, attacker)

    @pytest.mark.parametrize("fixture_name", ["nc_clip", "sa_clip"])
    def test_toggle_like_is_refused(self, attacker, request, fixture_name):
        clip = request.getfixturevalue(fixture_name)
        r = _client_for(attacker).post(f"/interactions/{clip.id}/toggle-like/")
        _assert_no_damage(r, clip, attacker)


# ---------------------------------------------------------------------------
# 3. The servable clip must keep working — the over-blocking regression guard,
#    and the positive control that makes section 1/2's assertions non-vacuous.
# ---------------------------------------------------------------------------
class TestServableClipStaysInteractable:
    def test_toggle_like_succeeds_and_writes_the_row(self, attacker, servable_clip):
        r = _client_for(attacker).post(
            f"/interactions/{servable_clip.id}/toggle-like/"
        )
        assert r.status_code == 200, r.data
        assert r.data["status"] == "liked"
        assert UserInteraction.objects.get(
            user=attacker, clip=servable_clip, interaction_type="like",
        ).is_active is True
        _flush()
        assert _ranking_state(servable_clip) == {
            "skips": 0, "likes": 1, "avg_completion_rate": 0.0,
        }

    def test_register_skip_succeeds_and_poisons_the_ranking_columns(
        self, attacker, servable_clip,
    ):
        """The positive control. This is what the blocked cases must *not* do:
        a 201, a `skips` increment and a completion sample that the flusher
        turns into `avg_completion_rate`.
        """
        r = _client_for(attacker).post(
            f"/interactions/{servable_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        assert r.status_code == 201, r.data
        flushed = _flush()
        assert flushed["drained"] > 0
        state = _ranking_state(servable_clip)
        assert state["skips"] == 1
        # One sample of 1.0, blended against the stored prior with weight 10
        # (tasks.py:_COMPLETION_PRIOR_WEIGHT): (0.0 * 10 + 1.0) / 11.
        # The sample is 1.0 and not 99999/1 because `_completion_rate` divides
        # by the server-side clip.duration_ms (commit 20f6e7e).
        assert state["avg_completion_rate"] == pytest.approx(1.0 / 11)
        assert UserInteraction.objects.filter(
            user=attacker, clip=servable_clip, interaction_type="view",
        ).exists()

    def test_log_telemetry_succeeds_and_enqueues_one_event(
        self, attacker, servable_clip, private_telemetry_stream,
    ):
        r = _client_for(attacker).post(
            f"/interactions/{servable_clip.id}/log-telemetry/",
            _telemetry_payload(), format="json",
        )
        assert r.status_code == 202, r.data
        assert _stream_length(private_telemetry_stream) == 1


# ---------------------------------------------------------------------------
# 4. ShareEvent — "can a user still interact with a clip shared to them?"
#    Answer: yes. See the class docstring.
# ---------------------------------------------------------------------------
class TestShareEventClipStaysInteractable:
    """A clip in the share inbox must stay interactable.

    Conclusion: **yes**, a share recipient may interact, and this file pins it.

    Why it must: ``resolve_clip_access`` (``entitlements.py:108-110``) grants
    ``ACCESS_SHARED_WITH_ME`` on the existence of a ``ShareEvent`` and returns
    *before* the licence check, by explicit design. The share inbox is a
    first-class surface — ``GET /share/inbox/`` serialises the clip through
    ``FeedClipSerializer`` and hands back a playable HLS URL. Denying the like
    on a clip the app itself just put in your inbox and let you play is the
    "the link works for you, then stops working" failure mode that
    ``views/content.py``'s per-action throttle work was written to avoid.

    Note the NC/SA case below: ``send_share`` refuses to *create* such a share
    today (``views/social.py:173-181``), so it can only be data written before
    that fix. It is still asserted, because the alternative is inventing a
    second, stricter rule than the one module that declares itself the single
    source of truth — and pre-fix rows are exactly the data a migration would
    have to reason about.

    What a share does *not* survive: unmoderation. A takedown clears
    ``moderation_approved`` and is enforced by refusing the share even when the
    ShareEvent row survives, so the share clause is gated on moderation.
    """

    def test_shared_servable_clip_is_interactable(
        self, attacker, author, servable_clip,
    ):
        ShareEvent.objects.create(
            sender=author, receiver=attacker, clip=servable_clip,
        )
        client = _client_for(attacker)
        like = client.post(f"/interactions/{servable_clip.id}/toggle-like/")
        assert like.status_code == 200, like.data
        skip = client.post(
            f"/interactions/{servable_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        assert skip.status_code == 201, skip.data
        assert _ranking_state_after_flush(servable_clip)["skips"] == 1

    def test_shared_noncommercial_clip_is_interactable(
        self, attacker, author, nc_clip,
    ):
        """Matches `resolve_clip_access`: the sharee exemption is evaluated
        before `is_license_restricted`, so a share recipient may act on an NC
        clip exactly as they may play it."""
        ShareEvent.objects.create(
            sender=author, receiver=attacker, clip=nc_clip,
        )
        r = _client_for(attacker).post(
            f"/interactions/{nc_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        assert r.status_code == 201, r.data

    def test_shared_clip_unmoderated_after_the_share_is_refused(
        self, attacker, author, servable_clip,
    ):
        """The takedown case. The ShareEvent row outlives the moderation
        reversal, and the share must not become a durable capability over
        withdrawn content."""
        ShareEvent.objects.create(
            sender=author, receiver=attacker, clip=servable_clip,
        )
        AudioClip.objects.filter(pk=servable_clip.pk).update(
            moderation_approved=False,
        )
        r = _client_for(attacker).post(
            f"/interactions/{servable_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        _assert_no_damage(r, servable_clip, attacker)

    def test_three_senders_of_one_clip_does_not_500(
        self, attacker, servable_clip, django_user_model,
    ):
        """The ShareEvent branch joins, so the same clip can match three rows
        in the scope queryset. `get_object()` ends in `.get()`, which raises
        `MultipleObjectsReturned` (a 500) on duplicates — this is what the
        `.distinct()` in `get_queryset` is load-bearing for, and a comment
        asserting it would be weaker than a request that proves it."""
        senders = [
            django_user_model.objects.create_user(
                username=f"w2b_sender{i}", email=f"w2b_sender{i}@example.com",
                password="pw-probe-12345",
            )
            for i in range(3)
        ]
        for sender in senders:
            ShareEvent.objects.create(
                sender=sender, receiver=attacker, clip=servable_clip,
            )
        r = _client_for(attacker).post(
            f"/interactions/{servable_clip.id}/register-skip/",
            _skip_payload(), format="json",
        )
        assert r.status_code == 201, r.data


# ---------------------------------------------------------------------------
# 5. The owner may always interact with their own clip
# ---------------------------------------------------------------------------
class TestOwnerMayInteractWithOwnClip:
    def test_own_unmoderated_clip_is_interactable(self, author):
        """The one deliberate divergence from `resolve_clip_access`, which
        refuses playback of an unmoderated clip even to its creator.

        Interaction is not playback. An unmoderated clip belongs to exactly one
        person — its uploader — and they are the only party the v1 flow lets
        approve it (``views/content.py:262-264``). Scoping their own draft more
        tightly than their ownership rights would be incoherent, and it would
        break existing coverage in
        ``test_security_and_validation.py::TestInteractions``, which likes and
        logs telemetry against the (unmoderated) ``ready_clip`` fixture.
        """
        own = _make_clip(author, moderation_approved=False, title="own draft")
        r = _client_for(author).post(f"/interactions/{own.id}/toggle-like/")
        assert r.status_code == 200, r.data
        assert r.data["status"] == "liked"

    def test_own_sharealike_clip_is_interactable(self, author):
        own = _make_clip(author, requires_share_alike=True, title="own sa")
        r = _client_for(author).post(f"/interactions/{own.id}/toggle-like/")
        assert r.status_code == 200, r.data


# ---------------------------------------------------------------------------
# 6. Anti-drift: the SQL scope must agree with `resolve_clip_access`
# ---------------------------------------------------------------------------
class TestScopeAgreesWithEntitlements:
    """The rule exists in one place: ``services/entitlements.py`` declares itself
    "the single source of truth" for what a user may do with a clip. A
    hand-written queryset is a *copy* of that rule, so this matrix is what makes
    the copy safe — if the two ever disagree, this fails.

    Exactly one divergence is expected and documented: the owner of an
    unmoderated clip (section 5). Everything else must agree.
    """

    @staticmethod
    def _in_scope(user, clip):
        view = ClipInteractionViewSet()
        view.request = SimpleNamespace(user=user)
        return view.get_queryset().filter(pk=clip.pk).exists()

    def test_scope_matches_resolve_clip_access_across_the_matrix(
        self, attacker, author, django_user_model,
    ):
        from backend.app.services.entitlements import resolve_clip_access

        # A third party, so the "shared with me" branch has a sender who is
        # neither the attacker nor the author.
        other = django_user_model.objects.create_user(
            username="w2b_other", email="w2b_other@example.com",
            password="pw-probe-12345",
        )

        cases = []
        for moderated in (True, False):
            for is_owner in (True, False):
                for is_sharee in (True, False):
                    for restricted in (True, False):
                        # Creator is chosen at create time, not patched with
                        # .update(): `resolve_clip_access` reads
                        # `clip.creator_id` off the in-memory instance, so a
                        # post-hoc UPDATE would leave the Python side of the
                        # comparison reading a stale value.
                        clip = _make_clip(
                            attacker if is_owner else author,
                            moderation_approved=moderated,
                            requires_share_alike=restricted,
                            title=f"m{moderated}-o{is_owner}-s{is_sharee}-r{restricted}",
                        )
                        if is_sharee:
                            ShareEvent.objects.create(
                                sender=other, receiver=attacker, clip=clip,
                            )
                        cases.append(
                            (clip, moderated, is_owner, is_sharee, restricted)
                        )

        assert len(cases) == 16
        for clip, moderated, is_owner, is_sharee, restricted in cases:
            allowed, reason = resolve_clip_access(attacker, clip)
            in_scope = self._in_scope(attacker, clip)
            label = (
                f"moderated={moderated} owner={is_owner} sharee={is_sharee} "
                f"restricted={restricted} (entitlements said "
                f"{'allow' if allowed else 'deny'}/{reason})"
            )
            if is_owner and not moderated:
                # Documented divergence — see TestOwnerMayInteractWithOwnClip.
                assert in_scope, label
                continue
            assert in_scope == allowed, (
                f"interaction scope disagrees with resolve_clip_access: {label}"
            )

    def test_following_the_author_does_not_change_the_answer(self, attacker, author):
        """`resolve_clip_access` reports ACCESS_FOLLOWED_AUTHOR *after* the
        licence check and never as a gate. If the interaction scope started
        honouring `following`, a licence-restricted clip would become
        interactable by following its author — a licence bypass by social graph.
        """
        from backend.app.services.entitlements import resolve_clip_access

        restricted = _make_clip(author, requires_share_alike=True, title="sa followed")
        attacker.following.add(author)
        attacker.refresh_from_db()
        assert not self._in_scope(attacker, restricted)
        allowed, reason = resolve_clip_access(attacker, restricted)
        assert allowed is False
        assert reason == "license_restricted"


# ---------------------------------------------------------------------------
# 7. Regression guard for the per-action throttle dispatch that sits directly
#    above get_queryset(). It must stay a property keyed on self.action.
# ---------------------------------------------------------------------------
class TestThrottleScopePropertyPreserved:
    def test_scope_is_per_action_not_static(self):
        view = ClipInteractionViewSet()
        view.action = "log_telemetry"
        assert view.throttle_scope == "telemetry"
        view.action = "register_skip"
        assert view.throttle_scope == "interaction"
        view.action = "toggle_like"
        assert view.throttle_scope == "interaction"
