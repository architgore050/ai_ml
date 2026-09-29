import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { ShareEvent } from '../types';
import { shareAPI } from '../api/client';
import { ReelCard } from '../components/audio/ReelCard';
import { Avatar } from '../components/common/atoms';
import { Spinner } from '../components/common/atoms';
import { DEMO_ACTIVITY } from '../data/demo';
import { fetchInbox } from '../data/feedAdapter';
import { useNavigation } from '../context/NavigationContext';
import { useDemoMode } from '../context/DemoModeContext';

export function InboxPage() {
  const { go } = useNavigation();
  const [items, setItems] = useState<ShareEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [previewClip, setPreviewClip] = useState<ShareEvent['clip'] | null>(null);
  const [tab, setTab] = useState<'messages' | 'activity'>('messages');
  const demo = useDemoMode();

  useEffect(() => {
    setLoading(true);
    fetchInbox()
      .then(d => { setItems(d); setLoading(false); })
      .catch(e => { setErr(e.message); setLoading(false); });
  }, []);

  const open = async (item: ShareEvent) => {
    setPreviewClip(item.clip);
    if (!item.is_read) {
      if (!demo) await shareAPI.markRead(item.id).catch(() => {});
      setItems(p => p.map(x => x.id === item.id ? { ...x, is_read: true } : x));
    }
  };

  const del = (id: number) => {
    setItems(p => p.filter(x => x.id !== id));
    if (!demo) shareAPI.deleteShare(id).catch(() => {});
  };

  const unreadCnt = items.filter(i => !i.is_read).length;

  if (previewClip) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ position: 'relative', width: '100%', maxWidth: 400 }}>
          <button onClick={() => setPreviewClip(null)} style={{
            position: 'absolute', top: -48, right: 0, width: 36, height: 36, borderRadius: 18,
            background: 'var(--surface)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface)', zIndex: 10
          }}><X size={16} /></button>
          <ReelCard clip={previewClip} onProfileClick={(id: number) => { setPreviewClip(null); go('profile', { userId: id }); }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: '56px 14px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, letterSpacing: '0.03em', color: 'var(--on-surface)' }}>INBOX</h1>
        {unreadCnt > 0 && (
          <span style={{
            padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: 'rgba(255,107,53,0.12)', color: 'var(--terracotta)', letterSpacing: '0.05em'
          }}>{unreadCnt} UNREAD</span>
        )}
      </div>

      <div style={{ padding: '0 14px', marginBottom: 4 }}>
        <div style={{ display: 'flex', gap: 0, borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', padding: 4, marginBottom: 16 }}>
          {['messages', 'activity'].map(t => (
            <button key={t} onClick={() => setTab(t as 'messages' | 'activity')} style={{
              flex: 1, padding: '8px 0', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: tab === t ? 'var(--terracotta)' : 'transparent',
              color: tab === t ? '#000' : 'var(--on-surface-variant)',
              transition: 'all 0.2s'
            }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ padding: '0 14px 100px' }}>
        {loading
          ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
          : err
            ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--on-surface-variant)', fontSize: 13 }}>{err}</div>
            : tab === 'messages'
              ? renderMessages(items, open, del, demo)
              : renderActivity(demo)
        }
      </div>
    </div>
  );
}

function renderMessages(items: ShareEvent[], open: (i: ShareEvent) => void, del: (id: number) => void, _demo: boolean) {
  if (!items.length) return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--on-surface-variant)', fontSize: 13 }}>
      No messages yet. When someone shares a clip with you, it&apos;ll appear here.
    </div>
  );
  return items.map(item => (
    <div key={item.id} style={{
      background: 'var(--surface)', borderRadius: 16, marginBottom: 10, overflow: 'hidden',
      border: `1px solid ${item.is_read ? 'var(--border)' : 'var(--outline)'}`,
      cursor: 'pointer', transition: 'all 0.2s'
    }} onClick={() => open(item)}>
      <div style={{ padding: '14px', display: 'flex', gap: 12, alignItems: 'center', position: 'relative' }}>
        {!item.is_read && <div style={{
          position: 'absolute', right: 18, top: '50%', transform: 'translateY(-50%)',
          width: 7, height: 7, borderRadius: 4, background: 'var(--terracotta)',
          boxShadow: '0 0 6px var(--terracotta)'
        }} />}
        <Avatar name={item.sender_name} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)', marginBottom: 2 }}>
            <span style={{ color: 'var(--terracotta)' }}>{item.sender_name}</span> shared a clip
          </p>
          <p style={{ fontSize: 12, color: 'var(--on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.clip_title || 'Audio clip'}
          </p>
          <p style={{ fontSize: 10, color: 'var(--outline)', marginTop: 2, letterSpacing: '0.04em' }}>
            {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <button onClick={e => { e.stopPropagation(); del(item.id); }} style={{
          background: 'none', border: 'none', color: 'var(--outline)', padding: 6, flexShrink: 0
        }}><X size={15} /></button>
      </div>
    </div>
  ));
}

function renderActivity(_demo: boolean) {
  const activities = DEMO_ACTIVITY;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {activities.map(a => (
        <div key={a.id} style={{
          background: 'var(--surface)', borderRadius: 14, padding: '14px', border: '1px solid var(--border)',
          display: 'flex', gap: 12, alignItems: 'center',
          opacity: a.read ? 0.7 : 1
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: a.read ? 'var(--outline)' : 'var(--terracotta)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, color: 'var(--on-surface)', lineHeight: 1.5 }}>
              <span style={{ color: 'var(--terracotta)', fontWeight: 600 }}>{a.actor}</span> {a.target}
            </p>
            <p style={{ fontSize: 10, color: 'var(--outline)', marginTop: 2 }}>{a.time}</p>
          </div>
        </div>
      ))}
    </div>
  );
}