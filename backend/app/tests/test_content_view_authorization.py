"""Authorization + state-scoping tests for `views/content.py`.

Three holes, all on the same viewset, all found by reading the file against
the predicates its neighbours already use.

Finding 1 — `GET /clips/{id}/public/` published metadata for unservable clips
---------------------------------------------------------------------------
`public_view` is `AllowAny` and is the **only** place the API origin serves
rendered HTML: a chat client unfurling a shared link gets an Open Graph title,
description and cover image out of it. Its queryset filtered
`moderation_approved=True` and nothing else.

Every other clip surface applies four conditions. `views/feed.py:111+115`
(primary), `:135+137` (degraded fallback), `:183-187` (suggestions),
`views/social.py:166-172` (send-share) and `views/profile.py:80-86` all require

    status='ready' AND moderation_approved=True
    AND is_noncommercial=False AND requires_share_alike=False

`public_view` applied the second of the four. So an unauthenticated caller got
a rendered card for NC audio, for SA audio, and for clips still mid-encode —
the exact metadata `feed.py`, `social.py:173` and `content.py`'s own
`share_link` / `play_shared` withhold. The A4 licence work closed this
everywhere else; this was the last surface.

Note the *audio* was still token-gated, so this is metadata disclosure plus
feed inconsistency, not a playback bypass. The severity is in the
inconsistency: the feed, the share pipeline and the public page then disagreed
about what exists.

Why 404 and not 403
--------------------
`content.py:546-561` already made its 403s deliberately indistinguishable
("A valid share link is required." for both a bad token and a
right-token-wrong-clip), and `:528-532` documents a deliberate 409-before-403
ordering. This file follows that sensibility by putting the whole predicate in
the **queryset**, so a non-servable clip 404s exactly like a nonexistent one —
no 403/404 split to read existence off. See `TestExistenceOracle`.

Finding 2 — post-approval PATCH could rewrite the rights record
--------------------------------------------------------------
`title`, `category` and `license_type` are all writable on a clip that is
already `moderation_approved=True` and `status='ready'`, and the update resets
neither flag nor re-runs moderation.

`license_type` is the sharp edge, but **not for the reason the finding
assumed**: it does *not* drive `is_noncommercial` / `requires_share_alike`.
Those are separate columns that only the scraper writes and that
`AudioUploadSerializer` does not even expose — pinned by
`TestPostApprovalPatch::test_the_rights_flags_are_not_writable_through_the_api`.
So a PATCH cannot open the redistribution gate at all. What it *can* do is
silently rewrite the declared licence and attribution of content a moderator
already ruled on, which is an audit-integrity problem, not a
redistribution bypass. The policy and the argument are in
`AudioUploadViewSet.update`; the tests pin the behaviour.

Finding 3 — `POST /clips/{id}/report/` was an unscoped existence oracle
-----------------------------------------------------------------------
`get_object_or_404(AudioClip, pk=pk)` — unscoped, and answered 201 for any
existing UUID and 404 otherwise at 20/hour, so it confirmed existence for
content the caller was not entitled to know about and polluted the operator
queue with claims nobody can verify. Scoped with the same predicate as
Finding 1, and to the same 404, so the two answers stay consistent.

Not-reportable is also the *correct* reading, not just the safe one: you cannot
report what you have not seen, and a report is an accusation of a rights
violation that has to be triageable. A rights-holder with evidence about
content that is already pulled has `POST /legal/takedown/`
(`views/legal.py:56`, `TakedownRequest`) and that endpoint does not require the
clip to be servable — so the legitimate path for "report something invisible"
already exists and is not closed by this.

Must-preserve, asserted here
----------------------------
`share-link` minting and the `play/` exchange (hardened in 3042f20),
`approve-moderation` owner-or-staff (Group C) — the rewritten frontend calls it
immediately after upload, so a 403 regression breaks every upload — plus
`get_queryset`'s creator scoping and the `SCOPED_ONLY_ACTIONS` set.
"""
import pytest
from rest_framework.test import APIClient

from backend.app.models import AudioClip, Report

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _isolate_throttles(clear_throttle_cache):
    """See conftest.clear_throttle_cache. Autouse: the `public_view` and
    `report_clip` requests here are unauthenticated and IP-keyed, so they all
    share the 127.0.0.1 budget with anything else in the run. `clip_report`
    is only 20/hour, which a full-suite run would exhaust on its own."""
    yield


@pytest.fixture
def owner(django_user_model):
    return django_user_model.objects.create_user(
        username="owner", email="owner@example.com", password="pw-probe-123"
    )


@pytest.fixture
def stranger(django_user_model):
    return django_user_model.objects.create_user(
        username="stranger", email="stranger@example.com", password="pw-probe-123"
    )


def make_clip(creator, **overrides):
    """A clip the feed would serve, unless `overrides` says otherwise.

    `hls_playlist_url` is set because it is the value `tasks.py:376` writes and
    because the share/play scope check compares the token's ``c`` against
    exactly this string.
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
    # tasks.py:376 writes f"hls/{clip.id}/master.m3u8". `clip_storage_key`
    # (services/uploads.py:53-71) then strips the filename, so the value a
    # playback token must be scoped to is f"hls/{clip.id}" — not the playlist
    # path. A token scoped to the playlist fails the `c` comparison with a
    # message that reads like a security bug.
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


def token_scope(clip):
    """The `c` value a playback token for `clip` must carry."""
    return f"hls/{clip.id}"


def anon():
    return APIClient()


def authed(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


HTML = "text/html,application/xhtml+xml"
JSON = "application/json"

#: The four conditions every clip-listing path applies. Copied from
#: `views/profile.py:80-86` and `views/feed.py:183-187`; the tests below are
#: written against this shape so a drift in the view is visible as a failure
#: rather than as a new rule that quietly disagrees with the feed.
UNSERVABLE = {
    "noncommercial": {"is_noncommercial": True},
    "share_alike": {"requires_share_alike": True},
    "unapproved": {"moderation_approved": False},
    "not_ready": {"status": "processing"},
    "rejected": {"status": "failed"},
}


# ---------------------------------------------------------------------------
# Finding 1 — public_view must not render unservable clips
# ---------------------------------------------------------------------------

class TestPublicViewWithholdsUnservableMetadata:
    """The card is the one thing an unauthenticated caller can read about a
    clip. Each case below returned 200 with a full OG title/description before
    the fix."""

    @pytest.mark.parametrize("state", sorted(UNSERVABLE))
    def test_the_html_card_is_not_rendered(self, owner, state):
        clip = make_clip(owner, title="A secret clip title", **UNSERVABLE[state])
        response = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=HTML)
        assert response.status_code == 404, (
            f"a {state} clip must not render a share card; the feed, the share "
            f"pipeline and this page have to agree on what exists"
        )
        # The title is the disclosure. Belt and braces: even a 404 body must
        # not carry it.
        assert "A secret clip title" not in response.content.decode()

    @pytest.mark.parametrize("state", sorted(UNSERVABLE))
    def test_the_json_branch_is_gated_too(self, owner, state):
        """The gate has to be in the lookup, not in the HTML renderer — the
        JSON branch runs the same query and would otherwise stay open."""
        clip = make_clip(owner, **UNSERVABLE[state])
        response = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON)
        assert response.status_code == 404

    def test_a_share_token_does_not_unlock_the_card(self, owner):
        """`?s=` is a bearer credential for `play/`. It must not be a bearer
        credential for the metadata page, or the 404 is trivially bypassed by
        anyone holding a forwarded link."""
        clip = make_clip(owner, is_noncommercial=True, title="NC clip title")
        response = anon().get(
            f"/clips/{clip.id}/public/?s=whatever", HTTP_ACCEPT=HTML
        )
        assert response.status_code == 404
        assert "NC clip title" not in response.content.decode()

    def test_an_authenticated_caller_gets_no_more_than_an_anonymous_one(
        self, owner, stranger
    ):
        """Logging in must not turn an unservable clip into a readable one."""
        clip = make_clip(owner, is_noncommercial=True)
        assert anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == authed(stranger).get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == 404

    def test_even_the_creator_cannot_unlock_it_over_the_public_path(
        self, owner
    ):
        """`resolve_clip_access` exempts the owner from the licence filter so
        they can hear their own upload. That exemption is about *playback
        tokens*, and it is deliberately not reused here: this page mints no
        credential, so there is no legitimate owner-side need, and the
        renderer is the most CSP-sensitive surface in the repo."""
        clip = make_clip(owner, is_noncommercial=True)
        assert authed(owner).get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == 404


class TestPublicViewPreservesTheUnfurlPath:
    """MUST-PRESERVE. This is the share-link landing page. There is no
    deployed web frontend (nginx is `server_name _` proxying only to Django),
    so a link unfurl is the only thing that renders a shared URL. Breaking it
    breaks every shared link."""

    def test_a_servable_clip_still_renders_the_card(self, owner):
        clip = make_clip(owner, title="Shared clip")
        response = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=HTML)
        assert response.status_code == 200
        assert response["Content-Type"].startswith("text/html")
        body = response.content.decode()
        assert 'property="og:title"' in body
        assert "Shared clip" in body
        assert 'property="og:description"' in body

    def test_a_servable_clip_still_serves_json(self, owner):
        clip = make_clip(owner, title="Shared clip", duration_ms=4200)
        response = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON)
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == str(clip.id)
        assert body["title"] == "Shared clip"
        assert body["duration_ms"] == 4200

    def test_opening_a_link_still_mints_no_credential(self, owner):
        clip = make_clip(owner)
        response = anon().get(
            f"/clips/{clip.id}/public/?s=anything", HTTP_ACCEPT=JSON
        )
        assert response.status_code == 200
        assert "ef_hls_token" not in response.cookies

    def test_a_user_supplied_title_is_still_escaped(self, owner):
        """The card renders free text on an unauthenticated page. This is why
        this surface is the CSP-sensitive one, and also why the missing CSP is
        the real finding and the escaping is not."""
        clip = make_clip(owner, title='<script>alert("xss")</script>')
        body = anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=HTML
        ).content.decode()
        assert "<script>" not in body
        assert "&lt;script&gt;" in body

    def test_every_documented_servable_state_still_serves(self, owner):
        """Guard against over-tightening: the gate is four conditions, and
        a fifth invented one would quietly remove content from the platform."""
        clip = make_clip(
            owner,
            is_noncommercial=False,
            requires_share_alike=False,
            moderation_approved=True,
            status="ready",
        )
        assert anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=HTML
        ).status_code == 200


class TestExistenceOracle:
    """A 404/403 split on an `AllowAny` detail route is a UUID oracle. The
    fix puts the whole predicate in the queryset precisely so that a
    non-servable clip is answered exactly like one that was never created.

    What "exactly like" has to mean here, precisely: DRF's browsable 404 page
    embeds the **requested** path in its resolver traceback, and the requested
    path is the caller's own input — echoing it discloses nothing. So the
    property under test is byte-identity *modulo the requested path*, plus
    the substantive one: no clip data in either body. Asserting raw
    byte-identity would be asserting something false about DRF rather than
    something true about this view.
    """

    @staticmethod
    def _normalise(body, uuid_str):
        """Strip the two things that legitimately differ between two 404s for
        the same reason.

        Neither is derived from the clip:

        * the requested path, which is the caller's own input echoed by
          DRF's resolver traceback;
        * the ``csrfToken``, which DRF's browsable-API page mints fresh per
          response. Verified by diffing the two bodies: with the path and the
          token normalised they are byte-identical, so nothing else about the
          clip leaks into the difference.
        """
        import re

        body = body.replace(str(uuid_str).encode(), b"<REQUESTED-UUID>")
        return re.sub(
            rb'"csrfToken": "[^"]*"', b'"csrfToken": "<PER-RESPONSE>"', body
        )

    def _assert_no_oracle(self, unservable, missing_id, request_path):
        client = anon()
        real = client.get(request_path.format(id=unservable.id), HTTP_ACCEPT=HTML)
        fake = client.get(request_path.format(id=missing_id), HTTP_ACCEPT=HTML)
        assert real.status_code == fake.status_code == 404
        assert "A secret clip title" not in real.content.decode()
        assert "A secret clip title" not in fake.content.decode()
        assert unservable.creator.username not in real.content.decode()
        assert self._normalise(real.content, unservable.id) == self._normalise(
            fake.content, missing_id
        ), "the two 404s differ by more than the requested path and the CSRF token"

    def test_a_non_servable_clip_is_indistinguishable_from_a_missing_one(
        self, owner
    ):
        import uuid

        clip = make_clip(owner, is_noncommercial=True, title="A secret clip title")
        self._assert_no_oracle(
            clip, uuid.uuid4(), "/clips/{id}/public/"
        )

    def test_an_unapproved_clip_is_indistinguishable_from_a_missing_one(
        self, owner
    ):
        import uuid

        clip = make_clip(owner, moderation_approved=False, title="A secret clip title")
        self._assert_no_oracle(
            clip, uuid.uuid4(), "/clips/{id}/public/"
        )

    def test_a_not_ready_clip_is_indistinguishable_from_a_missing_one(
        self, owner
    ):
        import uuid

        clip = make_clip(owner, status="processing", title="A secret clip title")
        self._assert_no_oracle(
            clip, uuid.uuid4(), "/clips/{id}/public/"
        )

    def test_the_json_404_is_byte_identical(self, owner):
        """The API branch has no resolver traceback, so here raw byte-identity
        does hold — and it is the branch every real client uses."""
        import uuid

        clip = make_clip(owner, is_noncommercial=True, title="A secret clip title")
        real = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON)
        fake = anon().get(f"/clips/{uuid.uuid4()}/public/", HTTP_ACCEPT=JSON)
        assert real.status_code == fake.status_code == 404
        assert real.content == fake.content

    def test_a_403_is_never_returned_for_a_known_clip(self, owner):
        """403 would confirm existence outright. Pinned so a future 'helpful'
        licence message on this route fails here."""
        for state in UNSERVABLE.values():
            clip = make_clip(owner, **state)
            response = anon().get(f"/clips/{clip.id}/public/", HTTP_ACCEPT=HTML)
            assert response.status_code not in (401, 403), state



# ---------------------------------------------------------------------------
# Finding 2 — PATCH after approval
# ---------------------------------------------------------------------------

#: `AudioUploadSerializer.validate()` requires this on every request, so any
#: PATCH payload that omits it gets a 400 from the serializer before the view
#: is reached. Sent on every PATCH here so a licence test cannot fail for the
#: wrong reason. See `test_a_patch_without_the_acknowledgement_is_a_serializer_400`.
ACK = {"copyright_acknowledgement": True}


def patch_clip(user, clip, **fields):
    return authed(user).patch(
        f"/clips/{clip.id}/", {**ACK, **fields}, format="json"
    )


class TestPostApprovalPatch:
    def test_a_title_typo_can_still_be_fixed(self, owner):
        """The legitimate need. An over-broad re-moderation would make this
        impossible and is a real regression: the frontend's clip-edit form
        exists to do exactly this."""
        clip = make_clip(owner, title="Rain on a windwwo")
        response = patch_clip(owner, clip, title="Rain on a window")
        assert response.status_code == 200
        clip.refresh_from_db()
        assert clip.title == "Rain on a window"

    def test_a_title_edit_does_not_take_the_clip_out_of_service(self, owner):
        """What the user actually sees. If this regressed, the edit would
        appear to revert and the clip would vanish from every feed."""
        clip = make_clip(owner)
        assert patch_clip(owner, clip, title="Retitled").status_code == 200
        clip.refresh_from_db()
        assert clip.moderation_approved is True
        assert clip.status == "ready"
        assert anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == 200

    def test_a_category_edit_still_works(self, owner):
        clip = make_clip(owner, category="music")
        assert patch_clip(
            owner, clip, category="comedy"
        ).status_code == 200
        clip.refresh_from_db()
        assert clip.category == "comedy"

    @pytest.mark.parametrize(
        "field,before,after",
        [
            ("license_type", "CC-BY-SA", "CC0"),
            ("license_type", "Owned", "CC-BY-NC"),
            ("copyright_owner_name", "Alice", "Someone Else"),
        ],
    )
    def test_the_rights_record_cannot_be_rewritten_after_approval(
        self, owner, field, before, after
    ):
        """The core of Finding 2. `run_moderation_check`
        (services/content_moderation.py:132-179) validates the audio
        fingerprint, the tags and the transcript. It reads nothing about the
        licence, so there is no re-moderation that would re-validate a
        changed rights claim — only a way to take a published clip out of
        service. Refusing the change is the honest option."""
        clip = make_clip(owner, **{field: before})
        response = patch_clip(owner, clip, **{field: after})
        assert response.status_code == 409, (
            "a rights field was rewritten on already-moderated content; the "
            "clip is not re-moderated and the declared licence now describes "
            "an upload nobody approved"
        )
        clip.refresh_from_db()
        assert getattr(clip, field) == before

    def test_a_refused_licence_change_does_not_take_the_clip_out_of_service(
        self, owner
    ):
        """A 409 must be inert. The tempting alternative — set
        `moderation_approved=False` — would remove the clip from every feed
        and suggestion query while re-running checks that cannot see a
        licence, and nothing re-approves it automatically."""
        clip = make_clip(owner, license_type="CC-BY-SA")
        assert patch_clip(
            owner, clip, license_type="CC0"
        ).status_code == 409
        clip.refresh_from_db()
        assert clip.moderation_approved is True
        assert anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == 200

    def test_a_refused_licence_change_writes_nothing_at_all(self, owner):
        """Atomic refusal. A partial apply would leave the client unable to
        tell which half landed, and the half that landed is the dangerous
        one."""
        clip = make_clip(owner, title="Original", license_type="CC-BY-SA")
        response = patch_clip(
            owner, clip, title="Renamed", license_type="CC0"
        )
        assert response.status_code == 409
        clip.refresh_from_db()
        assert clip.title == "Original"
        assert clip.license_type == "CC-BY-SA"

    def test_echoing_the_unchanged_licence_is_allowed(self, owner):
        """The edit-form case, and the reason the guard compares values
        instead of testing key presence. A form that submits the whole object
        sends `license_type` back; refusing that would break every save in
        the shipped clip-edit form for no security gain."""
        clip = make_clip(owner, title="Rain on a windwwo", license_type="Owned")
        response = patch_clip(
            owner, clip, title="Rain on a window", license_type="Owned"
        )
        assert response.status_code == 200
        clip.refresh_from_db()
        assert clip.title == "Rain on a window"

    def test_a_licence_change_on_an_unapproved_clip_still_works(self, owner):
        """Nothing has been moderated yet, so there is no approved rights
        record to contradict and no reason to refuse."""
        clip = make_clip(
            owner, moderation_approved=False, license_type="Unknown"
        )
        assert patch_clip(
            owner, clip, license_type="Owned"
        ).status_code == 200
        clip.refresh_from_db()
        assert clip.license_type == "Owned"

    def test_an_unapproved_clip_can_still_be_edited_and_titled(self, owner):
        clip = make_clip(owner, moderation_approved=False)
        assert patch_clip(owner, clip, title="Pre-approval edit").status_code == 200
        clip.refresh_from_db()
        assert clip.title == "Pre-approval edit"

    def test_the_rights_flags_are_not_writable_through_the_api(self, owner):
        """The finding assumed `license_type` drives `is_noncommercial`. It
        does not. `is_noncommercial` / `requires_share_alike` are separate
        columns, absent from `AudioUploadSerializer.Meta.fields`, written only
        by the scraper uploader. So PATCH cannot open the redistribution gate
        at all — which is the real protection, and it is worth pinning,
        because a future 'helpful' addition of these two to the serializer
        would be the actual vulnerability."""
        clip = make_clip(owner, license_type="CC-BY")
        response = authed(owner).patch(
            f"/clips/{clip.id}/",
            {**ACK, "is_noncommercial": True, "requires_share_alike": True},
            format="json",
        )
        assert response.status_code == 200
        clip.refresh_from_db()
        assert clip.is_noncommercial is False
        assert clip.requires_share_alike is False
        assert anon().get(
            f"/clips/{clip.id}/public/", HTTP_ACCEPT=JSON
        ).status_code == 200

    def test_the_acknowledgement_itself_is_not_frozen(self, owner):
        """`copyright_acknowledgement` is a one-way affirmation: flipping it
        False -> True strengthens the record and can never weaken it, so it
        is deliberately outside the guard. Guarding it would also 409 every
        save on a legacy row uploaded before the acknowledgement became
        mandatory."""
        clip = make_clip(owner, copyright_acknowledgement=False)
        assert patch_clip(
            owner, clip, title="Renamed", copyright_acknowledgement=True
        ).status_code == 200
        clip.refresh_from_db()
        assert clip.copyright_acknowledgement is True

    @pytest.mark.parametrize("extra", [{}, ACK], ids=["no_ack", "with_ack"])
    def test_a_title_edit_lands_with_or_without_the_acknowledgement(
        self, owner, extra
    ):
        """Whether an update must re-send `copyright_acknowledgement` is
        `AudioUploadSerializer.validate`'s decision (W2-G), not this file's.
        Both payload shapes must land the title edit here, so whatever they
        settle on, the edit works — that is the coupling worth pinning."""
        clip = make_clip(owner, title="Rain on a windwwo")
        response = authed(owner).patch(
            f"/clips/{clip.id}/", {**extra, "title": "Rain on a window"},
            format="json",
        )
        assert response.status_code == 200
        clip.refresh_from_db()
        assert clip.title == "Rain on a window"

    def test_a_revoked_acknowledgement_is_a_serializer_400(self, owner):
        """`AudioUploadSerializer.validate()` refuses to let the copyright
        declaration be revoked after upload, so a client sending
        `copyright_acknowledgement: false` gets a 400 naming that field.

        NOT this file's rule, and it is reached before `update()` runs. Pinned
        so it is never confused with the 409 above, which names
        `license_type` — the two failures look identical from a client that
        only checks the status code."""
        clip = make_clip(owner)
        response = authed(owner).patch(
            f"/clips/{clip.id}/",
            {"copyright_acknowledgement": False, "title": "Renamed"},
            format="json",
        )
        assert response.status_code == 400
        assert "copyright_acknowledgement" in response.json()
        clip.refresh_from_db()
        assert clip.title != "Renamed"

    def test_the_update_is_still_creator_scoped(self, owner, stranger):
        """Pre-existing and must stay: a stranger's clip is 404, not 403, and
        not writable."""
        clip = make_clip(owner, title="Not yours")
        response = patch_clip(stranger, clip, title="Pwned")
        assert response.status_code == 404
        clip.refresh_from_db()
        assert clip.title == "Not yours"

    def test_retrieve_is_still_creator_scoped(self, owner, stranger):
        clip = make_clip(owner)
        assert authed(stranger).get(
            f"/clips/{clip.id}/"
        ).status_code == 404
        assert authed(owner).get(f"/clips/{clip.id}/").status_code == 200


# ---------------------------------------------------------------------------
# Finding 3 — report scoping
# ---------------------------------------------------------------------------

def report(reporter, clip, payload=None):
    """POST the report endpoint. `payload` replaces the body wholesale rather
    than updating it, so a case that omits `content` really does omit it."""
    body = {
        "report_reason": "copyright",
        "content": "This is my recording.",
    }
    if payload is not None:
        body = payload
    return authed(reporter).post(
        f"/clips/{clip.id}/report/", body, format="json"
    )


class TestReportScoping:
    def test_a_servable_clip_can_still_be_reported(self, stranger, owner):
        """MUST-PRESERVE. Reporting is an IT Rules 2021 R3(1)(b) and
        Copyright Act obligation; scoping must not quietly remove the ability
        to report anything."""
        clip = make_clip(owner)
        response = report(stranger, clip)
        assert response.status_code == 201
        row = Report.objects.get(pk=response.json()["report_id"])
        assert row.clip_id == clip.id
        assert row.user_id == stranger.pk

    @pytest.mark.parametrize("state", sorted(UNSERVABLE))
    def test_an_unservable_clip_cannot_be_reported(self, stranger, owner, state):
        """A report is an accusation of a rights violation and has to be
        triageable by an operator. One filed against a clip the reporter was
        never shown is unverifiable, and the unfiltered 201-for-any-UUID made
        the endpoint a queue-flooding primitive at 20/hour."""
        clip = make_clip(owner, **UNSERVABLE[state])
        assert report(stranger, clip).status_code == 404
        assert Report.objects.count() == 0

    def test_a_non_servable_clip_is_indistinguishable_from_a_missing_one(
        self, stranger
    ):
        import uuid

        unservable = make_clip(stranger, is_noncommercial=True, title="A secret title")
        missing = uuid.uuid4()
        a = report(stranger, unservable)
        b = authed(stranger).post(
            f"/clips/{missing}/report/",
            {"report_reason": "copyright", "content": "This is my recording."},
            format="json",
        )
        assert a.status_code == b.status_code == 404
        assert "A secret title" not in a.content.decode()
        assert Report.objects.count() == 0
        assert TestExistenceOracle._normalise(
            a.content, unservable.id
        ) == TestExistenceOracle._normalise(b.content, missing), (
            "the two 404s differ by more than the requested path and the CSRF "
            "token, so one of them is telling the caller something about the "
            "clip"
        )

    def test_the_reporter_is_still_taken_from_the_token(self, stranger, owner):
        """A client must not be able to file a report attributed to another
        account by putting their id in the body."""
        clip = make_clip(owner)
        report(
            stranger,
            clip,
            {
                "report_reason": "copyright",
                "content": "Mine.",
                "user": owner.pk,
                "user_id": owner.pk,
            },
        )
        assert Report.objects.get().user_id == stranger.pk

    def test_anonymous_reporting_is_still_refused(self, owner):
        clip = make_clip(owner)
        response = anon().post(
            f"/clips/{clip.id}/report/",
            {"report_reason": "spam", "content": "Spam."},
            format="json",
        )
        assert response.status_code in (401, 403)
        assert Report.objects.count() == 0

    @pytest.mark.parametrize(
        "body",
        [
            {"report_reason": "because_i_said_so", "content": "x"},
            {"report_reason": "spam"},
            {"content": "no reason at all"},
            {"report_reason": "spam", "content": "   "},
        ],
    )
    def test_the_existing_validation_is_untouched(self, stranger, owner, body):
        """The clip lookup is still first, and the 400s the B4 work added are
        still 400s — scoping must not have replaced one error path with
        another."""
        clip = make_clip(owner)
        assert report(stranger, clip, body).status_code == 400
        assert Report.objects.count() == 0


# ---------------------------------------------------------------------------
# Must-preserve: the paths hardened in 3042f20 and Group C
# ---------------------------------------------------------------------------

class TestSharePipelineIsNotWeakened:
    def test_share_link_still_refuses_a_noncommercial_clip(self, owner):
        """3042f20. A share token is a 30-day media token carried in the URL,
        so refusing to mint one is the only load-bearing control."""
        clip = make_clip(owner, is_noncommercial=True)
        assert authed(owner).post(
            f"/clips/{clip.id}/share-link/", {}, format="json"
        ).status_code == 403

    def test_share_link_still_refuses_an_unapproved_clip(self, owner):
        clip = make_clip(owner, moderation_approved=False)
        assert authed(owner).post(
            f"/clips/{clip.id}/share-link/", {}, format="json"
        ).status_code == 403

    def test_share_link_still_mints_for_a_servable_clip(self, owner):
        clip = make_clip(owner)
        response = authed(owner).post(
            f"/clips/{clip.id}/share-link/", {}, format="json"
        )
        assert response.status_code == 201
        assert response.json()["path"].startswith(f"/clips/{clip.id}/public/?s=")

    def test_the_share_token_still_does_not_unlock_a_different_clip(
        self, owner
    ):
        """3042f20. Without the `c` scope comparison a recipient swaps the
        clip id in the path and plays anything."""
        from backend.app.services.hls_token import generate_playback_token

        owned = make_clip(owner, title="Mine")
        other = make_clip(owner, title="Not mine")
        forged = generate_playback_token(
            user_id=owner.pk,
            clip_key=token_scope(owned),
            ttl=600,
        )
        response = anon().post(
            f"/clips/{other.id}/play/", {"s": forged}, format="json"
        )
        assert response.status_code == 403
        assert "ef_hls_token" not in response.cookies

    def test_play_still_refuses_a_noncommercial_clip(self, owner):
        clip = make_clip(owner, is_noncommercial=True)
        assert anon().post(
            f"/clips/{clip.id}/play/", {"s": "x"}, format="json"
        ).status_code == 403


class TestApproveModerationIsNotWeakened:
    def test_a_stranger_cannot_approve_someone_elses_clip(self, owner, stranger):
        """Group C. The lookup was unscoped, so any authenticated user could
        approve — and publish — anyone's upload."""
        clip = make_clip(owner, moderation_approved=False)
        assert authed(stranger).post(
            f"/clips/{clip.id}/approve-moderation/", {}, format="json"
        ).status_code == 404

    def test_the_owner_can_still_self_approve(self, owner):
        """The rewritten frontend calls this immediately after upload, so a
        403 regression here breaks every upload in the app."""
        from backend.app.services import content_moderation as moderation_svc

        clip = make_clip(
            owner, moderation_approved=False, status="processing", tags=[]
        )
        approved, reason = moderation_svc.run_moderation_check(clip.id)
        assert approved is True, reason
        response = authed(owner).post(
            f"/clips/{clip.id}/approve-moderation/", {}, format="json"
        )
        assert response.status_code == 200
        assert response.json()["status"] == "approved"

    def test_a_rejected_clip_is_not_approved(self, owner):
        clip = make_clip(
            owner, moderation_approved=False, status="processing",
            tags=["child sexual abuse material"],
        )
        response = authed(owner).post(
            f"/clips/{clip.id}/approve-moderation/", {}, format="json"
        )
        assert response.status_code == 400
        clip.refresh_from_db()
        assert clip.moderation_approved is False


class TestThrottleWiringIsNotWeakened:
    def test_the_two_touched_actions_keep_their_scopes(self):
        from backend.app.views.content import AudioUploadViewSet

        view = AudioUploadViewSet()
        for action, scope in (
            ("public_view", "clip_public"),
            ("report_clip", "clip_report"),
            ("update", "upload"),
        ):
            view.action = action
            assert view.throttle_scope == scope, action

    def test_the_two_touched_actions_keep_their_dedicated_throttle_class(self):
        """`SCOPED_ONLY_ACTIONS` is what makes the scope apply; drop an action
        from it and the 20/hour upload cap silently starts charging a 20-view
        share link or a 20-report queue."""
        from backend.app.views.content import AudioUploadViewSet

        assert "public_view" in AudioUploadViewSet.SCOPED_ONLY_ACTIONS
        assert "report_clip" in AudioUploadViewSet.SCOPED_ONLY_ACTIONS

    def test_the_two_touched_actions_still_emit_no_credential(self, owner):
        """No path on this viewset may mint media except `play/`, and `play/`
        requires a valid share token."""
        clip = make_clip(owner)
        from backend.app.services.hls_token import generate_playback_token

        token = generate_playback_token(
            user_id=owner.pk, clip_key=token_scope(clip), ttl=600
        )
        for path, body in (
            (f"/clips/{clip.id}/public/", None),
            (f"/clips/{clip.id}/report/",
             {"report_reason": "spam", "content": "Spam."}),
        ):
            client = authed(owner) if body else anon()
            response = (
                client.post(path, body, format="json")
                if body
                else client.get(path, HTTP_ACCEPT=JSON)
            )
            assert "ef_hls_token" not in response.cookies, path
        assert anon().post(
            f"/clips/{clip.id}/play/", {"s": token}, format="json"
        ).status_code == 200
