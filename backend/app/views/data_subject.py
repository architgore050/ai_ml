"""Data-subject rights controller (ISSUE-06)."""
from rest_framework import generics, permissions, status, serializers, throttling
from rest_framework.response import Response
from django.utils import timezone
from django.db import transaction
from datetime import timedelta
from django.contrib.auth import get_user_model
from ..models import DataSubjectRequest, UserInteraction, Comment, ShareEvent
from ..services.task_publisher import publish
from ..tasks import execute_data_erasure

User = get_user_model()


class DataSubjectAccessSerializer(serializers.Serializer):
    pass


class DataSubjectAccessView(generics.GenericAPIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [throttling.ScopedRateThrottle]
    throttle_scope = 'data_subject'

    def get(self, request, *args, **kwargs):
        # ISSUE-06: Return full personal data categories for the user.
        user = request.user
        categories = {
            'profile': {
                'username': user.username,
                'email': user.email,
                'dob': user.dob,
                'is_minor': user.is_minor,
                'consent_accepted': user.consent_accepted,
                'terms_version': user.terms_version,
                'parent_email': user.parent_email,
            },
            'interactions_count': UserInteraction.objects.filter(user=user).count(),
            'comments_count': Comment.objects.filter(author=user).count(),
            'shares_sent_count': ShareEvent.objects.filter(sender=user).count(),
            'audio_clips_created': user.audio_clips.count() if hasattr(user, 'audio_clips') else 0,
        }
        return Response({
            'user_id': user.id,
            'categories': categories,
        })


class DataSubjectErasureSerializer(serializers.Serializer):
    confirm = serializers.BooleanField(required=True)


class DataSubjectErasureView(generics.GenericAPIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [throttling.ScopedRateThrottle]
    throttle_scope = 'data_subject'

    def post(self, request, *args, **kwargs):
        # ISSUE-06: 30-day cooling-off erasure enforced properly.
        # DECISION: Only create/update request if cooling-off hasn't passed;
        # actual deletion only triggered after period ends (v1: manual/deferred).
        # SECURITY: Prevents premature data destruction; ensures DPDP §14 compliance.
        user = request.user
        if not request.data.get('confirm'):
            return Response({
                'detail': 'Confirmation required. Set confirm=true to proceed.',
            }, status=status.HTTP_400_BAD_REQUEST)
        from ..models import DataSubjectRequest
        # Check existing request
        existing = DataSubjectRequest.objects.filter(user=user, request_type='erasure').first()
        if existing:
            if timezone.now() < existing.cooling_off_until:
                remaining = (existing.cooling_off_until - timezone.now()).days
                return Response({
                    'detail': f'Cooling-off period active. {remaining} day(s) remaining before erasure can proceed.',
                    'request_id': existing.id,
                    'status': existing.status,
                    'cooling_off_until': existing.cooling_off_until,
                }, status=status.HTTP_403_FORBIDDEN)
            else:
                # B3 (2026-09-29): the cooling-off has passed, so actually
                # arrange the deletion.
                #
                # Previously this set status='completed', stamped
                # completed_at, and returned "Data erasure process initiated."
                # — having deleted nothing. That is the worst possible
                # combination: the user is told their data is gone (so keeps
                # no copy) and a regulator query surfaces the claim as a
                # representation. The HACK comment said the work was deferred
                # to a task pipeline; the task now exists.
                #
                # status stays 'in_progress' and is set to 'completed' by
                # execute_data_erasure when it finishes. Claiming completion
                # here would reintroduce the same lie one layer down.
                existing.status = 'in_progress'
                existing.save(update_fields=['status'])

                publish(execute_data_erasure, int(user.id))

                return Response({
                    'request_id': existing.id,
                    'status': 'in_progress',
                    'message': (
                        'Cooling-off period complete. Erasure has been '
                        'scheduled. Your account, clips, comments, shares, '
                        'interactions and uploaded media will be deleted. '
                        'Consent, audit and grievance records are retained '
                        'with your identity removed, as required by the DPDP '
                        'Act 2023 and CERT-In 2022.'
                    ),
                    'cooling_off_until': existing.cooling_off_until,
                })
        # Create new erasure request with 30-day cooling off.
        req, _ = DataSubjectRequest.objects.get_or_create(
            user=user,
            request_type='erasure',
            defaults={
                'status': 'pending',
                'cooling_off_until': timezone.now() + timedelta(days=30),
            }
        )
        req.status = 'pending'
        req.cooling_off_until = timezone.now() + timedelta(days=30)
        req.save()
        return Response({
            'request_id': req.id,
            'status': req.status,
            'cooling_off_until': req.cooling_off_until,
            'message': 'Erasure request submitted with 30-day cooling-off period.',
        })
