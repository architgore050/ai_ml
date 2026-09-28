"""Tests for backend.app.services.content_moderation (B2a).

Three distinct problems are covered here, and it is worth being explicit that
only the first is what "B2a" originally meant:

1. **The blocklist's content.** The list is not empty, and that turned out to
   be worse than empty. It held 7 single common words matched against raw
   Whisper output and KeyBERT unigram tags, so "a song about violence in the
   city" was rejected. The list itself was the bug.

2. **A storage failure was recorded as a moderation decision.**
   ``check_fingerprint_blocklist("")`` returned a rejection, so a MinIO blip
   during approve-moderation set ``moderation_approved=False`` permanently
   with no path back.

3. **The transcript check inside ``run_moderation_check`` cannot fire.** It
   reads ``getattr(clip, "transcript_text", None)`` on a model that has no
   such column, so it is always None. That check is only reachable before
   ``process_audio_to_hls`` has transcribed anything, and the transcript is
   never persisted. The check that does real work is the inline one in the
   task. Pinned here so nobody mistakes it for coverage.

A note on why the "csam" entry is still here despite being a bare
acronym: see ``test_csam_is_the_one_entry_that_can_false_positive``.
"""
import pytest

from backend.app.services import content_moderation as mod

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# 1. The list's content
# ---------------------------------------------------------------------------

class TestBlockedPhraseListContent:
    def test_ordinary_speech_is_not_rejected(self):
        """Regression tests for the false positives that motivated B2a.

        Each of these returned ``(False, reason)`` under the old list. On a
        music/audio-clip platform these are ordinary uploads, and the user
        got a permanent rejection with no appeal.
        """
        benign = [
            "a song about violence in the city",
            "the storm arrived with extreme violence",
            "terrorism was the topic of the podcast today",
            "he called it an extremist policy",
            "the documentary discussed hate speech and its history",
            "obscenity law is a fascinating legal topic",
        ]
        for text in benign:
            approved, reason = mod.check_transcript_for_prohibited_content(text)
            assert approved is True, f"{text!r} was rejected: {reason}"

    def test_lyric_fragments_are_not_rejected(self):
        """KeyBERT extracts unigrams, so a single lyric word becomes a tag.
        The tag check shares the pattern, so it had the same false
        positives."""
        for tag in ["violence", "terrorism", "extremist", "obscenity"]:
            approved, reason = mod.check_tags_for_prohibited_content([tag])
            assert approved is True, f"tag {tag!r} was rejected: {reason}"

    def test_benign_tags_pass(self):
        for tag in ["instrumental", "rain", "acoustic", "lofi", "guitar"]:
            approved, _ = mod.check_tags_for_prohibited_content([tag])
            assert approved is True

    def test_the_pipeline_still_rejects_real_csam_references(self):
        """The point of the list. A multi-word CSAM construction must be
        caught — this is the category where a keyword match is defensible
        because there is no benign conversational use."""
        prohibited = [
            "this file contains child sexual abuse material",
            "labeled as child pornography",
            "it is csam",
        ]
        for text in prohibited:
            approved, reason = mod.check_transcript_for_prohibited_content(text)
            assert approved is False, f"{text!r} was NOT rejected"
            assert reason and "Blocked phrase" in reason

    def test_the_prohibited_tag_is_rejected(self):
        approved, reason = mod.check_tags_for_prohibited_content(
            ["child sexual abuse material"]
        )
        assert approved is False
        assert "child sexual abuse material" in reason

    def test_csam_is_the_one_entry_that_can_false_positive(self):
        """Documented honestly rather than hidden.

        "csam" is a bare acronym, so a user *could* legitimately discuss it
        — a video about a CSAM news story, say. It is kept because the
        self-describing acronym is rare in audio-clip uploads and because
        dropping it would remove the most compact form of the term. But it is
        the weakest entry in the list and the obvious next one to drop if
        false positives are observed in production. Calling it out is the
        point: the old list had seven such entries and nobody flagged any of
        them.
        """
        # A user discussing CSAM as a news topic is currently rejected.
        approved, _ = mod.check_transcript_for_prohibited_content(
            "a news report about csam legislation in india"
        )
        assert approved is False, (
            "if this is no longer desirable, remove 'csam' from "
            "_BLOCKED_PHRASES — this test exists so the trade-off stays visible"
        )

    def test_empty_and_none_input_is_approved(self):
        for value in (None, ""):
            assert mod.check_transcript_for_prohibited_content(value) == (True, None)
        for value in (None, []):
            assert mod.check_tags_for_prohibited_content(value) == (True, None)

    def test_matching_is_case_insensitive(self):
        approved, _ = mod.check_transcript_for_prohibited_content(
            "CHILD SEXUAL ABUSE MATERIAL"
        )
        assert approved is False

    def test_substrings_do_not_match(self):
        """Word boundaries must hold, or a benign word containing a blocked
        term as a substring would be rejected."""
        for text in ["childishness", "extraviolence", "terroristries"]:
            approved, reason = mod.check_transcript_for_prohibited_content(text)
            assert approved is True, f"{text!r} was rejected: {reason}"


# ---------------------------------------------------------------------------
# 2. A storage failure is not a moderation decision
# ---------------------------------------------------------------------------

class TestFingerprintFailureIsNotARejection:
    def test_empty_fingerprint_is_inconclusive_not_rejected(self):
        approved, reason = mod.check_fingerprint_blocklist("")
        assert approved is True
        assert reason is None

    def test_a_storage_error_does_not_reject(self):
        """The concrete failure. compute_audio_fingerprint swallows the
        exception and returns "", so the old check turned a MinIO blip into
        ``(False, "Fingerprint computation failed")`` and the caller wrote
        moderation_approved=False."""

        class UnreadableFile:
            def open(self, *args):
                raise OSError("MinIO unreachable")

            def chunks(self, **kwargs):
                yield b""

            def close(self):
                pass

        fingerprint = mod.compute_audio_fingerprint(UnreadableFile())
        assert fingerprint == ""
        assert mod.check_fingerprint_blocklist(fingerprint) == (True, None)

    def test_a_real_fingerprint_passes_when_not_blocklisted(self):
        digest = "a" * 64
        assert mod.check_fingerprint_blocklist(digest) == (True, None)

    def test_a_blocklisted_fingerprint_is_rejected(self, monkeypatch):
        """The fail-open is only safe because the set is empty. If it is ever
        populated this must still reject — pinned so that day is not a
        silent hole."""
        digest = "b" * 64
        monkeypatch.setattr(mod, "_FINGERPRINT_BLOCKLIST", {digest})
        approved, reason = mod.check_fingerprint_blocklist(digest)
        assert approved is False
        assert "blocked" in reason.lower()

    def test_the_fingerprint_blocklist_is_still_empty(self):
        """The safety of failing open depends on this being empty.

        If a fingerprint is ever added, ``check_fingerprint_blocklist`` must
        stop treating a missing fingerprint as inconclusive, because the
        check will be able to reject and "we could not compute it" will no
        longer be a safe answer. Asserted directly so that adding an entry
        surfaces here rather than silently weakening the guarantee.
        """
        # Not `== set()`: the set literal is annotated `set[str]` and Django
        # runs with a plain `{}` in the module, so compare emptiness rather
        # than type.
        assert not mod._FINGERPRINT_BLOCKLIST


# ---------------------------------------------------------------------------
# 3. The dead transcript check inside run_moderation_check
# ---------------------------------------------------------------------------

class TestRunModerationCheckWiring:
    @pytest.fixture
    def clip(self, django_user_model):
        from backend.app.models import AudioClip

        owner = django_user_model.objects.create_user(
            username="owner", email="owner@example.com", password="pw-probe-123"
        )
        return AudioClip.objects.create(
            creator=owner, title="t", status="ready", hls_playlist_url=""
        )

    def test_audio_clip_has_no_transcript_text_column(self, clip):
        """The reason the transcript branch in run_moderation_check is dead:
        the model has no such field, so getattr returns None every time."""
        assert not hasattr(clip, "transcript_text")

    def test_a_prohibited_tag_still_rejects_through_run_moderation_check(self, clip):
        """The tag branch is live, so run_moderation_check is not entirely
        dead — worth pinning, because it is the only check there that can
        reject anything today."""
        clip.tags = ["child sexual abuse material"]
        clip.save(update_fields=["tags"])

        approved, reason = mod.run_moderation_check(clip.id)
        assert approved is False
        assert "child sexual abuse material" in reason

        clip.refresh_from_db()
        assert clip.moderation_approved is False

    def test_a_benign_tag_approves(self, clip):
        clip.tags = ["rain", "acoustic"]
        clip.save(update_fields=["tags"])

        approved, _ = mod.run_moderation_check(clip.id)
        assert approved is True

        clip.refresh_from_db()
        assert clip.moderation_approved is True

    def test_unreadable_original_file_does_not_reject(self, clip):
        """End-to-end: the storage blip scenario against the real entry
        point, asserting the DB flag survives."""
        # No patching needed: a FieldFile pointing at a key that does not
        # exist raises on .open() for real, which is exactly the condition
        # being tested. An earlier version of this test monkeypatched the
        # function with a lambda that called the patched name, which
        # recursed; using the real failure is both simpler and more honest.
        clip.original_file = "uploads/2026/01/01/definitely-missing-key.wav"
        clip.save(update_fields=["original_file"])

        approved, _ = mod.run_moderation_check(clip.id)
        assert approved is True
        clip.refresh_from_db()
        assert clip.moderation_approved is True

    def test_missing_clip_is_reported_not_raised(self, clip):
        import uuid

        approved, reason = mod.run_moderation_check(uuid.uuid4())
        assert approved is False
        assert "not found" in reason
