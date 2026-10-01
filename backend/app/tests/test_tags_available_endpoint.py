"""`GET /tags/available/` — the tag vocabulary the catalogue actually has.

WHY THE ENDPOINT EXISTS
-----------------------
The onboarding modal offered eight hardcoded ids (`comedy`, `science`,
`motivation`, `music`, `quotes`, `instrumental`, `tech`, `mindset`) and
preselected two. Those are `AudioClip.category` values being sent as `tags`,
and `TagsViewSet.initialize_vectors` matches with exact JSONB containment
(`tags @> '["comedy"]'::jsonb`). No clip in the corpus satisfies that, so not
one of the eight could ever match: every cold start returned 400
`Not enough data to build baseline.` and `select count(*) from app_user where
long_term_semantic is not null` was 0 — the feature had never succeeded once.

The fix is to stop guessing: return what the data has, and let the client
render it.

THE INVARIANT UNDER TEST
------------------------
Offering a tag T is a promise that `POST /tags/initialize/` with just T will
find something. That holds if and only if the endpoint's clip population is the
matcher's population minus the tag containment, so

    len(matcher(T)) == min(advertised[T]['clips'], MATCHER_BASELINE_LIMIT)

`TestOfferedTagsAreMatchable` pins it by rebuilding the matcher's filter
**independently of the view's helper** — deliberate duplication, because a test
that called `feed_views._baseline_population()` would be asserting that a
function equals itself and a divergence between the two copies would be
invisible. If someone tightens one copy and not the other, this test fails.

The other way this could go wrong is offering a tag that then 400s
(unmatchable, empty, padded, over-length), which is worse than offering
nothing, so each of those has its own test below.

THE THROTTLE
------------
`TagsViewSet` declared no `throttle_scope` at all, and
`ScopedRateThrottle.allow_request` returns True — no counter, no accounting —
when the view it is asked about has no scope, so both actions ran on the
generic `user` (1000/hour) bucket alone. Both the wiring and the *rates* are
asserted here, and the rate assertion is not decoration: a scope name with no
entry in `DEFAULT_THROTTLE_RATES` does not fall back to a default, it raises
`ImproperlyConfigured` on every request (a 500), because `SimpleRateThrottle`
binds `THROTTLE_RATES` to the settings dict *at import time* — so a rate added
to settings after the class was imported is not even visible to it.

Fixtures follow `test_tags_initialize_bounds.py`: `AudioClip.objects.create()`
alone does not produce a clip the matcher can see, so both vector columns are
always supplied.
"""
import unittest
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache.backends.locmem import LocMemCache
from django.db.models import Q
from django.test import TestCase
from django.urls import resolve
from rest_framework.test import APIClient

from backend.app.models import AudioClip
from backend.app.views import feed as feed_views

URL = '/tags/available/'
INITIALIZE_URL = '/tags/initialize/'

# `initialize_vectors` reads this module global, so this is the name to patch
# (AGENTS.md: never patch a module-level name the function does not read).
# Unpatched, every successful initialization fires a real Celery apply_async.
PUBLISH = mock.patch.object(feed_views, 'publish')

# `initialize_vectors` ends with `.order_by('-likes')[:100]` (feed.py:417), so
# above this many matches the matcher is saturated rather than wrong. The
# advertised count is the *total* matchable count, which is what a user picking
# a tag wants to know.
MATCHER_BASELINE_LIMIT = 100


def matcher_queryset(*tags):
    """`initialize_vectors`' own filter, transcribed.

    Deliberately NOT `feed_views._baseline_population()`: this is the
    *matcher*, rebuilt from `TagsViewSet.initialize_vectors`
    (backend/app/views/feed.py:615-622) including its per-tag containment and
    its `[:100]` slice. Comparing two independently-built querysets is what
    makes the invariant test worth anything.
    """
    tag_filter = Q()
    for tag in tags:
        tag_filter |= Q(tags__contains=[tag])
    return AudioClip.objects.filter(
        tag_filter,
        semantic_vector__isnull=False,
        acoustic_vector__isnull=False,
        moderation_approved=True,
    ).order_by('-likes')[:MATCHER_BASELINE_LIMIT]


def _resolve_rate(scope):
    """What `ScopedRateThrottle` resolves a scope name to, or raises.

    `ScopedRateThrottle.__init__` is a deliberate no-op — the scope is only
    known once `allow_request` is called with a view — so the instance is free
    to construct and `get_rate()` is the whole resolution.
    """
    from rest_framework.throttling import ScopedRateThrottle
    throttle = ScopedRateThrottle()
    throttle.scope = scope
    return throttle.get_rate()


def _parse_rate(rate):
    """`'60/hour'` -> `(60, 3600)`, without hardcoding either number."""
    from rest_framework.throttling import ScopedRateThrottle
    return ScopedRateThrottle.parse_rate(ScopedRateThrottle(), rate)


class TagsAvailableTestBase(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(username='tagsavail', password='x')
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        PUBLISH.start()
        self.addCleanup(PUBLISH.stop)

    def make(self, title, tags, sem=None, ac=None, **kwargs):
        """An eligible clip: moderation-approved, both vectors present.

        The default vectors are binary-exact so an averaging assertion would be
        about the averaging, not float32 quantisation inside pgvector.
        """
        return AudioClip.objects.create(
            creator=self.user, title=title, category='comedy',
            status='ready', moderation_approved=True,
            is_noncommercial=False, requires_share_alike=False,
            duration_ms=10_000, tags=tags,
            semantic_vector=sem if sem is not None else [0.25] * 384,
            acoustic_vector=ac if ac is not None else [0.25] * 128,
            **kwargs,
        )

    def offered(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIn('tags', r.data, r.data)
        return r.data['tags']

    def by_tag(self, tags):
        return {row['tag']: row['clips'] for row in tags}


class TestOfferedTagsAreMatchable(TagsAvailableTestBase):
    """The deliverable: every offered tag matches, and matches *this many*
    times."""

    def setUp(self):
        super().setUp()
        # Three clips on two tags and two on three others, so the counts in the
        # response are not all identical (an off-by-one in the aggregation has
        # to show up somewhere), plus a tag on a single clip and one clip with
        # an empty tag array.
        self.make('c1', ['listen', 'feel', 'night'])
        self.make('c2', ['listen', 'feel', 'night'])
        self.make('c3', ['listen', 'feel'])
        self.make('c4', ['solo', 'alone', 'lonely'])
        self.make('c5', ['solo', 'alone'])
        self.make('c6', [])

    def test_every_offered_tag_matches_under_the_matcher_queryset(self):
        tags = self.offered()
        self.assertTrue(tags, "the fixture built two eligible tags on 2+ clips")

        for row in tags:
            with self.subTest(tag=row['tag']):
                matched = len(matcher_queryset(row['tag']))
                self.assertGreaterEqual(
                    matched, 1,
                    f"{row['tag']!r} was offered with zero matching clips — "
                    f"picking it is a guaranteed 400.",
                )
                self.assertEqual(
                    matched, min(row['clips'], MATCHER_BASELINE_LIMIT),
                    f"advertised {row['clips']} clips for {row['tag']!r}, but "
                    f"the matcher's own queryset returns {matched}",
                )

    def test_posting_one_offered_tag_alone_is_never_the_400(self):
        """The end-to-end form of the same promise: the product call succeeds.

        Not redundant with the queryset comparison — that one proves the two
        predicates agree, this one proves the *product* path agrees.
        """
        for row in self.offered():
            with self.subTest(tag=row['tag']):
                r = self.client.post(
                    INITIALIZE_URL, {'selected_tags': [row['tag']]}, format='json',
                )
                self.assertEqual(r.status_code, 200, r.data)
                self.assertEqual(
                    r.data, {'status': 'Algorithm initialized. Feed is ready.'},
                )

    def test_whole_response_is_the_agreed_shape(self):
        """`{"tags": [{"tag": ..., "clips": ...}]}` — an object, so it can grow
        fields later without breaking a client; each row exactly two keys."""
        data = self.client.get(URL).data
        self.assertEqual(set(data), {'tags'})
        self.assertIsInstance(data['tags'], list)
        for row in data['tags']:
            self.assertEqual(set(row), {'tag', 'clips'})
            self.assertIsInstance(row['tag'], str)
            self.assertIsInstance(row['clips'], int)

    def test_only_matchable_tags_are_offered(self):
        offered = self.by_tag(self.offered())
        self.assertEqual(
            offered,
            {'feel': 3, 'listen': 3, 'alone': 2, 'night': 2, 'solo': 2},
        )
        self.assertNotIn('lonely', offered, "'lonely' is on one clip only")

    def test_a_tag_the_matcher_would_reject_is_never_offered(self):
        self.assertNotIn('a-tag-no-clip-has', self.by_tag(self.offered()))


class TestThresholdAndExclusions(TagsAvailableTestBase):
    """Only tags on >= 2 eligible clips, counted over the matcher's own
    population and no other."""

    def test_tag_on_one_clip_is_withheld_and_tag_on_two_is_offered(self):
        self.make('c1', ['lonely'])
        self.make('c2', ['pair'])
        self.make('c3', ['pair'])
        offered = self.by_tag(self.offered())
        self.assertEqual(offered, {'pair': 2})
        self.assertNotIn('lonely', offered)

    def test_unapproved_clips_are_excluded_from_the_counts(self):
        """Both clips of the tag are `moderation_approved=False`, so the tag is
        withheld. Were it counted, a user could pick a tag whose only clips are
        pending moderation — and the matcher's own filter would still exclude
        them."""
        for title in ('pending', 'pending2'):
            AudioClip.objects.create(
                creator=self.user, title=title, category='comedy',
                status='ready', moderation_approved=False,
                duration_ms=10_000, tags=['pending'],
                semantic_vector=[1.0] * 384, acoustic_vector=[1.0] * 128,
            )
        self.make('ok1', ['live'])
        self.make('ok2', ['live'])
        self.assertEqual(self.by_tag(self.offered()), {'live': 2})

    def test_a_null_vector_on_either_column_excludes_the_clip(self):
        """Both of the matcher's vector conditions, one at a time:
        `semantic_vector` is the one an instrumental track with no transcript
        misses, `acoustic_vector` the one a librosa failure misses."""
        AudioClip.objects.create(
            creator=self.user, title='nosem', category='comedy',
            status='ready', moderation_approved=True,
            duration_ms=10_000, tags=['nosem'],
            semantic_vector=None, acoustic_vector=[0.25] * 128,
        )
        AudioClip.objects.create(
            creator=self.user, title='noac', category='comedy',
            status='ready', moderation_approved=True,
            duration_ms=10_000, tags=['noac'],
            semantic_vector=[0.25] * 384, acoustic_vector=None,
        )
        self.make('ok1', ['live'])
        self.make('ok2', ['live'])
        self.assertEqual(self.by_tag(self.offered()), {'live': 2})

    def test_empty_and_whitespace_padded_tags_are_ignored(self):
        """`''` is rejected outright by the matcher. `' jz'` is *unmatchable*:
        the matcher strips the caller's tag before building its containment
        clause, so "jz" cannot containment-match `" jz"` and " jz" is stripped
        before the query. Repeated on two clips so the count threshold alone
        cannot be what hides them."""
        for title in ('e1', 'e2'):
            self.make(title, ['', '   ', ' jz'])
        self.assertEqual(self.by_tag(self.offered()), {},
                         "no tag on this fixture is matchable")

    def test_non_string_elements_are_ignored(self):
        """Grouping is on the jsonb element, so a numeric `5` counts separately
        from the string "5" and is dropped rather than offered as "5" — which
        `tags @> '["5"]'` can never match against a numeric element."""
        for title in ('n1', 'n2'):
            self.make(title, [5, 'live'])
        self.assertEqual(self.by_tag(self.offered()), {'live': 2})

    def test_a_tag_listed_twice_on_one_clip_counts_once(self):
        """Unnesting expands one row into one row per *element*, so a clip whose
        array repeats a tag would be counted twice without a distinct count.
        The matcher matches clips — `tags @> '["live"]'` is true once for that
        row however many copies the array holds — so a plain `COUNT(*)` would
        advertise a number the matcher cannot reproduce."""
        for title in ('d1', 'd2'):
            self.make(title, ['live', 'live'])
        self.assertEqual(self.by_tag(self.offered()), {'live': 2})
        self.assertEqual(
            len(matcher_queryset('live')), 2,
            "the matcher sees two clips, so the offer must say two",
        )

    def test_over_length_tag_is_ignored(self):
        """The matcher 400s on a tag longer than `_MAX_TAG_LENGTH`, so one it
        would refuse must not be offered."""
        from backend.app.views.feed import _MAX_TAG_LENGTH
        long_tag = 'y' * (_MAX_TAG_LENGTH + 1)
        for title in ('l1', 'l2'):
            self.make(title, [long_tag])
        self.make('ok1', ['live'])
        self.make('ok2', ['live'])
        self.assertEqual(self.by_tag(self.offered()), {'live': 2})


class TestShapeAndStability(TagsAvailableTestBase):
    def test_ordering_is_clips_desc_then_tag_asc(self):
        self.make('c1', ['b_two', 'a_two', 'top'])
        self.make('c2', ['b_two', 'a_two', 'top'])
        self.make('c3', ['b_two', 'top'])
        self.make('c4', ['a_two', 'top'])
        self.assertEqual(
            self.offered(),
            [{'tag': 'top', 'clips': 4},
             {'tag': 'a_two', 'clips': 3},
             {'tag': 'b_two', 'clips': 3}],
        )

    def test_ordering_is_stable_across_repeated_calls(self):
        self.make('c1', ['beta', 'alpha', 'top'])
        self.make('c2', ['beta', 'alpha', 'top'])
        self.make('c3', ['beta', 'top'])
        first = self.offered()
        self.assertGreater(len(first), 1)
        for _ in range(3):
            self.assertEqual(self.offered(), first)

    def test_empty_catalogue_returns_an_empty_list_not_an_error(self):
        """Nothing qualifying is a valid answer: 200 + `{"tags": []}`. The client
        renders an honest "not enough audio to personalise yet" state from it.
        Not 404 (nothing is missing), not 400 (the request was fine), and not a
        single consolation tag — a tag on one clip is a row, not a preference."""
        self.make('c1', ['lonely'])
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, {'tags': []})

    def test_no_clips_at_all_returns_an_empty_list(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, {'tags': []})

    def test_cap_is_respected_and_keeps_the_top_of_the_ordering(self):
        from backend.app.views.feed import _MAX_OFFERED_TAGS
        # 15 tags on 3 clips each: all of them qualify, so the cap — not the
        # data — is what bounds the response.
        tags = [f'tag{i:02d}' for i in range(15)]
        for i in range(3):
            self.make(f'c{i}', tags)
        self.assertEqual(
            self.offered(),
            [{'tag': f'tag{i:02d}', 'clips': 3} for i in range(_MAX_OFFERED_TAGS)],
        )

    def test_unauthenticated_is_rejected(self):
        r = APIClient().get(URL)
        self.assertIn(r.status_code, (401, 403), r.data)
        self.assertNotIn('tags', r.data)


class TestThrottleScope(TagsAvailableTestBase):
    """The wiring: each action resolves to its own scope, under method names."""

    @staticmethod
    def scope_for(action):
        view = feed_views.TagsViewSet()
        view.action = action
        return view.throttle_scope

    def test_each_action_resolves_to_its_own_scope(self):
        self.assertEqual(self.scope_for('available_tags'), 'tags_available')
        self.assertEqual(self.scope_for('initialize_vectors'), 'tags_initialize')

    def test_actions_are_keyed_on_the_method_name_not_the_url_path(self):
        """`url_path` is where the handler is *mounted*; DRF's `self.action` is
        the method name. Keying on the former is what silently killed all five
        A4 clip scopes and then all seven ContentViewSet scopes in this
        codebase — twice, in this file family — and it does not raise: the
        scope simply never matches, so the endpoint is left unthrottled while
        looking configured."""
        actions = resolve(URL).func.actions
        # DRF's router also maps HEAD onto a GET action.
        self.assertEqual(set(actions.values()), {'available_tags'}, actions)
        self.assertEqual(actions['get'], 'available_tags')

    def test_scope_names_are_real_rates(self):
        from django.conf import settings as django_settings
        from rest_framework.throttling import ScopedRateThrottle
        rates = django_settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']
        for action in ('available_tags', 'initialize_vectors'):
            scope = self.scope_for(action)
            self.assertIn(scope, rates, f"{scope} has no rate behind it")
            self.assertTrue(rates[scope])
            # The class-level dict the throttle actually reads. It is bound to
            # the settings dict at import time, so a settings edit made later
            # (or by anything that replaces the dict) is invisible here.
            self.assertIn(scope, ScopedRateThrottle.THROTTLE_RATES)
            resolved = _resolve_rate(scope)
            self.assertEqual(resolved, rates[scope])

    def test_a_scope_with_no_rate_would_fail_loudly_not_pass_through(self):
        """Why the assertion above exists: DRF raises
        `ImproperlyConfigured` for an unknown scope, so a typo in a
        `throttle_scope` value 500s the endpoint rather than silently leaving
        it unthrottled. Worth pinning so nobody "fixes" a missing rate by
        assuming it degrades gracefully."""
        from django.core.exceptions import ImproperlyConfigured
        with self.assertRaises(ImproperlyConfigured):
            _resolve_rate('tags_avaliable')

    def test_unknown_action_falls_back_to_the_write_scope(self):
        """Not `tags_available`: an unmapped action here is, by default, one
        that writes user vectors and publishes a Celery task."""
        self.assertEqual(self.scope_for('something_new'), 'tags_initialize')

    def test_initialize_keeps_its_original_400(self):
        """Adding a scope must not change the action's contract:
        `test_tags_initialize_bounds.py:321` pins this body verbatim."""
        self.make('c1', ['lonely'])
        r = self.client.post(
            INITIALIZE_URL, {'selected_tags': ['a-tag-no-clip-has']}, format='json',
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data, {'error': 'Not enough data to build baseline.'})


class TestThrottleEngages(TagsAvailableTestBase):
    """Behavioural proof that the scope is enforced, on an isolated cache.

    The real throttle cache is the shared dev Redis and nothing in the suite
    clears it — conftest's `clear_throttle_cache` FLUSHDBs it, which would take
    a concurrent agent's cache with it (AGENTS.md, 2026-09-30). So
    `SimpleRateThrottle.cache` is patched instead: on the *parent* class (the
    only one that defines `cache`; every throttle in DRF and in
    backend/app/throttling.py inherits it), with `mock.patch.object` so the
    original is restored. An earlier version of this pattern assigned
    `Cls.cache = original` in a `finally`, which installed a shadowing
    attribute on the *subclass* and silently disabled every later fixture that
    patched the parent.
    """

    def setUp(self):
        super().setUp()
        self.make('c1', ['live', 'live'])
        from django.conf import settings as django_settings
        rate = django_settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['tags_available']
        self.num_requests, self.duration = _parse_rate(rate)

    def _spend_budget(self, key, call):
        """`call()` until it is refused; return (allowed, first_refusal).

        The refusal is reported rather than asserted inside the loop so a
        failure message can distinguish "the throttle did not engage" (still
        200 at the end) from "something unrelated broke the request" (a 500 from
        database contention). Those look identical in a bare assertEqual and are
        the two opposite diagnoses.
        """
        from rest_framework.throttling import SimpleRateThrottle
        allowed, refusal = 0, None
        with mock.patch.object(
            SimpleRateThrottle, 'cache', LocMemCache(key, {}),
        ):
            for _ in range(self.num_requests + 1):
                r = call()
                if r.status_code == 200:
                    allowed += 1
                    continue
                refusal = r
                break
        return allowed, refusal

    def test_available_is_denied_once_its_configured_rate_is_spent(self):
        allowed, refusal = self._spend_budget(
            'throttle-tags-available', lambda: self.client.get(URL),
        )
        self.assertEqual(
            allowed, self.num_requests,
            "the configured rate was not enforced (endpoint is unthrottled)",
        )
        self._assert_refusal(refusal)

    def test_initialize_is_denied_once_its_configured_rate_is_spent(self):
        """The write action is the one that matters: unbounded it is a read
        amplifier (one JSONB containment clause per tag, no GIN index on
        `tags`) and a Celery task-fan-out amplifier."""
        from django.conf import settings as django_settings
        rate = django_settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['tags_initialize']
        self.num_requests, _ = _parse_rate(rate)
        allowed, refusal = self._spend_budget(
            'throttle-tags-initialize',
            lambda: self.client.post(
                INITIALIZE_URL, {'selected_tags': ['live']}, format='json',
            ),
        )
        self.assertEqual(allowed, self.num_requests)
        self._assert_refusal(refusal)

    def _assert_refusal(self, refusal):
        self.assertIsNotNone(
            refusal,
            f"no refusal after {self.num_requests} successful requests — the "
            f"scope resolved to no rate, so the throttle allows everything",
        )
        self.assertEqual(
            refusal.status_code, 429,
            f"first refusal was {refusal.status_code}, not 429. If that is a "
            f"5xx it is infrastructure contention, not a throttle defect: "
            f"{getattr(refusal, 'data', None)}",
        )


if __name__ == '__main__':
    unittest.main()