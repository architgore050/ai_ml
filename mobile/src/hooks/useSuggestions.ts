import { useCallback, useEffect, useRef, useState } from 'react';

import { getSuggestions } from '../api/endpoints/feed';
import type { FeedClip } from '../api/schema';

/** Cursor-paginated state for the non-destructive Discover listing. */
export type SuggestionsState = {
  clips: FeedClip[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasNextPage: boolean;
  refresh: () => void;
  loadMore: () => void;
};

export function useSuggestions(category: string): SuggestionsState {
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const generationRef = useRef(0);
  const pagingRef = useRef(false);

  useEffect(() => {
    const generation = ++generationRef.current;
    pagingRef.current = false;
    setLoading(true);
    setRefreshing(false);
    setLoadingMore(false);
    setError(null);
    setClips([]);
    setNext(null);

    void getSuggestions(category).then(
      (page) => {
        if (generationRef.current !== generation) return;
        setClips(page.clips);
        setNext(page.next);
      },
      (err: unknown) => {
        if (generationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : 'Could not load Discover.');
      },
    ).finally(() => {
      if (generationRef.current === generation) setLoading(false);
    });
  }, [category, reload]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setReload((value) => value + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (!next || loading || pagingRef.current) return;
    const generation = generationRef.current;
    const cursor = next;
    pagingRef.current = true;
    setLoadingMore(true);

    void getSuggestions(category, cursor).then(
      (page) => {
        if (generationRef.current !== generation) return;
        setClips((current) => {
          const seen = new Set(current.map((clip) => clip.id));
          return current.concat(page.clips.filter((clip) => !seen.has(clip.id)));
        });
        setNext(page.next);
      },
      (err: unknown) => {
        if (generationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : 'Could not load more clips.');
      },
    ).finally(() => {
      if (generationRef.current === generation) {
        pagingRef.current = false;
        setLoadingMore(false);
      }
    });
  }, [category, loading, next]);

  return { clips, loading, refreshing, loadingMore, error, hasNextPage: next !== null, refresh, loadMore };
}
