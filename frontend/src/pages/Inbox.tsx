import React, { useEffect, useState } from "react";
import { AlertTriangle, Inbox as InboxIcon, Pause, Play, Radio, RefreshCw, Trash2 } from "lucide-react";
import { shareAPI } from "../api/client";
import { usePlayer } from "../stores/player";
import { ShareEvent } from "../types/echoflow";

interface InboxPageProps {
  onRefreshUnread: () => void;
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;
/** Mean Gregorian month, so "1 month ago" and "4 months ago" stay distinct. */
const MONTH_SECONDS = 4.34524 * WEEK_SECONDS;
const YEAR_SECONDS = 12 * MONTH_SECONDS;

/**
 * Chooses the largest unit the elapsed time fits in. Written as a ladder of
 * early returns rather than a `DIVISIONS` table so every branch is total —
 * there is no index to fall off the end of and no unreachable fallthrough
 * (`noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch` are both on).
 */
function relativeUnit(elapsedSeconds: number): {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
} {
  const magnitude = Math.abs(elapsedSeconds);
  if (magnitude < MINUTE_SECONDS) return { value: elapsedSeconds, unit: "second" };
  if (magnitude < HOUR_SECONDS) return { value: elapsedSeconds / MINUTE_SECONDS, unit: "minute" };
  if (magnitude < DAY_SECONDS) return { value: elapsedSeconds / HOUR_SECONDS, unit: "hour" };
  if (magnitude < WEEK_SECONDS) return { value: elapsedSeconds / DAY_SECONDS, unit: "day" };
  if (magnitude < MONTH_SECONDS) return { value: elapsedSeconds / WEEK_SECONDS, unit: "week" };
  if (magnitude < YEAR_SECONDS) return { value: elapsedSeconds / MONTH_SECONDS, unit: "month" };
  return { value: elapsedSeconds / YEAR_SECONDS, unit: "year" };
}

let relativeTimeFormatter: Intl.RelativeTimeFormat | null = null;

/**
 * `Intl.RelativeTimeFormat` is a platform API; hand-rolling "3h ago" strings
 * is how a screen ends up disagreeing with the device locale. It is built
 * lazily and memoised so the locale is read once.
 */
function formatter(): Intl.RelativeTimeFormat {
  relativeTimeFormatter ??= new Intl.RelativeTimeFormat(
    typeof navigator === "undefined" ? undefined : navigator.language,
    { numeric: "auto" },
  );
  return relativeTimeFormatter;
}

/**
 * `created_at` is supplied by `ShareEventSerializer` (`serializers.py:583`,
 * from `ShareEvent.created_at` at `models.py:241`) and declared at
 * `types/echoflow.ts:71`. The inbox rendered it nowhere, so "is this from five
 * minutes ago or five months ago" — the entire question this screen supports —
 * was unanswerable (RECON-03 finding #20).
 *
 * Returns `null` for an absent, blank or unparseable value. It must: a missing
 * field is not "now". Falling back to `Date.now()` here would fabricate a share
 * age out of nothing, which is the same defect class as
 * `date_joined || Date.now()` in `Profile.tsx` (RECON-03 finding #8) — the
 * caller renders nothing at all instead.
 */
function formatRelativeTime(createdAt: string | null | undefined, nowMs: number): string | null {
  if (typeof createdAt !== "string" || createdAt.trim() === "") return null;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return null;
  const { value, unit } = relativeUnit((createdMs - nowMs) / 1000);
  return formatter().format(Math.round(value), unit);
}

/**
 * `apiRequest` throws two unrelated shapes: an `Error` carrying `.status` and
 * `.data` when the server answered (`client.ts:162-170`), and the raw
 * transport error (a `TypeError`) when `fetch` itself rejected
 * (`client.ts:133`). One sentence for both tells a user on a dead connection
 * to go hunting a server bug that does not exist — the RECON-04 F15
 * error-laundering shape. So the failure is classified, not stringified.
 *
 * The offline/server discriminator itself belongs to `client.ts` (FIX-PLAN
 * #16, RECON-04 F8), which owns the request path. Reading `.status` here is
 * the same sniffing `Explore.tsx:33-43` already does; when that groundwork
 * lands, these two collapse into one call.
 */
type LoadFailure =
  | { kind: "offline" }
  | { kind: "server"; status: number; detail: string };

function classifyFailure(err: unknown): LoadFailure {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") {
    return {
      kind: "server",
      status,
      detail: err instanceof Error ? err.message : "",
    };
  }
  return { kind: "offline" };
}

/** One honest sentence per failure shape, appended to both mutation messages. */
function describeFailure(failure: LoadFailure): string {
  return failure.kind === "offline"
    ? "Check your connection."
    : `EchoFlow returned an error (${failure.status}).`;
}

export const InboxPage: React.FC<InboxPageProps> = ({ onRefreshUnread }) => {
  const [shares, setShares] = useState<ShareEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  /**
   * Announced mutation failures. These were `console.warn` only, so a share
   * that could not be marked read, or could not be removed, looked exactly
   * like one that could (RECON-04 F16). Cleared when a later action succeeds so
   * a stale warning never outlives the condition it describes.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The reference point for every relative time on the page. A relative time
   * is a claim about *now*, so it is recomputed once a minute rather than
   * frozen at first render — otherwise a row read at "2 minutes ago" still
   * says "2 minutes ago" an hour later, which is a stale claim rather than a
   * missing one.
   */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const { currentClip, isPlaying, playClip, togglePlay } = usePlayer();

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const loadInbox = async () => {
    setIsLoading(true);
    setFailure(null);
    try {
      const data = await shareAPI.getInbox();
      setShares(data);
      onRefreshUnread();
    } catch (err: unknown) {
      setFailure(classifyFailure(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadInbox();
  }, []);

  const handlePlayShare = async (item: ShareEvent) => {
    setActionError(null);
    if (!item.is_read) {
      try {
        await shareAPI.markRead(item.id);
        setShares((prev) =>
          prev.map((s) => (s.id === item.id ? { ...s, is_read: true } : s))
        );
        onRefreshUnread();
      } catch (err: unknown) {
        // Idempotent server-side, so a retry is free — but the user has to be
        // told, because the badge keeps saying NEW and nothing else explains
        // why. The share is *not* rolled forward: the server did not confirm.
        setActionError(
          `Couldn't mark @${item.sender_name}'s share as read. It stays unread. ${describeFailure(
            classifyFailure(err),
          )}`,
        );
      }
    }

    if (currentClip?.id === item.clip.id) {
      togglePlay();
    } else {
      playClip(item.clip);
    }
  };

  const handleDeleteShare = async (shareId: number) => {
    setActionError(null);
    const share = shares.find((s) => s.id === shareId);
    try {
      await shareAPI.deleteShare(shareId);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
      onRefreshUnread();
    } catch (err: unknown) {
      // The row is removed only *after* the server confirms, so there is
      // nothing to roll back — the existing behaviour is correct and is
      // pinned by a test. All that was missing was the announcement.
      setActionError(
        `Couldn't remove @${share?.sender_name ?? "this sender"}'s share. It is still in your inbox. ${describeFailure(
          classifyFailure(err),
        )}`,
      );
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 md:px-8 py-6 pb-28 space-y-6">
      <div className="border-b border-white/10 pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-[#F5F5F5] flex items-center gap-3">
            <InboxIcon className="w-7 h-7 text-[#FF6321]" aria-hidden="true" />
            Audio Inbox
          </h1>
          <p className="text-xs font-mono uppercase text-white/60 mt-1">
            Audio reels sent directly to your queue by network peers
          </p>
        </div>
        <span className="text-xs font-mono text-[#FF6321] font-bold uppercase">
          {shares.filter((s) => !s.is_read).length} UNREAD
        </span>
      </div>

      {/*
        Announced *and* visible. The old failures were `console.warn` only, so
        a sighted user saw nothing at all; `ReelCard.tsx:302-309` (the
        app's own reference implementation for this) is a visible red line
        inside an always-mounted region, and that is the shape used here.

        Kept mounted even when empty — a live region inserted at the same tick
        as its text is unreliable, and RECON-06 finding #25 records the
        mirror-image bug (a region whose text never changes is not
        re-announced) in `SessionAnnouncer`. An empty inline `<span>` costs no
        layout height, so it can stay.
      */}
      <span
        role="status"
        aria-live="polite"
        className="block text-[10px] font-mono uppercase text-rose-400"
      >
        {actionError ?? ""}
      </span>

      {isLoading ? (
        <div
          role="status"
          className="py-24 flex flex-col items-center justify-center text-white/60 font-mono text-xs uppercase gap-2"
        >
          <div
            className="w-8 h-8 border-2 border-[#FF6321] border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
          <span>Polling audio stream messages...</span>
        </div>
      ) : failure ? (
        <div
          role="alert"
          className="p-6 rounded-2xl bg-[#111111] border border-rose-500/40 text-center space-y-3"
        >
          <AlertTriangle className="w-8 h-8 mx-auto text-rose-400" aria-hidden="true" />
          <p className="text-sm font-black uppercase text-white">
            {failure.kind === "offline"
              ? "Can't reach EchoFlow"
              : `EchoFlow returned an error (${failure.status})`}
          </p>
          <p className="text-xs font-mono text-white/60">
            {failure.kind === "offline"
              ? "The request never completed. Check your connection, then try again."
              : failure.detail || "The server could not return your inbox."}
          </p>
          {/*
            The old error branch rendered the raw message in a bare `<div>`
            with no role and no way out — recovery meant switching tabs to
            unmount the page (RECON-04 F22). This button is that way out.

            No timeout is added around the request: `client.ts:115-174` has no
            `AbortController`, and a local `Promise.race` here would create a
            second, divergent request path. The timeout belongs in `client.ts`
            (FIX-PLAN #16, RECON-04 F8).
          */}
          <button
            type="button"
            onClick={() => void loadInbox()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider hover:bg-[#ff753b] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : shares.length === 0 ? (
        <div className="p-16 rounded-3xl bg-[#111111] border border-white/10 text-center space-y-3">
          <Radio className="w-12 h-12 text-white/60 mx-auto" aria-hidden="true" />
          <p className="text-base font-black uppercase text-white">Audio Inbox Clear</p>
          <p className="text-xs font-mono uppercase text-white/60 max-w-xs mx-auto">
            Directly shared audio reels from creators and friends will appear here for hands-free listening.
          </p>
        </div>
      ) : (
        <>
          {/*
            Rows were `<div onClick>` with a `<div>` play affordance inside
            them: not one keyboard-reachable or exposed control on the page
            (RECON-06 finding #6, WCAG 2.1.1). Each `<li>` now exposes three
            real buttons. The play button and the title button are *siblings*
            of each other, not nested — a `<button>` inside a `<button>` is
            invalid and, worse, only the inner one is reachable. This is the
            shape `Explore.tsx:270-326` already uses.

            `clip_hls_url` (`serializers.py:582`) is also supplied and still
            unused. Deliberately not built into a player here: it is an HLS
            URL behind the playback-token contract, and `player.tsx` owns that.
          */}
          <ul role="list" className="space-y-3">
            {shares.map((item) => {
              const isThisPlaying = currentClip?.id === item.clip.id && isPlaying;
              const relativeTime = formatRelativeTime(item.created_at, nowMs);

              return (
                <li
                  key={item.id}
                  className={`p-4 rounded-2xl border transition-all flex items-center justify-between gap-4 group ${
                    !item.is_read
                      ? "bg-[#111111] border-[#FF6321] shadow-[0_0_20px_rgba(255,99,33,0.1)] ring-1 ring-[#FF6321]"
                      : "bg-[#111111]/80 hover:bg-[#111111] border-white/10"
                  }`}
                >
                  {/* Play button */}
                  <button
                    type="button"
                    onClick={() => void handlePlayShare(item)}
                    aria-label={`${isThisPlaying ? "Pause" : "Play"} ${item.clip_title}`}
                    className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform ${
                      isThisPlaying
                        ? "bg-[#FF6321] text-black scale-105 shadow-[0_0_15px_rgba(255,99,33,0.35)]"
                        : "bg-white/10 text-white group-hover:bg-[#FF6321] group-hover:text-black"
                    }`}
                  >
                    {isThisPlaying ? (
                      <Pause className="w-5 h-5 fill-current" aria-hidden="true" />
                    ) : (
                      <Play className="w-5 h-5 fill-current ml-0.5" aria-hidden="true" />
                    )}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs font-black uppercase text-[#FF6321]">
                        @{item.sender_name}
                      </span>
                      <span className="text-[10px] font-mono uppercase text-white/60">shared audio reel</span>
                      {!item.is_read && (
                        <span className="px-1.5 py-0.2 rounded bg-[#FF6321] text-black text-[9px] font-mono font-black uppercase">
                          NEW
                        </span>
                      )}
                      {/*
                        The payload's own `created_at`, in the user's locale.
                        Rendered as nothing at all when the field is absent —
                        see `formatRelativeTime`.
                      */}
                      {relativeTime && (
                        <time
                          dateTime={item.created_at}
                          className="text-[10px] font-mono uppercase text-white/60"
                        >
                          {relativeTime}
                        </time>
                      )}
                    </div>
                    {/*
                      `<h3>` directly under the page `<h1>` skipped a level
                      (WCAG 1.3.1, RECON-06 finding #20). The share list is a
                      section of the page, so its items are `<h2>` — and the
                      title is the second button, which keeps the whole title
                      row clickable as it was.
                    */}
                    <h2 className="text-sm font-black uppercase tracking-tight text-white group-hover:text-[#FF6321] transition-colors">
                      <button
                        type="button"
                        onClick={() => void handlePlayShare(item)}
                        className="inline-block w-full text-left truncate"
                      >
                        {item.clip_title}
                      </button>
                    </h2>
                    <p className="text-[10px] font-mono uppercase text-white/60">
                      BY @{item.clip.creator_name} • {item.clip.category}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleDeleteShare(item.id)}
                      aria-label={`Remove ${item.clip_title} from inbox`}
                      className="p-2 rounded-lg text-white/60 hover:text-rose-400 hover:bg-white/10 transition-colors"
                      title="Remove from Inbox"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
};
