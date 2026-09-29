"""Scraper state persistence.

Saves a per-source state file under SCRAPER_SCRATCH_DIR/scraper_state/ so
the management command can resume after Ctrl-C. The state file is written
after every item (atomic write-temp + rename), so an interrupted run
loses at most the current item — every previously-processed item is
accounted for.

A separate CSV log (scraper_log.py) records per-item outcomes.

State schema (per source):
  {
    "source": "librivox",
    "started_at": "2026-09-07T...",
    "last_updated": "...",
    "params": {...},                     # CLI params for resume-mismatch check
    "fetch_offset": 5,                    # IA pagination cursor
    "fetched_ids": ["47", "52", ...],     # all source items seen (capped)
    "items": {                            # per-source-item state
      "<item_id>": {
        "title": "...",
        "url": "...",
        "fetched_at": "...",
        "total_segments": 5,
        "segment_status": {                # 0-based segment_index -> status
          "0": "imported",
          "1": "imported",
          "2": "failed_download",
          "3": "skipped_license",
          "4": "pending"
        }
      }
    },
    "counts": {
      "fetched": 0,
      "imported": 0,
      "skipped": 0,
      "failed": 0,
      "segments_imported": 0,
      "segments_failed": 0,
      "retried": 0
    }
  }
"""
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path


_DEFAULT_STATE_DIRNAME = 'scraper_state'
_FETCHED_IDS_CAP = 10000  # keep the last N IDs to avoid unbounded growth


def _default_state_dir():
    from django.conf import settings
    base = getattr(settings, 'SCRAPER_SCRATCH_DIR', '/tmp')
    return Path(base) / _DEFAULT_STATE_DIRNAME


def state_path(source, state_dir=None):
    """Return the absolute path to the state file for a given source."""
    sd = state_dir or _default_state_dir()
    return Path(sd) / f"{source}.json"


def load_state(source, state_dir=None):
    """Load a state file. Returns an empty state dict if the file is missing.

    A missing state file is normal (first run, or after --reset). A corrupt
    state file is treated as missing — we log and continue.
    """
    path = state_path(source, state_dir)
    if not path.exists():
        return _empty_state(source)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        import logging
        logging.getLogger(__name__).warning(
            'Corrupt state file at %s (%s); treating as fresh run', path, e)
        return _empty_state(source)
    # Backward-compat: older states may not have the per-segment
    # `items` dict, the `segments_imported` count, or the legacy
    # `processed_ids`/`skipped`/`failed` lists. Promote them so
    # callers can use the same accessors.
    if 'items' not in data:
        data['items'] = {}
    if 'processed_ids' not in data:
        data['processed_ids'] = []
    if 'skipped' not in data:
        data['skipped'] = []
    if 'failed' not in data:
        data['failed'] = []
    if 'counts' not in data:
        data['counts'] = {}
    if 'segments_imported' not in data['counts']:
        data['counts']['segments_imported'] = 0
    if 'segments_failed' not in data['counts']:
        data['counts']['segments_failed'] = 0
    return data


def save_state(source, state, state_dir=None):
    """Atomically write the state file.

    Atomic = write to a temp file in the same directory, fsync, rename.
    The rename is atomic on POSIX, so a concurrent reader either sees the
    old state or the new state — never partial.
    """
    path = state_path(source, state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f'.{source}.', suffix='.json.tmp', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def reset_state(source, state_dir=None):
    """Delete the state file. Returns True if a file was removed."""
    path = state_path(source, state_dir)
    if path.exists():
        path.unlink()
        return True
    return False


def _empty_state(source):
    return {
        'source': source,
        'started_at': None,
        'last_updated': None,
        'params': {},
        'fetch_offset': 0,
        'fetched_ids': [],
        'items': {},  # per-item segment tracking
        # Legacy single-clip tracking lists. Kept so the deprecated
        # mark_imported/mark_skipped/mark_failed accessors (and the
        # corresponding tests) continue to work. New code uses the
        # per-segment workflow via items[].segment_status.
        'processed_ids': [],
        'skipped': [],
        'failed': [],
        'counts': {
            'fetched': 0,
            'imported': 0,
            'skipped': 0,
            'failed': 0,
            'segments_imported': 0,
            'segments_failed': 0,
            'retried': 0,
        },
    }


def params_match(state_params, run_params):
    """Return True if a saved run's params match the current run's params.

    Different params (e.g. --allow-nc on a previous run) should not be
    silently resumed — the operator should re-run with --reset or
    accept that some items will be reprocessed.

    An empty `state_params` is a "first run" / "post-reset" state and
    always matches (the run is treated as fresh).

    Match rule: the saved state must contain every key the current run
    cares about, with the same value. Extra keys in the state are
    tolerated (e.g. from a run with a different --clip-length). A run
    param with value None is treated as "not set" and skipped.
    """
    if not state_params:
        return True
    for k, v in run_params.items():
        if v is None:
            continue
        if k not in state_params or state_params[k] != v:
            return False
    return True


def update_state_for_resume(state):
    """Mutate state in place to reflect resume: bump last_updated."""
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'


# --- Legacy single-clip accessors (kept for compatibility / callers that
#     don't care about per-segment tracking) -----------------------

def mark_fetched(state, item_id):
    """Record that an item was fetched from the upstream."""
    state['fetch_offset'] += 1
    if item_id not in state['fetched_ids']:
        state['fetched_ids'].append(item_id)
    if len(state['fetched_ids']) > _FETCHED_IDS_CAP:
        state['fetched_ids'] = state['fetched_ids'][-_FETCHED_IDS_CAP:]
    state['counts']['fetched'] += 1
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'


def mark_imported(state, item_id):
    """Legacy: record an item as a single-segment import.

    Kept so callers / tests that predate the per-segment workflow
    continue to work. Maps to a single-segment imported status on the
    new state.items[item_id] record.
    """
    # Bump imported count and processed_ids list directly; do NOT
    # call mark_segment (which would re-bump the segments_imported
    # counter — this is the legacy path that predates segment
    # tracking).
    ensure_item(state, item_id, total_segments=1)
    state['items'][item_id].setdefault('segment_status', {})
    state['items'][item_id]['segment_status']['0'] = 'imported'
    state['processed_ids'].append(item_id)
    state['counts']['imported'] += 1
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'


def mark_skipped(state, item_id, reason):
    """Legacy: record an item as a single-segment skip."""
    ensure_item(state, item_id, total_segments=1)
    state['items'][item_id].setdefault('segment_status', {})
    state['items'][item_id]['segment_status']['0'] = 'skipped_license'
    state['skipped'].append({'id': item_id, 'reason': reason})
    state['counts']['skipped'] += 1
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'


def mark_failed(state, item_id, error, retries=0):
    """Legacy: record an item as a single-segment failure."""
    ensure_item(state, item_id, total_segments=1)
    state['items'][item_id].setdefault('segment_status', {})
    state['items'][item_id]['segment_status']['0'] = 'failed_other'
    state['items'][item_id]['last_error'] = str(error)[:500]
    state['failed'].append({
        'id': item_id, 'error': str(error)[:500], 'retries': retries,
    })
    state['counts']['failed'] += 1
    if retries:
        state['counts']['retried'] += retries
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'


# --- Per-segment accessors (new workflow) -------------------------

def ensure_item(state, item_id, total_segments=1, title='', url=''):
    """Get or create the per-item state record."""
    items = state.setdefault('items', {})
    if item_id not in items:
        items[item_id] = {
            'title': title,
            'url': url,
            'fetched_at': datetime.utcnow().isoformat() + 'Z',
            'total_segments': total_segments,
            'segment_status': {},
        }
    else:
        # Update title/url if we now have better info
        if title and not items[item_id].get('title'):
            items[item_id]['title'] = title
        if url and not items[item_id].get('url'):
            items[item_id]['url'] = url
        if total_segments and not items[item_id].get('total_segments'):
            items[item_id]['total_segments'] = total_segments
    return items[item_id]


def mark_segment(state, item_id, segment_index, status, error=None,
                 retries=0):
    """Record the outcome for one segment.

    status: 'imported' | 'skipped_license' | 'failed_download' |
            'failed_other' | 'pending'
    """
    item = ensure_item(state, item_id)
    item.setdefault('segment_status', {})
    item['segment_status'][str(segment_index)] = status
    state['last_updated'] = datetime.utcnow().isoformat() + 'Z'

    if status == 'imported':
        state['counts']['segments_imported'] += 1
    elif status == 'skipped_license':
        pass  # not counted as imported or failed
    elif status.startswith('failed'):
        state['counts']['segments_failed'] += 1
        if retries:
            state['counts']['retried'] += retries
        if error:
            # Record error on the item's last-failed-segment
            item['last_error'] = str(error)[:500]


def item_done(state, item_id):
    """Return True if every segment of this item has reached a terminal state."""
    item = state.get('items', {}).get(item_id)
    if not item:
        return False
    total = item.get('total_segments', 1)
    seg_status = item.get('segment_status', {})
    # All segments 0..total-1 must have a status
    for i in range(total):
        if str(i) not in seg_status:
            return False
    # All done. Aggregate the per-item counts.
    state['counts']['imported'] += 1 if all(
        seg_status.get(str(i)) == 'imported' for i in range(total)
    ) else 0
    return True


def item_has_failures(state, item_id):
    """Return True if any segment of this item is in a failed state."""
    item = state.get('items', {}).get(item_id)
    if not item:
        return False
    seg_status = item.get('segment_status', {})
    return any(s.startswith('failed') for s in seg_status.values())


def item_segments_to_process(state, item_id):
    """Return the list of segment indices that still need to be processed
    (no status yet, or in a failed state for retry)."""
    item = state.get('items', {}).get(item_id)
    if not item:
        return list(range(0))
    total = item.get('total_segments', 1)
    seg_status = item.get('segment_status', {})
    to_do = []
    for i in range(total):
        s = seg_status.get(str(i))
        if s is None or s.startswith('failed'):
            to_do.append(i)
    return to_do


# --- Bulk accessors for analysis ------------------------------------

def items_already_handled(state):
    """Return the set of item IDs that are fully done AND had no failures.

    An item is "fully done" when:
      - every segment has reached a terminal status
      - no segment is in a `failed_*` state (so the resume doesn't re-process)

    Used by the management command to decide whether to skip an item
    on resume. Items that had any segment failure stay out of this set
    so the resume re-fetches them and retries the failed segments.
    """
    done = set()
    for item_id, item in state.get('items', {}).items():
        seg_status = item.get('segment_status', {})
        if not seg_status:
            continue
        total = item.get('total_segments', 1)
        if len(seg_status) < total:
            continue
        # All segments decided. Check no failures.
        if any(s.startswith('failed') for s in seg_status.values()):
            continue
        done.add(item_id)
    return done
