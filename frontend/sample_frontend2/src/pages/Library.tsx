import { useEffect, useState } from 'react';
import { Bookmark, History } from 'lucide-react';
import { AudioClip } from '../types';
import { ReelList } from '../components/feed/ReelList';
import { DEMO_CLIPS } from '../data/demoClips';
import { profileAPI } from '../api/client';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

type Tab = 'liked' | 'saved' | 'recent';

export function LibraryPage() {
  const { go } = useNavigation();
  const [tab, setTab] = useState<Tab>('liked');
  const [liked, setLiked] = useState<AudioClip[]>([]);
  const [saved, setSaved] = useState<AudioClip[]>([]);
  const [loading, setLoading] = useState(true);
  const demo = useDemoMode();

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        if (demo) {
          setLiked(DEMO_CLIPS.filter(c => c.is_liked));
          setSaved(DEMO_CLIPS.slice(0, 4));
        } else {
          const p = await profileAPI.getMyProfile();
          setLiked(p.liked_clips || []);
        }
      } catch {
        setLiked(DEMO_CLIPS.filter(c => c.is_liked));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'liked', label: 'Liked', icon: Bookmark },
    { id: 'saved', label: 'Saved', icon: Bookmark },
    { id: 'recent', label: 'Recent', icon: History },
  ];

  const current = tab === 'liked' ? liked : tab === 'saved' ? saved : liked;

  return (
    <div>
      <div style={{ padding: '56px 14px 14px' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800,
          letterSpacing: '0.03em', color: 'var(--on-surface)'
        }}>LIBRARY</h1>
        <p style={{ fontSize: 11, color: 'var(--outline)', letterSpacing: '0.06em', marginTop: 2 }}>
          Your saved and liked audio
        </p>
      </div>

      <div style={{ padding: '0 14px 100px' }}>
        <div style={{ display: 'flex', gap: 0, borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', padding: 4, marginBottom: 16, overflowX: 'auto' }}>
          {tabs.map(t => {
            const sel = tab === t.id;
            const I = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex: '0 0 auto', padding: '10px 18px', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase', borderRadius: 10,
                border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                background: sel ? 'var(--terracotta)' : 'transparent',
                color: sel ? '#000' : 'var(--outline)',
                transition: 'all 0.2s'
              }}><I size={14} />{t.label}</button>
            );
          })}
        </div>

        {loading
          ? <div style={{ padding: '20px' }}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton" style={{ height: 120, borderRadius: 14, marginBottom: 14 }} />)}</div>
          : current.length === 0
            ? <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--on-surface-variant)', fontSize: 13 }}>
                <Bookmark size={28} style={{ margin: '0 auto 16px', opacity: 0.5 }} />
                <p>No saved {tab === 'liked' ? 'likes' : tab === 'saved' ? 'saves' : 'history'} yet.</p>
                <p style={{ fontSize: 11, marginTop: 8 }}>Browse the feed or explore to get started.</p>
              </div>
            : <ReelList clips={current} loading={false} err={null} hasMore={false} onProfileClick={(id: number) => go('profile', { userId: id })} />
        }
      </div>
    </div>
  );
}