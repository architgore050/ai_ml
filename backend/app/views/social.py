"""Social views: sharing and following.

DECISION: Split out of monolithic views.py in 2026-09.
Stage 2 (relational-to-event-driven plan): ORM writes go through
backend.app.services.follows and backend.app.services.shares.

ShareViewSet is now GenericViewSet + List + Retrieve + Destroy, NOT
ModelViewSet. The router-default POST /share/ (modelviewset's create)
crashed with an IntegrityError because ShareEventSerializer has no
writable sender/receiver fields — the only legitimate create path is
the @action send_share which uses the shares_svc service. Narrowing the
mixin set makes POST /share/ return 405 Method Not Allowed instead of
500. List/retrieve/destroy continue to work as before.
"""
import logging

from django.contrib.auth import get_user_model
from django.db.models import Exists, OuterRef
from django.shortcuts import get_object_or_404
from rest_framework import generics, mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from ..models import AudioClip, ShareEvent, UserInteraction
from ..serializers import ShareEventSerializer, following_annotation
from ..services import follows as follows_svc
from ..services import shares as shares_svc
from ..services.entitlements import is_license_restricted

logger = logging.getLogger(__name__)


def _annotated_clip_prefetch(viewer):
    """Prefetch `clip` as a queryset carrying the serializer's fast paths.

    B7. Annotating the `ShareEvent` queryset does NOT work here, and the
    reason is easy to get wrong: `ShareEventSerializer.clip` is a nested
    `FeedClipSerializer`, so the object being serialised is the **AudioClip**,
    not the ShareEvent. An annotation placed on the ShareEvent row is never
    seen by `FeedClipSerializer.get_is_liked` / `get_is_following`, which
    look for `user_has_liked` / `user_is_following` on the clip. Measured:
    annotating the ShareEvent left both falling through to per-row queries
    (4 shares -> 10 queries, 2 of them per clip).

    `select_related` cannot carry annotations either. A `Prefetch` with its own
    annotated queryset does: the clips arrive in one extra query with the
    annotations attached, and Django caches one AudioClip per distinct clip id,
    so a clip shared by five senders is fetched and evaluated once.
    """
    from django.db.models import Prefetch

    return Prefetch(
        'clip',
        queryset=AudioClip.objects
        .select_related('creator')
        .annotate(
            # `is_active=True` is required for the same reason as in
            # FastFeedViewSet (feed.py:119-122): un-like flips the flag rather
            # than deleting the row, so without the clause every un-liked clip
            # in the inbox reads as liked on both share surfaces too.
            user_has_liked=Exists(
                UserInteraction.objects.filter(
                    clip=OuterRef('pk'),
                    user=viewer,
                    interaction_type='like',
                    is_active=True,
                )
            ),
            **following_annotation(viewer),
        ),
    )

User = get_user_model()


class ShareViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    # SECURITY: 100 shares/hour/user prevents inbox-spam DoS. Only
    # send_share uses this tight rate; read actions (inbox, find_user,
    # unread_count) share a looser 'share_poll' scope (see get_throttles).
    throttle_scope = 'share_send'
    serializer_class = ShareEventSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return ShareEvent.objects.filter(
            receiver=self.request.user
        ).select_related('sender').prefetch_related(
            _annotated_clip_prefetch(self.request.user)
            # Deterministic order. `ShareEvent` has no Meta.ordering, and
            # DRF paginates this queryset, so without an explicit order_by
            # Postgres may return rows in any order and a row can appear on
            # two pages or on none (UnorderedObjectListWarning). `-id` breaks
            # ties when two shares share a created_at.
        ).order_by('-created_at', '-id')

    def get_throttles(self):
        # SECURITY: Per-action throttle dispatch (mirrors the pattern in
        # ClipInteractionViewSet). Only send_share gets the tight
        # 'share_send' rate; read actions get the looser 'share_poll'
        # rate so a polling inbox badge doesn't burn the share-send
        # budget. 100 shares/hour is a spam guard; 1000/hour is enough
        # for a client polling every 3.6s.
        from rest_framework.throttling import ScopedRateThrottle
        if self.action == 'send_share':
            return [ScopedRateThrottle()]
        return super().get_throttles()

    @property
    def throttle_scope(self):
        if self.action == 'send_share':
            return 'share_send'
        return 'share_poll'

    @action(detail=False, methods=['get'], url_path='find-user')
    def find_user(self, request):
        """Look a peer up by username for the share flow.

        SECURITY / R5-07: this was `User.objects.get(username__iexact=…)`
        with `except User.DoesNotExist`. `User.username` is `unique=True` on a
        case-SENSITIVE column (`varchar(150)` under `en_US.utf8`, verified:
        `SELECT 'alice' = 'Alice'` -> false, `'alice' ILIKE 'Alice'` -> true),
        so `alice` and `Alice` are both storable and `iexact` matches both.
        `.get()` requires exactly one row, `MultipleObjectsReturned` is not a
        `DoesNotExist`, and the exception escaped as a 500 — from two
        registrations and one GET, on the public share path.

        Two rows is the whole answer set here, so the query is sliced at 2
        rather than counted. That keeps this at one query on every path,
        which `len(User.objects.filter(...).count())` would not: the count
        would be a second round trip on every single hit, the common case.

        On a collision the answer is 409, not a silent pick:
          * Both candidates are real, reachable accounts. Returning the
            lowest `pk` would deliver the share to whichever row happened to
            be created first — which is exactly the account an attacker
            squats, since squatting means registering the name you want
            shadowed. The listing order would be the attacker-tunable half of
            the attack, and the UI would show the victim's name while
            `send-share` wrote a ShareEvent for the impostor.
          * A 404 would be worse than either: it tells someone looking for a
            colleague that the colleague does not exist, and invites them to
            re-search forever.
          * 409 says the true thing — the name is taken, ambiguously — and
            both are representable by the client: `ShareModal`'s
            `lookupFailureMessage` already distinguishes 404 from "some other
            status". It needs a 409 branch to show this particular message;
            today it falls through to its generic "could not complete that
            search". Presentation is the frontend's to fix; the semantic
            status is this side's to get right.

        The real fix is a case-insensitive uniqueness constraint plus a data
        migration to resolve rows that already collide. Until that exists,
        colliding rows must be *reported* rather than crashed on, so this logs
        them: a collision is a data-integrity event, not a client error, and
        it is otherwise invisible — every other lookup of that name succeeds.

        `iexact` is deliberately kept: typing `ALICE` should find `alice`.
        """
        username = request.query_params.get('username', '').strip()
        if not username:
            return Response({'error': 'Username required'}, status=400)

        matches = list(
            User.objects.filter(username__iexact=username).order_by('pk')[:2]
        )
        if not matches:
            return Response({'error': f'No user found: @{username}'}, status=404)

        if len(matches) > 1:
            logger.warning(
                "find_user refused: username=%r is ambiguous across %d accounts "
                "(pk=%s). Resolved by a case-insensitive uniqueness "
                "constraint; until that migration lands this name is unusable "
                "for sharing.",
                username, len(matches), [u.pk for u in matches],
            )
            return Response(
                {'error': 'More than one account matches that username. '
                          'Try the exact spelling, or ask them to change it.'},
                status=status.HTTP_409_CONFLICT,
            )

        user = matches[0]
        if user == request.user:
            return Response({'error': "You can't share with yourself"}, status=400)
        return Response({'id': user.id, 'username': user.username})

    @action(detail=True, methods=['post'], url_path='send-share')
    def send_share(self, request, pk=None):
        """Send a clip to another user, creating an inbox item.

        SECURITY: the clip lookup is scoped. It was
        `get_object_or_404(AudioClip, pk=pk)`, which accepted *any* clip id in
        the table — unmoderated, unencoded, NonCommercial or ShareAlike.

        That is not a cosmetic validation gap. `resolve_clip_access` grants
        ``ACCESS_SHARED_WITH_ME`` on the existence of a ShareEvent and returns
        BEFORE the licence check (entitlements.py:108-110, by explicit design
        so a clean clip can be shared). So sharing an NC clip to a throwaway
        account handed that account playback of audio the feed is built to
        withhold, in two requests:

            POST /share/{nc_clip_id}/send-share/  {"receiver_id": <other>}
            POST /media/playback-token/{nc_clip_id}/       -> 200 + token

        `send-share` had no tests at all, so nothing pinned this.

        The filter below is the same one the feed uses (feed.py:135-137,
        183-186) rather than an independently-chosen set, so "what the feed
        will show" and "what can be shared" cannot drift apart. Reusing
        `is_license_restricted` for the NC/SA half keeps the rule in the one
        module whose docstring says it is the single source of truth.
        """
        receiver_id = request.data.get('receiver_id')
        if not receiver_id:
            return Response({'error': 'Receiver ID required'}, status=status.HTTP_400_BAD_REQUEST)

        # Mirrors find_user's own guard. Sharing with yourself produced a real
        # ShareEvent and a real counter increment for no benefit.
        if str(receiver_id) == str(request.user.pk):
            return Response(
                {'error': "You can't share with yourself"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        receiver = get_object_or_404(User, id=receiver_id)

        clip = get_object_or_404(
            AudioClip.objects.filter(
                status='ready',
                moderation_approved=True,
            ),
            pk=pk,
        )
        if is_license_restricted(clip):
            logger.warning(
                "send_share refused: licence-restricted clip=%s nc=%s sa=%s",
                clip.id, clip.is_noncommercial, clip.requires_share_alike,
            )
            return Response(
                {'error': 'This clip may not be shared'},
                status=status.HTTP_403_FORBIDDEN,
            )

        shares_svc.send_share(sender=request.user, clip=clip, receiver=receiver)
        return Response({'status': 'shared successfully'}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path='share-delete')
    def share_delete(self, request, pk=None):
        ShareEvent.objects.filter(pk=pk, receiver=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'], url_path='mark-read')
    def mark_read(self, request, pk=None):
        ShareEvent.objects.filter(pk=pk, receiver=request.user).update(is_read=True)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=False, methods=['get'], url_path='inbox')
    def inbox(self, request):
        shares = (
            ShareEvent.objects
            .filter(receiver=request.user)
            .select_related('sender')
            .prefetch_related(_annotated_clip_prefetch(request.user))
            .order_by('-created_at')
        )
        serializer = ShareEventSerializer(shares, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=['get'], url_path='unread-count')
    def unread_count(self, request):
        count = ShareEvent.objects.filter(receiver=request.user, is_read=False).count()
        return Response({'unread': count})


class FollowViewSet(viewsets.ViewSet):
    """
    Social graph: follow / unfollow.
    ENDPOINT: POST /follow/{user_id}/toggle-follow/
    """
    permission_classes = [permissions.IsAuthenticated]

    @action(detail=True, methods=['post'], url_path='toggle-follow')
    def toggle_follow(self, request, pk=None):
        target_user = get_object_or_404(User, pk=pk)
        if target_user == request.user:
            return Response({'error': 'You cannot follow yourself.'}, status=status.HTTP_400_BAD_REQUEST)

        result = follows_svc.toggle_follow(actor=request.user, target=target_user)
        status_code = status.HTTP_201_CREATED if result == 'followed' else status.HTTP_200_OK
        return Response({'status': result}, status=status_code)
