"""Scraper license classification — the rights gate for imported audio.

`license_features()` is the ONLY writer of `AudioClip.is_noncommercial` and
`AudioClip.requires_share_alike`. Those two columns are the sole input to
every rights gate in the product:

    views/feed.py:115        primary personalised feed
    views/feed.py:137        degraded/trending fallback
    views/feed.py:173        /suggestions/
    services/entitlements.py:67  is_license_restricted()
      -> views/media.py:228        POST /media/playback-token/{id}/

They are NOT writable through the API (`AudioUploadSerializer.Meta.fields`
does not include them), so this module is the only place a wrong
classification becomes a rights leak. A client upload cannot declare
itself NC; only the scraper can, and only if it classifies correctly.

The regression this file exists for
-----------------------------------
`_NORMALIZE_SUBS` mapped `attribution(?:\s+noncommercial|...)?` -> a single
`_FREESOUND_LIC` token, replacing the whole matched span. That DISCARDED the
"NonCommercial" qualifier, after which the `_freesound_lic` family rule
matched the surviving prefix and returned 'CC-BY'. Result:

    'Attribution NonCommercial' -> CC-BY -> (False, False) -> allowed

i.e. Freesound NC audio was written with `is_noncommercial=False` and served
by the commercial feed and by the playback-token endpoint, and
`SCRAPER_ALLOW_NC=False` had no effect because the flag was already False
when policy was applied. Reproduced before the fix; see the task-list 4.7
entry and `docs/EXPLAIN/scraping/03-licensing-safety.md`.
"""
import unittest

from django.test import SimpleTestCase

from ai_ml.scrapers.base import (
    is_noncommercial_license,
    is_share_alike_license,
    license_allows_commercial,
    license_features,
    normalize_license,
)


class NormalizeLicenseTests(SimpleTestCase):
    def test_freesound_nc_vocabulary_does_not_fail_open(self):
        """THE regression. Each of these was CC-BY (allowed) before."""
        cases = [
            'Attribution NonCommercial',
            'Attribution Noncommercial',
            'Attribution NonCommercial NoDerivs',
            'attribution-nc',
            'Attribution NC',
        ]
        for raw in cases:
            with self.subTest(raw=raw):
                family = normalize_license(raw)
                nc, _ = license_features(family)
                self.assertTrue(
                    nc,
                    f'{raw!r} normalized to {family!r} with is_noncommercial=False — '
                    f'NC audio would be served commercially',
                )
                self.assertFalse(
                    license_allows_commercial(family, allow_nc=False),
                    f'{raw!r} must not be commercially usable under default policy',
                )

    def test_freesound_plain_attribution_is_still_allowed(self):
        """The fix must not over-block the genuinely permissive case."""
        family = normalize_license('Attribution')
        self.assertEqual(family, 'CC-BY')
        nc, sa = license_features(family)
        self.assertFalse(nc)
        self.assertFalse(sa)
        self.assertTrue(license_allows_commercial(family, allow_nc=False))

    def test_canonical_cc_families(self):
        expected = {
            'CC0': (False, False),
            'CC-BY': (False, False),
            'CC-BY-SA': (False, True),
            'CC-BY-NC': (True, False),
            'CC-BY-NC-SA': (True, True),
            'CC-BY-NC-ND': (True, False),  # ND does not imply SA
        }
        for raw, (nc, sa) in expected.items():
            with self.subTest(raw=raw):
                family = normalize_license(raw)
                self.assertEqual(license_features(family), (nc, sa), f'{raw} -> {family}')

    def test_license_urls(self):
        """Internet Archive returns a licenseurl, not a token."""
        cases = {
            'http://creativecommons.org/licenses/by-nc/3.0/': (True, False),
            'http://creativecommons.org/licenses/by-sa/4.0/': (False, True),
            'http://creativecommons.org/licenses/by/4.0/': (False, False),
            'http://creativecommons.org/publicdomain/zero/1.0/': (False, False),
            'https://creativecommons.org/licenses/by-nc-nd/3.0/': (True, False),
        }
        for url, (nc, sa) in cases.items():
            with self.subTest(url=url):
                self.assertEqual(license_features(normalize_license(url)), (nc, sa))

    def test_public_domain_vocabulary(self):
        for raw in ('Public Domain', 'public-domain', 'pdm', 'CC0 1.0', 'cc0'):
            with self.subTest(raw=raw):
                nc, sa = license_features(normalize_license(raw))
                self.assertFalse(nc, raw)
                self.assertFalse(sa, raw)

    def test_unknown_licenses_fail_closed(self):
        """Anything unrecognised must be refused, never assumed permissive.
        This is what makes 3 of the 4 wired connectors import nothing."""
        for raw in ('', None, 'UNKNOWN', 'unknown', '   ', 'Some Custom Thing'):
            with self.subTest(raw=raw):
                family = normalize_license(raw)
                self.assertFalse(
                    license_allows_commercial(family, allow_nc=False),
                    f'{raw!r} -> {family!r} must not be commercially usable',
                )

    def test_remarc_variants(self):
        """`RemArc-NC` is NC. Bare `RemArc` was previously forced to
        'REMARC-NC', which is fail-closed but asserted a guess as fact;
        it is now its own family, also refused by default policy."""
        self.assertEqual(normalize_license('RemArc-NC'), 'REMARC-NC')
        self.assertTrue(is_noncommercial_license('REMARC-NC'))
        self.assertFalse(license_allows_commercial('REMARC-NC', allow_nc=False))
        self.assertEqual(normalize_license('RemArc'), 'REMARC')
        self.assertFalse(license_allows_commercial('REMARC', allow_nc=False))

    def test_share_alike_detection(self):
        self.assertTrue(is_share_alike_license('CC-BY-SA'))
        self.assertTrue(is_share_alike_license('CC-BY-NC-SA'))
        # ND forbids derivatives; it is not a ShareAlike grant.
        self.assertFalse(is_share_alike_license('CC-BY-NC-ND'))


class LicenseFeaturesTests(SimpleTestCase):
    def test_empty_family_is_permissive_but_blocked_by_policy(self):
        """`license_features(None)` is (False, False) so it is not NC, but
        `license_allows_commercial` refuses it. The two together are the
        gate; a caller that only checks the flags would get this wrong."""
        self.assertEqual(license_features(None), (False, False))
        self.assertFalse(license_allows_commercial(None))
        self.assertFalse(license_allows_commercial(''))
        self.assertFalse(license_allows_commercial('OTHER'))

    def test_allow_nc_flag_is_required_for_nc_families(self):
        self.assertFalse(license_allows_commercial('CC-BY-NC', allow_nc=False))
        self.assertTrue(license_allows_commercial('CC-BY-NC', allow_nc=True))
        # ShareAlike is operator-gated independently of NC.
        self.assertTrue(license_allows_commercial('CC-BY-SA', allow_nc=False))

    def test_family_matching_is_delimiter_anchored(self):
        """Regression guard on the helper shared with the backstop: a
        substring match would misread unrelated tokens (e.g. 'sync' for NC,
        'usage' for SA)."""
        self.assertFalse(is_noncommercial_license('SYNC-BY'))
        self.assertFalse(is_noncommercial_license('CANCELLED'))
        self.assertFalse(is_share_alike_license('USAGE-BY'))
        self.assertTrue(is_noncommercial_license('CC-BY-NC'))
        self.assertTrue(is_share_alike_license('CC-BY-SA'))


class NCBackstopTests(SimpleTestCase):
    """The backstop exists so an unmapped NC vocabulary fails closed."""

    def test_unknown_vocabulary_containing_nc_is_refused(self):
        """A brand-new source string that mentions NC but matches no family
        rule must not classify as commercially usable."""
        for raw in ('Acme NonCommercial Standard', 'Corp NC Licence',
                    'House Rules (non-commercial use only)'):
            with self.subTest(raw=raw):
                family = normalize_license(raw)
                self.assertFalse(
                    license_allows_commercial(family, allow_nc=False),
                    f'{raw!r} -> {family!r} leaked through as commercial',
                )

    def test_backstop_does_not_fire_on_legitimate_permissive_strings(self):
        for raw in ('CC-BY', 'CC0', 'Public Domain', 'Pixabay License', 'Attribution'):
            with self.subTest(raw=raw):
                self.assertTrue(
                    license_allows_commercial(normalize_license(raw), allow_nc=False),
                    f'{raw!r} was wrongly refused by the NC backstop',
                )


if __name__ == '__main__':
    unittest.main()
