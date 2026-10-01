"""B2 — `is_following` on clip and profile serializers.

The client could not read whether it already followed a creator, and
`POST /follow/{id}/toggle-follow/` is a *toggle*. So the Follow button in
`ReelCard.tsx` initialised `isFollowing` to `useState(false)` and always
showed "Follow" — and tapping it on someone already followed silently
unfollowed them. No confirmation, no feedback, a real FK mutation either way.

The backend already returned `{status: 'followed'|'unfollowed'}`; the state
was one serializer field away.

Scope of these tests:
  1. the field exists and is correct on all three serializers
  2. the annotation fast path is used (one query per page, not one per clip)
  3. the N+1 that a naive implementation would introduce does not appear
  4. edge cases: unauthenticated, self, no request context
"""
import pytest

from backend.app.serializers import (
    FeedClipSerializer,
    OwnProfileSerializer,
    PublicProfileSerializer,
    following_annotation,
)


pytestmark = pytest.mark.django_db


@pytest.fixture
def creator(django_user_model):
    return django_user_model.objects.create_user(
        username='creator', email='creator@example.com', password='test-pass-1234'
    )


@pytest.fixture
def clip_of(creator):
    from backend.app.models import AudioClip
    from django.utils import timezone

    def _make(count=1, other_creator=None):
        clips = []
        for i in range(count):
            clips.append(AudioClip.objects.create(
                title=f'Clip {i}',
                category='comedy',
                creator=other_creator or creator,
                status='ready',
                moderation_approved=True,
                duration_ms=60_000,
                created_at=timezone.now() - timezone.timedelta(minutes=i),
            ))
        return clips
    return _make


class _FakeRequest:
    """Minimal DRF-request stand-in.

    Always sets a real user object — DRF guarantees `request.user` is at
    worst `AnonymousUser`, never `None`. A `None` user would crash the
    pre-existing `get_is_liked` guard (`request.user.is_authenticated`), so
    using `None` here would fail for a reason that has nothing to do with
    B2.
    """

    def __init__(self, user):
        from django.contrib.auth.models import AnonymousUser
        self.user = user if user is not None else AnonymousUser()


class TestFeedClipIsFollowing:
    def test_field_is_present(self, clip_of, auth_client):
        clip_of()
        data = FeedClipSerializer(clip_of(1), many=True, context={'request': _FakeRequest(None)}).data
        assert 'is_following' in data[0]

    def test_false_when_not_following(self, user, creator, clip_of):
        clips = clip_of(1)
        data = FeedClipSerializer(clips, many=True,
                                  context={'request': _FakeRequest(user)}).data
        assert data[0]['is_following'] is False

    def test_true_when_following(self, user, creator, clip_of):
        clip_of(1)
        user.following.add(creator)
        clips = clip_of(1)
        data = FeedClipSerializer(clips, many=True,
                                  context={'request': _FakeRequest(user)}).data
        assert data[0]['is_following'] is True

    def test_false_for_own_clip(self, user, clip_of):
        """Self-follow 400s at the endpoint, so the field must read False."""
        clips = clip_of(1, other_creator=user)
        data = FeedClipSerializer(clips, many=True,
                                  context={'request': _FakeRequest(user)}).data
        assert data[0]['is_following'] is False

    def test_false_for_unauthenticated(self, creator, clip_of):
        from django.contrib.auth.models import AnonymousUser
        clips = clip_of(1)
        data = FeedClipSerializer(clips, many=True,
                                  context={'request': _FakeRequest(AnonymousUser())}).data
        assert data[0]['is_following'] is False

    def test_false_without_request_context(self, clip_of):
        clips = clip_of(1)
        data = FeedClipSerializer(clips, many=True).data
        assert data[0]['is_following'] is False

    def test_reflects_a_follow_made_after_the_page_loaded(self, user, creator, clip_of):
        """The fallback path must read live state, not a snapshot."""
        clips = clip_of(1)
        serializer = FeedClipSerializer(clips, many=True,
                                        context={'request': _FakeRequest(user)})
        assert serializer.data[0]['is_following'] is False

        user.following.add(creator)

        serializer = FeedClipSerializer(clips, many=True,
                                        context={'request': _FakeRequest(user)})
        assert serializer.data[0]['is_following'] is True

    def test_annotation_takes_precedence(self, user, creator, clip_of):
        """When annotated, the value wins — that is the whole point of B2."""
        from backend.app.models import AudioClip

        clip_of(1)
        annotated = AudioClip.objects.annotate(**following_annotation(user))
        # user does not follow creator, so the annotation must say False
        data = FeedClipSerializer(annotated, many=True,
                                  context={'request': _FakeRequest(user)}).data
        assert data[0]['is_following'] is False

        user.following.add(creator)
        annotated = AudioClip.objects.annotate(**following_annotation(user))
        data = FeedClipSerializer(annotated, many=True,
                                  context={'request': _FakeRequest(user)}).data
        assert data[0]['is_following'] is True

    def test_annotation_is_empty_for_anonymous(self):
        from django.contrib.auth.models import AnonymousUser
        # `is_authenticated`, not truthiness — AnonymousUser is truthy but
        # has no `following` manager, so a truthy check raises AttributeError.
        assert following_annotation(AnonymousUser()) == {}
        assert following_annotation(None) == {}


class TestIsFollowingQueryCount:
    """B2's cost control: the per-page annotation, not a per-clip query.

    The plan's risk table flagged `is_following` adding a per-row query as
    Medium likelihood. This pins the annotation's whole purpose — without it
    the serializer degrades to N+1 on every feed page.
    """

    def test_annotated_page_adds_no_follow_queries(self, user, creator, clip_of, django_assert_num_queries):
        """The annotation's purpose: `is_following` costs zero queries.

        `select_related('creator')` and the `user_has_liked` annotation are
        both included deliberately. They suppress *pre-existing* N+1s (the
        `creator_name` FK walk and `is_liked`'s per-clip lookup), and leaving
        them out would make this assertion measure those instead of B2's
        contribution — a queryset of 10 clips otherwise emits 20 queries for
        reasons that have nothing to do with follow state.
        """
        from django.db.models import Exists, OuterRef

        from backend.app.models import AudioClip, UserInteraction

        clip_of(10)
        annotated = list(
            AudioClip.objects
            .select_related('creator')
            .annotate(
                user_has_liked=Exists(
                    UserInteraction.objects.filter(
                        clip=OuterRef('pk'), user=user,
                        interaction_type='like', is_active=True,
                    )
                ),
                **following_annotation(user),
            )
        )

        with django_assert_num_queries(0):
            data = FeedClipSerializer(annotated, many=True,
                                      context={'request': _FakeRequest(user)}).data

        assert len(data) == 10
        assert all(item['is_following'] is False for item in data)

    def test_following_annotated_but_liked_not_still_adds_nothing(self, user, creator, clip_of, django_assert_num_queries):
        """Isolates B2 from the `is_liked` path: same page, `user_has_liked`
        deliberately omitted, so only the follow field could be costing
        queries. Expects exactly one query per clip, all of them is_liked."""
        from backend.app.models import AudioClip

        clip_of(4)
        annotated = list(
            AudioClip.objects.select_related('creator')
            .annotate(**following_annotation(user))
        )

        with django_assert_num_queries(4):
            data = FeedClipSerializer(annotated, many=True,
                                      context={'request': _FakeRequest(user)}).data

        assert len(data) == 4

    def test_fallback_path_queries_per_clip(self, user, creator, clip_of, django_assert_num_queries):
        """The un-annotated fallback does query per clip — deliberately, and
        only for single-object reads. Asserted so a refactor that widens a
        queryset's use of the fallback shows up as a test change.

        6 per clip: is_liked, is_following, and 4 more for `creator_name`
        (the FK walk), which the annotated case suppresses.
        """
        from backend.app.models import AudioClip

        clip_of(2)
        clips = list(AudioClip.objects.all())

        with django_assert_num_queries(6):
            data = FeedClipSerializer(clips, many=True,
                                      context={'request': _FakeRequest(user)}).data

        assert len(data) == 2


class TestProfileIsFollowing:
    def test_public_profile_reflects_follow_state(self, user, other_user):
        data = PublicProfileSerializer(
            other_user, context={'request': _FakeRequest(user)}
        ).data
        assert data['is_following'] is False

        user.following.add(other_user)
        data = PublicProfileSerializer(
            other_user, context={'request': _FakeRequest(user)}
        ).data
        assert data['is_following'] is True

    def test_public_profile_false_for_self(self, user):
        data = PublicProfileSerializer(user, context={'request': _FakeRequest(user)}).data
        assert data['is_following'] is False

    def test_public_profile_false_when_unauthenticated(self, other_user):
        from django.contrib.auth.models import AnonymousUser
        data = PublicProfileSerializer(
            other_user, context={'request': _FakeRequest(AnonymousUser())}
        ).data
        assert data['is_following'] is False

    def test_own_profile_always_false(self, user):
        """The field exists so the client reads one shape off both endpoints."""
        data = OwnProfileSerializer(user, context={'request': _FakeRequest(user)}).data
        assert 'is_following' in data
        assert data['is_following'] is False

    def test_public_profile_costs_one_query_not_n(self, user, other_user, django_assert_num_queries):
        with django_assert_num_queries(1):
            data = PublicProfileSerializer(
                other_user, context={'request': _FakeRequest(user)}
            ).data
        assert data['is_following'] is False


class TestOwnProfileLikedClipsRegression:
    """The 500 this commit's predecessor introduced, kept as a guard.

    `get_liked_clips` filtered on `interactions__*`, but `UserInteraction.clip`
    declares no `related_name`, so the reverse accessor is `userinteraction`
    and `interactions__*` raises FieldError. That made `GET /profile/me/`
    return 500 for *every* authenticated user — the primary profile endpoint
    was entirely dead, and no test covered it. The B2 work is what surfaced
    it, since B2 could not add a field to a serializer that 500s.
    """

    def test_profile_me_is_reachable(self, auth_client):
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200, dict(r.data)

    def test_liked_clips_is_a_list(self, auth_client, user, ready_clip):
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200, dict(r.data)
        assert r.data['liked_clips'] == []

    def test_liked_clips_returns_actually_liked_clips(self, auth_client, user, ready_clip):
        from backend.app.models import UserInteraction
        UserInteraction.objects.create(
            user=user, clip=ready_clip, interaction_type='like', is_active=True
        )
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200, dict(r.data)
        assert [c['id'] for c in r.data['liked_clips']] == [str(ready_clip.id)]

    def test_liked_clips_excludes_inactive_likes(self, auth_client, user, ready_clip):
        from backend.app.models import UserInteraction
        UserInteraction.objects.create(
            user=user, clip=ready_clip, interaction_type='like', is_active=False
        )
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200
        assert r.data['liked_clips'] == []

    def test_liked_clips_excludes_other_interaction_types(self, auth_client, user, ready_clip):
        from backend.app.models import UserInteraction
        UserInteraction.objects.create(
            user=user, clip=ready_clip, interaction_type='skip', is_active=True
        )
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200
        assert r.data['liked_clips'] == []

    def test_liked_clips_carry_is_following(self, auth_client, user, other_user, ready_clip):
        """B2's annotation has to reach the nested serializer too, which is
        why `get_liked_clips` annotates rather than relying on the fallback."""
        from backend.app.models import UserInteraction
        UserInteraction.objects.create(
            user=user, clip=ready_clip, interaction_type='like', is_active=True
        )
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200
        assert 'is_following' in r.data['liked_clips'][0]
        assert r.data['liked_clips'][0]['is_following'] is False


class TestProfileEndpointsExposeIsFollowing:
    """End-to-end: the field has to survive the actual view, not just the
    serializer in isolation."""

    def test_profile_me_reports_false(self, auth_client, user):
        r = auth_client.get('/profile/me/')
        assert r.status_code == 200, r.data
        assert r.data['is_following'] is False

    def test_profile_retrieve_reflects_follow_state(self, api_client, user, other_user):
        api_client.force_authenticate(user=user)
        r = api_client.get(f'/profile/{other_user.id}/')
        assert r.status_code == 200, r.data
        assert r.data['is_following'] is False

        user.following.add(other_user)
        r = api_client.get(f'/profile/{other_user.id}/')
        assert r.data['is_following'] is True

    def test_profile_clips_carry_is_following(self, api_client, user, other_user, clip_of):
        api_client.force_authenticate(user=user)
        clip_of(2, other_creator=other_user)
        r = api_client.get(f'/profile/{other_user.id}/clips/')
        assert r.status_code == 200, r.data
        assert len(r.data['results']) == 2
        assert all('is_following' in item for item in r.data['results'])
        assert all(item['is_following'] is False for item in r.data['results'])


class TestIsFollowingRoundTripsWithToggle:
    """The regression that motivated B2: read state, then toggle, and the
    result must match what the button claimed."""

    def test_follow_then_reread_then_toggle_does_not_unfollow_surprise(self, auth_client, other_user):
        # 1. read: not following
        before = auth_client.get(f'/profile/{other_user.id}/').data['is_following']
        assert before is False

        # 2. tap Follow
        r = auth_client.post(f'/follow/{other_user.id}/toggle-follow/')
        assert r.status_code == 201
        assert r.data['status'] == 'followed'

        # 3. re-read: the client now knows it is following
        after = auth_client.get(f'/profile/{other_user.id}/').data['is_following']
        assert after is True

        # 4. with honest state the client would show "Following"; tapping that
        #    is a *deliberate* unfollow, which is what the endpoint does.
        r = auth_client.post(f'/follow/{other_user.id}/toggle-follow/')
        assert r.data['status'] == 'unfollowed'

    def test_self_follow_still_rejected(self, auth_client, user):
        r = auth_client.post(f'/follow/{user.id}/toggle-follow/')
        assert r.status_code == 400
