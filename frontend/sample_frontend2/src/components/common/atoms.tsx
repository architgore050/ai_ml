import { resolveMediaUrl } from '../../api/client';

export function Spinner({ size = 20, color = 'var(--terracotta)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'spin 0.8s linear infinite' }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke={color} strokeWidth="2.5"
        strokeLinecap="round" strokeDasharray="50" strokeDashoffset="15" />
    </svg>
  );
}

export function Waves({ on, color = 'var(--terracotta)', bars = 7 }: { on?: boolean; color?: string; bars?: number }) {
  const heights = [10, 16, 12, 18, 12, 16, 10];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 18 }}>
      {Array.from({ length: bars }).map((_, i) => (
        <div key={i} className={on ? 'wave-bar' : ''} style={{
          width: 3, height: on ? heights[i % heights.length] : 4, borderRadius: 2,
          background: color, opacity: on ? 1 : 0.3,
          transition: 'height 0.3s ease'
        }} />
      ))}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 16px', borderRadius: 'var(--radius-full)', fontSize: 14,
  background: 'var(--surface-container)', border: '1px solid var(--outline-variant)',
  color: 'var(--on-surface)', outline: 'none',
  transition: 'border-color 0.2s', fontFamily: 'var(--font-body)'
};

export function Avatar({ src, name, size = 36 }: { src?: string | null; name?: string; size?: number }) {
  const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
  const url = src ? (src.startsWith('http') ? src : resolveMediaUrl(src) || apiBase + src) : null;
  return (
    <div style={{
      width: size, height: size, borderRadius: 'var(--radius-full)', overflow: 'hidden', flexShrink: 0,
      background: url ? 'transparent' : 'linear-gradient(135deg, var(--terracotta), var(--inverse-primary))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: '#fff',
      border: '1.5px solid var(--outline-variant)'
    }}>
      {url
        ? <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={name}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        : <span>{(name || '?')[0]?.toUpperCase()}</span>
      }
    </div>
  );
}

export function CatBadge({ category, color }: { category: string; color?: string }) {
  const c = color || 'var(--terracotta)';
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      background: `${c}18`, color: c, border: `1px solid ${c}33`
    }}>{category || 'Audio'}</span>
  );
}