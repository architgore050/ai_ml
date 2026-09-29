import { create } from 'zustand';

import { getTokenStore, onSessionExpired } from '../api/client';
import { installTokenStore, purgeLegacy, secureStoreTokens } from '../api/tokenStore';
import * as authApi from '../api/endpoints/auth';
import type { OwnProfile } from '../api/schema';

/**
 * Auth state. Zustand, not React Context (D4): the old `AuthContext` derived
 * `isAuthenticated` from `!!user`, which is not authoritative — a user object
 * restored from storage is not a valid session, and a valid session with a
 * failed profile fetch looked like a signed-out user.
 *
 * `status` is an explicit three-state enum so "still deciding" is
 * unrepresentable-as-signed-out. The old app had `isLoading` alongside
 * `isAuthenticated` and screens checked one or the other inconsistently.
 *
 * Access token lifetime is 15 minutes (settings.py:770) and the refresh token
 * lives 7 days (:771). The 7-day expiry is the *real* session boundary and gets
 * its own status so the UI can say "please sign in again" rather than
 * "something went wrong".
 */

export type AuthStatus =
  /** Cold start: reading the Keychain and validating. Nothing may navigate. */
  | 'initialising'
  | 'authenticated'
  | 'anonymous'
  /** Refresh token expired or was revoked. Distinct from a plain sign-out. */
  | 'expired';

type AuthState = {
  status: AuthStatus;
  user: OwnProfile | null;
  /** True while a login/register/logout call is in flight. */
  busy: boolean;
  error: string | null;

  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (input: authApi.RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  setExpired: () => void;
};

let initialised = false;
let unsubscribeSessionExpired: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'initialising',
  user: null,
  busy: false,
  error: null,

  /**
   * Cold start. Reads tokens from the Keychain, purges the old app's
   * unencrypted AsyncStorage keys, and validates against `/profile/me/`.
   *
   * The stored *user* is deliberately not trusted: only the presence of a token
   * plus a successful authenticated call makes a session. The old app
   * short-circuited on a cached user object (AuthContext.tsx:40).
   */
  async init() {
    if (initialised) return;
    initialised = true;
    installTokenStore();
    unsubscribeSessionExpired = onSessionExpired(() => get().setExpired());

    try {
      await purgeLegacy();
    } catch {
      // Best effort; a failed purge must not block startup.
    }

    const store = getTokenStore();
    const [access, refresh] = await Promise.all([store.getAccess(), store.getRefresh()]);
    if (!access || !refresh) {
      set({ status: 'anonymous', user: null });
      return;
    }

    try {
      // A 401 here triggers the client's refresh+replay, so a valid refresh
      // token survives an expired access token without an explicit refresh.
      const user = await authApi.getMyProfile();
      set({ status: 'authenticated', user, error: null });
    } catch {
      // Tokens present but the session did not validate. getMyProfile's 401
      // path already emitted session-expired, which flipped us to 'expired'.
      // If we are still 'initialising' the failure was network-shaped, not
      // auth-shaped — do not discard tokens for a flaky connection.
      if (get().status === 'initialising') {
        set({ status: 'anonymous', user: null });
      }
    }
  },

  async login(username, password) {
    set({ busy: true, error: null });
    try {
      const pair = await authApi.login(username, password);
      await secureStoreTokens.set(pair);
      const user = await authApi.getMyProfile();
      set({ status: 'authenticated', user, busy: false, error: null });
    } catch (err) {
      const message = authApi.authErrorMessage(err) ?? 'Could not sign in. Try again.';
      // A 429 on 'login' is 10/min/IP (credential stuffing), NOT a wrong
      // password — saying "wrong password" sends the user into a retry loop
      // that guarantees the 429 continues.
      set({
        busy: false,
        error: message,
        status: 'anonymous',
      });
      throw err;
    }
  },

  /**
   * Register then log in. `POST /auth/register/` returns a User and **no
   * tokens** (by design), so the login call is not optional.
   */
  async register(input) {
    set({ busy: true, error: null });
    try {
      await authApi.register(input);
      const pair = await authApi.login(input.username, input.password);
      await secureStoreTokens.set(pair);
      const user = await authApi.getMyProfile();
      set({ status: 'authenticated', user, busy: false, error: null });
    } catch (err) {
      set({ busy: false, error: authApi.authErrorMessage(err) ?? 'Could not create account.' });
      throw err;
    }
  },

  /**
   * Blacklist the refresh token, then clear local state **in a `finally`**. If
   * the network call fails the user must still be signed out locally — the
   * alternative is a signed-out UI with live tokens on the device.
   */
  async logout() {
    const refresh = await getTokenStore().getRefresh();
    set({ busy: true });
    try {
      if (refresh) await authApi.logout(refresh);
    } catch {
      // Swallowed on purpose — see above. The refresh token is short-lived and
      // the local clear is what matters for the device.
    } finally {
      await getTokenStore().clear();
      set({ status: 'anonymous', user: null, busy: false, error: null });
    }
  },

  clearError() {
    set({ error: null });
  },

  /** 401 that survived a refresh, or a 7-day refresh expiry. */
  setExpired() {
    if (get().status === 'authenticated') {
      set({ status: 'expired', user: null, error: null });
    }
  },
}));

/** Test seam: reset the init guard so `init()` can run again per test. */
export function __resetAuthStoreForTests(): void {
  initialised = false;
  unsubscribeSessionExpired?.();
  unsubscribeSessionExpired = null;
  useAuthStore.setState({
    status: 'initialising',
    user: null,
    busy: false,
    error: null,
  });
}
