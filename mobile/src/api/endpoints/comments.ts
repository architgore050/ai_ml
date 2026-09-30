import { apiFetch } from '../client';
import { commentSchema, cursorSchema, type Comment } from '../schema';
import { cursorFromNextUrl } from './feed';

function assertCommentText(text: string): void {
  if (!text.trim()) throw new Error('A comment cannot be empty.');
  if (text.length > 500) throw new Error('A comment cannot be longer than 500 characters.');
}

/** Cursor page for one clip's top-level comments. Never request a bare list. */
export async function getComments(
  clipId: string,
  cursor?: string | null,
): Promise<{ comments: Comment[]; next: string | null }> {
  const params = new URLSearchParams({ clip: clipId });
  if (cursor) params.set('cursor', cursor);
  const raw = await apiFetch(`/comments/?${params.toString()}`);
  const page = cursorSchema(commentSchema).parse(raw);
  return { comments: page.results, next: cursorFromNextUrl(page.next) };
}

/** POST uses a clip UUID from the reel, never a creator User id. */
/**
 * Create a top-level comment or reply. `parent` is accepted only when the
 * caller already holds a comment from this clip; the API repeats that
 * invariant and rejects a cross-clip parent as a 400.
 */
export async function createComment(
  clipId: string,
  text: string,
  parent?: Comment | null,
): Promise<Comment> {
  assertCommentText(text);
  if (parent && parent.clip !== clipId) {
    throw new Error('A reply parent must belong to the selected clip.');
  }
  const body = parent
    ? { clip: clipId, text: text.trim(), parent: parent.id }
    : { clip: clipId, text: text.trim() };
  const raw = await apiFetch('/comments/', { method: 'POST', body });
  return commentSchema.parse(raw);
}

export async function updateComment(commentId: string, text: string): Promise<Comment> {
  assertCommentText(text);
  const raw = await apiFetch(`/comments/${commentId}/`, { method: 'PATCH', body: { text: text.trim() } });
  return commentSchema.parse(raw);
}

/** A 204 returns no body. Authorship is enforced by the server as a 404. */
export async function deleteComment(commentId: string): Promise<void> {
  await apiFetch(`/comments/${commentId}/`, { method: 'DELETE' });
}
