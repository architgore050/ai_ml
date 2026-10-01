import React, { useEffect, useRef, useState } from "react";
import { X, Send, MessageSquare, AlertCircle } from "lucide-react";
import { commentsAPI } from "../../api/client";
import { Comment, FeedClip } from "../../types/echoflow";
import { useAuth } from "../../stores/auth";

interface CommentSheetProps {
  clip: FeedClip | null;
  isOpen: boolean;
  onClose: () => void;
}

const DIALOG_TITLE_ID = "comment-sheet-title";
const COMPOSER_INPUT_ID = "comment-composer-input";
const COMPOSER_ERROR_ID = "comment-composer-error";
const DELETE_ERROR_ID = "comment-delete-error";
const THREAD_LIST_NAME = "Comments on this reel";

/**
 * `CommentSerializer.Meta.fields` includes `author_id` (`serializers.py:521`)
 * but the shared `Comment` type does not declare it, so the ownership check
 * fell back to the username and a user who renamed lost Delete on their own
 * comments. Declared here — as an optional member, normalised on the way in —
 * rather than widened at the point of use, so a payload without it degrades to
 * "not the author" (no destructive affordance) instead of to a guess.
 */
type CommentNode = Comment & { author_id: number | null };

/** Replies fetched on demand for one parent, via `?parent=<id>`. */
interface ReplyBundle {
  comments: CommentNode[];
  isLoading: boolean;
  error: string | null;
}

interface ThreadNode {
  comment: CommentNode;
  children: ThreadNode[];
  /**
   * `parent` names a comment that is not in the loaded page. With the backend's
   * `-created_at` ordering a reply is newer than its parent, so the reply is on
   * the page and the parent is the row that falls off the page edge. The reply
   * is still shown, and still shown as a reply.
   */
  isDetachedReply: boolean;
}

/**
 * `parent` is a client-writable field, so a cycle is constructible (PATCH a
 * comment's `parent` to point back up its own chain). Bounding the walk keeps
 * a malformed thread from becoming an unbounded render.
 */
const MAX_THREAD_DEPTH = 8;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function toCommentNode(raw: Comment): CommentNode {
  const candidate = (raw as { author_id?: unknown }).author_id;
  return { ...raw, author_id: typeof candidate === "number" ? candidate : null };
}

/** The HTTP status on an `apiRequest` rejection, or `undefined` if there was no response. */
function httpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * A message the server actually meant for a human.
 *
 * `apiRequest` falls back to the literal "Request failed", and for a 5xx with
 * `DEBUG=False` it puts the entire HTML error page in `message`. Neither is a
 * diagnosis, so neither may be shown as one.
 */
function serverMessage(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed === "Request failed" || trimmed.startsWith("<")) return null;
  return trimmed;
}

function loadFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === undefined) return "Could not reach the server. Check your connection, then try again.";
  if (status === 429) return "Too many requests. Wait a moment, then try again.";
  return "The server returned an error. Try again in a moment.";
}

function postFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === undefined) return "Your comment was not sent. Check your connection, then try again.";
  if (status === 429) return "Too many comments. Wait a moment, then try again.";
  if (status === 400 || status === 403) {
    return serverMessage(err) ?? "The server rejected that comment.";
  }
  return "Your comment was not sent. Try again in a moment.";
}

function deleteFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === undefined) return "Could not delete that comment. Check your connection, then try again.";
  if (status === 429) return "Too many requests. Wait a moment, then delete again.";
  if (status === 404) return "Could not delete that comment — the server no longer has it.";
  return "Could not delete that comment. Try again in a moment.";
}

function repliesFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === undefined) return "Could not reach the server to load those replies.";
  return "Could not load those replies. Try again in a moment.";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A comment's age, or `null` when the payload carries no usable timestamp.
 *
 * `toLocaleTimeString` alone rendered a three-week-old comment as "14:32" —
 * a time of day attached to a moment three weeks in the past. Past a week a
 * relative phrase stops being useful, so this becomes a date. A missing or
 * unparseable value yields `null` and the caller renders nothing: never a
 * `Date.now()` substitute, which is the `date_joined || Date.now()` fabrication
 * (RECON-03 finding #8) reproduced in a new place.
 */
function formatCommentTime(iso: string, now: number): string | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const parsed = new Date(iso);
  const at = parsed.getTime();
  if (Number.isNaN(at)) return null;

  const age = now - at;
  // Clock skew, or a `created_at` from a server ahead of this one. Show the
  // value the server sent rather than a negative "ago".
  if (age < 0) return parsed.toLocaleString();
  if (age < MINUTE_MS) return "just now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
  if (age < 7 * DAY_MS) return `${Math.floor(age / DAY_MS)}d ago`;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function dedupeById(rows: CommentNode[]): CommentNode[] {
  const seen = new Set<string>();
  const out: CommentNode[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Group a loaded page into roots and the replies that belong to them.
 *
 * The payload carries `parent` on every comment, so the tree is read, not
 * invented. A reply whose parent is on the page is nested under it and dropped
 * from the top level; a reply whose parent is *not* on the page stays visible
 * at the top level, marked as a reply, because hiding it would lose a comment
 * and promoting it would claim it starts its own discussion.
 *
 * Replies within a thread are ordered oldest-first. The page itself arrives
 * newest-first (`-created_at`), which is right for a flat feed of comments and
 * unreadable for a conversation.
 */
function buildThread(rows: CommentNode[], repliesByParent: Record<string, ReplyBundle>): ThreadNode[] {
  const ids = new Set(rows.map((c) => c.id));
  const childrenByParent = new Map<string, CommentNode[]>();
  const tops: CommentNode[] = [];

  for (const row of rows) {
    if (!row.parent || !ids.has(row.parent)) {
      tops.push(row);
      continue;
    }
    const bucket = childrenByParent.get(row.parent);
    if (bucket) bucket.push(row);
    else childrenByParent.set(row.parent, [row]);
  }

  // A comment has exactly one parent, so a single visited set both de-duplicates
  // and makes a parent cycle unreachable.
  const visited = new Set<string>();

  const walk = (parentId: string, depth: number): ThreadNode[] => {
    if (depth >= MAX_THREAD_DEPTH) return [];
    const bundle = repliesByParent[parentId];
    const candidates = dedupeById([...(childrenByParent.get(parentId) ?? []), ...(bundle?.comments ?? [])]);
    const children: ThreadNode[] = [];
    for (const child of candidates) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      children.push({ comment: child, children: walk(child.id, depth + 1), isDetachedReply: false });
    }
    children.sort((a, b) => a.comment.created_at.localeCompare(b.comment.created_at));
    return children;
  };

  return tops.map((top) => {
    visited.clear();
    return {
      comment: top,
      children: walk(top.id, 0),
      isDetachedReply: top.parent !== null,
    };
  });
}

/**
 * Drop a comment and everything below it.
 *
 * `Comment.parent` is `on_delete=models.CASCADE` (`models.py:217`), so the
 * server removes the whole subtree. Leaving the descendants on screen would
 * render replies to a comment that no longer exists.
 */
function withoutSubtree(rows: CommentNode[], rootId: string): CommentNode[] {
  const removed = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parent && removed.has(row.parent) && !removed.has(row.id)) {
        removed.add(row.id);
        grew = true;
      }
    }
  }
  return rows.filter((c) => !removed.has(c.id));
}

function withoutSubtreeFromBundles(
  bundles: Record<string, ReplyBundle>,
  rootId: string,
): Record<string, ReplyBundle> {
  const next: Record<string, ReplyBundle> = {};
  for (const [parentId, bundle] of Object.entries(bundles)) {
    next[parentId] = { ...bundle, comments: withoutSubtree(bundle.comments, rootId) };
  }
  delete next[rootId];
  return next;
}

/**
 * What the header can honestly claim.
 *
 * `clip.comment_count` is the authoritative total, incremented on the server
 * for every top-level comment (`models.py:228-229`) — it is the same number the
 * `ReelCard` button behind this sheet shows, so the two can no longer disagree.
 * The rendered rows are one page of 20 (`views/_pagination.py:10-12`) and
 * `client.ts` discards `next`, so the count of what is on screen is not a total
 * and is never presented as one.
 */
function threadSummary(total: number, loaded: number, hasNextPage: boolean): string {
  const label = `${total} ${total === 1 ? "discussion" : "discussions"}`;
  if (hasNextPage) {
    return `Showing the ${loaded} most recent. ${label} in total — older comments are not loaded.`;
  }
  if (loaded === 0 || loaded >= total) return "";
  return `Showing ${loaded} of ${label}.`;
}

export const CommentSheet: React.FC<CommentSheetProps> = ({ clip, isOpen, onClose }) => {
  const { user } = useAuth();
  const [comments, setComments] = useState<CommentNode[]>([]);
  const [hasNextPage, setHasNextPage] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [repliesByParent, setRepliesByParent] = useState<Record<string, ReplyBundle>>({});
  const [newComment, setNewComment] = useState<string>("");
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [replyToUser, setReplyToUser] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Monotonic token for the top-level fetch. The sheet can be closed and
  // reopened on another clip while a request is still in flight, and a late
  // response would otherwise overwrite the new clip's list — the previous
  // clip's comments rendered under this clip's title.
  const loadToken = useRef<number>(0);

  const loadComments = async (clipId: string) => {
    const token = loadToken.current + 1;
    loadToken.current = token;
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await commentsAPI.getComments(clipId);
      if (loadToken.current !== token) return;
      setComments((data.results ?? []).map(toCommentNode));
      setHasNextPage(Boolean(data.next));
    } catch (err: unknown) {
      // The old handler was `console.warn` only, so `comments` stayed `[]` and
      // the list fell through to "No comments yet / Be the first to share your
      // reaction" — on a thread whose real total was on the `ReelCard` button
      // behind the sheet. A failure is not a fact about the thread.
      if (loadToken.current !== token) return;
      setLoadError(loadFailureMessage(err));
    } finally {
      if (loadToken.current === token) setIsLoading(false);
    }
  };

  const loadReplies = async (clipId: string, parentId: string) => {
    setRepliesByParent((prev) => ({
      ...prev,
      [parentId]: { comments: prev[parentId]?.comments ?? [], isLoading: true, error: null },
    }));
    try {
      const data = await commentsAPI.getComments(clipId, parentId);
      setRepliesByParent((prev) => ({
        ...prev,
        [parentId]: {
          comments: (data.results ?? []).map(toCommentNode),
          isLoading: false,
          error: null,
        },
      }));
    } catch (err: unknown) {
      setRepliesByParent((prev) => ({
        ...prev,
        [parentId]: {
          comments: prev[parentId]?.comments ?? [],
          isLoading: false,
          error: repliesFailureMessage(err),
        },
      }));
    }
  };

  // `Feed.tsx:172-176` mounts this component once and only ever flips `isOpen`,
  // so every `useState` here outlives a close. Nothing may carry over: the
  // previous clip's comments, its error banners, its fetched reply bundles and
  // the draft the user never sent.
  useEffect(() => {
    if (!isOpen || !clip) {
      // Invalidate any in-flight fetch, so its response cannot land in a sheet
      // that is closed (or already showing a different clip).
      loadToken.current += 1;
      setComments([]);
      setHasNextPage(false);
      setLoadError(null);
      setIsLoading(false);
      setRepliesByParent({});
      setNewComment("");
      setReplyToId(null);
      setReplyToUser(null);
      setPostError(null);
      setDeleteError(null);
      return;
    }
    void loadComments(clip.id);
  }, [isOpen, clip]);

  // Move focus into the dialog on open and put it back on the trigger on close,
  // so a keyboard user is not left tabbing through the feed behind the overlay.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [isOpen, clip?.id]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable.at(0);
    const last = focusable.at(focusable.length - 1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }

    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || active === dialog) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clip || !newComment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setPostError(null);
    try {
      const res = await commentsAPI.postComment(clip.id, newComment.trim(), replyToId);
      setComments((prev) => [toCommentNode(res), ...prev]);
      setNewComment("");
      setReplyToId(null);
      setReplyToUser(null);
    } catch (err: unknown) {
      // `console.warn` only, so a refused comment was indistinguishable from a
      // posted one and the user would assume it went through. The draft is
      // deliberately left in the field, so a retry is one keypress away.
      setPostError(postFailureMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    setDeleteError(null);
    try {
      await commentsAPI.deleteComment(commentId);
      // The row is either a member of the loaded page or of a fetched reply
      // bundle. Filtering only the page would report success and leave the row
      // on screen.
      setComments((prev) => withoutSubtree(prev, commentId));
      setRepliesByParent((prev) => withoutSubtreeFromBundles(prev, commentId));
    } catch (err: unknown) {
      // The delete failed, so the comment is still on the server. Removing the
      // row here would be the same lie in the other direction.
      setDeleteError(deleteFailureMessage(err));
    }
  };

  const handleToggleReplies = (parentId: string) => {
    if (!clip) return;
    const bundle = repliesByParent[parentId];
    if (bundle && !bundle.isLoading) {
      setRepliesByParent((prev) => {
        const rest = { ...prev };
        delete rest[parentId];
        return rest;
      });
      return;
    }
    void loadReplies(clip.id, parentId);
  };

  if (!isOpen || !clip) return null;

  const thread = buildThread(comments, repliesByParent);
  const summary = threadSummary(clip.comment_count, comments.length, hasNextPage);
  const isAuthor = (comment: CommentNode): boolean =>
    user != null && comment.author_id !== null && comment.author_id === user.id;
  const canSubmit = newComment.trim().length > 0 && !isSubmitting;

  const renderRow = (node: ThreadNode, depth: number) => {
    const { comment } = node;
    const bundle = repliesByParent[comment.id];
    const unloadedReplies = Math.max(0, comment.reply_count - node.children.length);
    const knownReplies = Math.max(comment.reply_count, node.children.length);
    const timeLabel = formatCommentTime(comment.created_at, Date.now());

    return (
      <li key={comment.id} className="space-y-2">
        <div className={depth > 0 ? "ml-3 pl-3 border-l border-white/10" : ""}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-full bg-white/10 border border-white/20 flex items-center justify-center font-black text-xs text-[#FF6321] flex-shrink-0 mt-0.5">
                {comment.author_username[0]?.toUpperCase()}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black uppercase text-white">
                    @{comment.author_username}
                  </span>
                  {timeLabel && (
                    <time
                      dateTime={comment.created_at}
                      className="text-[9px] font-mono text-white/30"
                    >
                      {timeLabel}
                    </time>
                  )}
                </div>
                {node.isDetachedReply && (
                  <p className="text-[9px] font-mono uppercase text-white/30 mt-0.5">
                    Parent comment not loaded
                  </p>
                )}
                <p className="text-xs text-white/80 mt-0.5 leading-relaxed font-sans">
                  {comment.text}
                </p>

                <div className="flex items-center gap-3 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setReplyToId(comment.id);
                      setReplyToUser(comment.author_username);
                    }}
                    className="inline-flex items-center min-h-6 text-[10px] font-mono uppercase text-[#FF6321] hover:underline"
                  >
                    Reply
                  </button>
                  {isAuthor(comment) && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteComment(comment.id)}
                      className="inline-flex items-center min-h-6 text-[10px] font-mono uppercase text-white/30 hover:text-rose-400"
                    >
                      Delete
                    </button>
                  )}
                  {knownReplies > 0 && (
                    <span className="inline-flex items-center min-h-6 text-[10px] font-mono text-white/30">
                      {unloadedReplies > 0 ? (
                        <button
                          type="button"
                          onClick={() => handleToggleReplies(comment.id)}
                          aria-busy={bundle?.isLoading === true}
                          className="inline-flex items-center min-h-6 hover:underline hover:text-white/60"
                        >
                          {bundle?.isLoading
                            ? "Loading replies..."
                            : `Show ${unloadedReplies} more ${unloadedReplies === 1 ? "reply" : "replies"}`}
                        </button>
                      ) : (
                        `${knownReplies} ${knownReplies === 1 ? "reply" : "replies"}`
                      )}
                    </span>
                  )}
                </div>

                {bundle?.error && (
                  <p className="text-[10px] font-mono text-rose-400 mt-1">{bundle.error}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {node.children.length > 0 && (
          <ul
            role="list"
            aria-label={`Replies to @${comment.author_username}`}
            className="ml-3 pl-3 border-l border-white/10 space-y-2"
          >
            {node.children.map((child) => renderRow(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/80 backdrop-blur-sm transition-opacity">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_TITLE_ID}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[85vh] h-[600px] bg-[#111111] border-t md:border border-white/15 rounded-t-3xl md:rounded-3xl flex flex-col shadow-2xl overflow-hidden animate-in slide-in-from-bottom-5 duration-200"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-white/10">
          <div className="min-w-0">
            <h2
              id={DIALOG_TITLE_ID}
              className="text-sm font-black uppercase tracking-tight text-white flex items-center gap-2"
            >
              <MessageSquare className="w-4 h-4 text-[#FF6321]" aria-hidden="true" />
              Discussions ({clip.comment_count})
            </h2>
            <p className="text-[10px] font-mono uppercase text-white/40 truncate max-w-xs">
              {clip.title}
            </p>
            {summary && <p className="text-[10px] font-mono text-white/30 mt-1">{summary}</p>}
          </div>
          <button
            type="button"
            aria-label="Close comments"
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Comment List */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4" aria-busy={isLoading}>
          {/* Kept mounted when empty: a live region inserted at the same tick as
              its text is not reliably announced. */}
          <p
            role="status"
            aria-live="polite"
            className={`text-center font-mono text-xs uppercase text-white/40 ${
              isLoading ? "py-12" : "sr-only"
            }`}
          >
            {isLoading ? "Loading thoughts..." : ""}
          </p>

          <p
            id={DELETE_ERROR_ID}
            role="status"
            aria-live="polite"
            className={`text-[10px] font-mono text-rose-400 ${deleteError ? "" : "sr-only"}`}
          >
            {deleteError ?? ""}
          </p>

          {isLoading ? null : loadError ? (
            <div role="alert" className="py-12 text-center space-y-3">
              <p className="text-sm font-black uppercase text-white flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400" aria-hidden="true" />
                Could not load comments
              </p>
              <p className="text-xs font-sans text-white/60">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadComments(clip.id)}
                className="inline-flex items-center min-h-6 px-3 rounded-lg border border-white/20 text-[10px] font-mono uppercase text-white hover:bg-white/10"
              >
                Try again
              </button>
            </div>
          ) : comments.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <p className="text-sm font-black uppercase text-white">No comments yet</p>
              <p className="text-xs font-mono uppercase text-white/40">
                Be the first to share your reaction on this audio reel.
              </p>
            </div>
          ) : (
            <ul role="list" aria-label={THREAD_LIST_NAME} className="space-y-4">
              {thread.map((node) => renderRow(node, 0))}
            </ul>
          )}
        </div>

        {/* Input Footer */}
        <div className="p-4 bg-black/60 border-t border-white/10">
          {replyToId && (
            <div className="flex items-center justify-between text-[10px] font-mono text-[#FF6321] uppercase mb-2 px-1">
              <span>Replying to @{replyToUser}</span>
              <button
                type="button"
                onClick={() => {
                  setReplyToId(null);
                  setReplyToUser(null);
                }}
                className="inline-flex items-center min-h-6 hover:underline"
              >
                Cancel
              </button>
            </div>
          )}
          <form onSubmit={handlePostComment} className="space-y-2">
            <label
              htmlFor={COMPOSER_INPUT_ID}
              className="block text-[10px] font-mono uppercase text-white/40"
            >
              Add a comment
            </label>
            <p
              id={COMPOSER_ERROR_ID}
              role="status"
              aria-live="polite"
              className={`text-[10px] font-mono text-rose-400 ${postError ? "" : "sr-only"}`}
            >
              {postError ?? ""}
            </p>
            <div className="flex items-center gap-2">
              <input
                id={COMPOSER_INPUT_ID}
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Drop an audio comment or reaction..."
                aria-describedby={postError ? COMPOSER_ERROR_ID : undefined}
                className="flex-1 bg-[#111111] border border-white/15 rounded-xl px-4 py-2.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#FF6321]"
              />
              {/* `aria-disabled` rather than `disabled`: a natively disabled
                  button leaves the tab order and drops focus to <body>
                  (WCAG 2.4.3), and this button disables whenever the field is
                  empty — i.e. on every submit attempt. The in-flight guard in
                  `handlePostComment` still refuses the double-submit. */}
              <button
                type="submit"
                aria-label="Post comment"
                aria-disabled={!canSubmit}
                aria-busy={isSubmitting}
                className="p-2.5 rounded-xl bg-[#FF6321] text-black hover:bg-[#ff753b] aria-disabled:opacity-40 aria-disabled:cursor-not-allowed transition-all"
              >
                <Send className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
