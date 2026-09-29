import logging
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

# Shared session: retries transient network errors (429/5xx) with backoff,
# so a single failed metadata lookup doesn't silently drop an item.
session = requests.Session()
_retries = Retry(
    total=3,
    backoff_factor=1,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=['GET'],
)
session.mount('https://', HTTPAdapter(max_retries=_retries))
session.mount('http://', HTTPAdapter(max_retries=_retries))


SEARCH = 'https://archive.org/advancedsearch.php'
METADATA = 'https://archive.org/metadata/{identifier}'
DOWNLOAD = 'https://archive.org/download/{identifier}/{name}'


def _ia_search_collection(collection, limit=10, license_filter=None,
                          extra_filters=None, fields=None, page=1,
                          sort=None):
    """Run an Internet Archive advancedsearch against one or more collections.

    Args:
        collection: single collection string OR iterable of strings to OR together.
                     Pass None to skip the collection clause (used for plain
                     mediatype:audio queries).
        limit: max results per page (max 10000 in advancedsearch)
        license_filter: optional regex/keyword for licenseurl. None = any.
        extra_filters: list of additional lucene clauses to AND into the query.
        fields: optional list of IA fields to return. Defaults to a sensible set.
        page: 1-indexed page number. Used for resume: when the operator paused
              at fetch_offset=N, the next call uses page=ceil(N/limit)+1 with
              the same sort to get the same N items to skip past.
        sort: optional sort spec (e.g. 'identifier asc' for stable ordering).
              Without a sort, IA returns items by relevance which is unstable
              across calls — pagination would skip or repeat items. Provide a
              stable sort to make resume deterministic.

    Returns:
        list of dicts: {identifier, title, licenseurl, ...}
    """
    clauses = ['mediatype:(audio)']
    if collection is not None:
        if isinstance(collection, (list, tuple, set)):
            col_clause = 'collection:(' + ' OR '.join(collection) + ')'
        else:
            col_clause = f'collection:{collection}'
        clauses.insert(0, col_clause)
    if license_filter:
        clauses.append(f'licenseurl:*{license_filter}*')
    if extra_filters:
        clauses.extend(extra_filters)

    fl = fields or ['identifier', 'title', 'licenseurl', 'creator', 'year']
    params = {
        'q': ' AND '.join(clauses),
        'fl[]': fl,
        'rows': str(limit),
        'page': str(int(page)),
        'output': 'json',
    }
    if sort:
        # advancedsearch uses bracket-wrapped sort params, e.g. sort[0]=identifier
        # and sort[0][dir]=asc. We pass them through as-is.
        sort_field, _, sort_dir = sort.partition(' ')
        params['sort[0]'] = sort_field
        params['sort[0][dir]'] = sort_dir or 'asc'
    try:
        r = session.get(SEARCH, params=params, timeout=30)
        r.raise_for_status()
        return r.json().get('response', {}).get('docs', [])
    except Exception as e:
        logger.exception('IA advancedsearch failed (%s): %s', collection, e)
        return []


def ia_search_raw(query, limit=10, fields=None, page=1, sort=None):
    """Run a raw IA advancedsearch query.

    Used by connectors whose source isn't a single collection (e.g. BBC SFX
    filtered by creator+subject, or C-SPAN filtered by creator). Caller is
    responsible for including mediatype:(audio) and any other filters.

    The optional `page` + `sort` args enable resumable pagination. Without
    a stable sort, the same query returns different items across calls.
    """
    fl = fields or ['identifier', 'title', 'licenseurl', 'creator', 'year']
    params = {
        'q': query,
        'fl[]': fl,
        'rows': str(limit),
        'page': str(int(page)),
        'output': 'json',
    }
    if sort:
        sort_field, _, sort_dir = sort.partition(' ')
        params['sort[0]'] = sort_field
        params['sort[0][dir]'] = sort_dir or 'asc'
    try:
        r = session.get(SEARCH, params=params, timeout=30)
        r.raise_for_status()
        return r.json().get('response', {}).get('docs', [])
    except Exception as e:
        logger.exception('IA advancedsearch raw failed (%s): %s', query[:60], e)
        return []


def _ia_resolve_audio_url(identifier, max_bytes=None):
    """Pick the smallest MP3/WAV/OGG/FLAC inside an IA item.

    Returns (url, size_bytes) or (None, None) when nothing playable is
    found. The optional max_bytes arg, when set, returns the URL only when
    the smallest playable file is within that limit — saves a 100MB
    download just to abort on the size cap.

    The `output=json` flag caps the metadata response to a few KB; the
    default XML metadata document is 100+ MB for items with thousands of
    files (e.g. the BBC SFX mega-collection has 16,000+ audio files).
    """
    try:
        m = session.get(
            METADATA.format(identifier=identifier),
            params={'output': 'json'},
            timeout=20,
        ).json()
    except Exception:
        logger.warning('Metadata fetch failed for %s; skipping item.', identifier)
        return None, None
    candidates = []
    for f in m.get('files', []):
        fmt = (f.get('format') or '').lower()
        name = f.get('name')
        if not name:
            continue
        if any(x in fmt for x in ('mp3', 'vbr mp3', 'wav', 'ogg', 'flac')):
            try:
                size = int(f.get('size') or 0)
            except (TypeError, ValueError):
                size = 0
            candidates.append((name, size))
    if not candidates:
        return None, None
    candidates.sort(key=lambda x: x[1])
    if max_bytes:
        for name, size in candidates:
            if size <= max_bytes:
                return DOWNLOAD.format(identifier=identifier, name=name), size
        return None, None
    name, size = candidates[0]
    return DOWNLOAD.format(identifier=identifier, name=name), size


def fetch_audio(limit=10, page=1, sort='identifier asc'):
    """Search Internet Archive for audio items and return direct file URLs.

    Returns list of dicts: {'url','title','page_url','id','license','licenseurl'}

    `page` + `sort` enable resumable pagination. `sort` defaults to
    `identifier asc` for stable ordering across calls.
    """
    docs = _ia_search_collection(
        collection=None, limit=limit,
        extra_filters=['-collection:test_collection'],
        page=page, sort=sort,
    )
    if not docs:
        params = {
            'q': 'mediatype:(audio)',
            'fl[]': ['identifier', 'title', 'licenseurl', 'creator'],
            'rows': str(limit),
            'page': str(int(page)),
            'sort[0]': sort.split()[0] if sort else 'identifier',
            'sort[0][dir]': (sort.split()[2] if len(sort.split()) > 2
                              else (sort.split()[1] if len(sort.split()) > 1
                                    else 'asc')),
            'output': 'json',
        }
        try:
            r = session.get(SEARCH, params=params, timeout=15)
            r.raise_for_status()
            docs = r.json().get('response', {}).get('docs', [])
        except Exception as e:
            logger.exception('IA search failed: %s', e)
            return []

    results = []
    for d in docs:
        identifier = d.get('identifier')
        if not identifier:
            continue
        title = d.get('title') or identifier
        if isinstance(title, list):
            title = title[0] if title else identifier
        url, _ = _ia_resolve_audio_url(identifier)
        if not url:
            continue
        lic = d.get('licenseurl')
        if isinstance(lic, list):
            lic = lic[0] if lic else None
        results.append({
            'url': url,
            'title': title,
            'page_url': f'https://archive.org/details/{identifier}',
            'id': identifier,
            'license': lic or 'UNKNOWN',
            'licenseurl': lic or '',
        })
    return results