import { useState, useEffect } from 'react';
import { X, Send } from 'lucide-react';
import { Comment } from '../../types';
import { commentsAPI } from '../../api/client';
import { useAuth } from '../../stores/auth';
import { Avatar } from '../common/atoms';
import { Spinner, inputStyle } from '../common/atoms';
import { DEMO_MODE } from '../../data/demo';
import { getDemoComments } from '../../data/demoComments';

interface Props { clipId: string; onClose: () => void; }

export function CommentSheet({ clipId, onClose }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [replyParent, setReplyParent] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (DEMO_MODE) {
      setItems(getDemoComments(clipId));
      setLoading(false);
      return;
    }
    commentsAPI.getComments(clipId)
      .then(d => { setItems(d.results || []); setLoading(false); })
      .catch(e => { setErr(e.message); setLoading(false); });
  }, [clipId]);

  const post = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    try {
      if (DEMO_MODE) {
        const c: Comment = {
          id: 'new', clip: clipId, author_username: user?.username || 'you',
          parent: null, text: text.trim(), likes: 0, reply_count: 0,
          created_at: new Date().toISOString(),
        };
        setItems(p => [c, ...p]);
      } else {
        const c = await commentsAPI.postComment({ clip: clipId, text: text.trim() });
        setItems(p => [c, ...p]);
      }
      setText('');
    } catch(e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(msg);
    } finally {
      setPosting(false);
    }
  };

  const handleReply = async (parentId: string) => {
    if (!replyText.trim()) return;
    try {
      if (DEMO_MODE) {
        const c: Comment = { id: 'reply-' + Date.now(), clip: clipId, author_username: user?.username || 'you', parent: parentId, text: replyText.trim(), likes: 0, reply_count: 0, created_at: new Date().toISOString() };
        setItems(prev => [c, ...prev]);
      } else {
        const c = await commentsAPI.postComment({ clip: clipId, text: replyText.trim(), parent: parentId });
        setItems(prev => [c, ...prev]);
      }
      setReplyText('');
      setReplyParent(null);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 800,
      background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'flex-end'
    }}>
      <div className="slide-up" onClick={e => e.stopPropagation()} style={{
        width: '100%', maxHeight: '80vh', background: 'var(--surface)',
        borderRadius: '22px 22px 0 0', display: 'flex', flexDirection: 'column',
        border: '1px solid var(--outline-variant)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--outline-variant)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, letterSpacing: '0.04em' }}>COMMENTS</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--on-surface-variant)' }}>
            <X size={20} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {loading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={28} /></div>
            : err
              ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--on-surface-variant)', fontSize: 13 }}>{err}</div>
              : items.length === 0
                ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--on-surface-variant)', fontSize: 13 }}>No comments yet. Be the first to comment!</div>
                : items.map(c => (
                    <div key={c.id} style={{ display: 'flex', gap: 10, marginBottom: 16, animation: 'fadeUp 0.2s ease' }}>
                      <Avatar name={c.author_username} size={32} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--terracotta)', marginBottom: 3 }}>{c.author_username}</p>
                          {user?.username === c.author_username && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => { setEditingComment(c.id); setEditText(c.text); }} style={{ background: 'none', border: 'none', color: 'var(--outline)', fontSize: 10, cursor: 'pointer' }}>Edit</button>
                              <button onClick={async () => { try { await commentsAPI.deleteComment(String(c.id)); setItems(prev => prev.filter(i => i.id !== c.id)); } catch (e: unknown) { alert((e instanceof Error ? e.message : 'Failed')); } }} style={{ background: 'none', border: 'none', color: 'var(--error)', fontSize: 10, cursor: 'pointer' }}>Delete</button>
                            </div>
                          )}
                        </div>
                        {editingComment === c.id ? (
                          <div>
                            <input value={editText} onChange={e => setEditText(e.target.value)} style={{ ...inputStyle, marginBottom: 6, fontSize: 13 }} />
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={async () => { try { await commentsAPI.patchComment(String(c.id), { text: editText.trim() }); setItems(prev => prev.map(i => i.id === c.id ? { ...i, text: editText.trim() } : i)); setEditingComment(null); } catch (e: unknown) { alert((e instanceof Error ? e.message : 'Failed')); } }} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 10, background: 'var(--terracotta)', color: '#fff', border: 'none', cursor: 'pointer' }}>Save</button>
                              <button onClick={() => setEditingComment(null)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 10, background: 'var(--surface-container)', color: 'var(--on-surface-variant)', border: '1px solid var(--outline-variant)', cursor: 'pointer' }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <p style={{ fontSize: 13, color: 'var(--on-surface)', lineHeight: 1.5 }}>{c.text}</p>
                        )}
                        <p style={{ fontSize: 10, color: 'var(--outline)', marginTop: 4, letterSpacing: '0.04em' }}>
                          {new Date(c.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {c.reply_count ? `${c.reply_count} replies` : 'No replies'}
                          <button onClick={() => setReplyParent(replyParent === c.id ? null : c.id)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--terracotta)', fontSize: 10, cursor: 'pointer' }}>{replyParent === c.id ? 'Cancel reply' : 'Reply'}</button>
                        </p>
                        {replyParent === c.id && (
                          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                            <input value={replyText} onChange={e => setReplyText(e.target.value)} placeholder="Write a reply..." onKeyDown={e => { if (e.key === 'Enter') handleReply(c.id); }} style={{ ...inputStyle, flex: 1, padding: '8px 12px', fontSize: 13 }} />
                            <button onClick={() => handleReply(c.id)} style={{ padding: '6px 12px', borderRadius: 12, background: 'var(--terracotta)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Reply</button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
          }
        </div>
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--outline-variant)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Avatar name={user?.username} size={32} />
          <input value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && post()}
            placeholder="Add a comment…" style={{ ...inputStyle, flex: 1, padding: '8px 12px', borderRadius: 20 }} />
          <button onClick={post} disabled={!text.trim() || posting} style={{
            width: 34, height: 34, borderRadius: 17, border: 'none', flexShrink: 0,
            background: text.trim() ? 'var(--terracotta)' : 'var(--surface-container)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: text.trim() ? 'pointer' : 'default'
          }}>
            {posting ? <Spinner size={14} color="#000" /> : <Send size={14} color={text.trim() ? '#000' : 'var(--outline)'} />}
          </button>
        </div>
      </div>
    </div>
  );
}
