import { useState, useEffect } from 'react';

export function NetworkBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const up = () => { setOnline(true); setShow(true); setTimeout(() => setShow(false), 2500); };
    const down = () => { setOnline(false); setShow(true); };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  if (!show) return null;
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 8000,
      padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      background: online ? 'rgba(170,208,177,0.12)' : 'rgba(255,180,171,0.12)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid ' + (online ? 'rgba(170,208,177,0.3)' : 'rgba(255,180,171,0.3)')
    }}>
      <span style={{
        fontSize: 12, fontWeight: 600,
        color: online ? 'var(--sage)' : 'var(--error)',
        letterSpacing: '0.05em'
      }}>
        {online ? 'BACK ONLINE' : 'NO CONNECTION — demo mode active'}
      </span>
    </div>
  );
}
