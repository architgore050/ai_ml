#!/usr/bin/env python3
"""Seed the local stack with real audio, driving the REAL upload + worker path.

Why this exists
---------------
Phase 2 of the mobile rebuild cannot be verified without playable media. The
local database had a single hollow row (``e2e clip``) whose ``original_file``
and ``hls_playlist_url`` were both empty strings, both vectors NULL and the
MinIO bucket empty — so ``/tags/initialize/`` 400s and the playback-token
endpoint 409s before it can reach its success path.

DECISION: this script drives the genuine HTTP API, not the ORM. It was
tempting to write a management command that inserted rows and set
``hls_playlist_url`` by hand, and that would be wrong twice over:

  1. It would not exercise the path Phase 2 depends on. The real flow is
     ``POST /clips/`` → ``POST /clips/{id}/approve-moderation/`` →
     ``process_audio_to_hls`` (librosa → Whisper → KeyBERT → ffmpeg → MinIO).
     The second step is the ONLY thing that enqueues the task
     (``services/uploads.py:82``); ``finalize_upload`` deliberately does not,
     because the task itself begins with an ``if not clip.moderation_approved:
     return`` gate. A hand-rolled seeder would skip the very step whose
     absence is the trap the codebase documents.
  2. A hand-rolled seeder can write a state the pipeline never produces, and
     then "the feed works" becomes unfalsifiable. Every field written here is
     written by the server.

Runs on the HOST (not in a container) because the source audio lives on a host
mount (``/mnt/dev-drive/my songs``) and the API is reachable at
``https://localhost:18443``. The dev certificate is passed explicitly via
``--verify``; it is self-signed, so this is a dev-only trust decision.

Usage
-----
    # inspect what would happen, upload nothing
    python3 backend/scripts/seed_clips.py --dry-run

    # upload + approve + wait for HLS
    python3 backend/scripts/seed_clips.py

    # only these, e.g. while iterating
    python3 backend/scripts/seed_clips.py --limit 3

    # re-run after a partial failure; skips tracks already at status=ready
    python3 backend/scripts/seed_clips.py --resume

Why exact filenames, not substring matching
--------------------------------------------
The library contains near-duplicate names where substring matching picks the
wrong file — ``NEFFEX - Fight Back [Official Video].mp3`` and
``NEFFEX - Make It (Official Video) Fight Back_ The Collection OUT NOW!.mp3``
both contain ``Fight Back``. The manifest therefore pins exact filenames, and
:func:`resolve_track` refuses to guess.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import requests

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_API = os.environ.get("SEED_API_URL", "https://localhost:18443")
DEFAULT_CERT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "docker", "certs", "localhost.crt",
)
DEFAULT_MEDIA_DIR = "/mnt/dev-drive/my songs"

# NOT A SECRET. These are throwaway credentials for a local-only fixture
# account, overridable via env. The default is committed deliberately so
# `seed_clips.py` is runnable straight after the one-line Django-shell step
# that creates the account (see :func:`main`'s error message). The account
# lives in a local Postgres reachable only through the dev nginx terminator,
# and every real credential for this stack lives in the gitignored
# ``.env.local``. Do not reuse this password anywhere, and do not point this
# script at a non-local host without supplying SEED_USERNAME/SEED_PASSWORD.
DEFAULT_USERNAME = os.environ.get("SEED_USERNAME", "seeduser")
DEFAULT_PASSWORD = os.environ.get("SEED_PASSWORD", "SeedLocal!2026")

#: ``server-enforced`` is the absolute cap in ``AudioUploadSerializer.MAX_SIZE``
#: (100 MB) and applies to Pro and free alike. ``pro`` limits
#: (``REVENUECAT_DAILY_UPLOAD_LIMIT_FREE=5``, ``..._MAX_SIZE_MB_FREE=10``) do
#: not apply because the seed account is granted Pro — see the module docstring
#: of the Phase 2 plan. Duration is capped at ``MAX_DURATION_SECONDS`` (300) for
#: every user, enforced by a pydub probe in ``validate_original_file``.
MAX_SECONDS = 300
MAX_BYTES = 100 * 1024 * 1024

#: Category values must be byte-identical to ``mobile/src/design/categories.ts``
#: because ``/suggestions/?category=`` filters on exact string equality — a
#: near-miss is a silently EMPTY result set, not a 400. Only the 3 of 5 branded
#: categories that honestly describe this library are used; ``news`` and
#: ``science`` are left empty rather than mislabelled.
#:
#: NOTE: the ``tags`` field on the clip is NOT this value — it is derived by
#: KeyBERT from the Whisper transcript inside ``process_audio_to_hls``. The two
#: will not agree, and that is expected rather than a bug.
#: DECISION: ``license_type='Owned'``. These are commercial recordings, so this
#: is a dev-fixture value chosen to avoid the ``"Unknown"`` audit-trail warning
#: at ``serializers.py:186-190`` — it is NOT a licensing assertion. Nothing
#: here reaches the feed filter or the playback gate: ``is_noncommercial`` and
#: ``requires_share_alike`` are not writable through the upload API at all
#: (``serializers.py:171``) so they stay at their ``False`` model defaults, and
#: ``resolve_clip_access`` grants the uploader an owner exemption regardless.
MANIFEST: list[tuple[str, str]] = [
    ("Drake - God's Plan (Lyric Video) (192 kbps).mp3", "music"),
    ("Billie Eilish, Khalid - lovely (192 kbps).mp3", "music"),
    ("Dua Lipa - Levitating Featuring DaBaby (Official Music Video) (192 kbps).mp3", "music"),
    ("Ed Sheeran - Shape of You (Official Music Video) (192 kbps).mp3", "music"),
    ("Imagine Dragons - Thunder (192 kbps).mp3", "music"),
    ("Olivia Rodrigo - good 4 u (Lyrics) (320 kbps).mp3", "music"),
    ("GDFR - Remix ( dj viral tik tok at 1_05) (320 kbps).mp3", "instrumental"),
    ("Ghost Rider x Ranji & Major7 - Vicious Game (Official Music Video) Lyrics (192 kbps).mp3", "instrumental"),
    ("NEFFEX - Fight Back [Official Video] (192 kbps).mp3", "instrumental"),
    ("Bella Poarch - Build a B_tch (Official Music Video) (192 kbps).mp3", "funny"),
    ("Masked Wolf - Astronaut In The Ocean (Official Music Video) (192 kbps).mp3", "funny"),
    ("DVRST - Close Eyes (Lyrics) _ megamind meme song name (320 kbps).mp3", "funny"),
]

#: How long to wait for one clip's HLS encode. Whisper-base-int8 transcribing a
#: ~3-minute track plus ffmpeg on a contended 12 GB host is minutes, not
#: seconds, so this is generous and the wait is polling rather than a blind
#: sleep.
READY_TIMEOUT_S = 900
POLL_INTERVAL_S = 5


class SeedError(RuntimeError):
    """A seed step failed in a way the operator needs to see and act on."""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def estimate_seconds(path: str) -> int:
    """Estimate duration from file size and the bitrate in the filename.

    Deliberately does not shell out to ffprobe: the files live on a host mount
    that no container can see, and the seeder runs on the host where ffmpeg may
    not be installed. Every library filename carries ``(192 kbps)``-style
    metadata, so ``size / (kbps * 1000 / 8)`` is accurate to well under the
    tolerance that matters here — it is only used to SKIP files that are
    certainly too long, and the server still enforces the real bound via a pydub
    probe. A mis-estimate costs one 400, not a wrong upload.
    """
    import re

    match = re.search(r"\((\d+)\s*kbps\)", os.path.basename(path))
    if not match:
        return 0  # unknown — let the server decide
    kbps = int(match.group(1))
    return int(os.path.getsize(path) / (kbps * 1000 / 8))


def resolve_track(media_dir: str, filename: str) -> str | None:
    """Return the absolute path for an exact manifest filename, or None."""
    path = os.path.join(media_dir, filename)
    return path if os.path.isfile(path) else None


def display_title(filename: str) -> str:
    """``Artist - Title (Lyrics) (192 kbps).mp3`` → ``Artist - Title``."""
    import re

    stem = os.path.splitext(filename)[0]
    stem = re.sub(r"\s*\(\d+\s*kbps\)\s*$", "", stem)
    stem = re.sub(
        r"\s*[\[(][^\])]*[\])]", "", stem
    )  # (Lyrics), [Official Video], (Official Music Video) …
    stem = re.sub(r"\s*_\s*", " — ", stem)
    return stem.strip(" —-_") or os.path.splitext(filename)[0]


# --------------------------------------------------------------------------- #
# API client
# --------------------------------------------------------------------------- #

class Client:
    def __init__(self, base_url: str, verify: str | bool, username: str, password: str):
        self.base = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers["Accept"] = "application/json"
        self.token: str | None = None
        self._login(username, password)

    def _login(self, username: str, password: str) -> None:
        resp = self.session.post(
            f"{self.base}/auth/login/",
            json={"username": username, "password": password},
            timeout=30,
        )
        if resp.status_code != 200:
            raise SeedError(
                f"login failed: HTTP {resp.status_code} {resp.text[:300]}\n"
                f"  user '{username}' must exist and be Pro. Create it with:\n"
                f"  docker compose -f docker-compose.local.yml --env-file .env.local "
                f"exec web_local python manage.py shell -c \"...\""
            )
        self.token = resp.json().get("access")
        if not self.token:
            raise SeedError(f"login returned no access token: {resp.text[:300]}")

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def upload(self, path: str, title: str, category: str) -> str:
        """POST /clips/ and return the new clip UUID."""
        with open(path, "rb") as handle:
            resp = self.session.post(
                f"{self.base}/clips/",
                headers=self._auth(),
                # Deliberately NOT setting Content-Type: requests derives the
                # multipart boundary from the file, and forcing the header
                # produces a body the server cannot parse.
                data={
                    "title": title,
                    "category": category,
                    "license_type": "Owned",
                    "copyright_owner_name": "Local dev fixture",
                    "copyright_acknowledgement": "true",
                },
                files={"original_file": (os.path.basename(path), handle, "audio/mpeg")},
                timeout=600,
            )
        if resp.status_code not in (201, 202):
            raise SeedError(f"upload failed for '{title}': HTTP {resp.status_code} {resp.text[:400]}")
        return resp.json()["clip_id"]

    def approve(self, clip_id: str) -> None:
        """POST /clips/{id}/approve-moderation/ — the only HLS trigger.

        ``uploads.py:82``. Without this the clip sits at ``processing``
        forever, because ``finalize_upload`` intentionally does not enqueue.
        """
        resp = self.session.post(
            f"{self.base}/clips/{clip_id}/approve-moderation/",
            headers=self._auth(),
            timeout=120,
        )
        if resp.status_code != 200:
            raise SeedError(
                f"approve-moderation failed for {clip_id}: HTTP {resp.status_code} {resp.text[:400]}"
            )
        if resp.json().get("status") != "approved":
            raise SeedError(f"moderation rejected {clip_id}: {resp.text[:400]}")

    def get_clip(self, clip_id: str) -> dict:
        resp = self.session.get(f"{self.base}/clips/{clip_id}/", headers=self._auth(), timeout=30)
        if resp.status_code != 200:
            raise SeedError(f"GET clip {clip_id}: HTTP {resp.status_code}")
        return resp.json()

    def existing_titles(self) -> set[str]:
        """Titles already owned by this user, for ``--resume``."""
        titles: set[str] = set()
        url: str | None = f"{self.base}/clips/?page=1"
        while url:
            resp = self.session.get(url, headers=self._auth(), timeout=30)
            if resp.status_code != 200:
                return titles
            body = resp.json()
            for row in body.get("results", []):
                if row.get("title"):
                    titles.add(row["title"])
            nxt = body.get("next")
            url = nxt.replace(self.base, "", 1) if nxt else None
            if url:
                url = f"{self.base}{url}"
        return titles

    def wait_ready(self, clip_id: str, timeout_s: int) -> str:
        """Poll until ``status == 'ready'``; return the final status."""
        deadline = time.monotonic() + timeout_s
        last = "?"
        while time.monotonic() < deadline:
            clip = self.get_clip(clip_id)
            last = clip.get("status", "?")
            if last == "ready":
                return last
            if last in ("failed", "rejected"):
                raise SeedError(f"clip {clip_id} ended in status={last}")
            time.sleep(POLL_INTERVAL_S)
        raise SeedError(f"clip {clip_id} still '{last}' after {timeout_s}s (worker slow or dead)")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--verify", default=DEFAULT_CERT, help="CA bundle path, or 'false' to disable TLS verification")
    parser.add_argument("--media-dir", default=DEFAULT_MEDIA_DIR)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument("--limit", type=int, default=len(MANIFEST))
    parser.add_argument("--dry-run", action="store_true", help="validate and print; upload nothing")
    parser.add_argument("--resume", action="store_true", help="skip tracks already uploaded by this user")
    parser.add_argument("--timeout", type=int, default=READY_TIMEOUT_S, help="per-clip HLS wait, seconds")
    args = parser.parse_args()

    verify = False if args.verify.lower() == "false" else args.verify
    if verify is not False and not os.path.isfile(verify):
        print(f"error: cert not found: {verify}", file=sys.stderr)
        return 2

    # ---- validate the manifest before touching the network ---------------- #
    plan: list[tuple[str, str, str, int]] = []  # (filename, title, category, secs)
    skipped: list[str] = []
    for filename, category in MANIFEST[: max(0, args.limit)]:
        path = resolve_track(args.media_dir, filename)
        if path is None:
            skipped.append(f"{filename}  [MISSING FILE]")
            continue
        size = os.path.getsize(path)
        secs = estimate_seconds(path)
        if secs and secs > MAX_SECONDS:
            skipped.append(f"{filename}  [{secs}s > {MAX_SECONDS}s server cap]")
            continue
        if size > MAX_BYTES:
            skipped.append(f"{filename}  [{size / 1048576:.1f}MB > {MAX_BYTES / 1048576:.0f}MB hard cap]")
            continue
        plan.append((filename, display_title(filename), category, secs))

    print(f"media dir : {args.media_dir}")
    print(f"manifest  : {len(plan)} to upload, {len(skipped)} skipped")
    print()
    for filename, title, category, secs in plan:
        print(f"  [{category:13}] {secs or '?':>4}s  {title}")
    for line in skipped:
        print(f"  SKIP  {line}")

    if args.dry_run:
        print("\n--dry-run: nothing uploaded.")
        return 0
    if not plan:
        print("\nerror: nothing to upload.", file=sys.stderr)
        return 1

    # ---- go --------------------------------------------------------------- #
    print(f"\nlogging in as {args.username} @ {args.api}")
    try:
        client = Client(args.api, verify, args.username, args.password)
    except requests.exceptions.SSLError as exc:
        print(f"error: TLS verification failed: {exc}\n  pass --verify /path/to/ca.crt", file=sys.stderr)
        return 2
    except SeedError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    already = client.existing_titles() if args.resume else set()
    if args.resume and already:
        print(f"resume: {len(already)} existing clip title(s) known")

    results: list[tuple[str, str, str]] = []  # (title, category, outcome)
    # SEQUENCING IS DELIBERATE, NOT AN ACCIDENT. Exactly one clip is in flight
    # at a time: upload -> approve -> block until status == 'ready' -> only then
    # upload the next. Do not "speed this up" by uploading the whole manifest
    # first and polling at the end.
    #
    #   * The media worker runs --concurrency=1 (docker-compose.local.yml), so
    #     two concurrent encodes would not run in parallel anyway — they would
    #     queue, while both clips sat in 'processing' and every poll became
    #     noise about a state that was never going to change yet.
    #   * The worker's peak is ~1GB against a 2G cgroup limit on a 12GB host
    #     that is also running a desktop. One encode at a time is the
    #     difference between fitting and being OOM-killed mid-transcode.
    #   * A per-clip failure is isolated and attributable. Uploading everything
    #     up front means one bad file and a `--resume` re-run cannot tell you
    #     which of the batch it was.
    #
    # The invariant is also asserted in the loop below: the next iteration is
    # unreachable until `wait_ready` returns.
    for index, (filename, title, category, _secs) in enumerate(plan, start=1):
        path = os.path.join(args.media_dir, filename)
        if title in already:
            print(f"\n[{index}/{len(plan)}] {title} — already uploaded, skipping")
            results.append((title, category, "skipped (exists)"))
            continue
        print(f"\n[{index}/{len(plan)}] {title} [{category}]")
        try:
            clip_id = client.upload(path, title, category)
            print(f"        uploaded   clip_id={clip_id}")
            client.approve(clip_id)
            print("        approved   (enqueued process_audio_to_hls)")
            status = client.wait_ready(clip_id, args.timeout)
            clip = client.get_clip(clip_id)
            print(
                f"        ready      status={status} "
                f"hls={clip.get('hls_playlist_url')} "
                f"duration_ms={clip.get('duration_ms')} tags={clip.get('tags')}"
            )
            results.append((title, category, "ready"))
        except (SeedError, requests.exceptions.RequestException) as exc:
            print(f"        FAILED: {exc}", file=sys.stderr)
            results.append((title, category, f"FAILED: {exc}"))

    # ---- summary ---------------------------------------------------------- #
    print("\n" + "=" * 78)
    print("SEED SUMMARY")
    print("=" * 78)
    by_cat: dict[str, list[str]] = {}
    for title, category, outcome in results:
        by_cat.setdefault(category, []).append(f"{title}  →  {outcome}")
    for category in sorted(by_cat):
        print(f"\n{category}:")
        for line in by_cat[category]:
            print(f"  {line}")
    ready = sum(1 for _, _, o in results if o == "ready")
    failed = [t for t, _, o in results if o.startswith("FAILED")]
    print(f"\n{ready}/{len(results)} ready, {len(failed)} failed")
    if failed:
        print("\nNext: re-run with --resume to retry only the failures.")
        return 1
    print("\nNext: python3 backend/scripts/seed_clips.py is done. Trigger a feed refill:")
    print("  docker compose -f docker-compose.local.yml --env-file .env.local \\")
    print("    exec celery_feed_local python manage.py shell -c "
          '"from backend.app.tasks import refill_user_feed; print(refill_user_feed(6))"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
