import { useState, useEffect } from 'react';

export function useBackendStatus() {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (connected !== null) return;
      setConnected(false);
    }, 3000);

    fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8005'}/profile/me/`, {
      signal: controller.signal,
    })
      .then(r => {
        clearTimeout(timeout);
        setConnected(r.ok || r.status === 401);
      })
      .catch(() => {
        clearTimeout(timeout);
        setConnected(false);
      });

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return connected;
}
