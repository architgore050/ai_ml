"""Scraper CSV log.

Writes a per-run CSV file with one row per item. Designed to be tailed +
analyzed after the fact. Header is written on open; rows are line-buffered
so a Ctrl-C won't lose the last row.
"""
import csv
import os
from datetime import datetime
from pathlib import Path


_CSV_FIELDS = [
    'timestamp', 'source', 'item_id', 'title', 'url', 'page_url',
    'license_raw', 'license_family', 'is_nc', 'is_sa',
    'status', 'retries', 'duration_sec', 'size_bytes', 'clip_id', 'error',
]


_DEFAULT_LOG_DIRNAME = 'scraper_logs'


def _default_log_dir():
    from django.conf import settings
    base = getattr(settings, 'SCRAPER_SCRATCH_DIR', '/tmp')
    return Path(base) / _DEFAULT_LOG_DIRNAME


def default_log_path(source, log_dir=None):
    """Path for the default log file (one per run).

    Filename: `{source}-{YYYYMMDDHHMMSS}.csv` so multiple runs of the
    same source don't overwrite each other.
    """
    ld = log_dir or _default_log_dir()
    ts = datetime.utcnow().strftime('%Y%m%d%H%M%S')
    return Path(ld) / f"{source}-{ts}.csv"


class ScraperCsvLog:
    """Append-only CSV writer. One instance per management-command run.

    The CSV path is fixed at construction; flush() is line-buffered so a
    Ctrl-C after a row is written preserves the row. close() flushes
    and closes; safe to call multiple times.
    """

    def __init__(self, path, fields=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fields = fields or _CSV_FIELDS
        self._f = open(self.path, 'w', encoding='utf-8', newline='')
        self._w = csv.DictWriter(self._f, fieldnames=self.fields,
                                 extrasaction='ignore')
        self._w.writeheader()
        self._f.flush()

    def write_row(self, **kwargs):
        """Write one row. Missing keys are filled with empty strings.

        A `timestamp` key is auto-filled with the current UTC ISO-8601 time
        if not supplied. `status` is required.
        """
        row = {k: '' for k in self.fields}
        row.update(kwargs)
        if not row.get('timestamp'):
            row['timestamp'] = datetime.utcnow().isoformat() + 'Z'
        # Stringify booleans so they read naturally in Excel / CSV viewers.
        for k in ('is_nc', 'is_sa'):
            v = row.get(k)
            if isinstance(v, bool):
                row[k] = 'true' if v else 'false'
        self._w.writerow(row)
        self._f.flush()

    def close(self):
        if not self._f.closed:
            self._f.flush()
            self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def open_log(source, log_path=None, log_dir=None):
    """Open (or create) a CSV log for the given source.

    If `log_path` is provided, that's used. Otherwise, a new
    timestamped file is created under `log_dir` (or the default scratch dir).
    Returns a ScraperCsvLog.

    Absolute log_path values are used as-is. Relative log_path values
    are resolved against `log_dir` (or the default log dir) so the
    operator can pass a friendly name like `--log=run-2026-09-07.csv`.
    """
    if log_path is None:
        log_path = default_log_path(source, log_dir)
    else:
        p = Path(log_path)
        if not p.is_absolute():
            base = Path(log_dir) if log_dir else _default_log_dir()
            log_path = base / log_path
    return ScraperCsvLog(log_path)
