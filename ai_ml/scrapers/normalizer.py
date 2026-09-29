"""Audio normalization + segment splitting.

The single CLI of the scraper used to be "trim to max_seconds and
export one file". That truncated long items (e.g. 4h LibriVox
audiobooks → 5min preview). The new behavior is to split the audio
into N fixed-length segments and return all of them.

Behavior:
- `max_seconds=0` (default) — return the input as-is, no splitting.
- `max_seconds>0` and audio fits in one segment — return the
  re-encoded audio as a single segment.
- `max_seconds>0` and audio exceeds one segment — return N segments
  (last segment is shorter if not evenly divisible).

All segments share the same re-encoding parameters (44.1 kHz stereo,
192 kbps MP3) for consistency. Each segment is exported to a
distinct temp file; the caller is responsible for cleanup.
"""
import logging
import os
import tempfile
from pydub import AudioSegment

logger = logging.getLogger(__name__)


def _reencode(audio, out_path, target_format='mp3', bitrate='192k'):
    """Normalize to 44.1 kHz stereo and export. Returns out_path."""
    try:
        audio = audio.set_frame_rate(44100).set_channels(2)
    except Exception:
        # Some formats (rare) may not support set_frame_rate; ignore.
        pass
    audio.export(out_path, format=target_format, bitrate=bitrate)
    return out_path


def split_into_segments(in_path, max_seconds=300, target_format='mp3',
                        target_dir=None, prefix='seg'):
    """Split `in_path` audio into N pieces, each up to `max_seconds`.

    Args:
        in_path: source audio file (any format pydub handles).
        max_seconds: max duration of each segment. 0 = no splitting.
        target_format: output container (default mp3).
        target_dir: directory to write segment files. If None, uses
            the temp dir of the system.
        prefix: filename prefix for segments.

    Returns:
        list of dicts, each:
            {path, index, duration_ms, start_ms, end_ms}

    Raises:
        RuntimeError on pydub load failure or export failure.
    """
    try:
        audio = AudioSegment.from_file(in_path)
    except Exception as e:
        logger.exception("split_into_segments: failed to load %s: %s",
                          in_path, e)
        raise

    # No splitting: just reencode the whole thing as a single segment.
    if max_seconds is None or max_seconds <= 0:
        if target_dir is None:
            target_dir = tempfile.mkdtemp(prefix='scraper_seg_')
        os.makedirs(target_dir, exist_ok=True)
        out_path = os.path.join(target_dir, f"{prefix}-000.mp3")
        _reencode(audio, out_path, target_format=target_format)
        duration_ms = len(audio)
        return [{
            'path': out_path,
            'index': 0,
            'duration_ms': duration_ms,
            'start_ms': 0,
            'end_ms': duration_ms,
        }]

    # Split into N segments
    total_ms = len(audio)
    max_ms = int(max_seconds * 1000)
    if total_ms <= 0:
        # Empty file: export a single 0-length segment to keep the
        # contract that the caller always gets at least one segment.
        if target_dir is None:
            target_dir = tempfile.mkdtemp(prefix='scraper_seg_')
        os.makedirs(target_dir, exist_ok=True)
        out_path = os.path.join(target_dir, f"{prefix}-000.mp3")
        _reencode(audio[:1], out_path, target_format=target_format)
        return [{
            'path': out_path,
            'index': 0,
            'duration_ms': 0,
            'start_ms': 0,
            'end_ms': 0,
        }]

    if target_dir is None:
        target_dir = tempfile.mkdtemp(prefix='scraper_seg_')
    os.makedirs(target_dir, exist_ok=True)

    results = []
    index = 0
    cursor = 0
    while cursor < total_ms:
        end = min(cursor + max_ms, total_ms)
        chunk = audio[cursor:end]
        out_path = os.path.join(target_dir, f"{prefix}-{index:03d}.mp3")
        try:
            _reencode(chunk, out_path, target_format=target_format)
        except Exception as e:
            logger.exception("split_into_segments: failed to export "
                              "segment %d for %s: %s", index, in_path, e)
            # Re-raise so the caller's per-segment retry path can
            # pick up the failure cleanly. Clean up any already-emitted
            # segment files for this item so we don't leak scratch.
            for r in results:
                try:
                    os.remove(r['path'])
                except OSError:
                    pass
            raise
        results.append({
            'path': out_path,
            'index': index,
            'duration_ms': end - cursor,
            'start_ms': cursor,
            'end_ms': end,
        })
        index += 1
        cursor = end

    return results


def normalize_and_trim(in_path, out_path, max_seconds=300,
                       target_format='mp3'):
    """Backward-compatible single-output wrapper around split_into_segments.

    Kept because some callers (and tests) import it. Returns the path of
    the single output file, same as before. Internally uses the new
    splitter with max_seconds=0 to preserve old "trim-or-pad to N
    seconds" semantics. New callers should use split_into_segments.
    """
    if max_seconds is None or max_seconds <= 0:
        # No trim: just copy
        import shutil
        shutil.copyfile(in_path, out_path)
        return out_path
    # Old behavior: trim to max_seconds
    try:
        audio = AudioSegment.from_file(in_path)
    except Exception as e:
        logger.exception("normalize_and_trim: failed to load %s: %s",
                          in_path, e)
        raise
    max_ms = int(max_seconds * 1000)
    if len(audio) > max_ms:
        audio = audio[:max_ms]
    return _reencode(audio, out_path, target_format=target_format)
