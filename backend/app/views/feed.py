"""Feed, suggestion, and tag-init views.

DECISION: Split out of monolithic views.py in 2026-09. Each of these
touches the recommendation engine / Redis feed cache, so they share
a single module. ~270 lines.
"""
import logging
import numpy as np
from django.core.cache import cache
from django.db.models import Exists, OuterRef, Case, When, Count, Func, F, JSONField
from pgvector.django import CosineDistance
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response

from ..models import AudioClip, UserInteraction
from ..serializers import FeedClipSerializer, following_annotation
from ..services.interactions import invalidate_user_vectors_cache
from ..tasks import refill_user_feed, calculate_time_decayed_vectors
from ..services.task_publisher import publish
from ._pagination import FeedCursorPagination


# N11 fix: cache the user's blended vector in Redis. Without this,
# /suggestions/?category=X runs calculate_time_decayed_vectors inline
# on every request, hitting Postgres for the last 50 interactions and
# doing numpy math per request. With the cache, a single computation
# is reused across 15 min, invalidated when the user takes a new action.
# Trade-off: 15-min staleness on explore recommendations; FastFeed (the
# main feed) is unaffected (it reads pre-computed vectors from Redis
# via refill_user_feed, not via this helper).
_USER_VECTORS_TTL_SECONDS = 900  # 15 min
_USER_VECTORS_KEY = 'user_vectors:{user_id}'


def get_user_vectors(user):
    """Return (semantic_vec, acoustic_vec) for a user, with Redis cache.

    Returns (None, None) on cache miss + no interactions (cold start).
    Cache key: 'user_vectors:{user_id}'. TTL: 15 min.
    """
    cache_key = _USER_VECTORS_KEY.format(user_id=user.id)
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    sem, ac = calculate_time_decayed_vectors(user)
    if sem is not None and ac is not None:
        cache.set(cache_key, (sem, ac), timeout=_USER_VECTORS_TTL_SECONDS)
    return sem, ac


# invalidate_user_vectors_cache is imported from
# backend.app.services.interactions at the top of this file. The
# helper is a single source of truth there; the import in this module
# is for backwards-compat with anything that imports the name from
# views/feed (the audit doc references this path; the test
# test_adversarial_pass3.py:472 checks hasattr here).


class FastFeedViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticated]

    def list(self, request):
        user_id = request.user.id
        redis_key = f"user_feed:{user_id}"

        # DECISION: Wrap the entire Redis path in try/except. If Redis is
        # unreachable, return a trending-feed fallback (top clips by
        # engagement_velocity) instead of 500ing. The architecture audit
        # warns that a Redis outage during a 5k-user peak would otherwise
        # firehose the database with 5k concurrent refill_user_feed tasks
        # and crash PostgreSQL.
        try:
            redis_client = cache.client.get_client()
            clip_ids_bytes = redis_client.lpop(redis_key, 10)

            if not clip_ids_bytes:
                publish(refill_user_feed, user_id, count=40)
                # N6 fix: refill_user_feed.delay() is async. The second
                # lpop immediately after runs in the same request thread,
                # *before* the worker has executed the refill. On a cold
                # queue (new user, expired 24h TTL, broker hiccup) this
                # second lpop almost always returns None, so we used to
                # return "You've caught up!" — telling the user the feed
                # is empty when it's actually about to be populated. The
                # fix is to return 202 Accepted with a retry_after_ms
                # hint so the client can poll again in ~1.5s and find
                # the freshly-populated queue.
                clip_ids_bytes = redis_client.lpop(redis_key, 10)

                if not clip_ids_bytes:
                    return Response(
                        {
                            "results": [],
                            "message": "Preparing your feed...",
                            "retry_after_ms": 1500,
                            "degraded": True,
                        },
                        status=status.HTTP_202_ACCEPTED,
                    )

            clip_ids = [vid.decode('utf-8') for vid in clip_ids_bytes]
            queue_length = redis_client.llen(redis_key)

            preserved_order = Case(*[When(pk=pk, then=pos) for pos, pk in enumerate(clip_ids)])
            # SECURITY: `is_active=True` is load-bearing, not decoration.
            # `record_like_toggle` (services/interactions.py:144-149) does NOT
            # delete the row on un-like — it flips `is_active=False` in place.
            # A subquery without that clause therefore matches the very row
            # that records the un-like, and `/feed/` rendered a filled heart
            # for every clip the user had explicitly un-liked. The same user
            # got the correct answer from `/profile/{id}/clips/`
            # (profile.py:64, which had the clause), so the two screens
            # contradicted each other on the main screen of the app.
            #
            # `FeedClipSerializer.get_is_liked` returns the annotation
            # verbatim when it is present, so this subquery — not the
            # serializer's own correct fallback query — is what the user sees.
            user_like_subquery = UserInteraction.objects.filter(
                clip=OuterRef('pk'), user=request.user,
                interaction_type='like', is_active=True,
            )
            clips = (
                AudioClip.objects
                .filter(id__in=clip_ids, moderation_approved=True)
                # `status='ready'` — the primary path was the only clip-
                # listing query in the codebase without it (the degraded
                # fallback below, `/suggestions/`, `/profile/{id}/clips/`
                # and `send_share` all had it), so a clip id still in the
                # Redis queue was served while it was still encoding.
                #
                # Defence in depth, honestly labelled: no production path
                # moves a clip off 'ready' once it is ready
                # (`cleanup_stuck_processing` only goes processing->failed)
                # and moderation revocation is filtered separately. But a
                # clip with `status='ready'` and an empty
                # `hls_playlist_url` IS constructible
                # (test_content_moderation.py:204), and the feed is the
                # only place a caller learns a clip id is in the queue.
                #
                # NOT A SUBSTITUTE, EITHER WAY: `status='ready'` is not a
                # substitute for `moderation_approved=True`, and
                # `moderation_approved=True` is not a substitute for
                # `status='ready'` — `process_audio_to_hls` sets
                # status='ready' *after* the worker-side moderation check,
                # so a task retry can leave a clip ready while
                # moderation_approved reads False. The two flags are
                # independent; both are required. (views/profile.py:76-79
                # carries the same reasoning; read it before touching this.)
                #
                # The clause is ADDED to the existing chain, not swapped into
                # it: `moderation_approved=True` above and the NC/SA filter
                # below are unchanged.
                #
                # SECURITY: Exclude NC + SA items from user feeds. NC items
                # are filtered at runtime via SCRAPER_ALLOW_NC; SA items are
                # operator-gated via /clips/{id}/approve-moderation/.
                .filter(status='ready')
                .filter(is_noncommercial=False, requires_share_alike=False)
                .annotate(user_has_liked=Exists(user_like_subquery))
                # B2: one annotation for the whole page instead of one
                # follow lookup per clip. See following_annotation().
                .annotate(**following_annotation(request.user))
                .order_by(preserved_order)
            )
            serializer = FeedClipSerializer(clips, many=True, context={'request': request})
            return Response({
                "next": "auto_trigger",
                "queue_health": queue_length,
                "results": serializer.data,
            })
        except Exception as e:
            logging.getLogger(__name__).warning(
                "feed service degraded for user %s; serving trending fallback: %s",
                user_id, e,
            )
            fallback = (
                AudioClip.objects
                .filter(status='ready', moderation_approved=True)
                # SECURITY: Same NC + SA exclusion as primary feed path.
                .filter(is_noncommercial=False, requires_share_alike=False)
                .annotate(user_has_liked=Exists(
                    # Same `is_active=True` requirement as the primary path
                    # above — see the reasoning there. Copying the omission
                    # into the fallback is how the two halves of one screen
                    # came to disagree.
                    UserInteraction.objects.filter(
                        clip=OuterRef('pk'), user=request.user,
                        interaction_type='like', is_active=True,
                    )
                ))
                # B2, same annotation as the primary path.
                .annotate(**following_annotation(request.user))
                .order_by('-engagement_velocity', '-created_at')[:20]
            )
            serializer = FeedClipSerializer(fallback, many=True, context={'request': request})
            return Response({
                "next": "auto_trigger",
                "queue_health": 0,
                "degraded": True,
                "results": serializer.data,
            })


class SuggestionViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Category-specific recommendations using user's blended preference vectors.

    ENDPOINT: GET /suggestions/explore/?category=comedy
    """
    serializer_class = FeedClipSerializer
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = FeedCursorPagination

    def get_queryset(self):
        user = self.request.user
        # `category` is a free-text CharField (models.py:112), NOT a
        # choices/enum field. `filter(category='all')` is therefore an exact
        # string match against the literal string "all", which matches zero
        # rows — so `?category=all` AND a bare `/suggestions/` (same default)
        # both returned 200 with an EMPTY list, never a 400. The client could
        # not tell "no such category" from "nothing to show", and the mobile
        # cold-start fallback silently served nothing.
        #
        # `all` is the documented sentinel for "do not filter" (the plan and
        # the mobile task list both call `/suggestions/?category=all` for the
        # cold-start fallback), so it must be handled as a no-op rather than
        # passed to the ORM.
        category = (self.request.query_params.get('category') or 'all').strip()
        unfiltered = category.lower() in ('', 'all')

        queryset = AudioClip.objects.filter(
            status='ready', moderation_approved=True,
            # SECURITY: Same NC + SA exclusion as feed endpoints.
            is_noncommercial=False, requires_share_alike=False,
        )
        if not unfiltered:
            queryset = queryset.filter(category=category)

        # DECISION: Wrap the vector search in try/except. The architecture
        # audit warns that a Postgres/Redis hiccup in
        # calculate_time_decayed_vectors would 500 the whole explore page.
        # With this fallback: rank by combined distance, or on failure
        # rank by engagement_velocity (trending within category), or as
        # a last resort serve the category unranked.
        # N11: get_user_vectors() now caches in Redis for 15 min, so
        # /suggestions/ doesn't recompute on every request.
        # SEC: sanitize the category to keep Prometheus label cardinality bounded.
        # Free-form category strings would explode the metric; we cap at 32 chars
        # and replace anything that isn't a-z/0-9/_/- with '_'.
        import re
        safe_category = re.sub(r'[^a-z0-9_\-]', '_', (category or 'all')[:32]) or 'all'

        from .. import metrics
        with metrics.time_suggestion_ranking(category=safe_category) as timer:
            try:
                sem_query, ac_query = get_user_vectors(user)
                if sem_query and ac_query:
                    queryset = queryset.annotate(
                        combined_distance=(
                            CosineDistance('semantic_vector', sem_query) +
                            CosineDistance('acoustic_vector', ac_query)
                        )
                    ).order_by('combined_distance')
            except Exception as e:
                logging.getLogger(__name__).warning(
                    "vector ranking failed for user %s; falling back to engagement_velocity: %s",
                    user.id, e,
                )
                timer.set_outcome('fallback')
                queryset = queryset.order_by('-engagement_velocity', '-created_at')

        # `is_active=True` is required for the same reason as in
        # FastFeedViewSet: un-like flips the flag rather than deleting the
        # row, so without the clause every un-liked clip reads as liked on
        # the Explore page too.
        user_like_subquery = UserInteraction.objects.filter(
            clip=OuterRef('pk'), user=user,
            interaction_type='like', is_active=True,
        )
        return queryset.annotate(
            user_has_liked=Exists(user_like_subquery),
            # B2: the Explore page renders FeedClipSerializer too, so it needs
            # the same per-page follow annotation.
            **following_annotation(user),
        )


# SECURITY (R5-04): bounds on POST /tags/initialize/'s `selected_tags`.
#
# _MAX_SELECTED_TAGS: each tag becomes one OR'd `tags @> '["tag"]'` JSONB
# containment clause, and `app_audioclip` has NO GIN index on `tags` (only
# btrees on status/category/creator plus the two HNSW vector indexes), so
# every clause is a sequential-scan containment check per row — cost grows
# with clauses x rows. Measured on this repo's local stack: 1 000 tags build
# a 48 KB query, 50 000 tags build 2.4 MB and cost 5.5 s of Django Q-tree
# construction in the request thread *before* Postgres is reached, plus 2.1 s
# of query. Note the Python half is NOT bounded by statement_timeout=30s
# (settings.py:225) — only the SQL half is.
# 20 is ~1.6x what the product actually sends: `available_tags` caps its
# offer at _MAX_OFFERED_TAGS (12) and the picker can select at most that
# many, leaving headroom while keeping the worst case trivial. This bound
# is deliberately independent of that cap — it is the *server's* ceiling on
# work per request, and must stay enforced even if a client ignores it.
_MAX_SELECTED_TAGS = 20
#
# _MAX_TAG_LENGTH: `AudioClip.tags` is written from KeyBERT with
# keyphrase_ngram_range=(1, 1) and top_n=3 (backend/app/tasks.py:284-292),
# i.e. single words, plus the literal "instrumental" for instrumental-only
# tracks (backend/app/tasks.py:364 — the old citation said 296, which is
# wrong). A single KeyBERT unigram is far below 64 chars, so 64 is already
# generous while keeping each clause small. Note the offered tags are no
# longer a hardcoded UI list: they come from the catalogue, so this has to
# hold for any tag the corpus happens to contain.
_MAX_TAG_LENGTH = 64


# ---------------------------------------------------------------------------
# Bounds for GET /tags/available/ (see TagsViewSet.available_tags).
#
# _MIN_CLIPS_PER_OFFERED_TAG: a tag that appears on exactly one clip is a row,
# not a preference. Offering it means the user can pick it, watch one clip,
# and have a baseline computed from a single vector — while the UI implies the
# tag characterises a group. 2 is the smallest threshold that says "more than
# an accident"; it is a HAVING clause on the aggregate, not a post-filter, so
# it cannot be inflated by tags that failed the other checks below.
_MIN_CLIPS_PER_OFFERED_TAG = 2
#
# _MAX_OFFERED_TAGS: the picker is a modal, not a taxonomy browser. A corpus
# with a very wide vocabulary must not turn "open onboarding" into a response
# of thousands of rows. 12 is ~1.5x what the current modal offers, so the UI
# can grow without a second round trip.
_MAX_OFFERED_TAGS = 12


def _baseline_population():
    """The clips `initialize_vectors` can actually build a baseline from.

    This is `initialize_vectors`' own three non-tag conditions, verbatim, MINUS
    the `tags @> ...` containment. That is the whole design: the endpoint
    advertises a tag only when that tag matches at least one clip *in exactly
    the population the matcher will query*, so the offer cannot drift from the
    match. If you add `status='ready'` or an NC/SA exclusion here and not in
    the matcher, the two disagree again and the invariant this endpoint exists
    to guarantee is gone.

    WHY DUPLICATED RATHER THAN SHARED. The obvious refactor is one helper both
    actions call. It was not done because `initialize_vectors` is contract-pinned
    by `test_tags_initialize_bounds.py` (it asserts on the exact SQL that
    reaches Postgres — the number of `@>` clauses for a given input), so
    touching its body is a larger blast radius than this endpoint warrants.
    The duplication is three clauses and is flagged here and in the test file;
    it is the smaller risk of the two, and the invariant test fails loudly the
    moment the two copies diverge.

    NOT IN THIS POPULATION, DELIBERATELY: `status='ready'` and the NC/SA
    exclusion. `initialize_vectors` filters on neither, so a tag whose only
    eligible clips are NC or not-yet-ready WOULD be offered here and WOULD build
    a baseline. That looseness is the matcher's, it predates this endpoint, and
    it is tracked separately (it is also why `A3`'s rights gate does not cover
    this action). Tightening it in one of the two places — rather than both —
    is precisely the drift this helper's docstring is warning about.
    """
    return AudioClip.objects.filter(
        semantic_vector__isnull=False,
        acoustic_vector__isnull=False,
        moderation_approved=True,
    )


class TagsViewSet(viewsets.ViewSet):
    """
    Cold-start onboarding: Initialize user preferences from tag selection.

    ENDPOINT: POST /tags/initialize/
    ENDPOINT: GET  /tags/available/
    """
    permission_classes = [permissions.IsAuthenticated]

    @property
    def throttle_scope(self):
        """Route each action to the rate it deserves.

        SECURITY: this viewset previously declared no `throttle_scope` at all,
        and `ScopedRateThrottle.allow_request` returns True — no accounting,
        no counter — when the view it is asked about has no scope. Both actions
        therefore ran on nothing but the shared `user` (1000/hour) bucket.
        `initialize_vectors` is not a cheap action to leave unbounded: it runs
        one JSONB containment clause per selected tag (up to
        `_MAX_SELECTED_TAGS` = 20) over `app_audioclip`, and publishes a
        `refill_user_feed` task on every success.

        Keys are **method names**, because DRF's `self.action` is the method
        name (`ViewSetMixin.initialize_request`) and `url_path` is only where
        the handler is mounted. Keying on `url_path` is what silently killed
        all five A4 clip scopes and then all seven ContentViewSet scopes in this
        codebase — twice, in this same file family — and a wrong key does not
        raise, it just leaves the endpoint unthrottled.

        The fallback is the WRITE scope, not the read one. An action added here
        without a mapping is, by default, something that writes and publishes;
        if it turns out to be a read, a too-tight rate is a visible 429 and one
        line of fix, whereas the reverse is invisible.

        The inherited throttle classes are kept (no `get_throttles` override,
        unlike `AudioUploadViewSet.SCOPED_ONLY_ACTIONS`) so the 1000/hour
        `user` bucket stays as a backstop beneath the scope. Note the two
        failure directions are different, and neither is graceful: if this
        property ever returned None the action would be accounted only by that
        generic bucket, whereas a scope *name* with no entry in
        `DEFAULT_THROTTLE_RATES` raises `ImproperlyConfigured` and 500s on
        every request. So the mapping above and the two rate keys in settings
        have to move together; `test_tags_available_endpoint.py` asserts both.
        """
        return {
            'available_tags': 'tags_available',
            'initialize_vectors': 'tags_initialize',
        }.get(self.action, 'tags_initialize')

    @action(detail=False, methods=['get'], url_path='available')
    def available_tags(self, request):
        """The tags this catalogue actually has, with the clip count of each.

        WHY THIS EXISTS. The onboarding modal used to offer eight hardcoded ids
        (comedy, science, motivation, music, quotes, instrumental, tech,
        mindset) and preselect two. Those are `AudioClip.category` values being
        passed as `tags`; `initialize_vectors` matches with exact JSONB
        containment, `tags @> '["comedy"]'::jsonb`, which no clip in the corpus
        satisfies. So not one of the eight could ever match, every cold start
        returned 400 "Not enough data to build baseline.", and
        `select count(*) from app_user where long_term_semantic is not null`
        was 0 — the feature had never once succeeded. This endpoint is what
        makes it possible to succeed: the client renders whatever is really
        there instead of a list of guesses.

        WHAT THE VOCABULARY IS — read this before "improving" the endpoint.
        `AudioClip.tags` is written by `process_audio_to_hls` from the Whisper
        transcript using KeyBERT **unigrams** — `tags = [kw[0] for kw in
        keywords]`, `keyphrase_ngram_range=(1, 1)`, `top_n=3`
        (backend/app/tasks.py:360) — plus the literal "instrumental" for
        instrumental-only tracks (tasks.py:364). A tag is therefore a *word
        lifted out of a lyric*, not a curated genre label: on this repo's local
        catalogue (13 clips, 12 of them eligible) there are 34 distinct tags, of
        which exactly two ("feel", "listen") appear on more than one clip. It is
        expected — not a bug to be smoothed over — that this list is short and
        slightly odd.

        SO: do not hardcode moods here, and do not union this with a curated
        list. The instant the response stops being derived from the corpus, the
        vocabulary drifts from the data again and we are back to offering tags
        that return 400. If the catalogue's tagging needs improving, improve
        `tasks.py`; this endpoint is only the honest view of whatever it
        produces.

        Empty catalogue is a VALID answer, not an error: the response is
        `{"tags": []}` with a 200, and the client renders an honest "not enough
        audio to personalise yet" state from it. It is deliberately not a 404
        (nothing is missing), not a 400 (the request was fine) and not a single
        consolation tag (offering one clip's tag is what `_MIN_CLIPS_PER_
        OFFERED_TAG` exists to prevent).
        """
        # `jsonb_array_elements` rather than the `_text` variant: the grouping
        # key is then the jsonb element itself, and jsonb equality is exactly
        # what the `@>` containment the matcher uses tests. With `_text` a
        # numeric element `5` would be counted and offered as the string "5",
        # which the matcher can never match — `'["5"]'::jsonb @> '[5]'::jsonb`
        # is false. Non-string elements are dropped below instead. (`tags` is
        # not writable through `AudioUploadSerializer`, so no API writer can
        # produce one today; the check is here because "not constructible
        # today" is not a property of the data, it is a property of today's
        # writers.)
        element = Func(
            F('tags'),
            function='jsonb_array_elements',
            output_field=JSONField(),
        )
        # No SQL LIMIT. The checks below (`isinstance`, emptiness, padding,
        # length) are Python-side because a set-returning function cannot appear
        # in WHERE — Django's `filter()` on the annotated alias emits
        # `... AND jsonb_array_elements(tags) IS NOT NULL` and Postgres rejects
        # that with "set-returning functions are not allowed in WHERE" — so a
        # LIMIT here would be applied *before* the rejections and could hide a
        # real tag behind junk. The fetch is a grouped aggregate: its size is
        # the number of distinct tags, not the number of clips.
        #
        # `Count('pk', distinct=True)`, NOT `Count('*')`: unnesting expands one
        # row into one row per element, so a clip whose array carries the same
        # tag twice (`["live", "live"]`) would be counted twice. The matcher
        # matches *clips*, and `tags @> '["live"]'` is true once for that row
        # however many copies of the element it holds, so a plain count would
        # advertise a number the matcher cannot reproduce — the exact
        # disagreement this endpoint exists to rule out.
        rows = (
            _baseline_population()
            .annotate(tag=element)
            .values('tag')
            .annotate(clips=Count('pk', distinct=True))
            .filter(clips__gte=_MIN_CLIPS_PER_OFFERED_TAG)
            .order_by('-clips', 'tag')
        )

        offered = []
        for row in rows:
            tag = row['tag']
            if not isinstance(tag, str):
                continue
            # Empty string: `initialize_vectors` strips then refuses an empty
            # tag with a 400, so offering one would advertise a choice that
            # cannot be made.
            if not tag:
                continue
            # Whitespace-padded (`" jz"`): *unmatchable*, and subtly so. The
            # matcher strips the caller's tag before building its containment
            # clause, so no client input can ever match a padded stored element
            # — sending " jz" is stripped to "jz", and "jz" does not
            # containment-match `" jz"`. Offering the stripped form instead
            # would advertise a count including rows the matcher will never
            # see, i.e. exactly the lie this endpoint exists to stop telling.
            if tag != tag.strip():
                continue
            # Over-length: `initialize_vectors` 400s on a tag longer than
            # `_MAX_TAG_LENGTH`, so a tag it cannot accept must not be offered.
            if len(tag) > _MAX_TAG_LENGTH:
                continue
            offered.append({'tag': tag, 'clips': row['clips']})
            if len(offered) >= _MAX_OFFERED_TAGS:
                break

        return Response({'tags': offered})

    @action(detail=False, methods=['post'], url_path='initialize')
    def initialize_vectors(self, request):
        user = request.user
        selected_tags = request.data.get('selected_tags')

        # SECURITY (R5-04): `selected_tags` used to be read straight off the
        # body with no type or bound. All rejections below are 400s in the
        # `{"error": ...}` shape this action already used for "Not enough
        # data to build baseline." — DRF's own `{"detail": ...}` / a
        # serializer's `{"selected_tags": {...}}` would be a third shape in a
        # file the project already splits between two.
        #
        # Validated inline rather than via a serializer: feed.py has no
        # body-validating action to copy, and its only comparable input path
        # (SuggestionViewSet's `category`) normalises inline too.
        if not isinstance(selected_tags, list):
            return Response(
                {"error": "selected_tags is required and must be a list of strings."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not selected_tags:
            return Response(
                {"error": "selected_tags must contain at least one tag."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(selected_tags) > _MAX_SELECTED_TAGS:
            return Response(
                {"error": f"selected_tags accepts at most {_MAX_SELECTED_TAGS} tags "
                          f"(got {len(selected_tags)})."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        cleaned = []
        for index, tag in enumerate(selected_tags):
            if not isinstance(tag, str):
                return Response(
                    {"error": f"selected_tags[{index}] must be a string, "
                              f"not {type(tag).__name__}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # NUL survives JSON parsing and then kills the jsonb literal
            # server-side: psycopg raises "unsupported Unicode escape
            # sequence". Same rule CommentSerializer.validate_text applies.
            if '\x00' in tag:
                return Response(
                    {"error": f"selected_tags[{index}] must not contain null bytes."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            tag = tag.strip()
            # Stripped to empty it can never match, so a clause for it is pure
            # waste — and the caller deserves to be told rather than to be
            # handed a misleading "Not enough data to build baseline."
            if not tag:
                return Response(
                    {"error": f"selected_tags[{index}] must not be empty or whitespace only."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if len(tag) > _MAX_TAG_LENGTH:
                return Response(
                    {"error": f"selected_tags[{index}] is {len(tag)} characters; "
                              f"the maximum is {_MAX_TAG_LENGTH}."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cleaned.append(tag)

        # Normalise duplicates instead of rejecting them: `Q(a) | Q(a)` is
        # the same predicate as `Q(a)`, so this is lossless *and* it further
        # shrinks the clause count the bounds above exist to cap. Rejecting
        # would turn a benign client bug (double-tap, retried request, a
        # state array that already held the tag) into a failed cold-start,
        # and this one-shot onboarding path is where that costs the most.
        selected_tags = list(dict.fromkeys(cleaned))

        # N bug fix: tags is a JSONField(default=list) (see models.py:69),
        # NOT a Postgres ArrayField. The old code used Django's ArrayField
        # 'overlap' lookup on a JSONField, which Django silently
        # reinterpreted as a JSON path: `JSON_EXTRACT(tags, '$.overlap')`.
        # That returned 0 rows for every call (no JSON document has a key
        # literally named 'overlap'), so the entire tag-based cold-start
        # UX was silently non-functional.
        #
        # Postgres JSONB has no native "any-of" operator. The right
        # primitive is `@>` (contains): tags @> '["tag"]'::jsonb is true
        # when the array contains "tag". We OR one Q per selected tag.
        # selected_tags is guaranteed non-empty by the validation above, so
        # there is no empty-selection case to short-circuit.
        from django.db.models import Q
        tag_filter = Q()
        for tag in selected_tags:
            tag_filter |= Q(tags__contains=[tag])
        baseline_clips = AudioClip.objects.filter(
            tag_filter,
            semantic_vector__isnull=False,
            acoustic_vector__isnull=False,
            moderation_approved=True,
        ).order_by('-likes')[:100]

        if not baseline_clips:
            return Response({"error": "Not enough data to build baseline."}, status=400)

        sem_vectors = [np.array(clip.semantic_vector) for clip in baseline_clips]
        ac_vectors = [np.array(clip.acoustic_vector) for clip in baseline_clips]

        user.long_term_semantic = (np.mean(sem_vectors, axis=0)).tolist()
        user.long_term_acoustic = (np.mean(ac_vectors, axis=0)).tolist()
        user.save()

        publish(refill_user_feed, user.id, count=30)

        return Response({"status": "Algorithm initialized. Feed is ready."}, status=200)
