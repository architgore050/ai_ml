"""R5-04 — input bounds on `POST /tags/initialize/` `selected_tags`.

`TagsViewSet.initialize_vectors` (backend/app/views/feed.py) read
`request.data.get('selected_tags', [])` straight off the request body with
no type check, no list bound and no per-element bound, then OR'd one
`Q(tags__contains=[tag])` per element into a Postgres query. Measured on the
unpatched view (13-row `app_audioclip`, this repo's local stack):

    n=   100   ORM build 0.001s   query 0.007s     SQL   5,756 bytes
    n=  1000   ORM build 0.003s   query 0.035s     SQL  48,056 bytes
    n=  5000   ORM build 0.035s   query 0.188s     SQL 240,056 bytes
    n= 50000   ORM build 5.466s   query 2.075s     SQL 2,440,056 bytes

Three distinct consequences, all reachable by one POST from a free account:

1. **Repeatable database stall.** 50 000 tags produce 2.4 MB of SQL and a
   multi-second query. Note the split above: 5.5 s of the 7.5 s is Django
   building the Q-tree *in the request thread*, before Postgres sees
   anything — so the worst case is not the 30 s `statement_timeout` ceiling
   that bounds the SQL half. And `app_audioclip` has **no GIN index on
   `tags`** (verified: `pg_indexes` lists only pkey, status/category/creator
   btrees and the two HNSW vector indexes), so every `@>` clause is a
   sequential-scan containment check per row; cost scales with
   clauses x rows.
2. **Unhandled 500s.** A non-iterable body value (`5`, `1.5`, `True`)
   raises `TypeError: 'int' object is not iterable` inside the view.
3. **Silently wrong, not an error.** A body value of `"abc"` iterates to its
   three characters and a `{"a": "b"}` iterates to its key, so both build
   nonsense-but-valid queries and return a misleading
   "Not enough data to build baseline."

These tests pin the *bounds*, not a particular implementation, and the
first one is the no-regression case: this endpoint is real product
functionality (the 8-vibe cold-start onboarding modal calls it), so it has
to keep working for normal input, not just refuse abuse.
"""
from conftest import assert_view_queries  # noqa: E402  (query budget excl. middleware)
import time
import unittest
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from backend.app.views import feed as feed_views

URL = '/tags/initialize/'

# The view imports `publish` at module level and `initialize_vectors` reads
# that module global, so this is the name to patch (AGENTS.md: never patch a
# module-level name the function does not read). Unpatched, this would fire a
# real Celery apply_async at the broker from every test.
PUBLISH = mock.patch.object(feed_views, 'publish')


class TagsInitializeBoundsTests(TestCase):
    """`selected_tags` validation on POST /tags/initialize/."""

    def setUp(self):
        from backend.app.models import AudioClip

        User = get_user_model()
        self.user = User.objects.create_user(username='tagbounds', password='x')
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        PUBLISH.start()
        self.addCleanup(PUBLISH.stop)

        def make(title, tags, sem, ac):
            return AudioClip.objects.create(
                creator=self.user, title=title, category='comedy',
                status='ready', moderation_approved=True,
                is_noncommercial=False, requires_share_alike=False,
                duration_ms=10_000, tags=tags,
                semantic_vector=sem, acoustic_vector=ac,
            )

        # Exactly representable binary fractions (0.25/0.75 -> mean 0.5) so
        # the mean assertion below is about the averaging, not float32
        # quantisation inside pgvector.
        self.jazz = make('jazz clip', ['jazz', 'piano'], [0.25] * 384, [0.25] * 128)
        self.lofi = make('lofi clip', ['lofi', 'chill'], [0.75] * 384, [0.75] * 128)

    def _post(self, payload):
        return self.client.post(URL, payload, format='json')

    def _assert_error_shape(self, response):
        """Every rejection from this action is a 400 whose body is
        `{"error": ...}` — the shape this action already used for
        "Not enough data to build baseline." A bare `{"detail": ...}` (DRF's
        own exception body) or a per-field `{"selected_tags": {...}}`
        (serializer output) would be a third shape; `frontend/src/api/
        client.ts` tolerates either key, but the file should not mix."""
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('error', response.data, response.data)
        self.assertNotIn('detail', response.data, response.data)

    # --- 1. no-regression: a normal request still works -------------------

    def test_normal_three_tags_still_initialises_and_writes_user_vectors(self):
        """The most important test in this file. The endpoint is product
        functionality, not just an attack surface: 3 ordinary tags must
        return 200 and must still populate the caller's own vectors."""
        self.user.long_term_semantic = None
        self.user.long_term_acoustic = None
        self.user.save(update_fields=['long_term_semantic', 'long_term_acoustic'])

        r = self._post({'selected_tags': ['jazz', 'lofi', 'piano']})

        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data, {'status': 'Algorithm initialized. Feed is ready.'})

        self.user.refresh_from_db()
        self.assertIsNotNone(self.user.long_term_semantic)
        self.assertIsNotNone(self.user.long_term_acoustic)
        self.assertEqual(len(self.user.long_term_semantic), 384)
        self.assertEqual(len(self.user.long_term_acoustic), 128)
        # Mean of [0.25]*384 and [0.75]*384 across the two matching clips.
        for dim in range(384):
            self.assertAlmostEqual(self.user.long_term_semantic[dim], 0.5, places=5)
        for dim in range(128):
            self.assertAlmostEqual(self.user.long_term_acoustic[dim], 0.5, places=5)

    def test_successful_initialisation_enqueues_the_feed_refill(self):
        """A no-regression on the side effect too — bounding the input must
        not silently drop the Celery publish that fills the new user's feed."""
        with mock.patch.object(feed_views, 'publish') as pub:
            r = self._post({'selected_tags': ['jazz']})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(pub.call_count, 1)

    # --- 2/3. list length --------------------------------------------------

    def test_list_at_the_maximum_length_is_accepted(self):
        from backend.app.views.feed import _MAX_SELECTED_TAGS
        self.assertGreaterEqual(_MAX_SELECTED_TAGS, 8, (
            "the current onboarding UI offers 8 vibes "
            "(frontend/src/components/feed/OnboardingModal.tsx:11-20); the "
            "bound must not reject a full selection."
        ))
        tags = ['jazz'] + [f'vibe{i}' for i in range(_MAX_SELECTED_TAGS - 1)]
        r = self._post({'selected_tags': tags})
        self.assertEqual(r.status_code, 200, r.data)

    def test_one_over_the_maximum_is_rejected_and_never_queries(self):
        from backend.app.views.feed import _MAX_SELECTED_TAGS
        tags = ['jazz'] + [f'vibe{i}' for i in range(_MAX_SELECTED_TAGS)]
        self.assertEqual(len(tags), _MAX_SELECTED_TAGS + 1)

        # assertNumQueries(0) is the structural proof: the tag Q-tree was
        # never built, so no AudioClip SELECT was issued. It is deterministic
        # (unlike a wall-clock bound) and it is the property that matters —
        # an over-long list must cost zero database work.
        with assert_view_queries(0):
            r = self._post({'selected_tags': tags})

        self._assert_error_shape(r)
        self.assertIn(str(_MAX_SELECTED_TAGS), r.data['error'])

    # --- 4. the 50 000-tag payload ----------------------------------------

    def test_fifty_thousand_tags_is_rejected_without_stalling(self):
        payload = {'selected_tags': [f'tag{i}' for i in range(50_000)]}

        started = time.monotonic()
        with assert_view_queries(0):
            r = self._post(payload)
        elapsed = time.monotonic() - started

        self._assert_error_shape(r)
        # assertNumQueries(0) already proves the ORM never built 50 000
        # clauses. This wall-clock bound is a non-flaky belt-and-braces check
        # (rejection is pure CPU on an already-parsed 50k-element JSON list,
        # ~ms; the unpatched view took ~7.5 s). 5 s is >50x the green path
        # and below the measured red path.
        self.assertLess(
            elapsed, 5.0,
            f"50k-tag rejection took {elapsed:.2f}s — validation is not "
            f"short-circuiting before the ORM layer.",
        )

    # --- 5. non-list values ------------------------------------------------

    def test_non_list_values_are_rejected_not_crashed(self):
        cases = [
            (5, 'int'),
            (1.5, 'float'),
            (True, 'bool'),
            ('jazz,lofi', 'string — iterates to characters'),
            ({'a': 'jazz'}, 'dict — iterates to keys'),
            (None, 'null'),
        ]
        for value, label in cases:
            with self.subTest(value=label):
                with assert_view_queries(0):
                    r = self._post({'selected_tags': value})
                # The regression is a 500: `for tag in 5` raised
                # TypeError, and "jazz"/{"a": ...} silently built nonsense.
                self._assert_error_shape(r)

    def test_missing_field_is_rejected(self):
        with assert_view_queries(0):
            r = self.client.post(URL, {}, format='json')
        self._assert_error_shape(r)

    # --- 6/7. element bounds ----------------------------------------------

    def test_non_string_element_is_rejected_not_crashed(self):
        for bad in (5, None, {'a': 1}, ['nested'], True):
            with self.subTest(element=repr(bad)):
                with assert_view_queries(0):
                    r = self._post({'selected_tags': ['jazz', bad]})
                self._assert_error_shape(r)

    def test_over_length_single_tag_is_rejected(self):
        from backend.app.views.feed import _MAX_TAG_LENGTH
        with assert_view_queries(0):
            r = self._post({'selected_tags': ['jazz', 'x' * (_MAX_TAG_LENGTH + 1)]})
        self._assert_error_shape(r)
        self.assertIn(str(_MAX_TAG_LENGTH), r.data['error'])

    def test_tag_at_the_element_maximum_length_is_accepted(self):
        """A tag exactly at the bound must not be rejected off-by-one."""
        from backend.app.views.feed import _MAX_TAG_LENGTH
        at_bound = 'y' * _MAX_TAG_LENGTH
        self.assertLessEqual(_MAX_TAG_LENGTH, 64, (
            "tags are KeyBERT unigrams (keyphrase_ngram_range=(1,1), top_n=3 — "
            "tasks.py:284-292), i.e. single words; 64 is already far above "
            "any real keyword and above the longest current vibe id "
            "('instrumental', 12 chars)."
        ))
        # No assertNumQueries(0) here: a tag exactly at the bound is
        # *accepted*, so it legitimately runs the baseline SELECT + the user
        # UPDATE. The point is that it is not rejected off-by-one.
        r = self._post({'selected_tags': ['jazz', at_bound]})
        # 200 (matches the jazz clip) or 400 "not enough data" (the long tag
        # matches nothing) are both fine — what must not happen is a 500 or
        # a length rejection at exactly the bound.
        self.assertIn(r.status_code, (200, 400), r.data)
        if r.status_code == 400:
            self.assertNotIn('the maximum is', r.data['error'])
            self.assertEqual(r.data, {'error': 'Not enough data to build baseline.'})

    def test_whitespace_only_tag_is_rejected(self):
        """Stripped to empty it can never match, so building a clause for it
        is pure waste — and a caller who sends it deserves to be told."""
        with assert_view_queries(0):
            r = self._post({'selected_tags': ['jazz', '   ']})
        self._assert_error_shape(r)

    def test_surrounding_whitespace_is_stripped_rather_than_matching_nothing(self):
        """' jazz ' must behave like 'jazz'. KeyBERT never emits padding, but
        a hand-rolled client can, and without the strip it silently returns
        'Not enough data to build baseline.' — which reads as a backend bug
        to the caller."""
        r = self._post({'selected_tags': ['  jazz  ']})
        self.assertEqual(r.status_code, 200, r.data)

    def test_null_byte_in_tag_is_rejected_not_crashed(self):
        """Separate 500 from the int case: `["ja\\x00zz"]` survives JSON
        parsing, then psycopg raises
        `DataError: unsupported Unicode escape sequence` server-side when it
        tries to inline it as a jsonb literal. Rejecting NUL is the same
        rule CommentSerializer.validate_text already applies
        (serializers.py:540-541)."""
        with assert_view_queries(0):
            r = self._post({'selected_tags': ['jazz', 'ja\x00zz']})
        self._assert_error_shape(r)

    # --- 8/9. empty list and duplicates ------------------------------------

    def test_empty_list_is_rejected_with_a_useful_message(self):
        with assert_view_queries(0):
            r = self._post({'selected_tags': []})
        self._assert_error_shape(r)
        self.assertIn('at least one', r.data['error'])
        self.assertNotIn(
            'Not enough data', r.data['error'],
            "an empty selection is a client error; telling them the backend "
            "lacks data points at the wrong problem.",
        )

    def test_duplicate_tags_are_deduplicated_not_rejected(self):
        """Choice: normalise, do not reject. `Q(a) | Q(a)` is the same
        predicate as `Q(a)`, so de-duplication is lossless *and* strictly
        reduces the OR-clause count — the exact resource the bound exists to
        protect. Rejecting would turn a benign client bug (a double-tap, a
        retried request, a state array that already held the tag) into a
        failed cold-start, and this one-shot onboarding path is where a
        failure costs the user the most."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        payload = {'selected_tags': ['jazz', 'lofi', 'jazz', 'lofi', 'jazz']}
        with CaptureQueriesContext(connection) as ctx:
            r = self._post(payload)
        self.assertEqual(r.status_code, 200, r.data)

        # Assert on the SQL the *view* actually emitted — counting clauses in
        # a Q-tree the test rebuilt itself would only prove the test is right.
        selects = [q['sql'] for q in ctx.captured_queries if 'app_audioclip' in q['sql']]
        self.assertEqual(len(selects), 1, ctx.captured_queries)
        self.assertEqual(
            selects[0].count('@>'), 2,
            f"5 tags sent but {selects[0].count('@>')} containment clauses "
            f"reached Postgres — duplicates were not collapsed.",
        )

    def test_duplicate_only_request_matches_like_a_single_tag(self):
        """De-duplication must not change which rows come back — it is a
        normalisation, not a filter."""
        r = self._post({'selected_tags': ['jazz', 'jazz', 'jazz']})
        self.assertEqual(r.status_code, 200, r.data)
        self.user.refresh_from_db()
        for dim in range(384):
            self.assertAlmostEqual(self.user.long_term_semantic[dim], 0.25, places=5)

    # --- preserved behaviour ----------------------------------------------

    def test_valid_tags_matching_nothing_still_returns_the_original_400(self):
        """The pre-existing 'Not enough data to build baseline.' contract is
        preserved verbatim — bounding the input must not repurpose it."""
        r = self._post({'selected_tags': ['a-tag-no-clip-has']})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data, {'error': 'Not enough data to build baseline.'})

    def test_endpoint_still_requires_authentication(self):
        """Bounding the body must not weaken the auth gate. 401 (not 403):
        DEFAULT_AUTHENTICATION_CLASSES is JWTAuthentication alone, which
        supplies a WWW-Authenticate header, so DRF prefers 401."""
        anon = APIClient()
        for payload in ({'selected_tags': ['jazz']}, {'selected_tags': 'jazz'}, {}):
            with self.subTest(payload=payload):
                self.assertEqual(
                    anon.post(URL, payload).status_code, 401,
                    "POST /tags/initialize/ must stay authenticated.",
                )

    def test_unapproved_clips_are_still_excluded_from_the_baseline(self):
        """Bounds are not a licence to loosen the query: the baseline must
        still only be built from moderation-approved clips with vectors.

        The pending clip carries the 'jazz' tag at 1.0, so if it leaked in the
        mean of {jazz 0.25, lofi 0.75, pending 1.0} would be ~0.667, not 0.5."""
        from backend.app.models import AudioClip
        AudioClip.objects.create(
            creator=self.user, title='pending', category='comedy',
            status='ready', moderation_approved=False,
            duration_ms=10_000, tags=['jazz'],
            semantic_vector=[1.0] * 384, acoustic_vector=[1.0] * 128,
        )
        r = self._post({'selected_tags': ['jazz', 'lofi']})
        self.assertEqual(r.status_code, 200, r.data)
        self.user.refresh_from_db()
        for dim in range(384):
            self.assertAlmostEqual(self.user.long_term_semantic[dim], 0.5, places=5)


if __name__ == '__main__':
    unittest.main()
