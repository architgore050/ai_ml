"""Read-only triage for the telemetry dead-letter queue and the stream PEL.

WHY THIS EXISTS
---------------
``flush_telemetry_stream`` routes anything it cannot turn into a
``UserInteraction`` row to ``stream:interaction.events:dlq`` and XACKs it off
the main stream, so the pipeline never stalls. Before this command that DLQ
was write-only: nothing in the repo ever read it, so a tick that dumped 500
accounts' telemetry into it was indistinguishable from a healthy one.

The same is true of the PEL. ``docs/EXPLAIN/redis-celery/01-redis-usage.md``
lists ``XPENDING stream:interaction.events cg:telemetry-flush < 1,000`` as a
critical metric, but no application code called XPENDING — the alert had
nothing to scrape. This command reports it so the threshold is wireable.

It reports only. There is deliberately no replay flag: whether DLQ'd
telemetry is trustworthy enough to re-apply is a product decision, and
guessing at it from a shell is how duplicate watch-time accounting happens.
The DLQ records the *source* stream entry id, and XACK leaves the payload in
the main stream until the 50k maxlen trims it, so a human can still
recover one by hand with ``XRANGE stream:interaction.events <id> <id>``.

Usage::

    python manage.py inspect_telemetry_dlq                 # human summary
    python manage.py inspect_telemetry_dlq --limit 20      # show 20 newest
    python manage.py inspect_telemetry_dlq --json          # machine readable
    python manage.py inspect_telemetry_dlq --check         # exit 1 if unhealthy
"""

import json

import redis
from django.conf import settings
from django.core.management.base import BaseCommand

# Mirrors the "Critical Metrics" table in
# docs/EXPLAIN/redis-celery/01-redis-usage.md. Kept as a module constant so
# the number quoted by an alert and the number a human reads cannot drift.
PENDING_THRESHOLD = 1000
STREAM_MAXLEN = 50_000


class Command(BaseCommand):
    help = (
        "Report the telemetry DLQ depth, its newest entries, and the stream's "
        "pending-entry (PEL) depth. Read-only: nothing is replayed or trimmed."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--limit', type=int, default=20,
            help='How many of the newest DLQ entries to list (default: 20). '
                 'Does not affect the reported depth.',
        )
        parser.add_argument(
            '--json', action='store_true', dest='as_json',
            help='Emit a single JSON object instead of a text summary.',
        )
        parser.add_argument(
            '--check', action='store_true',
            help='Exit 0 when healthy, 1 when any alert threshold is breached. '
                 'Designed for a cron/Prometheus textfile probe.',
        )

    def handle(self, *args, **options):
        from backend.app.services.interactions import CONSUMER_GROUP, STREAM_KEY
        from backend.app.tasks import TELEMETRY_DLQ_KEY

        client = self._client()
        try:
            report = self._collect(client, STREAM_KEY, CONSUMER_GROUP, TELEMETRY_DLQ_KEY, options['limit'])
        finally:
            try:
                client.close()
            except Exception:
                pass

        if options['as_json']:
            self.stdout.write(json.dumps(report, indent=2, sort_keys=True))
        else:
            self.stdout.write(self._render(report))

        if options['check']:
            # SystemExit, not CommandError: a non-zero exit code is the whole
            # point of --check, and CommandError exits 1 with a traceback on
            # stderr, which reads as a crash rather than a threshold breach.
            raise SystemExit(0 if report['ok'] else 1)

    # -- helpers --------------------------------------------------------

    def _client(self):
        # Own client rather than ``cache.client.get_client()``: this one needs
        # ``decode_responses`` so the entry ids and field values come back as
        # text, and django_redis's pooled client is not configured for that.
        # (The same missing flag in the consumer is what made every stream
        # payload look empty — see flush_telemetry_stream.)
        return redis.from_url(
            settings.CACHES['default']['LOCATION'],
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )

    def _collect(self, client, stream_key, group, dlq_key, limit):
        depth = int(client.xlen(dlq_key))
        stream_length = int(client.xlen(stream_key))
        pending = 0
        pending_by_consumer = []
        try:
            summary = client.xpending(stream_key, group)
            pending = int(summary.get('pending') or 0)
            pending_by_consumer = [
                {'name': c.get('name'), 'pending': int(c.get('pending') or 0)}
                for c in (summary.get('consumers') or [])
            ]
        except redis.exceptions.ResponseError as exc:
            # NOGROUP on a virgin Redis, or a stream that has been trimmed
            # away entirely. Neither is an error condition for a triage tool:
            # zero pending is the honest answer.
            self.stderr.write(f"XPENDING unavailable ({exc}); reporting pending=0.")

        entries = [
            {
                'id': entry_id,
                'original_id': fields.get('original_id', ''),
                'reason': fields.get('reason', ''),
            }
            # Newest first: when something is going wrong the interesting
            # entry is the one that just got there.
            for entry_id, fields in (client.xrevrange(dlq_key, count=max(limit, 0)) or [])
        ]

        legacy_depth = int(client.llen('telemetry:queue'))

        return {
            'dlq_depth': depth,
            'pending': pending,
            'pending_threshold': PENDING_THRESHOLD,
            'pending_by_consumer': pending_by_consumer,
            'stream_length': stream_length,
            'stream_maxlen': STREAM_MAXLEN,
            'legacy_queue_depth': legacy_depth,
            'entries': entries,
            # Mirrors the doc's healthy bounds: DLQ 0, PEL under 1,000, legacy
            # list empty. The stream length is reported for context but is not
            # a pass/fail here — it has its own 50k-sustained-5min alert.
            'ok': depth == 0 and pending < PENDING_THRESHOLD and legacy_depth == 0,
        }

    def _render(self, report) -> str:
        verdict = 'OK' if report['ok'] else 'ATTENTION'
        lines = [
            f"telemetry pipeline: {verdict}",
            f"  DLQ depth            : {report['dlq_depth']}"
            f"   (healthy: 0)",
            f"  stream pending (PEL) : {report['pending']}"
            f"   (healthy: < {report['pending_threshold']})",
            f"  stream length        : {report['stream_length']}"
            f"   (maxlen: {report['stream_maxlen']})",
            f"  legacy queue depth   : {report['legacy_queue_depth']}"
            f"   (healthy: 0)",
        ]
        if report['pending_by_consumer']:
            lines.append('  pending by consumer:')
            for row in report['pending_by_consumer']:
                lines.append(f"    {row['name']}: {row['pending']}")
        if report['entries']:
            lines.append(f"  newest {len(report['entries'])} DLQ entries "
                         f"(original stream id -> reason):")
            for entry in report['entries']:
                lines.append(f"    {entry['original_id'] or '?':>24}  "
                             f"{entry['reason'] or '(no reason recorded)'}")
        else:
            lines.append('  DLQ is empty.')
        if not report['ok']:
            lines.append(
                '  NOTE: nothing is replayed automatically. Recover an entry by '
                'hand with XRANGE stream:interaction.events <original_id> '
                '<original_id> while it is still under maxlen.'
            )
        return '\n'.join(lines)
