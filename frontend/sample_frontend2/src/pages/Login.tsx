import { useState } from 'react';
import { Headphones, Moon, Sun, AlertCircle } from 'lucide-react';
import { useAuth } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { Spinner, inputStyle } from '../components/common/atoms';

interface Props { onSuccess: (page: string) => void; }

export function LoginPage({ onSuccess }: Props) {
  const { login, register, loading } = useAuth();
  const { theme, toggle } = useTheme();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', username: '', password: '' });
  const [err, setErr] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setErr(null);
    try {
      if (mode === 'login') await login(form.username, form.password);
      else await register(form.email, form.username, form.password);
      onSuccess(mode === 'register' ? 'explore' : 'feed');
    } catch (e: unknown) {
      let msg = 'Authentication failed';
      if (e && typeof e === 'object') {
        const errData = e as { status?: number; message?: string; errors?: unknown };
        if (errData.status === 0) {
          msg = 'Cannot connect to backend. Is the server running on ' + (import.meta.env.VITE_API_BASE_URL || 'localhost:8000') + '?';
        } else if (errData.status === 401) {
          msg = 'Invalid username or password.';
        } else if (errData.status === 400) {
          const details = errData.errors;
          if (details && typeof details === 'object' && !Array.isArray(details)) {
            const fieldErrors = Object.entries(details as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`)
              .join(' ');
            msg = fieldErrors || 'Please check your input.';
          } else {
            msg = 'Please check your credentials.';
          }
        } else if (errData.status === 403) {
          msg = 'Access denied. Contact administrator.';
        } else {
          msg = errData.message || `Server error (${errData.status}). Please try again.`;
        }
      } else if (e instanceof Error) {
        msg = e.message;
      }
      setErr(msg);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, background: 'var(--background)', position: 'relative', overflow: 'hidden'
    }}>
      {/* Ambient background */}
      <div style={{
        position: 'absolute', width: 500, height: 500, borderRadius: 'var(--radius-full)',
        background: 'radial-gradient(circle, rgba(232,168,124,0.06), transparent 60%)',
        top: -150, right: -150, pointerEvents: 'none'
      }} />
      <div style={{
        position: 'absolute', width: 400, height: 400, borderRadius: 'var(--radius-full)',
        background: 'radial-gradient(circle, rgba(170,208,177,0.04), transparent 60%)',
        bottom: -100, left: -100, pointerEvents: 'none'
      }} />

      <div className="fade-up" style={{ width: '100%', maxWidth: 380, position: 'relative', zIndex: 1 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{
            width: 72, height: 72, borderRadius: 'var(--radius-lg)', margin: '0 auto 18px',
            background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 32px rgba(232, 168, 124, 0.25)'
          }}>
            <Headphones size={32} color="#000" />
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 900,
            letterSpacing: '0.04em', color: 'var(--on-surface)', lineHeight: 1
          }}>ECHOFLOW</h1>
          <p style={{ fontSize: 13, color: 'var(--on-surface-variant)', marginTop: 6, letterSpacing: '0.08em' }}>
            TikTok for your ears
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--surface-container)',
          borderRadius: 'var(--radius-xl)',
          padding: 26,
          border: '1px solid var(--outline-variant)'
        }}>
          {/* Login/Register toggle */}
          <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-lowest)', borderRadius: 12, marginBottom: 22 }}>
            {['login', 'register'].map(m => (
              <button key={m} onClick={() => { setMode(m as 'login' | 'register'); setErr(null); }} style={{
                flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 700,
                letterSpacing: '0.06em', textTransform: 'uppercase', border: 'none',
                background: mode === m ? 'var(--surface-container)' : 'transparent',
                color: mode === m ? 'var(--on-surface)' : 'var(--outline)', transition: 'all 0.2s',
                cursor: 'pointer'
              }}>{m}</button>
            ))}
          </div>

          {/* Form fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {mode === 'register' && (
              <input type="email" placeholder="Email address" value={form.email}
                onChange={e => set('email', e.target.value)} style={inputStyle} />
            )}
            <input type="text" placeholder="Username" value={form.username}
              onChange={e => set('username', e.target.value)} style={inputStyle} />
            <input type="password" placeholder="Password" value={form.password}
              onChange={e => set('password', e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} style={inputStyle} />
          </div>

          {/* Error message */}
          {err && (
            <div style={{
              marginTop: 14, padding: '12px 14px', borderRadius: 12,
              background: 'rgba(255,180,171,0.08)', border: '1px solid rgba(255,180,171,0.2)',
              fontSize: 13, color: 'var(--error)', display: 'flex', alignItems: 'flex-start', gap: 8
            }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ lineHeight: 1.4 }}>{err}</span>
            </div>
          )}

          {/* Submit button */}
          <button onClick={submit} disabled={loading || !form.username || !form.password || (mode === 'register' && !form.email)} style={{
            width: '100%', marginTop: 20, padding: '13px 0', borderRadius: 'var(--radius-full)', border: 'none',
            background: 'linear-gradient(135deg, var(--terracotta), var(--accent-hover))',
            color: '#000', fontSize: 15, fontWeight: 800, fontFamily: 'var(--font-display)',
            letterSpacing: '0.06em', cursor: loading || !form.username || !form.password || (mode === 'register' && !form.email) ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            boxShadow: '0 4px 20px rgba(232, 168, 124, 0.25)', transition: 'all 0.2s'
          }}>
            {loading ? <Spinner size={18} color="var(--outline)" /> : (mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT')}
          </button>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, padding: '0 4px' }}>
          <button onClick={toggle} style={{
            width: 38, height: 38, borderRadius: 'var(--radius-full)', background: 'var(--surface-container)',
            border: '1px solid var(--outline-variant)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', color: 'var(--on-surface-variant)'
          }}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}