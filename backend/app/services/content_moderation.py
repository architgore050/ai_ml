import hashlib
import logging
import re
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

# 1. Use Regex for Word Boundary Matching to prevent false positives
# DECISION (2026-09-29, B2a): the previous list was 7 single common words —
# "violence", "terrorism", "extremist", "obscenity", "hate speech", "csam",
# "child sexual" — matched with \b boundaries against raw Whisper output and
# against KeyBERT unigram tags. Verified false positives before changing it:
#
#   "a song about violence in the city"           -> REJECTED
#   "terrorism was the topic of the podcast today"  -> REJECTED
#   "he called it an extremist policy"             -> REJECTED
#
# On an audio-clip platform, the word "violence" in a lyric or a news
# monologue is ordinary content, not prohibited content. The old list made
# the pipeline actively harmful: it rejected legitimate uploads, and a user
# who hit that got a permanent rejection with no appeal path.
#
# The entries below are all multi-word CSAM-specific constructions, which is
# the category where a bare keyword match is defensible: there is no benign
# conversational use of "child sexual abuse material" that a user would
# upload to a music app. "csam" alone is kept because it is a rare
# self-describing acronym in this context, but it is the one entry here that
# could plausibly false-positive, and it is called out in the test.
#
# TODO: this is a v1 keyword list, not a moderation system. A real
# deployment needs a classifier (or the external API the audit proposed)
# plus a human review queue, because a keyword list cannot distinguish
# discussion of a topic from the topic itself.
_BLOCKED_PHRASES = [
    "child sexual abuse material",
    "child sexual abuse",
    "child pornography",
    "csam",
]
# Pre-compile the regex pattern for fast execution across workers
_BLOCKED_PATTERN = re.compile(r'\b(' + '|'.join(re.escape(p) for p in _BLOCKED_PHRASES) + r')\b', re.IGNORECASE)

# Note: In a multi-worker Celery architecture, this set must be populated 
# strictly via code commits before boot. Runtime modifications will not sync.
_FINGERPRINT_BLOCKLIST: set[str] = {
    # "a1b2c3d4..."
}

def check_transcript_for_prohibited_content(transcript_text: Optional[str]) -> Tuple[bool, Optional[str]]:
    if not transcript_text:
        return True, None
    
    match = _BLOCKED_PATTERN.search(transcript_text)
    if match:
        reason = f"Blocked phrase detected: '{match.group(1)}' (category: prohibited content)"
        logger.warning("Moderation rejected transcript: %s", reason)
        return False, reason
        
    return True, None

def check_tags_for_prohibited_content(tags: Optional[list]) -> Tuple[bool, Optional[str]]:
    if not tags:
        return True, None
        
    for tag in tags:
        match = _BLOCKED_PATTERN.search(str(tag))
        if match:
            reason = f"Blocked phrase detected in tag '{tag}': '{match.group(1)}'"
            logger.warning("Moderation rejected tag: %s", reason)
            return False, reason
            
    return True, None

def compute_audio_fingerprint(django_file) -> str:
    """
    Computes SHA256 abstractly via Django's File API. 
    This works universally for local disks and remote MinIO/S3 buckets.
    """
    h = hashlib.sha256()
    try:
        # Open the file via the storage backend (streams from S3 if necessary)
        django_file.open("rb")
        # .chunks() prevents loading massive files entirely into RAM
        for chunk in django_file.chunks(chunk_size=8192):
            h.update(chunk)
    except Exception as exc:
        logger.error("Fingerprint computation failed: %s", exc)
        return ""
    finally:
        django_file.close()
        
    return h.hexdigest()

def check_fingerprint_blocklist(fingerprint: str) -> Tuple[bool, Optional[str]]:
    """Check a computed fingerprint against the known-bad set.

    DECISION (2026-09-29, B2a): an empty fingerprint is treated as
    **inconclusive, not as a rejection**.

    It previously returned ``(False, "Fingerprint computation failed")``.
    That conflated "we could not read the object" with "this object is
    prohibited", and the consequences were bad: a transient MinIO blip or an
    S3 timeout during a moderator's approve-moderation call set
    ``moderation_approved=False`` permanently, with no path back (the only
    caller writes the flag and there is no un-approve route). An
    infrastructure error silently became a moderation decision against the
    user's own upload.

    So: fail open on the *fingerprint* check specifically, log loudly, and let
    the transcript and tag checks — which need no storage access — carry the
    decision. This is a deliberate availability-over-strictness trade, and it
    is safe only because the fingerprint blocklist is currently empty, so the
    check can reject nothing anyway. If that set is ever populated, the
    caller must treat a missing fingerprint as a hard error instead. The
    test pins that: see test_fingerprint_failure_is_not_a_rejection.
    """
    if not fingerprint:
        logger.error(
            "Fingerprint unavailable; treating as inconclusive and NOT "
            "rejecting. An object-storage read failure must not be recorded "
            "as a moderation decision."
        )
        return True, None

    if fingerprint in _FINGERPRINT_BLOCKLIST:
        reason = f"Audio fingerprint blocked: {fingerprint}"
        logger.warning("Moderation rejected fingerprint: %s", reason)
        return False, reason

    return True, None

def run_moderation_check(clip_id) -> Tuple[bool, Optional[str]]:
    """
    Runs full moderation check.
    Consolidates the DB save to prevent multiple writes.
    """
    from ..models import AudioClip
    
    try:
        clip = AudioClip.objects.get(id=clip_id)
    except AudioClip.DoesNotExist:
        return False, f"Clip {clip_id} not found"

    approved = True
    reason = None

    # 1. Fingerprint check (Using the abstract File object). Now fail-open on
    #    an unreadable object — see check_fingerprint_blocklist.
    if clip.original_file:
        fingerprint = compute_audio_fingerprint(clip.original_file)
        approved, reason = check_fingerprint_blocklist(fingerprint)

    # 2. Tags check (Only run if previous checks passed)
    if approved:
        approved, reason = check_tags_for_prohibited_content(clip.tags)

    # 3. Transcript check
    if approved:
        # SEC-FIX (2026-09-29, B2a): was an *indirect* check, so it read
        # None. This function is called from approve-moderation, which runs
        # BEFORE process_audio_to_hls has transcribed anything — the
        # transcript exists only as a local variable inside that task and is
        # never persisted. So this branch could not reject anything, ever.
        # The transcript check that actually does something is the inline one
        # at tasks.py:303, which runs with the in-scope value.
        #
        # Left as a genuine check rather than deleted because a
        # transcript_text column is the obvious fix (tracked as B2b), and
        # this is where it would be read. Until then it is dead, and
        # test_transcript_is_not_persisted_so_this_check_cannot_fire says so
        # explicitly so nobody mistakes it for coverage.
        transcript_text = getattr(clip, "transcript_text", None)
        approved, reason = check_transcript_for_prohibited_content(transcript_text)

    # Single DB update transaction
    clip.moderation_approved = approved
    clip.save(update_fields=["moderation_approved"])

    return approved, reason

