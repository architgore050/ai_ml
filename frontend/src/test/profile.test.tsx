import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFetchMock, type FetchMock, type MockResponseSpec } from "./fetchMock";
import { ProfilePage } from "../pages/Profile";
import type { FeedClip, OwnProfile, PublicProfile } from "../types/echoflow";

/**
 * The profile page reported failures as facts.
 *
 * `loadProfileData` caught everything into `console.warn` and fell through to
 * render, with `|| 0` on all three counters and `date_joined || Date.now()` on
 * the join date. So a 500, a 401 or a dropped connection produced a
 * fully-formed profile reading 0 / 0 / 0, the claim "No audio reels published
 * to network.", and today's date as the account creation date — with no error
 * affordance anywhere on the page.
 *
 * The same file also badged every profile CREATOR (there is no creator tier
 * anywhere in the backend), counted uploads by the length of one 10-item page
 * while the real `uploads_count` sat 30px above it, offered a six-option
 * `<select>` for a field the backend stores free-form, and rendered the raw
 * storage key instead of the signed URL the serializer supplies.
 *
 * Every test below was run against the unpatched file first and seen red.
 */

const OWN_USER_ID = 7;
const OTHER_USER_ID = 9;

const OWN_USER = { id: OWN_USER_ID, username: "waveform" };

/**
 * The pre-fix page read the profile document out of the auth store, so the
 * mock hands it one. Without this the old code had nothing to render and the
 * tests below would have gone red on an empty page rather than on the lie.
 * The fixed page fetches its own copy and never reads this.
 */
let authProfile: OwnProfile | null = null;

vi.mock("../stores/auth", () => ({
  useAuth: () => ({
    user: OWN_USER,
    profile: authProfile,
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    refreshProfile: async () => {},
  }),
}));

vi.mock("../stores/player", () => ({
  usePlayer: () => ({
    currentClip: null,
    isPlaying: false,
    playClip: vi.fn(),
    togglePlay: vi.fn(),
  }),
}));

// The raw storage key and the signed URL the serializer actually sends
// (`get_profile_picture_url`). `email` is deliberately absent: it is not in
// `OwnProfileSerializer.Meta.fields`, so a faithful fixture must not carry one.
const SIGNED_AVATAR_URL =
  "https://media.example/profile_pictures/7/avatar.png?X-Amz-Signature=signed";

const OWN_PROFILE: OwnProfile = {
  id: OWN_USER_ID,
  username: "waveform",
  profile_picture: "profile_pictures/7/avatar.png",
  profile_picture_url: SIGNED_AVATAR_URL,
  followers_count: 412,
  following_count: 38,
  uploads_count: 42,
  liked_clips: [],
  is_following: false,
  date_joined: "2024-03-01T10:00:00Z",
} as unknown as OwnProfile;

const PUBLIC_PROFILE: PublicProfile = {
  id: OTHER_USER_ID,
  username: "alex",
  profile_picture: "profile_pictures/9/avatar.png",
  followers_count: 12,
  following_count: 4,
  uploads_count: 3,
  date_joined: "2023-07-19T08:00:00Z",
} as unknown as PublicProfile;

function makeClip(overrides: Partial<FeedClip> = {}): FeedClip {
  return {
    id: "clip-1",
    title: "Original title",
    creator_name: "waveform",
    creator_id: OWN_USER_ID,
    category: "music",
    hls_playlist_url: "https://media.example/hls/clip-1/master.m3u8",
    likes: 3,
    shares: 1,
    skips: 0,
    comment_count: 2,
    is_liked: false,
    is_following: false,
    duration_ms: 4000,
    tags: ["acoustic"],
    cover_image: null,
    ...overrides,
  };
}

function clipsPage(count: number, overrides: Partial<FeedClip> = {}): MockResponseSpec {
  return {
    status: 200,
    body: {
      next: null,
      previous: null,
      results: Array.from({ length: count }, (_, i) =>
        makeClip({ id: `clip-${i + 1}`, title: `Reel ${i + 1}`, ...overrides })
      ),
    },
  };
}

/** Wire the two requests an own-profile load makes, in matching order. */
function serveOwnProfile(
  api: FetchMock,
  profile: Partial<OwnProfile> = {},
  clipResponse: MockResponseSpec = clipsPage(0)
) {
  api.on("GET", /\/profile\/me\//, () => ({ status: 200, body: { ...OWN_PROFILE, ...profile } }));
  api.on("GET", /\/profile\/\d+\/clips\//, () => clipResponse);
}

let api: FetchMock;

/** A response the test releases by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  api = installFetchMock();
  authProfile = { ...OWN_PROFILE };
});

/**
 * Opened by `title` rather than by accessible name so the dialog tests fail on
 * dialog semantics and not on the trigger's naming; the naming of the
 * icon-only triggers is asserted separately, below.
 */
async function openEditReelDialog(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByTitle("Edit Details");
  await user.click(trigger);
  return trigger;
}

async function openEditProfileDialog(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByTitle("Edit Profile");
  await user.click(trigger);
  return trigger;
}

describe("Profile — a failed fetch is never rendered as a fact", () => {
  it("shows an error with a working retry when GET /profile/me/ 500s", async () => {
    api.on("GET", /\/profile\/me\//, () => ({ status: 500, body: { detail: "boom" } }));
    api.on("GET", /\/profile\/\d+\/clips\//, () => clipsPage(0));
    const user = userEvent.setup();

    render(<ProfilePage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn.t load this profile/i);

    // Nothing was read from the server, so nothing is claimed about the user.
    expect(screen.queryByText("Followers")).not.toBeInTheDocument();
    expect(screen.queryByText("Following")).not.toBeInTheDocument();
    expect(screen.queryByText("Audio Reels")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No audio reels published to network.")
    ).not.toBeInTheDocument();
    // The most damaging line of the old page: today as the join date.
    expect(screen.queryByText(new Date().toLocaleDateString())).not.toBeInTheDocument();
    expect(screen.queryByText(/^Joined:/)).not.toBeInTheDocument();

    // The retry affordance is real, not decorative.
    await user.click(within(alert).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(api.callsTo(/\/profile\/me\//)).toHaveLength(2));
  });

  it("shows the same error, and no zeros, when the network throws", async () => {
    api.fail("GET", /\/profile\//, new TypeError("Failed to fetch"));

    render(<ProfilePage />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn.t load this profile/i);
    expect(alert).toHaveTextContent(/failed to fetch/i);
    expect(screen.queryByText("Followers")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText(new Date().toLocaleDateString())).not.toBeInTheDocument();
  });

  it("does not fabricate a join date for a third party's public profile", async () => {
    api.on("GET", /\/profile\/9\//, () => ({ status: 500, body: { detail: "boom" } }));
    api.on("GET", /\/profile\/\d+\/clips\//, () => clipsPage(0));

    render(<ProfilePage targetUserId={OTHER_USER_ID} />);

    await screen.findByRole("alert");
    expect(screen.queryByText("Followers")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText(new Date().toLocaleDateString())).not.toBeInTheDocument();
  });

  it("shows a skeleton, not plausible zeros, while loading", async () => {
    const inFlight = deferred<MockResponseSpec>();
    api.on("GET", /\/profile\/me\//, () => inFlight.promise);
    api.on("GET", /\/profile\/\d+\/clips\//, () => clipsPage(0));

    render(<ProfilePage />);

    // Wait until the request is genuinely in flight, so the assertions below
    // describe a page that is still loading.
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(screen.getByText(/loading profile/i)).toBeInTheDocument();
    // The labels are there; the numbers are not, because they have not arrived.
    expect(screen.getByText("Followers")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("412")).not.toBeInTheDocument();
    expect(screen.queryByText(new Date().toLocaleDateString())).not.toBeInTheDocument();

    // And it recovers into the real figures.
    inFlight.resolve({ status: 200, body: OWN_PROFILE });
    await waitFor(() => expect(screen.getByText("412")).toBeInTheDocument());
    expect(screen.queryByText(/loading profile/i)).not.toBeInTheDocument();
  });

  it("renders an em dash for a date the server did not send", async () => {
    serveOwnProfile(api, { date_joined: undefined });

    render(<ProfilePage />);

    await waitFor(() => expect(screen.getByText(/^Joined:/)).toBeInTheDocument());
    expect(screen.getByText(/^Joined:/)).toHaveTextContent("—");
    expect(screen.queryByText(new Date().toLocaleDateString())).not.toBeInTheDocument();
  });
});

describe("Profile — counts come from the server, not from the page", () => {
  it("badges nobody CREATOR, not even an account with zero uploads", async () => {
    serveOwnProfile(
      api,
      { uploads_count: 0, followers_count: 0, following_count: 0, liked_clips: [] },
      clipsPage(0)
    );

    render(<ProfilePage />);

    await waitFor(() => expect(screen.getByText("Audio Reels")).toBeInTheDocument());
    expect(screen.queryByText(/CREATOR/i)).not.toBeInTheDocument();
    // A genuine zero is still shown as a zero: the fix is not "hide all zeros".
    expect(screen.getAllByText("0")).toHaveLength(3);
  });

  it("labels the uploads tab with the real total, not the 10-item page length", async () => {
    serveOwnProfile(api, { uploads_count: 42 }, clipsPage(10));

    render(<ProfilePage />);

    const tab = await screen.findByRole("button", { name: /my uploads \(42\)/i });
    expect(tab).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /my uploads \(10\)/i })).not.toBeInTheDocument();
    // ...and it agrees with the stat above it rather than contradicting it.
    expect(screen.getByText("Audio Reels")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("does not claim a total for liked reels it cannot know", async () => {
    const fiftyMostRecent = Array.from({ length: 50 }, (_, i) => makeClip({ id: `liked-${i}` }));
    serveOwnProfile(api, { liked_clips: fiftyMostRecent }, clipsPage(0));
    const user = userEvent.setup();

    render(<ProfilePage />);

    // 50 is a page size, not a like count. Saying "50" would tell a user with
    // 500 likes that they have 50.
    expect(
      await screen.findByRole("button", { name: /liked reels \(50 most recent\)/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /liked reels \(50\)\s*$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /liked reels/i }));
    expect(screen.getAllByRole("button", { name: /^play /i })).toHaveLength(50);
  });
});

describe("Profile — avatar uses the signed URL, not the storage key", () => {
  it("renders the signed profile_picture_url", async () => {
    serveOwnProfile(api);

    const { container } = render(<ProfilePage />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(SIGNED_AVATAR_URL);
    expect(img?.getAttribute("src")).not.toBe(OWN_PROFILE.profile_picture);
  });
});

describe("Profile — mutation failures are announced", () => {
  it("keeps the edit dialog open and announces a failed clip edit", async () => {
    serveOwnProfile(api, {}, clipsPage(1));
    api.on("PATCH", /\/clips\//, () => ({ status: 500, body: { detail: "write failed" } }));
    const user = userEvent.setup();

    render(<ProfilePage />);

    await openEditReelDialog(user);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/write failed/i);
    // The rollback that already worked, kept: the edit is not applied and the
    // dialog is not dismissed, so the user's unsaved text is still on screen.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue("Reel 1");
  });

  it("announces a failed clip delete and keeps the reel listed", async () => {
    serveOwnProfile(api, {}, clipsPage(1));
    api.on("DELETE", /\/clips\//, () => ({ status: 500, body: { detail: "delete refused" } }));
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ProfilePage />);

    await user.click(await screen.findByRole("button", { name: /delete reel/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/delete refused/i);
    expect(screen.getByText("Reel 1")).toBeInTheDocument();
  });
});

describe("Profile — the free-form category round-trips", () => {
  it("represents a category the old six-option select had no slot for", async () => {
    serveOwnProfile(api, {}, clipsPage(1, { category: "tech" }));
    api.on("PATCH", /\/clips\//, () => ({ status: 200, body: makeClip({ category: "tech" }) }));
    const user = userEvent.setup();

    render(<ProfilePage />);

    await openEditReelDialog(user);

    // `AudioClip.category` is a free-form CharField. The old <select> had no
    // `tech` option, so the field rendered blank and touching it rewrote the
    // stored value to one of six invented ones.
    const field = screen.getByRole("textbox", { name: /category/i });
    expect(field).toHaveValue("tech");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const patches = api.calls.filter((c) => c.method === "PATCH");
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toEqual({ title: "Reel 1", category: "tech" });
  });
});

describe("Profile — the two dialogs behave like dialogs", () => {
  it("exposes the edit-profile modal as a dialog and closes it on Escape", async () => {
    serveOwnProfile(api);
    const user = userEvent.setup();

    render(<ProfilePage />);

    const trigger = await openEditProfileDialog(user);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent(
      /edit profile details/i
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("moves focus into the dialog on open, traps Tab, and names the close button", async () => {
    serveOwnProfile(api);
    const user = userEvent.setup();

    render(<ProfilePage />);

    await openEditProfileDialog(user);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());

    expect(screen.getByRole("button", { name: /close edit profile dialog/i })).toBeInTheDocument();

    // Tab cycles inside the dialog rather than walking into the page behind it.
    const insideDialog = () => {
      const dialog = screen.getByRole("dialog");
      return dialog.contains(document.activeElement);
    };
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(insideDialog()).toBe(true);
    }
  });

  it("marks the page behind an open dialog inert, and not the dialog", async () => {
    serveOwnProfile(api);
    const user = userEvent.setup();

    const { container } = render(<ProfilePage />);

    expect(container.querySelector("[inert]")).toBeNull();
    await openEditProfileDialog(user);
    const inert = container.querySelector("[inert]");
    expect(inert).not.toBeNull();
    // The backdrop covers the page but does nothing to it: the page is still
    // tabbable and still exposed to assistive tech behind an open dialog.
    expect(inert?.contains(screen.getByRole("dialog"))).toBe(false);
  });

  it("names the edit-reel close button and restores focus to its trigger", async () => {
    serveOwnProfile(api, {}, clipsPage(1));
    const user = userEvent.setup();

    render(<ProfilePage />);

    const trigger = await openEditReelDialog(user);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    await user.click(screen.getByRole("button", { name: /close edit reel dialog/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("Profile — form fields and headings", () => {
  it("resolves every field by accessible name", async () => {
    serveOwnProfile(api, {}, clipsPage(1, { category: "tech" }));
    const user = userEvent.setup();

    render(<ProfilePage />);

    // Edit profile dialog: username and avatar.
    await openEditProfileDialog(user);
    expect(screen.getByRole("textbox", { name: "Username" })).toHaveValue("waveform");
    // The avatar is a file input, which has no textbox role; the label is what
    // names it, and the visible button proxies the hidden input.
    expect(screen.getByLabelText("Avatar Image")).toHaveAttribute("type", "file");
    expect(screen.getByRole("button", { name: /select image asset/i })).toBeInTheDocument();
    // There is no email field to name: the old page rendered `profile.email`,
    // which OwnProfileSerializer does not send, so the line could never appear.
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();

    await user.keyboard("{Escape}");

    // Edit reel dialog: title and category.
    await openEditReelDialog(user);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Reel 1");
    expect(screen.getByRole("textbox", { name: "Category" })).toHaveValue("tech");
  });

  it("names the icon-only controls", async () => {
    serveOwnProfile(api, {}, clipsPage(1));
    const user = userEvent.setup();

    render(<ProfilePage />);

    // Every one of these was icon-only with no text. A `title` is a fallback,
    // not a name, and is not exposed on touch at all.
    expect(await screen.findByRole("button", { name: "Edit profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit reel details/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete reel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^play reel 1$/i })).toBeInTheDocument();
  });

  it("associates a profile-save failure with the field that caused it", async () => {
    serveOwnProfile(api);
    api.on("PATCH", /\/profile\/me\/update\//, () => ({
      status: 400,
      body: { username: ["That username is already taken."] },
    }));
    const user = userEvent.setup();

    render(<ProfilePage />);

    await openEditProfileDialog(user);
    const field = screen.getByRole("textbox", { name: "Username" });
    expect(field).not.toHaveAttribute("aria-invalid");

    await user.clear(field);
    await user.type(field, "taken");
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already taken/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("uses a heading hierarchy with no skipped level", async () => {
    serveOwnProfile(api, {}, clipsPage(2));

    render(<ProfilePage />);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("@waveform");
    // The page used to start at <h2> and then jump to <h4>.
    expect(screen.queryByRole("heading", { level: 4 })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Reel 1",
      "Reel 2",
    ]);
  });
});

describe("Profile — real data and reachable controls are preserved", () => {
  it("keeps per-clip engagement, with the emoji hidden from assistive tech", async () => {
    serveOwnProfile(api, {}, clipsPage(1));
    const { container } = render(<ProfilePage />);

    await waitFor(() => expect(screen.getByText(/likes/)).toBeInTheDocument());
    const engagement = screen.getByText(/likes/);
    expect(engagement).toHaveTextContent("3 likes");
    expect(engagement).toHaveTextContent("2 comments");
    expect(engagement).toHaveTextContent("1 shares");
    // The emoji still render, but carry no meaning for a screen reader.
    expect(container.querySelectorAll("span[aria-hidden='true']").length).toBeGreaterThan(0);
    expect(engagement.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });

  it("makes liked reels reachable as buttons", async () => {
    serveOwnProfile(api, { liked_clips: [makeClip({ id: "liked-1", title: "Liked one" })] }, clipsPage(0));
    const user = userEvent.setup();

    render(<ProfilePage />);

    await user.click(await screen.findByRole("button", { name: /liked reels/i }));

    const rows = screen.getAllByRole("button", { name: /^play liked one$/i });
    expect(rows).toHaveLength(1);
    // `getByRole` throws on a second match, so this is the "exactly one row"
    // assertion with the type narrowing `noUncheckedIndexedAccess` needs.
    await user.click(screen.getByRole("button", { name: /^play liked one$/i }));
    expect(rows[0]).toBeInTheDocument();
  });
});
