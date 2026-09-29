import { ReactNode } from 'react';

interface BtnProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  sm?: boolean;
  ghost?: boolean;
  danger?: boolean;
  fill?: boolean;
  style?: React.CSSProperties;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
}

export function Btn({ children, onClick, disabled, sm, ghost, danger, fill, style, className, type }: BtnProps) {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: sm ? '8px 18px' : '12px 24px',
    borderRadius: 'var(--radius-full)',
    fontSize: sm ? 12 : 14, fontWeight: 600,
    border: ghost || danger ? '1px solid ' + (danger ? 'rgba(255,180,171,0.3)' : 'var(--outline)') : 'none',
    background: disabled ? 'var(--surface-container-high)'
      : fill ? 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))'
      : danger ? 'rgba(255,180,171,0.1)'
      : ghost ? 'transparent'
      : 'var(--surface-container)',
    color: disabled ? 'var(--outline)'
      : fill ? '#000'
      : danger ? 'var(--error)'
      : ghost ? 'var(--on-surface-variant)'
      : 'var(--on-surface)',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'all 0.2s ease', fontFamily: 'var(--font-body)',
    ...style
  };
  return <button type={type || 'button'} onClick={onClick} disabled={disabled} className={className} style={base}>{children}</button>;
}

export function EmptyBox({ icon: Icon, title, sub, action }: {
  icon: React.ElementType; title: string; sub: string; action?: ReactNode
}) {
  return (
    <div className="fade-up" style={{ textAlign: 'center', padding: '56px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-full)', background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={28} color="var(--outline)" />
      </div>
      <p style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--on-surface)' }}>{title}</p>
      <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', maxWidth: 220, lineHeight: 1.5 }}>{sub}</p>
      {action}
    </div>
  );
}

export function ErrBox({ msg, retry }: { msg: string; retry?: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p style={{ fontSize: 14, color: 'var(--on-surface-variant)' }}>{msg}</p>
      {retry && <Btn sm onClick={retry}>Retry</Btn>}
    </div>
  );
}

export function ReelSkeleton() {
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', border: '1px solid var(--outline-variant)' }}>
      <div className="skeleton" style={{ height: 200, borderRadius: 0 }} />
      <div style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="skeleton" style={{ height: 20, width: '75%' }} />
        <div className="skeleton" style={{ height: 14, width: '50%' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 'var(--radius-full)' }} />
          <div className="skeleton" style={{ height: 12, width: '35%' }} />
        </div>
        <div className="skeleton" style={{ height: 4, width: '100%', marginTop: 8 }} />
      </div>
    </div>
  );
}

export function FeedSkeleton() {
  return (
    <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {[1, 2, 3].map(i => <ReelSkeleton key={i} />)}
    </div>
  );
}

export function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
