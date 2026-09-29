import { apiFetch } from '../client';
import { feedClipSchema, parseFeedResponse, playbackTokenSchema, type FeedResponse, type PlaybackToken } from '../schema';

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
 * The backend's docstring for this viewset still says `/suggestions/explore/`;
 * that route does not exist. The registered route is the flat
 * `/suggestions/` (urls.py), which is what this calls.
 */
export async function getSuggestions(
  category?: string,
  cursor?: string | null,
): Promise<{ clips: unknown[]; next: string | null }> {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  const raw = await apiFetch(`/suggestions/${query ? `?${query}` : ''}`);
  const parsed = raw as { results?: unknown[]; next?: string | null };
  return {
    clips: Array.isArray(parsed.results) ? parsed.results : [],
    next: parsed.next ?? null,
  };
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
