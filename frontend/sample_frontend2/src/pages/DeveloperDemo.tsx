import { useState, useEffect } from 'react';
import { Headphones, Activity, Zap, Wifi, Music } from 'lucide-react';
import { DEMO_CREATORS, DEMO_CLIPS } from '../data/demo';
import { ReelList } from '../components/feed/ReelList';
import { Avatar } from '../components/common/atoms';
import { useNavigation } from '../context/NavigationContext';

export function DeveloperDemoPage() {
  const { go } = useNavigation();
  const [backendStatus, setBackendStatus] = useState<'connected' | 'demo' | 'checking'>('checking');
  const [apiEndpoint, setApiEndpoint] = useState('');

  useEffect(() => {
    const apiBase = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:8005';
    setApiEndpoint(apiBase);

    const controller = new AbortController();
    const timeout = setTimeout(() => setBackendStatus('demo'), 3000);

    fetch(`${apiBase}/profile/me/`, { signal: controller.signal, credentials: 'include' })
      .then(r => setBackendStatus(r.ok || r.status === 401 ? 'connected' : 'demo'))
      .catch(() => setBackendStatus('demo'));

    return () => { clearTimeout(timeout); controller.abort(); };
  }, []);

  return (
    <div style={{ padding: '56px 14px 100px' }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800,
            letterSpacing: '0.03em', color: 'var(--on-surface)'
          }}>DEVELOPER DEMO</h1>
          <span style={{
            padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: backendStatus === 'connected' ? 'rgba(0,229,160,0.15)' : 'rgba(255,107,53,0.15)',
            color: backendStatus === 'connected' ? 'var(--sage)' : 'var(--terracotta)'
          }}>
            {backendStatus === 'checking' ? 'CHECKING...' : backendStatus === 'connected' ? 'BACKEND CONNECTED' : 'DEMO MODE'}
          </span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginBottom: 4 }}>
          API endpoint: <span style={{ color: 'var(--terracotta)', fontFamily: 'monospace' }}>{apiEndpoint}</span>
        </p>
        <p style={{ fontSize: 11, color: 'var(--outline)' }}>
          {backendStatus === 'connected' ? 'Recommendation engine: Active (vector similarity + engagement velocity)' : 'Recommendation engine: Demo fallback (seeded data)'}
        </p>
      </div>

      {/* Pipeline status */}
      <div style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>AUDIO PIPELINE STATUS</p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <PipelineStep label="Upload" icon={Music} status="done" />
          <PipelineStep label="Acoustic analysis" icon={Activity} status="done" />
          <PipelineStep label="Transcription" icon={Headphones} status="done" />
          <PipelineStep label="Semantic embedding" icon={Zap} status="processing" />
          <PipelineStep label="HLS transcoding" icon={Wifi} status="pending" />
        </div>
      </div>

      {/* Demo creators */}
      <div style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>DEMO CREATORS</p>
        <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 4, scrollbarWidth: 'none' }}>
          {DEMO_CREATORS.map(c => (
            <button key={c.id} onClick={() => go('profile', { userId: c.id })} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              background: 'var(--surface)', borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--border)', padding: 16, minWidth: 90, cursor: 'pointer',
              transition: 'all 0.2s'
            }}>
              <Avatar name={c.username} size={48} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--on-surface)' }}>@{c.username}</span>
              <span style={{ fontSize: 10, color: 'var(--outline)' }}>{c.followers_count && (c.followers_count / 1000).toFixed(1) + 'K'} followers</span>
            </button>
          ))}
        </div>
      </div>

      {/* Demo interactions */}
      <div style={{ marginBottom: 28 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>DEMO INTERACTIONS</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ padding: '6px 14px', borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--on-surface-variant)' }}>
            Likes: enabled (optimistic UI)
          </span>
          <span style={{ padding: '6px 14px', borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--on-surface-variant)' }}>
            Follows: enabled
          </span>
          <span style={{ padding: '6px 14px', borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--on-surface-variant)' }}>
            Comments: enabled
          </span>
          <span style={{ padding: '6px 14px', borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--on-surface-variant)' }}>
            Shares: to inbox or copy link
          </span>
        </div>
      </div>

      {/* Demo feed */}
      <div>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>DEMO FEED</p>
        <ReelList clips={DEMO_CLIPS} loading={false} err={null} hasMore={false} onProfileClick={(id: number) => go('profile', { userId: id })} />
      </div>
    </div>
  );
}

function PipelineStep({ label, icon: Icon, status }: { label: string; icon: React.ElementType; status: 'done' | 'processing' | 'pending' }) {
  const colors = {
    done: { bg: 'var(--sage)', text: 'var(--sage)' },
    processing: { bg: 'var(--terracotta)', text: 'var(--terracotta)' },
    pending: { bg: 'var(--outline)', text: 'var(--outline)' },
  };
  const col = colors[status];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', minWidth: 150 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: col.bg, flexShrink: 0, boxShadow: status === 'processing' ? `0 0 8px ${col.bg}` : 'none' }} />
      <Icon size={14} color={col.text} />
      <span style={{ fontSize: 11, color: col.text, fontWeight: status === 'processing' ? 700 : 500 }}>{label}</span>
    </div>
  );
}