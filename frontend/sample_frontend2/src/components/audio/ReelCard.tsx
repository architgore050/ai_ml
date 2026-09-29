import { useState, useRef } from 'react';
import { Heart, MessageCircle, Share2, SkipForward, SkipBack, UserPlus, UserCheck } from 'lucide-react';
import { AudioClip } from '../../types';
import { usePlayer } from '../../stores/player';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { interactionsAPI, followAPI } from '../../api/client';
import { WaveformBar } from './WaveformBar';
import { Avatar, CatBadge } from '../common/atoms';
import { getCatColor } from '../../data/clips';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareModal } from '../sharing/ShareModal';

interface Props { clip: AudioClip; onProfileClick?: (id: number) => void; }

export function ReelCard({ clip, onProfileClick }: Props) {
  const { active, playing: globalPlaying, play, skipForward, skipBackward, listenMs, progress, duration } = usePlayer();
  const { user } = useAuth();
  const toast = useToast();
  const isActive = active?.id === clip.id;
  const isPlaying = isActive && globalPlaying;

  const [liked, setLiked] = useState(clip.is_liked || false);
  const [likes, setLikes] = useState(clip.likes || 0);
  const [following, setFollowing] = useState(false);
  const [showCmts, setShowCmts] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [ripple, setRipple] = useState(false);
  const [showPlayIcon, setShowPlayIcon] = useState(false);
  const tapTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const c = getCatColor(clip.category);
  const creatorId = clip.creator_id || clip.creator?.id;

  const handleVisualTap = (_e: React.MouseEvent<HTMLDivElement>) => {
    if (tapTimeout.current) {
      clearTimeout(tapTimeout.current);
      tapTimeout.current = null;
      setShowPlayIcon(true);
      setTimeout(() => setShowPlayIcon(false), 600);
      if (isActive) {
        if (globalPlaying) {
          // pause handled by player
        } else {
          play(clip);
        }
      }
      return;
    }
    tapTimeout.current = setTimeout(() => {
      tapTimeout.current = null;
      play(clip);
    }, 250);
  };

  const toggleLike = async () => {
    const nl = !liked;
    setLiked(nl);
    setLikes(n => nl ? n + 1 : n - 1);
    setRipple(true);
    setTimeout(() => setRipple(false), 500);
    try {
      await interactionsAPI.toggleLike(clip.id);
    } catch {
      setLiked(!nl);
      setLikes(n => nl ? n - 1 : n + 1);
    }
  };

  const toggleFollow = async () => {
    if (!creatorId) return toast('Cannot follow: missing creator ID', 'error');
    if (String(creatorId) === String(user?.id)) return;
    setFollowing(f => !f);
    try {
      const d = await followAPI.toggleFollow(creatorId);
      const isNowFollowing = d?.status === 'followed';
      setFollowing(isNowFollowing);
    } catch {
      setFollowing(f => !f);
    }
  };

  return (
    <>
      <div style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        borderRadius: 'var(--radius-xl)',
        overflow: 'hidden',
        border: `1px solid ${isActive ? c + '44' : 'var(--outline-variant)'}`,
        transition: 'all 0.25s ease'
      }}>
        {/* Full-screen visual header */}
        <div
          onClick={handleVisualTap}
          style={{
            height: '100%',
            minHeight: 400,
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
            background: clip.cover_image ? 'transparent' : `linear-gradient(135deg, ${c}10 0%, ${c}22 50%, #121416 100%)`
          }}
        >
          {clip.cover_image ? (
            <img
              src={clip.cover_image}
              alt={clip.title}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
              }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <>
              {/* Ambient background circles */}
              <div style={{
                position: 'absolute', width: 280, height: 280, borderRadius: 'var(--radius-full)',
                background: c + '08', top: '10%', right: '-10%', filter: 'blur(60px)'
              }} />
              <div style={{
                position: 'absolute', width: 200, height: 200, borderRadius: 'var(--radius-full)',
                background: c + '0A', bottom: '20%', left: '-5%', filter: 'blur(40px)'
              }} />
              <div style={{
                position: 'absolute', inset: 0, opacity: 0.08,
                backgroundImage: `radial-gradient(circle, ${c} 1px, transparent 1px)`,
                backgroundSize: '24px 24px'
              }} />

              {/* Play/Pause overlay (100px circular container) */}
              {showPlayIcon && (
                <div style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  zIndex: 10
                }}>
                  <div style={{
                    width: 100, height: 100, borderRadius: 'var(--radius-full)',
                    background: 'rgba(0,0,0,0.4)',
                    backdropFilter: 'blur(10px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'popIn 0.3s ease forwards'
                  }}>
                    {isPlaying ? (
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 24 }}>
                        {[12, 18, 14, 20, 14, 18, 12].map((h, i) => (
                          <div key={i} className="wave-bar" style={{
                            width: 4, height: h, borderRadius: 2, background: '#fff', opacity: 0.9
                          }} />
                        ))}
                      </div>
                    ) : (
                      <svg width="28" height="34" viewBox="0 0 24 24" fill="#fff" stroke="#fff" strokeWidth="1">
                        <polygon points="6,4 22,12 6,20" />
                      </svg>
                    )}
                  </div>
                </div>
              )}

              {/* Category badge */}
              <div style={{ position: 'absolute', top: 16, right: 72 }}>
                <CatBadge category={clip.category} color={c} />
              </div>

              {/* Waveform visualization in background */}
              <div style={{
                position: 'absolute', bottom: 120, left: 0, right: 0, height: 60,
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, opacity: 0.15
              }}>
                {Array.from({ length: 40 }).map((_, i) => {
                  const h = 8 + Math.sin(i * 0.4) * 12 + Math.random() * 10;
                  return (
                    <div key={i} style={{
                      width: 3, height: h, borderRadius: 2,
                      background: `linear-gradient(to top, ${c}, var(--sage))`,
                      opacity: isActive ? 0.6 : 0.3,
                      transition: 'opacity 0.3s'
                    }} />
                  );
                })}
              </div>
            </>
          )}

          {/* Glassmorphism metadata overlay (bottom-left) */}
          <div className="glass" style={{
            position: 'absolute', bottom: 0, left: 0, right: 68,
            padding: '20px 20px 16px',
            borderTop: '1px solid rgba(255,255,255,0.06)'
          }}>
            {/* Creator info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <button onClick={() => creatorId && onProfileClick?.(Number(creatorId))} style={{
                display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer', padding: 0
              }}>
                <Avatar name={clip.creator_name} size={40} />
                <span style={{
                  fontSize: 15, color: '#fff', fontWeight: 600,
                  textShadow: '0px 2px 4px rgba(0,0,0,0.4)'
                }}>{clip.creator_name}</span>
              </button>
              {String(creatorId) !== String(user?.id) && (
                <button onClick={toggleFollow} style={{
                  padding: '5px 14px', borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 600,
                  background: following ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: following ? 'var(--outline)' : '#fff',
                  border: `1px solid ${following ? 'var(--outline-variant)' : 'rgba(255,255,255,0.3)'}`,
                  transition: 'all 0.2s', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4
                }}>
                  {following ? <><UserCheck size={12} /> Following</> : <><UserPlus size={12} /> Follow</>}
                </button>
              )}
            </div>

            {/* Track title */}
            <h3 style={{
              fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700,
              color: '#fff', letterSpacing: '0.02em', lineHeight: 1.2, marginBottom: 8,
              textShadow: '0px 2px 4px rgba(0,0,0,0.4)'
            }}>{clip.title}</h3>

            {/* Tags */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {clip.tags?.slice(0, 4).map(t => (
                <span key={t} style={{
                  padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 600,
                  background: 'rgba(255,255,255,0.1)', color: '#fff',
                  border: '1px solid rgba(255,255,255,0.15)'
                }}>#{t}</span>
              ))}
            </div>

            {/* Meta info */}
            <p style={{
              fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.05em',
              textShadow: '0px 2px 4px rgba(0,0,0,0.4)'
            }}>
              {Math.round(clip.duration_ms / 1000)}s • {likes} likes
            </p>
          </div>

          {/* Waveform bar component */}
          <div style={{ position: 'absolute', bottom: 60, left: 0, right: 0, padding: '0 14px' }}>
            <WaveformBar clip={clip} onProfileClick={onProfileClick} />
          </div>
        </div>

        {/* Right-side vertical interaction stack (64px circular buttons, 24px spacing) */}
        <div style={{
          position: 'absolute', right: 12, bottom: 140,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24
        }}>
          {/* Like */}
          <button onClick={toggleLike} style={{
            width: 56, height: 56, borderRadius: 'var(--radius-full)', border: 'none',
            background: liked ? 'var(--error)' : 'var(--surface-overlay)',
            backdropFilter: 'blur(10px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', position: 'relative', overflow: 'hidden',
            transition: 'all 0.2s ease',
            boxShadow: liked ? '0 0 20px rgba(255,180,171,0.3)' : 'none'
          }}>
            {ripple && <div style={{
              position: 'absolute', width: 40, height: 40, borderRadius: 'var(--radius-full)',
              background: 'rgba(255,180,171,0.3)', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)', animation: 'ripple 0.5s ease forwards'
            }} />}
            <Heart size={22} fill={liked ? '#fff' : 'none'} color={liked ? '#fff' : '#fff'}
              style={{ transition: 'all 0.2s', transform: liked ? 'scale(1.15)' : 'scale(1)' }} />
            <span style={{ fontSize: 10, color: '#fff', fontWeight: 600, marginTop: 2 }}>{likes}</span>
          </button>

          {/* Comments */}
          <button onClick={() => setShowCmts(true)} style={{
            width: 56, height: 56, borderRadius: 'var(--radius-full)', border: 'none',
            background: 'var(--surface-overlay)', backdropFilter: 'blur(10px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 0.2s ease'
          }}>
            <MessageCircle size={22} color="#fff" />
            <span style={{ fontSize: 10, color: '#fff', fontWeight: 600, marginTop: 2 }}>{clip.comment_count || 0}</span>
          </button>

          {/* Share */}
          <button onClick={() => setShowShare(true)} style={{
            width: 56, height: 56, borderRadius: 'var(--radius-full)', border: 'none',
            background: 'var(--surface-overlay)', backdropFilter: 'blur(10px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 0.2s ease'
          }}>
            <Share2 size={22} color="#fff" />
            <span style={{ fontSize: 10, color: '#fff', fontWeight: 600, marginTop: 2 }}>{clip.shares || 0}</span>
          </button>

          {/* Skip controls */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginTop: 8 }}>
            <button onClick={() => { skipForward(10); interactionsAPI.registerSkip(clip.id, { listen_duration_ms: listenMs(), reel_position_ms: Math.round(duration * progress * 1000), reel_id: clip.id }).catch(() => {}); }} style={{
              width: 40, height: 40, borderRadius: 'var(--radius-full)',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'var(--surface-overlay)', backdropFilter: 'blur(10px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', cursor: 'pointer', transition: 'all 0.2s'
            }} title="Skip forward 10s">
              <SkipForward size={16} />
            </button>
            <button onClick={() => { skipBackward(10); interactionsAPI.registerSkip(clip.id, { listen_duration_ms: listenMs(), reel_position_ms: Math.round(duration * progress * 1000), reel_id: clip.id }).catch(() => {}); }} style={{
              width: 40, height: 40, borderRadius: 'var(--radius-full)',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'var(--surface-overlay)', backdropFilter: 'blur(10px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', cursor: 'pointer', transition: 'all 0.2s'
            }} title="Skip back 10s">
              <SkipBack size={16} />
            </button>
          </div>
        </div>
      </div>

      {showCmts && <CommentSheet clipId={clip.id} onClose={() => setShowCmts(false)} />}
      {showShare && <ShareModal clip={clip} onClose={() => setShowShare(false)} />}
    </>
  );
}
