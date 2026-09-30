"""Legal / compliance endpoints for DPDP readiness (ISSUE-03)."""
from rest_framework import generics, permissions, serializers, throttling
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


#: ``Grievance.subject`` / ``Report.title`` are ``varchar(200)``.
SUBJECT_MAX_LENGTH = 200
#: ``EmailField`` is ``varchar(254)`` in both ``TakedownRequest`` and
#: ``Grievance``. Validated here, before the write, rather than left to
#: Postgres.
EMAIL_MAX_LENGTH = 254
#: ``TakedownRequest.reason`` is an unbounded ``TextField`` written by an
#: ``AllowAny`` caller at 30 requests/hour/IP, so it grows without limit and
#: the throttle is the only control on it (and the throttle is per-IP, so a
#: distributed caller is not bounded at all).
#:
#: Why 10,000 and not the 4,000 that ``views/content.py`` uses for the
#: ``Report.content`` append path: a rights holder's takedown statement is
#: routinely longer than a bug report — ownership claim, the infringing work,
#: the basis for the claim, prior licensing history. 4,000 characters is about
#: 600 words, which is tight for that. 10,000 is still ~10 KB of text per row
#: against a 1 GB TOAST limit, and it is 2.5x the repo's own existing cap.
#:
#: Rejected, not truncated: an operator acting on a sentence that stops
#: mid-clause is a worse outcome than a 400 the caller can see and retry.
FREE_TEXT_MAX_LENGTH = 10_000


class TakedownRequestSerializer(serializers.Serializer):
    """Input validation for ``POST /legal/takedown/``.

    R5-06. This endpoint is ``AllowAny`` — IT Rules 2021 R3(1)(b) obliges us
    to receive complaints from the public — and it used to write
    ``request.data`` straight into ``TakedownRequest.objects.create()``,
    bypassing every serializer. Three consequences, all of them live 500s any
    remote caller could trigger for free:

    * ``clip_id`` reached ``AudioClip.objects.get(id=...)`` unvalidated, so a
      non-UUID raised ``django.core.exceptions.ValidationError`` — which is
      **not** ``AudioClip.DoesNotExist`` and so slipped past the ``except``
      beside it.
    * ``requester_email`` went into ``varchar(254)`` unchecked, so an
      over-length value raised ``StringDataRightTruncation``. It was never
      validated as an email either, so *any* string was accepted.
    * ``reason`` was an unbounded ``TextField`` from an anonymous caller.

    The serializer lives here rather than in ``app/serializers.py`` for the
    same reason ``views/data_subject.py`` defines its own: this is a
    self-contained regulatory endpoint and a whole-file move of the
    serializers module is not something a security fix should drag along.

    Requiredness is deliberately unchanged. ``requester_email`` stays optional
    and blank-acceptable because the view has always defaulted it to ``''``;
    the model declares the field non-blank (``EmailField()`` with no
    ``blank=True``) and that tension is an owner decision about whether an
    unactionable complaint should be accepted at all, not an input-validation
    question. What changed is that a *present* address must now be a real one.
    """

    # A UUIDField both validates the shape and hands back a ``uuid.UUID``, so
    # the ORM lookup below can no longer raise. DRF accepts the same formats
    # Django's UUIDField does, so a client that was previously served is still
    # served.
    clip_id = serializers.UUIDField(required=True)

    # ``allow_blank=False`` (the default) means a missing ``reason`` is a 400
    # rather than a row with an empty statement.
    reason = serializers.CharField(required=True, max_length=FREE_TEXT_MAX_LENGTH)

    requester_email = serializers.EmailField(
        required=False,
        allow_blank=True,
        max_length=EMAIL_MAX_LENGTH,
    )


def flatten_serializer_errors(error) -> str:
    """Render DRF's ``{field: [messages]}`` into one human-readable string.

    The response shape stays ``{"error": "<string>"}`` — the one these two
    view modules already used (``legal.py`` emitted it for its own 400s) and
    the one ``frontend/src/api/client.ts:164-165`` reads after ``detail``.
    A dict would render as ``[object Object]`` in the ``new Error()`` the
    client builds from it, so the fields are flattened rather than nested.
    """
    if isinstance(error, dict):
        return '; '.join(
            f'{field}: {" ".join(str(m) for m in messages)}'
            for field, messages in error.items()
        )
    return str(error)


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
        # R5-06: validate before the write. The serializer is the single
        # place the bounds live; nothing below re-checks them, and no
        # malformed body reaches ``objects.create()``.
        serializer = TakedownRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {"error": flatten_serializer_errors(serializer.errors)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        clip_id = serializer.validated_data['clip_id']

        try:
            clip = AudioClip.objects.get(id=clip_id)
        except AudioClip.DoesNotExist:
            # 404, preserved on purpose. The request was well formed and named
            # a real, addressable namespace (clip PKs); the row simply is not
            # there. See the note below on what this still leaks.
            return Response({"error": "Clip not found."}, status=status.HTTP_404_NOT_FOUND)
        TakedownRequest.objects.create(
            clip=clip,
            reason=serializer.validated_data['reason'],
            requester_email=serializer.validated_data.get('requester_email', ''),
            status='pending',
        )
        return Response({
            "status": "received",
            "message": "Takedown request recorded. You will receive acknowledgment within 24 hours.",
            "clip_id": str(clip.id),
        }, status=status.HTTP_201_CREATED)


# OPEN FINDING — unauthenticated clip-existence oracle (NOT closed by this fix)
# ---------------------------------------------------------------------------
# ``POST /legal/takedown/`` answers 404 for a well-formed UUID that matches no
# row and 201 for one that does, with no authentication, at 30 requests/hour/IP.
# That is an existence oracle over the whole clip catalogue. It was reported as
# part of R5-06 and is deliberately left in place here, for reasons that are
# regulatory rather than technical:
#
#   * IT Rules 2021 R3(1)(b)/(2) oblige us to *receive and categorise* every
#     complaint. A takedown naming a clip that has since been deleted is still
#     a complaint, and R5-13 shows the clip row is ``on_delete=CASCADE`` — the
#     operator may be the only remaining record that anyone complained at all.
#     Answering a fake 201 for a non-existent clip would record nothing, so the
#     fix for the oracle would be a fix that destroys the complaint.
#   * The cheap version of closing it (one 400/201 shape) is trivially
#     defeated anyway: an attacker who can reach a public feed already has
#     clip UUIDs, and 30/hour/IP is not a bound a distributed caller respects.
#
# The real control is R5-12 (verify ``requester_email``) plus a per-address
# submission cap, both of which need an owner decision. This note is here so
# the next reader does not mistake the 404 for an oversight.

