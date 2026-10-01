import { useCallback, useEffect, useRef, useState } from 'react';

import { getMyProfile } from '../api/endpoints/auth';
import { updateProfilePicture } from '../api/endpoints/profile';
import type { OwnProfile } from '../api/schema';

export type OwnProfileState = {
  profile: OwnProfile | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
  updateAvatar: (asset: { uri: string; fileName?: string | null; mimeType?: string | null }) => Promise<void>;
};

/** A refreshable own-profile read. `/profile/me/` also supplies liked clips. */
export function useOwnProfile(): OwnProfileState {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void getMyProfile().then(
      (next) => {
        if (!mounted.current) return;
        setProfile(next);
        setError(null);
      },
      (err: unknown) => {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : 'Could not load your profile.');
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
    return () => { mounted.current = false; };
  }, [refresh]);

  const updateAvatar = useCallback(async (asset: { uri: string; fileName?: string | null; mimeType?: string | null }) => {
    setError(null);
    await updateProfilePicture(asset);
    const next = await getMyProfile();
    if (mounted.current) setProfile(next);
  }, []);

  return { profile, loading, refreshing, error, refresh, updateAvatar };
}
