import React, { useRef, useState } from "react";
import { Headphones, Radio, Eye, EyeOff, ArrowRight } from "lucide-react";
import { useAuth } from "../stores/auth";

interface LoginPageProps {
  onLoginSuccess?: () => void;
}

// RECON-06 #2: `htmlFor` occurred zero times in the whole app, so every field
// on the app's front door took its accessible name from `placeholder` — a
// string that disappears on focus and renders at 1.77:1. These are the first
// real label/field associations in the codebase.
const USERNAME_ID = "login-username";
const EMAIL_ID = "login-email";
const DOB_ID = "login-dob";
const PARENT_EMAIL_ID = "login-parent-email";
const PASSWORD_ID = "login-password";
const ERROR_ID = "login-error";
const TITLE_ID = "login-title";

/**
 * Mirrors the server bound in `RegisterSerializer.validate` (serializers.py):
 * a future dob is rejected, as is one over 120 years old. The server re-validates
 * and remains the authority; this only keeps the native picker honest.
 *
 * These are `min`/`max` on an `<input type="date">`, where the browser reads
 * them as *inclusive bounds on the value*:
 *
 *     min = the EARLIEST date you may type   -> 120 years ago
 *     max = the LATEST date you may type     -> today
 *
 * The upper-age bound is therefore a `min`, NOT a `max`. This was previously
 * written as `max={MAX_DOB_ISO}` with MAX_DOB_ISO set to 120 years ago, which
 * told the browser "reject any birthdate later than 1906" — i.e. it rejected
 * every living person and accepted only the implausibly old. Because `min` was
 * absent, the input also had no lower bound, so the 120-year floor was never
 * enforced client-side at all. Two attributes, both inverted in effect.
 *
 * The floor itself is `today - timedelta(days=120 * 365)` on the server, i.e.
 * exactly 43800 days. `setFullYear(year - 120)` is a different date (120
 * calendar years is 43829-43831 days), so derive it from the same day count.
 * `toISOString()` would also convert to UTC, while the input holds a *local*
 * calendar date; format from local getters so attribute and value agree.
 */
const localIsoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Earliest accepted dob: 120 years ago, matching the server's 43800-day bound. */
const MIN_DOB = new Date();
MIN_DOB.setDate(MIN_DOB.getDate() - 120 * 365);
const MIN_DOB_ISO = localIsoDate(MIN_DOB);

/** Latest accepted dob: today. A future birthdate is rejected by the server. */
const MAX_DOB_ISO = localIsoDate(new Date());

const dobToAge = (iso: string): number | null => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  // Compare (month, day) pairs NUMERICALLY. This was previously written as
  // `((now.getMonth(), now.getDate()) < (parsed.getMonth(), parsed.getDate()))`,
  // intending a tuple comparison the way the server writes it
  // (serializers.py:967). JavaScript has no tuples: the comma is the comma
  // *operator*, so that expression collapsed to
  // `now.getDate() < parsed.getDate()` -- day-of-month only, with the month
  // discarded. The age was therefore out by one for every birthdate whose
  // day-of-month was later than today's, which on the 1st of a month is
  // everything except the 1st. That misclassified real 17-year-olds as adults
  // and hid the guardian-email field the server then demanded.
  const monthDiff = now.getMonth() - parsed.getMonth();
  const hadBirthdayThisYear =
    monthDiff > 0 || (monthDiff === 0 && now.getDate() >= parsed.getDate());
  return now.getFullYear() - parsed.getFullYear() - (hadBirthdayThisYear ? 0 : 1);
};

type FieldKey = "username" | "email" | "dob" | "parentEmail" | "password";

interface AuthFailure {
  message: string;
  /** null when the failure is about the request as a whole. */
  field: FieldKey | null;
}

/**
 * DRF field name -> the field it describes, in the precedence the old inline
 * chain at this file's `catch` used (`non_field_errors`, then `username`, then
 * `email`, then the flattened `Error.message`). The last three are the fields
 * the register form adds; a body carrying only `{"password": [...]}` already
 * resolved to the same text via `Error.message`, so the message a user reads
 * is unchanged — it is now also attached to the field that caused it.
 */
const SERVER_ERROR_FIELDS: ReadonlyArray<readonly [string, FieldKey | null]> = [
  ["non_field_errors", null],
  ["username", "username"],
  ["email", "email"],
  ["dob", "dob"],
  ["parent_email", "parentEmail"],
  ["password", "password"],
];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/**
 * DRF field errors arrive as `["msg", ...]`; a `{"detail": ...}` body arrives as
 * a bare string. Take the first real string either way rather than stringifying
 * an object into "[object Object]".
 */
const firstMessage = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string") ?? null;
  }
  return null;
};

/**
 * `apiRequest` (client.ts) builds `Error.message` from `detail`/`error`/a
 * flattened join of the body, and hangs the parsed body off `error.data`. Both
 * are read here, in that order, so the server's own wording survives.
 */
const readAuthFailure = (err: unknown): AuthFailure => {
  const record = asRecord(err);
  const data = asRecord(record?.data);
  if (data) {
    for (const [key, field] of SERVER_ERROR_FIELDS) {
      const message = firstMessage(data[key]);
      if (message) return { message, field };
    }
  }
  return {
    message: firstMessage(record?.message) ?? "Authentication failed. Please verify credentials.",
    field: null,
  };
};

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [dob, setDob] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * A ref, not `isLoading`: two submits within one render would both read the
   * same stale `false`, and RECON-04's duplicate-submit audit is explicit that
   * `handleSubmit` never checked the flag at all. The Enter path reaches this
   * function without going through the submit button, so the button's own state
   * cannot be the guard.
   */
  const inFlight = useRef(false);

  /**
   * DPDP §9: `dob` is required (serializers.py:512) and `parent_email` is
   * required when the computed age is under 18. Omitting `dob` used to register
   * the account as an adult, which was the bypass. All three fields also carry
   * the native `required` attribute, so a browser blocks first; these guards
   * are what runs when submission arrives without native validation — the Enter
   * key on the password field, which the keydown handler handles directly.
   */
  const validate = (): AuthFailure | null => {
    if (mode !== "register") return null;
    if (!email.trim()) {
      return { message: "A valid email address is required.", field: "email" };
    }
    if (!dob) {
      return { message: "Date of birth is required.", field: "dob" };
    }
    const age = dobToAge(dob);
    if (age !== null && age < 18 && !parentEmail.trim()) {
      return {
        message: "A parent or guardian email is required for users under 18.",
        field: "parentEmail",
      };
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const localFailure = validate();
    if (localFailure) {
      setFailure(localFailure);
      return;
    }
    inFlight.current = true;
    setFailure(null);
    setIsLoading(true);

    try {
      if (mode === "register") {
        await register({
          email: email.trim(),
          username: username.trim(),
          password,
          dob,
          parentEmail: parentEmail.trim() || undefined,
        });
      } else {
        await login(username.trim(), password);
      }
      onLoginSuccess?.();
    } catch (err: unknown) {
      setFailure(readAuthFailure(err));
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  };

  /** aria-invalid / aria-describedby for one field, or nothing when it is fine. */
  const describedBy = (field: FieldKey) => (failure?.field === field ? ERROR_ID : undefined);
  const isInvalid = (field: FieldKey) => failure?.field === field || undefined;

  return (
    <main
      aria-labelledby={TITLE_ID}
      className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-4 relative overflow-hidden"
    >
      {/* Background glow effects */}
      <div className="absolute w-[500px] h-[500px] rounded-full bg-[#FF6321]/5 blur-[120px] -top-40 -right-40 pointer-events-none" />
      <div className="absolute w-[400px] h-[400px] rounded-full bg-[#FF6321]/5 blur-[100px] -bottom-32 -left-32 pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Logo + Brand */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-[#FF6321] flex items-center justify-center mx-auto mb-5 shadow-[0_0_32px_rgba(255,99,33,0.35)]">
            <Headphones className="w-8 h-8 text-black" />
          </div>
          <h1
            id={TITLE_ID}
            className="text-3xl md:text-4xl font-black uppercase tracking-tight text-white"
          >
            EchoFlow
          </h1>
          <p className="text-xs font-mono uppercase text-white/40 mt-2 tracking-widest">
            TikTok for your ears
          </p>
        </div>

        {/* Auth Card */}
        <div className="bg-[#111111] border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl">
          {/* Login / Register Toggle. RECON-06 #21: the selected state was
              background colour alone, so it is also exposed as pressed state. */}
          <div
            role="group"
            aria-label="Authentication mode"
            className="flex gap-1 p-1 bg-[#0A0A0A] rounded-xl mb-7"
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  setFailure(null);
                }}
                className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${
                  mode === m ? "bg-white/10 text-white" : "text-white/30 hover:text-white/60"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* RECON-06 #35: the app's primary error surface was a bare <div>,
                announced by nothing. It lives inside the <form> so it is
                rendered alongside the fields, and is described by the field it
                belongs to when that field exists. */}
            {failure && (
              <div
                id={ERROR_ID}
                role="alert"
                className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-mono"
              >
                {failure.message}
              </div>
            )}

            {/* Username */}
            <div>
              <label
                htmlFor={USERNAME_ID}
                className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider"
              >
                Username
              </label>
              <input
                id={USERNAME_ID}
                name="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. soundwave"
                required
                aria-invalid={isInvalid("username")}
                aria-describedby={describedBy("username")}
                className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:border-[#FF6321] transition-colors"
              />
            </div>

            {/* Email (register only) */}
            {mode === "register" && (
              <div>
                <label
                  htmlFor={EMAIL_ID}
                  className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider"
                >
                  Email Address
                </label>
                <input
                  id={EMAIL_ID}
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="soundwave@echoflow.fm"
                  required
                  aria-invalid={isInvalid("email")}
                  aria-describedby={describedBy("email")}
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Date of birth (register only) */}
            {mode === "register" && (
              <div>
                <label
                  htmlFor={DOB_ID}
                  className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider"
                >
                  Date of Birth
                </label>
                <input
                  id={DOB_ID}
                  name="dob"
                  type="date"
                  autoComplete="bday"
                  value={dob}
                  min={MIN_DOB_ISO}
                  max={MAX_DOB_ISO}
                  onChange={(e) => setDob(e.target.value)}
                  required
                  aria-invalid={isInvalid("dob")}
                  aria-describedby={describedBy("dob")}
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Parent / guardian email — required by the server when the
                computed age is under 18. No `autoComplete`: the WHATWG autofill
                vocabulary has no token for "someone else's email address", and
                marking it `email` invites a manager to fill in the *user's* own
                address, which the server rejects as a duplicate. */}
            {mode === "register" && dobToAge(dob) !== null && dobToAge(dob)! < 18 && (
              <div>
                <label
                  htmlFor={PARENT_EMAIL_ID}
                  className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider"
                >
                  Parent / Guardian Email
                </label>
                <input
                  id={PARENT_EMAIL_ID}
                  name="parent_email"
                  type="email"
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                  placeholder="guardian@echoflow.fm"
                  required
                  aria-invalid={isInvalid("parentEmail")}
                  aria-describedby={describedBy("parentEmail")}
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Password */}
            <div>
              <label
                htmlFor={PASSWORD_ID}
                className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id={PASSWORD_ID}
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  aria-invalid={isInvalid("password")}
                  aria-describedby={describedBy("password")}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit(e)}
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 pr-14 text-xs font-mono text-white placeholder-white/20 focus:border-[#FF6321] transition-colors"
                />
                {/* RECON-06 #10 / #24: was 16x16, unnamed, and stateless.
                    `aria-pressed` carries the state so the name can stay
                    stable; `min-w-11 min-h-11` is a 44x44 target (Tailwind's
                    scale is 4px per unit), above the 2.5.8 AA 24px floor. */}
                <button
                  type="button"
                  aria-label="Show password"
                  aria-pressed={showPassword}
                  aria-controls={PASSWORD_ID}
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 min-w-11 min-h-11 flex items-center justify-center rounded-lg text-white/60 hover:text-white transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button. RECON-06 #22: `aria-disabled` rather than
                `disabled` — a natively disabled button leaves the tab order
                and drops focus to <body> (WCAG 2.4.3). The in-flight guard in
                `handleSubmit` is what actually prevents the second request. */}
            <button
              type="submit"
              aria-disabled={isLoading}
              className="w-full py-3.5 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-widest shadow-[0_0_20px_rgba(255,99,33,0.3)] hover:bg-[#ff753b] active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-6 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
            >
              <span>
                {isLoading
                  ? "Authenticating..."
                  : mode === "register"
                  ? "Create Account"
                  : "Sign In"}
              </span>
              <ArrowRight className="w-4 h-4 stroke-[3]" />
            </button>
          </form>

          {/* Toggle Link */}
          <div className="text-center pt-5 mt-5 border-t border-white/10">
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setFailure(null);
              }}
              className="text-xs font-mono uppercase text-[#FF6321] hover:underline transition-colors"
            >
              {mode === "login" ? "Need an account? Sign up here" : "Already have an account? Log in"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
};
