import React, { useEffect, useRef, useState } from "react";
import { Sparkles, Check, Headphones, RefreshCw } from "lucide-react";
import { ApiError, apiRequest, feedAPI } from "../../api/client";

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInitialized: () => void;
}

const DIALOG_TITLE_ID = "onboarding-modal-title";
const TAG_GROUP_NAME = "Vibes to seed your feed";
const SUBMIT_ERROR_ID = "onboarding-submit-error";
const TAGS_ENDPOINT = "/tags/available/";

/**
 * One row of `GET /tags/available/`.
 *
 * `tag` is a real `AudioClip.tags` value and `clips` is how many clips carry
 * it. The server serves this from the same clip population
 * `POST /tags/initialize/` draws its baseline from, so every tag offered here
 * is one that can actually be matched.
 */
interface AvailableTag {
  tag: string;
  clips: number;
}

/**
 * The endpoint's body, checked at runtime.
 *
 * The response is a network boundary, so its shape is asserted rather than
 * assumed: `apiRequest` is generic (`<T = any>`) and a cast would be a claim
 * about the server that nothing tests. A row without a usable `tag` string is
 * dropped instead of rendered — a `undefined` in the toggle list is a label
 * nothing can match, which is the defect this file used to ship. A body that
 * has no `tags` array at all is NOT treated as "no tags": that is a broken
 * contract, and rendering it as an empty picker would tell the user their taste
 * matched nothing when the truth is that nothing was read.
 */
function readTags(body: unknown): AvailableTag[] | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { tags?: unknown }).tags;
  if (!Array.isArray(raw)) return null;

  const tags: AvailableTag[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const candidate = row as { tag?: unknown; clips?: unknown };
    if (typeof candidate.tag !== "string") continue;
    const tag = candidate.tag.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const clips =
      typeof candidate.clips === "number" && Number.isFinite(candidate.clips)
        ? Math.max(0, Math.trunc(candidate.clips))
        : 0;
    tags.push({ tag, clips });
  }
  // Order is the server's (`clips DESC, tag ASC`), so it is not re-derived here.
  return tags;
}

/** The vocabulary's state. `empty` means "read fine, nothing qualifies". */
type VocabPhase = "loading" | "ready" | "empty" | "failed";

/**
 * The vocabulary failure, split the way `ApiError.kind` splits it.
 *
 * `apiRequest` throws one class for three different situations, and they are
 * not the same news for a user: a 500 is the server's problem, a transport
 * failure is the connection's, and a timeout is not evidence of either. Showing
 * one sentence for all three is what `pages/Explore.tsx:232-240` stopped doing.
 */
interface VocabFailure {
  title: string;
  detail: string;
}

/**
 * What the vocabulary call has to say, by cause.
 *
 * `serverMessage` is reused for the HTTP case so a server that explained
 * itself is quoted, and so a 5xx HTML page still cannot reach a human.
 */
function vocabularyFailure(err: unknown): VocabFailure {
  if (!(err instanceof ApiError)) {
    return {
      title: "Can't reach EchoFlow",
      detail: "The request never completed. Check your connection, then try again.",
    };
  }
  if (err.kind === "timeout") {
    return {
      title: "That took too long",
      detail:
        "EchoFlow did not answer in time, so no tags were loaded. That is not a verdict on your connection — try again.",
    };
  }
  if (err.kind === "network") {
    return {
      title: "Can't reach EchoFlow",
      detail: "The request never completed. Check your connection, then try again.",
    };
  }
  return {
    title: err.status === undefined ? "EchoFlow returned an error" : `EchoFlow returned an error (${err.status})`,
    detail:
      serverMessage(err) ??
      "The server could not return the tag list, so nothing was loaded. Try again in a moment.",
  };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

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
 * diagnosis, so neither may be shown as one. The body of a `TagsViewSet` 400 is
 * `{"error": "..."}` — `views/feed.py` uses that shape deliberately rather than
 * DRF's `{"detail": ...}` — so `error` is the field to read, with `message` as
 * the fallback for a shape this file does not own.
 */
function serverMessage(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { error?: unknown; message?: unknown };
  for (const value of [candidate.error, candidate.message]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "Request failed" || trimmed.startsWith("<")) continue;
    return trimmed;
  }
  return null;
}

/**
 * Cold-start failures, by cause. The old handler showed `err?.message` from a
 * `catch (err: any)`, which for a transport failure is a `TypeError: Failed to
 * fetch` rendered as though the server had said it.
 */
function initializeFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status === undefined) {
    return "Could not reach the server. Your feed was not initialized — try again.";
  }
  if (status === 400) {
    return (
      serverMessage(err) ??
      "The server rejected that selection. Choose a different vibe and try again."
    );
  }
  if (status === 401 || status === 403) {
    return "Your session expired before the feed could be initialized. Sign in and try again.";
  }
  if (status === 429) {
    return "Too many attempts. Wait a moment, then try again.";
  }
  return "Your feed could not be initialized. Try again in a moment.";
}

export const OnboardingModal: React.FC<OnboardingModalProps> = ({ isOpen, onClose, onInitialized }) => {
  /**
   * Empty, not a guess.
   *
   * This used to open with two of the eight hardcoded ids preselected. Neither
   * was a value any clip carried, so the dialog arrived pre-armed with a
   * selection that could only ever 400. With the vocabulary now coming from
   * the server, the default is nothing: an empty selection is honest, and it
   * keeps the `aria-disabled` submit button reachable for a keyboard user who
   * wants to hear why it is inert.
   */
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [tags, setTags] = useState<AvailableTag[]>([]);
  const [phase, setPhase] = useState<VocabPhase>("loading");
  const [vocabFailure, setVocabFailure] = useState<VocabFailure | null>(null);
  /** Bumped by Retry. A fresh effect run cancels the previous request's result. */
  const [requestId, setRequestId] = useState(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  /**
   * The vocabulary, from the server.
   *
   * The eight ids this dialog used to ship in source are gone, and there is no
   * fallback list to replace them: a fallback is the same defect wearing a
   * different hat. `GET /tags/available/` only returns tags that appear on
   * more than one clip, and it is served from the same population
   * `POST /tags/initialize/` matches against, so every option offered is one
   * that can succeed. When it returns `{"tags": []}` the honest thing is to say
   * the catalogue is too small to personalise from — not to invent a guess.
   *
   * `cancelled` discards a response that arrives after the request was
   * abandoned (Retry, close, unmount), so a slow first answer cannot overwrite
   * a newer one.
   */
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setPhase("loading");
    setVocabFailure(null);

    void (async () => {
      try {
        const body = await apiRequest<unknown>(TAGS_ENDPOINT);
        if (cancelled) return;
        const parsed = readTags(body);
        if (parsed === null) {
          setTags([]);
          setVocabFailure({
            title: "EchoFlow sent something we can't read",
            detail:
              "The tag list came back in a shape this screen does not understand, so nothing was loaded. Try again.",
          });
          setPhase("failed");
          return;
        }
        setTags(parsed);
        setPhase(parsed.length > 0 ? "ready" : "empty");
      } catch (err: unknown) {
        if (cancelled) return;
        setTags([]);
        setVocabFailure(vocabularyFailure(err));
        setPhase("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, requestId]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  /**
   * Dismissing the dialog is a decision, so it clears `ef_new_user`.
   *
   * It used to be cleared only inside the `try` of a successful initialize, and
   * a successful initialize had never happened — `select count(*) from app_user
   * where long_term_semantic is not null` was 0. So Skip left the flag set and
   * `App.tsx:509-513` re-armed this modal on every single reload, for ever.
   * Escape and the empty state's route to the feed go through here too: they
   * are the same dismissal, and any of them leaving the flag behind re-creates
   * the loop. A 400 does NOT: the modal is still open, and the user has not
   * dismissed anything.
   */
  const handleSkip = () => {
    sessionStorage.removeItem("ef_new_user");
    onClose();
  };

  const handleInitialize = async () => {
    if (selectedTags.length === 0) {
      setErrorMsg("Select at least one vibe to initialize your feed.");
      return;
    }
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await feedAPI.initializeTags(selectedTags);
      sessionStorage.removeItem("ef_new_user");
      onInitialized();
      onClose();
    } catch (err: unknown) {
      setErrorMsg(initializeFailureMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Move focus into the dialog on open and put it back on the trigger on close,
  // so a keyboard user is not left tabbing through the page behind the overlay.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      handleSkip();
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

  const hasSelection = selectedTags.length > 0;
  const canInitialize = phase === "ready";

  /**
   * One live region for the whole dialog, always mounted (it sits inside the
   * dialog, which is mounted from first paint) rather than inserted together
   * with its text. It carries whichever fact is currently true, so a loading
   * spinner cannot add a second `role="status"` for a screen reader to choose
   * between.
   */
  const statusText =
    phase === "ready"
      ? `${selectedTags.length} Vibes Armed`
      : phase === "loading"
        ? "Loading tags…"
        : phase === "empty"
          ? "No tags to seed from yet"
          : "Tags unavailable";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_TITLE_ID}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="w-full max-w-lg bg-[#111111] border border-white/15 rounded-3xl p-6 md:p-8 shadow-2xl relative"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-[#FF6321] flex items-center justify-center text-black font-black">
            <Sparkles className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
          </div>
          <div>
            <h2
              id={DIALOG_TITLE_ID}
              className="text-xl md:text-2xl font-black uppercase tracking-tight text-white"
            >
              Vector Cold-Start
            </h2>
            {/*
              Was "Initialize 384-dimensional cosine preference weights". It
              described an internal mechanism the response says nothing about,
              and it read as a promise: it told the user a 384-dimensional
              vector was about to exist for them. It usually did not —
              `app_user.long_term_semantic` was NULL for every row in the
              catalogue, so every submission 400'd with "Not enough data to
              build baseline." and the user was left to conclude their taste was
              the problem. Now it says what the button does.
            */}
            <p className="text-[10px] font-mono uppercase text-white/50">
              Blend a few real tags into a starting profile
            </p>
          </div>
        </div>

        <p className="text-xs font-mono uppercase text-white/60 mb-4 leading-relaxed">
          Pick what sounds like you and we&apos;ll blend those tags into a starting profile. If a tag
          has no audio behind it by the time you submit, we&apos;ll tell you what happened — and your
          feed works either way.
        </p>

        {/* `role="alert"` so a rejected cold-start is announced. The same node
            also names the submit button through `aria-describedby`, because a
            message about a control the user is trying to use is only useful if
            it reaches them while they are on it. */}
        {errorMsg && (
          <div
            id={SUBMIT_ERROR_ID}
            role="alert"
            className="mb-4 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-mono"
          >
            {errorMsg}
          </div>
        )}

        {/* The vocabulary failed. Rendered INSTEAD of the picker, never as an
            empty one: "here are no vibes for you" is a statement about the
            user's taste, and the true statement is that a request did not come
            back. */}
        {phase === "failed" && vocabFailure && (
          <div
            role="alert"
            className="mb-6 p-5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-center space-y-3"
          >
            <p className="text-sm font-black uppercase text-white">{vocabFailure.title}</p>
            <p className="text-xs font-mono text-white/60">{vocabFailure.detail}</p>
            <button
              type="button"
              onClick={() => setRequestId((n) => n + 1)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider hover:bg-[#ff753b] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Retry
            </button>
          </div>
        )}

        {/*
          The honest empty state. NOT "Nothing here yet", and not a picker with
          zero options in it: `pages/Feed.tsx:468-478` already refused that
          shape because "showing the empty state here told a recommender's user
          that their taste matched nothing". The same reasoning applies here,
          and it is stronger: the reason the list is empty is that the catalogue
          is too small, not that the user is unfindable.
          `ai_ml/pipelines/recommendation.py:280-293` is the cold-start path —
          top `engagement_velocity`, no user vectors required — so skipping
          genuinely works and this says so truthfully rather than as a
          consolation prize.
        */}
        {phase === "empty" && (
          <div className="mb-6 p-5 rounded-2xl bg-white/[0.03] border border-white/10 space-y-3">
            <h3 className="text-sm font-black uppercase text-white">Not enough audio yet</h3>
            <p className="text-xs font-mono text-white/60 leading-relaxed">
              Personalising here needs tags that already appear on more than one track, and the
              catalogue does not have any yet. That is a fact about how much audio has been
              uploaded — not about you.
            </p>
            <p className="text-xs font-mono text-white/60 leading-relaxed">
              Skipping is a real option, not a dead end: until we know your taste, the feed is
              ranked by what is popular right now.
            </p>
            <button
              type="button"
              onClick={handleSkip}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#FF6321] text-black text-xs font-black uppercase tracking-wider hover:bg-[#ff753b] transition-colors"
            >
              Browse the feed
            </button>
          </div>
        )}

        {phase === "loading" && (
          <div className="mb-6 py-10 flex flex-col items-center gap-3">
            <div
              className="w-8 h-8 border-2 border-[#FF6321] border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
            <p className="text-xs font-mono uppercase text-white/50">Loading tags…</p>
          </div>
        )}

        {/* Tag Grid.
            Named group, and every tag exposes `aria-pressed`. Selected state was
            border + ring + background tint with an unexposed `<Check>` glyph
            inside: colour alone (WCAG 1.4.1), so a screen-reader user could
            neither see nor hear which vibes were armed.

            Rendered from `GET /tags/available/` — never from a list in this
            file. `POST /tags/initialize/` matches with exact JSONB containment
            (`tags @> '["tag"]'`), and the ids that used to be hardcoded here
            were `category` values passed as `tags`: none of the eight could be
            matched by any clip, so all eight were dead on arrival. */}
        {phase === "ready" && (
          <div
            role="group"
            aria-label={TAG_GROUP_NAME}
            className="grid grid-cols-2 gap-2.5 max-h-72 overflow-y-auto pr-1 mb-6"
          >
            {tags.map(({ tag, clips }) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-pressed={isSelected}
                  className={`p-3.5 rounded-xl text-left border transition-all flex items-start justify-between gap-2 ${
                    isSelected
                      ? "bg-white/10 border-[#FF6321] text-white ring-1 ring-[#FF6321] shadow-[0_0_15px_rgba(255,99,33,0.15)]"
                      : "bg-black/50 border-white/10 text-white/60 hover:text-white hover:border-white/20"
                  }`}
                >
                  <div>
                    <div className="font-black uppercase text-xs break-words">{tag}</div>
                    <p className="text-[10px] font-mono text-white/50 mt-1 leading-snug uppercase">
                      {clips} {clips === 1 ? "track" : "tracks"}
                    </p>
                  </div>
                  <div
                    aria-hidden="true"
                    className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected ? "bg-[#FF6321] text-black font-black" : "border border-white/20"
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Action Button */}
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-white/10">
          {/*
            The count changed on every tap and was a bare <span>, so nothing
            said so. A live region that is always mounted (it is inside the
            dialog, which is mounted from first paint) rather than one inserted
            with its text. It also carries the vocabulary's own state, so the
            dialog announces one thing at a time. */}
          <span
            role="status"
            aria-live="polite"
            className="text-[11px] font-mono uppercase text-white/50 flex items-center gap-1.5"
          >
            <Headphones className="w-3.5 h-3.5 text-[#FF6321]" aria-hidden="true" />
            {statusText}
          </span>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSkip}
              className="px-4 py-2 text-xs font-mono uppercase font-bold text-white/50 hover:text-white transition-colors"
            >
              Skip
            </button>
            {/* `aria-disabled`, not `disabled`. A natively disabled button leaves
                the tab order and drops focus to <body> (WCAG 2.4.3) — so a
                keyboard user tabbing onto "Initialize Feed" at zero tags landed
                on nothing, with no explanation of why. It also made the
                `selectedTags.length === 0` guard in `handleInitialize`
                unreachable, so the app had a message for a state it could not
                reach. Now the button stays focusable, the guard is the single
                source of truth, and the reason is announced when it fires.
                This is the same trade-off `ShareModal` and `CommentSheet` made.

                Hidden entirely when there is no vocabulary to submit: with
                nothing loaded there is nothing to initialize, and a permanently
                inert button beside a Retry is worse than no button. */}
            {canInitialize && (
              <button
                type="button"
                aria-disabled={!hasSelection || isSubmitting}
                aria-describedby={errorMsg ? SUBMIT_ERROR_ID : undefined}
                onClick={() => void handleInitialize()}
                className="px-6 py-2.5 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-wider shadow-[0_0_20px_rgba(255,99,33,0.3)] hover:bg-[#ff763a] active:scale-95 transition-all aria-disabled:opacity-40"
              >
                {isSubmitting ? "Synthesizing..." : "Initialize Feed →"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
