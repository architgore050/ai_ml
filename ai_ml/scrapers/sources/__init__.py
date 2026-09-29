"""Source connectors for the scraper.

Each source module should provide a `fetch_audio(limit)` function that returns
an iterable of dicts with keys: `url`, `title`, `page_url`, and optionally
`license` and `id`.

Wiring status
-------------
`68ffbf2` shipped 13 connectors. Only the four below are wired here.

The others are recoverable in one command when their blockers are cleared:

    git show aacd759^:ai_ml/scrapers/sources/<name>.py \\
        > ai_ml/scrapers/sources/<name>.py

Then uncomment the import and the SOURCES entry.

Deliberately NOT wired, with reasons:

* `pixabay`, `podcast_index` — need `SCRAPER_PIXABAY_API_KEY` /
  `SCRAPER_PODCAST_INDEX_API_KEY` + `_API_SECRET`, which are not configured.
* `youtube`, `youtube_shorts` — **do not wire these without a legal
  decision.** `downloader._download_youtube` is dispatched from
  `download_audio` *before* `_download_once`, so it never reaches
  `RobotsTxtChecker`; it resolves a stream URL via `yt-dlp` and downloads
  it directly. YouTube's Terms of Service prohibit automated collection, and
  no robots check is performed on that path. The license side does fail
  closed (the connector returns `UNKNOWN`, which `license_allows_commercial`
  rejects), so this is a ToS/robots problem rather than a rights leak —
  but it needs an explicit operator decision, not a default.
* `openverse`, `librivox`, `free_music_archive`, `podcast_rss`,
  `bbc_sound_effects`, `musopen`, `loc_national_jukebox`, `usgov_audio` —
  dropped in the `5c9c2d6` cleanup and not restored here because each one's
  license vocabulary has to be re-verified against the current API responses
  before it is trusted (see `03-licensing-safety.md`). `resolve_podcast_rss`
  is present in `base.py` for them.

Note the asymmetry that matters: the four wired connectors do NOT all emit a
`license` key. `freesound` does; `wikimedia_commons`, `internet_archive` and
`kaggle` do not, so `item.get('license')` is `None` -> `UNKNOWN` ->
`license_allows_commercial` returns False and every item is skipped. That
is the fail-closed default and it is correct, but it means those three
import nothing until a per-source license mapping is added. Verified by
test, not assumed -- see `test_scraper_licensing.py`.
"""

from . import (
    wikimedia_commons,
    internet_archive,
    freesound,
    kaggle,
)

SOURCES = {
    'wikimedia': wikimedia_commons,
    'internet_archive': internet_archive,
    'freesound': freesound,
    'kaggle': kaggle,
}
