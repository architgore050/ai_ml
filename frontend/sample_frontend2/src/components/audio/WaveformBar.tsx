import { AudioClip } from '../../types';
import { usePlayer } from '../../stores/player';
import { Waves, Spinner } from '../common/atoms';
import { formatTime } from '../common/molecules';
import { getCatColor } from '../../data/clips';

interface Props { clip: AudioClip; onProfileClick?: (id: number) => void; }

export function WaveformBar({ clip }: Props) {
  const { active, playing, progress, duration, buffered, isBuffering, play, pause, seek } = usePlayer();
  const isActive = active?.id === clip.id;
  const isPlaying = isActive && playing;
  const pct = isActive ? progress : 0;
  const buf = isActive ? buffered : 0;
  const c = getCatColor(clip.category);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isActive) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seek(fraction);
  };

  return (
    <div style={{ padding: '14px', paddingBottom: '4px' }}>
      <div onClick={handleSeek} style={{
        position: 'relative', height: 4, borderRadius: 2, background: 'var(--surface-container)',
        cursor: isActive ? 'pointer' : 'default', marginBottom: 10, overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute', height: '100%', width: `${buf * 100}%`,
          background: 'var(--surface)', filter: 'brightness(1.6)', borderRadius: 2, transition: 'width 0.3s'
        }} />
        <div style={{
          position: 'absolute', height: '100%', width: `${pct * 100}%`,
          background: `linear-gradient(90deg, ${c}, var(--terracotta))`,
          borderRadius: 2, transition: 'width 0.1s linear',
          boxShadow: isPlaying ? `0 0 6px var(--accent-glow)` : 'none'
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => isActive ? (isPlaying ? pause() : play(clip)) : play(clip)} style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, border: 'none',
          background: isPlaying ? c : 'var(--surface-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.2s ease', boxShadow: isPlaying ? `0 0 12px var(--accent-glow)` : 'none'
        }}>
          {isBuffering
            ? <Spinner size={14} color={c} />
            : isPlaying
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="black"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
              : <PlayIcon fill={isActive ? c : 'var(--outline)'} color={isActive ? c : 'var(--outline)'} />
          }
        </button>
        <div style={{ flex: 1 }}>
          <Waves on={isPlaying} color={isPlaying ? c : 'var(--outline)'} />
        </div>
        <span style={{ fontSize: 11, color: 'var(--outline)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.03em' }}>
          {isActive ? `${formatTime(duration * progress)} / ${formatTime(duration)}` : '--:--'}
        </span>
      </div>
    </div>
  );
}

function PlayIcon({ fill, color }: { fill: string; color: string }) {
  return (
    <svg width="14" height="18" viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth="1">
      <polygon points="6,4 22,12 6,20" />
    </svg>
  );
}
