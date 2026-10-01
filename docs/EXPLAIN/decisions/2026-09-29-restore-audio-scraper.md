# Restore the audio scraper, and close a fail-open in its license classifier

**Date:** 2026-09-29
**Status:** Implemented
**Supersedes:** the implicit assumption in `AGENTS.md` that the scraper was
correctly deleted and only needed its imports fixing.

## Why this is not a simple revert

`5c9c2d6 "removed scraper"` did not delete the license helpers. It deleted a
*stripped* 10-file / 407-line copy of the tree whose `base.py` was 63 lines and
never contained them. The real 355-line `base.py` was deleted by `aacd759`,
which **also added `ai_ml/scrapers/` to both `.gitignore` and
`.dockerignore`** in the same commit.

Three consequences that made this look like a missing-imports problem:

1. The copies on disk were stale residue from the *other* removal. They were
   invisible to git (ignored) and shipped in no image (dockerignored), so
   `scrape_audio` could not run in any container even with imports fixed.
2. `scrape_audio.py:44-45` imports `ai_ml.scrapers.state` and `.log` — two
   whole modules (373 + 106 lines) — so restoring only the 6 helpers would
   still `ImportError` on the next line.
3. `tasks.py:990` passes `is_noncommercial=` / `requires_share_alike=` /
   `license_family=` to `uploader.save_clip`, whose stripped signature accepts
   none of them — a `TypeError` even after the imports were satisfied.

Authoritative restore source: `git show aacd759^:ai_ml/scrapers/<file>`.

## The security finding

`normalize_license` is the **only** writer of `AudioClip.is_noncommercial` and
`AudioClip.requires_share_alike`. Those columns are the only input to every
rights gate:

| Gate | Location |
|---|---|
| primary personalised feed | `views/feed.py:115` |
| degraded / trending fallback | `views/feed.py:137` |
| `/suggestions/` | `views/feed.py:173` |
| `is_license_restricted()` | `services/entitlements.py:67` |
| -> playback token issuance | `views/media.py:228` |

They are **not** writable through the API: `AudioUploadSerializer.Meta.fields`
omits them, and no `AudioClip` serializer exposes them. So the upload path
cannot declare itself NC at all, and this classifier is the sole enforcement
point for third-party content.

The restored code failed open on the Freesound licence vocabulary:

```
Attribution                          -> CC-BY   correct
Attribution NonCommercial            -> CC-BY   NC audio served commercially
Attribution NonCommercial NoDerivs   -> CC-BY   NC audio served commercially
```

Cause: `_NORMALIZE_SUBS` mapped
`attribution(?:\s+noncommercial|...)?` -> a single `_FREESOUND_LIC` token,
replacing the **whole matched span** and discarding the NC qualifier. The
`_freesound_lic` family rule then matched the surviving prefix.
`license_features('CC-BY')` -> `(False, False)`.

`SCRAPER_ALLOW_NC=False` could not stop it: the flag was already `False` by the
time policy was applied. The same licence arriving as a
`creativecommons.org/licenses/by-nc/3.0/` URL classified **correctly** — the
defect was specific to the Freesound custom-licence string, which is the one
`freesound.py` actually emits.

Reproduced against the real code before fixing; pinned by
`backend/app/tests/test_scraper_licensing.py`.

## Why this was not currently exploitable

With no writer running, every row in the database has
`is_noncommercial=False, requires_share_alike=False`, so the gate filters
nothing and no NC content exists to leak. **Restoring the helpers flips the
gate from inert to load-bearing — which is exactly why restoring the code
without fixing this would have introduced the leak rather than preserved
safety.**

## What was changed

### 1. NC survives normalization

The NC variant is captured into a distinct token ahead of the plain pattern:

```python
attribution[\s\-_]*(?:non[\s\-_]*commercial|nocommercial|nc)  -> _freesound_nc   # CC-BY-NC
attribution                                                  -> _FREESOUND_LIC    # CC-BY
```

### 2. A fail-closed backstop

If the normalized string still carries a delimiter-anchored NC marker
(`_NC_MARKER_RE`) but the resolved family is not NC, the item is refused
(`UNKNOWN`) rather than guessed. An unmapped vocabulary fails closed instead
of open.

Matching is delimiter-anchored so it cannot fire on unrelated substrings
(`sync`, `cancelled`, `usage`).

### 3. `license_allows_commercial` is an allow-list

It was a deny-list:

```python
if not family or family in ('OTHER', 'UNKNOWN'): return False
return not nc or allow_nc
```

i.e. **"anything recognised that is not NC is commercial"** — so a family
became commercially permitted the moment it was added to `_FAMILY_PATTERNS`,
with no second review.

This was not theoretical. Correcting bare `remarc` to its own family (see
below) immediately made `RemArc` commercially usable, and the new test caught
it. The BBC RemArc licence is non-commercial / personal + educational.

Now:

| Family | Commercial (default) | Commercial (`allow_nc=True`) |
|---|---|---|
| `CC0`, `CC-BY`, `CC-BY-SA`, `PIXABAY`, `PD` | yes | yes |
| `CC-BY-NC`, `CC-BY-NC-SA`, `CC-BY-NC-ND` | **no** | yes |
| `REMARC` | **no** | **no** |
| `OTHER`, `UNKNOWN`, unrecognised | **no** | **no** |

`CC-BY-SA` is cleared for commercial use because ShareAlike is a distribution
condition, not a commercial-use prohibition; the obligation is carried by
`requires_share_alike=True` and enforced by the feed/entitlements filters.

`REMARC` is deliberately absent from both sets. `allow_nc` widens NC
acceptance and nothing else.

### 4. Bare `remarc` no longer claims to be NC

`_FAMILY_PATTERNS` mapped both `remarc` and `remarc-nc` to `REMARC-NC`. That is
fail-*closed* and therefore harmless, but it encoded a guess as fact. Bare
`RemArc` is now its own family — refused, for the correct reason.

### 5. One shared NC predicate

`license_features` used `\bNC\b` plus a special-case `{'REMARC-NC'}` set. The
backstop and the feature extraction must agree or the backstop is theatre, so
both now call one delimiter-anchored `_family_is_nc()`.

## Why the importer is gated off

`SCRAPER_ENABLED` (default `False`) raises at both entry points —
`scrape_audio` (`CommandError`) and `scrape_and_import` (`RuntimeError`).

A rights gate that has already failed open once should not be re-enabled
because the bug is closed. Enabling it is an operator decision made after
re-verifying a source's licensing by hand.

It **raises** rather than warns: an operator who believes an import ran must
not be able to mistake "refused" for "imported", and a partially imported
catalog is worse than none.

The library stays importable, so the classifier's tests keep running while the
importer is off — otherwise the code rots behind a flag and the next enable is
untested.

## Sources wired, and why

Only the four already present on disk: `wikimedia`, `internet_archive`,
`freesound`, `kaggle`.

**`youtube` / `youtube_shorts` are deliberately not wired.**
`downloader.download_audio` dispatches to `_download_youtube` *before*
`_download_once`, so that path never reaches `RobotsTxtChecker`; it resolves a
stream URL via `yt-dlp` and downloads it directly. YouTube's Terms of Service
prohibit automated collection and no robots check runs on that path. The
licence side does fail closed (the connector returns `UNKNOWN`, which
`license_allows_commercial` rejects), so this is a ToS/robots problem rather
than a rights leak — but it requires an explicit operator decision, not a
default.

The other seven connectors are recoverable with one command, documented in
`ai_ml/scrapers/sources/__init__.py`:

```bash
git show aacd759^:ai_ml/scrapers/sources/<name>.py > ai_ml/scrapers/sources/<name>.py
```

### Expected fail-closed behaviour

`wikimedia_commons`, `internet_archive` and `kaggle` do **not** emit a
`license` key, so `item.get('license')` is `None` -> `UNKNOWN` ->
`license_allows_commercial` returns `False` and **every item is skipped**.
`freesound` is the only wired connector that classifies today.

This is the correct default and it is verified by test, but it means those
three sources import nothing until a per-source licence mapping is added. Not
a regression introduced here — it is the pre-existing state of those
connectors.

## Other fixes in this change

- `scrape_audio.py:527` read `settings.MEDIA_ROOT`, removed with the S3
  migration. The resulting `AttributeError` was swallowed by a bare `except`,
  so scratch files were never deleted and accumulated in the container. Now
  keyed on `SCRAPER_SCRATCH_DIR`.
- `SCRAPER_ALLOW_LICENSES` has had no readers since the family map replaced it.
  Left in place (documented as dead) so an existing env file still imports.

## Known gap, not fixed here

`AudioClip.license_type` is client-writable, defaults to `"Unknown"`, and is
read by **no view, service, or gate in the codebase**. An upload declaring
`license_type='Unknown'` — or an NC recording uploaded by a user who never
declares anything — is treated as fully commercially usable. The serializer
only emits `logger.warning` (`serializers.py:245-247`); it does not reject or
flag the row.

This is a live Copyright Act 1957 exposure in the **upload** path, independent
of the scraper, and restoring the scraper neither fixes nor worsens it. Tracked
as separate compliance work; it needs a policy decision (reject `Unknown`?
require `is_noncommercial` on upload? add a moderation queue?) rather than a
mechanical patch.

## Test coverage

`backend/app/tests/test_scraper_licensing.py` — 13 tests, 35 subtests:

- the exact three strings that failed open, each asserted to be NC **and**
  refused under default policy
- plain `Attribution` still permitted (the fix must not over-block)
- canonical CC families and `creativecommons.org` URLs
- unknown / `None` / empty fail closed
- `RemArc` vs `RemArc-NC`
- delimiter anchoring (`SYNC-BY`, `CANCELLED`, `USAGE-BY` must not match)
- backstop does not fire on legitimate permissive licences

## Un-ignoring

`.gitignore` and `.dockerignore` both listed `ai_ml/scrapers` (added by
`aacd759`). Both entries removed — the `.dockerignore` one was duplicated.
Shipping the code is not the same as running it; the runtime gate is
`SCRAPER_ENABLED`.
