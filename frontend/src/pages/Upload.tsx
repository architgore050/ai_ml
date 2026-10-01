import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Upload as UploadIcon,
  Music,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  FileAudio,
  Loader2,
  XCircle,
} from "lucide-react";
import { apiRequest, clipsAPI } from "../api/client";

interface UploadPageProps {
  onUploadSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Server-reported limits
// ---------------------------------------------------------------------------

/**
 * `GET /subscription/` → `SubscriptionStatusSerializer`
 * (`backend/app/serializers.py:890-895`). `limits` is a
 * `DictField(child=CharField)`, so **every value arrives as a string** —
 * `"10"`, `"60"`, `"5"` or `"unlimited"` — never a number. Parsing them as
 * numbers is not a nicety, it is the only correct reading of the payload.
 *
 * The hardcoded ceiling for everyone is `AudioUploadSerializer.MAX_SIZE`
 * (100 MB, `serializers.py:195`) and `MAX_DURATION_SECONDS` (300 s,
 * `serializers.py:338`). Those are tier-blind absolutes, not the limits that
 * will actually reject this user — a free account is capped at
 * `REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE` (10 MB, `serializers.py:271`) and
 * `REVENUECAT_DAILY_UPLOAD_LIMIT_FREE` (5/day, `views/content.py:198`).
 */
interface SubscriptionStatusResponse {
  limits?: Record<string, unknown>;
}

type DailyUploads =
  | { kind: "count"; value: number }
  | { kind: "unlimited" }
  | { kind: "unknown" };

interface UploadLimits {
  maxUploadMb: number;
  maxDurationSec: number;
  dailyUploads: DailyUploads;
}

const SERVER_CEILING_MB = 100;
const SERVER_CEILING_SEC = 300;

function toPositiveInt(value: unknown): number | null {
  const parsed =
    typeof value === "string"
      ? Number(value.trim())
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Returns `null` unless both enforced limits are present and sane. A missing
 * or unparsable limit is **unknown**, not zero and not a guess — showing
 * `NaN` or silently falling back to the Pro ceiling would be the exact lie
 * this replaced.
 */
function normalizeUploadLimits(raw: unknown): UploadLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const limits = raw as Record<string, unknown>;
  const maxUploadMb = toPositiveInt(limits.max_upload_size_mb);
  const maxDurationSec = toPositiveInt(limits.max_clip_duration_seconds);
  if (maxUploadMb === null || maxDurationSec === null) return null;

  const remaining = limits.daily_uploads_remaining;
  const isUnlimited =
    typeof remaining === "string" && remaining.trim().toLowerCase() === "unlimited";
  const remainingCount = isUnlimited ? null : toPositiveInt(remaining);

  return {
    maxUploadMb,
    maxDurationSec,
    dailyUploads: isUnlimited
      ? { kind: "unlimited" }
      : remainingCount === null
        ? { kind: "unknown" }
        : { kind: "count", value: remainingCount },
  };
}

// ---------------------------------------------------------------------------
// Clip API calls that `clipsAPI` does not expose
// ---------------------------------------------------------------------------

// FIX-PLAN (layering): these two belong on `clipsAPI` in `../api/client`, which
// currently has `uploadClip` / `updateClip` / `deleteClip` and no `getClip` or
// `approveModeration`. `apiRequest` is already exported from that module, so
// they are declared here rather than editing a file this change does not own.
// Wave 3 should fold both onto `clipsAPI` and drop these.

/** `POST /clips/{id}/approve-moderation/` — `views/content.py:243-299`. */
async function approveClip(clipId: string): Promise<void> {
  await apiRequest<{ status: string; clip_id: string }>(
    `/clips/${clipId}/approve-moderation/`,
    { method: "POST" },
  );
}

/**
 * `GET /clips/{id}/` → `AudioUploadSerializer` (`serializers.py:236`), which
 * carries `status`. `AudioClip.status` is a free `CharField`
 * (`models.py:170`) and the worker only ever writes `processing`, `ready` or
 * `failed` (`tasks.py:200,225,259,347,378,404,897`).
 */
async function getClip(clipId: string): Promise<{ id: string; status: string }> {
  return apiRequest<{ id: string; status: string }>(`/clips/${clipId}/`);
}

async function getSubscriptionLimits(): Promise<UploadLimits> {
  const res = await apiRequest<SubscriptionStatusResponse>("/subscription/");
  const normalized = normalizeUploadLimits(res?.limits);
  if (!normalized) {
    // Not a silent fallback: the caller renders "limits unknown" rather than
    // the Pro ceiling.
    throw new Error("Subscription response carried no usable limits.");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;

/**
 * 20 attempts × 3 s = 60 s of automatic checking, then the page stops and
 * says so. It does **not** claim the clip failed: a media worker transcode can
 * legitimately run for minutes, and the backend's own sweeper only gives up
 * after three times its 15-minute threshold (`tasks.py:880-900`). Stopping
 * early is an admission of what we know; inventing a failure is not.
 */
const MAX_POLL_ATTEMPTS = 20;

type UploadPhase = "processing" | "ready" | "failed" | "not_approved";

interface UploadOutcome {
  clipId: string;
  /** The server's own 202 message, verbatim. */
  message: string;
  phase: UploadPhase;
  /** Server-supplied reason when the phase is not a success. */
  detail: string | null;
  /** True while the status poll is in flight. */
  watching: boolean;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

interface ApiError {
  status?: number;
  message?: string;
  data?: Record<string, unknown> | null;
}

function asApiError(err: unknown): ApiError {
  return (err ?? {}) as ApiError;
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    return typeof first === "string" ? first : null;
  }
  return typeof value === "string" ? value : null;
}

/**
 * Precedence preserved from the previous implementation: a field-level server
 * message first, then the transport/`detail` message, then a generic fallback.
 * The backend's free-tier copy (`views/content.py:204-207`,
 * `serializers.py:264-276`) arrives as a one-element list, and the old
 * `err.data.original_file[0]` read assumed exactly that shape; this accepts a
 * bare string too so a shape change degrades to the full message instead of
 * its first character.
 */
function describeUploadError(err: unknown): string {
  const error = asApiError(err);
  const data = error.data ?? {};
  return (
    firstString(data.original_file) ||
    firstString(data.title) ||
    error.message ||
    "Upload failed. Please check the file format."
  );
}

function errorFieldOf(err: unknown): "file" | "title" | null {
  const data = asApiError(err).data;
  if (!data || typeof data !== "object") return null;
  if ("original_file" in data) return "file";
  if ("title" in data) return "title";
  return null;
}

function describeApprovalError(err: unknown): string {
  const error = asApiError(err);
  const data = error.data ?? {};
  return (
    firstString(data.reason) ||
    firstString(data.detail) ||
    error.message ||
    "The server refused to approve this clip, so it was not published."
  );
}

// ---------------------------------------------------------------------------

export const UploadPage: React.FC<UploadPageProps> = ({ onUploadSuccess }) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [inFlight, setInFlight] = useState<"uploading" | "approving" | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"file" | "title" | null>(null);
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const [limitsUnknown, setLimitsUnknown] = useState<boolean>(false);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollAttemptsRef = useRef<number>(0);

  // The displayed and enforced limits are the server's. Until (or unless)
  // they arrive, fall back to the tier-blind absolute ceiling — which is
  // genuinely the largest the API accepts from anybody — and say so on screen.
  const maxUploadMb = limits?.maxUploadMb ?? SERVER_CEILING_MB;
  const maxDurationSec = limits?.maxDurationSec ?? SERVER_CEILING_SEC;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getSubscriptionLimits();
        if (cancelled) return;
        setLimits(loaded);
        setLimitsUnknown(false);
      } catch {
        if (cancelled) return;
        setLimits(null);
        setLimitsUnknown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Status poll. Chained `setTimeout`, so a slow request cannot stack up, and
  // a failed read is *not* evidence of failure: the attempt counter below is
  // what terminates the loop.
  useEffect(() => {
    if (!outcome || outcome.phase !== "processing" || !outcome.watching) return;
    const clipId = outcome.clipId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Functional update, so the server's own 202 message — the one real
    // artefact of the 202 — survives every transition below.
    const settle = (next: Partial<UploadOutcome>) => {
      if (cancelled) return;
      setOutcome((current) =>
        current && current.clipId === clipId ? { ...current, ...next } : current,
      );
    };

    const poll = async () => {
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
        settle({ phase: "processing", detail: null, watching: false });
        return;
      }

      let status: string | null = null;
      try {
        status = (await getClip(clipId))?.status ?? null;
      } catch {
        // A transport error or a 429 tells us nothing about the clip. Leave
        // the phase alone and try again until the budget runs out.
        status = null;
      }
      if (cancelled) return;

      if (status === "ready") {
        settle({ phase: "ready", detail: null, watching: false });
        return;
      }
      if (status === "failed") {
        settle({
          phase: "failed",
          detail:
            "The worker stopped on this clip and will not retry it. No playable stream was produced.",
          watching: false,
        });
        return;
      }

      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        settle({ phase: "processing", detail: null, watching: false });
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [outcome?.clipId, outcome?.phase, outcome?.watching]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const applyFile = useCallback(
    (selected: File) => {
      setErrorMessage(null);
      setErrorField(null);

      if (selected.size > maxUploadMb * 1024 * 1024) {
        setErrorMessage(
          limits
            ? `File is ${(selected.size / (1024 * 1024)).toFixed(1)} MB. Your account's limit is ${maxUploadMb} MB.`
            : `File exceeds the ${maxUploadMb} MB server ceiling. Your account's own limit could not be read.`,
        );
        setErrorField("file");
        return;
      }

      // Probing the local file is worth keeping: it turns a 100 MB round trip
      // into an instant message. The threshold is the server-reported limit,
      // not a hardcoded 300 s.
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(selected);
      audio.src = objectUrl;
      audio.onloadedmetadata = () => {
        const measured = Math.round(audio.duration);
        setDurationSec(measured);
        if (measured > maxDurationSec) {
          setErrorMessage(
            limits
              ? `Audio duration (${measured}s) exceeds the ${maxDurationSec}s limit for your account.`
              : `Audio duration (${measured}s) exceeds the ${maxDurationSec}s server ceiling. Your account's own limit could not be read.`,
          );
          setErrorField("file");
        }
        URL.revokeObjectURL(objectUrl);
      };

      setFile(selected);
      setDurationSec(null);
      setTitle((current) => {
        if (current.trim()) return current;
        return selected.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
      });
    },
    [limits, maxDurationSec, maxUploadMb],
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    applyFile(selected);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files && e.dataTransfer.files[0];
    if (dropped) applyFile(dropped);
  };

  /**
   * A locally generated sine tone, offered as a test fixture.
   *
   * Kept, and kept honestly labelled: the consequence is a real `AudioClip`
   * row and a real trip through the transcode worker, so the button says so
   * rather than "For Testing" alone. Gating it behind `import.meta.env.DEV` is
   * a product call (it would remove a visible button from production builds),
   * not a bug fix — raised in the fix report rather than decided here.
   */
  const generateSampleClip = () => {
    const sampleRate = 22050;
    const dur = 15;
    const numSamples = sampleRate * dur;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const freq = 180 + 40 * Math.sin(2 * Math.PI * 0.5 * t);
      const val = Math.sin(2 * Math.PI * freq * t) * 0.4;
      const intVal = Math.max(-32768, Math.min(32767, Math.floor(val * 32767)));
      view.setInt16(44 + i * 2, intVal, true);
    }

    const blob = new Blob([buffer], { type: "audio/wav" });
    applyFile(new File([blob], "echoflow_voice_snippet.wav", { type: "audio/wav" }));
    setTitle("My EchoFlow Voice Roast");
    setCategory("comedy");
  };

  const runApproval = useCallback(async (clipId: string) => {
    setInFlight("approving");
    try {
      await approveClip(clipId);
      pollAttemptsRef.current = 0;
      setOutcome((current) =>
        current && current.clipId === clipId
          ? { ...current, phase: "processing", detail: null, watching: true }
          : current,
      );
    } catch (err) {
      setOutcome((current) =>
        current && current.clipId === clipId
          ? {
              ...current,
              phase: "not_approved",
              detail: describeApprovalError(err),
              watching: false,
            }
          : current,
      );
    } finally {
      setInFlight(null);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // In-flight guard. The button is `aria-disabled` rather than `disabled`
    // (a native `disabled` drops focus to <body> mid-interaction, WCAG 2.4.3),
    // so the guard has to live here instead.
    if (inFlight) return;
    if (!file || !title.trim()) return;

    if (durationSec !== null && durationSec > maxDurationSec) {
      setErrorMessage(
        limits
          ? `Audio duration (${durationSec}s) exceeds the ${maxDurationSec}s limit for your account.`
          : `Audio duration (${durationSec}s) exceeds the ${maxDurationSec}s server ceiling. Your account's own limit could not be read.`,
      );
      setErrorField("file");
      return;
    }

    setInFlight("uploading");
    setErrorMessage(null);
    setErrorField(null);
    setOutcome(null);
    pollAttemptsRef.current = 0;

    const formData = new FormData();
    formData.append("original_file", file);
    formData.append("title", title.trim());
    formData.append("category", category.trim());
    formData.append("copyright_acknowledgement", "true");

    try {
      const res = await clipsAPI.uploadClip(formData);
      // The 202 is real and is kept: the clip row exists. What it does NOT
      // mean is that anything is transcribing. `finalize_upload`
      // (`services/uploads.py:18-34`) deliberately enqueues nothing and forces
      // `moderation_approved = False`, so the pipeline is not running yet.
      setOutcome({
        clipId: res.clip_id,
        message: res.message,
        phase: "processing",
        detail: null,
        watching: false,
      });
      await runApproval(res.clip_id);
    } catch (err) {
      setErrorMessage(describeUploadError(err));
      setErrorField(errorFieldOf(err));
      setInFlight(null);
    }
  };

  const resetForm = () => {
    setOutcome(null);
    setFile(null);
    setTitle("");
    setCategory("");
    setDurationSec(null);
    setErrorMessage(null);
    setErrorField(null);
    pollAttemptsRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resumeWatching = () => {
    pollAttemptsRef.current = 0;
    setOutcome((current) => (current ? { ...current, watching: true } : current));
  };

  const busy = inFlight !== null;
  const submitBlocked = busy || !file || !title.trim();

  const formatHint = `MP3, WAV, OGG, M4A, FLAC • MAX ${maxUploadMb} MB • MAX ${maxDurationSec}S`;
  const dailyHint =
    limits?.dailyUploads.kind === "unlimited"
      ? "Unlimited uploads today"
      : limits?.dailyUploads.kind === "count"
        ? `${limits.dailyUploads.value} upload${limits.dailyUploads.value === 1 ? "" : "s"} left today`
        : null;

  const describedBy =
    errorField === "file" && errorMessage
      ? "upload-audio-hint upload-error"
      : "upload-audio-hint";

  return (
    <div className="w-full max-w-2xl mx-auto px-4 md:px-8 py-6 pb-28 space-y-6">
      <div className="border-b border-white/10 pb-4">
        <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-[#F5F5F5] flex items-center gap-3">
          <UploadIcon className="w-7 h-7 text-[#FF6321]" />
          Creator Studio
        </h1>
        <p className="text-xs font-mono uppercase text-white/40 mt-1">
          Accepted, then held for moderation approval, then transcoded to HLS in the background
        </p>
      </div>

      {outcome ? (
        <div
          role="status"
          aria-live="polite"
          className="p-8 rounded-3xl bg-[#111111] border border-white/15 text-center space-y-4 animate-in zoom-in-95 duration-200"
        >
          <div
            className={`w-16 h-16 rounded-2xl border flex items-center justify-center mx-auto ${
              outcome.phase === "ready"
                ? "bg-[#FF6321]/20 text-[#FF6321] border-[#FF6321]/30"
                : outcome.phase === "processing"
                  ? "bg-white/10 text-white/70 border-white/15"
                  : "bg-rose-500/15 text-rose-300 border-rose-500/30"
            }`}
          >
            {outcome.phase === "ready" ? (
              <CheckCircle2 className="w-8 h-8" />
            ) : outcome.phase === "processing" ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : (
              <XCircle className="w-8 h-8" />
            )}
          </div>

          <div className="space-y-1">
            {/* Still true: the API really did answer 202. */}
            <h2 className="text-xl font-black uppercase tracking-tight text-white">
              Ingestion Accepted (202)
            </h2>
            {outcome.message && <p className="text-xs text-white/60">{outcome.message}</p>}
            <p className="text-[11px] text-[#FF6321] font-mono break-all">
              CLIP_ID: {outcome.clipId}
            </p>
          </div>

          {outcome.phase === "processing" && (
            <p className="text-xs font-mono uppercase text-white/60 leading-relaxed">
              {outcome.watching
                ? "Approved for publishing. Transcoding in progress — this page re-checks the server every few seconds."
                : inFlight === "approving"
                  ? "Approving for publishing…"
                  : "Approval request is with the server."}
            </p>
          )}

          {outcome.phase === "ready" && (
            <p className="text-xs font-mono uppercase text-[#FF6321] font-bold">
              Transcode complete. This reel is live in the feed.
            </p>
          )}

          {(outcome.phase === "failed" || outcome.phase === "not_approved") && (
            <div
              role="alert"
              className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono leading-relaxed"
            >
              <p className="font-bold uppercase">
                {outcome.phase === "not_approved"
                  ? "Not approved for publishing"
                  : "Processing failed"}
              </p>
              {outcome.detail && <p className="mt-1 normal-case">{outcome.detail}</p>}
              <p className="mt-1 normal-case text-rose-300/80">
                The clip was stored, but it is not playable and does not appear in your profile.
              </p>
            </div>
          )}

          {outcome.phase === "processing" && !outcome.watching && !busy && (
            <p className="text-[11px] font-mono uppercase text-white/50">
              This page stopped checking automatically. The server has not reported a result yet.
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            {outcome.phase === "not_approved" && (
              <button
                type="button"
                aria-disabled={busy || undefined}
                onClick={(e) => {
                  if (busy) {
                    e.preventDefault();
                    return;
                  }
                  void runApproval(outcome.clipId);
                }}
                className={`px-5 py-3 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-widest ${
                  busy ? "opacity-40 cursor-not-allowed" : ""
                }`}
              >
                {busy ? "Retrying…" : "Try approving again"}
              </button>
            )}
            {outcome.phase === "processing" && !outcome.watching && !busy && (
              <button
                type="button"
                onClick={resumeWatching}
                className="px-5 py-3 rounded-xl bg-white/5 border border-white/15 text-white font-black text-xs uppercase tracking-widest hover:bg-white/10"
              >
                Check again
              </button>
            )}
            {outcome.phase === "ready" && (
              <button
                type="button"
                onClick={onUploadSuccess}
                className="px-5 py-3 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-widest"
              >
                Go to the feed
              </button>
            )}
            <button
              type="button"
              onClick={resetForm}
              className="px-5 py-3 rounded-xl bg-white/5 border border-white/15 text-white font-black text-xs uppercase tracking-widest hover:bg-white/10"
            >
              Upload another
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          {errorMessage && (
            <div
              id="upload-error"
              role="alert"
              className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/*
            Drag-and-drop is an enhancement over a real control, never the
            route. The previous version put `onClick` on this div and left the
            `<input>` at `className="hidden"` (display:none → out of the
            accessibility tree, unfocusable), so there was no keyboard route to
            a file picker at all. Same shape as the one correct instance in the
            app: `Profile.tsx`'s avatar field — a hidden input proxied by a
            visible, named `<button>`.
          */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className={`relative rounded-2xl border-2 border-dashed transition-all ${
              file
                ? "bg-[#FF6321]/5 border-[#FF6321]"
                : "bg-[#111111] hover:bg-[#161616] border-white/15 hover:border-white/30"
            }`}
          >
            <input
              ref={fileInputRef}
              id="upload-audio-file"
              type="file"
              accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,.webm,.opus,audio/*"
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={openFilePicker}
              aria-describedby={describedBy}
              className="w-full p-8 rounded-2xl flex flex-col items-center justify-center text-center space-y-3 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#FF6321] focus-visible:outline-offset-2"
            >
              <span className="w-14 h-14 rounded-xl bg-white/10 flex items-center justify-center text-[#FF6321]">
                {file ? <FileAudio className="w-7 h-7 text-[#FF6321]" /> : <Music className="w-7 h-7" />}
              </span>

              {file ? (
                <span>
                  <span className="block text-sm font-black uppercase tracking-tight text-white">
                    {file.name}
                  </span>
                  <span className="block text-xs font-mono uppercase text-white/40 mt-1">
                    {(file.size / (1024 * 1024)).toFixed(2)} MB{" "}
                    {durationSec !== null ? `• ${durationSec}S DURATION` : ""}
                  </span>
                  <span className="block text-[10px] font-mono uppercase text-[#FF6321] font-bold mt-2 underline">
                    Activate to choose a different audio file
                  </span>
                </span>
              ) : (
                <span>
                  <span className="block text-sm font-black uppercase tracking-tight text-white">
                    Drop Audio File Here, Or Activate To Choose One
                  </span>
                  <span className="block text-xs font-mono uppercase text-white/40 mt-1">
                    {formatHint}
                  </span>
                </span>
              )}
            </button>
          </div>

          <p id="upload-audio-hint" className="text-[10px] font-mono uppercase text-white/50">
            {dailyHint ? `${formatHint} • ${dailyHint}` : formatHint}
            {limitsUnknown && " • Your account's own limits could not be read; the server will enforce them"}
          </p>

          {!file && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={generateSampleClip}
                className="text-xs font-mono uppercase font-bold text-[#FF6321] hover:text-[#ff783d] flex items-center gap-1.5 p-2 rounded hover:bg-white/5 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>
                  Synthesize 15s Demo Voice Clip For Testing — it is a real upload and will be
                  transcoded
                </span>
              </button>
            </div>
          )}

          <div>
            <label
              htmlFor="upload-title"
              className="text-xs font-black uppercase tracking-wider text-white/60 block mb-1.5 font-mono"
            >
              Reel Title
            </label>
            <input
              id="upload-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., THE FUTURE OF QUIET COMPUTING"
              maxLength={255}
              required
              aria-invalid={errorField === "title" || undefined}
              aria-describedby={errorField === "title" && errorMessage ? "upload-error" : undefined}
              className="w-full bg-[#111111] border border-white/15 rounded-xl px-4 py-3 text-sm font-bold text-white placeholder-white/20 focus:border-[#FF6321] focus-visible:outline-2 focus-visible:outline-[#FF6321] focus-visible:outline-offset-2 transition-colors"
            />
          </div>

          {/*
            Free text, not a six-option list. `AudioClip.category` is a
            free-form `CharField(max_length=50, blank=True)`
            (`models.py:112`), and the app offered four different closed
            vocabularies for it across four screens — a clip tagged `tech`
            could not be represented here at all.
          */}
          <div>
            <label
              htmlFor="upload-category"
              className="text-xs font-black uppercase tracking-wider text-white/60 block mb-1.5 font-mono"
            >
              Vector Category
            </label>
            <input
              id="upload-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Free text — e.g. comedy, tech, focus"
              maxLength={50}
              className="w-full bg-[#111111] border border-white/15 rounded-xl px-4 py-3 text-sm font-bold text-white placeholder-white/20 focus:border-[#FF6321] focus-visible:outline-2 focus-visible:outline-[#FF6321] focus-visible:outline-offset-2 transition-colors"
            />
          </div>

          {/*
            Rewritten, not deleted. Every element is checkable:
              - `WhisperModel("base", device="cpu", compute_type="int8")` — tasks.py:44
              - 128-dim = mfcc(40) + chroma(12) + mel(76)          — tasks.py:104-113
              - single-variant AAC 128 k HLS, no `var_stream_map`   — tasks.py:360-367
            The previous text claimed "3-tier ABR", "Whisper-v3 Large" and
            "128-dim MFCC", and contradicted its own success screen, which said
            "chroma". `HLS_BUCKETS` is a Prometheus histogram of seconds
            (`metrics.py:132`), not a bitrate ladder.
          */}
          <div className="p-4 rounded-xl bg-[#111111] border border-white/10 text-[10px] font-mono uppercase text-white/40 leading-relaxed">
            <span className="font-bold text-[#FF6321]">PIPELINE SPEC: </span>
            After approval — faster-whisper &quot;base&quot; (CPU, int8) transcription • librosa
            128-dim acoustic vector (MFCC 40 + chroma 12 + mel 76) • FFmpeg HLS, single AAC 128
            kbps variant.
          </div>

          {/*
            `aria-disabled` + a guard in `handleSubmit`, not `disabled`:
            disabling a focused button removes it from the tab order and drops
            focus to <body> (WCAG 2.4.3).
          */}
          <button
            type="submit"
            aria-disabled={submitBlocked || undefined}
            onClick={(e) => {
              if (submitBlocked) e.preventDefault();
            }}
            className={`w-full py-4 rounded-xl bg-[#FF6321] text-black font-black text-sm uppercase tracking-widest shadow-[0_0_25px_rgba(255,99,33,0.3)] hover:bg-[#ff753b] active:scale-[0.99] transition-all focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 ${
              submitBlocked ? "opacity-40 cursor-not-allowed" : ""
            }`}
          >
            {inFlight === "uploading"
              ? "Uploading file — a browser cannot report upload progress"
              : "Upload & Launch Reel"}
          </button>
        </form>
      )}
    </div>
  );
};
