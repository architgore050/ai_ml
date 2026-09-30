import { z } from 'zod';

import { apiFetch } from '../client';
import {
  feedClipSchema,
  publicProfileSchema,
  type FeedClip,
  type PublicProfile,
} from '../schema';
import { cursorFromNextUrl } from './feed';

/** Profile clips use the documented cursor envelope, not PageNumberPagination.
 * Keep this endpoint strict because accepting `count` would silently mask a
 * route/pagination regression and give the paging UI a different contract. */
const publicProfileClipsPageSchema = z
  .object({
    next: z.string().nullable(),
    previous: z.string().nullable(),
    results: z.array(feedClipSchema),
  })
  .strict();

/**
 * Public-profile endpoints.
 *
 * `id` is the integer User primary key, never the UUID of an AudioClip. Django
 * resolves an invalid path value before the view can return a useful 404, so
 * reject anything other than a positive safe integer at this boundary.
 */
function assertUserId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('profile id must be a positive integer User id.');
  }
}

/** `GET /profile/{id}/` — public account fields and server follow state. */
export async function getPublicProfile(id: number): Promise<PublicProfile> {
  assertUserId(id);
  const raw = await apiFetch(`/profile/${id}/`);
  return publicProfileSchema.parse(raw);
}

/**
 * `GET /profile/{id}/clips/` — non-destructive cursor page of public clips.
 *
 * DRF sends an absolute URL in `next`; callers retain only its opaque cursor,
 * avoiding an invalid `?cursor=https://...` request on the next page.
 */
export async function getPublicProfileClips(
  id: number,
  cursor?: string | null,
): Promise<{ clips: FeedClip[]; next: string | null }> {
  assertUserId(id);
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : '';
  const raw = await apiFetch(`/profile/${id}/clips/${query}`);
  const page = publicProfileClipsPageSchema.parse(raw);
  return { clips: page.results, next: cursorFromNextUrl(page.next) };
}
