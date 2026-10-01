import { z } from 'zod';

import { apiFetch } from '../client';
import { subscriptionStatusSchema, type SubscriptionStatus } from '../schema';

const syncResultSchema = z.object({ detail: z.string() });
const manageUrlSchema = z.object({ url: z.string().url() });

/** Read the server-owned subscription state and stable RevenueCat id. */
export async function getSubscription(): Promise<SubscriptionStatus> {
  return subscriptionStatusSchema.parse(await apiFetch('/subscription/'));
}

/** Ask the backend to refresh RevenueCat state; entitlement remains server-owned. */
export async function syncSubscription(): Promise<{ detail: string }> {
  return syncResultSchema.parse(await apiFetch('/subscription/sync/', { method: 'POST' }));
}

/** Get the backend-generated customer portal URL. */
export async function getSubscriptionManageUrl(): Promise<{ url: string }> {
  return manageUrlSchema.parse(await apiFetch('/subscription/manage/'));
}
