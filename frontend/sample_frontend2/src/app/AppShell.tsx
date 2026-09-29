import { useState, useEffect } from 'react';
import { useAuth } from '../stores/auth';
import { BottomNav } from '../components/navigation/BottomNav';
import { MiniPlayer } from '../components/feed/MiniPlayer';
import { NetworkBanner } from '../components/common/NetworkBanner';
import { OnboardingModal } from '../components/feed/OnboardingModal';
import { shareAPI } from '../api/client';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

interface Props { page: string; children: React.ReactNode; }

export function AppShell({ page, children }: Props) {
  const { authed } = useAuth();
  const { go } = useNavigation();
  const demo = useDemoMode();

  const [unread, setUnread] = useState(0);
  const [onboarding, setOnboarding] = useState(false);

  useEffect(() => {
    // Router already guards with RequireAuth, but keep defensive check
    if (!authed) return;
    const poll = () => {
      if (demo) return;
      shareAPI.getUnread().then(d => {
        // Handle both { unread } and { count } response shapes
        const response = d as { unread?: number; count?: number };
        const count = response.unread ?? response.count ?? 0;
        setUnread(count);
      }).catch(() => {});
    };
    poll();
    const intervalId = setInterval(poll, 30000);
    return () => clearInterval(intervalId);
  }, [authed, demo]);

  useEffect(() => {
    if (authed && sessionStorage.getItem('ef_new_user') === '1') {
      sessionStorage.removeItem('ef_new_user');
      setOnboarding(true);
    }
  }, [authed]);

  return (
    <>
      <div className="scan-line" />
      <NetworkBanner />
      <div key={page} className="page-in" style={{ maxWidth: 470, margin: '0 auto', minHeight: '100vh', position: 'relative' }}>
        {children}
      </div>
      <MiniPlayer />
      <BottomNav page={page} go={go} unread={unread} />
      {onboarding && <OnboardingModal onDone={() => setOnboarding(false)} />}
    </>
  );
}