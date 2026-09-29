import { useState, useEffect } from 'react';
import { Pause, Play } from 'lucide-react';
import { usePlayer } from '../../stores/player';
import { Waves } from '../common/atoms';
import { getCatColor } from '../../data/clips';

export function MiniPlayer() {
  const { active, playing, progress, play, pause } = usePlayer();
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (active) setVisible(true); }, [active]);
  if (!visible || !active) return null;

  const c = getCatColor(active.category);

  return (
    <div style={{
      position: 'fixed', top: 12, left: 12, right: 12, zIndex: 190,
      background: 'rgba(18, 20, 22, 0.7)',
      backdropFilter: 'blur(20px)',
      ['-webkit-backdropFilter']: 'blur(20px)',
      borderRadius: 'var(--radius-xl)',
      border: '1px solid rgba(255,255,255,0.08)',
      overflow: 'hidden',
      animation: 'fadeUp 0.3s ease forwards'
    }}>
      {/* Progress bar (2px, expands on hover) */}
      <div style={{
        height: 2, background: 'rgba(255,255,255,0.08)', position: 'absolute', top: 0, left: 0, right: 0,
        transition: 'height 0.2s ease', cursor: 'pointer'
      }}
        onMouseEnter={e => { (e.target as HTMLElement).style.height = '6px'; }}
        onMouseLeave={e => { (e.target as HTMLElement).style.height = '2px'; }}
      >
        <div style={{
          height: '100%', width: `${progress * 100}%`,
          background: `linear-gradient(90deg, ${c}, var(--terracotta))`,
          transition: 'width 0.1s linear', borderRadius: 'var(--radius-full)'
        }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
        {/* Album art placeholder */}
        <div style={{
          width: 44, height: 44, borderRadius: 'var(--radius-md)', flexShrink: 0,
          background: `${c}18`, border: `1px solid ${c}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill={c}>
            <path d="M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
          </svg>
        </div>

        {/* Track info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 14, fontWeight: 600, color: 'var(--on-surface)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--font-display)'
          }}>{active.title}</p>
          <p style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginTop: 1 }}>{active.creator_name}</p>
        </div>

        {/* Playing indicator */}
        {playing && <Waves on={true} color={c} />}

        {/* Play/Pause button */}
        <button onClick={() => playing ? pause() : play(active)} style={{
          width: 40, height: 40, borderRadius: 'var(--radius-full)', border: 'none', flexShrink: 0,
          background: playing ? c : 'var(--surface-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: playing ? `0 0 16px ${c}44` : 'none', transition: 'all 0.2s',
          cursor: 'pointer'
        }}>
          {playing
            ? <Pause size={16} fill="#000" color="#000" />
            : <Play size={16} fill={c} color={c} style={{ marginLeft: 2 }} />
          }
        </button>

        {/* Close button */}
        <button onClick={() => { pause(); setVisible(false); }} style={{
          width: 32, height: 32, borderRadius: 'var(--radius-full)', border: '1px solid rgba(255,255,255,0.1)',
          background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--outline)', flexShrink: 0, cursor: 'pointer', transition: 'all 0.2s'
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
