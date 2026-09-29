import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { AudioClip } from '../types';
import { ReelList } from '../components/feed/ReelList';
import { FeedSkeleton } from '../components/common/molecules';
import { fetchSuggestions } from '../data/feedAdapter';
import { VIBE_TAGS, DISCOVERY_HUBS } from '../data/demo';
import { useNavigation } from '../context/NavigationContext';

const VIBE_COLORS: Record<string, string> = {
  'Deep Focus': '#00e5a0',
  Comedy: '#f59e0b',
  'Morning Calm': '#60a5fa',
  Chill: '#8b5cf6',
  Energy: '#ff6b35',
  Sleep: '#a78bfa',
  Motivation: '#ffd166',
};

export function ExplorePage() {
  const { go } = useNavigation();
  const [query, setQuery] = useState('');
  const [activeVibe, setActiveVibe] = useState<string | null>(null);
  const [activeHub, setActiveHub] = useState<string | null>(null);
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadCategory = async (cat: string) => {
    setLoading(true); setErr(null); setClips([]);
    try {
      const data = await fetchSuggestions(cat);
      setClips(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed';
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeHub) {
      loadCategory(activeHub === 'trending' ? 'music' : activeHub === 'science' ? 'science' : activeHub === 'laugh' ? 'funny' : 'instrumental');
    }
  }, [activeHub]);

  return (
    <div style={{ padding: '56px 14px 100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800,
          letterSpacing: '0.03em', color: 'var(--on-surface)'
        }}>DISCOVER</h1>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 24 }}>
        <Search size={18} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--outline)' }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Artists, moods, or podcasts"
          style={{
            width: '100%', padding: '12px 16px 12px 40px', borderRadius: 16, fontSize: 15,
            background: 'var(--surface)', border: '1px solid var(--border)',
            color: 'var(--on-surface)', fontFamily: 'var(--font-body)'
          }}
        />
      </div>

      {/* Vibe Check */}
      <div style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>
          VIBE CHECK
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {VIBE_TAGS.map(v => {
            const sel = activeVibe === v;
            const col = VIBE_COLORS[v] || 'var(--terracotta)';
            return (
              <button key={v} onClick={() => { setActiveVibe(v); loadCategory('music'); }} style={{
                padding: '9px 18px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                letterSpacing: '0.04em',
                background: sel ? `${col}18` : 'var(--surface-container)',
                color: sel ? col : 'var(--on-surface-variant)',
                border: sel ? `1px solid ${col}44` : '1px solid var(--border)',
                transition: 'all 0.2s', cursor: 'pointer'
              }}>{v}</button>
            );
          })}
        </div>
      </div>

      {/* Discovery Hubs */}
      <div style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase' }}>
          DISCOVERY HUBS
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140, 1fr))', gap: 12 }}>
          {DISCOVERY_HUBS.map(h => {
            const sel = activeHub === h.id;
            return (
              <button key={h.id} onClick={() => setActiveHub(h.id)} style={{
                padding: 16, borderRadius: 'var(--radius-xl)', fontSize: 13, fontWeight: 600,
                background: sel ? h.color + '18' : 'var(--surface)',
                color: sel ? h.color : 'var(--on-surface)',
                border: sel ? `1px solid ${h.color}44` : '1px solid var(--border)',
                textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                boxShadow: sel ? `0 0 20px ${h.color}18` : 'none',
                display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center'
              }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: h.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: h.color, animation: sel ? 'pulse-soft 2s infinite' : 'none' }} />
                </div>
                <span>{h.title}</span>
                <span style={{ fontSize: 10, color: 'var(--outline)', fontWeight: 400 }}>{h.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Feed */}
      {loading && !clips.length ? <FeedSkeleton /> :
        <ReelList clips={clips} loading={false} err={err} hasMore={false}
          onProfileClick={(id: number) => go('profile', { userId: id })} />
      }
      {!loading && !err && clips.length === 0 && activeHub && (
        <p style={{ padding: '40px 0', textAlign: 'center', color: 'var(--on-surface-variant)', fontSize: 13 }}>
          No reels found in this hub. Try another vibe.
        </p>
      )}
    </div>
  );
}