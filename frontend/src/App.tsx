import React, { useState, useEffect } from "react";
import { AuthProvider, useAuth } from "./stores/auth";
import { PlayerProvider } from "./stores/player";
import { Header } from "./components/common/Header";
import { BottomNav } from "./components/navigation/BottomNav";
import { NetworkBanner } from "./components/common/NetworkBanner";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { SessionNotice, useSessionAnnouncer } from "./components/common/SessionAnnouncer";
import { MiniPlayer } from "./components/feed/MiniPlayer";
import { OnboardingModal } from "./components/feed/OnboardingModal";
import { FeedPage } from "./pages/Feed";
import { ExplorePage } from "./pages/Explore";
import { UploadPage } from "./pages/Upload";
import { InboxPage } from "./pages/Inbox";
import { ProfilePage } from "./pages/Profile";
import { LoginPage } from "./pages/Login";
import { shareAPI } from "./api/client";

const MainContent: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<string>("feed");
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const [targetProfileUserId, setTargetProfileUserId] = useState<number | null>(null);

  // Poll unread count every 30s as specified in Section 4.7
  const refreshUnreadCount = async () => {
    try {
      const data = await shareAPI.getUnreadCount();
      setUnreadCount(data.unread || 0);
    } catch {
      // Ignore unauth poll
    }
  };

  useEffect(() => {
    refreshUnreadCount();
    const interval = setInterval(refreshUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Check onboarding on new user register
  useEffect(() => {
    if (sessionStorage.getItem("ef_new_user") === "1") {
      setIsOnboardingOpen(true);
    }
  }, []);

  const handleOpenCreatorProfile = (creatorId: number) => {
    setTargetProfileUserId(creatorId);
    setActiveTab("profile");
  };

  const handleBackToMyProfile = () => {
    setTargetProfileUserId(null);
  };

  // Show login page when not authenticated
  if (!isAuthenticated && !isLoading) {
    return <LoginPage />;
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#F5F5F5] flex flex-col selection:bg-[#FF6321] selection:text-black font-sans">
      {/* Connectivity banner — FRONTEND-REQUIREMENTS.md §4.9 */}
      <NetworkBanner />

      {/* Top App Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={(tab) => {
          if (tab === "profile") setTargetProfileUserId(null);
          setActiveTab(tab);
        }}
        unreadCount={unreadCount}
      />

      {/* Main Tab Screen */}
      <main className="flex-1 w-full flex flex-col">
        {activeTab === "feed" && (
          <FeedPage
            onOpenCreatorProfile={handleOpenCreatorProfile}
            onOpenOnboarding={() => setIsOnboardingOpen(true)}
          />
        )}
        {activeTab === "explore" && (
          <ExplorePage onOpenFeed={() => setActiveTab("feed")} />
        )}
        {activeTab === "upload" && (
          <UploadPage onUploadSuccess={() => setActiveTab("feed")} />
        )}
        {activeTab === "inbox" && (
          <InboxPage onRefreshUnread={refreshUnreadCount} />
        )}
        {activeTab === "profile" && (
          <ProfilePage
            targetUserId={targetProfileUserId}
            onBackToMyProfile={handleBackToMyProfile}
          />
        )}
      </main>

      {/* Persistent Mini Player (visible on other tabs when audio is loaded) */}
      {activeTab !== "feed" && (
        <MiniPlayer onOpenFeed={() => setActiveTab("feed")} />
      )}

      {/* Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        setActiveTab={(tab) => {
          if (tab === "profile") setTargetProfileUserId(null);
          setActiveTab(tab);
        }}
        unreadCount={unreadCount}
      />

      {/* Cold Start Vector Onboarding Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onInitialized={() => {
          setIsOnboardingOpen(false);
          setActiveTab("feed");
        }}
      />
    </div>
  );
};

/**
 * Gate between the authenticated app and the login page.
 *
 * The session notice lives here rather than inside `MainContent` because
 * session expiry is the event that *causes* `MainContent` to render
 * `LoginPage` — a notice rendered inside the authenticated tree would be torn
 * down by the very transition it needs to explain.
 */
const AuthenticatedApp: React.FC = () => {
  const { message, dismiss } = useSessionAnnouncer();
  const { isAuthenticated } = useAuth();

  return (
    <>
      <SessionNotice message={message} onDismiss={dismiss} />
      {isAuthenticated ? <MainContent /> : <LoginPage />}
    </>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <PlayerProvider>
          <AuthenticatedApp />
        </PlayerProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
