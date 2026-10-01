import os
import logging
from rest_framework import serializers
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Exists, OuterRef
from backend.EchoFlow.client_ip import get_client_ip
from .media_urls import get_hls_playback_url, get_signed_media_url
from .models import AudioClip, UserInteraction, ShareEvent, Comment, ConsentAudit, Grievance, AuditLog
from rest_framework.validators import UniqueValidator


User = get_user_model()

# Module-level so the audit warning emitted from `AudioUploadSerializer.create`
# can name the clip it is about. `validate()` uses a local `getLogger` because
# it runs before the row exists; see the comment there.
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pure-Python magic-byte allowlist.
#
# SECURITY: a 14-byte header check that runs in <1us, no system binary
# required. Catches the most common attack vectors (PE/EXE trojans, ELF
# binaries, scripts, archives) before the file ever reaches the ffprobe
# subprocess or object storage. This is the FIRST line of defense;
# python-magic (libmagic) and the pydub duration probe are the second
# and third.
#
# Audio formats we accept share common header patterns that are NOT
# in the BLOCKED_SIGNATURES list below. We only block signatures we
# can identify with high confidence — unknown headers fall through
# to the extension check and the pydub probe.
# ---------------------------------------------------------------------------
_BLOCKED_MAGIC_SIGNATURES = (
    # Windows PE / DOS executable
    b'MZ',
    # ELF (Linux/Unix executable)
    b'\x7fELF',
    # Bash/sh script shebang
    b'#!/bin/sh',
    b'#!/bin/bash',
    b'#!/usr/bin/env',
    # Python script shebang
    b'#!/usr/bin/python',
    b'#!/usr/bin/env python',
    # Perl script shebang
    b'#!/usr/bin/perl',
    # PDF document
    b'%PDF-',
    # Java class file
    b'\xca\xfe\xba\xbe',
    # Mach-O universal binary (macOS executable)
    b'\xca\xfe\xba\xbe',  # same as Java class; intentionally listed once
    b'\xcf\xfa\xed\xfe',  # 64-bit little-endian
    b'\xfe\xed\xfa\xce',  # 32-bit big-endian
    b'\xfe\xed\xfa\xcf',  # 64-bit big-endian
    # ZIP / DOCX / XLSX / JAR (archives disguised as audio)
    b'PK\x03\x04',
    b'PK\x05\x06',
    b'PK\x07\x08',
    # RAR archive
    b'Rar!\x1a\x07',
    # 7z archive
    b'7z\xbc\xaf\x27\x1c',
    # Gzip
    b'\x1f\x8b',
    # Windows BMP
    b'BM',
    # GIF
    b'GIF87a',
    b'GIF89a',
    # PNG
    b'\x89PNG\r\n\x1a\n',
    # JPEG
    b'\xff\xd8\xff',
)


def request_user(context: dict):
    """The authenticated user for a serializer context, or AnonymousUser.

    DRF's `request.user` is `AnonymousUser` when unauthenticated rather than
    `None`, so `is_authenticated` is the check — not truthiness.
    """
    request = context.get('request')
    user = getattr(request, 'user', None)
    if user is None or not user.is_authenticated:
        return None
    return user


def following_annotation(viewer, creator_ref='creator_id'):
    """`Exists` annotation for the B2 `user_is_following` fast path.

    `FeedClipSerializer.get_is_following` checks `hasattr(obj,
    'user_is_following')` first, exactly as `get_is_liked` does with
    `user_has_liked`. Any queryset that serialises more than one clip should
    `.annotate(**following_annotation(request.user))` to stay at one query
    instead of one per clip.

    `creator_ref` is the OuterRef path to the *creator being tested*. It
    defaults to `'creator_id'`, which is correct when the queryset is of
    AudioClip. A queryset that reaches the clip through a relation — e.g.
    `ShareEventSerializer.clip` is a nested `FeedClipSerializer`, so
    `GET /share/` and `GET /share/inbox/` serialise clips from a ShareEvent
    queryset — must pass `'clip__creator_id'`. Without the argument that
    raises FieldError at queryset construction, not at render time, so it
    fails loudly rather than silently falling back to N+1.

    Exported so views and the serializer module do not each grow their own
    copy of the subquery, which is how the two drift apart.
    """
    from django.db.models import Exists, OuterRef

    # Must test `is_authenticated`, not truthiness: DRF hands an unauthenticated
    # request `AnonymousUser`, which is truthy but has no `following`
    # manager. `request_user()` exists for the same reason.
    if not getattr(viewer, 'is_authenticated', False):
        return {}

    # `User.following` is symmetrical=False with related_name='followers',
    # so "viewer follows creator" is a filter on the viewer's own M2M
    # manager. Outered on the AudioClip row so Postgres evaluates it once.
    return {
        'user_is_following': Exists(
            viewer.following.filter(pk=OuterRef(creator_ref))
        )
    }


def _viewer_follows(viewer, target) -> bool:
    """Does `viewer` already follow `target`? B2, shared by the profile serializers.

    A `False` for unauthenticated viewers and for self, matching
    `FollowViewSet.toggle_follow`'s 400 on `target == request.user`.
    """
    if viewer is None or target is None:
        return False
    if viewer.pk == target.pk:
        return False
    return viewer.following.filter(pk=target.pk).exists()


def _has_blocked_magic_signature(head: bytes) -> str | None:
    """Return the matched signature label if `head` matches a known
    non-audio file signature, else None.

    The label is human-readable and surfaced in the rejection error
    so the audit logs can show the detected type without exposing
    the full binary header.
    """
    for sig in _BLOCKED_MAGIC_SIGNATURES:
        if head.startswith(sig):
            if sig.startswith(b'MZ'):
                return 'PE/EXE executable'
            if sig.startswith(b'\x7fELF'):
                return 'ELF executable'
            if sig.startswith(b'#!'):
                return 'script'
            if sig.startswith(b'%PDF'):
                return 'PDF document'
            if sig == b'\xca\xfe\xba\xbe':
                return 'Java class / Mach-O binary'
            if sig.startswith(b'PK'):
                return 'ZIP archive'
            if sig.startswith(b'Rar!'):
                return 'RAR archive'
            if sig.startswith(b'7z'):
                return '7-Zip archive'
            if sig.startswith(b'\x1f\x8b'):
                return 'gzip archive'
            if sig == b'BM':
                return 'BMP image'
            if sig.startswith(b'GIF'):
                return 'GIF image'
            if sig.startswith(b'\x89PNG'):
                return 'PNG image'
            if sig.startswith(b'\xff\xd8\xff'):
                return 'JPEG image'
            if sig == b'\xcf\xfa\xed\xfe' or sig == b'\xfe\xed\xfa\xcf':
                return 'Mach-O 64-bit binary'
            if sig == b'\xfe\xed\xfa\xce':
                return 'Mach-O 32-bit binary'
            return 'non-audio content'
    return None

#: WHAT THIS DOES *NOT* CLOSE — read this before calling it "mitigated".
#:
#: Derivation trusts the DECLARATION. A user who uploads audio that is really
#: CC-BY-NC while declaring ``"Owned"`` still gets ``(False, False)`` and is
#: still served commercially. Nothing on the upload path can catch that: there
#: is no audio fingerprint that determines a licence, the server has no access
#: to the source, and the only classifier in this repository
#: The removed ingestion classifier read a *licence string*, not
#: audio. So the honest statement of what this table buys is:
#:
#:   It makes an HONEST declaration binding. It does not make a DISHONEST one
#:   detectable.
#:
#: That is still the whole difference between a rights gate that works and one
#: that is theatre — before this, even a truthful declaration was discarded — but
#: the lying uploader remains open and closing it needs operator review
#: (ISSUE-04's moderation queue), not a serializer. Nothing in the code below
#: should be read as claiming otherwise.
#:
#: The residual on ``"Unknown"`` is separate and smaller: see that row.
#:
#: ``license_type`` -> ``(is_noncommercial, requires_share_alike)``.
#:
#: The table below is the authority for the seven values in
#: ``AudioUploadSerializer.LICENSE_CHOICES``. It is explicit rather than
#: computed so the rights policy is reviewable and deterministic.
#:
#: WHY TRANSCRIBED INSTEAD OF IMPORTED
#: -----------------------------------
#: ``serializers.py`` is imported by every request this platform serves, so the
#: policy deliberately has no optional ingestion-package dependency.
LICENSE_RESTRICTION_FEATURES = {
    # Owned work. No third-party obligation, so nothing to enforce.
    "Owned": (False, False),
    # Public-domain dedications. Same.
    "CC0": (False, False),
    "Public_Domain": (False, False),
    # Attribution only. Commercially usable, no share-alike condition —
    # the attribution obligation is carried by `copyright_owner_name`.
    "CC-BY": (False, False),
    # ShareAlike: commercial use is permitted, but redistribution must carry
    # the same licence. That is a DISTRIBUTION CONDITION, and
    # `is_license_restricted` treats it as a gate, so it must be flagged.
    "CC-BY-SA": (False, True),
    # NonCommercial: the case with real Copyright Act 1957 s.30 exposure.
    "CC-BY-NC": (True, False),
    # (A2) The uploader did not say. `license_features('UNKNOWN')` also
    # returns (False, False), and this mirrors it deliberately: a licence we
    # do not know carries no obligation we are able to enforce, and refusing
    # it would mean hiding every upload whose author left the dropdown alone.
    # Nothing in mobile/ or frontend/ sends `license_type` at all today, so
    # quarantining this value would quarantine 100% of uploads and brick the
    # upload flow — `docs/EXPLAIN/compliance/01-license-type-unknown-gap.md`
    # parks that as "Option 2" and it is an owner decision, not an agent's.
    #
    # What keeps this honest is that `Unknown` is not servable for free:
    # `AudioUploadSerializer.create()` forces `moderation_approved=False`, so
    # such a clip needs an explicit approval before any surface serves it. The
    # residual is real and is stated in the audit trail: owner self-approval is
    # permitted, so an `Unknown` upload becomes servable after one further
    # request. See `test_upload_license_derivation::TestUnknown`-equivalent
    # tests, which pin both halves.
    "Unknown": (False, False),
}


def license_restriction_features(license_type):
    """Return ``(is_noncommercial, requires_share_alike)`` for a licence.

    Unknown or unrecognised values fall through to ``(False, False)``, which is
    the same fail-open-on-unknown answer used by legacy imported rows. That is
    a deliberate, bounded choice and not a general default: the input here is
    already constrained to ``LICENSE_CHOICES`` by a ``ChoiceField``, so an
    unrecognised value can only arrive from a row written outside this
    serializer (for example a fixture or management command), whose persisted
    rights flags remain authoritative.
    """
    if not license_type:
        return (False, False)
    return LICENSE_RESTRICTION_FEATURES.get(license_type, (False, False))


class UserProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'username', 'date_joined']
        read_only_fields = ['id', 'date_joined']

class AudioUploadSerializer(serializers.ModelSerializer):
    # DECISION: Added file type/size validation at serializer boundary
    # rather than model level to provide fast feedback to client.
    # Tradeoff: Slightly more code in serializer vs. guaranteed validation.
    ALLOWED_EXT = {'.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.opus'}
    MAX_SIZE = 100 * 1024 * 1024  # 100 MB
    # SECURITY: Magic-byte MIME allowlist. An attacker can rename evil.exe
    # to evil.mp3 and bypass extension-only checks. python-magic reads the
    # first ~1KB of the file and returns the inferred MIME type. We accept
    # only audio/* MIME types. If libmagic is unavailable, fall back to
    # extension-only (with a logged warning) so the service doesn't break
    # on minimal Docker images.
    ALLOWED_MIMES = frozenset({
        'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
        'audio/wave', 'audio/x-vorbis+ogg', 'audio/ogg', 'audio/flac',
        'audio/x-flac', 'audio/mp4', 'audio/aac', 'audio/x-m4a',
        'audio/webm', 'audio/opus',
    })

    # ISSUE-05: User-upload licensing and copyright acknowledgment.
    LICENSE_CHOICES = [
        ("Owned", "Owned"),
        ("CC0", "CC0"),
        ("CC-BY", "CC BY"),
        ("CC-BY-SA", "CC BY-SA"),
        ("CC-BY-NC", "CC BY-NC"),
        ("Public_Domain", "Public Domain"),
        ("Unknown", "Unknown"),
    ]
    license_type = serializers.ChoiceField(
        choices=LICENSE_CHOICES,
        default="Unknown",
        required=False,
    )
    copyright_owner_name = serializers.CharField(
        max_length=255,
        required=False,
        allow_blank=True,
        allow_null=True,
    )
    copyright_acknowledgement = serializers.BooleanField(
        required=True,
    )

    class Meta:
        model = AudioClip
        fields = ['id', 'title', 'category', 'original_file', 'status', 'license_type', 'copyright_owner_name', 'copyright_acknowledgement']
        # N8 fix: original_file is writable on create (POST) but read-only
        # on update (PATCH/PUT). The serializer-level read_only_fields
        # applies to BOTH, so we use 'original_file' as a writable
        # field here and enforce read-only-on-update at the view level
        # via an update() override that raises PermissionDenied or
        # silently ignores the field. See AudioUploadViewSet.update().
        read_only_fields = ['id', 'status']

    def validate(self, data):
        # SECURITY / REGULATORY: Enforce copyright acknowledgment.
        # Per ISSUE-05 (Copyright Act 1957 / IT Rules 2021), the user
        # must explicitly confirm they have the right to upload the audio.
        #
        # W2-G (2026-09-30) — this used to be a single unconditional
        # `if not data.get("copyright_acknowledgement", False)`. That made
        # every `PATCH /clips/{id}/` a 400: DRF's `partial=True` skips
        # FIELD-level validation for absent fields, but the object-level
        # `validate()` hook is still called, so a client editing a clip title
        # without re-sending the flag was rejected. Clip editing could never
        # have worked end to end.
        #
        # DECISION: required on create, and never revocable afterwards.
        #
        #  * Create — must be present and true, exactly as before. This is the
        #    only moment the declaration can honestly be made: the audio is
        #    being introduced here, and `original_file` is stripped from every
        #    update by `AudioUploadViewSet.update` (N8), so the content being
        #    licensed can never change afterwards.
        #  * Update — absent is accepted (there is no new content to license);
        #    present-and-false is rejected. The stored column is the durable
        #    record of a declaration made at upload time, so letting any client
        #    flip it to False would let the one actor with no standing erase
        #    it, and would make the gate hold only until somebody PATCHed.
        #    Note the rejected-update path is the pre-existing one: this
        #    method rejected every update, so no client can have depended on
        #    a `false` write succeeding.
        #
        # The error text is unchanged so anything already rendering it stays
        # correct, and so the create-side behaviour is byte-identical.
        creating = self.instance is None
        acknowledged = data.get('copyright_acknowledgement')
        if creating:
            unsatisfied = not acknowledged
        else:
            unsatisfied = acknowledged is not None and not acknowledged
        if unsatisfied:
            raise serializers.ValidationError(
                {"copyright_acknowledgement": "You must acknowledge that you have the right to upload this audio and that it does not infringe any third-party rights."}
            )
        license_type = data.get("license_type", "Unknown")
        if license_type == "Unknown":
            logger = logging.getLogger(__name__)
            logger.warning("Upload with Unknown license type — audit trail required.")

        # Pro gating: check free-tier limits for non-Pro users.
        request = self.context.get('request')
        if request and hasattr(request.user, 'is_pro') and not request.user.is_pro():
            self._enforce_free_limits(request.user, data.get('original_file'))
        return data

    def _enforce_free_limits(self, user, original_file):
        """Reject uploads that exceed free-tier limits."""
        from django.conf import settings as django_settings
        from django.utils import timezone
        from datetime import timedelta

        # File size limit
        max_mb = getattr(django_settings, "REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE", 10)
        max_size = max_mb * 1024 * 1024
        if original_file and original_file.size > max_size:
            raise serializers.ValidationError(
                {"original_file": f"Free tier upload limit is {max_mb}MB. Upgrade to Pro for unlimited uploads."}
            )

    def validate_original_file(self, value):
        if value.size > self.MAX_SIZE:
            raise serializers.ValidationError(f"File exceeds {self.MAX_SIZE//1024//1024}MB limit.")
        ext = os.path.splitext(value.name)[1].lower()
        if ext not in self.ALLOWED_EXT:
            raise serializers.ValidationError(f"Unsupported file type: {ext}")
        # SECURITY: Pure-Python magic-byte sniff. Reads the first 8KB
        # and matches against a hard-coded list of KNOWN non-audio
        # signatures. Catches PE/EXE, ELF, scripts, archives, and
        # common image formats BEFORE the file reaches the ffprobe
        # subprocess (or object storage, on a longer path). No
        # external binary required, so this check works on minimal
        # Docker images without ffmpeg installed and is the most
        # reliable first line of defense.
        value.seek(0)
        head = value.read(8192)
        value.seek(0)
        detected_type = _has_blocked_magic_signature(head)
        if detected_type is not None:
            raise serializers.ValidationError(
                f"File content does not match audio format. Detected: {detected_type}"
            )
        # Magic-byte sniff via libmagic (python-magic). Layer-2 check:
        # if libmagic confidently identifies the file as a non-audio
        # MIME that the pure-Python allowlist above missed, reject it.
        # The pure-Python allowlist already covers the common attacks
        # (PE/ELF/scripts/archives); libmagic adds coverage for less
        # common formats. If python-magic is not installed, skip this
        # step (with a logged warning) and rely on the pydub probe.
        try:
            import magic
            mime = magic.from_buffer(head, mime=True)
            if mime and not mime.startswith('audio/') and mime != 'application/octet-stream':
                raise serializers.ValidationError(
                    f"File content does not match audio format. Detected: {mime}"
                )
        except ImportError:
            # python-magic not installed — log and fall back to the
            # pure-Python check + the pydub probe.
            logging.getLogger(__name__).warning(
                "python-magic unavailable; relying on pure-Python magic-byte allowlist"
            )
        # SECURITY: Duration probed at upload time, not in the worker. A
        # 100MB-but-24-hour WAV would otherwise be accepted into S3,
        # billed, and only then failed — wasting bandwidth, storage,
        # and worker time. Group C item 23 fix.
        #
        # DECISION: pydub over ffprobe because pydub is already in
        # requirements-media.txt for the worker, the API is cleaner
        # inside a serializer, and the underlying ffmpeg subprocess
        # is the same. Cost: ~6MB in the web image (already present
        # in the media image).
        #
        # HACK: Reading the whole upload into memory here to pass to
        # pydub. Django normally streams; we get a file object via
        # the serializer's value attr. pydub needs a path or
        # BytesIO, not a streaming file. TODO: stream via pydub's
        # from_file with a temp path if memory pressure becomes a
        # problem.
        from django.conf import settings as django_settings
        max_seconds = getattr(django_settings, 'MAX_DURATION_SECONDS', 300)
        try:
            import io
            from pydub import AudioSegment
            value.seek(0)
            data = value.read()
            value.seek(0)
            audio = AudioSegment.from_file(io.BytesIO(data))
            duration_seconds = len(audio) / 1000.0
            if duration_seconds > max_seconds:
                raise serializers.ValidationError(
                    f"Audio duration ({duration_seconds:.1f}s) exceeds maximum "
                    f"allowed ({max_seconds}s)."
                )
        except serializers.ValidationError:
            raise
        except Exception as e:
            # pydub raises various exceptions for unsupported/corrupt files.
            # CouldntDecodeError, FileNotFoundError (ffmpeg missing), etc.
            # Reject as unsupported so we don't accept garbage.
            logging.getLogger(__name__).warning(
                f"Duration probe failed for {value.name}: {type(e).__name__}: {e}"
            )
            raise serializers.ValidationError(
                "Could not probe audio duration. File may be corrupt or unsupported."
            )
        return value

    def create(self, validated_data):
        # Issue-05: Ensure copyright fields are persisted.
        validated_data['creator'] = self.context['request'].user
        validated_data.setdefault('moderation_approved', False)
        validated_data.setdefault('copyright_acknowledgement', validated_data.get('copyright_acknowledgement', False))

        # DEFECT A — the declared licence is now load-bearing.
        #
        # `license_type` was writable and `ChoiceField`-validated, and its only
        # reader in the entire tree was the `logger.warning` in `validate()`
        # above. `is_noncommercial` / `requires_share_alike` are absent from
        # `Meta.fields`, so a client could not set them, and they are
        # `BooleanField(default=False)` — so they held False for every user
        # upload. `services/entitlements.is_license_restricted` is a
        # two-boolean predicate, and it is the ONLY rights gate. So an uploader
        # who correctly declared "CC-BY-NC", then self-approved (the v1 flow in
        # `AudioUploadViewSet.approve_moderation`), was served commercially
        # from /feed/, /suggestions/, the playback token, the share link and
        # the public page. Two requests, no privileges, deterministic.
        #
        # The fix is to make the columns carry the truth rather than to add a
        # second rule that duplicates `is_license_restricted`: every existing
        # consumer starts working with no edit to any of them, and the feed
        # query stays an index-friendly two-predicate filter.
        #
        # Assigned, not `setdefault`. `setdefault` would be a no-op for any
        # value already present, and the fields are not in `Meta.fields` so
        # nothing can pre-populate them — but the point is that the derivation
        # is unconditional, so a future "helpful" addition of these two to
        # `Meta.fields` (much more tempting now that this method touches them)
        # cannot be used to clear a real restriction.
        #
        # `license_type` has `default="Unknown"`, so it is always present in
        # `validated_data` by now; the `or` only guards a row written through
        # a serializer instance that skipped the field default.
        license_type = validated_data.get('license_type') or 'Unknown'
        is_noncommercial, requires_share_alike = license_restriction_features(
            license_type
        )
        validated_data['is_noncommercial'] = is_noncommercial
        validated_data['requires_share_alike'] = requires_share_alike

        clip = super().create(validated_data)

        # (A2) `Unknown` derives to (False, False) — the same answer
        # the legacy classifier — and that is a deliberate product decision,
        # not an oversight. Reasoning is on the
        # `LICENSE_RESTRICTION_FEATURES["Unknown"]` row: the value is what
        # every upload gets by default, so quarantining it here would
        # quarantine 100% of uploads. What keeps it from being free is the
        # `moderation_approved=False` above, which pins "an `Unknown` upload is
        # not servable until somebody approves it".
        #
        # (A3) This warning is the audit trail for that decision, and it is
        # emitted HERE rather than only in `validate()` because the row exists
        # here, so the record can name the clip. `validate()` runs first and
        # can only say "an upload declared Unknown" — which is unactionable
        # when an operator is asked to review the queue.
        if license_type == 'Unknown':
            logger.warning(
                "Upload with Unknown license type — audit trail required. "
                "clip=%s creator=%s nc=%s sa=%s moderation_approved=%s",
                clip.id, clip.creator_id, clip.is_noncommercial,
                clip.requires_share_alike, clip.moderation_approved,
            )
        return clip

def _cover_image_url(clip):
    """Return a browser-reachable, presigned URL for a clip's cover art.

    DEFECT B. This used to be, in two places::

        request.build_absolute_uri(obj.cover_image.url)

    ``FieldFile.url`` reaches django-storages' ``S3Storage.url()``, and with
    ``"querystring_auth": True`` that presigns against
    ``"endpoint_url": AWS_S3_ENDPOINT_URL`` — the *container-internal* MinIO
    endpoint (``http://minio:9000``), a Docker-network-only DNS name.
    ``build_absolute_uri()`` returns an already-absolute URL verbatim, so it
    does not repair the host: the client received a **validly-signed**
    ~1-hour URL pointing at an internal hostname, disclosing the storage engine
    and the in-network DNS. That is precisely the "ENDPOINT MISMATCH" that
    ``media_urls.py:1-11`` exists to document, and ``get_signed_media_url()``
    (media_urls.py:87) already solves it. These two call sites bypassed it and
    called ``default_storage`` directly — a straight copy of the bug the module
    was written to prevent.

    Severity was higher than the feed case: this is duplicated on the
    **unauthenticated** ``GET /clips/{id}/public/`` (``AllowAny``) and the value
    is interpolated into the ``og:image`` tag of the public share card by
    ``_render_share_card`` in ``views/content.py``, so any link unfurler
    received the internal URL. Latent only because ``cover_image`` is not in
    any serializer's ``Meta.fields``, so it is ``NULL`` on every row today — it
    goes live silently the moment cover upload is added.

    Why the signed helper and not the HLS one: a cover image is a single
    object, not a multi-file stream, and it lives under ``covers/`` on the
    origin that actually serves objects. ``get_hls_playback_url`` produces a
    bucket-less edge URL for ``/hls/*`` only; used here it would 404. That
    distinction is the whole reason ``media_urls.py`` keeps two helpers.

    Neither the request nor its host is consulted: the signature is computed
    over a canonical request against the storage endpoint, so re-hosting it
    yields a URL the origin rejects. The old code let the request's ``Host:``
    header decide, which was both wrong and attacker-influenced.

    Returns None when the clip has no cover, which is the field's contract for
    "no image" and is what both call sites and the clients expect.
    """
    if not clip.cover_image or not clip.cover_image.name:
        return None
    return get_signed_media_url(clip.cover_image.name)


class FeedClipSerializer(serializers.ModelSerializer):
    # Fixed from owner.username to creator.username
    creator_name = serializers.CharField(source='creator.username', read_only=True)
    creator_id = serializers.IntegerField(source='creator.id', read_only=True)
    is_liked = serializers.SerializerMethodField()
    # B2 (2026-09-29). See get_is_following for why this had to be added:
    # without it the client's Follow button is a blind toggle that *unfollows*
    # creators you already follow. Same hasattr-annotation fast path as
    # get_is_liked so the common case costs no extra query.
    is_following = serializers.SerializerMethodField()
    # `AudioClip.hls_playlist_url` stores a relative object-storage KEY
    # (e.g. "hls/<clip_id>/master.m3u8"), not a servable URL — the bucket is
    # private, so a real playable URL has to be signed fresh on every read.
    # A signed URL persisted in the DB would silently expire after
    # AWS_S3_QUERYSTRING_EXPIRE regardless of whether the clip is still
    # valid, so we generate it here instead of trusting the stored field.
    hls_playlist_url = serializers.SerializerMethodField()
    cover_image = serializers.SerializerMethodField()

    class Meta:
        model = AudioClip
        fields = [
            'id', 'title', 'creator_name', 'category',
            'hls_playlist_url', 'likes', 'shares', 'skips',
            'comment_count', 'is_liked', 'is_following', 'creator_id', 'cover_image',
            # A2 (2026-09-29). Both were already columns on AudioClip and
            # were simply never exposed, so the client had to derive them:
            # `tags` drives the chip row, and without `duration_ms` the
            # scrubber has to estimate progress from the player clock, which
            # drifts and cannot survive a resume. Long-acknowledged gap —
            # FRONTEND-REQUIREMENTS.md §11.11 and mobile-rebuild-plan.md B5.
            #
            # tags is a JSONField, so ModelSerializer renders it as-is; the
            # DB default is [] and tasks.py writes ["instrumental"] for
            # vocal-free clips, so the client never has to null-check.
            'tags', 'duration_ms',
        ]
        read_only_fields = [
            'likes', 'shares', 'skips', 'comment_count', 'hls_playlist_url', 'is_liked', 'cover_image',
            'is_following', 'tags', 'duration_ms',
        ]

    def get_hls_playlist_url(self, obj):
        return get_hls_playback_url(obj.hls_playlist_url)

    def get_cover_image(self, obj):
        # DEFECT B — see `_cover_image_url`. This field stays in
        # `Meta.fields`: it is already part of the shipped feed contract and
        # the RN client tolerates it. Only the URL construction changed.
        return _cover_image_url(obj)

    def get_is_liked(self, obj):
        if hasattr(obj, 'user_has_liked'):
            return obj.user_has_liked
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        return UserInteraction.objects.filter(
            user=request.user, clip=obj, interaction_type='like', is_active=True
        ).exists()

    def get_is_following(self, obj):
        """Whether `request.user` already follows this clip's creator.

        B2. The field did not exist on any serializer, and
        `POST /follow/{id}/toggle-follow/` is a *toggle* — so a client that
        cannot read the current state cannot render an honest button, and
        tapping "Follow" on someone already followed silently unfollows them.
        The backend already returns `{status: 'followed'|'unfollowed'}`; this
        was one field away.

        Follow is a property of the (viewer, creator) pair, not of the clip,
        so the per-object query below is a fallback. Every queryset that
        serialises a list of clips annotates `user_is_following` with an
        `Exists` subquery so this hits the fast path with no extra round trip
        — the same strategy `is_liked` uses via `user_has_liked`.

        Note the self-follow case: the endpoint 400s on
        `target == request.user`, so reporting False for your own clip is what
        keeps the client's optimistic state consistent with the server.
        """
        if hasattr(obj, 'user_is_following'):
            return obj.user_is_following
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False
        return request.user.following.filter(pk=obj.creator_id).exists()

class PublicClipSerializer(serializers.ModelSerializer):
    """Metadata for a shared clip, visible without authentication.

    A4 (2026-09-29). Deliberately NOT ``FeedClipSerializer``: that one is the
    signed-in feed contract and carries engagement counters, ``is_liked`` (a
    per-viewer value that is meaningless with no viewer), and
    ``hls_playlist_url``. The public view previously reused it, so an
    unauthenticated caller could read a clip's like/skip/share/comment
    counts and the per-viewer field.

    Omitted on purpose:

    * ``hls_playlist_url`` — the media is token-gated, so publishing the URL
      to an unauthenticated caller leaks nothing useful and invites the
      "just share the HLS link" pattern that a previous frontend already
      implemented. Playback is authorised separately, on an explicit play
      intent, via ``POST /clips/{id}/play/``.
    * ``likes`` / ``shares`` / ``skips`` / ``comment_count`` — engagement
      data is not needed to render a share card, and it is the kind of
      figure that is scraped.
    * ``is_liked`` — viewer-specific; always false without a session.
    * ``creator_id`` — the display name is enough to attribute the clip, and
      omitting the id keeps this from being a user-id oracle.
    """

    creator_name = serializers.CharField(source="creator.username", read_only=True)

    # DEFECT B, and this DECLARATION is the whole bug — the `get_cover_image`
    # below was dead code and never ran. DRF only calls a `get_<field>` hook for
    # a field declared as a `SerializerMethodField`. Without this line, `Model-
    # Serializer` auto-builds an `ImageField` for `cover_image` straight from
    # the model column, and rendering it calls `value.url` on the `FieldFile` —
    # i.e. `S3Storage.url()` with `querystring_auth: True`, which presigns
    # against `AWS_S3_ENDPOINT_URL`, the container-internal `http://minio:9000`.
    # So the leak was NOT caused by `get_cover_image` returning a bad URL; that
    # method was never consulted at all. `FeedClipSerializer` declares the field
    # (which is why the feed path was the one that already worked), and the two
    # calling the *same* helper is not evidence they behave the same — sharing a
    # helper only matters once the caller actually reaches it.
    #
    # Read-only either way, so declaring it here opens no writable surface:
    # `read_only_fields` below already listed `cover_image`, and a
    # `SerializerMethodField` is inherently read-only.
    cover_image = serializers.SerializerMethodField()

    class Meta:
        model = AudioClip
        fields = ["id", "title", "creator_name", "category", "duration_ms", "tags", "cover_image"]
        read_only_fields = fields

    def get_cover_image(self, obj):
        # DEFECT B — the unauthenticated copy of the same bug, and the one that
        # actually reached an anonymous caller and a link unfurler. Same helper,
        # deliberately, so the two cannot drift apart again. Note this hook is
        # only live because of the `SerializerMethodField` declaration above.
        return _cover_image_url(obj)


class SkipActionSerializer(serializers.Serializer):
    listen_duration_ms = serializers.IntegerField(min_value=0, required=True)
    reel_position_ms = serializers.IntegerField(min_value=0, required=True)
    reel_id = serializers.UUIDField(required=True)

class ShareActionSerializer(serializers.Serializer):
    receiver_id = serializers.IntegerField(required=True)


class CommentSerializer(serializers.ModelSerializer):
    author_username = serializers.CharField(source='author.username', read_only=True)
    # A5 (2026-09-29). The username was exposed but not the id, so a client
    # could render a comment author as text but could not make them
    # tappable — there was no way to build a profile route from a comment
    # list response. Exposing the bare id (not the whole profile) keeps the
    # endpoint from becoming a user-enumeration surface: the app still has
    # to call GET /profile/{id}/ for anything richer.
    author_id = serializers.IntegerField(source='author.id', read_only=True)
    reply_count = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = ['id', 'clip', 'author_username', 'author_id', 'parent', 'text', 'reply_count', 'created_at']
        read_only_fields = ['id', 'author_username', 'author_id', 'reply_count', 'created_at']

    def get_reply_count(self, obj):
        if not obj.parent_id:
            return obj.replies.count()
        return 0

    def validate_text(self, value):
        # SECURITY: strip control characters (NUL, BEL, etc.) from
        # comment text before storage. The React frontend auto-escapes
        # JSON strings, so a stored `<script>` payload is rendered as
        # text — but defense-in-depth: reject obviously malicious
        # characters server-side too. Limit to 500 chars (model
        # CharField max_length) and reject NUL bytes which can break
        # downstream loggers.
        if '\x00' in value:
            raise serializers.ValidationError("Comment contains null bytes.")
        # Strip ASCII control characters except common whitespace (\t, \n, \r).
        cleaned = ''.join(
            ch for ch in value
            if ch >= ' ' or ch in '\t\n\r'
        )
        return cleaned.strip()

    def create(self, validated_data):
        validated_data['author'] = self.context['request'].user
        return super().create(validated_data)
    
class InteractionTelemetrySerializer(serializers.Serializer):
    action_type = serializers.ChoiceField(choices=['view', 'like', 'share', 'skip'])
    # SECURITY: cap watch_time_ms at 10 hours = 36,000,000ms. Anything
    # longer is a client bug or a viewbot inflating completion_rate.
    # Real short-form audio is < 5 min (300,000ms); 10h is a generous
    # upper bound for any legitimate use.
    watch_time_ms = serializers.IntegerField(min_value=0, max_value=36_000_000, required=True)

class ShareEventSerializer(serializers.ModelSerializer):
    sender_name = serializers.CharField(source='sender.username', read_only=True)
    clip_title = serializers.CharField(source='clip.title', read_only=True)
    # See FeedClipSerializer.get_hls_playlist_url — same reasoning: the model
    # field is a storage key, not a URL, so it must be signed here rather
    # than passed through as a plain CharField.
    clip_hls_url = serializers.SerializerMethodField()
    clip = FeedClipSerializer(read_only=True)

    def get_clip_hls_url(self, obj):
        return get_hls_playback_url(obj.clip.hls_playlist_url)
    
    class Meta:
        model = ShareEvent
        fields = [
            'id', 
            'sender_name', 
            'clip',
            'clip_title',
            'clip_hls_url',
            'created_at', 
            'is_read'
        ]


class RegisterSerializer(serializers.ModelSerializer):
    # ISSUE-01 (DPDP consent / age gate)
    # SECURITY: consent_accepted is required; without it registration
    # must fail. terms_version validated against allowed versions
    # from settings (default v1.0 from env).
    consent_accepted = serializers.BooleanField(required=True)
    terms_version = serializers.CharField(required=True, max_length=50)
    dob = serializers.DateField(required=False, allow_null=True)
    parent_email = serializers.EmailField(required=False, allow_null=True)
    # Ensure email is unique and required
    email = serializers.EmailField(
        required=True,
        validators=[UniqueValidator(queryset=User.objects.all())]
    )
    # B1 (2026-09-29): was `required=False, allow_null=True`, which made the
    # age gate advisory rather than enforced — a client that simply omitted
    # dob was registered as an adult, is_minor stayed False, and their
    # telemetry was processed under the adult path. DPDP §9 applies to
    # processing a child's data; the platform cannot know whether it is
    # doing that if the client controls whether it finds out. Optionality
    # was the bypass.
    dob = serializers.DateField(required=True)

    class Meta:
        model = User #built-in User model
        fields = ('username', 'password', 'email', 'consent_accepted', 'terms_version', 'dob', 'parent_email')
        # Ensure password is never returned in a GET request
        extra_kwargs = {
            'password': {'write_only': True}, 'email': {'write_only': True},
        }

    def validate_terms_version(self, value):
        allowed = getattr(settings, 'TERMS_VERSIONS', ['v1.0'])
        # A1 (2026-09-29): settings now strips whitespace when parsing
        # TERMS_VERSIONS, so a client sending "v1.0" is unaffected. This
        # strip is belt-and-braces for the *inbound* side: a client that
        # round-trips a value it read from elsewhere should not 400 over a
        # trailing space. The error message lists the canonical strings so a
        # client can correct itself from the 400 alone.
        if value.strip() not in allowed:
            raise serializers.ValidationError(f"Invalid terms version. Allowed: {allowed}")
        return value.strip()

    def _validate_password(self, data):
        """Run `settings.AUTH_PASSWORD_VALIDATORS` over the submitted password.

        W2-G (2026-09-30). Extracted from `validate()` so the call site reads
        as one step of the object-level gate rather than a wall of comments.

        Error shape: `{'password': [...]}`, i.e. field-level. The rest of this
        serializer reports on the offending field (`dob`, `parent_email`,
        `original_file`, `copyright_acknowledgement`) and a client that renders
        a field error next to its input is strictly better served than one
        that gets an unattributable `detail`. `Frontend/client.ts:166`
        flattens `Object.values(data).flat().join(" ")`, so it renders either
        shape — but the field key is what a form needs.

        Django's `ValidationError` is translated rather than propagated: DRF
        does not recognise it and would surface it as a 500.
        """
        password = data.get('password')
        if password is None:
            # `password` is a required model field, so DRF has already
            # rejected the request before `validate()` runs. Nothing to do,
            # and `validate_password(None, ...)` would raise something less
            # useful than the field error the client already has.
            return

        # Built from validated data, not `self.initial_data`: `initial_data`
        # is un-validated, and the similarity check must compare against the
        # values that will actually be stored.
        candidate = User(
            username=data.get('username') or '',
            email=data.get('email') or '',
            first_name=data.get('first_name') or '',
            last_name=data.get('last_name') or '',
        )
        try:
            password_validation.validate_password(password, user=candidate)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({'password': exc.messages})

    def validate(self, data):
        # DECISION: age < 18 requires a parent/guardian email and sets
        # is_minor. Tradeoff: extra validation vs. DPDP §9.
        #
        # B1 (2026-09-29) — two changes:
        #  * `dob` is now required, so the `if dob:` / `else:` split that let
        #    a client dodge the gate by omission is gone. The else branch set
        #    is_minor=False, which is precisely the bypass.
        #  * A future `dob` is rejected outright rather than clamping. A
        #    client sending 2030-01-01 is either a typo or someone trying to
        #    be born after the fact, and silently coercing it to an adult
        #    would hide a data-quality problem. Note this is also a
        #    minor-safety question: the adult path is the one with fewer
        #    restrictions, so it is the one worth refusing to guess at.
        from datetime import date

        # W2-G (2026-09-30) — AUTH_PASSWORD_VALIDATORS was dead code here.
        # `EchoFlow/settings.py:467-480` configures all four validators
        # (similarity, minimum length, common-password, numeric), but nothing
        # on the registration path ever called `validate_password`, so
        # `POST /auth/register/` accepted `password: "123"` and returned 201.
        # Django's `UserCreationForm` runs these through
        # `django.contrib.auth.password_validation`; a custom `ModelSerializer`
        # that overrides `create()` gets none of that for free.
        #
        # The `user=` argument is the part that is easy to get wrong and
        # silently wrong: `UserAttributeSimilarityValidator` iterates
        # `getattr(user, attr)` for username/first_name/last_name/email and
        # skips anything it cannot read, so a bare `validate_password(value)`
        # enforces three of the four rules and quietly does nothing about the
        # fourth. The unsaved `User` below is built from the *already
        # validated* data, so it carries the same username/email the row will
        # be created with. (SetPasswordForm passes the real instance for the
        # same reason; here there is no row yet.)
        self._validate_password(data)

        today = date.today()
        dob = data['dob']
        if dob > today:
            raise serializers.ValidationError(
                {"dob": "Date of birth cannot be in the future."}
            )
        # Constructed by subtracting days rather than via
        # today.replace(year=today.year - 120): replace() raises ValueError on
        # 29 Feb, so a leap-day "today" would turn this validation into a
        # 500 for every registration. timedelta arithmetic has no such edge.
        from datetime import timedelta

        if dob < today - timedelta(days=120 * 365):
            raise serializers.ValidationError(
                {"dob": "Date of birth is implausible (over 120 years ago)."}
            )

        age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        if age < 18:
            data['is_minor'] = True
            # HACK: minor_consent_verified is hardcoded False because there
            # is no parental-verification flow (no mail backend is
            # configured). The field exists so the intent is recorded and so
            # the telemetry gate has something to read, but nothing can set
            # it True yet.
            #
            # SECURITY: is_minor=True already gates telemetry downstream
            # (see the age gate in interactions.py), so the DPDP §9
            # behavioural-monitoring exposure is closed by is_minor alone.
            # minor_consent_verified is the stricter signal and will matter
            # when a verification flow exists.
            data['minor_consent_verified'] = False
            if not data.get('parent_email'):
                raise serializers.ValidationError(
                    {"parent_email": "Parent/guardian email is required for users under 18."}
                )
        else:
            data['is_minor'] = False
            data['minor_consent_verified'] = False
        return data

    def create(self, validated_data):
        # DECISION: Separate consent audit creation from user creation
        # so that consent records exist even if user creation rolls back.
        # Tradeoff: potential orphaned audit rows vs. guaranteed audit trail.
        consent_accepted = validated_data.pop('consent_accepted', False)
        terms_version = validated_data.pop('terms_version', 'v1.0')
        dob = validated_data.get('dob')
        parent_email = validated_data.get('parent_email')
        # Handle minor flow fields
        is_minor = validated_data.pop('is_minor', False)
        minor_consent_verified = validated_data.pop('minor_consent_verified', False)
        user = User.objects.create_user(
            username=validated_data['username'],
            email=validated_data['email'],
            password=validated_data['password'],
            dob=dob,
            parent_email=parent_email,
            is_minor=is_minor,
            minor_consent_verified=minor_consent_verified,
            consent_accepted=consent_accepted,
            terms_version=terms_version,
        )
        # ISSUE-01: Create ConsentAudit row for regulatory audit trail.
        # HACK: Writing audit on user creation in serializer rather than
        # signal so we have direct access to validated consent data.
        request = self.context.get('request')
        ConsentAudit.objects.create(
            user=user,
            terms_version_id=terms_version,
            privacy_version_id='v1.0',
            # SEC-FIX (2026-09-29, Group C): was
            # `request.META.get('REMOTE_ADDR')`, which behind nginx is the
            # nginx container's IP — so every consent record attributed the
            # notice to the proxy rather than the user. DPDP §5(1) requires
            # the notice to be attributable, and it also disagreed with
            # AuditLog's value for the same request, so the two audit
            # artifacts could not be reconciled.
            #
            # Shared helper, because CorrelationIdMiddleware had the same
            # defect with a subtler shape (REMOTE_ADDR checked *first*, making
            # its XFF fallback unreachable). See EchoFlow/client_ip.py.
            ip_address=get_client_ip(request),
            user_agent=request.META.get('HTTP_USER_AGENT', '')[:500] if request else '',
        )
        return user

class PublicProfileSerializer(serializers.ModelSerializer):
    """For viewing any user's profile"""
    followers_count = serializers.IntegerField(read_only=True)
    following_count = serializers.IntegerField(read_only=True)
    uploads_count = serializers.IntegerField(read_only=True)

    profile_picture_url = serializers.SerializerMethodField()
    is_following = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'profile_picture', 'profile_picture_url',
            'followers_count', 'following_count', 'uploads_count',
            'is_following', 'date_joined'
        ]


    def get_profile_picture_url(self, obj):
        if obj.profile_picture and obj.profile_picture.name:
            return get_signed_media_url(obj.profile_picture.name)
        return None

    def get_is_following(self, obj):
        """B2 — see `FeedClipSerializer.get_is_following`.

        The Profile page has its own follow button hitting the same blind
        toggle, so it needs the same honest state. Always False for your own
        profile, matching the endpoint's 400 on self-follow.
        """
        return _viewer_follows(request_user(self.context), obj)

class OwnProfileSerializer(serializers.ModelSerializer):
    """For the logged-in user's own profile — includes private data"""
    followers_count = serializers.IntegerField(read_only=True)
    following_count = serializers.IntegerField(read_only=True)
    uploads_count = serializers.IntegerField(read_only=True)
    liked_clips = serializers.SerializerMethodField()

    profile_picture_url = serializers.SerializerMethodField()
    # B2. Always False for your own profile, but the field is declared so the
    # client can read one shape off both profile endpoints and never has to
    # branch on which one it got.
    is_following = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'profile_picture', 'profile_picture_url',
            'followers_count', 'following_count', 'uploads_count',
            'liked_clips', 'is_following', 'date_joined'
        ]


    def get_profile_picture_url(self, obj):
        if obj.profile_picture and obj.profile_picture.name:
            return get_signed_media_url(obj.profile_picture.name)
        return None

    def get_is_following(self, obj):
        return False

    def get_liked_clips(self, obj):
        # N7 fix: query AudioClip directly with the user_has_liked
        # annotation, so FeedClipSerializer.get_is_liked() hits the
        # fast hasattr branch (no per-clip query).
        request = self.context.get('request') if hasattr(self, 'context') else None
        viewer = request.user if request and request.user.is_authenticated else None
        user_like_subquery = UserInteraction.objects.filter(
            clip=OuterRef('pk'),
            user=obj,
            interaction_type='like',
            is_active=True,
        )
        liked_clips = (
            AudioClip.objects
            .filter(
                # FIX (2026-09-29, found while doing B2): the reverse
                # accessor is `userinteraction`, not `interactions`.
                # `UserInteraction.clip` declares no `related_name`
                # (models.py:256), so Django derives the name from the model
                # and lowercases it. `interactions__*` therefore raises
                # FieldError, which made `GET /profile/me/` return 500 for
                # *every* authenticated user — the primary profile endpoint
                # was entirely non-functional, and no test covered it.
                # `order_by('-userinteraction__updated_at')` below was wrong
                # for the same reason.
                userinteraction__user=obj,
                userinteraction__interaction_type='like',
                userinteraction__is_active=True,
            )
            .annotate(user_has_liked=Exists(user_like_subquery))
            # B2: same one-query-per-page treatment as views/feed.py and
            # views/profile.py. `viewer`, not `obj` — the follow state that
            # matters is the request's, not the profile owner's.
            .annotate(**following_annotation(viewer))
            .distinct()
            .order_by('-userinteraction__updated_at')[:50]
        )
        return FeedClipSerializer(
            liked_clips, many=True, context=self.context
        ).data

class ProfileUpdateSerializer(serializers.ModelSerializer):
    """For PATCH — only editable fields exposed.

    SECURITY (B1): the avatar upload was completely unbounded. Any
    authenticated user could POST an arbitrarily large file to object storage.
    The audio path has had an explicit `MAX_SIZE` since Group C item 23
    (`AudioUploadSerializer.MAX_SIZE`); the avatar path had none, and
    `Frontend/src/pages/Profile.tsx` labels the field "Max 5MB" while
    enforcing nothing on either side.

    Two checks only, and it is worth being precise about why there is no
    third. This field is `models.ImageField` (`models.py:55`), which DRF maps
    to `serializers.ImageField`; that already calls Pillow's full
    `Image.open()` + `verify()`, so *content* is validated by an actual decode
    attempt, which is strictly stronger than a magic-byte sniff — a renamed
    `evil.exe` cannot pass it. `serializers.py:_BLOCKED_MAGIC_SIGNATURES` is
    needed for audio because audio has many valid headers and block-listing is
    the only tractable rule; an avatar has three, but Pillow already covers
    them, so a hand-rolled header check here would be redundant surface.

    Django's `ImageField` sets no size limit, and an upload is spooled to a
    temp file rather than held in memory, so `DATA_UPLOAD_MAX_MEMORY_SIZE`
    does not apply. The explicit cap below is therefore the whole fix.
    """
    MAX_SIZE = 5 * 1024 * 1024  # 5 MB
    ALLOWED_EXT = {'.jpg', '.jpeg', '.png', '.webp'}

    class Meta:
        model = User
        fields = ['username', 'profile_picture']

    def validate_username(self, value):
        user = self.context['request'].user
        if User.objects.exclude(pk=user.pk).filter(username=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value

    def validate_profile_picture(self, value):
        if value is None:
            return value
        if value.size > self.MAX_SIZE:
            raise serializers.ValidationError(
                f"Image exceeds {self.MAX_SIZE // 1024 // 1024}MB limit."
            )
        ext = os.path.splitext(value.name)[1].lower()
        if ext not in self.ALLOWED_EXT:
            raise serializers.ValidationError(
                f"Unsupported image type: {ext}. "
                f"Allowed: {', '.join(sorted(self.ALLOWED_EXT))}"
            )
        return value


class SubscriptionStatusSerializer(serializers.Serializer):
    # SELF-SCOPED. `app_user_id` is the authenticated user's own RevenueCat
    # App User ID and nothing else — it is the identity a client passes to the
    # RevenueCat SDK, so it must be readable here and ONLY here.
    #
    # It is deliberately absent from every other serializer in this file
    # (OwnProfileSerializer, PublicProfileSerializer, the feed/comment/clip
    # serializers). `User.revenuecat_app_user_id` is not in any `Meta.fields`,
    # so the only way it can reach a response body is through an explicit
    # declaration like this one. `test_revenuecat.py::TestAppUserIdIsSelfScoped`
    # pins that: it asserts a second user's id never appears in this payload and
    # that the public/feed surfaces do not carry the field at all.
    app_user_id = serializers.UUIDField()
    is_pro = serializers.BooleanField()
    expires_at = serializers.DateTimeField(allow_null=True)
    grace_until = serializers.DateTimeField(allow_null=True)
    last_synced = serializers.DateTimeField()
    limits = serializers.DictField(child=serializers.CharField())
