import logging
from django.conf import settings

logger = logging.getLogger(__name__)


def fetch_audio(limit=10):
    """Fetch audio via the Freesound API using `FREESOUND_API_KEY` in settings.

    Returns list of dicts: {'url','title','page_url','id','license'}
    """
    api_key = getattr(settings, 'FREESOUND_API_KEY', None)
    if not api_key:
        logger.warning('Freesound API key not configured; skipping freesound source')
        return []

    # Minimal implementation: query Freesound search endpoint for short audio
    import requests
    SEARCH = 'https://freesound.org/apiv2/search/text/'
    params = {
        'query': 'duration:[0 TO 300]',
        'fields': 'id,name,previews,license,url',
        'page_size': min(limit, 50)
    }
    headers = {'Authorization': f'Token {api_key}'}
    try:
        r = requests.get(SEARCH, params=params, headers=headers, timeout=10)
        r.raise_for_status()
        data = r.json()
        results = []
        for item in data.get('results', [])[:limit]:
            # NOTE: Full-quality downloads require OAuth2 authentication.
            # With a plain API token only preview URLs are accessible, so we
            # use the highest-quality (HQ) preview available and fall back to LQ.
            preview = item.get('previews', {}).get('preview_hq_mp3') or item.get('previews', {}).get('preview_lq_mp3')
            if not preview:
                continue
            results.append({
                'url': preview,
                'title': item.get('name'),
                'page_url': item.get('url'),
                'id': item.get('id'),
                'license': item.get('license')
            })
        return results
    except Exception as e:
        logger.exception('Freesound fetch failed: %s', e)
        return []
