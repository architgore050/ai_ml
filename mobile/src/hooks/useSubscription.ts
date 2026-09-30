import { useCallback, useEffect, useRef, useState } from 'react';
import RevenueCatUI from 'react-native-purchases-ui';

import {
  getSubscription,
  getSubscriptionManageUrl,
  syncSubscription,
} from '../api/endpoints/subscription';
import type { SubscriptionStatus } from '../api/schema';
import {
  getRevenueCatCustomerInfo,
  identifyRevenueCat,
  logoutRevenueCat,
  revenueCatEntitlementId,
} from '../lib/revenuecat';
import { useAuthStore } from '../store/auth';

export type SubscriptionState = {
  status: SubscriptionStatus | null;
  isPro: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  presentPaywall: () => Promise<void>;
  openCustomerPortal: () => Promise<string>;
};

/**
 * Coordinates the API-owned entitlement with RevenueCat's native customer
 * identity. Purchases never decide access locally; the API remains the source
 * of truth for limits and moderation-sensitive upload permissions.
 */
export function useSubscription(): SubscriptionState {
  const authStatus = useAuthStore((state) => state.status);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const generationAtStart = generation.current;
    setRefreshing(true);
    setError(null);
    try {
      const next = await getSubscription();
      if (generation.current !== generationAtStart) return;
      // The API is authoritative for access and limits. A RevenueCat cache
      // can lag a purchase/webhook, and a missing SDK key must not block free
      // users from using the app, so SDK identity is best-effort here.
      setStatus(next);
      try {
        await identifyRevenueCat(next.app_user_id);
        await getRevenueCatCustomerInfo();
      } catch (sdkCause) {
        if (generation.current === generationAtStart) {
          setError(sdkCause instanceof Error ? sdkCause.message : 'RevenueCat is unavailable.');
        }
      }
    } catch (cause) {
      if (generation.current === generationAtStart) {
        setError(cause instanceof Error ? cause.message : 'Could not load subscription.');
      }
    } finally {
      if (generation.current === generationAtStart) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const currentGeneration = generation.current;
    if (authStatus !== 'authenticated') {
      setStatus(null);
      setError(null);
      setLoading(false);
      void logoutRevenueCat().catch(() => undefined);
      return;
    }
    setLoading(true);
    void refresh().finally(() => {
      if (generation.current === currentGeneration) setLoading(false);
    });
  }, [authStatus, refresh]);

  const sync = useCallback(async () => {
    await syncSubscription();
    await refresh();
  }, [refresh]);

  const presentPaywall = useCallback(async () => {
    await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: revenueCatEntitlementId(),
    });
    await sync();
  }, [sync]);

  const openCustomerPortal = useCallback(async () => {
    const { url } = await getSubscriptionManageUrl();
    return url;
  }, []);

  return {
    status,
    isPro: status?.is_pro ?? false,
    loading,
    refreshing,
    error,
    refresh,
    sync,
    presentPaywall,
    openCustomerPortal,
  };
}
