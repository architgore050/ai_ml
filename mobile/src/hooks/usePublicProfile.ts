import { useCallback, useEffect, useRef, useState } from 'react';

import { getPublicProfile, getPublicProfileClips } from '../api/endpoints/profile';
import type { FeedClip, PublicProfile } from '../api/schema';

export type PublicProfileState = {
  profile: PublicProfile | null;
  clips: FeedClip[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  refresh: () => void;
  loadMore: () => void;
};

/**
 * Public profile and its non-destructive clip listing.
 *
 * The request sequence is a race guard: changing routes while an old profile
 * request is in flight must not let that response overwrite the newer screen.
 * Pagination is deliberately a separate action from refresh so a failed next
 * page leaves the already-viewable first page on screen.
 */
export function usePublicProfile(userId: number | null): PublicProfileState {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const nextRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(() => {
    const request = ++sequence.current;
    if (userId === null) {
      setProfile(null);
      setClips([]);
      setNext(null);
      nextRef.current = null;
      setLoading(false);
      setRefreshing(false);
      setError('Invalid profile.');
      return;
    }

    setRefreshing(true);
    setError(null);
    void (async () => {
      try {
        const account = await getPublicProfile(userId);
        const page = await getPublicProfileClips(userId);
        if (!mounted.current || request !== sequence.current) return;
        setProfile(account);
        setClips(page.clips);
        setNext(page.next);
        nextRef.current = page.next;
      } catch (err) {
        if (!mounted.current || request !== sequence.current) return;
        setError(err instanceof Error ? err.message : 'Could not load this profile.');
      } finally {
        if (mounted.current && request === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
  }, [userId]);

  const loadMore = useCallback(() => {
    const cursor = nextRef.current;
    if (userId === null || !cursor || loadingMoreRef.current) return;

    const request = sequence.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void getPublicProfileClips(userId, cursor).then(
      (page) => {
        if (!mounted.current || request !== sequence.current) return;
        setClips((current) => [...current, ...page.clips]);
        setNext(page.next);
        nextRef.current = page.next;
      },
      (err: unknown) => {
        if (!mounted.current || request !== sequence.current) return;
        setError(err instanceof Error ? err.message : 'Could not load more clips.');
      },
    ).finally(() => {
      loadingMoreRef.current = false;
      if (mounted.current && request === sequence.current) setLoadingMore(false);
    });
  }, [userId]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  return { profile, clips, loading, refreshing, loadingMore, error, refresh, loadMore };
}
