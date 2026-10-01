import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider } from "../stores/auth";
import { LoginPage } from "../pages/Login";
import { installFetchMock, json, type FetchMock, type MockResponseSpec } from "./fetchMock";

/**
 * `LoginPage` — the app's front door, and the least accessible screen in the
 * codebase.
 *
 * `RECON-06` lists it as a **core-loop blocker**: §2 "Prerequisite — sign in:
 * FAILS", because `htmlFor` occurred **zero times in the whole app**. The five
 * visible `<label>`s labelled nothing and no `<input>` had an `id`, so every
 * accessible name fell back to the `placeholder` — "e.g. soundwave" — a string
 * that vanishes on focus (WCAG 3.3.2) and renders at 1.77:1. The auth failure
 * was a bare `<div>` with no `role="alert"` (finding #35), so the app's
 * primary error surface was silent; no field carried `autoComplete` (#33); the
 * password toggle was a 16×16 unnamed control with no `aria-pressed` (#10,
 * #24); five fields suppressed their own focus ring (#15); and the submit
 * button used native `disabled`, which drops focus to `<body>` mid-interaction
 * (#22).
 *
 * The behaviours pinned here that were *already* correct and must not regress:
 * the login/register mode toggle, the DPDP §9 age gate (`dob` required,
 * `parent_email` required under 18), and honest surfacing of the server's own
 * field-level message at the old `Login.tsx:79-81`.
 */

const TOKENS = { access: "access-token", refresh: "refresh-token" };

const PROFILE = {
  id: 7,
  username: "soundwave",
  email: "soundwave@echoflow.fm",
  profile_picture: null,
  followers_count: 0,
  following_count: 0,
  uploads_count: 0,
  liked_clips: [],
  date_joined: "2026-01-01T00:00:00Z",
};

/** A date that is under 18 whatever day the suite runs on. */
const underEighteenDob = (): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 10);
  return d.toISOString().slice(0, 10);
};

/** A date that is over 18 whatever day the suite runs on. */
const overEighteenDob = (): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 30);
  return d.toISOString().slice(0, 10);
};

let api: FetchMock;

function renderLogin(onLoginSuccess?: () => void) {
  const utils = render(
    <AuthProvider>
      <LoginPage onLoginSuccess={onLoginSuccess} />
    </AuthProvider>
  );
  const form = utils.container.querySelector("form");
  if (!form) throw new Error("LoginPage rendered no <form>");
  return { ...utils, form };
}

/**
 * The non-auth routes every flow touches. The `/auth/login/` and
 * `/auth/register/` routes are registered per-test by the `stub*` helpers
 * below: `installFetchMock` resolves to the **first** matching route, so a
 * shared happy-path stub registered in `beforeEach` would silently shadow every
 * failure a test tries to install.
 */
function stubAncillaryRoutes() {
  api
    .on("GET", /\/profile\/me\//, () => json(200, PROFILE))
    .on("GET", /\/legal\/compliance\//, () =>
      json(200, {
        terms_versions: ["v1.0"],
        current_terms_version: "v1.0",
        privacy_version: "v1.0",
        physical_address: "",
      })
    );
}

const stubLoginOk = () => api.on("POST", /\/auth\/login\//, () => json(200, TOKENS));
const stubRegisterOk = () =>
  api.on("POST", /\/auth\/register\//, () =>
    json(201, { id: 7, username: "soundwave", email: "soundwave@echoflow.fm" })
  );
const stubLoginWith = (spec: MockResponseSpec) =>
  api.on("POST", /\/auth\/login\//, () => spec);
const stubRegisterWith = (spec: MockResponseSpec) =>
  api.on("POST", /\/auth\/register\//, () => spec);

/** A login that never settles until `release()` — for observing the in-flight state. */
const stubLoginPending = () => {
  let release: () => void = () => {};
  api.on("POST", /\/auth\/login\//, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return json(200, TOKENS);
  });
  return () => release();
};

const usernameField = () => screen.getByLabelText(/^username$/i);
const passwordField = () => screen.getByLabelText(/^password$/i);
const emailField = () => screen.getByLabelText(/^email address$/i);
const dobField = () => screen.getByLabelText(/^date of birth$/i);
const guardianField = () => screen.getByLabelText(/^parent \/ guardian email$/i);
const submitButton = () => screen.getByRole("button", { name: /sign in|create account/i });

async function typeCredentials(
  user: ReturnType<typeof userEvent.setup>,
  username = "soundwave",
  password = "correct horse"
) {
  await user.type(usernameField(), username);
  await user.type(passwordField(), password);
}

/** Switch to register mode and wait for the extra fields to mount. */
async function switchToRegister(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^register$/i }));
}

beforeEach(() => {
  api = installFetchMock();
  stubAncillaryRoutes();
});

// ---------------------------------------------------------------------------
// 1 — RECON-06 #2: every field resolves by accessible name
// ---------------------------------------------------------------------------

describe("LoginPage field naming", () => {
  it("resolves the username field by its visible label", () => {
    renderLogin();
    expect(screen.getByRole("textbox", { name: /^username$/i })).toBe(usernameField());
  });

  it("resolves the password field by its visible label", () => {
    renderLogin();
    // `<input type="password">` has no implicit ARIA role, so `getByLabelText`
    // is the only route to it — and it can only succeed through a real
    // `<label for>` association.
    expect(passwordField().tagName).toBe("INPUT");
  });

  it("resolves the email field by its visible label in register mode", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);
    expect(screen.getByRole("textbox", { name: /^email address$/i })).toBe(emailField());
  });

  it("gives every field in the login form an <label for> that points at a real input", () => {
    const { container } = renderLogin();
    const inputs = Array.from(container.querySelectorAll("input"));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.id).not.toBe("");
      const label = container.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      expect(label, `no <label for="${input.id}">`).not.toBeNull();
      expect(label?.textContent?.trim()).not.toBe("");
    }
  });

  it("computes the accessible name from the label, not the placeholder", () => {
    const { container } = renderLogin();
    const input = container.querySelector('input[type="text"]');
    expect(input).toHaveAccessibleName("Username");
    // The placeholder is still there as a hint; it is simply no longer the
    // only thing naming the field.
    expect(input).toHaveAttribute("placeholder", "e.g. soundwave");
  });
});

// ---------------------------------------------------------------------------
// 2 — RECON-06 #2 in register mode; the DPDP §9 age gate must survive
// ---------------------------------------------------------------------------

describe("LoginPage register-mode fields", () => {
  it("resolves date of birth by label and keeps it required", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);
    expect(dobField()).toBeInTheDocument();
    expect(dobField()).toBeRequired();
  });

  it("reveals the guardian email only for an under-18 date, and requires it", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    expect(screen.queryByLabelText(/^parent \/ guardian email$/i)).toBeNull();

    fireEvent.change(dobField(), { target: { value: underEighteenDob() } });
    expect(guardianField()).toBeInTheDocument();
    expect(guardianField()).toBeRequired();
  });

  it("does not reveal the guardian email for an adult date", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    fireEvent.change(dobField(), { target: { value: overEighteenDob() } });
    expect(screen.queryByLabelText(/^parent \/ guardian email$/i)).toBeNull();
  });

  it("refuses to register an under-18 account with no guardian email", async () => {
    const user = userEvent.setup();
    stubRegisterOk();
    renderLogin();
    await switchToRegister(user);

    await user.type(usernameField(), "kid");
    await user.type(emailField(), "kid@echoflow.fm");
    fireEvent.change(dobField(), { target: { value: underEighteenDob() } });
    await user.type(passwordField(), "correct horse{Enter}");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(api.callsTo(/\/auth\/register\//)).toHaveLength(0);
  });

  it("sends dob to the server and omits parent_email for an adult", async () => {
    const user = userEvent.setup();
    stubRegisterOk();
    stubLoginOk();
    renderLogin();
    await switchToRegister(user);

    await user.type(usernameField(), "grownup");
    await user.type(emailField(), "grownup@echoflow.fm");
    fireEvent.change(dobField(), { target: { value: overEighteenDob() } });
    await user.type(passwordField(), "correct horse{Enter}");

    await waitFor(() => expect(api.callsTo(/\/auth\/register\//)).toHaveLength(1));
    const [call] = api.callsTo(/\/auth\/register\//);
    expect(call?.body.dob).toBe(overEighteenDob());
    expect(call?.body).not.toHaveProperty("parent_email");
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 — RECON-06 #16 / #35: the auth failure must be announced and associated
// ---------------------------------------------------------------------------

describe("LoginPage error surfacing", () => {
  it("renders a failed login in a live region rather than a bare div", async () => {
    const user = userEvent.setup();
    stubLoginWith(
      json(400, { non_field_errors: ["No active account found with the given credentials"] })
    );
    renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No active account found with the given credentials");
  });

  it("keeps the alert inside the form, so it is announced alongside the fields", async () => {
    const user = userEvent.setup();
    stubLoginWith(json(401, { detail: "Invalid credentials." }));
    const { form } = renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(form).toContainElement(alert);
  });

  it("surfaces a transport failure too, rather than failing silently", async () => {
    const user = userEvent.setup();
    api.fail("POST", /\/auth\/login\//, new TypeError("Failed to fetch"));
    renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/failed to fetch|authentication failed/i);
  });

  it("marks a field-specific server error invalid and describes the field with it", async () => {
    const user = userEvent.setup();
    stubLoginWith(json(400, { username: ["A user with that username already exists."] }));
    renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A user with that username already exists.");

    const field = usernameField();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).not.toBe("");
  });

  it("attributes a server email error to the email field, not the username field", async () => {
    const user = userEvent.setup();
    stubRegisterWith(json(400, { email: ["Enter a valid email address."] }));
    renderLogin();
    await switchToRegister(user);

    await user.type(usernameField(), "soundwave");
    await user.type(emailField(), "not-an-email");
    fireEvent.change(dobField(), { target: { value: overEighteenDob() } });
    await user.type(passwordField(), "correct horse{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a valid email address.");
    expect(emailField()).toHaveAttribute("aria-invalid", "true");
    expect(usernameField()).not.toHaveAttribute("aria-invalid");
  });

  it("leaves fields un-marked while the error is a form-level one", async () => {
    const user = userEvent.setup();
    stubLoginWith(json(429, { detail: "Request was throttled." }));
    renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(usernameField()).not.toHaveAttribute("aria-invalid");
    expect(passwordField()).not.toHaveAttribute("aria-invalid");
  });

  it("clears the invalid state when the mode toggle resets the form", async () => {
    const user = userEvent.setup();
    stubLoginWith(json(400, { username: ["Nope."] }));
    renderLogin();
    await typeCredentials(user);
    await user.click(submitButton());

    await screen.findByRole("alert");
    expect(usernameField()).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: /^register$/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(usernameField()).not.toHaveAttribute("aria-invalid");
  });

  it("associates the local under-18 guardian guard with the guardian field", async () => {
    const user = userEvent.setup();
    stubRegisterOk();
    renderLogin();
    await switchToRegister(user);

    await user.type(usernameField(), "kid");
    await user.type(emailField(), "kid@echoflow.fm");
    fireEvent.change(dobField(), { target: { value: underEighteenDob() } });
    // The Enter path runs `handleSubmit` straight from the keydown, so it is
    // the one route that reaches the local guards without native validation.
    await user.type(passwordField(), "correct horse{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/parent or guardian email/i);
    expect(guardianField()).toHaveAttribute("aria-invalid", "true");
    expect(guardianField().getAttribute("aria-describedby")).toBe(alert.id);
    expect(emailField()).not.toHaveAttribute("aria-invalid");
  });
});

// ---------------------------------------------------------------------------
// 5 — RECON-06 #10 / #24: the password visibility toggle
// ---------------------------------------------------------------------------

describe("LoginPage password visibility toggle", () => {
  const toggle = () => screen.getByRole("button", { name: /password/i });

  it("has an accessible name", () => {
    renderLogin();
    expect(toggle()).toBeInTheDocument();
  });

  it("exposes its state with aria-pressed and flips the input's type", async () => {
    const user = userEvent.setup();
    renderLogin();

    expect(passwordField()).toHaveAttribute("type", "password");
    expect(toggle()).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(passwordField()).toHaveAttribute("type", "text");

    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(passwordField()).toHaveAttribute("type", "password");
  });

  it("keeps a keyboard-reachable hit area above the 24px AA floor", () => {
    // jsdom has no layout, so the declared minimum size is the only evidence
    // available. Tailwind's spacing scale is 4px per unit, so `min-w-11` /
    // `min-h-11` is a 44x44 target — 2.5.8 AA (24px) and 2.5.5 AAA (44px).
    renderLogin();
    const cls = toggle().className;
    expect(cls).toMatch(/\bmin-w-11\b/);
    expect(cls).toMatch(/\bmin-h-11\b/);
    expect(cls).not.toMatch(/(^|\s)w-4(\s|$)/);
  });

  it("is tied to the password field it controls", () => {
    renderLogin();
    expect(toggle().getAttribute("aria-controls")).toBe(passwordField().id);
  });
});

// ---------------------------------------------------------------------------
// 6 — RECON-06 #33: Identify Input Purpose (WCAG 1.3.5 AA)
// ---------------------------------------------------------------------------

describe("LoginPage autocomplete", () => {
  it("marks the username for a browser or password manager", () => {
    renderLogin();
    expect(usernameField()).toHaveAttribute("autocomplete", "username");
  });

  it("uses new-password and marks the register-only fields", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);
    expect(passwordField()).toHaveAttribute("autocomplete", "new-password");
    expect(emailField()).toHaveAttribute("autocomplete", "email");
    expect(dobField()).toHaveAttribute("autocomplete", "bday");
  });

  it("marks the sign-in password as current-password", () => {
    renderLogin();
    expect(passwordField()).toHaveAttribute("autocomplete", "current-password");
  });

  it("does not claim the user's own email address on the guardian field", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);
    fireEvent.change(dobField(), { target: { value: underEighteenDob() } });

    const guardian = guardianField();
    // The WHATWG autofill vocabulary has no token for "someone else's email
    // address". Marking it `email` invites a manager to fill in the *user's*
    // own address, which the server rejects as a duplicate.
    expect(guardian.getAttribute("autocomplete")).not.toBe("email");
    expect(guardian.getAttribute("autocomplete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7 — RECON-06 #21: the mode toggle's selected state is not colour alone
// ---------------------------------------------------------------------------

describe("LoginPage mode toggle", () => {
  it("exposes the selected mode as pressed", async () => {
    const user = userEvent.setup();
    renderLogin();

    const login = screen.getByRole("button", { name: /^login$/i });
    const register = screen.getByRole("button", { name: /^register$/i });

    expect(login).toHaveAttribute("aria-pressed", "true");
    expect(register).toHaveAttribute("aria-pressed", "false");

    await user.click(register);
    expect(register).toHaveAttribute("aria-pressed", "true");
    expect(login).toHaveAttribute("aria-pressed", "false");
  });
});

// ---------------------------------------------------------------------------
// 8 + 9 — RECON-06 #15 / #22 and the RECON-04 duplicate-submit audit row
// ---------------------------------------------------------------------------

describe("LoginPage submit path", () => {
  it("calls the login endpoint exactly once on a successful sign-in", async () => {
    const user = userEvent.setup();
    stubLoginOk();
    const onLoginSuccess = vi.fn();
    renderLogin(onLoginSuccess);

    await typeCredentials(user);
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledTimes(1));
  });

  it("does not use native disabled while authenticating, so focus is not dropped", async () => {
    const user = userEvent.setup();
    const release = stubLoginPending();
    renderLogin();

    await typeCredentials(user);
    const button = submitButton();
    await user.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(button).not.toBeDisabled();
    expect(document.activeElement).toBe(button);
    expect(button).toHaveTextContent(/authenticating/i);

    release();
    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
  });

  it("does not issue a second request when Enter is pressed mid-flight", async () => {
    const user = userEvent.setup();
    const release = stubLoginPending();
    renderLogin();

    await typeCredentials(user);
    await user.click(submitButton());
    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));

    // The Enter path goes through the keydown handler, so the submit button's
    // own state never gated it.
    await user.type(passwordField(), "{Enter}");
    await user.type(passwordField(), "{Enter}");

    release();
    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
  });

  it("cancels the Enter keydown's default action, which is what suppresses native submission", async () => {
    const user = userEvent.setup();
    stubLoginOk();
    renderLogin();
    await typeCredentials(user);

    // `handleSubmit` calls `e.preventDefault()` on the keydown. Implicit form
    // submission is the *default action* of Enter, so a cancelled keydown is
    // what makes "one Enter, one submit" true. `fireEvent` returns false when
    // a handler called preventDefault().
    expect(fireEvent.keyDown(passwordField(), { key: "Enter" })).toBe(false);
    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
  });

  it("one Enter in the password field produces exactly one submission", async () => {
    const user = userEvent.setup();
    stubLoginOk();
    const { form } = renderLogin();
    const submits = vi.fn();
    form.addEventListener("submit", submits);

    await typeCredentials(user);
    await user.type(passwordField(), "{Enter}");

    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
    // The keydown handler runs `handleSubmit` directly, so no `submit` event is
    // dispatched at all — the native path was cancelled, not merely ignored.
    expect(submits).not.toHaveBeenCalled();
  });

  it("clicking submit also dispatches exactly one submit event", async () => {
    const user = userEvent.setup();
    stubLoginOk();
    const { form } = renderLogin();
    const submits = vi.fn();
    form.addEventListener("submit", submits);

    await typeCredentials(user);
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo(/\/auth\/login\//)).toHaveLength(1));
    expect(submits).toHaveBeenCalledTimes(1);
  });
});

/**
 * Controls for the "exactly one submission" tests above.
 *
 * RECON-02 rated the double-submit claim WRONG on the reasoning that
 * `e.preventDefault()` cancels implicit submission, and left it explicitly
 * "not verified by test — low confidence". These two tests are what makes the
 * negative result above worth anything: the first proves the harness *does*
 * produce a native implicit submission, the second proves it *can* report two
 * submissions when two happen. Without them, "one" could just mean "the
 * harness cannot see it".
 */
describe("implicit-submission harness controls", () => {
  it("control: Enter in a plain form performs an implicit submission", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="probe" />
        <button type="submit">go</button>
      </form>
    );
    await userEvent.setup().type(screen.getByRole("textbox", { name: "probe" }), "hi{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("control: an uncancelled keydown submit alongside the native one is reported as two", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form
        onSubmit={onSubmit}
        // Exactly the shape RECON-06 #37 describes: submit from the keydown
        // *and* leave the default action alone. No preventDefault.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.requestSubmit();
        }}
      >
        <input aria-label="probe" />
        <button type="submit">go</button>
      </form>
    );
    await userEvent.setup().type(screen.getByRole("textbox", { name: "probe" }), "hi{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe("LoginPage focus ring", () => {
  it("no longer suppresses the focus ring on any of its fields", () => {
    const { container } = renderLogin();
    const fields = Array.from(container.querySelectorAll("input"));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field.className, "focus:outline-none is still present").not.toMatch(/outline-none/);
    }
  });
});

// ---------------------------------------------------------------------------
// RECON-06 §3: landmarks. The authenticated shell has <main>; this page did not.
// ---------------------------------------------------------------------------

describe("LoginPage landmarks", () => {
  it("exposes a main region named by the page heading", () => {
    renderLogin();
    const main = screen.getByRole("main");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(main.getAttribute("aria-labelledby")).toBe(heading.id);
  });
});
