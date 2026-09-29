import { Home, Compass, Plus, Bell, User } from 'lucide-react';

interface Props {
  page: string;
  go: (p: string, params?: Record<string, unknown>) => void;
  unread: number;
}

const tabs = [
  { id: 'feed', icon: Home, label: 'Home' },
  { id: 'explore', icon: Compass, label: 'Explore' },
  { id: 'create', icon: Plus, label: null as string | null },
  { id: 'inbox', icon: Bell, label: 'Inbox' },
  { id: 'profile', icon: User, label: 'Profile' },
];

export function BottomNav({ page, go, unread }: Props) {
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
      background: 'rgba(18, 20, 22, 0.85)',
      backdropFilter: 'blur(20px)',
      ['-webkit-backdropFilter']: 'blur(20px)',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-around',
      padding: '8px 0 max(12px, env(safe-area-inset-bottom))'
    }}>
      {tabs.map(t => {
        const active = page === t.id;
        const I = t.icon;
        if (!t.label) {
          return (
            <button key={t.id} onClick={() => go('create')} style={{
              width: 48, height: 48, borderRadius: 'var(--radius-full)', border: 'none',
              background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 18px rgba(232, 168, 124, 0.3)',
              cursor: 'pointer'
            }}>
              <Plus size={22} color="#000" strokeWidth={2.5} />
            </button>
          );
        }
        return (
          <button key={t.id} onClick={() => go(t.id)} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            background: 'none', border: 'none', padding: '4px 16px', position: 'relative',
            cursor: 'pointer'
          }}>
            {t.id === 'inbox' && unread > 0 && (
              <div style={{
                position: 'absolute', top: 0, right: 6,
                minWidth: 18, height: 18, borderRadius: 'var(--radius-full)',
                background: 'var(--error)', color: '#fff',
                fontSize: 9, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px'
              }}>{unread > 9 ? '9+' : unread}</div>
            )}
            <I size={22} color={active ? 'var(--terracotta)' : 'var(--outline)'}
              fill={active ? 'var(--terracotta)' : 'none'} strokeWidth={active ? 2.5 : 2} />
            <span style={{
              fontSize: 9, fontWeight: active ? 700 : 500,
              letterSpacing: '0.06em', textTransform: 'uppercase',
              color: active ? 'var(--terracotta)' : 'var(--outline)'
            }}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
