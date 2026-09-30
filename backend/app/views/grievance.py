"""Grievance endpoint for ISSUE-03 (DPDP grievance / compliance)."""
from rest_framework import generics, permissions, serializers, status, throttling
from rest_framework.response import Response
from django.utils import timezone
from datetime import timedelta
from ..models import Grievance  # will import from models

from .legal import (
    EMAIL_MAX_LENGTH,
    FREE_TEXT_MAX_LENGTH,
    SUBJECT_MAX_LENGTH,
    flatten_serializer_errors,
)


class GrievanceCreateSerializer(serializers.Serializer):
    """Input validation for ``POST /grievance/``.

    R5-06. The view created rows straight from ``request.data``
    (``# HACK: Direct model creation to avoid extra serializer file.``), so
    an ``AllowAny`` caller at 10 requests/hour could reach Postgres with
    values the columns cannot hold:

    * ``subject`` is ``varchar(200)``; one character more raised
      ``StringDataRightTruncation``.
    * ``user_email`` is ``varchar(254)``; the same.
    * ``description`` is an unbounded ``TextField`` with no length check.

    The bounds and their reasoning are in ``views/legal.py``, which owns the
    shared constants; ``SUBJECT_MAX_LENGTH`` and ``EMAIL_MAX_LENGTH`` come from
    the model definitions and ``FREE_TEXT_MAX_LENGTH`` is the same number the
    takedown endpoint uses for the same class of field.

    Requiredness is deliberately unchanged from the previous behaviour: an
    anonymous complainant who supplies no address is still recorded, because
    refusing to accept a complaint is a worse failure under IT Rules 2021
    R3(2) than storing a null ``user_email``. What is new is that a *supplied*
    address must be a real one.
    """

    # Reject over-length rather than truncating: ``subject`` is the operator's
    # queue key. A silently cut title is a complaint filed against the wrong
    # thing, and the complainant has no way to notice.
    subject = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=SUBJECT_MAX_LENGTH,
    )
    description = serializers.CharField(
        required=False,
        allow_blank=True,
        max_length=FREE_TEXT_MAX_LENGTH,
    )
    user_email = serializers.EmailField(
        required=False,
        allow_blank=True,
        max_length=EMAIL_MAX_LENGTH,
    )


class GrievanceCreateView(generics.CreateAPIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [throttling.ScopedRateThrottle]
    throttle_scope = 'grievance'
    serializer_class = GrievanceCreateSerializer

    def get_queryset(self):
        return Grievance.objects.all()

    def create(self, request, *args, **kwargs):
        # ISSUE-03: Accept grievance and create DB row; automated 24h acknowledgment.
        #
        # R5-06: validated before the write. ``request.data.copy()`` and the
        # ad-hoc ``serializer_class = None`` are gone — the serializer is the
        # view's ``serializer_class`` and does the work.
        serializer = self.get_serializer(data=request.data)
        if not serializer.is_valid():
            # ``CreateAPIView`` would render this as a nested
            # ``{field: [messages]}`` body, which is a third response shape in
            # this cluster. Flattened to ``{"error": "<string>"}`` to match
            # ``legal.py`` and what ``client.ts:164-165`` parses.
            return Response(
                {"error": flatten_serializer_errors(serializer.errors)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        data = serializer.validated_data

        # Set acknowledgment due to 24h from now
        acknowledgment_due = timezone.now() + timedelta(hours=24)
        user = request.user if request.user.is_authenticated else None
        grievance = Grievance.objects.create(
            subject=data.get('subject', ''),
            description=data.get('description', ''),
            user=user,
            user_email=data.get('user_email') or (user.email if user else None),
            status='received',
            acknowledgment_due=acknowledgment_due,
        )
        return Response({
            'grievance_id': grievance.id,
            'status': grievance.status,
            'acknowledgment_due': acknowledgment_due,
            'message': 'Grievance received. Acknowledgment within 24 hours.',
        }, status=status.HTTP_201_CREATED)
