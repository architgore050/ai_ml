import { z } from 'zod';

import { apiFetch } from '../client';
import {
  feedClipSchema,
  parseFeedResponse,
  playbackTokenSchema,
  type FeedClip,
  type FeedResponse,
  type PlaybackToken,
} from '../schema';

/**
 * Feed + playback-token endpoints. Thin and typed, mirroring
 * `endpoints/auth.ts`: no state, no caching decisions, no retry policy. The
 * logic that *consumes* these (destructive-page handling, token lifecycle) lives
 * in `hooks/useFeedBuffer.ts` and `hooks/usePlaybackToken.ts`.
 *
 * Routes, from backend/app/urls.py:
 *   GET  /feed/                            FastFeedViewSet        (auth)
 *   GET  /suggestions/?category=<X>        SuggestionViewSet      (auth, cursor page)
 *   POST /media/playback-token/<uuid>/     PlaybackTokenView      (auth, 300/min)
 */

/** Header that opts in to receiving the token value in the response body. */
export const NATIVE_CLIENT_HEADER = 'X-EchoFlow-Client';
export const NATIVE_CLIENT_VALUE = 'native';

/**
 * One page of `GET /feed/`.
 *
 * ⚠️ THIS CALL IS DESTRUCTIVE. `FastFeedViewSet.list` does
 * `redis_client.lpop(redis_key, 10)` (views/feed.py:75) — it *consumes* up to
 * 10 ids off the user's queue. Re-requesting a page you already got does not
 * return it again; it returns the NEXT ten (or a 202 once the queue drains).
 *
 * Consequence for callers: never treat this as a refetchable query. Do not put
 * it behind a "retry on error" that re-issues the same call, do not let
 * TanStack Query refetch it (it will, on window focus and on mount), and do
 * not call it twice for one screenful. `useFeedBuffer` accumulates and dedupes
 * so the buffer grows monotonically instead.
 *
 * 200 → `{results, next:'auto_trigger', queue_health, degraded?}`
 * 202 → `{retry_after_ms}` (cold queue; no results)
 */
export async function getFeedPage(): Promise<FeedResponse> {
  const raw = await apiFetch('/feed/');
  return parseFeedResponse(raw);
}

/**
 * Explore / cold-start fallback: a paged, NON-destructive listing.
 *
 * `category` is matched on **exact string equality** by the backend, so a
 * near-miss ("Lo-Fi" vs "Lo-Fi Beats") is a silently EMPTY result set rather
 * than an error. Use the values from `src/design/categories.ts` verbatim.
 *
 * `all` is the one exception and is now honoured as "unfiltered" server-side
 * (`SuggestionViewSet.get_queryset`). It used to be matched literally against
 * a free-text column, so it matched nothing — which is why this caller
 * previously hardcoded `music` as a workaround and a cold start could only
 * ever show one category.
 *
 * The backend's docstring for this viewset still says `/suggestions/explore/`;
 * that route does not exist. The registered route is the flat
 * `/suggestions/` (urls.py), which is what this calls.
 *
 * Results are **validated**, not cast. The old signature returned
 * `clips: unknown[]` and the caller did `rows as FeedClip[]`, so a drifted
 * serializer surfaced as an undefined-property crash inside `ReelCard` — and
 * a row with no `id` became an `undefined` `keyExtractor`, which corrupts
 * VirtualizedList cell reuse rather than failing loudly.
 */
export async function getSuggestions(
  category?: string,
  cursor?: string | null,
): Promise<{ clips: FeedClip[]; next: string | null }> {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  const raw = await apiFetch(`/suggestions/${query ? `?${query}` : ''}`);
  const parsed = z
    .object({
      results: z.array(feedClipSchema).default([]),
      // DRF's CursorPagination returns an ABSOLUTE url here, not an opaque
      // cursor. Handing the whole url back as `?cursor=` makes
      // `decode_cursor` base64-decode the url characters into garbage and
      // raise InvalidCursor (400), so extract the query parameter.
      next: z.string().nullable().default(null),
    })
    .parse(raw);
  return { clips: parsed.results, next: cursorFromNextUrl(parsed.next) };
}

/**
 * Pull the opaque `cursor` out of DRF's absolute `next` url.
 *
 * Returns `null` for anything that is not a parseable url with a cursor, so a
 * pagination bug degrades to "one page" instead of a 400 on the next call.
 */
export function cursorFromNextUrl(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    return new URL(next).searchParams.get('cursor');
  } catch {
    // A bare cursor rather than a full url is also accepted, so the helper is
    // not the thing that breaks if DRF ever changes its shape.
    return next.includes('cursor=') ? (next.split('cursor=')[1] ?? null) : null;
  }
}

/** Re-validate a single clip's feed shape (used after a 409 clears to ready). */
export function parseFeedClip(raw: unknown) {
  return feedClipSchema.parse(raw);
}

/**
 * Mint a short-lived HLS playback token.
 *
 * POST, not GET: a GET is CSRF-able, prefetchable and cacheable, and this
 * response sets a credential cookie. The server answers GET with 405 and a
 * message saying so.
 *
 * `X-EchoFlow-Client: native` is REQUIRED on this platform. Without it the body
 * is `{"status":"ok"}` and the credential arrives only as an HttpOnly,
 * Secure cookie — which AVPlayer (no `NSHTTPCookieStorage` sharing) and
 * ExoPlayer's default data source (sends no `Cookie` header) cannot present.
 * The body token is what the player then attaches as
 * `X-EchoFlow-Media-Token` on the manifest and every segment.
 *
 * Throws `ApiError` with the status the UI must branch on:
 *   409 media not ready yet      → poll, do not treat as fatal
 *   403 unavailable/removed      → tombstone (do NOT distinguish the two 403
 *                                  messages; that leaks moderation state)
 *   404 gone
 */
export async function mintPlaybackToken(clipId: string): Promise<PlaybackToken> {
  const raw = await apiFetch(`/media/playback-token/${clipId}/`, {
    method: 'POST',
    headers: { [NATIVE_CLIENT_HEADER]: NATIVE_CLIENT_VALUE },
  });
  return playbackTokenSchema.parse(raw);
}
