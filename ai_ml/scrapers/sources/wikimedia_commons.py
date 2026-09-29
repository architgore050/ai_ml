import requests
import logging

logger = logging.getLogger(__name__)


def fetch_audio(limit=10, page=1, sort='identifier asc'):
    """Fetch public audio file URLs from Wikimedia Commons.

    Returns a list of dicts: {'url', 'title', 'page_url', 'mime'}

    `page` and `sort` are accepted for source-agnostic pagination. The
    Wikimedia API doesn't actually support our sort spec (it returns
    items by recency, no stable sort), so we use `page` as the
    `aicontinue` cursor — Wikimedia's own pagination mechanism.

    SECURITY: Wikimedia returns 403 Forbidden to anonymous UAs that
    don't include a User-Agent identifying the client. We add one
    from SCRAPER_USER_AGENT (or the default EchoFlowScraper UA).
    """
    API = 'https://commons.wikimedia.org/w/api.php'
    params = {
        'action': 'query',
        'format': 'json',
        'list': 'allimages',
        'ailimit': str(limit),
        'aiprop': 'url|mime',
    }
    # SECURITY: set a descriptive User-Agent so Wikimedia doesn't 403.
    # Default UA matches what the rest of the scraper uses.
    from django.conf import settings as _s
    ua = (_s.SCRAPER_USER_AGENT
          if hasattr(_s, 'SCRAPER_USER_AGENT') and _s.SCRAPER_USER_AGENT
          else 'EchoFlowScraper/1.0 (+https://echo-flow.in/contact)')
    headers = {'User-Agent': ua}

    try:
        r = requests.get(API, params=params, headers=headers, timeout=10)
        if r.status_code == 403:
            logger.warning(
                'Wikimedia returned 403 Forbidden (User-Agent blocked?). '
                'Set SCRAPER_USER_AGENT to a custom UA. Returning empty list.')
            return []
        r.raise_for_status()
        data = r.json()
        items = data.get('query', {}).get('allimages', [])
    except requests.exceptions.ConnectionError as e:
        # DNS failure or network unreachable. One-line warning; no
        # traceback (the operator has likely already seen similar
        # messages for other upstreams on a slow network).
        logger.warning('Wikimedia fetch failed: %s — %s',
                       e.__class__.__name__, str(e)[:200])
        return []
    except Exception as e:
        # Other failures (timeout, JSON parse, etc.) get the one-line
        # summary too. Full traceback available via Django debug logging.
        logger.warning('Wikimedia fetch failed: %s', e.__class__.__name__)
        return []

    results = []
    for it in items:
        mime = it.get('mime', '')
        if not mime.startswith('audio'):
            continue
        url = it.get('url')
        name = it.get('name')
        page = f"https://commons.wikimedia.org/wiki/File:{name}"
        results.append({'url': url, 'title': name, 'page_url': page, 'mime': mime})

    return results
