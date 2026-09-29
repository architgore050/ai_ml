import { useState, useEffect } from 'react';
import { ArrowLeft, Sun, Moon, Edit3, Check } from 'lucide-react';
import { AudioClip, UserProfile } from '../types';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { useToast } from '../stores/toast';
import { profileAPI, followAPI, clipsAPI } from '../api/client';
import { Avatar } from '../components/common/atoms';
import { ReelList } from '../components/feed/ReelList';
import { fetchProfile } from '../data/feedAdapter';
import { useDemoMode } from '../context/DemoModeContext';
import { useNavigation } from '../context/NavigationContext';

interface Props { userId?: number; }

export function ProfilePage({ userId: targetId }: Props) {
  const { go } = useNavigation();
  const { user: au, patchUser, logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const isOwn = !targetId || targetId === au?.id;
  const demo = useDemoMode();

  const [prof, setProf] = useState<UserProfile | null>(null);
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'uploads' | 'liked'>('uploads');
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [following, setFollowing] = useState(false);

  const toast = useToast();

  useEffect(() => {
    setLoading(true); setErr(null);
    const load = async () => {
      try {
        if (demo) {
          const p = await fetchProfile(targetId);
          setProf(p.profile);
          setClips(p.clips);
          setNewName(p.profile.username || '');
        } else if (isOwn) {
          const p = await profileAPI.getMyProfile();
          setProf(p);
          const cd = await clipsAPI.getUserClips(au?.id || 0);
          setClips(cd.results || []);
          setNewName(p.username || '');
        } else {
          const p = await profileAPI.getProfile(Number(targetId));
          setProf(p);
          const cd = await clipsAPI.getUserClips(Number(targetId));
          setClips(cd.results || []);
          setNewName(p.username || '');
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Error';
        setErr(msg);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [targetId, demo, isOwn, au?.id]);

  const saveName = async () => {
    if (!newName.trim() || newName === prof?.username) { setEditing(false); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('username', newName.trim());
      const d = await profileAPI.updateProfile(fd);
      setProf(p => p ? { ...p, ...d } : null);
      patchUser({ username: d.username });
      setEditing(false);
      toast('Username updated', 'success');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleFollowProfile = async () => {
    if (!prof) return;
    const orig = following;
    setFollowing(!orig);
    try {
      const d = await followAPI.toggleFollow(prof.id);
      const nowFollowing = d?.status === 'followed';
      setFollowing(nowFollowing);
       setProf(p => p ? { ...p, followers_count: (p.followers_count || 0) + (nowFollowing ? 1 : -1) } : null);
    } catch {
      setFollowing(orig);
    }
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}><div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} /></div>;
  if (err) return <div style={{ padding: 24, color: 'var(--on-surface-variant)', textAlign: 'center' }}>{err}</div>;
  if (!prof) return null;

  return (
    <div>
      {!isOwn && (
        <div style={{ padding: '54px 14px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => go('feed')} style={{ background: 'none', border: 'none', color: 'var(--on-surface)', padding: 4 }}>
            <ArrowLeft size={22} />
          </button>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 800, letterSpacing: '0.04em' }}>{prof.username}</span>
        </div>
      )}

      <div style={{ padding: isOwn ? '54px 18px 18px' : '8px 18px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ position: 'relative' }}>
            <Avatar src={(prof.profile_picture_url || prof.profile_picture)} name={prof.username} size={78} />
            {!isOwn && (
              <div style={{
                position: 'absolute', bottom: 0, right: 0, width: 18, height: 18, borderRadius: '50%',
                background: 'var(--terracotta)', border: '2px solid var(--background)',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }} />
            )}
          </div>

          {isOwn ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={toggleTheme} style={{
                width: 38, height: 38, borderRadius: 19, background: 'var(--surface)',
                border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', cursor: 'pointer', color: 'var(--on-surface-variant)'
              }}>
                {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
              </button>
              <button onClick={() => { logout(); toast('Signed out', 'info'); }} style={{
                padding: '8px 16px', borderRadius: 20, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em',
                background: 'rgba(255,77,109,0.1)', color: 'var(--error)',
                border: '1px solid rgba(255,77,109,0.2)', cursor: 'pointer'
              }}>SIGN OUT</button>
            </div>
          ) : (
            <button onClick={toggleFollowProfile} style={{
              padding: '10px 22px', borderRadius: 20, fontSize: 13, fontWeight: 800, letterSpacing: '0.04em',
              background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
              color: '#000', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-display)', boxShadow: '0 4px 16px var(--accent-glow)'
            }}>
              {following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>

        {editing ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
              onKeyDown={e => e.key === 'Enter' && saveName()}
              style={{
                flex: 1, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, padding: '8px 12px',
                background: 'var(--surface)', border: '1px solid var(--border)',
                color: 'var(--on-surface)', borderRadius: 'var(--radius-full)'
              }} />
            <button onClick={saveName} style={{
              width: 34, height: 34, borderRadius: 17, background: 'var(--terracotta)', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
            }}>
              {saving ? <div className="skeleton" style={{ width: 14, height: 14, borderRadius: '50%' }} /> : <Check size={14} color="#000" />}
            </button>
            <button onClick={() => setEditing(false)} style={{
              width: 34, height: 34, borderRadius: 17, background: 'var(--surface)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface-variant)', cursor: 'pointer'
            }}>
              <X size={14} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 900,
              letterSpacing: '0.04em', color: 'var(--on-surface)'
            }}>{prof.username}</h2>
            <span style={{ fontSize: 12, color: 'var(--outline)' }}>@{prof.username}</span>
            {isOwn && <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--outline)', padding: 4 }}>
              <Edit3 size={15} />
            </button>}
          </div>
        )}

        {prof.bio && (
          <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', lineHeight: 1.6, marginBottom: 16, maxWidth: 320 }}>
            {prof.bio}
          </p>
        )}

        {/* Stats */}
        <div style={{ display: 'flex', gap: 0, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 4 }}>
          <Stat label="UPLOADS" value={prof.uploads_count || 0} />
          <Stat label="FOLLOWERS" value={prof.followers_count || 0} />
          <Stat label="FOLLOWING" value={prof.following_count || 0} />
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 18px', marginBottom: 4 }}>
        {(isOwn ? ['uploads', 'liked'] : ['uploads']).map(t => (
          <button key={t} onClick={() => setTab(t as 'uploads' | 'liked')} style={{
            padding: '10px 0', marginRight: 24, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
            textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
            color: tab === t ? 'var(--terracotta)' : 'var(--outline)',
            borderBottom: tab === t ? '2px solid var(--terracotta)' : '2px solid transparent',
            transition: 'all 0.2s', marginBottom: -1
          }}>{t}</button>
        ))}
      </div>

      <ReelList
        clips={tab === 'uploads' ? clips : (prof.liked_clips || [])}
        loading={false} err={null} hasMore={false}
        onProfileClick={(id: number) => go('profile', { userId: id })}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ flex: 1, padding: '12px 0', textAlign: 'center', borderRight: '1px solid var(--border)' }}>
      <p style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 900, color: 'var(--on-surface)', letterSpacing: '0.02em' }}>{value}</p>
      <p style={{ fontSize: 9, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em' }}>{label}</p>
    </div>
  );
}

function X({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}