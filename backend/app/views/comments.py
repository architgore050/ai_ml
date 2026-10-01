"""Comment views.

Stage 2 (relational-to-event-driven plan): serializer handles validation
+ the model.save()/delete() F() side-effect lives in the model itself.
The service is invoked via perform_create/perform_update/perform_destroy
so the ViewSet surface (URLs, status codes, throttling) is unchanged.

N1 fix: any authenticated user can PATCH/DELETE any other user's comment.
CommentViewSet was a ModelViewSet with no per-object permission. The
fix is two-layered:
1. get_queryset() scopes write actions (update/destroy) to comments
   owned by request.user. Reads (list/retrieve) stay visible subject to
   the clip-state gate below.
2. An IsAuthorOrReadOnly object-level permission denies unsafe methods
   even if get_queryset is bypassed. Defense in depth.

Read-path clip gate (R5-05)
---------------------------
The queryset used to be ``Comment.objects.select_related('author').all()``
— no moderation check, no status check, no NC/SA check, and this module
did not even import ``AudioClip``. Three separate leaks, fixed three ways:

1. ``GET /comments/?clip=<id>`` returned every comment on a clip that no
   feed, suggestion or profile listing serves. A comment row carries
   ``author_username``, ``author_id`` and free text, so this discloses who
   engaged with a never-approved draft or with NonCommercial / ShareAlike
   audio. That is licensing *metadata* and an internal-state disclosure, not
   a redistribution bypass: the audio itself stays behind
   ``resolve_clip_access`` and the token-gated HLS edge either way.
2. ``GET /comments/?clip=<id that does not exist>`` returned **200 with an
   empty list** — the same body as a readable clip with no comments. That is
   an enumeration oracle over the clip-UUID space. Fixed by making an
   unreadable clip and a missing clip answer identically (both 404).
3. Bare ``GET /comments/`` and ``?parent=<id>`` name no clip at all, so no
   per-request check is possible. Left alone they walk straight past the
   ``?clip=`` check: ``parent`` is an independent ``filterset_fields`` entry
   and is client-supplied on create. The bare list is a paginated dump of
   the entire comment table with usernames attached.

The scoping decision, explicitly
--------------------------------
* **LIST with ``?clip=``** — 404 unless the clip exists *and* is readable by
  this caller. Deliberately one status code for "missing" and "withheld",
  for the reason in (2) above. A malformed (non-UUID) value is a 400: it
  cannot name a real row, so telling the caller it is malformed leaks
  nothing.
* **LIST bare, or with ``?parent=``** — no per-request check is possible, so
  the *queryset* is restricted to comments on readable clips. This is the
  only thing that closes (3); a 404 on ``?clip=`` alone leaves the endpoint
  fully walkable.
* **``GET /comments/{id}/``** — symmetric with the list. A comment on an
  unreadable clip is 404 for everyone except the clip's creator.
* **Writes are NOT gated.** An author can always update and delete their own
  comment regardless of the clip's state. That is the GDPR-erasure and
  content-takedown path; gating it would mean a comment on a withdrawn clip
  can never be removed by anyone, which trades a metadata disclosure for a
  compliance regression.

The owner exemption, and why this is not a blanket filter
--------------------------------------------------------
A filter with no exception hides a comment thread from the person who
uploaded the clip and wrote the comments — precisely when they most need to
see and delete it (moderation approval revoked, licence reclassified as NC).
``_readable_clips`` therefore ORs in ``creator=user``, mirroring the owner
exemption already in ``services/entitlements.resolve_clip_access`` (point 2:
NC/SA restrict *redistribution*; the uploader must still reach their own
content). The creator's *unmoderated draft* is likewise theirs, not
unpublished state about someone else.

Known divergence, recorded rather than silently inherited
---------------------------------------------------------
``resolve_clip_access`` also exempts a user the clip was in-app shared with
(``ACCESS_SHARED_WITH_ME``) before it applies the licence filter. This gate
does **not** copy that: the clip-listing paths (``feed.py``,
``views/profile.py``) do not exempt sharees either, and matching them is what
keeps "what is servable" from having three divergent definitions. A sharee of
an NC clip can play the audio but cannot read its comment thread. If that
matters, the fix is to change the listing paths together, not to special-case
comments.
"""
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Q
from django.http import Http404
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import viewsets, permissions
from rest_framework.exceptions import ValidationError as DRFValidationError
from rest_framework.permissions import BasePermission

from ..models import AudioClip, Comment
from ..serializers import CommentSerializer
from ..services import comments as comments_svc
from ._pagination import CommentCursorPagination


class IsAuthorOrReadOnly(BasePermission):
    """Object-level: only the comment author may update or destroy.

    GET/HEAD/OPTIONS remain public (the audit's design intent: public
    reads for threaded conversations; private writes).
    """

    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.author_id == request.user.id


class CommentViewSet(viewsets.ModelViewSet):
    # SECURITY: 60 comments/hour/user prevents comment spam. Default
    # 1000/hour/user lets one account post every 3.6s indefinitely.
    throttle_scope = 'comment'
    serializer_class = CommentSerializer
    # N1: two layers of defense. IsAuthenticated gates the endpoint;
    # IsAuthorOrReadOnly gates the per-object write. (get_queryset also
    # scopes writes below, so an attacker who somehow passes the
    # object-perm check still gets a 404 from a filtered queryset.)
    permission_classes = [permissions.IsAuthenticated, IsAuthorOrReadOnly]
    pagination_class = CommentCursorPagination
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['clip', 'parent']

    # Actions whose queryset is restricted to comments on readable clips.
    # Writes are excluded on purpose — see the module docstring.
    _READ_ACTIONS = ('list', 'retrieve')

    @staticmethod
    def _readable_clips(user):
        """Clips whose comment thread `user` may read.

        The predicate is the feed's own — ``status='ready'``,
        ``moderation_approved=True``, ``is_noncommercial=False``,
        ``requires_share_alike=False`` — as applied at
        ``views/feed.py:125+158+159`` and ``views/profile.py:80-86``, OR'd
        with "you created it".

        The two branches are an OR of positively-indexed column predicates
        rather than an ``exclude()`` over the inverse, so the subquery that
        ``get_queryset`` builds (``clip__in=...``) plans off the existing
        btrees on ``status`` / ``is_noncommercial`` / ``requires_share_alike``
        instead of degrading to a sequential scan over the clip table.

        Copied rather than imported on purpose: a helper shared with the feed
        would be one more place the rule can be edited without the other
        copies noticing. The comments here and in profile.py are the tripwire
        if these ever need to diverge.
        """
        return AudioClip.objects.filter(
            Q(creator=user)
            | Q(
                status='ready',
                moderation_approved=True,
                is_noncommercial=False,
                requires_share_alike=False,
            )
        )

    def _assert_clip_readable(self, user, raw_clip):
        """404 unless `raw_clip` names a clip this user may read.

        One status code for "no such clip" and "withheld clip", so the
        endpoint cannot be used to learn which clip UUIDs exist or which
        licence/mod moderation state a clip carries. A malformed value is a
        400 — it cannot name a real row, so the distinction leaks nothing,
        and `filter(pk='not-a-uuid')` raises `DjangoValidationError` which
        would otherwise surface as a 500.
        """
        try:
            exists = self._readable_clips(user).filter(pk=raw_clip).exists()
        except (DjangoValidationError, ValueError, TypeError):
            raise DRFValidationError({
                'clip': 'Must be a valid AudioClip id (UUID).',
            })
        if not exists:
            raise Http404

    def get_queryset(self):
        # Reads (list/retrieve) are restricted to comments on clips the
        # requester may read; see the module docstring for why this is a
        # queryset filter and not only a `?clip=` check. Writes
        # (update/destroy) are scoped to comments the requester owns, which
        # is what makes a non-author's PATCH/DELETE a 404 rather than a 403
        # — the standard DRF pattern, and it doesn't leak comment existence.
        qs = Comment.objects.select_related('author')
        if self.action in ('update', 'partial_update', 'destroy'):
            return qs.filter(author=self.request.user)
        if self.action in self._READ_ACTIONS:
            qs = qs.filter(clip__in=self._readable_clips(self.request.user))
        return qs.all()

    def list(self, request, *args, **kwargs):
        # `?clip=` is the one filter where the caller names the clip, so it is
        # the one place a per-request answer is possible. 404 on a withheld
        # or missing clip; `get_queryset` still applies, so this is
        # belt-and-braces rather than the only defence.
        raw_clip = request.query_params.get('clip')
        if raw_clip is not None:
            self._assert_clip_readable(request.user, raw_clip)
        return super().list(request, *args, **kwargs)

    def perform_create(self, serializer):
        # Assign back so DRF's response renderer (get_success_headers,
        # serializer.data) sees the persisted instance, not validated_data.
        serializer.instance = comments_svc.create_comment(
            user=self.request.user,
            clip=serializer.validated_data['clip'],
            text=serializer.validated_data['text'],
            parent=serializer.validated_data.get('parent'),
        )

    def perform_update(self, serializer):
        comments_svc.update_comment(serializer.instance, text=serializer.validated_data['text'])

    def perform_destroy(self, instance):
        comments_svc.delete_comment(instance)
