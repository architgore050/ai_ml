"""Clip playback entitlement resolution.

DECISION: A single predicate decides whether a user may be issued a playback
token for a clip. It lives here rather than inline in ``PlaybackTokenView``
because the share pipeline (A4) needs the same answer, and two copies of an
authorization rule will eventually disagree.

Why this exists
---------------
``PlaybackTokenView`` used to authorize on four things only: the caller is
authenticated, the clip exists, ``moderation_approved`` is true, and HLS
output exists. That is a licensing bypass rather than a privacy nit, because
``FastFeedViewSet`` also filters::

    .filter(is_noncommercial=False, requires_share_alike=False)

and the token endpoint applied neither. Any logged-in user who learned a clip
UUID could mint a token for a NonCommercial or ShareAlike clip that the feed
deliberately never serves. This module closes that.

What this deliberately does NOT do
----------------------------------
It does not restrict playback to clips that were *served* to this user. An
earlier draft returned a ``not_entitled`` denial for unrelated users, and
that was wrong — it would have broken the feed.

The feed is not built from a social graph. ``services/feed_pool.py`` builds
both halves from ``AudioClip.objects.filter(status='ready')``: the exploit
side is a global vector-similarity ranking, and the explore side only
``.exclude(id__in=seen_ids)``. Neither is scoped to authors the user
follows or clips they have interacted with. So most clips in any user's
feed come from authors with no relationship to them, and denying those would
403 the primary playback path for most of the catalogue.

The residual risk is therefore: a user who obtains a clip UUID they were
never sent can still mint a token for it, provided the clip is moderated
and license-clean. UUIDv4 is not enumerable and the app's own routes already
expose IDs, so this is accepted for v1. Closing it properly needs a
served-log (a table of what was actually served, or a durable record of
feed pops), which is a schema change — not a predicate change.

In short: **this is a licensing gate, not a privacy gate.** It answers
"may this audio be redistributed to this caller", not "was this caller sent
this clip".
"""

#: Reasons a caller may be granted playback. Descriptive — they say *why*
#: access was granted, for logs and analytics. Only the DENY_* values gate.
ACCESS_OWNER = "owner"
ACCESS_SHARED_WITH_ME = "shared_with_me"
ACCESS_FOLLOWED_AUTHOR = "followed_author"
ACCESS_INTERACTED = "interacted"
ACCESS_PUBLIC_CLEAN = "public_clean"

#: Reasons playback is refused. These are the only two gates.
DENY_NOT_MODERATED = "not_moderated"
DENY_LICENSED = "license_restricted"


def is_license_restricted(clip) -> bool:
    """Return True if the clip may not be redistributed outside its owner.

    NonCommercial (NC) and ShareAlike (SA) clips are excluded from every feed
    and suggestion query for licensing reasons. This is the predicate that
    ``PlaybackTokenView`` was missing.
    """
    return bool(clip.is_noncommercial or clip.requires_share_alike)


def resolve_clip_access(user, clip) -> tuple[bool, str]:
    """Return ``(allowed, reason)`` for issuing a playback token.

    Args:
        user: the authenticated ``User`` requesting playback.
        clip: the ``AudioClip`` being requested.

    Returns:
        A ``(bool, reason)`` pair. ``reason`` is one of the ``ACCESS_*`` or
        ``DENY_*`` constants above, and is intended for logging and for
        distinguishing 403 causes in tests — it is not returned to clients
        verbatim, since that would tell an unauthorised caller which
        licenses a clip carries.

    Rationale for the ordering:

    1. ``moderation_approved`` gates **everyone**, owner included. That is
       existing behaviour (the upload flow only produces HLS after approval)
       and this is not the place to change policy.
    2. The owner is exempt from the license restriction. NC/SA restrict
       *redistribution*; the uploader still has to be able to hear what they
       uploaded.
    3. An in-app share to this specific user is also exempt, on the basis
       that sharing to a named recipient is a deliberate act by the owner.
       JUDGEMENT CALL — flagged for review: if NC is interpreted as "not
       distributed to third parties at all", drop this exemption and require
       ``ACCESS_OWNER``.
    4. The license restriction then gates everyone else. This is the bug
       being fixed.
    5. Otherwise the clip is allowed. Following the author or having
       interacted is reported as the reason where true, purely for logs.
    """
    if not clip.moderation_approved:
        return False, DENY_NOT_MODERATED

    if clip.creator_id == user.id:
        return True, ACCESS_OWNER

    if _was_shared_with(user, clip):
        # See rationale point 3 — exemption from the license filter.
        return True, ACCESS_SHARED_WITH_ME

    if is_license_restricted(clip):
        return False, DENY_LICENSED

    if _follows_author(user, clip):
        return True, ACCESS_FOLLOWED_AUTHOR

    if _has_interaction(user, clip):
        return True, ACCESS_INTERACTED

    return True, ACCESS_PUBLIC_CLEAN


def _was_shared_with(user, clip) -> bool:
    """True if a ShareEvent sent this clip to this user, in-app.

    Imports are local to keep this module importable from serializers and
    management commands without dragging in the app registry at import time.
    """
    from backend.app.models import ShareEvent

    return ShareEvent.objects.filter(
        receiver=user,
        clip=clip,
    ).exists()


def _follows_author(user, clip) -> bool:
    """True if the caller follows the clip's creator."""
    return user.following.filter(pk=clip.creator_id).exists()


def _has_interaction(user, clip) -> bool:
    """True if the caller has any recorded interaction with the clip.

    Deliberately not filtered by ``interaction_type``: any type at all is
    evidence the user legitimately encountered the clip, and enumerating
    types here would mean a new ``UserInteraction.TYPES`` value silently
    starts denying playback.
    """
    from backend.app.models import UserInteraction

    return UserInteraction.objects.filter(user=user, clip=clip).exists()
