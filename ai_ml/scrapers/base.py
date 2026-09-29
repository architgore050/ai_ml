import re
import time
import logging
from urllib.parse import urlparse
from urllib import robotparser
from xml.etree import ElementTree as ET

import requests
from django.conf import settings

logger = logging.getLogger(__name__)


class RobotsTxtChecker:
    def __init__(self):
        self.parsers = {}

    def allowed(self, url, user_agent=None):
        parsed = urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        rp = self.parsers.get(base)
        if not rp:
            rp = robotparser.RobotFileParser()
            rp.set_url(base + "/robots.txt")
            try:
                rp.read()
            except Exception:
                # If robots.txt cannot be read, default to permissive
                logger.debug("Could not read robots.txt for %s", base)
            self.parsers[base] = rp
        ua = user_agent or getattr(settings, 'SCRAPER_USER_AGENT', '*')
        try:
            return rp.can_fetch(ua, url)
        except Exception:
            return True


class RateLimiter:
    def __init__(self, max_per_min=30):
        self.max_per_min = max_per_min or 30
        self.min_interval = 60.0 / float(self.max_per_min)
        self.last_access = {}

    def wait(self, url):
        host = urlparse(url).netloc
        last = self.last_access.get(host)
        if last:
            elapsed = time.time() - last
            if elapsed < self.min_interval:
                to_sleep = self.min_interval - elapsed
                logger.debug("Sleeping %.2fs to respect rate limit for %s", to_sleep, host)
                time.sleep(to_sleep)
        self.last_access[host] = time.time()


def get_session():
    s = requests.Session()
    ua = getattr(settings, 'SCRAPER_USER_AGENT', None)
    contact = getattr(settings, 'SCRAPER_CONTACT_EMAIL', None)
    if ua:
        header = ua
    else:
        header = f"EchoFlowScraper/1.0 (+{contact or 'contact@example.com'})"
    s.headers.update({'User-Agent': header})
    return s


# ---------------------------------------------------------------------------
# License normalization + family classification
# ---------------------------------------------------------------------------
#
# Different sources describe the same license in wildly different vocabularies:
#   - Openverse:        "by", "by-nc", "by-nc-nd", "cc0"
#   - Internet Archive: licenseurl like "http://creativecommons.org/licenses/by-nc/3.0/"
#   - Freesound:        "CC0", "Attribution", "Attribution NonCommercial"
#   - Pixabay:          "Pixabay License"
#   - BBC SFX:          "RemArc" / "RemArc-NC"
#   - Public Domain:    "pdm", "pd", "public domain"
#
# The old management-command check did substring matching on hardcoded
# `CC0|CC-BY|CC-BY-SA|CC-BY-NC` tokens, which silently dropped most Openverse
# items as "not allowed". This module replaces that with a one-pass
# normalization + family mapping so enforcement is one switch statement.
#
# Adding a new family = one new (input_pattern, family) pair in
# `_FAMILY_PATTERNS`. Adding a new normalization alias = one line in
# `_NORMALIZE_SUBS`.
#
# DECISION: Pure-stdlib regex (no external deps). The patterns are deliberately
# permissive so unknown inputs degrade to "OTHER" rather than throwing.
# HACK: License vocabularies drift over time. The patterns below were captured
# from current API responses (2026-09-07 audit) and may need new aliases
# added as sources evolve.

_NORMALIZE_SUBS = [
    (re.compile(r'\bpublic[\s\-_]*domain\b', re.I), 'PD'),
    (re.compile(r'\bpdm?\b', re.I), 'PD'),
    (re.compile(r'\bpdm\s*old\b', re.I), 'PD-OLD'),
    (re.compile(r'cc0', re.I), 'CC0'),
    # SECURITY: the NC qualifier must SURVIVE normalization.
    #
    # The original single pattern was
    #     attribution(?:\s+noncommercial|\s+nocommercial|\s+nc)?  -> _FREESOUND_LIC
    # and it replaced the whole matched span, so "Attribution NonCommercial"
    # normalized to "_freesound_lic" with the NC marker DISCARDED. The
    # `_freesound_lic` family rule then matched the prefix and returned
    # 'CC-BY' -> license_features() -> (False, False) ->
    # is_noncommercial=False. Freesound NC audio was therefore written to
    # AudioClip with the rights flag unset and served by the commercial feed
    # and by /media/playback-token/, with SCRAPER_ALLOW_NC=False doing
    # nothing to stop it. Measured against the real Freesound vocabulary:
    #   'Attribution'                        -> CC-BY       (correct)
    #   'Attribution NonCommercial'          -> CC-BY       (WRONG, fail-open)
    #   'Attribution NonCommercial NoDerivs' -> CC-BY       (WRONG, fail-open)
    #
    # Two changes, defence in depth:
    #   1. the NC variant is captured into a distinct token, and
    #   2. `normalize_license` has a backstop that rejects any string still
    #      carrying an NC marker that classified as non-NC (see
    #      `_NC_MARKER_RE` / the guard in `normalize_license`).
    # Either alone would fix the known vocabulary; both together mean a new
    # source string cannot fail open the same way by accident.
    (re.compile(r'attribution[\s\-_]*(?:non[\s\-_]*commercial|nocommercial|nc)(?=$|[\s\-_])', re.I), '_freesound_nc'),
    (re.compile(r'attribution', re.I), '_FREESOUND_LIC'),
    (re.compile(r'pixabay', re.I), 'PIXABAY'),
    (re.compile(r'remarc[\s\-_]*nc', re.I), 'REMARC-NC'),
    (re.compile(r'remarc', re.I), 'REMARC'),
]

# SECURITY backstop for the class of bug above. Any post-normalization
# string that still carries a standalone NC / non-commercial marker must not
# be allowed to classify as a commercially-usable family. Matching is
# delimiter-anchored so it cannot fire on unrelated substrings (e.g. the
# "nc" inside "sync", or "SA" inside "usage").
_NC_MARKER_RE = re.compile(
    r'(?:^|[\s\-_])(?:nc|non[\s\-_]*commercial|nocommercial)(?=$|[\s\-_])', re.I
)

# Lowercase patterns matched against the post-normalization string.
# Order matters: more-specific patterns first.
_FAMILY_PATTERNS = [
    # CC0 / Public Domain
    (re.compile(r'\bcc0\b|\bpd\b|\bpdm\b'), 'CC0'),
    # CC-BY-NC-SA
    (re.compile(r'\bcc[ -]?by[ -]?nc[ -]?sa\b|\bby[ -]?nc[ -]?sa\b'), 'CC-BY-NC-SA'),
    # CC-BY-NC-ND
    (re.compile(r'\bcc[ -]?by[ -]?nc[ -]?nd\b|\bby[ -]?nc[ -]?nd\b'), 'CC-BY-NC-ND'),
    # CC-BY-NC
    (re.compile(r'\bcc[ -]?by[ -]?nc\b|\bby[ -]?nc\b'), 'CC-BY-NC'),
    # CC-BY-SA
    (re.compile(r'\bcc[ -]?by[ -]?sa\b|\bby[ -]?sa\b'), 'CC-BY-SA'),
    # SECURITY: bare "remarc" (no -nc) is NOT automatically NC. The previous
    # table mapped both `remarc` and `remarc-nc` to 'REMARC-NC', which is
    # fail-CLOSED and therefore harmless, but it encoded a guess as if it were
    # a fact. RemArc without an explicit -nc is a different licence whose
    # redistribution terms are operator-gated, so it is left as its own family
    # and blocked by the default allow-list.
    (re.compile(r'\bremarc[\s\-_]*nc\b'), 'REMARC-NC'),
    (re.compile(r'\bremarc\b'), 'REMARC'),
    # Freesound custom strings. NC first (longer token), then plain.
    (re.compile(r'\b_freesound_nc\b'), 'CC-BY-NC'),
    (re.compile(r'\b_freesound_lic\b'), 'CC-BY'),
    # CC-BY  (kept last among the CC rules so an NC/SA/ND token wins first)
    (re.compile(r'\bcc[ -]?by\b|\bby\b'), 'CC-BY'),
    # Pixabay
    (re.compile(r'\bpixabay\b'), 'PIXABAY'),
    # PD-OLD (out-of-copyright historical recordings)
    (re.compile(r'\bpd[-_ ]?old\b'), 'PD'),
]


def _normalize_input(raw):
    """Reduce a raw license string to a canonical alphanumeric shape."""
    if not raw:
        return ''
    s = str(raw)
    s = s.replace('\u00a9', '(c)')
    s = s.replace('&', 'and')
    # Extract from IA licenseurl
    m = re.search(r'creativecommons\.org/licenses/([^/"\s]+)', s, re.I)
    if m:
        s = 'cc-' + m.group(1).lower()
    # Strip license version (3.0, 4.0) and stray punctuation
    s = re.sub(r'\b\d+\.\d+\b', '', s)
    # Lowercase BEFORE alias subs (subs handle case-insensitive matches).
    s = s.lower()
    s = re.sub(r'[^a-z0-9 \-]+', ' ', s)
    s = re.sub(r'\s+', '-', s).strip('-')
    # Alias substitutions
    for pat, repl in _NORMALIZE_SUBS:
        s = pat.sub(repl, s)
    # Lowercase again in case any sub produced uppercase output.
    s = s.lower()
    return s


def _family_is_nc(family):
    """Single definition of "is this family non-commercial".

    SECURITY: `license_features` and the `normalize_license` backstop must
    agree on this or the backstop is theatre. Kept as one helper so a new
    NC family cannot be added to one and forgotten in the other.
    """
    if not family:
        return False
    f = str(family).upper()
    return bool(re.search(r'(?:^|[\s\-_])NC(?:$|[\s\-_])', f))


def normalize_license(raw):
    """Return a normalized license token, e.g. 'CC-BY-NC-ND' or 'CC0' or 'UNKNOWN'.

    Used by every connector + the management command. Single source of truth
    for "what license does this string claim to be".
    """
    if raw is None:
        return 'UNKNOWN'
    s = str(raw).strip()
    if not s or s.upper() == 'UNKNOWN':
        return 'UNKNOWN'
    norm = _normalize_input(s)
    if not norm:
        return 'UNKNOWN'
    family = 'OTHER'
    for pat, candidate in _FAMILY_PATTERNS:
        if pat.search(norm):
            family = candidate
            break

    # SECURITY BACKSTOP (fail closed). The Freesound NC vocabulary used to
    # fail open: normalization discarded the "NonCommercial" token and the
    # family rule matched the surviving prefix, so "Attribution
    # NonCommercial" classified as plain 'CC-BY' and
    # `is_noncommercial=False` was written to the DB. That put NC audio in
    # the commercial feed and behind /media/playback-token/, and
    # SCRAPER_ALLOW_NC=False could not stop it because the flag was already
    # False by the time policy was applied.
    #
    # If the string still advertises NC but the family says it is not NC,
    # we do not know which is right — a vocabulary we have no rule for, or a
    # rule that misfired. Guessing either way can serve NC audio
    # commercially, so refuse the item. `license_allows_commercial('UNKNOWN')`
    # is False, so this results in a skip, not a leak.
    if _NC_MARKER_RE.search(norm) and not _family_is_nc(family):
        return 'UNKNOWN'

    if family in ('OTHER', 'UNKNOWN'):
        return family
    return family.upper()


def license_family(raw):
    """Alias for normalize_license(). Kept for readability at call sites."""
    return normalize_license(raw)


def license_features(family):
    """Return (is_noncommercial, requires_share_alike) for a license family.

    Used by uploader.save_clip() to populate AudioClip.is_noncommercial and
    AudioClip.requires_share_alike at import time.
    """
    if not family:
        return False, False
    f = str(family).upper()
    nc = _family_is_nc(f)
    sa = bool(re.search(r'(?:^|[\s\-_])SA(?:$|[\s\-_])', f)) and not re.search(
        r'(?:^|[\s\-_])ND(?:$|[\s\-_])', f
    )
    return nc, sa


def is_noncommercial_license(family):
    nc, _ = license_features(family)
    return nc


def is_share_alike_license(family):
    _, sa = license_features(family)
    return sa


# SECURITY: explicit ALLOW-list of families cleared for commercial use, rather
# than a deny-list. The previous implementation was
#
#     if not family or family in ('OTHER','UNKNOWN'): return False
#     return not license_features(family)[0] or allow_nc
#
# i.e. "anything we recognise that is not NC is commercial", which means a
# family added to `_FAMILY_PATTERNS` is commercially permitted the moment it
# exists, with no second review. That is how bare `RemArc` became
# commercially usable when its rule was corrected — a family we never intended
# to clear, cleared by omission.
#
# Under an allow-list the default for an unrecognised or newly added family is
# refusal, and clearing one is a deliberate edit with a reason.
#
#   CC0 / CC-BY   unconditional
#   CC-BY-SA      commercial use permitted, but the ShareAlike obligation is
#                 carried by `requires_share_alike=True` and enforced by the
#                 feed/entitlements filters — it is a distribution condition,
#                 not a commercial-use prohibition
#   PIXABAY / PD  Pixabay's own licence permits commercial use; PD-old is
#                 out-of-copyright historical material
#   REMARC        NOT listed. The BBC RemArc licence is non-commercial /
#                 personal + educational. It is refused, which is the correct
#                 outcome, but it is refused *deliberately* rather than by
#                 accident of pattern order.
_COMMERCIAL_ALLOW = frozenset({'CC0', 'CC-BY', 'CC-BY-SA', 'PIXABAY', 'PD'})
_COMMERCIAL_ALLOW_WITH_NC = frozenset({'CC-BY-NC', 'CC-BY-NC-SA', 'CC-BY-NC-ND'})
# `allow_nc=True` is an operator policy flag (SCRAPER_ALLOW_NC). It widens NC
# acceptance but must NOT widen anything else — notably not REMARC, which is
# not an NC-flagged CC family and is not cleared for commercial use by any
# policy setting in this codebase.


def license_allows_commercial(family, allow_nc=False):
    """Return True if the license permits commercial use given the policy flag.

    Fail-closed and allow-list based. See `_COMMERCIAL_ALLOW` above for why
    this is not expressed as "not-NC means yes".
    """
    if not family:
        return False
    f = str(family).upper()
    if f in _COMMERCIAL_ALLOW:
        return True
    if f in _COMMERCIAL_ALLOW_WITH_NC:
        return bool(allow_nc)
    return False


# ---------------------------------------------------------------------------
# Generic podcast RSS resolver
# ---------------------------------------------------------------------------
#
# Many podcast sources expose audio via RSS/Atom feeds (Podcast Index returns
# feed URLs; BBC podcasts, NPR, TED audio all expose RSS). This helper parses
# any RSS 2.0 / Atom 1.0 feed and yields episode items with audio enclosures,
# leaving the license field as 'UNKNOWN' since RSS feeds rarely carry license
# metadata. Per-show license review happens at the moderation layer, not the
# feed parser.
#
# DECISION: stdlib ElementTree only — no feedparser dependency.

_PODCAST_AUDIO_MIMES = (
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/ogg',
    'audio/opus', 'audio/wav', 'audio/x-m4a', 'audio/flac', 'audio/webm',
)


def resolve_podcast_rss(feed_url, limit=10, session=None):
    """Parse an RSS / Atom feed and return episode dicts with enclosures.

    Returns list of dicts: {url, title, page_url, license='UNKNOWN', id}.
    License is always 'UNKNOWN' at this layer — RSS feeds do not carry
    per-episode license metadata. Downstream moderation sets
    license_family + the per-clip flags.
    """
    if not feed_url:
        return []
    sess = session or get_session()
    try:
        resp = sess.get(feed_url, timeout=15)
        resp.raise_for_status()
        body = resp.content
    except Exception as e:
        logger.warning('Podcast RSS fetch failed for %s: %s', feed_url, e)
        return []

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        logger.warning('Podcast RSS parse failed for %s: %s', feed_url, e)
        return []

    channel_title = ''
    channel_link = ''
    # RSS 2.0 channel-level metadata
    ch = root.find('channel')
    if ch is not None:
        t = ch.find('title')
        if t is not None and t.text:
            channel_title = t.text.strip()
        l = ch.find('link')
        if l is not None and l.text:
            channel_link = l.text.strip()

    results = []
    # RSS 2.0 items
    items = ch.findall('item') if ch is not None else []
    # Atom entries (root-level if no channel wrapper)
    if not items:
        items = root.findall('{http://www.w3.org/2005/Atom}entry')
    # When the root IS the Atom <feed> element, channel_title/channel_link
    # are on the root itself, not on a nested channel.
    if not channel_title:
        t = root.find('{http://www.w3.org/2005/Atom}title')
        if t is None:
            t = root.find('title')
        if t is not None and t.text:
            channel_title = t.text.strip()
    if not channel_link:
        l = root.find('{http://www.w3.org/2005/Atom}link')
        if l is not None:
            channel_link = (l.text or l.get('href') or '').strip()
    for item in items:
        title_el = item.find('title')
        if title_el is None:
            title_el = item.find('{http://www.w3.org/2005/Atom}title')
        if title_el is None or not title_el.text:
            continue
        title = title_el.text.strip()
        link_el = item.find('link')
        if link_el is None:
            link_el = item.find('{http://www.w3.org/2005/Atom}link')
        page_url = ''
        if link_el is not None:
            page_url = (link_el.text or link_el.get('href') or '').strip()
        if not page_url:
            page_url = channel_link

        enclosure_url = ''
        enclosure_type = ''
        enclosure_length = 0
        enc = item.find('enclosure')
        if enc is None:
            enc = item.find('{http://www.w3.org/2005/Atom}link[@rel="enclosure"]')
        if enc is not None:
            enclosure_url = enc.get('url', '') or enc.get('href', '')
            enclosure_type = (enc.get('type') or '').lower()
            try:
                enclosure_length = int(enc.get('length') or 0)
            except (TypeError, ValueError):
                enclosure_length = 0
        if not enclosure_url:
            # Atom link rel="enclosure"
            for atom_link in item.findall('{http://www.w3.org/2005/Atom}link'):
                rel = atom_link.get('rel') or 'alternate'
                href = atom_link.get('href') or ''
                ltype = (atom_link.get('type') or '').lower()
                if rel == 'enclosure' and href:
                    enclosure_url = href
                    enclosure_type = ltype
                    break
        if not enclosure_url:
            continue
        # Audio check: mime contains 'audio/' OR URL ends in audio extension
        is_audio = 'audio' in enclosure_type
        if not is_audio:
            url_lower = enclosure_url.lower()
            is_audio = any(url_lower.endswith(ext) for ext in (
                '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac', '.webm',
            ))
        if not is_audio:
            continue
        # Build a stable id
        guid_el = item.find('guid')
        ep_id = (guid_el.text or '').strip() if guid_el is not None and guid_el.text else enclosure_url
        results.append({
            'url': enclosure_url,
            'title': f"{channel_title} - {title}" if channel_title else title,
            'page_url': page_url or feed_url,
            'license': 'UNKNOWN',
            'id': ep_id,
            'mime': enclosure_type,
            'size': enclosure_length,
        })
        if len(results) >= limit:
            break

    return results