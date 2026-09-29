import React, { useState } from "react";
import { Headphones, Radio, Eye, EyeOff, ArrowRight } from "lucide-react";
import { useAuth } from "../stores/auth";

interface LoginPageProps {
  onLoginSuccess?: () => void;
}

/** Mirrors the server bound in RegisterSerializer.validate (serializers.py):
 *  a future dob is rejected, as is one over 120 years old. Computed here only
 *  to decide whether the guardian field is required — the server re-validates
 *  and remains the authority. */
const MAX_DOB = new Date();
MAX_DOB.setFullYear(MAX_DOB.getFullYear() - 120);
const MAX_DOB_ISO = MAX_DOB.toISOString().slice(0, 10);

const dobToAge = (iso: string): number | null => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  return (
    now.getFullYear() -
    parsed.getFullYear() -
    ((now.getMonth(), now.getDate()) < (parsed.getMonth(), parsed.getDate()) ? 1 : 0)
  );
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    try {
      if (mode === "register") {
        if (!email.trim()) {
          setErrorMsg("A valid email address is required.");
          setIsLoading(false);
          return;
        }
        // DPDP §9: `dob` is required (serializers.py:512) and `parent_email` is
        // required when the computed age is under 18. Omitting `dob` used to
        // register the account as an adult, which was the bypass.
        if (!dob) {
          setErrorMsg("Date of birth is required.");
          setIsLoading(false);
          return;
        }
        const age = dobToAge(dob);
        if (age !== null && age < 18 && !parentEmail.trim()) {
          setErrorMsg("A parent or guardian email is required for users under 18.");
          setIsLoading(false);
          return;
        }
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
    } catch (err: any) {
      setErrorMsg(
        err?.data?.non_field_errors?.[0] ||
        err?.data?.username?.[0] ||
        err?.data?.email?.[0] ||
        err?.message ||
        "Authentication failed. Please verify credentials."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute w-[500px] h-[500px] rounded-full bg-[#FF6321]/5 blur-[120px] -top-40 -right-40 pointer-events-none" />
      <div className="absolute w-[400px] h-[400px] rounded-full bg-[#FF6321]/5 blur-[100px] -bottom-32 -left-32 pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Logo + Brand */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-[#FF6321] flex items-center justify-center mx-auto mb-5 shadow-[0_0_32px_rgba(255,99,33,0.35)]">
            <Headphones className="w-8 h-8 text-black" />
          </div>
          <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tight text-white">
            EchoFlow
          </h1>
          <p className="text-xs font-mono uppercase text-white/40 mt-2 tracking-widest">
            TikTok for your ears
          </p>
        </div>

        {/* Auth Card */}
        <div className="bg-[#111111] border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl">
          {/* Login / Register Toggle */}
          <div className="flex gap-1 p-1 bg-[#0A0A0A] rounded-xl mb-7">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setErrorMsg(null);
                }}
                className={`flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all ${
                  mode === m
                    ? "bg-white/10 text-white"
                    : "text-white/30 hover:text-white/60"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Error Message */}
          {errorMsg && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-mono">
              {errorMsg}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div>
              <label className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. soundwave"
                required
                className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#FF6321] transition-colors"
              />
            </div>

            {/* Email (register only) */}
            {mode === "register" && (
              <div>
                <label className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="soundwave@echoflow.fm"
                  required
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Date of birth (register only) */}
            {mode === "register" && (
              <div>
                <label className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider">
                  Date of Birth
                </label>
                <input
                  type="date"
                  value={dob}
                  max={MAX_DOB_ISO}
                  onChange={(e) => setDob(e.target.value)}
                  required
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Parent / guardian email — required by the server when the
                computed age is under 18. */}
            {mode === "register" && dobToAge(dob) !== null && dobToAge(dob)! < 18 && (
              <div>
                <label className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider">
                  Parent / Guardian Email
                </label>
                <input
                  type="email"
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                  placeholder="guardian@echoflow.fm"
                  required
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#FF6321] transition-colors"
                />
              </div>
            )}

            {/* Password */}
            <div>
              <label className="text-[10px] font-mono uppercase text-white/40 block mb-1.5 tracking-wider">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit(e)}
                  className="w-full bg-black border border-white/15 rounded-xl px-4 py-3 pr-12 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[#FF6321] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 rounded-xl bg-[#FF6321] text-black font-black text-xs uppercase tracking-widest shadow-[0_0_20px_rgba(255,99,33,0.3)] hover:bg-[#ff753b] active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
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
                setErrorMsg(null);
              }}
              className="text-xs font-mono uppercase text-[#FF6321] hover:underline transition-colors"
            >
              {mode === "login"
                ? "Need an account? Sign up here"
                : "Already have an account? Log in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
