import { useCallback, useEffect, useRef, useState } from 'react';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';

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
} from '../lib/revenuecat';
import { useAuthStore } from '../store/auth';

export type SubscriptionState = {
  plans: SubscriptionPlan[];
  status: SubscriptionStatus | null;
  isPro: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
  presentPaywall: () => Promise<void>;
  purchasePlan: (productId: string) => Promise<void>;
  openCustomerPortal: () => Promise<string>;
};

export type SubscriptionPlan = { productId: string; title: string; price: string };

/**
 * Coordinates the API-owned entitlement with RevenueCat's native customer
 * identity. Purchases never decide access locally; the API remains the source
 * of truth for limits and moderation-sensitive upload permissions.
 */
export function useSubscription(): SubscriptionState {
  const authStatus = useAuthStore((state) => state.status);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const packages = useRef(new Map<string, PurchasesPackage>());

  const loadPlans = useCallback(async () => {
    const offering = (await Purchases.getOfferings()).current;
    if (!offering?.availablePackages.length) throw new Error('No subscription plans are available.');
    packages.current = new Map(offering.availablePackages.map((item) => [item.product.identifier, item]));
    setPlans(offering.availablePackages.map((item) => ({
      productId: item.product.identifier,
      title: item.product.title,
      price: item.product.priceString,
    })));
  }, []);

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
        await loadPlans();
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
  }, [loadPlans]);

  useEffect(() => {
    generation.current += 1;
    const currentGeneration = generation.current;
    if (authStatus !== 'authenticated') {
      setStatus(null);
      setPlans([]);
      packages.current.clear();
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
    await loadPlans();
  }, [loadPlans]);

  const purchasePlan = useCallback(async (productId: string) => {
    const selected = packages.current.get(productId);
    if (!selected) throw new Error('That plan is no longer available. Refresh plans and try again.');
    await Purchases.purchasePackage(selected);
    await sync();
  }, [sync]);

  const openCustomerPortal = useCallback(async () => {
    const { url } = await getSubscriptionManageUrl();
    return url;
  }, []);

  return {
    plans,
    status,
    isPro: status?.is_pro ?? false,
    loading,
    refreshing,
    error,
    refresh,
    sync,
    presentPaywall,
    purchasePlan,
    openCustomerPortal,
  };
}
