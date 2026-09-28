"""Content/ingestion view: audio upload.

Stage 2 (relational-to-event-driven plan): the transaction.on_commit
dispatch into Celery is owned by services.uploads.finalize_upload.
"""
from rest_framework import viewsets, permissions, parsers, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from ..models import AudioClip, Report, TakedownRequest
from ..services import content_moderation as moderation_svc
from ..services import uploads as uploads_svc

from ..models import AudioClip
from ..serializers import AudioUploadSerializer, FeedClipSerializer
from ..services import uploads as uploads_svc


class AudioUploadViewSet(viewsets.ModelViewSet):
    # SECURITY: 20 uploads/hour/user prevents storage-abuse DoS. Each upload
    # is up to 100 MB (AudioUploadSerializer.MAX_SIZE), so default DRF
    # 1000/hour/user would let one account push 100 GB/hour.
    throttle_scope = 'upload'
    queryset = AudioClip.objects.all()
    serializer_class = AudioUploadSerializer
    permission_classes = [permissions.IsAuthenticated]
    # B4 (2026-09-29): JSONParser added because the viewset is
    # multipart-only for uploads, which meant `/clips/{id}/report/` answered
    # **415 Unsupported Media Type** to every JSON client — the endpoint was
    # effectively callable only with form data.
    #
    # Not scoped to the actions that need it, because per-action parsers
    # cannot be selected here: `APIView.initialize_request` calls
    # `get_parsers()`, and `ViewSetMixin.initialize_request` only sets
    # `self.action` *after* delegating to it, so `self.action` is always None
    # during parser selection. Reaching for it would silently no-op.
    #
    # Safe to add viewset-wide: a JSON body cannot carry a real file, so
    # `original_file` fails in the serializer ("The submitted data was not a
    # file data") and a bad upload gets a 400 that names the missing file —
    # clearer than the 415 it replaces. Size, MIME and magic-byte validation
    # are unaffected because they only run once a real file is present.
    parser_classes = [
        parsers.MultiPartParser,
        parsers.FormParser,
        parsers.JSONParser,
    ]

    def get_queryset(self):
        # For moderation endpoints, operators may need broader access.
        # We keep user-scoped by default but allow override for actions.
        return AudioClip.objects.filter(creator=self.request.user)

    def create(self, request, *args, **kwargs):
        # Pro gating: check daily upload limit for free users BEFORE
        # serializer validation to fail fast (no wasted work on files
        # that would be rejected).
        if not request.user.is_pro():
            from django.conf import settings as django_settings
            from django.utils import timezone
            from rest_framework.exceptions import PermissionDenied
            daily_limit = getattr(django_settings, "REVENUECAT_DAILY_UPLOAD_LIMIT_FREE", 5)
            today = timezone.now().date()
            created_today = AudioClip.objects.filter(
                creator=request.user, created_at__date=today
            ).count()
            if created_today >= daily_limit:
                raise PermissionDenied(
                    f"Free tier limit of {daily_limit} daily uploads reached. "
                    "Upgrade to Pro for unlimited uploads."
                )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        clip = serializer.save()

        uploads_svc.finalize_upload(clip)

        headers = self.get_success_headers(serializer.data)
        return Response(
            {
                "message": "Audio uploading and processing in background.",
                "clip_id": clip.id,
                "status": clip.status
            },
            status=status.HTTP_202_ACCEPTED,
            headers=headers,
        )

    def update(self, request, *args, **kwargs):
        # N8 fix: PATCH/PUT on a clip must NOT replace original_file.
        # The previous approach (read_only_fields at serializer level)
        # broke the legitimate upload flow because read_only_fields
        # applies to BOTH create and update. Instead: at update time,
        # strip the file from the request data BEFORE the serializer
        # runs. A user who wants to replace their file must delete
        # the clip and re-upload via POST.
        if 'original_file' in request.data:
            # request.data is a QueryDict (immutable). Make a mutable copy
            # and replace the request's internal _full_data so the
            # serializer sees the file-stripped version.
            data = request.data.copy()
            data.pop('original_file')
            request._full_data = data
        return super().update(request, *args, **kwargs)

    @action(detail=True, methods=['post'], url_path='approve-moderation', permission_classes=[permissions.IsAuthenticated])
    def approve_moderation(self, request, pk=None):
        """Operator-facing endpoint to approve moderation for a clip.

        ISSUE-04: Manual moderation approval for v1. After passing,
        HLS processing is triggered.

        SEC-FIX (2026-09-29, Group C): the lookup was
        ``get_object_or_404(AudioClip, pk=pk)`` — unscoped, which silently
        bypassed ``get_queryset()`` (creator-scoped). So **any** authenticated
        user could approve **any** clip, on someone else's upload. That is a
        moderation bypass (it is the step that sets moderation_approved and
        triggers HLS encoding) and a compute-abuse vector, and the old
        docstring admitted it: "For v1, any authenticated user can approve
        (simplified)."

        Now owner-or-staff. Owner is permitted because the mobile upload flow
        self-approves its own clip — that is the current v1 workflow, and
        denying it would leave uploads permanently stuck in `processing` until
        a human looked at them.

        HONEST LIMITATION: with the owner allowed, moderation is not a gate.
        A user can upload, self-approve, and be published after only the
        keyword checks in services/content_moderation.py run. That is the
        accepted v1 state, and this change narrows the abuse surface (from
        anyone to the uploader) without pretending to more. Making it a real
        gate needs either a human review queue or a classifier — the content
        decision tracked as ISSUE-04, not a scoping fix.
        """
        if request.user.is_staff:
            clip = get_object_or_404(AudioClip, pk=pk)
        else:
            # 404 rather than 403 for someone else's clip: a 403 would
            # confirm the clip exists, and UUIDs are the only identifier here.
            clip = get_object_or_404(
                AudioClip.objects.filter(creator=request.user), pk=pk
            )
        approved, reason = moderation_svc.run_moderation_check(clip.id)
        # Reload clip from DB so moderation_approved reflects the update.
        clip.refresh_from_db()
        if approved:
            # Enqueue HLS processing after approval.
            uploads_svc.trigger_hls_processing(clip)
            return Response({
                "status": "approved",
                "message": "Moderation approved. HLS processing started.",
                "clip_id": clip.id,
                "moderation_approved": clip.moderation_approved,
            }, status=status.HTTP_200_OK)
        else:
            return Response({
                "status": "rejected",
                "message": "Moderation check failed.",
                "reason": reason,
                "clip_id": clip.id,
                "moderation_approved": False,
            }, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], url_path='report', permission_classes=[permissions.IsAuthenticated])
    def report_clip(self, request, pk=None):
        """User-facing endpoint to report a clip.

        B4 (2026-09-29): this previously created a Report with no link to the
        clip and no reason, so the report was unactionable — an operator queue
        could not tell what was reported or triage it. IT Rules 2021 R3(1)(b)
        requires categorised complaint handling.

        The clip FK and the IT Rules-aligned reason enum are now populated and
        validated, and duplicate reports from the same user are collapsed
        (matching the partial unique constraint on the model).
        """
        clip = get_object_or_404(AudioClip, pk=pk)

        reason = request.data.get('report_reason', '')
        valid_reasons = {code for code, _label in Report.REPORT_REASONS}
        if reason not in valid_reasons:
            return Response(
                {
                    "report_reason": [
                        f"Invalid report reason. Allowed: {sorted(valid_reasons)}"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        content = (request.data.get('content') or '').strip()
        if not content:
            # The body is the only free-text a moderator has, so an empty one
            # is useless. Requiring it also forces the "other" bucket to
            # carry an explanation.
            return Response(
                {"content": ["Please describe the problem."]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        title = request.data.get('title') or f"Report: {reason.replace('_', ' ')}"

        # SECURITY: a user must not be able to file a report that is
        # attributed to somebody else. `user` comes from the token, never the
        # body. Reported here as well as enforced at the model, because
        # get_or_create is what makes the duplicate collapse safe.
        report, created = Report.objects.get_or_create(
            user=request.user,
            clip=clip,
            defaults={
                'title': title[:200],
                'content': content,
                'report_reason': reason,
                'status': 'open',
            },
        )
        if not created:
            # Append the new detail to the existing report rather than
            # silently discarding it — the user did tell us something.
            existing = (report.content or '')
            separator = '\n\n' if existing else ''
            report.content = (existing + separator + content)[:4000]
            report.save(update_fields=['content'])

        return Response({
            "status": "reported",
            "message": "Your report has been recorded.",
            "clip_id": clip.id,
            "report_id": report.id,
            "duplicate": not created,
        }, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='public', permission_classes=[permissions.AllowAny])
    def public_view(self, request, pk=None):
        """Public clip view endpoint — ISSUE-14. Only shows approved clips."""
        # SECURITY / REGULATORY: Filter moderation_approved for public access.
        # DECISION: Using queryset filter rather than exception — avoids
        # leaking clip existence via 404 vs 403 distinction.
        clip = get_object_or_404(AudioClip.objects.filter(moderation_approved=True), pk=pk)
        serializer = FeedClipSerializer(clip, context={'request': request})
        return Response(serializer.data)
