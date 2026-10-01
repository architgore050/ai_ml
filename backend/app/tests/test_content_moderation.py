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

3. **Transcript evidence must be persisted.** The moderation worker now stores
   the Whisper transcript and evaluates it after HLS preprocessing. The test
   pins the persisted evidence and decision so later moderation runs cannot
   silently lose the transcript. The check that does real work is the inline one in the
   task. Pinned here so nobody mistakes it for coverage.

4. **The gate that does fire, which had no behavioural tests at all.**
   Because of (1)-(3), ``POST /clips/{id}/approve-moderation/`` approves every
   upload; ``grep -rn "moderation_rejected"`` over the test tree returned
   nothing. The moderation that is actually load-bearing is the inline pair of
   checks in ``tasks._process_audio_to_hls_impl`` (``tasks.py:389-405``),
   running inside the worker against the transcript that exists only as a
   local variable there. ``TestWorkerSideModerationGate`` covers that branch
   with the ML collaborators stubbed, and says plainly which of the two
   branches the real pipeline can actually reach.

A note on why the "csam" entry is still here despite being a bare
acronym: see ``test_csam_is_the_one_entry_that_can_false_positive``.
"""
import subprocess

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

    def test_audio_clip_persists_transcript_text(self, clip):
        """The moderation evidence is part of the clip schema."""
        assert hasattr(clip, "transcript_text")
        assert clip.transcript_text == ""

    def test_a_prohibited_transcript_is_persisted_by_run_moderation_check(self, clip):
        clip.transcript_text = "child sexual abuse material"
        clip.save(update_fields=["transcript_text"])

        approved, reason = mod.run_moderation_check(clip.id)

        assert approved is False
        assert reason and "child sexual abuse material" in reason
        clip.refresh_from_db()
        assert clip.moderation_approved is False
        assert clip.moderation_reason == reason
        assert clip.moderated_at is not None

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


# ---------------------------------------------------------------------------
# 4. The gate that actually runs: tasks._process_audio_to_hls_impl
# ---------------------------------------------------------------------------
#
# Everything above is about the entry point that cannot reject. This section is
# about the branch inside the worker that can, and it is the only place in the
# platform where a prohibited upload is stopped.
#
# The collaborators are stubbed at the `backend.app.tasks` module namespace with
# `monkeypatch.setattr` — the same shape test_group_c.py uses for
# `services.uploads.publish`. Nothing here invokes Whisper, sentence-transformers,
# KeyBERT, librosa or ffmpeg; the transcript and the keywords are the *inputs* the
# gate branches on, so supplying them directly tests the branch rather than
# mocking the thing under test. The two moderation predicates are NOT stubbed —
# they are the real functions, because the point is that the worker reaches them
# with the real values.

PROHIBITED_TRANSCRIPT = "this recording contains child sexual abuse material"
BENIGN_TRANSCRIPT = "a quiet instrumental guitar loop in the rain"


class _FakeSegment:
    def __init__(self, text):
        self.text = text


class _FakeWhisper:
    def __init__(self, transcript):
        self._transcript = transcript

    def transcribe(self, path, **kwargs):
        return [_FakeSegment(self._transcript)], None


class _FakeVector(list):
    """Stands in for the numpy array `SentenceTransformer.encode` returns.

    The task calls `.tolist()` on it, so a bare list would raise AttributeError
    and be swallowed by the task's broad `except Exception` into
    `status='failed'` — the test would then be measuring the wrong branch.
    """

    def tolist(self):
        return list(self)


class _FakeEmbedder:
    def encode(self, text):
        return _FakeVector([0.1] * 384)


class _FakeKeywordExtractor:
    def __init__(self, keywords):
        self._keywords = keywords

    def extract_keywords(self, text, **kwargs):
        return [(word, 0.9) for word in self._keywords]


class _FakeLibrosa:
    def load(self, path, sr=None):
        return [0.0] * 16, sr or 22050

    def get_duration(self, y=None, sr=None):
        return 1.0


class _RecordingTimer:
    """Stands in for `metrics._TimerAdapter`, recording `set_outcome` calls.

    `_TimerAdapter` defaults `_outcome` to 'success' and only reports it to
    Prometheus on `__exit__`, which is not observable from a test. Recording the
    calls is: `calls == []` on the clean path is a stronger statement than
    `outcome == 'success'`, which the default would satisfy vacuously.
    """

    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    @property
    def outcome(self):
        return self.calls[-1] if self.calls else "success"

    def set_outcome(self, outcome):
        self.calls.append(outcome)


class _FakeSubprocess:
    """Namespace replacement for the `subprocess` module *as tasks sees it*.

    `monkeypatch.setattr(tasks.subprocess, "run", ...)` would patch the real
    stdlib module process-wide; replacing the name on `tasks` keeps the patch
    scoped to the code under test. `CalledProcessError` is carried over because
    the task's `except` clauses resolve it at raise time off the same name.
    """

    CalledProcessError = subprocess.CalledProcessError
    PIPE = subprocess.PIPE
    DEVNULL = subprocess.DEVNULL

    def __init__(self, sink):
        self._sink = sink

    def run(self, command, **kwargs):
        self._sink.append(command)
        return subprocess.CompletedProcess(command, 0, b"", b"")


class TestWorkerSideModerationGate:
    """`tasks.py:389-405` — the only moderation that stops anything."""

    @pytest.fixture
    def pipeline(self, monkeypatch, django_user_model):
        """Stub the ML/encode collaborators; return a `run` for the task.

        Note the clip is created with `moderation_approved=True`. The task's
        first guard is `if not clip.moderation_approved: return` (tasks.py:256),
        so a False flag short-circuits before any of this runs. In production
        `approve-moderation` set it — which is exactly why that endpoint's
        checks being inert is survivable: the worker does the deciding.
        """
        from django.core.files.base import ContentFile
        from django.core.files.storage import default_storage

        from backend.app import metrics, tasks

        state = {"transcript": BENIGN_TRANSCRIPT, "keywords": ["rain", "guitar"]}
        recorded = {"ffmpeg": []}
        timer = _RecordingTimer()

        monkeypatch.setattr(metrics, "time_hls_processing", lambda: timer)
        # ffmpeg normalisation: return a path. It need not exist — nothing
        # downstream opens it once librosa/Whisper/ffmpeg are stubbed, and the
        # task's `finally` already tolerates a missing file with `except OSError`.
        monkeypatch.setattr(
            tasks, "normalize_to_wav", lambda path, sr=22050: path + ".wav"
        )
        monkeypatch.setattr(tasks, "librosa", _FakeLibrosa())
        monkeypatch.setattr(tasks, "extract_acoustic_vector", lambda y, sr: [0.1] * 128)
        monkeypatch.setattr(tasks, "subprocess", _FakeSubprocess(recorded["ffmpeg"]))
        monkeypatch.setattr(tasks, "get_whisper_model", lambda: _FakeWhisper(state["transcript"]))
        monkeypatch.setattr(tasks, "get_embedding_model", lambda: _FakeEmbedder())
        monkeypatch.setattr(
            tasks, "get_kw_model", lambda: _FakeKeywordExtractor(state["keywords"])
        )

        owner = django_user_model.objects.create_user(
            username="worker-owner", email="worker@example.com",
            password="pw-probe-123",
        )
        from backend.app.models import AudioClip

        # A real object in the real bucket: the task streams it down to a temp
        # file before ffmpeg, so a missing key would take the
        # "Audio file for clip not found" branch instead of the gate.
        stored = default_storage.save(
            "uploads/gate-probe.wav", ContentFile(b"RIFF0000WAVEfake")
        )
        clip = AudioClip.objects.create(
            creator=owner,
            title="gate probe",
            status="processing",
            moderation_approved=True,
            original_file=stored,
        )

        def run():
            # `.run` is the autoretry wrapper, so this is the task body itself
            # (not Task.__call__, which would want a broker request context).
            tasks.process_audio_to_hls.run(clip.id)
            return clip

        try:
            yield {
                "run": run,
                "clip": clip,
                "state": state,
                "timer": timer,
                "ffmpeg_runs": recorded["ffmpeg"],
            }
        finally:
            default_storage.delete(stored)

    # -- transcript branch ---------------------------------------------------

    def test_a_prohibited_transcript_rejects_the_clip(self, pipeline):
        pipeline["state"]["transcript"] = PROHIBITED_TRANSCRIPT

        clip = pipeline["run"]()

        clip.refresh_from_db()
        assert clip.moderation_approved is False
        assert clip.status == "rejected"
        assert pipeline["timer"].outcome == "moderation_rejected"

    def test_a_prohibited_transcript_stops_before_the_hls_encode(self, pipeline):
        """The point of the `return`: the encode is the expensive, irreversible
        part, and a rejected clip must never reach it. Asserted on the ffmpeg
        invocation rather than on the status, so a pipeline that reorders the
        encode ahead of the gate fails here too."""
        pipeline["state"]["transcript"] = PROHIBITED_TRANSCRIPT

        pipeline["run"]()

        assert pipeline["ffmpeg_runs"] == [], "ffmpeg ran on a rejected clip"
        clip = pipeline["clip"]
        clip.refresh_from_db()
        # Not "hls_playlist_url is None": the fixture's clip has whatever the
        # column defaults to, and the encode's real marker is the master
        # playlist path written at tasks.py:471. Asserting the absence of *that*
        # cannot be satisfied by an accident of the default.
        assert not (clip.hls_playlist_url or "").endswith("master.m3u8"), (
            "the pipeline recorded a playable HLS location for a clip it "
            "rejected"
        )
        assert clip.status == "rejected"

    def test_a_prohibited_transcript_records_the_tags_it_found(self, pipeline):
        """`save(update_fields=[..., 'tags'])` writes the tags on the reject
        path, so an operator looking at the clip can see what the pipeline saw
        before it stopped."""
        pipeline["state"]["transcript"] = PROHIBITED_TRANSCRIPT
        pipeline["state"]["keywords"] = ["abuse", "material"]

        clip = pipeline["run"]()

        clip.refresh_from_db()
        assert clip.tags == ["abuse", "material"]

    # -- tag branch ----------------------------------------------------------

    def test_a_prohibited_tag_rejects_the_clip(self, pipeline):
        """Clean transcript, prohibited tag: the second branch, on its own.

        The only blocked phrase a tag can equal is `csam`, and only because it
        is the one single-token entry in `_BLOCKED_PHRASES` — the other three
        contain spaces, so a unigram keyword can never match them. That makes
        this branch a defence-in-depth net rather than a reachable outcome: a
        transcript containing "csam" is caught by the transcript check on the
        line above and returns before `clip.tags` is even consulted. The branch
        is still worth pinning, because deleting it would remove the only
        defence if a future extractor emits multi-word keywords.
        """
        pipeline["state"]["transcript"] = BENIGN_TRANSCRIPT
        pipeline["state"]["keywords"] = ["csam"]

        clip = pipeline["run"]()

        clip.refresh_from_db()
        assert clip.moderation_approved is False
        assert clip.status == "rejected"
        assert clip.tags == ["csam"]
        assert pipeline["timer"].outcome == "moderation_rejected"
        assert pipeline["ffmpeg_runs"] == []

    # -- both consulted, and the clean path ----------------------------------

    def test_both_checks_are_consulted_independently(self, pipeline, monkeypatch):
        """Two separate calls, two separate values, and both made even when the
        first one already failed.

        The assertions are on the *arguments* as well as the call count, because
        "both were called" is also true of an implementation that passed the
        same value to both, or that checked tags before transcribing.
        """
        seen = {}
        real_transcript_check = mod.check_transcript_for_prohibited_content
        real_tag_check = mod.check_tags_for_prohibited_content

        def spy_transcript(value):
            seen["transcript"] = value
            return real_transcript_check(value)

        def spy_tags(value):
            seen["tags"] = value
            return real_tag_check(value)

        # Patched on the module object, not on `tasks`: the task does
        # `from .services import content_moderation as moderation_svc` inside
        # the function and then calls `moderation_svc.check_...`, so the lookup
        # happens on the module at call time.
        monkeypatch.setattr(mod, "check_transcript_for_prohibited_content", spy_transcript)
        monkeypatch.setattr(mod, "check_tags_for_prohibited_content", spy_tags)

        pipeline["state"]["transcript"] = PROHIBITED_TRANSCRIPT
        pipeline["state"]["keywords"] = ["abuse", "material"]

        pipeline["run"]()

        assert seen["transcript"] == PROHIBITED_TRANSCRIPT
        assert seen["tags"] == ["abuse", "material"]

    def test_a_clean_transcript_and_tags_approve_and_continue(self, pipeline):
        pipeline["state"]["transcript"] = BENIGN_TRANSCRIPT
        pipeline["state"]["keywords"] = ["rain", "guitar"]

        clip = pipeline["run"]()

        clip.refresh_from_db()
        assert clip.moderation_approved is True
        assert clip.status == "ready"
        assert clip.hls_playlist_url == f"hls/{clip.id}/master.m3u8"
        assert len(pipeline["ffmpeg_runs"]) == 1, "the HLS encode did not run"
        assert pipeline["timer"].calls == [], (
            "a clean clip must not set an outcome override; the default "
            "'success' is the right label"
        )

    # -- the save(update_fields=...) on the reject path -----------------------

    def test_the_reject_path_persists_moderation_evidence_and_vectors(self, pipeline):
        """A rejected clip keeps the evidence needed for audit/review."""
        pipeline["state"]["transcript"] = PROHIBITED_TRANSCRIPT

        pipeline["run"]()  # reaching the next line is the "does not blow up"

        clip = pipeline["clip"]
        clip.refresh_from_db()
        assert clip.semantic_vector is not None
        assert clip.acoustic_vector is not None
        assert clip.duration_ms == 1000
        assert clip.transcript_text == PROHIBITED_TRANSCRIPT
        assert clip.moderation_reason
        assert clip.moderated_at is not None
