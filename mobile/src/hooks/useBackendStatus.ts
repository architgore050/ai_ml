import { useEffect, useRef, useState } from 'react';

import { getMyProfile } from '../api/endpoints/auth';

/**
 * Backend reachability, polled on a **30 s timer**.
 *
 * FRONTEND-REQUIREMENTS.md §4.9: the web client's `useBackendStatus` checks once
 * at mount, so the "backend not reachable" banner never recovers after a
 * transient outage — it latches off and the user has to restart the app. A slow
 * timer fixes that without hammering the API.
 *
 * Uses a lightweight authenticated call (`/profile/me/`) rather than a
 * dedicated health endpoint: it exercises the same path a real feature would,
 * so a green banner means the app can actually function. A 401 still counts as
 * reachable — the backend is answering.
 */

const INTERVAL_MS = 30_000;

export type BackendStatus = 'unknown' | 'online' | 'offline';

export function useBackendStatus(enabled = true): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>('unknown');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return () => {
      mounted.current = false;
    };

    let cancelled = false;

    const check = async () => {
      try {
        await getMyProfile();
        if (!cancelled && mounted.current) setStatus('online');
      } catch {
        if (!cancelled && mounted.current) setStatus('offline');
      }
    };

    void check();
    const timer = setInterval(check, INTERVAL_MS);

    return () => {
      cancelled = true;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return status;
}
