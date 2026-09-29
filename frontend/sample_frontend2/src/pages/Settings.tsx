import { useState, useEffect } from 'react';
import { Moon, Sun, Bell, Shield, Info, HelpCircle, LogOut, User, Globe } from 'lucide-react';
import { UserProfile } from '../types';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { DEMO_ME } from '../data/demo';
import { fetchMyProfile } from '../data/feedAdapter';
import { Avatar } from '../components/common/atoms';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

export function SettingsPage() {
  const { go } = useNavigation();
  const { user, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const [prof, setProf] = useState<UserProfile | null>(null);
  const demo = useDemoMode();

  useEffect(() => {
    if (demo) { setProf(DEMO_ME); return; }
    fetchMyProfile().then(setProf).catch(() => setProf(DEMO_ME));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows: { label: string; icon: React.ElementType; action: () => void; danger?: boolean }[] = [
    { label: 'Profile', icon: User, action: () => go('profile') },
    { label: 'Privacy', icon: Shield, action: () => {} },
    { label: 'Notifications', icon: Bell, action: () => {} },
    { label: 'Language', icon: Globe, action: () => {} },
    { label: 'Help & Feedback', icon: HelpCircle, action: () => {} },
    { label: 'About', icon: Info, action: () => {} },
  ];

  return (
    <div style={{ padding: '56px 14px 100px' }}>
      <h1 style={{
        fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800,
        letterSpacing: '0.03em', color: 'var(--on-surface)', marginBottom: 24
      }}>SETTINGS</h1>

      {/* Profile section */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: 20,
        background: 'var(--surface)', borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border)', marginBottom: 16
      }}>
        <Avatar src={prof?.profile_picture} name={prof?.username || user?.username} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--on-surface)' }}>{prof?.username || user?.username}</p>
          <p style={{ fontSize: 12, color: 'var(--on-surface-variant)' }}>{prof?.email || user?.email || 'No email set'}</p>
        </div>
      </div>

      {/* Theme */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>APPEARANCE</p>
        <div style={{ display: 'flex', gap: 0, borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', padding: 4, overflow: 'hidden' }}>
          {[
            { v: 'dark', label: 'Dark', icon: Moon },
            { v: 'light', label: 'Light', icon: Sun },
          ].map(o => {
            const sel = theme === o.v;
            const I = o.icon;
            return (
              <button key={o.v} onClick={toggleTheme} style={{
                flex: 1, padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                background: sel ? 'var(--terracotta)' : 'transparent', color: sel ? '#000' : 'var(--on-surface-variant)',
                border: 'none', cursor: 'pointer', transition: 'all 0.2s', fontSize: 12, fontWeight: 600
              }}><I size={18} />{o.label}</button>
            );
          })}
        </div>
      </div>

      {/* Settings rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px solid var(--border)', overflow: 'hidden' }}>
        {rows.map(r => (
          <button key={r.label} onClick={r.action} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
            background: 'none', border: 'none', color: 'var(--on-surface)',
            cursor: 'pointer', textAlign: 'left', fontSize: 14, fontWeight: 500,
            transition: 'all 0.2s'
          }}>
            <r.icon size={18} />
            {r.label}
          </button>
        ))}
      </div>

      {/* Demo mode indicator */}
      {demo && (
        <div style={{
          padding: '14px', borderRadius: 'var(--radius-xl)', background: 'var(--accent-soft)',
          border: '1px solid var(--terracotta)', marginBottom: 16
        }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--terracotta)', marginBottom: 4 }}>
            Developer Demo Mode
          </p>
          <p style={{ fontSize: 11, color: 'var(--on-surface-variant)' }}>
            Backend not detected. Showing demo data.
          </p>
        </div>
      )}

      {/* Sign out */}
      <button onClick={() => { logout(); go('login'); }} style={{
        display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '14px 18px',
        borderRadius: 'var(--radius-xl)', border: '1px solid rgba(255,77,109,0.2)',
        background: 'rgba(255,77,109,0.1)', color: 'var(--error)',
        cursor: 'pointer', fontSize: 14, fontWeight: 600, transition: 'all 0.2s'
      }}>
        <LogOut size={18} />
        Sign out
      </button>
    </div>
  );
}