import os
import logging
from django.conf import settings

logger = logging.getLogger(__name__)


def fetch_audio(limit=10):
    """Fetch audio files from a local Kaggle dataset path configured in settings.

    Expects `SCRAPER_KAGGLE_LOCAL_PATH` in settings pointing at a directory containing audio files.
    Returns list of dicts: {'url' (file://), 'title', 'page_url' (file path), 'id'}
    """
    base = getattr(settings, 'SCRAPER_KAGGLE_LOCAL_PATH', None)
    if not base or not os.path.isdir(base):
        logger.warning('Kaggle local path not configured or not a directory; skipping')
        return []

    results = []
    for root, _, files in os.walk(base):
        for fn in files:
            if fn.lower().endswith(('.mp3', '.wav', '.ogg', '.flac', '.aac')):
                path = os.path.join(root, fn)
                results.append({'url': f'file://{path}', 'title': fn, 'page_url': path, 'id': path})
                if len(results) >= limit:
                    return results
    return results
