import { useEffect, useRef, useCallback } from 'react';
import { AudioClip } from '../../types';
import { usePlayer } from '../../stores/player';
import { ReelCard } from '../audio/ReelCard';

interface Props {
  clips: AudioClip[];
  loading: boolean;
  err: string | null;
  hasMore: boolean;
  loadMore?: () => void;
  retry?: () => void;
  onProfileClick?: (id: number) => void;
}

const ITEM_HEIGHT = 'calc(100vh - 80px)';

export function ReelList({ clips, loading, err, hasMore, loadMore, onProfileClick }: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { active, progress, play } = usePlayer();
  const activeIdRef = useRef(active?.id);
  useEffect(() => { activeIdRef.current = active?.id; }, [active?.id]);

  const retry = useCallback(() => window.location.reload(), []);

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !loadMore) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loading) loadMore();
    }, { threshold: 0.1 });
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [clips.length, hasMore, loading, loadMore]);

  // Auto-advance after completion (1s delay)
  useEffect(() => {
    if (active && progress >= 0.99) {
      const idx = clips.findIndex(c => c.id === active.id);
      if (idx >= 0 && idx < clips.length - 1) {
        const timer = setTimeout(() => {
          const next = itemRefs.current[idx + 1];
          next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [active, progress, clips]);

  // Auto-play on view
  useEffect(() => {
    if (!clips.length) return;
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const idx = Number((entry.target as HTMLElement).dataset.index);
          const clip = clips[idx];
          if (activeIdRef.current !== clip.id) {
            play(clip);
          }
        }
      });
    }, { threshold: 0.6 });
    itemRefs.current.forEach(ref => ref && obs.observe(ref));
    return () => obs.disconnect();
  }, [clips, play]);

  if (err && !clips.length) return <div style={{ padding: 24 }}><ErrorBox msg={err} onRetry={retry} /></div>;
  if (!loading && !clips.length) return <EmptyState />;

  return (
    <div style={{
      height: ITEM_HEIGHT,
      overflowY: 'auto', scrollSnapType: 'y mandatory',
      display: 'flex', flexDirection: 'column',
      padding: '0 0 80px', scrollbarWidth: 'none'
    }}>
      <style dangerouslySetInnerHTML={{ __html: 'div::-webkit-scrollbar{display:none}' }} />
      {clips.map((clip, i) => (
        <div
          key={clip.id}
          data-index={i}
          ref={el => { itemRefs.current[i] = el; if (i === clips.length - 2) sentinelRef.current = el; }}
          style={{
            flex: `0 0 ${ITEM_HEIGHT}`, scrollSnapAlign: 'center',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            position: 'relative', minHeight: ITEM_HEIGHT
          }}
        >
          <div style={{ maxWidth: 480, width: '100%', margin: '0 auto', height: ITEM_HEIGHT, display: 'flex', alignItems: 'center' }}>
            <ReelCard clip={clip} onProfileClick={onProfileClick} />
          </div>
        </div>
      ))}
      {loading && (
        <div style={{ flex: `0 0 ${ITEM_HEIGHT}`, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div className="skeleton" style={{ height: 4, width: '60%', borderRadius: 2, margin: '24px auto' }} />
        </div>
      )}
      {!hasMore && clips.length > 0 && (
        <p style={{ flex: '0 0 100%', textAlign: 'center', color: 'var(--outline)', fontSize: 12, letterSpacing: '0.06em', padding: 24 }}>
          -- ALL CAUGHT UP --
        </p>
      )}
    </div>
  );
}

function ErrorBox({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p style={{ fontSize: 14, color: 'var(--on-surface-variant)' }}>{msg}</p>
      <button onClick={onRetry} style={{
        padding: '8px 20px', borderRadius: 'var(--radius-full)', fontSize: 13, fontWeight: 700,
        background: 'var(--terracotta)', color: '#000', border: 'none', cursor: 'pointer'
      }}>Retry</button>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: 'center', padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-full)', background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--outline)" strokeWidth="2">
          <path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v2" />
        </svg>
      </div>
      <p style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--on-surface)' }}>Nothing here yet</p>
      <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', maxWidth: 220, lineHeight: 1.5, textAlign: 'center' }}>Check back soon for fresh audio reels</p>
    </div>
  );
}