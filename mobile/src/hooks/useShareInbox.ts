import { useCallback, useEffect, useRef, useState } from 'react';

import { getShareInbox, type ShareInboxItem } from '../api/endpoints/share';

/** The documented polling cadence: 120 calls/hour, below `share_poll`'s 1000/hour. */
export const SHARE_INBOX_POLL_MS = 30_000;

export type ShareInboxState = {
  shares: ShareInboxItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
};

export function useShareInbox(): ShareInboxState {
  const [shares, setShares] = useState<ShareInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void getShareInbox().then(
      (items) => {
        if (!mounted.current) return;
        setShares(items);
        setError(null);
      },
      (err: unknown) => {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : 'Could not load your inbox.');
      },
    ).finally(() => {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const interval = setInterval(refresh, SHARE_INBOX_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [refresh]);

  return { shares, loading, refreshing, error, refresh };
}
