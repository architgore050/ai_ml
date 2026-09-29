import { useState } from 'react';
import { Headphones } from 'lucide-react';
import { CATEGORIES } from '../../data/clips';
import { tagsAPI } from '../../api/client';
import { isDemoMode } from '../../data/feedAdapter';
import { Spinner } from '../../components/common/atoms';

export function OnboardingModal({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [selTags, setSelTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const demo = isDemoMode();

  const submit = async () => {
    if (step === 0) { setStep(1); return; }
    if (!selTags.length) { onDone(); return; }
    setLoading(true);
    try {
      if (!demo) await tagsAPI.initialize(selTags);
      onDone();
    } catch {
      onDone();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 7000,
      background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div className="pop-in" style={{
        width: '100%', maxWidth: 360, background: 'var(--surface)',
        borderRadius: 24, padding: 32, border: '1px solid var(--border)'
      }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 28 }}>
          {[0, 1].map(i => (
            <div key={i} style={{
              height: 4, borderRadius: 2, transition: 'all 0.3s',
              width: i === step ? 24 : 8,
              background: i <= step ? 'var(--terracotta)' : 'var(--surface-container)'
            }} />
          ))}
        </div>
        {step === 0 ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 72, height: 72, borderRadius: 22, margin: '0 auto 18px',
              background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 32px var(--accent-glow)'
            }}><Headphones size={32} color="#000" /></div>
            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 900,
              letterSpacing: '0.04em', marginBottom: 10, color: 'var(--on-surface)'
            }}>WELCOME TO ECHOFLOW</h2>
            <p style={{ fontSize: 14, color: 'var(--on-surface-variant)', lineHeight: 1.6, marginBottom: 28 }}>
              TikTok for your ears. Short audio reels — comedy, music, science, news — no screen required.
            </p>
            <button onClick={submit} style={{
              width: '100%', padding: '14px', borderRadius: 14, border: 'none',
              background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
              color: '#000', fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 900,
              letterSpacing: '0.05em', cursor: 'pointer',
              boxShadow: '0 4px 24px var(--accent-glow)'
            }}>GET STARTED</button>
          </div>
        ) : (
          <div>
            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 900,
              letterSpacing: '0.04em', marginBottom: 8, color: 'var(--on-surface)', textAlign: 'center'
            }}>PICK YOUR VIBES</h2>
            <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', textAlign: 'center', marginBottom: 20 }}>
              Select categories to personalize your feed
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
              {CATEGORIES.map(t => {
                const sel = selTags.includes(t);
                const col = '#ff6b35';
                return (
                  <button key={t} onClick={() => setSelTags(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t])} style={{
                    padding: '9px 18px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                    letterSpacing: '0.04em', textTransform: 'capitalize',
                    background: sel ? col + '18' : 'var(--surface-container)',
                    color: sel ? col : 'var(--on-surface-variant)',
                    border: sel ? `1px solid ${col}55` : '1px solid var(--border)', cursor: 'pointer'
                  }}>{sel && '\u2713 '}{t}</button>
                );
              })}
            </div>
            <button onClick={submit} disabled={loading} style={{
              width: '100%', padding: '14px', borderRadius: 14, border: 'none',
              background: selTags.length ? 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))' : 'var(--surface-container)',
              color: selTags.length ? '#fff' : 'var(--outline)',
              fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 800, letterSpacing: '0.05em',
              cursor: selTags.length ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
            }}>
              {loading ? <Spinner size={16} /> : (selTags.length ? 'START FEED WITH ' + selTags.length + ' TAGS' : 'SKIP FOR NOW')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
