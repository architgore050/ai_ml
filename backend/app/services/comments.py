"""Comment service layer.

Stage 2 boundary. Preserves the existing counter-side-effect semantics:
the AudioClip.comment_count F() bump on save()/delete() of a TOP-LEVEL
comment (parent_id IS NULL) lives in Comment.save()/delete() in the
model, not here — the service simply calls those methods.

This module is the single place to add business rules (rate, profanity
filter, thread depth cap) without touching the ViewSet.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import ValidationError

from ..models import AudioClip, Comment


def create_comment(user, clip: AudioClip, text: str, parent: Comment | None = None) -> Comment:
    """Create a comment. Reply vs top-level semantics are enforced in the model.

    Reply (parent is not None): does NOT increment AudioClip.comment_count.
    Top-level (parent is None): the model's save() bumps the counter via F().

    `parent` is client-supplied and must live on the same clip.

    SECURITY: without this check a reply can be filed under clip A while
    pointing at a parent on clip B. Both FKs resolve, so the row is valid and
    no database constraint rejects it — but the thread reads as split, since
    `?clip=A` returns the reply and `?clip=B` returns its parent.

    DECISION: checked here rather than in `CommentSerializer.validate`, because
    the invariant is about the row, not the request. A serializer check guards
    exactly one entry point (`POST /comments/`); every other caller of this
    service — a moderation import, a management command, a test fixture — could
    still write the broken row. This module is the documented single place for
    comment business rules precisely so they are not re-implemented per caller.

    The cost is importing `rest_framework`. That is what makes this a 400:
    DRF 3.18's `exception_handler` only recognises `APIException`, `Http404`
    and `PermissionDenied`, so Django's own `ValidationError` would surface
    from the view as a 500. `exceptions.ValidationError` is a leaf module that
    reads no settings, so the service is not coupled to HTTP configuration.
    """
    if parent is not None and parent.clip_id != clip.pk:
        raise ValidationError({
            'parent': 'Parent comment must be on the same clip.',
        })
    return Comment.objects.create(author=user, clip=clip, text=text, parent=parent)


def update_comment(comment: Comment, text: str) -> Comment:
    comment.text = text
    comment.save(update_fields=['text'])
    return comment


@transaction.atomic
def delete_comment(comment: Comment) -> None:
    """Delete a comment. The model's delete() decrements the parent's counter
    if this was a top-level comment."""
    comment.delete()
