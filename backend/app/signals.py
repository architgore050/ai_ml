"""Signal handlers for app models.

N9 fix: when an AudioClip is deleted, remove its files from object
storage. Without this, every user-deletion cascade (creator FK is
on_delete=CASCADE) leaves the original upload and the HLS segment
tree in S3/MinIO forever. Same for explicit DELETE /clips/{id} or
any future admin delete.

S3 prefix to clean on delete:
  uploads/YYYY/MM/DD/<uuid>.<ext>  (the original_file)
  hls/<clip_id>/master.m3u8, seg-N.ts, index.m3u8  (the rendered HLS)

Both are stored in default_storage (S3Storage in production,
FileSystemStorage in dev). The S3 backend supports listdir() and
delete() on keys.
"""
import logging
import os

from django.core.files.storage import default_storage
from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import AudioClip

logger = logging.getLogger(__name__)


@receiver(post_delete, sender=AudioClip)
def cleanup_audioclip_storage(sender, instance, **kwargs):
    """Remove the original upload and the HLS segment tree from object
    storage when the AudioClip is deleted.

    Failure handling: the signal runs in the same transaction as the
    delete. If the S3 delete fails (network, credentials, bucket
    perms), the failure is logged and the function returns — the DB
    row is already deleted, the orphan files are the cost. For a real
    production deployment, a periodic Celery task (cleanup_orphan_hls)
    should scan for hls/<id>/ prefixes whose <id> is not in
    AudioClip.objects.values_list('id', flat=True) and delete them.
    Out of audit scope.
    """
    if instance.original_file:
        try:
            instance.original_file.delete(save=False)
        except Exception as exc:
            logger.warning(
                "post_delete: failed to delete original_file %s for clip %s: %s",
                instance.original_file.name, instance.id, exc,
            )

    # B3 (2026-09-29): cover_image was never deleted. It is a user-supplied
    # image in object storage, so leaving it behind on erasure retains
    # personal data outside the database — and the DB half of a DPDP erasure
    # that claims completeness while the bucket keeps the photo is the worst
    # combination. A user's cover image is personal data whatever the clip
    # was.
    if instance.cover_image:
        try:
            instance.cover_image.delete(save=False)
        except Exception as exc:
            logger.warning(
                "post_delete: failed to delete cover_image %s for clip %s: %s",
                instance.cover_image.name, instance.id, exc,
            )

    # hls_playlist_url looks like "hls/<clip_id>/master.m3u8" (or
    # absent if processing never reached HLS). The whole prefix is
    # ours to clean.
    if instance.hls_playlist_url:
        prefix = instance.hls_playlist_url.rsplit('/', 1)[0]  # drop "master.m3u8"
        try:
            _delete_s3_prefix(prefix)
        except Exception as exc:
            logger.warning(
                "post_delete: failed to delete HLS prefix %s for clip %s: %s",
                prefix, instance.id, exc,
            )


def _delete_s3_prefix(prefix):
    """Delete all S3 objects under a prefix.

    S3Storage's delete() is single-object only; for a prefix we need
    to list + batch-delete. Falls back to single-key delete if the
    storage backend doesn't expose listdir (e.g. some S3-compatible
    backends).
    """
    if not hasattr(default_storage, 'listdir'):
        # Best-effort: try delete on the prefix itself. On a real
        # S3 backend this is a no-op; on a flat filesystem it's a
        # path delete.
        try:
            default_storage.delete(prefix)
        except Exception:
            pass
        return

    try:
        _dirs, files = default_storage.listdir(prefix)
    except Exception as exc:
        logger.warning("listdir(%s) failed: %s", prefix, exc)
        return

    for fname in files:
        key = f"{prefix}/{fname}".replace(os.sep, '/')
        try:
            default_storage.delete(key)
        except Exception as exc:
            logger.warning("delete(%s) failed: %s", key, exc)
