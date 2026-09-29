"""Audio downloader.

`download_audio` is the basic one-shot download. `download_with_retries`
adds an explicit retry loop with a per-attempt counter — used by the
management command's CSV log to record how many times a given item had
to be retried before success or final failure.

`download_youtube` handles YouTube pseudo-URLs (item['url'] starting
with `youtube:video:`). It calls yt-dlp to resolve the actual stream
URL, then downloads via the same retry-aware path.
"""
import os
import tempfile
import logging
import time
from django.conf import settings
from .base import get_session, RateLimiter, RobotsTxtChecker

logger = logging.getLogger(__name__)


class DownloadError(RuntimeError):
    """Download failed after retries. `attempts` = how many tries were made."""

    def __init__(self, message, attempts=1, last_exception=None):
        super().__init__(message)
        self.attempts = attempts
        self.last_exception = last_exception


def _try_import_yt_dlp():
    try:
        import yt_dlp
        return yt_dlp
    except ImportError:
        return None


def _download_once(url, max_bytes, timeout):
    """Single attempt. Raises on any failure."""
    robots = RobotsTxtChecker()
    if not robots.allowed(url):
        raise RuntimeError(f"Blocked by robots.txt: {url}")

    limiter = RateLimiter(getattr(settings, 'SCRAPER_MAX_DOWNLOADS_PER_MIN', 30))
    limiter.wait(url)

    session = get_session()
    resp = session.get(url, stream=True, timeout=timeout)
    resp.raise_for_status()

    content_type = resp.headers.get('Content-Type', '')
    if 'audio' not in content_type and not url.lower().endswith(('.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.webm', '.opus')):
        raise RuntimeError(f"URL does not appear to be audio (Content-Type: {content_type})")

    content_length = resp.headers.get('Content-Length')
    if content_length and int(content_length) > max_bytes:
        raise RuntimeError(f"Remote file too large: {content_length} bytes")

    suffix = os.path.splitext(url)[1] or '.m4a'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    total = 0
    with tmp as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                total += len(chunk)
                if total > max_bytes:
                    tmp_name = tmp.name
                    f.close()
                    os.unlink(tmp_name)
                    raise RuntimeError("Downloaded file exceeds maximum allowed size")
                f.write(chunk)

    return tmp.name, total


def download_audio(url, max_bytes=50_000_000, timeout=30):
    """Download an audio file from `url` to a temporary file.

    For YouTube pseudo-URLs (`youtube:video:<id>`), uses yt-dlp to
    resolve the stream URL first, then downloads via the normal
    retry-aware path. Returns the path to the downloaded file.
    """
    if url.startswith('youtube:video:'):
        return _download_youtube(url, max_bytes, timeout)

    path, _ = _download_once(url, max_bytes, timeout)
    return path


def _download_youtube(pseudo_url, max_bytes, timeout):
    """Resolve a YouTube pseudo-URL via yt-dlp, then download the audio stream.

    Returns the path to the downloaded file. Raises RuntimeError on any failure.
    """
    yt_dlp = _try_import_yt_dlp()
    if yt_dlp is None:
        raise RuntimeError(
            'yt-dlp not installed. Cannot download YouTube content. '
            'Install via the wheelhouse regen script + rebuild the image.')

    vid = pseudo_url[len('youtube:video:'):]
    url = f'https://www.youtube.com/watch?v={vid}'
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'format': 'bestaudio/best',
        'noplaylist': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=False)
        except Exception as e:
            raise RuntimeError(f'yt-dlp extract failed for {vid}: {e}')

    stream_url = info.get('url')
    if not stream_url:
        formats = info.get('formats') or []
        for f in formats:
            if f.get('acodec') and f.get('acodec') != 'none' and f.get('url'):
                stream_url = f['url']
                break
    if not stream_url:
        raise RuntimeError(f'yt-dlp returned no stream URL for {vid}')

    return _download_once(stream_url, max_bytes, timeout)


def download_with_retries(url, max_bytes=50_000_000, timeout=30,
                          max_attempts=3, backoff=2.0):
    """Download with explicit retry loop. Returns (path, attempts, size_bytes).

    Raises DownloadError(attempts=N) after exhausting retries. The
    caller (management command) logs attempts to the CSV so the operator
    can see which items required multiple retries.
    """
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            path, size = _download_once(url, max_bytes, timeout)
            return path, attempt, size
        except Exception as e:
            last_exc = e
            if attempt < max_attempts:
                sleep_for = backoff ** attempt
                logger.warning('download attempt %d/%d failed for %s: %s; '
                               'sleeping %.1fs', attempt, max_attempts,
                               url, e, sleep_for)
                time.sleep(sleep_for)
    raise DownloadError(
        f"Download failed after {max_attempts} attempts: {last_exc}",
        attempts=max_attempts, last_exception=last_exc,
    )
