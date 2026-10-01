import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { setTokenStore, type TokenStore } from './client';
import type { TokenPair } from './schema';

/**
 * Token storage in the Keychain (iOS) / Keystore (Android).
 *
 * D4: tokens go to `expo-secure-store`, NOT MMKV and NOT AsyncStorage. The old
 * app used `@react-native-async-storage/async-storage` (api.ts:1), which on
 * Android is an unencrypted world-readable-ish key/value file — for a 7-day
 * refresh token that blacklists access on logout, that is a real exposure.
 *
 * Keys are versioned (`ef_v1_*`) so a future change of storage backend can
 * migrate rather than silently read the wrong thing.
 *
 * One more thing: the old app left its AsyncStorage keys behind. `purgeLegacy()`
 * clears them, because after this ships the old tokens are both dead (the app is
 * a fresh install, no logout was ever called) and unnecessary.
 */

const ACCESS_KEY = 'ef_v1_access_token';
const REFRESH_KEY = 'ef_v1_refresh_token';

/** Pre-Phase-1 AsyncStorage keys, from api.ts:23-25. */
const LEGACY_KEYS = [
  'ef_mobile_access_token',
  'ef_mobile_refresh_token',
  'ef_mobile_user',
] as const;

export const secureStoreTokens: TokenStore = {
  async getAccess() {
    try {
      return await SecureStore.getItemAsync(ACCESS_KEY);
    } catch {
      // A Keychain read can fail (device lock state change, corrupt entry).
      // Treat as "no session" rather than crashing the boot path.
      return null;
    }
  },

  async getRefresh() {
    try {
      return await SecureStore.getItemAsync(REFRESH_KEY);
    } catch {
      return null;
    }
  },

  async set(pair: TokenPair) {
    // Written separately rather than as one blob so a partial write can never
    // produce a mismatched access/refresh pair from different logins.
    await SecureStore.setItemAsync(ACCESS_KEY, pair.access, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(REFRESH_KEY, pair.refresh, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  async clear() {
    await SecureStore.deleteItemAsync(ACCESS_KEY);
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  },
};

/**
 * Remove the old app's unencrypted AsyncStorage tokens.
 *
 * SECURITY: this is not a cosmetic migration. The bundle ID is unchanged
 * (`com.echoflow.audio`), so an upgrading device carries `mobile/`'s old keys
 * with it — and those refresh tokens are still VALID server-side, because the
 * old app's logout was never called by an upgrade. They sit in an unencrypted
 * key/value file. Deleting them is the point.
 *
 * `@react-native-async-storage/async-storage` is a real dependency for exactly
 * this reason. It is otherwise unused, and stays unused: the new app reads
 * tokens from SecureStore and never writes here again.
 */
export async function purgeLegacy(): Promise<void> {
  try {
    await Promise.all(LEGACY_KEYS.map((k) => AsyncStorage.removeItem(k)));
  } catch {
    // Best effort. A failed purge must not block startup, and a device with no
    // legacy keys has nothing to remove.
  }
}

/** Called once at app start, before the first request. */
export function installTokenStore(): void {
  setTokenStore(secureStoreTokens);
}
