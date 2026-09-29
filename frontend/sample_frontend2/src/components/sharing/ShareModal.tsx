import { useState, useRef } from 'react';
import { X, Send, Check, Copy } from 'lucide-react';
import { AudioClip } from '../../types';
import { shareAPI } from '../../api/client';
import { useToast } from '../../stores/toast';
import { Avatar } from '../common/atoms';
import { inputStyle } from '../common/atoms';
import { DEMO_MODE } from '../../data/demo';
import { Spinner } from '../common/atoms';

interface Props { clip: AudioClip; onClose: () => void; }

export function ShareModal({ clip, onClose }: Props) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [resolved, setResolved] = useState<{ id: number; username: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const link = clip.hls_playlist_url ? clip.hls_playlist_url : `${window.location.origin}/public/clips/${clip.id}`;

  const onUsernameChange = (val: string) => {
    setUsername(val);
    setResolved(null);
    setSearchErr(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!val.trim() || val.length < 2) return;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        if (DEMO_MODE) {
          setResolved({ id: 1, username: val.trim() });
        } else {
          const d = await shareAPI.findUser(val.trim());
          setResolved(d);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setSearchErr(msg);
      } finally {
        setSearching(false);
      }
    }, 500);
  };

  const send = async () => {
    if (!resolved || sending) return;
    setSending(true);
    try {
      if (!DEMO_MODE) await shareAPI.sendShare(clip.id, resolved.id);
      setDone(true);
      toast(`Shared with @${resolved.username}`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Send failed';
      toast(msg, 'error');
    } finally {
      setSending(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast('Link copied', 'success');
    } catch {
      toast('Could not copy link', 'error');
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 800,
      background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div className="fade-up" onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 360, background: 'var(--surface)',
        borderRadius: 20, padding: 24, border: '1px solid var(--border)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, letterSpacing: '0.04em' }}>SHARE</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--on-surface-variant)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Link copy */}
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--outline)', letterSpacing: '0.08em', marginBottom: 6 }}>COPY LINK</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={link} readOnly style={{ ...inputStyle, flex: 1, padding: '6px 10px', fontSize: 11, borderRadius: 8 }} />
            <button onClick={copyLink} style={{
              width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: copied ? 'var(--sage)' : 'var(--on-surface-variant)'
            }}>
              {copied ? <Check size={14} color="var(--sage)" /> : <Copy size={14} />}
            </button>
          </div>
        </div>

        {!done ? (
          <>
            <p style={{ fontSize: 12, color: 'var(--on-surface-variant)', marginBottom: 8 }}>Send to a friend</p>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--outline)', fontSize: 14, fontWeight: 600 }}>@</div>
              <input value={username} onChange={e => onUsernameChange(e.target.value)}
                placeholder="username" autoFocus
                onKeyDown={e => e.key === 'Enter' && send()}
                style={{ ...inputStyle, width: '100%', paddingLeft: 28,
                  borderColor: resolved ? 'rgba(170,208,177,0.4)'
                    : searchErr ? 'rgba(255,180,171,0.4)' : 'var(--outline-variant)'
                }} />
              <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
                {searching && <Spinner size={14} color="var(--terracotta)" />}
                {resolved && !searching && <Check size={14} color="var(--sage)" />}
              </div>
            </div>

            {resolved && (
              <div className="fade-up" style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', borderRadius: 10, marginBottom: 12,
                background: 'rgba(170,208,177,0.08)', border: '1px solid rgba(170,208,177,0.2)'
              }}>
                <Avatar name={resolved.username} size={32} />
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--on-surface)' }}>@{resolved.username}</p>
              </div>
            )}

            {searchErr && <p style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{searchErr}</p>}

            <button onClick={send} disabled={!resolved || sending} style={{
              width: '100%', padding: '12px', borderRadius: 12, border: 'none',
              background: resolved ? 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))' : 'var(--surface-container)',
              color: resolved ? '#000' : 'var(--outline)',
              fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 800,
              letterSpacing: '0.04em', cursor: resolved ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
            }}>
              {sending ? <Spinner size={16} color="#000" /> : <><Send size={14} /> SEND</>}
            </button>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{
              width: 48, height: 48, borderRadius: 24,
              background: 'rgba(170,208,177,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px'
            }}>
              <Check size={22} color="var(--sage)" />
            </div>
            <p style={{ fontSize: 14, color: 'var(--sage)', fontWeight: 600 }}>Sent to @{resolved?.username}</p>
          </div>
        )}
      </div>
    </div>
  );
}
