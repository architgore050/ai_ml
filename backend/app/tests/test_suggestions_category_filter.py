"""`/suggestions/?category=...` filtering semantics.

`AudioClip.category` is a free-text `CharField(max_length=50, blank=True)`
(`models.py:112`) — it has no `choices`, so it is not an enum. That means
`AudioClip.objects.filter(category='all')` is an **exact string match
against the literal string "all"**, which matches zero rows.

`SuggestionViewSet.get_queryset` used to default the param to `'all'` and
pass it straight to the ORM. Both `?category=all` and a bare
`/suggestions/` therefore returned **200 with an empty list** rather than a
400, and a caller could not distinguish "this category does not exist" from
"there is nothing to show". The mobile cold-start fallback calls exactly
`?category=all`, so it silently received nothing and fell through to a
hardcoded single-category default.

The fix treats `all` (and blank) as "do not filter".

These tests assert the *outcome* — which rows come back — rather than only
the status code, because the bug was precisely that a 200 was returned in
both cases and the status code could not detect it.
"""
import unittest

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient


class SuggestionCategoryFilterTests(TestCase):
    def setUp(self):
        from backend.app.models import AudioClip

        User = get_user_model()
        self.user = User.objects.create_user(username='catfilter', password='x')
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)
        self.url = '/suggestions/'

        def make(category, title):
            return AudioClip.objects.create(
                creator=self.user, title=title, category=category,
                status='ready', moderation_approved=True,
                license='CC0', license_family='CC0',
                is_noncommercial=False, requires_share_alike=False,
                duration_ms=10000,
            )

        self.music = make('music', 'a music clip')
        self.funny = make('funny', 'a funny clip')
        self.science = make('science', 'a science clip')

    def _ids(self, qs):
        return {c['id'] for c in qs.data['results']}

    def test_category_all_returns_every_category(self):
        """The regression. `?category=all` must NOT be an exact-match for a
        category literally named "all" — it must mean "unfiltered"."""
        r = self.client.get(self.url, {'category': 'all'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self._ids(r), {str(self.music.id), str(self.funny.id), str(self.science.id)},
        )

    def test_bare_request_defaults_to_unfiltered(self):
        """Omitting the param took the same `'all'` default, so the bare
        endpoint was equally broken."""
        r = self.client.get(self.url)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self._ids(r), {str(self.music.id), str(self.funny.id), str(self.science.id)},
        )

    def test_explicit_category_still_filters(self):
        """The fix must not turn the endpoint into an unfiltered dump."""
        r = self.client.get(self.url, {'category': 'funny'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._ids(r), {str(self.funny.id)})

    def test_unknown_category_returns_empty_not_an_error(self):
        """A real category that has no clips is a legitimate empty page.
        This is the case the client must be able to tell apart from
        "unfiltered but also empty" — the status code alone cannot."""
        r = self.client.get(self.url, {'category': 'no-such-category'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._ids(r), set())

    def test_all_is_case_insensitive_and_trimmed(self):
        for variant in ('ALL', 'All', '  all  '):
            with self.subTest(variant=variant):
                r = self.client.get(self.url, {'category': variant})
                self.assertEqual(r.status_code, 200)
                self.assertEqual(len(r.data['results']), 3, f'{variant!r} did not unfilter')

    def test_license_gate_still_applies_when_unfiltered(self):
        """SECURITY: the `all` branch must not bypass the NC/SA exclusion —
        it widens the category filter, not the rights filter."""
        from backend.app.models import AudioClip

        AudioClip.objects.create(
            creator=self.user, title='NC clip', category='music',
            status='ready', moderation_approved=True,
            license='CC-BY-NC', license_family='CC-BY-NC',
            is_noncommercial=True, requires_share_alike=False,
            duration_ms=10000,
        )
        AudioClip.objects.create(
            creator=self.user, title='SA clip', category='music',
            status='ready', moderation_approved=True,
            license='CC-BY-SA', license_family='CC-BY-SA',
            is_noncommercial=False, requires_share_alike=True,
            duration_ms=10000,
        )
        r = self.client.get(self.url, {'category': 'all'})
        self.assertEqual(r.status_code, 200)
        titles = {c['title'] for c in r.data['results']}
        self.assertNotIn('NC clip', titles)
        self.assertNotIn('SA clip', titles)
        self.assertIn('a music clip', titles)

    def test_unmoderated_and_non_ready_are_excluded(self):
        """The `all` branch must keep the pre-existing status/approval gate
        rather than only relaxing the category."""
        from backend.app.models import AudioClip

        AudioClip.objects.create(
            creator=self.user, title='pending clip', category='music',
            status='processing', moderation_approved=True,
            license='CC0', license_family='CC0',
            is_noncommercial=False, requires_share_alike=False,
        )
        AudioClip.objects.create(
            creator=self.user, title='unmoderated clip', category='music',
            status='ready', moderation_approved=False,
            license='CC0', license_family='CC0',
            is_noncommercial=False, requires_share_alike=False,
        )
        r = self.client.get(self.url, {'category': 'all'})
        titles = {c['title'] for c in r.data['results']}
        self.assertNotIn('pending clip', titles)
        self.assertNotIn('unmoderated clip', titles)


if __name__ == '__main__':
    unittest.main()
