"""Cold-start pipeline for new users.

The onboarding endpoint validates request data and delegates the actual
baseline construction here. Keeping the database query in this pipeline makes
the documented AI/ML entry point usable by workers and future clients without
duplicating the vector-averaging logic in a view.
"""

from __future__ import annotations

import numpy as np


def initialize_user_vectors(user, selected_tags: list[str]):
    """Bootstrap user vectors from tag selection.

    Returns the number of eligible baseline clips used. ``ValueError`` means
    there was not enough approved, vectorized catalogue data to initialize the
    user and is intentionally free of HTTP concerns.
    """
    from django.db.models import Q
    from backend.app.models import AudioClip

    if not selected_tags:
        raise ValueError("selected_tags must contain at least one tag")

    # JSONField arrays require JSONB containment (`tags__contains`), not the
    # ArrayField-only `tags__overlap` lookup that silently returned no rows.
    tag_filter = Q()
    for tag in selected_tags:
        tag_filter |= Q(tags__contains=[tag])

    baseline_clips = list(
        AudioClip.objects.filter(
            tag_filter,
            semantic_vector__isnull=False,
            acoustic_vector__isnull=False,
            moderation_approved=True,
        ).order_by('-likes')[:100]
    )
    if not baseline_clips:
        raise ValueError("Not enough data to build baseline.")

    user.long_term_semantic = np.mean(
        [np.asarray(clip.semantic_vector) for clip in baseline_clips], axis=0
    ).tolist()
    user.long_term_acoustic = np.mean(
        [np.asarray(clip.acoustic_vector) for clip in baseline_clips], axis=0
    ).tolist()
    user.save(update_fields=['long_term_semantic', 'long_term_acoustic'])
    return len(baseline_clips)
