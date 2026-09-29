import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { useBackendStatus } from '../hooks/useBackendStatus';
import { LoginPage } from '../pages/Login';
import { FeedPage } from '../pages/Feed';
import { ExplorePage } from '../pages/Explore';
import { ProfilePage } from '../pages/Profile';
import { InboxPage } from '../pages/Inbox';
import { LibraryPage } from '../pages/Library';
import { UploadPage } from '../pages/Upload';
import { SettingsPage } from '../pages/Settings';
import { DeveloperDemoPage } from '../pages/DeveloperDemo';
import { AppShell } from './AppShell';
import { setBackendStatus } from '../data/feedAdapter';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { authed } = useAuth();
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicClipRedirect() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id } = useParams();
  // ISSUE-14: Redirect to feed (public endpoint handled by backend /clips/{id}/public/)
  return <Navigate to="/feed" replace />;
}

function RootRedirect() {
  const { authed } = useAuth();
  return authed ? <Navigate to="/feed" replace /> : <Navigate to="/login" replace />;
}

function LoginRouter() {
  return <LoginPage onSuccess={(p) => { window.location.href = '/' + (p === 'explore' ? 'explore' : 'feed'); }} />;
}

function ProfilePageWrapper() {
  const { userId } = useParams();
  return <ProfilePage userId={userId ? Number(userId) : undefined} />;
}

function BackendWatcher() {
  const status = useBackendStatus();
  useEffect(() => {
    if (status !== null) setBackendStatus(!!status);
  }, [status]);
  return null;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginRouter />} />
        <Route path="/dev/demo" element={<RequireAuth><AppShell page="devdemo"><DeveloperDemoPage /></AppShell></RequireAuth>} />
        <Route path="/" element={<RootRedirect />} />
        <Route path="/feed" element={<RequireAuth><AppShell page="feed"><FeedPage /></AppShell></RequireAuth>} />
        <Route path="/explore" element={<RequireAuth><AppShell page="explore"><ExplorePage /></AppShell></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><AppShell page="profile"><ProfilePageWrapper /></AppShell></RequireAuth>} />
        <Route path="/profile/:userId" element={<RequireAuth><AppShell page="profile"><ProfilePageWrapper /></AppShell></RequireAuth>} />
        <Route path="/inbox" element={<RequireAuth><AppShell page="inbox"><InboxPage /></AppShell></RequireAuth>} />
        <Route path="/library" element={<RequireAuth><AppShell page="library"><LibraryPage /></AppShell></RequireAuth>} />
        <Route path="/upload" element={<RequireAuth><AppShell page="upload"><UploadPage /></AppShell></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><AppShell page="settings"><SettingsPage /></AppShell></RequireAuth>} />
        <Route path="/public/clips/:id" element={<PublicClipRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BackendWatcher />
    </BrowserRouter>
  );
}