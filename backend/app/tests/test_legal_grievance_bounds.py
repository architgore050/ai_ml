"""R5-06 — unauthenticated 500s on ``POST /legal/takedown/`` and ``POST /grievance/``.

Both endpoints are ``AllowAny`` (IT Rules 2021 requires the grievance and
complaint channels to be reachable without an account) and both wrote
``request.data`` straight into ``objects.create()``, bypassing every
serializer. Three separate defects followed from that, each of which an
unauthenticated caller could trigger from any address at 30/hour and 10/hour
respectively:

1. ``legal.py`` did ``AudioClip.objects.get(id=clip_id)``. A non-UUID raises
   ``django.core.exceptions.ValidationError``, which is **not**
   ``AudioClip.DoesNotExist``, so the ``except`` beside it never fired.
2. ``requester_email`` / ``user_email`` went into an ``EmailField``
   (``varchar(254)``) unchecked — over-length raised
   ``StringDataRightTruncation``, and nothing validated them as emails at all.
3. ``subject`` (``varchar(200)``) over-length raised the same way, and
   ``description`` / ``reason`` (``TextField``) were unbounded free text from
   an anonymous caller.

The 500 is the defect, not the cosmetics of it: a remote caller gets one 500
per request from every IP, each raises a Sentry event, and the
500-vs-400-vs-404 split is an error oracle (the 404-vs-201 split is a separate,
*unfixed* existence oracle — see the module note in ``legal.py``).

The bounds asserted here are the contract. They are spelled out as literals
rather than imported from the views so that changing a bound is a visible
edit to this file, not a silent self-fulfilling assertion.

Test-isolation note
-------------------
These endpoints are throttled (``legal`` 30/hour, ``grievance`` 10/hour) and
DRF keys every bucket on ``get_ident(request)``. ``NUM_PROXIES`` is unset, so
DRF takes the last ``X-Forwarded-For`` entry when the header is present. The
``isolated_throttle_budget`` fixture therefore gives each test its own
documentation-range address (RFC 5737 ``198.51.100.0/24``).

It deliberately does **not** use the conftest ``clear_throttle_cache``
fixture, which does a global ``cache.clear()``: that would flush the shared
Redis under the other concurrently-running test sessions, taking out their
throttle budgets and their ``user_feed:*`` / ``user_vectors:*`` keys with it.
Per-test addresses isolate just this file and touch nothing shared.
"""
import hashlib
import uuid

import pytest
from django.urls import reverse
from rest_framework import serializers
from rest_framework.test import APIClient

from backend.app.models import Grievance, TakedownRequest

pytestmark = pytest.mark.django_db


# The contract. See the module docstring.
SUBJECT_MAX = 200        # Grievance.subject — models.CharField(max_length=200)
EMAIL_MAX = 254          # Grievance.user_email / TakedownRequest.requester_email — EmailField
FREE_TEXT_MAX = 10_000   # Grievance.description / TakedownRequest.reason — TextField

#: Values a text field must reject outright. See ``TestDRFCoercionIsNotAHole``
#: for why numbers are absent.
REJECTED_TEXT = [
    ['a', 'list'],
    {'nested': 'object'},
    True,
]


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolated_throttle_budget(request):
    """Give each test its own DRF throttle bucket. See the module docstring."""
    digest = hashlib.sha256(request.node.nodeid.encode()).hexdigest()
    client = APIClient(raise_request_exception=False)
    client.defaults['HTTP_X_FORWARDED_FOR'] = f'198.51.100.{int(digest[:4], 16) % 254 + 1}'
    return client


@pytest.fixture
def raising_client():
    """A client that re-raises view exceptions instead of returning a 500.

    The isolation fixture deliberately returns 500s so they can be *observed*.
    These tests are the counterweight: they prove the exception is genuinely
    gone rather than swallowed somewhere on the way to a 400.
    """
    client = APIClient()
    digest = hashlib.sha256(client.__class__.__name__.encode()).hexdigest()
    client.defaults['HTTP_X_FORWARDED_FOR'] = f'198.51.100.{int(digest[:4], 16) % 254 + 1}'
    return client


def _email_of_length(total: int) -> str:
    """A syntactically valid address exactly ``total`` characters long."""
    domain = '@example.com'
    return 'a' * (total - len(domain)) + domain


def _assert_error_envelope(response):
    """The 400 body is ``{"error": "<string>"}`` — the shape ``legal.py`` already
    used, and the one ``client.ts:164-165`` reads after ``detail``."""
    body = response.json()
    assert set(body) == {'error'}, f'expected a single "error" key, got {sorted(body)}'
    assert isinstance(body['error'], str), f'error must be a string, got {body["error"]!r}'
    assert body['error'], 'error message must not be empty'
    return body


class TestDRFCoercionIsNotAHole:
    """DRF's field coercions, pinned so they read as decisions.

    ``CharField.to_internal_value`` coerces ``int``/``float`` to ``str`` and
    rejects everything else including ``bool``; ``UUIDField`` coerces an
    ``int`` to ``uuid.UUID(int=...)``. None of that is R5-06 — none of it
    raises — and the rejection lists throughout this file are written to match
    it rather than to assert a DRF implementation detail. These tests exist so
    that a later reader who finds ``int`` missing from a rejection list knows
    it was excluded on purpose.
    """

    def test_char_field_coerces_numbers(self):
        field = serializers.CharField()
        assert field.run_validation(12345) == '12345'
        assert field.run_validation(3.5) == '3.5'

    def test_char_field_rejects_bools_lists_and_dicts(self):
        field = serializers.CharField()
        for value in (True, ['a'], {'k': 'v'}):
            with pytest.raises(serializers.ValidationError):
                field.run_validation(value)

    def test_uuid_field_coerces_int(self):
        import uuid as _uuid
        assert serializers.UUIDField().run_validation(1) == _uuid.UUID(int=1)


# ---------------------------------------------------------------------------
# POST /legal/takedown/  —  IT Rules 2021 R3(1)(b) complaint intake
# ---------------------------------------------------------------------------

class TestTakedownHappyPath:
    """Must-preserve. A 'hardening' that stops accepting valid takedowns is a
    regression, not a fix — the obligation to receive complaints is the point
    of the endpoint."""

    def test_valid_takedown_returns_201_and_records_the_request(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'I own the master recording of this track.',
                'requester_email': 'rights.holder@example.com',
            },
            format='json',
        )

        assert response.status_code == 201, response.content
        assert response.json()['clip_id'] == str(ready_clip.id)

        row = TakedownRequest.objects.get()
        assert row.clip_id == ready_clip.id
        assert row.reason == 'I own the master recording of this track.'
        assert row.requester_email == 'rights.holder@example.com'
        assert row.status == 'pending'

    def test_valid_takedown_without_requester_email_still_accepted(self, isolated_throttle_budget, ready_clip):
        """Requiredness is unchanged from the pre-fix behaviour.

        ``TakedownRequest.requester_email`` is an ``EmailField`` with no
        ``blank=True``, so the model considers it required, but the view has
        always defaulted it to ``''`` and accepted the request. Tightening that
        changes the happy path, which is out of scope for an input-validation
        fix; it is reported to the owner instead.
        """
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': str(ready_clip.id), 'reason': 'Infringing copy.'},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert TakedownRequest.objects.get().requester_email == ''

    def test_takedown_response_shape_is_unchanged(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'r',
                'requester_email': 'a@example.com',
            },
            format='json',
        )

        body = response.json()
        assert body['status'] == 'received'
        assert 'message' in body and 'clip_id' in body


class TestTakedownMalformedClipId:
    """Cause 1: a non-UUID is a *malformed request*, not a missing resource."""

    def test_non_uuid_clip_id_is_400_not_500(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': 'not-a-uuid', 'reason': 'r', 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 400, (
            f'expected 400 for a malformed clip_id, got {response.status_code}: {response.content[:300]}'
        )
        _assert_error_envelope(response)
        assert TakedownRequest.objects.count() == 0

    def test_non_uuid_clip_id_raises_nothing(self, raising_client, ready_clip):
        """The counterweight to the isolation fixture.

        Before the fix this propagated
        ``django.core.exceptions.ValidationError: 'not-a-uuid' is not a valid
        UUID`` out of the view. A raising client turns a swallowed 500 back
        into a test error, so this cannot be satisfied by catching the
        exception somewhere and answering 400.
        """
        response = raising_client.post(
            reverse('legal_takedown'),
            {'clip_id': 'not-a-uuid', 'reason': 'r', 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 400, response.content
        assert TakedownRequest.objects.count() == 0

    def test_absent_clip_id_is_400(self, isolated_throttle_budget, ready_clip):
        """Missing, not absent-but-well-formed.

        Both are 400 because both are malformed *requests*; neither names a
        resource that could be said to exist or not exist.
        """
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'reason': 'r', 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 400, response.content
        _assert_error_envelope(response)
        assert TakedownRequest.objects.count() == 0

    def test_wellformed_uuid_for_absent_clip_is_404_preserved(self, isolated_throttle_budget, ready_clip):
        """The current semantic is preserved deliberately.

        A well-formed UUID that matches no row is 404, not 400: the request
        was perfectly well-formed and it names a real, addressable namespace
        (clip PKs) — the row is simply not there. See the oracle note in the
        report: the 404-vs-201 split remains an unauthenticated existence
        oracle and is *not* closed by this test.
        """
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(uuid.uuid4()),
                'reason': 'r',
                'requester_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 404, response.content
        assert 'Clip not found' in response.json()['error']
        assert TakedownRequest.objects.count() == 0

    @pytest.mark.parametrize('clip_id', [
        'x',
        '12345',
        '00000000-0000-0000-0000-00000000000',   # right shape, wrong digit count
        '../../../etc/passwd',
        'null',
        '',
        ['a-list-not-a-uuid'],
        {'nested': 'object'},
        3.5,
    ], ids=['str', 'numeric-str', 'short-dashed', 'traversal', 'null-word',
            'empty', 'list', 'dict', 'float'])
    def test_malformed_clip_id_shapes_are_400(self, isolated_throttle_budget, ready_clip, clip_id):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': clip_id, 'reason': 'r', 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 400, (
            f'clip_id={clip_id!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert TakedownRequest.objects.count() == 0

    @pytest.mark.parametrize('clip_id', [12345, True, 0])
    def test_integer_clip_id_is_404_not_400(self, isolated_throttle_budget, ready_clip, clip_id):
        """DRF's ``UUIDField`` coerces an ``int`` to ``uuid.UUID(int=...)``
        (``fields.py`` ``to_internal_value``), and ``bool`` is an ``int``
        subclass, so ``True`` becomes ``uuid.UUID(int=1)``.

        The coerced value is a *well-formed* UUID that matches no row, so 404
        is the correct answer under the rule the rest of this class asserts —
        not 400. Pinned explicitly so the coercion is a recorded contract
        rather than an accident someone later "fixes" into a different
        status, and asserted here only because a float (the previous entry)
        is genuinely rejected with 400.
        """
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': clip_id, 'reason': 'r', 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 404, (
            f'clip_id={clip_id!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert TakedownRequest.objects.count() == 0


class TestTakedownRequesterEmail:
    """Cause 2: the address was neither length-checked nor email-checked."""

    def test_over_length_requester_email_is_400_not_500(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'r',
                'requester_email': 'A' * (EMAIL_MAX + 1),
            },
            format='json',
        )

        assert response.status_code == 400, (
            f'expected 400, got {response.status_code}: {response.content[:300]}'
        )
        _assert_error_envelope(response)
        assert TakedownRequest.objects.count() == 0

    def test_over_length_requester_email_raises_nothing(self, raising_client, ready_clip):
        """Before the fix this was ``StringDataRightTruncation`` from Postgres."""
        response = raising_client.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'r',
                'requester_email': 'A' * (EMAIL_MAX + 1),
            },
            format='json',
        )

        assert response.status_code == 400, response.content
        assert TakedownRequest.objects.count() == 0

    @pytest.mark.parametrize('bad_email', [
        'not-an-email',
        'missing-domain@',
        '@missing-local.com',
        'spaces in@example.com',
        'trailing@dot.',
        'a@b@c.com',
    ])
    def test_requester_email_must_be_an_email(self, isolated_throttle_budget, ready_clip, bad_email):
        """Not validated as an email at all before the fix — every value here
        was written straight to an ``EmailField``."""
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': str(ready_clip.id), 'reason': 'r', 'requester_email': bad_email},
            format='json',
        )

        assert response.status_code == 400, (
            f'requester_email={bad_email!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert TakedownRequest.objects.count() == 0

    def test_requester_email_at_exactly_the_limit_is_accepted(self, isolated_throttle_budget, ready_clip):
        address = _email_of_length(EMAIL_MAX)
        assert len(address) == EMAIL_MAX

        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': str(ready_clip.id), 'reason': 'r', 'requester_email': address},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert TakedownRequest.objects.get().requester_email == address

    def test_requester_email_one_over_the_limit_is_400(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'r',
                'requester_email': _email_of_length(EMAIL_MAX + 1),
            },
            format='json',
        )

        assert response.status_code == 400, response.content
        assert TakedownRequest.objects.count() == 0


class TestTakedownReasonBounds:
    """``TakedownRequest.reason`` is the takedown-side twin of
    ``Grievance.description``: unbounded ``TextField`` written from an
    ``AllowAny`` endpoint at 30/hour. Same bound, same policy."""

    def test_reason_at_exactly_the_limit_is_accepted(self, isolated_throttle_budget, ready_clip):
        reason = 'x' * FREE_TEXT_MAX

        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': reason,
                'requester_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 201, response.content
        assert len(TakedownRequest.objects.get().reason) == FREE_TEXT_MAX

    def test_reason_one_over_the_limit_is_400(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': 'x' * (FREE_TEXT_MAX + 1),
                'requester_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 400, response.content
        _assert_error_envelope(response)
        assert TakedownRequest.objects.count() == 0

    def test_missing_reason_is_400(self, isolated_throttle_budget, ready_clip):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {'clip_id': str(ready_clip.id), 'requester_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 400, response.content
        assert TakedownRequest.objects.count() == 0

    @pytest.mark.parametrize('bad_reason', REJECTED_TEXT, ids=['list', 'dict', 'bool'])
    def test_non_string_reason_is_400_not_500(self, isolated_throttle_budget, ready_clip, bad_reason):
        response = isolated_throttle_budget.post(
            reverse('legal_takedown'),
            {
                'clip_id': str(ready_clip.id),
                'reason': bad_reason,
                'requester_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 400, (
            f'reason={bad_reason!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert TakedownRequest.objects.count() == 0


# ---------------------------------------------------------------------------
# POST /grievance/  —  IT Rules 2021 R3(2) grievance officer + 24h SLA
# ---------------------------------------------------------------------------

class TestGrievanceHappyPath:
    def test_valid_grievance_returns_201_and_records_the_row(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {
                'subject': 'Data shared without consent',
                'description': 'My transcript was shared with a third party.',
                'user_email': 'complainant@example.com',
            },
            format='json',
        )

        assert response.status_code == 201, response.content
        body = response.json()
        assert body['status'] == 'received'
        assert body['acknowledgment_due'] is not None

        row = Grievance.objects.get(id=body['grievance_id'])
        assert row.subject == 'Data shared without consent'
        assert row.description == 'My transcript was shared with a third party.'
        assert row.user_email == 'complainant@example.com'
        assert row.status == 'received'
        assert row.user is None            # anonymous submission
        assert row.acknowledgment_due is not None

    def test_anonymous_grievance_without_user_email_still_accepted(self, isolated_throttle_budget):
        """Requiredness unchanged: an anonymous complainant with no address is
        still recorded, exactly as before."""
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'Anonymous grievance', 'description': 'No contact address.'},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert Grievance.objects.get().user_email is None

    def test_body_with_no_recognised_fields_is_still_recorded(self, isolated_throttle_budget):
        """An empty body is accepted, and that is the preserved behaviour.

        It was accepted before this fix too — every field defaulted to ``''`` /
        ``None`` and a row was written. Pinning it here makes the decision
        visible: IT Rules 2021 R3(2) obliges us to receive grievances, and
        rejecting a body for being empty would be a worse failure than storing
        a thin one, which the 24h acknowledgment and operator triage can then
        follow up. The bounds added by this fix do not change it.
        """
        response = isolated_throttle_budget.post(reverse('grievance_create'), {}, format='json')

        assert response.status_code == 201, response.content
        row = Grievance.objects.get()
        assert row.subject == ''
        assert row.description == ''
        assert row.user_email is None
        assert row.acknowledgment_due is not None


class TestGrievanceSubjectBounds:
    """Cause 3, part 1: ``subject`` is ``varchar(200)``."""

    def test_over_length_subject_is_400_not_500(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {
                'subject': 'S' * (SUBJECT_MAX + 1),
                'description': 'y',
                'user_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 400, (
            f'expected 400, got {response.status_code}: {response.content[:300]}'
        )
        _assert_error_envelope(response)
        assert Grievance.objects.count() == 0

    def test_over_length_subject_raises_nothing(self, raising_client):
        """Before the fix this was ``StringDataRightTruncation`` from Postgres."""
        response = raising_client.post(
            reverse('grievance_create'),
            {
                'subject': 'S' * (SUBJECT_MAX + 1),
                'description': 'y',
                'user_email': 'a@example.com',
            },
            format='json',
        )

        assert response.status_code == 400, response.content
        assert Grievance.objects.count() == 0

    def test_subject_at_exactly_the_limit_is_accepted(self, isolated_throttle_budget):
        subject = 'S' * SUBJECT_MAX

        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': subject, 'description': 'y', 'user_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert Grievance.objects.get().subject == subject

    def test_subject_one_over_the_limit_is_400(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'S' * (SUBJECT_MAX + 1), 'description': 'y'},
            format='json',
        )

        assert response.status_code == 400, response.content
        assert Grievance.objects.count() == 0

    @pytest.mark.parametrize('bad_subject', REJECTED_TEXT, ids=['list', 'dict', 'bool'])
    def test_non_string_subject_is_400_not_500(self, isolated_throttle_budget, bad_subject):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': bad_subject, 'description': 'y'},
            format='json',
        )

        assert response.status_code == 400, (
            f'subject={bad_subject!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert Grievance.objects.count() == 0


class TestGrievanceUserEmailBounds:
    def test_over_length_user_email_is_400_not_500(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {
                'subject': 'ok',
                'description': 'y',
                'user_email': 'A' * (EMAIL_MAX + 1),
            },
            format='json',
        )

        assert response.status_code == 400, (
            f'expected 400, got {response.status_code}: {response.content[:300]}'
        )
        _assert_error_envelope(response)
        assert Grievance.objects.count() == 0

    def test_over_length_user_email_raises_nothing(self, raising_client):
        response = raising_client.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': 'y', 'user_email': 'A' * (EMAIL_MAX + 1)},
            format='json',
        )

        assert response.status_code == 400, response.content
        assert Grievance.objects.count() == 0

    @pytest.mark.parametrize('bad_email', [
        'not-an-email',
        'missing-domain@',
        '@missing-local.com',
        'a@b@c.com',
    ])
    def test_user_email_must_be_an_email(self, isolated_throttle_budget, bad_email):
        """Unvalidated as an email before the fix — this is the field R5-12
        (report-only) says can be used to file a fabricated grievance against a
        named third party. Format validation is a *correctness* fix, not the
        verification flow R5-12 actually needs."""
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': 'y', 'user_email': bad_email},
            format='json',
        )

        assert response.status_code == 400, (
            f'user_email={bad_email!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert Grievance.objects.count() == 0

    def test_user_email_at_exactly_the_limit_is_accepted(self, isolated_throttle_budget):
        address = _email_of_length(EMAIL_MAX)
        assert len(address) == EMAIL_MAX

        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': 'y', 'user_email': address},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert Grievance.objects.get().user_email == address

    def test_user_email_one_over_the_limit_is_400(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': 'y', 'user_email': _email_of_length(EMAIL_MAX + 1)},
            format='json',
        )

        assert response.status_code == 400, response.content
        assert Grievance.objects.count() == 0


class TestGrievanceDescriptionBounds:
    """Cause 3, part 2: unbounded ``TextField`` from an anonymous caller.

    Bounded generously and **rejected** over the bound, not truncated: a
    half-sentence grievance is worse for the operator than a rejected
    request, and the complainant can retry. See ``legal.py`` for the number's
    derivation.
    """

    def test_description_at_exactly_the_bound_is_accepted(self, isolated_throttle_budget):
        description = 'd' * FREE_TEXT_MAX

        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': description, 'user_email': 'a@example.com'},
            format='json',
        )

        assert response.status_code == 201, response.content
        assert len(Grievance.objects.get().description) == FREE_TEXT_MAX

    def test_description_one_over_the_bound_is_400(self, isolated_throttle_budget):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': 'd' * (FREE_TEXT_MAX + 1)},
            format='json',
        )

        assert response.status_code == 400, response.content
        _assert_error_envelope(response)
        assert Grievance.objects.count() == 0

    @pytest.mark.parametrize('bad_description', REJECTED_TEXT, ids=['list', 'dict', 'bool'])
    def test_non_string_description_is_400_not_500(self, isolated_throttle_budget, bad_description):
        response = isolated_throttle_budget.post(
            reverse('grievance_create'),
            {'subject': 'ok', 'description': bad_description},
            format='json',
        )

        assert response.status_code == 400, (
            f'description={bad_description!r} produced {response.status_code}: {response.content[:300]}'
        )
        assert Grievance.objects.count() == 0


# ---------------------------------------------------------------------------
# Cross-cutting: no anonymous input may produce a 500
# ---------------------------------------------------------------------------

MALFORMED_PAYLOADS = [
    ({}, 'empty body'),
    ({'clip_id': None, 'reason': None, 'requester_email': None}, 'all null'),
    ({'clip_id': ['nested'], 'reason': {'k': 'v'}, 'requester_email': 1}, 'all wrong-typed'),
    ({'clip_id': '', 'reason': '', 'requester_email': ''}, 'all empty strings'),
    ({'clip_id': 'x' * 5000, 'reason': 'y' * 5000, 'requester_email': 'z' * 5000}, 'all over-length'),
    ({'clip_id': True, 'reason': False, 'requester_email': None}, 'booleans'),
    ({'unexpected': 'field'}, 'unknown field only'),
    ({'clip_id': 'x', 'reason': 'y', 'requester_email': 'a@example.com', 'extra': 1}, 'unknown extra field'),
]


class TestNoUnhandled500:
    """The core claim of the fix, stated as a property rather than as a list of
    the individual cases above: from any address, at 30/hour and 10/hour, no
    malformed body reaches the client as a 500."""

    @pytest.mark.parametrize('payload,label', MALFORMED_PAYLOADS, ids=[label for _, label in MALFORMED_PAYLOADS])
    def test_takedown_never_500s(self, isolated_throttle_budget, ready_clip, payload, label):
        response = isolated_throttle_budget.post(reverse('legal_takedown'), payload, format='json')

        assert response.status_code < 500, (
            f'takedown 500s on {label}: {response.content[:400]}'
        )
        assert TakedownRequest.objects.count() == 0

    @pytest.mark.parametrize('payload,label', MALFORMED_PAYLOADS, ids=[label for _, label in MALFORMED_PAYLOADS])
    def test_grievance_never_500s(self, isolated_throttle_budget, payload, label):
        """Only ``< 500`` is asserted here, deliberately.

        Most of these payloads carry no ``subject``/``description``/``user_email``
        at all, and this endpoint has always recorded such a body rather than
        rejecting it — see
        ``test_body_with_no_recognised_fields_is_still_recorded``. Asserting
        "no row was created" would be asserting a product decision about an
        IT Rules intake channel, not the property this fix is about.
        """
        response = isolated_throttle_budget.post(reverse('grievance_create'), payload, format='json')

        assert response.status_code < 500, (
            f'grievance 500s on {label}: {response.content[:400]}'
        )

    @pytest.mark.parametrize('field,value', [
        ('subject', 'S' * (SUBJECT_MAX + 1)),
        ('subject', ['list']),
        ('user_email', 'A' * (EMAIL_MAX + 1)),
        ('user_email', 'nope'),
        ('description', 'd' * (FREE_TEXT_MAX + 1)),
        ('description', {'nested': 'object'}),
    ], ids=['subject-over', 'subject-list', 'user_email-over', 'user_email-invalid',
            'description-over', 'description-dict'])
    def test_grievance_field_storms_never_500(self, isolated_throttle_budget, field, value):
        payload = {'subject': 'ok', 'description': 'y', 'user_email': 'a@example.com'}
        payload[field] = value

        response = isolated_throttle_budget.post(reverse('grievance_create'), payload, format='json')

        assert response.status_code < 500, response.content[:400]
        assert Grievance.objects.count() == 0

    @pytest.mark.parametrize('field,value', [
        ('clip_id', 'not-a-uuid'),
        ('clip_id', ['list']),
        ('clip_id', 99999999999999999999),
        ('requester_email', 'A' * (EMAIL_MAX + 1)),
        ('requester_email', 'nope'),
        ('reason', 'r' * (FREE_TEXT_MAX + 1)),
        ('reason', ['list']),
    ], ids=['clip_id-malformed', 'clip_id-list', 'clip_id-huge-int',
            'email-over', 'email-invalid', 'reason-over', 'reason-list'])
    def test_takedown_field_storms_never_500(self, isolated_throttle_budget, ready_clip, field, value):
        payload = {
            'clip_id': str(ready_clip.id),
            'reason': 'r',
            'requester_email': 'a@example.com',
        }
        payload[field] = value

        response = isolated_throttle_budget.post(reverse('legal_takedown'), payload, format='json')

        assert response.status_code < 500, response.content[:400]
        assert TakedownRequest.objects.count() == 0
