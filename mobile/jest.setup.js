/* eslint-env node */

// jest.setup.js
//
// Two things must exist before any test imports the client:
//
//  1. EXPO_PUBLIC_API_BASE_URL. client.ts calls resolveBaseUrl() at MODULE
//     LOAD, not per request, and throws on a non-https or empty base. That is
//     deliberate (a silent plaintext fallback is the bug the old app shipped),
//     but it means a test run without the env var fails at import with a
//     message about the API base URL rather than about the test. Setting it here
//     keeps the failure where it belongs.
//
//  2. A stub SecureStore. expo-secure-store's native module is absent under
//     jest, so any import of src/api/tokenStore.ts throws at require time.

process.env.EXPO_PUBLIC_API_BASE_URL = 'https://localhost:18443';

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key);
    }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    __store: store,
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: { extra: { apiBaseUrl: 'https://localhost:18443' } },
  },
}));
