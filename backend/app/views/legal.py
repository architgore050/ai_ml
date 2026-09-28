"""Legal / compliance endpoints for DPDP readiness (ISSUE-03)."""
from rest_framework import generics, permissions, throttling
from rest_framework.response import Response
from django.conf import settings


class ComplianceContactView(generics.GenericAPIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [throttling.ScopedRateThrottle]
    throttle_scope = 'legal'

    def get(self, request, *args, **kwargs):
        # ISSUE-03: Return compliance / grievance / nodal officer info.
        # DECISION: Read from settings/env rather than DB table for
        # simplicity (single source of truth, easy to rotate without migration).
        # Tradeoff: Requires deploy to update vs. admin-editable DB row.
        return Response({
            'compliance_officer': {
                'name': getattr(settings, 'COMPLIANCE_OFFICER_NAME', 'Not configured'),
                'email': getattr(settings, 'COMPLIANCE_OFFICER_EMAIL', ''),
            },
            'grievance_officer': {
                'name': getattr(settings, 'GRIEVANCE_OFFICER_NAME', 'Not configured'),
                'email': getattr(settings, 'GRIEVANCE_OFFICER_EMAIL', ''),
            },
            'nodal_contact': {
                'name': getattr(settings, 'NODAL_CONTACT_NAME', 'Not configured'),
                'email': getattr(settings, 'NODAL_CONTACT_EMAIL', ''),
            },
            # A1 (2026-09-29): the registration contract has to be
            # discoverable. RegisterSerializer.terms_version is required and
            # validated against settings.TERMS_VERSIONS, so a client that
            # cannot read that list has to hardcode a version and will 400
            # the day a new one is appended. Publishing it here — on an
            # AllowAny endpoint that already exists — is what removes the
            # guesswork. IT Rules 2021 R4(4) also requires the terms/privacy
            # text to be reachable without an account, so the version list
            # belongs next to the officer contacts rather than behind auth.
            'terms_versions': list(getattr(settings, 'TERMS_VERSIONS', ['v1.0'])),
            'current_terms_version': (
                # The last entry is the one in force, so appending a version
                # to TERMS_VERSIONS is the whole deploy step — no second
                # variable to forget to update.
                list(getattr(settings, 'TERMS_VERSIONS', ['v1.0']))[-1]
            ),
            'privacy_version': getattr(settings, 'PRIVACY_VERSION', 'v1.0'),
            # Consumer Protection (E-Commerce) Rules 2020 requires a
            # physical address on the site. Previously read into settings
            # but served nowhere, so it was configured-and-invisible.
            'physical_address': getattr(settings, 'PHYSICAL_ADDRESS', ''),
        })

from rest_framework import status
from ..models import TakedownRequest, AudioClip

class TakedownRequestView(generics.GenericAPIView):
    """POST /legal/takedown/ endpoint for copyright owner-facing takedown.

    ISSUE-05: Uses TakedownRequest model (Agent 1 added) linked to AudioClip.
    DECISION: Minimal v1 endpoint — accepts reason, requester_email, clip_id.
    A production system should include counter-notice support, verification,
    and automated acknowledgment timelines.
    """
    permission_classes = [permissions.AllowAny]
    throttle_classes = [throttling.ScopedRateThrottle]
    throttle_scope = 'legal'

    def post(self, request, *args, **kwargs):
        clip_id = request.data.get('clip_id')
        reason = request.data.get('reason', '')
        requester_email = request.data.get('requester_email', '')
        if not clip_id or not reason:
            return Response({"error": "clip_id and reason are required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            clip = AudioClip.objects.get(id=clip_id)
        except AudioClip.DoesNotExist:
            return Response({"error": "Clip not found."}, status=status.HTTP_404_NOT_FOUND)
        TakedownRequest.objects.create(
            clip=clip,
            reason=reason,
            requester_email=requester_email,
            status='pending',
        )
        return Response({
            "status": "received",
            "message": "Takedown request recorded. You will receive acknowledgment within 24 hours.",
            "clip_id": str(clip.id),
        }, status=status.HTTP_201_CREATED)
