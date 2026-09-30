"""HTTP-level tests for the share endpoints in `views/social.py`.

These endpoints had **no** coverage at all. `grep -rn "send-share"
backend/app/tests/*.py` returned zero hits before this file, which is how
`send_share` shipped with an unscoped `get_object_or_404(AudioClip, pk=pk)`
for the whole life of the feature.

Why the scoping is a security control and not tidiness
-----------------------------------------------------
`resolve_clip_access` (services/entitlements.py) grants
``ACCESS_SHARED_WITH_ME`` purely on the existence of a ``ShareEvent`` and
returns **before** the licence check, by explicit design so that a clean clip
can be shared at all. That makes a ShareEvent row a capability.

So the two-request chain was:

    POST /share/{nc_clip_id}/send-share/  {"receiver_id": <throwaway>}
        -> ShareEvent written, no validation of the clip at all
    POST /media/playback-token/{nc_clip_id}/   (as the throwaway)
        -> ACCESS_SHARED_WITH_ME, licence check never reached
        -> 200 + 600s media token

i.e. `POST /media/playback-token/` refuses an NC clip for a stranger, and two
requests through the share endpoint defeat that refusal. The same holds for
`moderation_approved=False`, which is how a takedown is enforced elsewhere.

`test_services_shares.py` covers the service layer and is still the right
place for counter/cache behaviour; this file is about what the HTTP endpoint
will and will not accept.
"""
from conftest import assert_view_queries  # noqa: E402  (query budget excl. middleware)
import pytest
from rest_framework.test import APIClient

from backend.app.models import AudioClip, ShareEvent, UserInteraction

pytestmark = pytest.mark.django_db


@pytest.fixture
def sender(django_user_model):
    return django_user_model.objects.create_user(
        username="sender", email="sender@example.com", password="pw-12345"
    )


@pytest.fixture
def receiver(django_user_model):
    return django_user_model.objects.create_user(
        username="receiver", email="receiver@example.com", password="pw-12345"
    )


@pytest.fixture
def shareable(django_user_model):
    """A clip in exactly the state the feed will serve.

    `hls_playlist_url` is set because the licensing bypass is proved end to
    end by actually minting a media token, which requires playable media.
    """
    author = django_user_model.objects.create_user(
        username="clipauthor", email="author@example.com", password="pw-12345"
    )
    clip = AudioClip.objects.create(
        creator=author,
        title="Shareable",
        category="music",
        status="ready",
        moderation_approved=True,
        duration_ms=4200,
    )
    clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
    clip.save(update_fields=["hls_playlist_url"])
    return clip


import uuid


class _StubClip:
    """Minimal object carrying only the `.id` the view reads before the
    lookup fails, so a missing-clip test does not need a real row.

    AudioClip's primary key is a UUID, so the id must be one — an integer
    raises ValidationError from the field before the 404 is reached.
    """

    def __init__(self, pk=None):
        self.id = pk or uuid.uuid4()


def authed(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def post_share(user, clip, receiver_id):
    return authed(user).post(
        f"/share/{clip.id}/send-share/",
        {"receiver_id": receiver_id},
        format="json",
    )


class TestSendShareHappyPath:
    def test_a_clean_clip_is_shared(self, sender, receiver, shareable):
        response = post_share(sender, shareable, receiver.id)
        assert response.status_code == 201, response.data
        assert ShareEvent.objects.filter(
            sender=sender, receiver=receiver, clip=shareable
        ).exists()

    def test_sharing_a_clip_you_do_not_own_is_allowed(self, sender, receiver, shareable):
        """Peer-to-peer sharing is the feature. Scoping the clip must not
        accidentally scope it to the sender's own uploads."""
        assert shareable.creator_id != sender.id
        assert post_share(sender, shareable, receiver.id).status_code == 201


class TestSendShareRejectsUnshareableClips:
    """The regression net. Each of these returned 201 and wrote a
    ShareEvent (i.e. granted a capability) before the fix."""

    def test_an_unmoderated_clip_cannot_be_shared(self, sender, receiver, shareable):
        """A takedown must not be laundered through a share row."""
        shareable.moderation_approved = False
        shareable.save(update_fields=["moderation_approved"])

        assert post_share(sender, shareable, receiver.id).status_code == 404
        assert not ShareEvent.objects.filter(clip=shareable).exists()

    def test_a_processing_clip_cannot_be_shared(self, sender, receiver, shareable):
        shareable.status = "processing"
        shareable.save(update_fields=["status"])

        assert post_share(sender, shareable, receiver.id).status_code == 404
        assert not ShareEvent.objects.filter(clip=shareable).exists()

    @pytest.mark.parametrize(
        "field,value",
        [("is_noncommercial", True), ("requires_share_alike", True)],
    )
    def test_a_licence_restricted_clip_cannot_be_shared(
        self, sender, receiver, shareable, field, value
    ):
        setattr(shareable, field, value)
        shareable.save(update_fields=[field])

        assert post_share(sender, shareable, receiver.id).status_code == 403
        assert not ShareEvent.objects.filter(clip=shareable).exists(), (
            "A ShareEvent was written for a licence-restricted clip. That row "
            "is itself the capability: it grants ACCESS_SHARED_WITH_ME, which "
            "entitlements.py returns before the licence check."
        )

    def test_a_nonexistent_clip_is_404(self, sender, receiver):
        response = post_share(sender, _StubClip(), receiver.id)
        assert response.status_code == 404
        assert not ShareEvent.objects.exists()


class TestSelfShare:
    def test_sharing_with_yourself_is_rejected(self, sender, shareable):
        """`find_user` already refuses this; `send_share` did not, so the
        restriction was a UI convention rather than a server rule."""
        response = post_share(sender, shareable, sender.id)
        assert response.status_code == 400
        assert not ShareEvent.objects.filter(receiver=sender).exists()

    def test_self_share_is_rejected_even_before_the_clip_is_valid(self, sender):
        """The self-check runs first, so it cannot be used to probe clip
        existence by passing your own id."""
        response = post_share(sender, _StubClip(), sender.id)
        assert response.status_code == 400


class TestLicenceBypassIsClosedEndToEnd:
    """The point of the fix, asserted through the real second request.

    A status-code assertion on the share endpoint only proves the share was
    refused. This proves the *consequence* is gone: after the refusal, the
    throwaway account cannot mint a media token for the NC clip, which is the
    behaviour `POST /media/playback-token/` already had.
    """

    def test_a_stranger_cannot_mint_a_token_for_a_shared_nc_clip(
        self, django_user_model, shareable
    ):
        shareable.is_noncommercial = True
        shareable.save(update_fields=["is_noncommercial"])

        attacker = django_user_model.objects.create_user(
            username="attacker", email="attacker@example.com", password="pw-12345"
        )
        victim = django_user_model.objects.create_user(
            username="victim", email="victim@example.com", password="pw-12345"
        )

        # Step 1: the share is refused outright.
        assert post_share(attacker, shareable, victim.id).status_code == 403

        # Step 2: and the victim therefore never gets the capability, so the
        # playback-token endpoint's own licence refusal still stands.
        mint = authed(victim).post(f"/media/playback-token/{shareable.id}/")
        assert mint.status_code == 403, (
            "The victim minted a media token for a NonCommercial clip. Either "
            "a ShareEvent leaked through, or the playback-token licence gate "
            "is no longer holding."
        )

    def test_a_clean_shared_clip_still_mints(self, django_user_model, shareable):
        """Negative control. If this fails, the gate is too broad and normal
        peer sharing is broken — which would be worse than the hole."""
        receiver = django_user_model.objects.create_user(
            username="cleanrecv", email="clean@example.com", password="pw-12345"
        )
        assert post_share(
            shareable.creator, shareable, receiver.id
        ).status_code == 201

        mint = authed(receiver).post(f"/media/playback-token/{shareable.id}/")
        assert mint.status_code == 200, (
            "A clean shared clip must remain playable for the recipient — the "
            "ACCESS_SHARED_WITH_ME exemption is deliberate."
        )


class TestSendShareValidation:
    def test_a_missing_receiver_id_is_400(self, sender, shareable):
        response = authed(sender).post(
            f"/share/{shareable.id}/send-share/", {}, format="json"
        )
        assert response.status_code == 400
        assert not ShareEvent.objects.exists()

    def test_an_unknown_receiver_is_404(self, sender, shareable):
        response = post_share(sender, shareable, 10**9)
        assert response.status_code == 404
        assert not ShareEvent.objects.exists()

    def test_anonymous_cannot_send(self, shareable, receiver):
        response = APIClient().post(
            f"/share/{shareable.id}/send-share/",
            {"receiver_id": receiver.id},
            format="json",
        )
        assert response.status_code in (401, 403)
        assert not ShareEvent.objects.exists()


class TestShareListQueryCount:
    """B7: `ShareEventSerializer.clip` is a nested `FeedClipSerializer`, so
    both share read endpoints serialise a LIST of clips through the same
    serializer as the feed — and neither annotated.

    Three per-row queries fired for every share:
      - `creator_name` walking clip.creator with no select_related
      - `is_liked`  falling through to a per-row UserInteraction lookup
      - `is_following` falling through to a per-row Follow lookup

    The third is a regression from 21846fe, which added the field to
    `FeedClipSerializer` and annotated the five clip endpoints but not these
    two. Measured +24% query count on both.

    These are the only tests in the repo that assert query counts on a real
    endpoint for this serializer. The two in test_is_following.py measure
    hand-built querysets that no view uses, which is how a 10-query feed page
    got a green suite — so the counts here are deliberately measured against
    the shipped view, not a reconstruction of it.
    """

    @staticmethod
    def _seed_shares(n, receiver, django_user_model):
        author = django_user_model.objects.create_user(
            username="qauthor", email="q@example.com", password="pw-12345"
        )
        for i in range(n):
            clip = AudioClip.objects.create(
                creator=author,
                title=f"Clip {i}",
                category="music",
                status="ready",
                moderation_approved=True,
                duration_ms=4000,
            )
            clip.hls_playlist_url = f"hls/{clip.id}/master.m3u8"
            clip.save(update_fields=["hls_playlist_url"])
            ShareEvent.objects.create(
                sender=author, receiver=receiver, clip=clip
            )

    def test_share_list_query_count_is_flat(self, receiver, django_user_model):
        self._seed_shares(4, receiver, django_user_model)
        client = authed(receiver)
        # One warm-up so schema/prepared-statement setup is not counted.
        client.get("/share/")
        with assert_view_queries(3):
            response = client.get("/share/")
        assert response.status_code == 200
        assert len(response.json()["results"]) == 4

    def test_inbox_query_count_is_flat(self, receiver, django_user_model):
        self._seed_shares(4, receiver, django_user_model)
        client = authed(receiver)
        client.get("/share/inbox/")
        with assert_view_queries(2):
            response = client.get("/share/inbox/")
        assert response.status_code == 200
        assert len(response.json()) == 4

    def test_the_list_is_deterministically_ordered(self, receiver,
                                                   django_user_model):
        """ShareEvent has no Meta.ordering and DRF paginates this queryset, so
        an unordered page can repeat or skip rows. Assert the order exists and
        that no UnorderedObjectListWarning is raised."""
        import warnings
        from django.core.paginator import UnorderedObjectListWarning

        self._seed_shares(3, receiver, django_user_model)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            response = authed(receiver).get("/share/")
        assert response.status_code == 200
        assert not any(
            issubclass(w.category, UnorderedObjectListWarning) for w in caught
        ), "GET /share/ is paginating an unordered queryset."

    def test_includes_is_following_on_the_nested_clip(self, sender, receiver,
                                                     shareable):
        """The field B2 added has to actually arrive on this path, or the
        annotation is pointless and the fallback is silently back."""
        post_share(sender, shareable, receiver.id)
        data = authed(receiver).get("/share/inbox/").json()
        assert data[0]["clip"]["is_following"] is False


# ---------------------------------------------------------------------------
# is_liked ignores is_active on the two share read surfaces
# ---------------------------------------------------------------------------

def _like_then_unlike(client, clip):
    """Drive the real toggle endpoint twice.

    Deliberately the HTTP endpoint rather than
    ``UserInteraction.objects.create(...)``: the defect is that the *row*
    survives the un-like, and a hand-built row would not prove that the
    production write path leaves the state the subquery then misreads. Same
    helper, same reasoning as ``test_feed_and_comments_gates.py``.
    """
    for _ in range(2):
        response = client.post(f"/interactions/{clip.id}/toggle-like/")
        assert response.status_code == 200, response.data

    row = UserInteraction.objects.get(clip=clip, interaction_type="like")
    assert row.is_active is False, (
        "precondition: the un-like must leave the row in place with "
        "is_active=False — record_like_toggle flips the flag, it does not "
        "delete. If this ever deletes instead, the defect is unreachable and "
        "these tests are measuring nothing."
    )
    return row


def _inbox_is_liked(client, clip):
    response = client.get("/share/inbox/")
    assert response.status_code == 200, response.data
    return {row["clip"]["id"]: row["clip"]["is_liked"] for row in response.json()}


def _share_list_is_liked(client, clip):
    response = client.get("/share/")
    assert response.status_code == 200, response.data
    return {row["clip"]["id"]: row["clip"]["is_liked"]
            for row in response.json()["results"]}


def _profile_clips_is_liked(client, creator):
    """`views/profile.py:62` — the independently-correct copy of the subquery.

    This is the parity target rather than a restated copy of the rule: a
    restated predicate cannot detect the two copies drifting, which is how the
    omission shipped at all.
    """
    response = client.get(f"/profile/{creator.id}/clips/")
    assert response.status_code == 200, response.data
    return {row["id"]: row["is_liked"] for row in response.json()["results"]}


class TestIsLikedRespectsIsActiveOnTheShareSurfaces:
    """REGRESSION: `_annotated_clip_prefetch` omitted `is_active=True`.

    `record_like_toggle` (`services/interactions.py:144-152`) does NOT delete
    the row on un-like — it flips `is_active=False` in place. A subquery
    without that clause therefore matches the very row that records the
    un-like, and `FeedClipSerializer.get_is_liked` returns the annotation
    verbatim when it is present (`serializers.py:669-670`), so the
    serializer's own correct fallback query is never reached.

    This is the fourth site with the identical defect. The first three were
    found and fixed in `views/feed.py` (primary path, degraded fallback,
    suggestions) in a10fe14; `serializers.py:1120` and
    `views/profile.py:62` already carried the clause. `_annotated_clip_prefetch`
    was the one remaining `user_has_liked` producer without it, so both
    `GET /share/` and `GET /share/inbox/` reported `is_liked: true` for
    every clip the recipient had explicitly un-liked.

    Both read endpoints are covered because they share the helper: fixing one
    and not the other is possible, and only the second surface would go
    unnoticed otherwise.

    Nothing here asserts on the counter store. `record_like_toggle` writes
    likes/completion keys into the Redis instance shared with every other
    agent in this stack, and this file deliberately does not request
    `clear_throttle_cache` (that fixture is a FLUSHDB) — the assertions are
    DB-backed and per-test-database, so they cannot be perturbed by another
    agent's drain.
    """

    def test_inbox_reports_an_unliked_clip_as_not_liked(
        self, sender, receiver, shareable
    ):
        post_share(sender, shareable, receiver.id)
        client = authed(receiver)
        _like_then_unlike(client, shareable)

        liked = _inbox_is_liked(client, shareable)
        assert liked == {str(shareable.id): False}, (
            f"/share/inbox/ reported {liked} after an explicit un-like. The "
            "row is still there with is_active=False, so the subquery matched "
            "it — the recipient sees a filled heart for a like they removed."
        )

    def test_share_list_reports_an_unliked_clip_as_not_liked(
        self, sender, receiver, shareable
    ):
        post_share(sender, shareable, receiver.id)
        client = authed(receiver)
        _like_then_unlike(client, shareable)

        liked = _share_list_is_liked(client, shareable)
        assert liked == {str(shareable.id): False}, (
            f"GET /share/ reported {liked} after an explicit un-like."
        )

    def test_inbox_agrees_with_profile_clips_after_unlike(
        self, sender, receiver, shareable
    ):
        """The actual bug is the *disagreement*, so assert the two screens.

        A pair of independent assertions restating the rule would both go
        red today and both go green after any patch that adds
        `is_active=True` — including one that fixes only one of them. This
        fails if either copy drifts.
        """
        post_share(sender, shareable, receiver.id)
        client = authed(receiver)
        _like_then_unlike(client, shareable)

        inbox_liked = _inbox_is_liked(client, shareable)
        profile_liked = _profile_clips_is_liked(client, shareable.creator)
        assert inbox_liked == profile_liked, (
            "the same user sees contradictory is_liked for the same clip "
            f"depending on the screen: /share/inbox/={inbox_liked} "
            f"/profile/{{id}}/clips/={profile_liked}"
        )
        assert inbox_liked == {str(shareable.id): False}

    def test_a_live_like_is_still_reported_as_liked(
        self, sender, receiver, shareable
    ):
        """The guard against fixing this by always returning False."""
        post_share(sender, shareable, receiver.id)
        client = authed(receiver)
        response = client.post(f"/interactions/{shareable.id}/toggle-like/")
        assert response.status_code == 200, response.data

        liked = _inbox_is_liked(client, shareable)
        assert liked == {str(shareable.id): True}, (
            f"/share/inbox/ reported {liked} for a like the user still holds."
        )
