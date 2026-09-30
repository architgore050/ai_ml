import React, { useEffect, useRef, useState } from "react";
import { Sparkles, Check, Headphones } from "lucide-react";
import { feedAPI } from "../../api/client";

interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInitialized: () => void;
}

const DIALOG_TITLE_ID = "onboarding-modal-title";
const TAG_GROUP_NAME = "Vibes to seed your feed";
const SUBMIT_ERROR_ID = "onboarding-submit-error";

/**
 * The eight vibes below are a hardcoded client-side list, and that is a real
 * defect rather than a style choice — but it is NOT fixed here, because the fix
 * is a product decision about where the vocabulary comes from, and inventing a
 * canonical list here would be inventing policy.
 *
 * What the pipeline actually writes: `tasks.py:292-296` sets
 * `clip.tags = [kw[0] for kw in keywords]` — the top 3 KeyBERT unigrams from the
 * Whisper transcript, e.g. `["quantum", "energy", "orbit"]` — or the literal
 * `["instrumental"]` for a clip with no speech. `POST /tags/initialize/` then
 * matches with `tags__contains=[tag]` (`views/feed.py:358-360`), an exact
 * JSONB containment per tag.
 *
 * So: of the eight ids offered here, exactly one (`instrumental`) is a value
 * the backend can ever have written. `comedy`, `science`, `motivation`,
 * `music`, `quotes`, `tech` and `mindset` match nothing — a single-word KeyBERT
 * extraction from an audio clip is not going to produce the word "comedy" often
 * enough to be a cold-start signal, and never by design.
 *
 * The default selection is `["comedy", "science"]`. Neither can match, so the
 * modal opens pre-armed with a selection that resolves to
 * `400 {"error": "Not enough data to build baseline."}` unless the user
 * deselects both and happens to pick `instrumental` or a tag that some clip
 * genuinely carries.
 *
 * RECON-03 §3 lists the backend-fed vocabulary as the right answer. That needs
 * an endpoint (the most-derived tags across approved, encoded clips) and a
 * decision about what to do when a user's account has no clips yet — which is
 * every account, at the moment this modal is shown. Tracked in
 * `docs/frontend/FIX-PLAN.md`; not silently patched with a guess.
 */
const AVAILABLE_TAGS = [
  { id: "comedy", label: "Comedy & Roasts", emoji: "🎙️", desc: "Tech roasts & standup" },
  { id: "science", label: "Science Bites", emoji: "🔬", desc: "Quantum, space & biology" },
  { id: "motivation", label: "Daily Motivation", emoji: "⚡", desc: "Stoicism & discipline" },
  { id: "music", label: "Beat Snippets", emoji: "🎧", desc: "Lo-fi, vinyl & synth loops" },
  { id: "instrumental", label: "Focus Waves", emoji: "🌊", desc: "Binaural & ambient drones" },
  { id: "quotes", label: "Deep Quotes", emoji: "📜", desc: "Philosophers & thinkers" },
  { id: "tech", label: "Coding & Startups", emoji: "💻", desc: "Architecture & dev humor" },
  { id: "mindset", label: "Psychology & Flow", emoji: "🧠", desc: "Cognition & habits" },
];

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
  const [selectedTags, setSelectedTags] = useState<string[]>(["comedy", "science"]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  const toggleTag = (id: string) => {
    setSelectedTags((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
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

  const hasSelection = selectedTags.length > 0;

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
            <p className="text-[10px] font-mono uppercase text-white/50">
              Initialize 384-dimensional cosine preference weights
            </p>
          </div>
        </div>

        <p className="text-xs font-mono uppercase text-white/60 mb-4 leading-relaxed">
          EchoFlow learns what you love through continuous listening. Select your favorite audio vibes to seed your recommendation index:
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

        {/* Tag Grid.
            Named group, and every tag exposes `aria-pressed`. Selected state was
            border + ring + background tint with an unexposed `<Check>` glyph
            inside: colour alone (WCAG 1.4.1), so a screen-reader user could
            neither see nor hear which vibes were armed. */}
        <div
          role="group"
          aria-label={TAG_GROUP_NAME}
          className="grid grid-cols-2 gap-2.5 max-h-72 overflow-y-auto pr-1 mb-6"
        >
          {AVAILABLE_TAGS.map((tag) => {
            const isSelected = selectedTags.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggleTag(tag.id)}
                aria-pressed={isSelected}
                className={`p-3.5 rounded-xl text-left border transition-all flex items-start justify-between gap-2 ${
                  isSelected
                    ? "bg-white/10 border-[#FF6321] text-white ring-1 ring-[#FF6321] shadow-[0_0_15px_rgba(255,99,33,0.15)]"
                    : "bg-black/50 border-white/10 text-white/60 hover:text-white hover:border-white/20"
                }`}
              >
                <div>
                  <div className="flex items-center gap-1.5 font-black uppercase text-xs">
                    {/* Decorative: the label beside it carries the meaning, and
                        an announced emoji is noise in a toggle's name. */}
                    <span aria-hidden="true">{tag.emoji}</span>
                    <span>{tag.label}</span>
                  </div>
                  <p className="text-[10px] font-mono text-white/50 mt-1 leading-snug uppercase">
                    {tag.desc}
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

        {/* Action Button */}
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-white/10">
          {/* The count changed on every tap and was a bare <span>, so nothing
              said so. A live region that is always mounted (it is inside the
              dialog, which is mounted from first paint) rather than one inserted
              with its text. */}
          <span
            role="status"
            aria-live="polite"
            className="text-[11px] font-mono uppercase text-white/50 flex items-center gap-1.5"
          >
            <Headphones className="w-3.5 h-3.5 text-[#FF6321]" aria-hidden="true" />
            {selectedTags.length} Vibes Armed
          </span>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
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
                This is the same trade-off `ShareModal` and `CommentSheet` made. */}
            <button
              type="button"
              aria-disabled={!hasSelection || isSubmitting}
              aria-describedby={errorMsg ? SUBMIT_ERROR_ID : undefined}
              onClick={() => void handleInitialize()}
              className="px-6 py-2.5 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-wider shadow-[0_0_20px_rgba(255,99,33,0.3)] hover:bg-[#ff763a] active:scale-95 transition-all aria-disabled:opacity-40"
            >
              {isSubmitting ? "Synthesizing..." : "Initialize Feed →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
