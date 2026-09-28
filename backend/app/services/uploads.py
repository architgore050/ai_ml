"""Upload service layer.

Stage 2 boundary. The only call here today is `finalize_upload`, which
moves the `transaction.on_commit(process_audio_to_hls.delay(...))` line
out of the view so the view does not own Celery dispatch.

When P1.3 (presigned PUT) lands, this module grows a `get_signed_put_url`
function and the view becomes a thin wrapper.
"""
from __future__ import annotations

from django.db import transaction

from ..models import AudioClip
from ..tasks import process_audio_to_hls
from .task_publisher import publish

def finalize_upload(clip: AudioClip) -> None:
    """Prepare an uploaded clip for moderation (v1 Option A).

    DECISION: This deliberately does NOT enqueue ``process_audio_to_hls``.

    That is not an oversight, and the "fix" is a trap. The task begins with::

        if not clip.moderation_approved:
            timer.set_outcome('skipped')
            return

    and this function's whole job is to ensure ``moderation_approved`` is
    False. So enqueueing here would dispatch a Celery task that wakes up,
    reads the clip, sees the gate, and immediately returns having done
    nothing — burning a worker slot and a `skipped` metric per upload. The
    enqueue has to happen *after* ``run_moderation_check`` approves, which is
    what ``approve-moderation`` does via ``trigger_hls_processing``.

    Tradeoff (unchanged, and real): prohibited content is stored in object
    storage before moderation runs. It is never rendered to users, because
    the feed filters on ``moderation_approved``. A StagingClip row (v1
    Option B) would avoid the storage entirely.

    Removed (2026-09-29, Group C): ``transaction.on_commit(lambda: None)``.
    It was a no-op whose comment claimed it was "kept for future
    extensibility" — it dispatched nothing and preserved nothing, so it only
    suggested a dispatch was happening here.
    """
    # Explicitly set moderation_approved=False (model default, but
    # defensive for any existing rows created without it).
    if clip.moderation_approved:
        clip.moderation_approved = False
        clip.save(update_fields=["moderation_approved"])


def trigger_hls_processing(clip: AudioClip) -> None:
    """Enqueue HLS processing for an approved clip.

    Called by the approve-moderation endpoint after moderation passes.
    """
    # Only process if moderation is approved.
    if not clip.moderation_approved:
        raise ValueError("Cannot trigger HLS processing for unapproved clip.")
    transaction.on_commit(lambda: publish(process_audio_to_hls, str(clip.id)))
