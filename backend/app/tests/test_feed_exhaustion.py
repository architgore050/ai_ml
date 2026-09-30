"""Regression tests for candidate recovery when a small catalogue is exhausted."""
from datetime import timedelta

import pytest
from django.utils import timezone

from backend.app.models import AudioClip, UserInteraction
from ai_ml.pipelines.recommendation import build_feed_candidates


pytestmark = pytest.mark.django_db


def _clip(user, title, *, status='ready', engagement=0.0):
    return AudioClip.objects.create(
        creator=user,
        title=title,
        status=status,
        engagement_velocity=engagement,
    )


def _seen(user, clip, when):
    interaction = UserInteraction.objects.create(
        user=user,
        clip=clip,
        interaction_type='view',
    )
    UserInteraction.objects.filter(pk=interaction.pk).update(created_at=when)


def test_unseen_candidates_are_preferred_over_recovery_candidates(user):
    """The recovery path must never weaken the normal 30-day seen policy."""
    seen = _clip(user, 'already-seen', engagement=100)
    unseen = _clip(user, 'new-to-user', engagement=1)
    _seen(user, seen, timezone.now() - timedelta(days=1))

    candidates = build_feed_candidates(user.id, count=10, pool_first=False)

    assert candidates == [str(unseen.id)]


def test_exhausted_catalogue_re_serves_least_recently_seen_clip_first(user):
    """An exhausted user gets a finite repeat feed instead of permanent 202."""
    oldest = _clip(user, 'oldest-repeat', engagement=1)
    newest = _clip(user, 'newest-repeat', engagement=100)
    now = timezone.now()
    _seen(user, oldest, now - timedelta(days=20))
    _seen(user, newest, now - timedelta(days=1))

    candidates = build_feed_candidates(user.id, count=10, pool_first=False)

    assert candidates == [str(oldest.id), str(newest.id)]


def test_feed_recovery_never_returns_an_unready_clip(user):
    ready = _clip(user, 'ready-repeat')
    processing = _clip(user, 'still-processing', status='processing')
    now = timezone.now()
    _seen(user, ready, now - timedelta(days=2))
    _seen(user, processing, now - timedelta(days=3))

    candidates = build_feed_candidates(user.id, count=10, pool_first=False)

    assert candidates == [str(ready.id)]
