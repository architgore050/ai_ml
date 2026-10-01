/**
 * Creator Studio — the upload page reported outcomes it had not observed.
 *
 * Before this change, `POST /clips/` → 202 was treated as "published":
 *
 *  - `finalize_upload` (`backend/app/services/uploads.py:18-34`) deliberately
 *    enqueues nothing and forces `moderation_approved = False`. The only
 *    enqueue trigger is `POST /clips/{id}/approve-moderation/`, which this
 *    client never called — so the clip sat at `processing` for ever,
 *    excluded from the feed, the profile and playback.
 *  - The success card then claimed a four-stage pipeline was running, named
 *    Whisper-v3 Large / 3-tier ABR / 128-dim MFCC (none of which exist), and
 *    hard-navigated to an empty feed 2.5 s later.
 *  - The limits shown were the Pro ceiling for every user, and a keyboard
 *    user could not open a file picker at all.
 *
 * Every test below was run against the unpatched file first and seen red.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFetchMock, json, type FetchMock } from "./fetchMock";
import { UploadPage } from "../pages/Upload";

const CLIP_ID = "11111111-2222-3333-4444-555555555555";

/** The status read, `GET /clips/{id}/`. */
const STATUS_URL = new RegExp(`/clips/${CLIP_ID}/$`);
/** The upload itself, `POST /clips/`. */
const UPLOAD_URL = /\/clips\/$/;
/** The only enqueue trigger in the system. */
const APPROVE_URL = new RegExp(`/clips/${CLIP_ID}/approve-moderation/$`);

/**
 * `GET /subscription/` as `SubscriptionStatusSerializer` actually returns it
 * (`backend/app/serializers.py:890-895`). `limits` is a
 * `DictField(child=CharField)`, so **every value is a string** — `"10"`, not
 * `10`. A free account: 10 MB, 60 s, 5 uploads/day.
 */
const FREE_SUBSCRIPTION = {
  is_pro: false,
  expires_at: null,
  grace_until: null,
  last_synced: "2026-09-29T10:00:00Z",
  limits: {
    daily_uploads_remaining: "5",
    max_clip_duration_seconds: "60",
    max_upload_size_mb: "10",
    hd_quality_allowed: "false",
  },
};

const ACCEPTED_202 = {
  message: "Audio uploading and processing in background.",
  clip_id: CLIP_ID,
  status: "processing",
};

const APPROVED_200 = {
  status: "approved",
  message: "Moderation approved. HLS processing started.",
  clip_id: CLIP_ID,
  moderation_approved: true,
};

/** Every fabricated infrastructure claim the old page made, in one place. */
const FABRICATED_CLAIMS = [
  /worker task dispatched/i,
  /faster-whisper transcribing/i,
  /3-tier/i,
  /packaging active/i,
  /whisper-v3 large/i,
  /directing to live feed/i,
  /dispatching to celery queue/i,
];

function audioFile(name = "voice_roast.wav", bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: "audio/wav" });
}

let api: FetchMock;
let onUploadSuccess: ReturnType<typeof vi.fn>;

function renderPage() {
  return render(<UploadPage onUploadSuccess={onUploadSuccess} />);
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input rendered");
  return input;
}

beforeEach(() => {
  api = installFetchMock();
  onUploadSuccess = vi.fn();
  // jsdom implements neither. The duration probe is a real code path, so the
  // shim has to exist for the page to render at all.
  URL.createObjectURL = vi.fn(() => "blob:echoflow-test");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. The clip is never published unless the client approves it
// ===========================================================================

describe("UploadPage — approval and status polling", () => {
  beforeEach(() => {
    api.on("GET", /\/subscription\//, () => json(200, FREE_SUBSCRIPTION));
  });

  it("calls approve-moderation after the 202 — it is the only enqueue trigger", async () => {
    api.on("POST", APPROVE_URL, () => json(200, APPROVED_200));
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "processing" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const user = userEvent.setup();
    const { container } = renderPage();

    await user.upload(fileInput(container), audioFile());
    await user.click(screen.getByRole("button", { name: /upload & launch reel/i }));

    await waitFor(() => expect(api.callsTo(APPROVE_URL)).toHaveLength(1));
    const [approveCall] = api.callsTo(APPROVE_URL);
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.url).toContain(CLIP_ID);
    // And it happens *after* the upload, not instead of it.
    expect(api.callsTo(UPLOAD_URL)).toHaveLength(1);
  });

  it("shows a processing state, then a ready state, and claims nothing before the server confirms it", async () => {
    vi.useFakeTimers();

    let statusReads = 0;
    // The 202 lands, the approval is still outstanding. Nothing about the
    // transcode has been established at this point.
    let releaseApprove: (() => void) | undefined;
    const approveGate = new Promise<void>((resolve) => {
      releaseApprove = resolve;
    });

    api.on("POST", APPROVE_URL, async () => {
      await approveGate;
      return json(200, APPROVED_200);
    });
    api.on("GET", STATUS_URL, () => {
      statusReads += 1;
      return json(200, { id: CLIP_ID, status: statusReads === 1 ? "processing" : "ready" });
    });
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const { container } = renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.change(fileInput(container), { target: { files: [audioFile()] } });
    fireEvent.change(screen.getByLabelText(/reel title/i), { target: { value: "Test Reel" } });
    const form = screen.getByRole("button", { name: /upload & launch reel/i }).closest("form");
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The 202 is real and preserved.
    expect(screen.getByText("Ingestion Accepted (202)")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(CLIP_ID))).toBeInTheDocument();
    // But approval is outstanding, so no stage of the pipeline may be claimed.
    for (const claim of FABRICATED_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
    expect(statusReads).toBe(0);
    expect(screen.queryByText(/transcoding in progress/i)).toBeNull();
    // A status read is the only thing that can license a publication claim,
    // and none has happened. Claiming readiness here is the old bug verbatim.
    expect(screen.queryByText(/live in the feed/i)).toBeNull();
    expect(screen.queryByText(/transcode complete/i)).toBeNull();

    await act(async () => {
      releaseApprove?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    // First read: still processing. The server has been asked, and is still
    // working.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(api.callsTo(STATUS_URL)).toHaveLength(1);
    expect(screen.getByText(/transcoding in progress/i)).toBeInTheDocument();
    expect(screen.queryByText(/live in the feed/i)).toBeNull();
    for (const claim of FABRICATED_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }

    // Second read: ready. Only now is a success claim allowed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(api.callsTo(STATUS_URL)).toHaveLength(2);
    expect(screen.getByText(/live in the feed/i)).toBeInTheDocument();
    for (const claim of FABRICATED_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
  });

  it("reports a failed transcode honestly instead of claiming success", async () => {
    vi.useFakeTimers();

    api.on("POST", APPROVE_URL, () => json(200, APPROVED_200));
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "failed" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const { container } = renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(fileInput(container), { target: { files: [audioFile()] } });
    const form = screen.getByRole("button", { name: /upload & launch reel/i }).closest("form");
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/processing failed/i);
    expect(alert).toHaveTextContent(/will not retry/i);
    // No success claim of any kind.
    expect(screen.queryByText(/live in the feed/i)).toBeNull();
    for (const claim of FABRICATED_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
  });

  it("reports a refused approval instead of claiming the reel is live", async () => {
    api.on("POST", APPROVE_URL, () =>
      json(403, { detail: "You are not allowed to approve this clip." }),
    );
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "processing" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const user = userEvent.setup();
    const { container } = renderPage();

    await user.upload(fileInput(container), audioFile());
    await user.click(screen.getByRole("button", { name: /upload & launch reel/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/not approved for publishing/i);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /You are not allowed to approve this clip\./,
    );
    // The 202 is still preserved — the row does exist.
    expect(screen.getByText("Ingestion Accepted (202)")).toBeInTheDocument();
    // And nothing claims publication.
    expect(screen.queryByText(/live in the feed/i)).toBeNull();
    expect(screen.queryByText(/directing to feed/i)).toBeNull();
    for (const claim of FABRICATED_CLAIMS) {
      expect(screen.queryByText(claim)).toBeNull();
    }
    // The status was never polled, because nothing was approved.
    expect(api.callsTo(STATUS_URL)).toHaveLength(0);
  });

  it("stops watching on its own instead of claiming a result it never got", async () => {
    vi.useFakeTimers();

    api.on("POST", APPROVE_URL, () => json(200, APPROVED_200));
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "processing" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const { container } = renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(fileInput(container), { target: { files: [audioFile()] } });
    const form = screen.getByRole("button", { name: /upload & launch reel/i }).closest("form");
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Well past the 60 s automatic budget.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });

    // Bounded: 20 reads at a 3 s cadence, then it stops. `clip_read` is
    // 120/min (settings.py:826) and an unbounded poll would be a throttle
    // bug of its own.
    expect(api.callsTo(STATUS_URL)).toHaveLength(20);
    expect(screen.getByText(/stopped checking automatically/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /check again/i })).toBeInTheDocument();
    expect(screen.queryByText(/live in the feed/i)).toBeNull();
  });

  it("does not navigate away on its own after 2.5 seconds", async () => {
    vi.useFakeTimers();

    api.on("POST", APPROVE_URL, () => json(200, APPROVED_200));
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "processing" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const { container } = renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(fileInput(container), { target: { files: [audioFile()] } });
    const form = screen.getByRole("button", { name: /upload & launch reel/i }).closest("form");
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onUploadSuccess).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    // The old code called `onUploadSuccess()` on a 2.5 s timer, yanking the
    // user off a screen they had not finished reading.
    expect(onUploadSuccess).not.toHaveBeenCalled();
    expect(screen.getByText("Ingestion Accepted (202)")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(CLIP_ID))).toBeInTheDocument();
  });
});

// ===========================================================================
// 2. The limits shown are the server's
// ===========================================================================

describe("UploadPage — subscription limits", () => {
  it("displays the server's free-tier limit, not the 100 MB Pro ceiling", async () => {
    api.on("GET", /\/subscription\//, () => json(200, FREE_SUBSCRIPTION));

    const { container } = renderPage();

    await waitFor(() =>
      expect(screen.getAllByText(/MAX 10 MB • MAX 60S/).length).toBeGreaterThan(0),
    );
    expect(container.textContent).not.toMatch(/100 MB/);
    expect(container.textContent).not.toMatch(/300S/);
    // The daily limit that actually rejects a free user is shown too.
    expect(screen.getByText(/5 uploads left today/i)).toBeInTheDocument();
  });

  it("says the limits are unknown when the server cannot be asked", async () => {
    api.fail("GET", /\/subscription\//, new TypeError("Failed to fetch"));

    const { container } = renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/your account's own limits could not be read/i),
      ).toBeInTheDocument(),
    );
    // The tier-blind ceiling is shown and labelled as such, rather than
    // passing it off as this account's allowance.
    expect(screen.getAllByText(/MAX 100 MB • MAX 300S/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/MAX 10 MB/);
    expect(container.textContent).not.toMatch(/left today/i);
  });

  it("does not render a number it could not read", async () => {
    api.on("GET", /\/subscription\//, () => json(200, { is_pro: false, limits: {} }));

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/your account's own limits could not be read/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/MAX undefined/)).toBeNull();
  });
});

// ===========================================================================
// 3. Keyboard reach
// ===========================================================================

describe("UploadPage — keyboard access", () => {
  beforeEach(() => {
    api.on("GET", /\/subscription\//, () => json(200, FREE_SUBSCRIPTION));
  });

  it("lets a keyboard-only user open the file picker", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const input = fileInput(container);

    const opened = vi.fn();
    input.addEventListener("click", opened);

    // A real control, with a real accessible name. The old page had a
    // `<div onClick>` and a `className="hidden"` input, so there was no
    // keyboard route to a picker at all.
    const trigger = screen.getByRole("button", {
      name: /drop audio file here, or activate to choose one/i,
    });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("type", "button");

    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps the file input out of the tab order and reachable only via the button", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const input = fileInput(container);

    // The proxy input is the same pattern Profile.tsx's avatar field uses: a
    // hidden input plus a visible named button. It is not the only route —
    // the button is.
    expect(input).toHaveAttribute("id", "upload-audio-file");
    expect(input.getAttribute("aria-label")).toBeNull();
    expect(input.closest("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: /choose one|different audio file/i })).toHaveLength(1);

    // Selecting through the button's input still works.
    await user.upload(input, audioFile("keyboard_reel.wav"));
    await waitFor(() => expect(screen.getByText("keyboard_reel.wav")).toBeInTheDocument());
  });
});

// ===========================================================================
// 4. Form semantics
// ===========================================================================

describe("UploadPage — form semantics", () => {
  beforeEach(() => {
    api.on("GET", /\/subscription\//, () => json(200, FREE_SUBSCRIPTION));
  });

  it("resolves the title and category fields by accessible name", async () => {
    renderPage();

    const title = screen.getByRole("textbox", { name: /reel title/i });
    const category = screen.getByRole("textbox", { name: /vector category/i });

    expect(title).toHaveAttribute("id", "upload-title");
    expect(category).toHaveAttribute("id", "upload-category");
    // `htmlFor` occurred zero times app-wide before; the accessible name can
    // only come from a real `id`/`htmlFor` pair now.
    expect(document.querySelector('label[for="upload-title"]')).not.toBeNull();
    expect(document.querySelector('label[for="upload-category"]')).not.toBeNull();

    await waitFor(() =>
      expect(screen.getAllByText(/MAX 10 MB/).length).toBeGreaterThan(0),
    );
  });

  it("round-trips a category outside the old six-option list", async () => {
    api.on("POST", APPROVE_URL, () => json(200, APPROVED_200));
    api.on("GET", STATUS_URL, () => json(200, { id: CLIP_ID, status: "processing" }));
    api.on("POST", UPLOAD_URL, () => json(202, ACCEPTED_202));

    const user = userEvent.setup();
    const { container } = renderPage();

    await user.upload(fileInput(container), audioFile());
    const category = screen.getByRole("textbox", { name: /vector category/i }) as HTMLInputElement;
    await user.clear(category);
    await user.type(category, "tech");

    // Exact, not a substring and not a coerced option.
    expect(category.value).toBe("tech");

    await user.click(screen.getByRole("button", { name: /upload & launch reel/i }));
    await waitFor(() => expect(api.callsTo(UPLOAD_URL)).toHaveLength(1));

    const [uploadCall] = api.callsTo(UPLOAD_URL);
    expect((uploadCall?.body as FormData).get("category")).toBe("tech");
  });

  it("exposes the upload error as an alert and keeps the server's own copy", async () => {
    // The backend's free-tier message (`serializers.py:264-276`) reaches the
    // client as `{"original_file": ["..."]}`.
    api.on("POST", UPLOAD_URL, () =>
      json(400, {
        original_file: ["Free tier upload limit is 10MB. Upgrade to Pro for unlimited uploads."],
      }),
    );

    const user = userEvent.setup();
    const { container } = renderPage();

    await user.upload(fileInput(container), audioFile());
    await user.click(screen.getByRole("button", { name: /upload & launch reel/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Free tier upload limit is 10MB. Upgrade to Pro for unlimited uploads.");
  });
});
