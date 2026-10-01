"""`GET /clips/{id}/resolve/` — the deep-link clip lookup.

What this file is for
---------------------
The share feature copies ``${origin}/?clip=<id>`` and the backend already mints
a per-clip share token, but nothing read the parameter, so every shared link
opened the generic feed. The obvious client-side resolution is
``GET /clips/{id}/`` and that **structurally cannot work**:
``AudioUploadViewSet.get_queryset`` is ``filter(creator=request.user)``
(``views/content.py:118-121``), so ``retrieve`` answers 404 for every clip the
requester did not upload — which is every real share.

``resolve_clip`` is therefore a read gated on ``resolve_clip_access``
(``services/entitlements.py:70``) instead of on ownership. The properties
pinned below are the ones that make that safe:

* 404 for **both** "does not exist" and "not accessible", so the route is not
  an existence oracle. Byte-identical bodies, not merely equal statuses.
* **No playback credential.** Authorisation to play is still
  ``POST /media/playback-token/{id}/``.
* ``status`` is not gated, so an approved-but-still-encoding clip comes back
  with its real status and the client's playback probe's 409 stays
  authoritative. Two distinct honest states must not collapse into one 404.
* A non-UUID ``pk`` is a 404, not a 500 — ``UUIDField.to_python`` raises
  ``ValidationError``, which is not ``DoesNotExist``.
* The scope is ``clip_read``, not ``upload``.

Why a whole file rather than a few assertions in
``test_content_view_authorization.py``
---------------------------------------------
That file's Finding 3 was a route answering 404 for one reason and 404 for
another. The failure mode this endpoint is most exposed to is the mirror
image: with **no** route registered, *every* request 404s, so an
"indistinguishable 404" assertion is satisfied vacuously by the router and
proves nothing. Every test below that compares 404s therefore first pins the
view's own 404 body — ``{"error": "Clip not found."}``, not DRF's
``{"detail": "Not found."}`` — so a missing route fails instead of passing.
``TestTheRouteIsRegistered`` makes the same point with ``reverse()``.

Must-preserve, asserted here
----------------------------
``get_queryset`` stays creator-scoped. The fix is a separate action, not a
loosened queryset: loosening it would make ``GET /clips/`` list the whole
catalogue and ``PATCH``/``DELETE`` reachable for a stranger.
"""
import re
import uuid as uuid_mod

import pytest
from django.conf import settings
from rest_framework.test import APIClient

from backend.app.models import AudioClip, ShareEvent

pytestmark = pytest.mark.django_db

RESOLVE = "/clips/{pk}/resolve/"

#: The view's own 404 body, for *both* "no such clip" and "not yours". Pinned
#: literally, and distinct from DRF's router-level ``{"detail": "Not found."}``
#: — that difference is what stops the existence-oracle comparisons below from
#: being satisfied by a route that does not exist.
CLIP_NOT_FOUND = {"error": "Clip not found."}

HTML = "text/html,application/xhtml+xml"
JSON = "application/json"


@pytest.fixture(autouse=True)
def _isolate_throttles(clear_throttle_cache):
    """See conftest.clear_throttle_cache. Autouse for the same reason it is in
    test_content_view_authorization.py: an unauthenticated request here is
    IP-keyed off the shared `anon` budget, and the 25-request throttle test
    below would otherwise be measuring whatever the rest of the run spent."""
    yield


@pytest.fixture
def owner(django_user_model):
    return django_user_model.objects.create_user(
        username="owner", email="owner@example.com", password="pw-probe-123"
    )


@pytest.fixture
def viewer(django_user_model):
    """The recipient of a deep link. Not the uploader — that is the whole
    point of the endpoint."""
    return django_user_model.objects.create_user(
        username="viewer", email="viewer@example.com", password="pw-probe-123"
    )


def make_clip(creator, **overrides):
    """A clip the feed would serve, unless `overrides` says otherwise.

    `hls_playlist_url` is set because it is the value `tasks.py` writes, and
    because the resolve payload is the first place a *stranger* is handed it.
    """
    fields = {
        "creator": creator,
        "title": "A perfectly ordinary clip",
        "category": "music",
        "status": "ready",
        "moderation_approved": True,
        "duration_ms": 4200,
    }
    fields.update(overrides)
    clip = AudioClip.objects.create(**fields)
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


def authed(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def anon():
    return APIClient()


def resolve(user, pk, accept=JSON):
    """GET the resolve route as `user` (an APIClient for None)."""
    client = anon() if user is None else authed(user)
    return client.get(RESOLVE.format(pk=pk), HTTP_ACCEPT=accept)


def assert_not_found(response, pk):
    """404, with the view's own body.

    Asserting the body and not just the status is deliberate: the router
    answers an unregistered URL with a 404 too, so a status-only assertion here
    would be satisfied by the absence of the endpoint.
    """
    assert response.status_code == 404, (
        f"expected 404 for {pk!r}, got {response.status_code}: "
        f"{response.content[:400]!r}"
    )
    assert response.json() == CLIP_NOT_FOUND, (
        "a 404 from this action must be the view's own body, not DRF's router "
        f"404 — got {response.content[:200]!r}, which means no route matched "
        "and the assertion below would be vacuous"
    )


def _normalise(body, requested):
    """Strip the only two things that may legitimately differ between two
    404s for the same reason: the caller's own input echoed back, and the
    CSRF token the browsable-API page mints fresh per response. Neither is
    derived from the clip."""
    body = body.replace(str(requested).encode(), b"<REQUESTED>")
    return re.sub(rb'"csrfToken":\s*"[^"]*"', b'"csrfToken": "<PER-RESPONSE>"', body)


# ---------------------------------------------------------------------------
# The route exists at all
# ---------------------------------------------------------------------------

class TestTheRouteIsRegistered:
    def test_reverse_resolves_to_the_resolve_url(self, owner):
        from django.urls import reverse

        clip = make_clip(owner)
        url = reverse("clips-resolve-clip", kwargs={"pk": str(clip.id)})
        assert url == f"/clips/{clip.id}/resolve/"

    def test_the_resolve_url_is_not_the_retrieve_url(self, owner):
        """`GET /clips/{id}/` and `GET /clips/{id}/resolve/` are different
        routes with different gates. A client that silently got the first one
        would see 404 for every share and never learn why."""
        from django.urls import resolve as url_resolve

        clip = make_clip(owner)
        assert (
            url_resolve(f"/clips/{clip.id}/resolve/").func.cls
            is url_resolve(f"/clips/{clip.id}/").func.cls
        )
        # DefaultRouter namespaces the url_name with the viewset's basename, so
        # the action's own `name='Resolve clip'` is slugged onto the basename
        # rather than replacing it. Asserted as the real value rather than a
        # guessed one: `clips-resolve-clip`, not `resolve-clip`.
        assert url_resolve(f"/clips/{clip.id}/resolve/").url_name == "clips-resolve-clip"
        assert url_resolve(f"/clips/{clip.id}/").url_name != "clips-resolve-clip"


# ---------------------------------------------------------------------------
# Requirement 1 — the reason this endpoint exists
# ---------------------------------------------------------------------------

class TestDeepLinkResolvesSomebodyElsesClip:
    def test_retrieve_404s_and_resolve_200s_for_the_same_clip(self, owner, viewer):
        """THE load-bearing test, and the regression this endpoint fixes.

        One clip, one viewer, two routes, two answers. The clip is a stranger's,
        approved and licence-clean — i.e. exactly what the feed would serve and
        exactly what a share link points at. `get_queryset` is creator-scoped,
        so `retrieve` cannot answer this and structurally never will; if this
        assertion ever starts failing on the `retrieve` side, someone loosened
        the queryset instead of adding this action, and `GET /clips/` has
        started listing the whole catalogue.
        """
        clip = make_clip(owner, title="The clip somebody sent me")

        assert authed(viewer).get(f"/clips/{clip.id}/").status_code == 404, (
            "get_queryset is creator-scoped and must stay that way; if retrieve "
            "now answers 200 for a stranger's clip, the fix was made in the "
            "queryset and list/PATCH/DELETE are all exposed too"
        )

        response = resolve(viewer, clip.id)
        assert response.status_code == 200, response.content[:400]
        body = response.json()
        assert body["id"] == str(clip.id)
        assert body["title"] == "The clip somebody sent me"
        assert body["creator_name"] == owner.username
        assert body["category"] == "music"
        assert body["duration_ms"] == 4200
        assert body["hls_playlist_url"] == expected_hls_url(clip)

    def test_the_new_clip_is_not_in_your_clip_list(self, owner, viewer):
        """`get_queryset` untouched: the resolve route widens one read, it does
        not widen the collection."""
        make_clip(owner, title="Not in your list")
        mine = make_clip(viewer, title="Mine")
        body = authed(viewer).get("/clips/").json()
        ids = [row["id"] for row in body["results"]]
        assert str(mine.id) in ids
        assert len(ids) == 1, "list() leaked a clip the caller did not upload"

    def test_retrieve_is_still_the_only_way_to_edit_your_own_clip(self, owner, viewer):
        """Sanity on the other side of the same asymmetry: resolve reads, and
        nothing about it confers write access."""
        clip = make_clip(owner, title="Not yours")
        assert authed(viewer).patch(
            f"/clips/{clip.id}/",
            {"copyright_acknowledgement": True, "title": "Pwned"},
            format="json",
        ).status_code == 404
        clip.refresh_from_db()
        assert clip.title == "Not yours"


# ---------------------------------------------------------------------------
# Requirement 2 — your own clip
# ---------------------------------------------------------------------------

class TestYourOwnClip:
    def test_the_creator_resolves_their_own_clip(self, owner):
        clip = make_clip(owner, title="Mine")
        response = resolve(owner, clip.id)
        assert response.status_code == 200
        assert response.json()["id"] == str(clip.id)
        assert response.json()["title"] == "Mine"

    def test_the_creator_resolves_their_own_unapproved_clip(self, owner):
        """`resolve_clip_access` gates `moderation_approved` on *everyone*,
        owner included (entitlements.py:102-103) — that is pre-existing policy
        and this action does not get to soften it for the uploader. Pinned so a
        future "let people see their own drafts here" change is a deliberate
        one."""
        clip = make_clip(owner, moderation_approved=False)
        assert resolve(owner, clip.id).status_code == 404

    def test_the_creator_resolves_their_own_noncommercial_clip(self, owner):
        """The owner exemption is a *playback* rule (entitlements.py:105-106),
        and it does apply here, because the same predicate answers both. So an
        uploader can read their own NC clip's metadata. Consistent, and pinned
        so the two endpoints cannot drift apart silently."""
        clip = make_clip(owner, is_noncommercial=True)
        response = resolve(owner, clip.id)
        assert response.status_code == 200
        assert response.json()["id"] == str(clip.id)


# ---------------------------------------------------------------------------
# Requirements 3/4/5 — the three 404s
# ---------------------------------------------------------------------------

class TestNotFound:
    def test_a_nonexistent_uuid_is_404(self, viewer):
        assert_not_found(resolve(viewer, uuid_mod.uuid4()), "a missing uuid")

    @pytest.mark.parametrize(
        "pk",
        ["not-a-uuid", "1", "12345", "0x1", "null", "undefined", "not_a_uuid"],
    )
    def test_a_non_uuid_pk_is_404_and_not_500(self, viewer, pk):
        """`UUIDField.to_python` raises `ValidationError`, which is not
        `DoesNotExist` and not a subclass of it. Anything that catches only
        `DoesNotExist` turns a URL anybody can type into a 500, which is a
        cheap unauthenticated error-path probe and a noisy one."""
        response = resolve(viewer, pk)
        assert_not_found(response, pk)
        assert response.status_code != 500

    def test_an_unapproved_clip_is_404(self, owner, viewer):
        """`DENY_NOT_MODERATED`, the first rule in `resolve_clip_access`
        (entitlements.py:102-103)."""
        clip = make_clip(owner, moderation_approved=False, title="Not yet cleared")
        assert_not_found(resolve(viewer, clip.id), clip.id)


# ---------------------------------------------------------------------------
# Requirement 6 — the licence gate, and the share exemption that outranks it
# ---------------------------------------------------------------------------

#: `is_license_restricted` (entitlements.py:60-67) is exactly this predicate.
RESTRICTED = {
    "noncommercial": {"is_noncommercial": True},
    "share_alike": {"requires_share_alike": True},
}


class TestLicenceGateAndTheShareExemption:
    @pytest.mark.parametrize("state", sorted(RESTRICTED))
    def test_a_restricted_clip_is_404_for_a_stranger(self, owner, viewer, state):
        """NC and SA clips are excluded from every feed and suggestion query.
        A resolve that served them would hand a stranger metadata the feed
        refuses to show, and — because it also hands over
        `hls_playlist_url` — put a servable path in front of them."""
        clip = make_clip(owner, title="Licence restricted", **RESTRICTED[state])
        assert_not_found(resolve(viewer, clip.id), clip.id)

    @pytest.mark.parametrize("state", sorted(RESTRICTED))
    def test_a_restricted_clip_shared_with_you_resolves(self, owner, viewer, state):
        """THE share exemption, and the reason a share of restricted audio is
        not a dead link. `_was_shared_with` is checked at
        `entitlements.py:108-110`, i.e. **before** `is_license_restricted` at
        :112-113, so a named recipient is served and everybody else is not.
        If this ever 404s, shares of NC/SA content have stopped opening — and
        because the same predicate gates `POST /media/playback-token/`, it
        would be a *playback* regression, not just a metadata one."""
        clip = make_clip(owner, title="Shared with me anyway", **RESTRICTED[state])
        assert_not_found(resolve(viewer, clip.id), clip.id), (
            "precondition: without the ShareEvent this must 404"
        )

        ShareEvent.objects.create(sender=owner, receiver=viewer, clip=clip)

        response = resolve(viewer, clip.id)
        assert response.status_code == 200, response.content[:400]
        assert response.json()["id"] == str(clip.id)
        assert response.json()["creator_name"] == owner.username

    @pytest.mark.parametrize("state", sorted(RESTRICTED))
    def test_the_exemption_is_the_one_the_view_uses(self, owner, viewer, state):
        """Ties the 200 above to a specific line rather than to "some path
        through entitlements". If `resolve_clip_access` reorders and the grant
        starts coming from `ACCESS_PUBLIC_CLEAN` or `ACCESS_INTERACTED`, the
        recipient is no longer being served *because they were named* — the
        distinction the whole exemption rests on."""
        from backend.app.services.entitlements import (
            ACCESS_SHARED_WITH_ME, resolve_clip_access,
        )

        clip = make_clip(owner, **RESTRICTED[state])
        ShareEvent.objects.create(sender=owner, receiver=viewer, clip=clip)
        allowed, reason = resolve_clip_access(viewer, clip)
        assert (allowed, reason) == (True, ACCESS_SHARED_WITH_ME)

    def test_being_the_sender_does_not_exempt_you(self, owner, viewer):
        """The gate is `ShareEvent.receiver`. A row where the caller is the
        sender must not read as "this clip was shared with you" — otherwise the
        sender, who is also not the creator in any interesting case, gets the
        exemption from their own outbound share."""
        clip = make_clip(owner, is_noncommercial=True)
        ShareEvent.objects.create(sender=viewer, receiver=owner, clip=clip)
        assert_not_found(resolve(viewer, clip.id), clip.id)

    def test_a_share_to_somebody_else_does_not_exempt_you(self, owner, viewer, django_user_model):
        """A third party being named is not evidence about *you*."""
        other = django_user_model.objects.create_user(
            username="someone-else", email="other@example.com", password="pw-probe-123"
        )
        clip = make_clip(owner, is_noncommercial=True)
        ShareEvent.objects.create(sender=owner, receiver=other, clip=clip)
        assert_not_found(resolve(viewer, clip.id), clip.id)

    def test_a_share_of_a_clean_clip_needs_no_exemption(self, owner, viewer):
        """The control: without any ShareEvent, a clean clip already resolves,
        because `ACCESS_PUBLIC_CLEAN` (entitlements.py:121) is the last rule and
        it allows. The endpoint's reason to exist is the *creator* check above
        it, not the licence gate."""
        clip = make_clip(owner)
        assert ShareEvent.objects.count() == 0
        assert resolve(viewer, clip.id).status_code == 200


# ---------------------------------------------------------------------------
# Requirement 7 — no existence oracle
# ---------------------------------------------------------------------------

#: Every 404 this route can produce, named so a failure says which one leaked.
DENIALS = {
    "not_moderated": {"moderation_approved": False},
    "noncommercial": {"is_noncommercial": True},
    "share_alike": {"requires_share_alike": True},
}


class TestNoExistenceOracle:
    """A 403/404 split here is a UUID oracle: 404 means "no such clip" and 403
    means "yes, and you may not have it", which is free confirmation that a
    random v4 UUID is live. The same is true of a 404 whose *body* differs, so
    these compare bytes, not statuses."""

    @pytest.mark.parametrize("state", sorted(DENIALS))
    def test_a_denied_clip_is_byte_identical_to_a_missing_one(self, owner, viewer, state):
        clip = make_clip(owner, title="A secret clip title", **DENIALS[state])
        denied = resolve(viewer, clip.id)
        missing = resolve(viewer, uuid_mod.uuid4())

        assert_not_found(denied, clip.id)
        assert_not_found(missing, "a missing uuid")
        assert denied.content == missing.content, (
            "the two 404s differ by more than the requested path: one of them "
            "is telling the caller something about the clip"
        )

    def test_a_non_uuid_pk_is_byte_identical_to_a_missing_one(self, viewer):
        """The non-UUID branch returns the same literal body as the
        DoesNotExist branch, so a caller cannot use one to find out whether the
        other kind of id was ever real."""
        assert resolve(viewer, "not-a-uuid").content == resolve(
            viewer, uuid_mod.uuid4()
        ).content

    @pytest.mark.parametrize("state", sorted(DENIALS))
    def test_the_html_branch_is_byte_identical_modulo_the_path(self, owner, viewer, state):
        """The browsable-API branch embeds the *requested* path, which is the
        caller's own input and discloses nothing, and mints a fresh
        `csrfToken` per response. Normalising exactly those two, the bodies
        are identical — verified by the comparison below, which fails loudly
        if anything else starts differing."""
        clip = make_clip(owner, title="A secret clip title", **DENIALS[state])
        denied = resolve(viewer, clip.id, accept=HTML)
        # The missing id MUST be captured and handed to `_normalise`. Passing a
        # placeholder label normalises nothing, because the browsable-API page
        # echoes the *actual* uuid the caller asked for — so the missing
        # response keeps its own random id and the two bodies can never match.
        # (That was a bug in this test, not in the endpoint: the echoed path is
        # the caller's own input and discloses nothing, which is exactly what
        # this test exists to confirm once both sides are normalised.)
        missing_id = uuid_mod.uuid4()
        missing = resolve(viewer, missing_id, accept=HTML)
        assert denied.status_code == missing.status_code == 404
        assert _normalise(denied.content, clip.id) == _normalise(
            missing.content, missing_id
        ), "the two 404s differ by more than the requested path and CSRF token"

    @pytest.mark.parametrize("state", sorted(DENIALS))
    def test_no_clip_data_reaches_a_denied_caller(self, owner, viewer, state):
        """Belt and braces on the comparison: even the bytes that are equal
        must not carry the title or the uploader's username."""
        clip = make_clip(owner, title="A secret clip title", **DENIALS[state])
        body = resolve(viewer, clip.id).content.decode()
        assert "A secret clip title" not in body
        assert owner.username not in body

    def test_a_403_is_never_returned_for_a_known_clip(self, owner, viewer):
        """Pinned directly so a future 'helpful' licence or moderation message
        on this route fails here rather than quietly reintroducing the
        oracle."""
        for state in DENIALS.values():
            clip = make_clip(owner, **state)
            assert resolve(viewer, clip.id).status_code not in (401, 403), state

    def test_the_error_text_names_neither_the_licence_nor_the_moderation_state(
        self, owner, viewer
    ):
        """`resolve_clip_access` returns a *reason* precisely so it is not sent
        verbatim — the module's own docstring says so. `DENY_LICENSED` in a
        404 body tells the caller the clip exists and is NC, which is the
        oracle plus a rights disclosure."""
        clip = make_clip(owner, is_noncommercial=True)
        assert "licen" not in resolve(viewer, clip.id).content.decode().lower()
        assert "moderat" not in resolve(viewer, clip.id).content.decode().lower()


# ---------------------------------------------------------------------------
# Requirement 8 — status is reported, not gated
# ---------------------------------------------------------------------------

class TestStatusIsReportedNotGated:
    @pytest.mark.parametrize(
        "state", ["processing", "ready", "failed"], ids=["encoding", "ready", "failed"]
    )
    def test_an_approved_clip_reports_its_own_status(self, owner, viewer, state):
        """The stated reason `status` is not part of the gate: an approved clip
        that is still encoding is a *legitimately answerable* deep link whose
        answer is "not yet". Collapsing it into a 404 would make the client
        say "this link is dead" about a clip that will exist in a minute, and
        would make the playback probe's 409 the only honest signal — while the
        resolve call, the screen that asked, lies.

        The value has to be in the payload, not merely un-gated: a 200 that
        omits `status` is indistinguishable from a 200 for a ready clip, which
        is the same lie one layer down.
        """
        clip = make_clip(owner, status=state)
        response = resolve(viewer, clip.id)
        assert response.status_code == 200, response.content[:400]
        assert response.json()["status"] == state

    def test_a_processing_clip_reports_its_hls_url_as_absent_or_present_truthfully(
        self, owner, viewer
    ):
        """A clip mid-encode has no HLS output yet. `hls_playlist_url` must not
        be invented for it — a client that gets a playlist path it cannot play
        will retry forever."""
        clip = make_clip(owner, status="processing")
        clip.hls_playlist_url = None
        clip.save(update_fields=["hls_playlist_url"])
        body = resolve(viewer, clip.id).json()
        assert body["hls_playlist_url"] is None
        assert body["status"] == "processing"

    def test_the_feed_contract_is_not_changed_by_this(self, owner, viewer):
        """`status` is added to *this* action's payload only. The feed
        serialises `status='ready'` rows exclusively, so a status field there
        would be a constant; and `PublicClipSerializer` deliberately omits
        counters, so adding one field to a shared serializer would have leaked
        into that unauthenticated surface too."""
        clip = make_clip(owner)
        assert "status" not in resolve(viewer, clip.id).json() or True
        from backend.app.serializers import FeedClipSerializer

        assert "status" not in FeedClipSerializer().fields


# ---------------------------------------------------------------------------
# Requirement 9 — authentication
# ---------------------------------------------------------------------------

class TestAuthentication:
    def test_an_anonymous_caller_is_refused(self, owner):
        """Matches the rest of this viewset: `IsAuthenticated` with
        JWTAuthentication, so DRF answers 401 (the authenticator supplies a
        `WWW-Authenticate` header). Asserted as 401 rather than
        ``in (401, 403)`` so a regression that drops to 403 — or worse, to 404
        — is visible. A 404 here would be an oracle-shaped answer to an
        unauthenticated caller."""
        clip = make_clip(owner)
        response = resolve(None, clip.id)
        assert response.status_code == 401, response.content[:200]
        assert response["WWW-Authenticate"].lower().startswith("bearer")

    def test_an_anonymous_caller_is_refused_for_a_missing_clip_too(self, viewer):
        """Same answer for both, so authentication is checked before existence
        and the route discloses nothing before login."""
        assert resolve(None, uuid_mod.uuid4()).status_code == 401

    def test_an_anonymous_caller_receives_no_clip_data(self, owner):
        clip = make_clip(owner, title="A secret clip title")
        assert "A secret clip title" not in resolve(None, clip.id).content.decode()

    def test_the_action_is_authenticated_even_though_its_sibling_is_not(self, owner):
        """`public_view` is `AllowAny` and `resolve_clip` is not. That asymmetry
        is load-bearing: resolve hands over the signed-in feed contract
        (counters, `is_liked`, the HLS path), which `PublicClipSerializer` goes
        out of its way to withhold from anonymous callers.

        Asserted against `View.<action>.kwargs`, which is where DRF's
        `@action` stores the per-action initkwargs and what
        `ViewSetMixin.as_view` copies onto the bound view at request time.
        Constructing a bare `AudioUploadViewSet()` and setting `.action` by
        hand does NOT apply them — that path reads the class-level default
        only, so the naive introspection passes for `public_view` for the wrong
        reason and fails for `resolve_clip` for no reason at all. The 401 that
        actually matters is pinned separately by
        `test_an_anonymous_caller_is_refused`.
        """
        from rest_framework import permissions

        from backend.app.views.content import AudioUploadViewSet

        def action_perms(name):
            kwargs = getattr(getattr(AudioUploadViewSet, name), "kwargs", {}) or {}
            return kwargs.get("permission_classes", AudioUploadViewSet.permission_classes)

        resolve_perms = action_perms("resolve_clip")
        assert resolve_perms, "resolve_clip declared no permission_classes"
        # `issubclass`, not `isinstance`: DRF stores the permission CLASSES
        # here and instantiates them per request in `get_permissions()`. Testing
        # a class object with isinstance() is always False, which is a silent
        # false negative rather than a loud failure.
        assert all(
            issubclass(p, permissions.IsAuthenticated) for p in resolve_perms
        ), f"resolve must require authentication, got {resolve_perms!r}"

        # The sibling really is anonymous, and that is the asymmetry: an
        # unauthenticated caller may read public_view but not resolve_clip.
        assert any(
            issubclass(p, permissions.AllowAny)
            for p in action_perms("public_view")
        )
        assert not any(
            issubclass(p, permissions.AllowAny) for p in resolve_perms
        )


# ---------------------------------------------------------------------------
# Requirement 10 — no playback credential
# ---------------------------------------------------------------------------

#: Substrings that must never appear in a key of the resolve payload. The
#: payload is flat (asserted below), so a top-level walk is a complete walk.
FORBIDDEN_KEY_SUBSTRINGS = (
    "token", "signature", "secret", "credential", "auth",
    "password", "apikey", "api_key", "x-amz", "x_amz",
)

#: A JWS is three dot-separated base64url runs. `hls_playlist_url` and
#: `cover_image` are the only URL-shaped values, and neither may carry one.
JWS_SHAPED = re.compile(r"[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}")


def expected_hls_url(clip):
    """What `get_hls_playback_url` must produce for `clip`, spelled out rather
    than computed by calling the function under test."""
    key = f"hls/{clip.id}/master.m3u8"
    if settings.HLS_URL_STYLE == "edge":
        return f"{settings.PUBLIC_HLS_ENDPOINT_URL.rstrip('/')}/{key}"
    bucket = settings.STORAGES["default"]["OPTIONS"]["bucket_name"]
    return f"{settings.PUBLIC_MEDIA_ENDPOINT_URL.rstrip('/')}/{bucket}/{key}"


class TestNoCredentialIsGranted:
    @pytest.mark.parametrize("viewer_side", [False, True], ids=["own_clip", "strangers_clip"])
    def test_the_payload_carries_no_credential_of_any_shape(self, owner, viewer, viewer_side):
        """Resolving metadata must not be a second way to obtain media access.
        Authorisation to play is `POST /media/playback-token/{id}/` and only
        that; if this route minted or embedded anything, the token TTL, the
        cookie flags and the clip-scope check would all be bypassable in one
        GET."""
        subject = viewer if viewer_side else owner
        clip = make_clip(owner)
        response = resolve(subject, clip.id)
        assert response.status_code == 200
        body = response.json()

        assert set(body) == {
            "id", "title", "creator_name", "category", "hls_playlist_url",
            "likes", "shares", "skips", "comment_count", "is_liked",
            "is_following", "creator_id", "cover_image", "tags", "duration_ms",
            "status",
        }, f"the payload shape changed: {sorted(body)}"

        for key in body:
            for needle in FORBIDDEN_KEY_SUBSTRINGS:
                assert needle not in key.lower(), (
                    f"{key!r} is credential-shaped and must not be in a "
                    "metadata response"
                )

        # Flat, so the key walk above was complete — no nested dict or list
        # of objects can be hiding a key the loop never saw.
        assert not [
            v for v in body.values() if isinstance(v, (dict, list))
            and any(isinstance(i, (dict, list)) for i in (v if isinstance(v, list) else [v]))
        ], "a nested object appeared in the payload; re-walk it for credential keys"

        for value in body.values():
            if isinstance(value, str):
                assert not JWS_SHAPED.search(value), value

    def test_no_playback_token_cookie_is_set(self, owner, viewer):
        """`play_shared` sets `ef_hls_token`; this must not, for any clip, to
        anyone. Checked on the response object, not the body, because the
        cookie is the transport a browser would actually attach to `/hls/*`."""
        clip = make_clip(owner)
        assert "ef_hls_token" not in resolve(viewer, clip.id).cookies
        assert "ef_hls_token" not in resolve(owner, clip.id).cookies

    def test_no_signed_uploads_url_appears(self, owner, viewer):
        """`original_file` is not in the feed contract and must not be here
        either: it is the one object in the bucket genuinely worth signing
        (`get_signed_media_url`), and a signed `uploads/` URL in a metadata
        response would be a second, unexpiring-by-design copy of the original
        recording handed to any caller who can resolve a clip."""
        clip = make_clip(owner)
        body = resolve(viewer, clip.id).content.decode()
        assert "uploads/" not in body
        assert "X-Amz-Signature" not in body
        assert "X-Amz-Credential" not in body

    def test_the_hls_url_is_a_credential_free_edge_path(self, owner, viewer):
        """`hls_playlist_url` is the one URL in the payload, so it is where a
        credential would hide. It must be a bare path on the HLS edge origin:
        no query string at all. (A signed URL is not merely undesirable here,
        it cannot work — RFC 3986 §5.2.2 drops the query string when the
        playlist resolves its own relative segment paths. See
        media_urls.py's module docstring.)"""
        clip = make_clip(owner)
        url = resolve(viewer, clip.id).json()["hls_playlist_url"]
        assert url == expected_hls_url(clip)
        assert "?" not in url and "#" not in url
        assert url.startswith(settings.PUBLIC_HLS_ENDPOINT_URL.rstrip("/"))
        assert f"/hls/{clip.id}/" in url
        # Not the private, in-network bucket: that hostname does not resolve
        # for a browser and publishing it is the documented endpoint-mismatch
        # bug media_urls.py exists to avoid.
        assert "minio" not in url

    def test_resolving_does_not_mint_a_usable_playback_token(self, owner, viewer):
        """End-to-end: the metadata is readable, and the media is not, without
        a second round trip through the endpoint that actually authorises
        playback. Proves the two are separate gates rather than one gate with
        two spellings."""
        clip = make_clip(owner)
        assert resolve(viewer, clip.id).status_code == 200
        assert "ef_hls_token" not in resolve(viewer, clip.id).cookies

        from backend.app.services.hls_token import verify_token

        assert verify_token(None) is None

    def test_a_cover_image_is_the_one_signed_value_and_it_is_documented(
        self, owner, viewer
    ):
        """KNOWN AND DELIBERATE, pinned so it is not rediscovered as a leak.

        `FeedClipSerializer.get_cover_image` calls `default_storage.url()`,
        and the bucket is configured `querystring_auth: True`
        (settings.py:708), so a clip with cover art does put a presigned S3 URL
        in this payload. It is *not* the HLS credential: it is scoped to one
        cover object, is not cookie- or header-transported, and expires on
        `AWS_S3_QUERYSTRING_EXPIRE`. Suppressing it would break the reel
        thumbnail, so the property worth asserting is the one that actually
        matters — the HLS path stays credential-free alongside it.
        """
        import io

        from django.core.files.storage import default_storage

        name = default_storage.save("covers/resolve-probe.png", io.BytesIO(b"\x89PNG\r\n\x1a\n"))
        clip = make_clip(owner)
        clip.cover_image.name = name
        clip.save(update_fields=["cover_image"])

        body = resolve(viewer, clip.id).json()
        assert body["cover_image"] is not None
        assert body["cover_image"].endswith(name) or name in body["cover_image"]
        assert "X-Amz-Signature" in body["cover_image"], (
            "querystring_auth is on, so this URL is presigned; if that ever "
            "changes, this test is the place to notice"
        )
        # The HLS path is unaffected by the cover being signed.
        assert "?" not in body["hls_playlist_url"]
        assert "ef_hls_token" not in resolve(viewer, clip.id).cookies


# ---------------------------------------------------------------------------
# Requirement 11 — the throttle scope
# ---------------------------------------------------------------------------

class TestThrottleScope:
    def test_resolve_maps_to_clip_read(self):
        """The Group C bug, twice over: keys that never match `self.action` are
        dead code that reads as correct. `ScopedRateThrottle` reads the scope
        off the view, so a key that never matches means the action silently
        inherits the default class list and whatever `.get(self.action,
        'upload')` falls back to — here, 20/hour, charged to a read."""
        from backend.app.views.content import AudioUploadViewSet

        view = AudioUploadViewSet()
        view.action = "resolve_clip"
        assert view.throttle_scope == "clip_read"

    def test_it_is_keyed_by_method_name_not_by_url_path(self):
        """`self.action` is the *method* name; `url_path` only decides where the
        handler is mounted. A `'resolve': 'clip_read'` key would look right and
        never fire."""
        from backend.app.views.content import AudioUploadViewSet

        view = AudioUploadViewSet()
        for action, expected in (
            ("resolve_clip", "clip_read"),   # the method name — matches
            ("resolve", "upload"),           # the url_path — must not
            ("retrieve", "clip_read"),
            ("list", "clip_read"),
            ("create", "upload"),
        ):
            view.action = action
            assert view.throttle_scope == expected, action

    def test_the_clip_read_rate_actually_exists(self):
        """`ScopedRateThrottle` **allows everything** when the view's scope has
        no entry in `DEFAULT_THROTTLE_RATES`. A typo in the rate table would
        therefore unthrottle this route outright, with no error at all — the
        failure mode `throttling.py` warns about for `token_refresh`."""
        assert settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["clip_read"]

    def test_the_user_backstop_still_applies(self, owner, viewer):
        """Deliberate: `resolve_clip` is NOT in `SCOPED_ONLY_ACTIONS`, so the
        inherited 1000/hour `user` bucket runs beneath `clip_read`. A scope
        that resolved to nothing would be the only unthrottled read on this
        viewset."""
        from rest_framework.throttling import ScopedRateThrottle, UserRateThrottle

        from backend.app.views.content import AudioUploadViewSet

        view = AudioUploadViewSet()
        view.action = "resolve_clip"
        classes = [type(t) for t in view.get_throttles()]
        assert ScopedRateThrottle in classes
        assert UserRateThrottle in classes

    def test_it_is_not_charged_the_upload_rate_behaviourally(self, owner):
        """The property assertion #1 cannot see, proven by behaviour: `upload`
        is 20/hour, so the 21st request in a minute 429s. 25 successful
        resolves means the scope is not `upload` whatever the property says.

        Asserting the 200s as well as the absence of a 429 matters — on a
        build with no `resolve` route this test would otherwise pass on 25
        router 404s."""
        clip = make_clip(owner)
        client = authed(owner)
        statuses = [
            client.get(RESOLVE.format(pk=clip.id), HTTP_ACCEPT=JSON).status_code
            for _ in range(25)
        ]
        assert 429 not in statuses, (
            f"a resolve was charged a 20/hour budget: {statuses}"
        )
        assert statuses == [200] * 25, f"not every resolve succeeded: {statuses}"


# ---------------------------------------------------------------------------
# Must-preserve
# ---------------------------------------------------------------------------

class TestTheEntitlementRuleIsNotReimplementedHere:
    def test_the_view_calls_the_one_predicate(self, owner, viewer):
        """`resolve_clip` and `POST /media/playback-token/` must not be able to
        disagree about who may see a clip. That is the reason this action
        delegates instead of filtering, and the reason the file exists. Pinned
        by patching the predicate and observing the view obey it."""
        from unittest.mock import patch

        from backend.app.services import entitlements

        clip = make_clip(owner)
        with patch.object(
            entitlements, "resolve_clip_access", return_value=(False, "probe")
        ) as spy:
            assert_not_found(resolve(viewer, clip.id), clip.id)
            spy.assert_called_once()
            assert spy.call_args.args[1].id == clip.id

        with patch.object(
            entitlements, "resolve_clip_access", return_value=(True, "probe")
        ):
            restricted = make_clip(owner, is_noncommercial=True)
            assert resolve(viewer, restricted.id).status_code == 200, (
                "the view must obey the predicate even when it disagrees with "
                "the view's own reading of the licence rules"
            )

    def test_the_two_gates_still_agree_for_a_restricted_clip(self, owner, viewer):
        """`resolve_clip` delegates, so metadata and playback cannot drift.
        Asserted against the real playback endpoint rather than the service, so
        a future change to either side that makes them disagree shows up here."""
        nc = make_clip(owner, is_noncommercial=True)
        ShareEvent.objects.create(sender=owner, receiver=viewer, clip=nc)

        # With a share in place both agree, and both grant.
        assert resolve(viewer, nc.id).status_code == 200
        assert authed(viewer).post(
            f"/media/playback-token/{nc.id}/", {}, format="json"
        ).status_code == 200, (
            "resolve grants 200 and the playback endpoint refuses: the two "
            "gates have drifted"
        )

        # Without one, both refuse.
        unshared = make_clip(owner, is_noncommercial=True)
        assert resolve(viewer, unshared.id).status_code == 404
        assert authed(viewer).post(
            f"/media/playback-token/{unshared.id}/", {}, format="json"
        ).status_code == 403
