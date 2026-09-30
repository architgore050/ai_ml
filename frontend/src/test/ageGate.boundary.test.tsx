/**
 * Age-gate boundary tests. These exist because the existing suite in
 * `login.test.tsx` probes only 10-years-ago and 30-years-ago dates, which sit
 * far enough from the 18th-birthday boundary that they cannot detect an
 * off-by-one in the age arithmetic.
 *
 * The bug this pins: `dobToAge` in `pages/Login.tsx` was written as
 *
 *     ((now.getMonth(), now.getDate()) < (parsed.getMonth(), parsed.getDate()))
 *
 * In JavaScript the comma is the *comma operator*, not a tuple constructor, so
 * that expression evaluates to `now.getDate() < parsed.getDate()` -- a
 * comparison of day-of-month only, with the month discarded. It is not the
 * birthday-aware comparison the backend performs at `serializers.py:967`
 * (`(today.month, today.day) < (dob.month, dob.day)`).
 *
 * The off-by-one therefore fires on every date whose day-of-month is later than
 * today's. On the 1st of a month that is *every* date except day 1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider } from "../stores/auth";
import { LoginPage } from "../pages/Login";
import { installFetchMock, json, type FetchMock } from "./fetchMock";

/** Birthday-aware age, mirroring `RegisterSerializer.validate` (serializers.py:967). */
const trueAge = (iso: string): number => {
  const dob = new Date(`${iso}T00:00:00`);
  const today = new Date();
  const hadBirthday =
    today.getMonth() > dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
  return today.getFullYear() - dob.getFullYear() - (hadBirthday ? 0 : 1);
};

/** An ISO date that is exactly `years` before today, preserving month/day. */
const yearsAgoIso = (years: number, dayOfMonth?: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(dayOfMonth ?? d.getDate());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

/** The 1st of the current month, `years` ago -- a date whose day-of-month is 1. */
const firstOfMonthYearsAgo = (years: number): string => yearsAgoIso(years, 1);

let api: FetchMock;

const PROFILE = {
  id: 7,
  username: "soundwave",
  email: "soundwave@echoflow.fm",
  profile_picture: null,
  profile_picture_url: null,
  followers_count: 0,
  following_count: 0,
  uploads_count: 0,
  liked_clips: [],
  is_following: false,
  date_joined: "2026-01-01T00:00:00Z",
};

function renderLogin() {
  const utils = render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>,
  );
  const form = utils.container.querySelector("form");
  if (!form) throw new Error("LoginPage rendered no <form>");
  return { ...utils, form };
}

const byLabel = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;

async function switchToRegister(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^register$/i }));
  await waitFor(() => expect(byLabel(/date of birth/i)).toBeInTheDocument());
}

describe("age gate: 18th-birthday boundary", () => {
  beforeEach(() => {
    api = installFetchMock();
    api
      .on("GET", /\/profile\/me\//, () => json(200, PROFILE))
      .on("GET", /\/legal\/compliance\//, () =>
        json(200, {
          terms_versions: ["v1.0"],
          current_terms_version: "v1.0",
          privacy_version: "v1.0",
          physical_address: "",
        }),
      );
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("demands a guardian email for someone one day short of 18", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    // 18 years ago, but one day later in the year than today => the 18th
    // birthday has not arrived yet, so they are 17 and a minor.
    const iso = yearsAgoIso(18, new Date().getDate() + 1);
    expect(trueAge(iso)).toBe(17);

    fireEvent.change(byLabel(/date of birth/i), { target: { value: iso } });
    expect(screen.getByLabelText(/^parent \/ guardian email$/i)).toBeInTheDocument();
  });

  it("does not demand a guardian email for someone exactly 18 today", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    // The 18th birthday is today => an adult.
    const iso = yearsAgoIso(18);
    expect(trueAge(iso)).toBe(18);

    fireEvent.change(byLabel(/date of birth/i), { target: { value: iso } });
    expect(screen.queryByLabelText(/^parent \/ guardian email$/i)).toBeNull();
  });

  it("demands a guardian email for a 17-year-old born on the 1st of a month", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    // Day-of-month 1 is the case that survived the comma-operator bug: the
    // discarded month does not matter when the day comparison also says "not
    // yet". This asserts the guard so a future refactor cannot regress it.
    const iso = firstOfMonthYearsAgo(17);
    expect(trueAge(iso)).toBe(17);

    fireEvent.change(byLabel(/date of birth/i), { target: { value: iso } });
    expect(screen.getByLabelText(/^parent \/ guardian email$/i)).toBeInTheDocument();
  });

  it("does not demand a guardian email for an adult born late in the month", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    // An adult whose day-of-month is later than today's: the exact input the
    // comma-operator bug misclassified as a minor, producing a spurious
    // guardian field for a grown adult.
    const d = new Date();
    d.setDate(Math.min(28, d.getDate() + 10));
    const iso = `${d.getFullYear() - 30}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(trueAge(iso)).toBeGreaterThanOrEqual(18);

    fireEvent.change(byLabel(/date of birth/i), { target: { value: iso } });
    expect(screen.queryByLabelText(/^parent \/ guardian email$/i)).toBeNull();
  });

  it("demands a guardian email for a minor whose birthday falls later this year", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    // The discriminating case for the comma-operator bug. The birthday is
    // LATER in the calendar year than today (so the person is still 17), but
    // its day-of-month is 1, which is not later than today's day-of-month --
    // so the shipped expression skips the subtraction and reports them as an
    // adult. Any date with (month, day) strictly after today and day-of-month
    // === 1 exercises this; pick the next such month.
    const today = new Date();
    const laterThisYear = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      1,
    );
    // Guard the fixture itself: this must be a minor.
    const iso = `${laterThisYear.getFullYear() - 18}-${String(laterThisYear.getMonth() + 1).padStart(2, "0")}-01`;
    expect(trueAge(iso)).toBe(17);

    fireEvent.change(byLabel(/date of birth/i), { target: { value: iso } });
    expect(screen.getByLabelText(/^parent \/ guardian email$/i)).toBeInTheDocument();
  });
});

describe("age gate: native date bounds", () => {
  beforeEach(() => {
    api = installFetchMock();
    api
      .on("GET", /\/profile\/me\//, () => json(200, PROFILE))
      .on("GET", /\/legal\/compliance\//, () =>
        json(200, {
          terms_versions: ["v1.0"],
          current_terms_version: "v1.0",
          privacy_version: "v1.0",
          physical_address: "",
        }),
      );
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  /**
   * `min`/`max` on `<input type="date">` are inclusive bounds ON THE VALUE, so
   * the 120-year floor is a `min` and "no future birthdates" is a `max`. These
   * assert the *direction* as well as the value, because the previous code had
   * the floor bound on `max` -- which told the browser to reject every birthdate
   * after 1906, i.e. every living person, while leaving the 120-year floor
   * unenforced. A value-only assertion would have passed either way.
   */
  it("bounds the dob picker with min=120 years ago and max=today", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    const input = byLabel(/date of birth/i) as HTMLInputElement;
    const localIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const floor = new Date();
    floor.setDate(floor.getDate() - 120 * 365);
    const today = new Date();

    expect(input.getAttribute("min")).toBe(localIso(floor));
    expect(input.getAttribute("max")).toBe(localIso(today));
  });

  it("accepts ordinary living users' birthdates and rejects only implausible ones", async () => {
    const user = userEvent.setup();
    renderLogin();
    await switchToRegister(user);

    const input = byLabel(/date of birth/i) as HTMLInputElement;

    // Every one of these is a real, plausible account. If the floor bound is on
    // `max`, the browser marks all of them invalid and no one can register.
    for (const iso of ["1990-05-05", "2000-01-01", "2008-06-01", "2020-01-01"]) {
      fireEvent.change(input, { target: { value: iso } });
      expect(input.validity.valid, `${iso} should be an acceptable birthdate`).toBe(true);
    }

    // Today itself is the newest acceptable birthdate.
    const localIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    fireEvent.change(input, { target: { value: localIso(new Date()) } });
    expect(input.validity.valid).toBe(true);

    // A future birthdate and one over 120 years old are both out.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    fireEvent.change(input, { target: { value: localIso(tomorrow) } });
    expect(input.validity.valid, "a future birthdate must be rejected").toBe(false);

    fireEvent.change(input, { target: { value: "1900-01-01" } });
    expect(input.validity.valid, "a birthdate over 120 years ago must be rejected").toBe(false);
  });
});