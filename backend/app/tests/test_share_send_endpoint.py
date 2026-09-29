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
import pytest
from rest_framework.test import APIClient

from backend.app.models import AudioClip, ShareEvent

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
