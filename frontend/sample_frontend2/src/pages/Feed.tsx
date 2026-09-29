import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioClip } from '../types';
import { usePlayer } from '../stores/player';
import { useToast } from '../stores/toast';
import { ReelList } from '../components/feed/ReelList';
import { FeedSkeleton } from '../components/common/molecules';
import { fetchFeed } from '../data/feedAdapter';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

export function FeedPage() {
  const { go } = useNavigation();
  const demo = useDemoMode();
  const toast = useToast();
  const { active } = usePlayer();
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [initial, setInitial] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [degraded, setDegraded] = useState(false);

  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (isInitial = false) => {
    if (isInitial) { setInitial(true); }
    setLoading(true); setErr(null);
    try {
      const { clips: fresh, hasMore: hm, err: e, degraded, retry_after_ms, status } = await fetchFeed();
      if (e) throw new Error(e);
      // ISSUE-09: Handle 202 Accepted (cold-state retry) without polling storm.
      if (status === 202 || retry_after_ms !== undefined) {
        // Temporarily disable loadMore to prevent observer storm.
        setHasMore(false);
        // Schedule retry after server-suggested delay.
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          load(isInitial);
        }, retry_after_ms || 1500);
        // Show degraded banner only on initial load when no clips.
        setDegraded(degraded || false);
        if (isInitial && degraded) {
          toast('Feed preparing — retrying shortly', 'info');
        }
        // Do not append empty results to the list.
        setClips(p => p);
        return;
      }
      setDegraded(false);
      setClips(p => isInitial ? fresh : [...p, ...fresh]);
      setHasMore(hm);
      if (isInitial && fresh.length === 0 && !degraded) toast('Queue is empty — check back soon', 'info');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      setErr(msg);
      if (isInitial) toast('Could not load feed: ' + msg, 'error');
    } finally {
      setLoading(false);
      setInitial(false);
    }
  }, [toast]);

  useEffect(() => { load(true); }, [load]);

  useEffect(() => {
    return () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); };
  }, []);

  const loadMore = () => { if (!loading && hasMore) { load(false); } };

  return (
    <div>
      <div style={{ padding: '56px 14px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          {degraded && (
        <div style={{ padding: '8px 14px', background: 'rgba(255,180,171,0.1)', color: 'var(--error)', fontSize: 12, fontWeight: 600, borderBottom: '1px solid var(--outline-variant)' }}>Feed degraded — showing fallback content</div>
      )}
      <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 900,
            letterSpacing: '0.04em', lineHeight: 1, color: 'var(--on-surface)'
          }}>FOR YOU</h1>
          <p style={{ fontSize: 11, color: 'var(--outline)', letterSpacing: '0.06em', marginTop: 2 }}>
            {demo ? 'DEMO — connect backend for real recommendations' : 'PERSONALIZED AUDIO FEED'}
          </p>
        </div>
        {demo && active && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--terracotta)', fontWeight: 600 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--terracotta)', animation: 'pulse-soft 2s infinite' }} />
            DEMO
          </div>
        )}
      </div>
      {loading && initial
        ? <FeedSkeleton />
        : <ReelList
            clips={clips} loading={loading && !initial} err={err} retry={() => { setClips([]); setInitial(true); load(true); }}
            hasMore={hasMore} loadMore={loadMore} onProfileClick={(id: number) => go('profile', { userId: id })}
          />
      }
    </div>
  );
}