import React from "react";
import { Headphones } from "lucide-react";
import { usePlayer } from "../../stores/player";
import { useAuth } from "../../stores/auth";
import { useBackendHealth, type BackendHealth } from "./useBackendHealth";

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  unreadCount: number;
}

/**
 * Copy is scoped to what the probes actually measure. `GET /health/` is a
 * Django liveness probe and `GET /ready/` runs `SELECT 1` against Postgres
 * (backend/EchoFlow/health.py) — neither observes a Celery worker, so this
 * must not claim workers are active. It said "Workers Active" for months while
 * never having asked anything.
 */
const HEALTH_VIEW: Record<
  BackendHealth["status"],
  { label: string; dot: string; text: string }
> = {
  checking: {
    label: "Checking",
    dot: "bg-white/30",
    text: "text-white/40",
  },
  healthy: {
    label: "Backend Ready",
    dot: "bg-green-500",
    text: "text-green-400",
  },
  unreachable: {
    label: "Not Reachable",
    dot: "bg-red-500",
    text: "text-red-400",
  },
};

function healthTitle(health: BackendHealth): string {
  const checked = health.lastCheckedAt ? new Date(health.lastCheckedAt).toLocaleTimeString() : "never";
  const suffix = health.lastError ? ` — ${health.lastError}` : "";
  return `Liveness /health/ and readiness /ready/ — last checked ${checked}${suffix}`;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab, unreadCount }) => {
  const { handsFreeMode, setHandsFreeMode } = usePlayer();
  const { user, profile } = useAuth();
  const health = useBackendHealth();
  const healthView = HEALTH_VIEW[health.status];

  const navLinks = [
    { id: "feed", label: "Live Feed" },
    { id: "explore", label: "Discover" },
    { id: "upload", label: "Creator Studio" },
    { id: "inbox", label: "Inbox", badge: unreadCount },
  ];

  return (
    <header className="sticky top-0 z-30 w-full bg-[#0A0A0A]/95 backdrop-blur-xl border-b border-white/10 px-4 md:px-8 py-3.5 transition-all">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand with Orange Pulse */}
        <div
          onClick={() => setActiveTab("feed")}
          className="flex items-center gap-3 cursor-pointer select-none group"
        >
          <div className="w-8 h-8 bg-[#FF6321] rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(255,99,33,0.35)] transition-transform group-hover:scale-105">
            <div className="w-3.5 h-3.5 border-2 border-black rounded-full animate-pulse" />
          </div>
          <div>
            <span className="text-xl md:text-2xl font-black tracking-tighter uppercase text-[#F5F5F5] leading-none">
              EchoFlow
            </span>
            <p className="text-[10px] uppercase font-mono tracking-wider text-white/40 leading-none mt-0.5">
              Audio-First Short-Form
            </p>
          </div>
        </div>

        {/* Center Desktop Navigation Tabs */}
        <div className="hidden md:flex items-center gap-6 text-xs font-black uppercase tracking-widest text-white/40">
          {navLinks.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`relative py-1 transition-colors hover:text-white flex items-center gap-1.5 ${
                  isActive ? "text-[#FF6321]" : ""
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge && tab.badge > 0 ? (
                  <span className="px-1.5 py-0.2 rounded-full bg-[#FF6321] text-black text-[9px] font-mono font-black">
                    {tab.badge}
                  </span>
                ) : null}
                {isActive && (
                  <span className="absolute -bottom-1 left-0 right-0 h-0.5 bg-[#FF6321]" />
                )}
              </button>
            );
          })}
        </div>

        {/* Right Actions: System Status & User Controls */}
        <div className="flex items-center gap-3 md:gap-5">
          {/* System Status Indicator — driven by a real poll of /health/ and
              /ready/. `animate-pulse` appears only while a probe is genuinely
              in flight; the old `animate-ping` pulsed for ever, which is a
              visual claim of continuous activity the code never made. */}
          <div className="hidden lg:flex flex-col text-right">
            <span className="text-[9px] uppercase font-mono font-bold text-white/30 tracking-wider">
              System Status
            </span>
            <span
              role="status"
              aria-live="polite"
              title={healthTitle(health)}
              className={`text-[10px] uppercase font-mono font-bold flex items-center justify-end gap-1 ${healthView.text}`}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${healthView.dot} ${
                  health.status === "checking" ? "animate-pulse" : ""
                }`}
              />
              {healthView.label}
            </span>
          </div>

          {/* Hands-Free Toggle */}
          <button
            type="button"
            onClick={() => setHandsFreeMode(!handsFreeMode)}
            aria-pressed={handsFreeMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold uppercase tracking-wider transition-all border ${
              handsFreeMode
                ? "bg-[#FF6321] text-black border-[#FF6321] shadow-[0_0_15px_rgba(255,99,33,0.3)]"
                : "bg-white/5 text-white/60 hover:text-white border-white/10 hover:bg-white/10"
            }`}
            title="Toggle Hands-Free Continuous Playback"
          >
            <Headphones className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Hands-Free</span>
            {handsFreeMode && <span className="w-1.5 h-1.5 rounded-full bg-black" />}
          </button>

          {/* User Profile Avatar */}
          <button
            type="button"
            onClick={() => setActiveTab("profile")}
            className="flex items-center gap-2 p-1 rounded-full hover:ring-2 hover:ring-[#FF6321]/50 transition-all"
            title="My Profile"
          >
            <div className="w-8 h-8 rounded-full bg-white/10 border border-white/20 overflow-hidden flex items-center justify-center">
              {profile?.profile_picture ? (
                <img
                  src={profile.profile_picture}
                  alt={user?.username || "avatar"}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="font-black text-xs text-[#FF6321]">
                  {user?.username?.[0]?.toUpperCase() || "E"}
                </span>
              )}
            </div>
          </button>
        </div>
      </div>
    </header>
  );
};
