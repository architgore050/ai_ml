import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';

const configuredKeys = new Set<string>();

export type RevenueCatCustomerInfo = {
  entitlements: { active: Record<string, unknown> };
};

/** Public store keys only. Secret RevenueCat credentials must never be bundled. */
export function revenueCatPublicKey(): string | null {
  const key = Platform.OS === 'ios'
    ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
    : Platform.OS === 'android'
      ? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
      : undefined;
  return key?.trim() || null;
}

export function revenueCatEntitlementId(): string {
  return process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID?.trim() || 'pro';
}

/** Configure once per public key, then identify the API-owned customer. */
export async function identifyRevenueCat(appUserId: string): Promise<void> {
  const key = revenueCatPublicKey();
  if (!key) throw new Error(`RevenueCat public key is missing for ${Platform.OS}.`);

  if (!configuredKeys.has(key)) {
    Purchases.configure({ apiKey: key });
    configuredKeys.add(key);
  }
  await Purchases.logIn(appUserId);
}

export async function getRevenueCatCustomerInfo(): Promise<RevenueCatCustomerInfo> {
  return Purchases.getCustomerInfo() as Promise<RevenueCatCustomerInfo>;
}

export async function logoutRevenueCat(): Promise<void> {
  if (configuredKeys.size > 0) await Purchases.logOut();
}

export function hasActiveRevenueCatEntitlement(info: RevenueCatCustomerInfo): boolean {
  return Boolean(info.entitlements.active[revenueCatEntitlementId()]);
}

/** Test-only reset; native state remains owned by the SDK. */
export function __resetRevenueCatForTests(): void {
  configuredKeys.clear();
}
