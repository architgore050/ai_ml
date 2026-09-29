import { createContext, useContext, useState, useRef, useCallback, ReactNode } from 'react';

type ToastType = 'success' | 'error' | 'info' | 'warn';

interface Toast { id: number; msg: string; type: ToastType; }

const ToastContext = createContext<(msg: string, type?: ToastType, ms?: number) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const tid = useRef(0);

  const push = useCallback((msg: string, type: ToastType = 'info', ms = 3200) => {
    const id = ++tid.current;
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), ms);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div style={{
        position: 'fixed', top: 18, right: 14, zIndex: 5000,
        display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none'
      }}>
        {toasts.map(t => (
          <ToastItem key={t.id} msg={t.msg} type={t.type} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const COLORS: Record<ToastType, string> = { success: 'var(--sage)', error: 'var(--error)', info: 'var(--terracotta)', warn: '#f59e0b' };

function ToastItem({ msg, type }: { msg: string; type: ToastType }) {
  return (
    <div style={{
      pointerEvents: 'auto',
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 16px', borderRadius: 12, minWidth: 200, maxWidth: 320,
      background: 'var(--surface)', border: `1px solid ${COLORS[type]}44`,
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      animation: 'toastIn 0.28s cubic-bezier(.22,.61,.36,1) forwards'
    }}>
      <span style={{ color: COLORS[type], fontWeight: 800, fontSize: 13 }}>
        {type === 'success' ? '\u2713' : type === 'error' ? '\u2717' : type === 'info' ? '\u26a1' : '\u26a0'}
      </span>
      <span style={{ fontSize: 13, color: 'var(--on-surface)', lineHeight: 1.4 }}>{msg}</span>
    </div>
  );
}
