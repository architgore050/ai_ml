import React from "react";
import { Flame, Compass, Plus, Inbox, User } from "lucide-react";

interface BottomNavProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  unreadCount: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({ activeTab, setActiveTab, unreadCount }) => {
  const tabs = [
    { id: "feed", label: "Live Feed", icon: Flame },
    { id: "explore", label: "Discover", icon: Compass },
    { id: "upload", label: "Studio", icon: Plus, highlight: true },
    { id: "inbox", label: "Inbox", icon: Inbox, badge: unreadCount },
    { id: "profile", label: "Profile", icon: User },
  ];

  return (
    // Labelled because the Header now renders a second <nav> for the same five
    // destinations at `md` and up. Two unlabelled navigation landmarks are a
    // list a screen reader cannot act on. Both are called "Primary" because they
    // are the same navigation at two breakpoints; collapsing them into one
    // landmark means dropping `md:hidden` from this element, which is a layout
    // change and an owner decision (RECON-06 §16 Q10), not an a11y patch.
    <nav aria-label="Primary" className="fixed bottom-0 left-0 right-0 z-40 bg-[#0A0A0A]/95 backdrop-blur-xl border-t border-white/10 pb-safe md:hidden">
      <div className="max-w-md mx-auto flex items-center justify-around px-2 py-2">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          if (tab.highlight) {
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? "page" : undefined}
                // `focus:outline-none` used to sit here with nothing replacing
                // it, deleting the browser's focus ring outright — a keyboard
                // user tabbing to the primary action saw nothing at all. It is
                // gone rather than overridden: leaving it beside
                // `focus-visible:outline-none` would make the ring depend on
                // which rule Tailwind happens to emit last, since both carry the
                // same specificity. The ring is now drawn explicitly and scoped
                // to `focus-visible`, so it follows the keyboard and not the
                // mouse.
                //
                // White rather than the brand orange: this tab's fill is
                // `bg-[#FF6321]` in both its active and inactive states, so an
                // orange ring would be invisible on it. No `ring-offset-*`
                // colour is used because Tailwind 4.3.3 emits no such utility —
                // only the width — so the offset colour would have been dead CSS.
                className="flex flex-col items-center justify-center -mt-5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(255,99,33,0.3)] transition-transform active:scale-95 ${
                  isActive
                    ? "bg-[#FF6321] text-black ring-4 ring-[#0A0A0A] scale-105"
                    : "bg-[#FF6321] text-black hover:bg-[#ff753b]"
                }`}>
                  <Icon className="w-6 h-6 stroke-[3]" />
                </div>
                <span className="text-[9px] font-black uppercase tracking-widest text-white/50 mt-1">Create</span>
              </button>
            );
          }

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center py-1 px-3 transition-colors ${
                isActive ? "text-[#FF6321]" : "text-white/50 hover:text-white/80"
              }`}
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {tab.badge && tab.badge > 0 ? (
                  <>
                    {/* The badge is a number that states nothing about what it
                        counts, so the button's computed name was "Inbox 5" —
                        ambiguous in isolation, and it changed on a 30s poll that
                        no live region announced. The visible chip is decorative
                        and the count is spelled out for assistive technology. */}
                    <span
                      aria-hidden="true"
                      className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-[#FF6321] text-[9px] font-black text-black flex items-center justify-center font-mono"
                    >
                      {tab.badge}
                    </span>
                    <span className="sr-only">{tab.badge} unread</span>
                  </>
                ) : null}
              </div>
              <span className="text-[9px] font-black uppercase tracking-wider mt-1">{tab.label}</span>
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#FF6321] mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
