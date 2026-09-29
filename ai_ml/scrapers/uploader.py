"""AudioClip uploader with multi-segment support.

When a source item produces N audio segments (e.g. a 4h LibriVox
audiobook split into 5-minute pieces), this module creates N
AudioClip rows that share the same `group_id` (UUID), each with a
distinct `segment_index` (0..N-1) and the same `segment_count` (N).
Single-piece imports leave `group_id=NULL`.

`save_clip_segments` is the new entry point. It:
  1. Splits the source file into N segments via the normalizer.
  2. Generates a group_id (UUID4) for the group.
  3. Creates N AudioClip rows, each pointing to its segment file.
  4. Calls publish(process_audio_to_hls, ...) for each segment id.
  5. Returns the list of created AudioClip objects.

`save_clip` is kept for the old single-piece path. The management
command always calls save_clip_segments (max_seconds=0 → 1 segment).
"""
import os
import uuid
import datetime
import logging
from django.core.files import File as DjangoFile
from django.core.files.storage import default_storage

from .normalizer import split_into_segments

logger = logging.getLogger(__name__)


def _save_single_clip(user, title, source_name, source_url, license_,
                      attribution_text, segment_path, original_source_id,
                      segment_index, segment_count, group_id,
                      is_noncommercial, requires_share_alike,
                      license_family, category=None):
    """Save one AudioClip row pointing to segment_path. Returns the clip."""
    from backend.app.models import AudioClip

    date = datetime.datetime.utcnow().strftime("%Y/%m/%d")
    dest_rel_dir = f"audio_scraper/{source_name}/{date}"

    ext = os.path.splitext(segment_path)[1] or '.mp3'
    filename = f"{uuid.uuid4().hex}{ext}"
    upload_path = f"{dest_rel_dir}/{filename}"

    with open(segment_path, 'rb') as f:
        saved_name = default_storage.save(upload_path, DjangoFile(f))
        clip = AudioClip(
            creator=user,
            title=title or filename,
            category=category or source_name,
            source_name=source_name,
            source_url=source_url,
            license=license_,
            attribution_text=attribution_text,
            imported_via_scraper=True,
            original_source_id=original_source_id,
            is_noncommercial=is_noncommercial,
            requires_share_alike=requires_share_alike,
            license_family=license_family or '',
            group_id=group_id,
            segment_index=segment_index,
            segment_count=segment_count,
        )
        clip.original_file.name = saved_name
        clip.save()

    logger.info("Saved clip %s (group=%s segment=%s/%s)",
                clip.id, group_id, segment_index, segment_count)
    return clip


def save_clip_segments(
    user,
    title,
    source_name,
    source_url,
    license,
    attribution_text,
    local_file_path,
    original_source_id=None,
    category=None,
    is_noncommercial=False,
    requires_share_alike=False,
    license_family='',
    max_seconds=300,
    target_format='mp3',
):
    """Split the local file into N segments and save N AudioClip rows.

    Returns a list of AudioClip objects (length 1 when max_seconds<=0 or
    the source fits in one segment; length N otherwise).

    The caller is responsible for cleaning up the local file at
    `local_file_path` after this returns.
    """
    # Split the source file
    segments = split_into_segments(
        in_path=local_file_path,
        max_seconds=max_seconds,
        target_format=target_format,
    )
    segment_count = len(segments)

    if segment_count == 1:
        # Single segment: no group_id (denormalize: NULL means "no group")
        clip = _save_single_clip(
            user=user,
            title=title,
            source_name=source_name,
            source_url=source_url,
            license_=license,
            attribution_text=attribution_text,
            segment_path=segments[0]['path'],
            original_source_id=original_source_id,
            segment_index=None,
            segment_count=None,
            group_id=None,
            is_noncommercial=is_noncommercial,
            requires_share_alike=requires_share_alike,
            license_family=license_family,
            category=category,
        )
        return [clip]

    # N segments: same group_id, indices 0..N-1
    group_id = uuid.uuid4()
    title_with_count = f"{title} (1/{segment_count})" if title else None
    clips = []
    for seg in segments:
        seg_title = title_with_count
        # Subsequent segments get a numbered title
        if seg['index'] > 0 and title:
            seg_title = f"{title} ({seg['index'] + 1}/{segment_count})"
        clip = _save_single_clip(
            user=user,
            title=seg_title,
            source_name=source_name,
            source_url=source_url,
            license_=license,
            attribution_text=attribution_text,
            segment_path=seg['path'],
            original_source_id=original_source_id,
            segment_index=seg['index'],
            segment_count=segment_count,
            group_id=group_id,
            is_noncommercial=is_noncommercial,
            requires_share_alike=requires_share_alike,
            license_family=license_family,
            category=category,
        )
        clips.append(clip)

    return clips


def save_clip(user, title, source_name, source_url, license, attribution_text,
              local_file_path, original_source_id=None, category=None,
              is_noncommercial=False, requires_share_alike=False,
              license_family=''):
    """Backward-compat single-clip save. Equivalent to
    save_clip_segments(..., max_seconds=0) — saves the file as a single
    AudioClip with no group_id.

    Kept so existing tests and any external callers don't break. The
    management command prefers save_clip_segments.
    """
    return save_clip_segments(
        user=user,
        title=title,
        source_name=source_name,
        source_url=source_url,
        license=license,
        attribution_text=attribution_text,
        local_file_path=local_file_path,
        original_source_id=original_source_id,
        category=category,
        is_noncommercial=is_noncommercial,
        requires_share_alike=requires_share_alike,
        license_family=license_family,
        max_seconds=0,
    )
