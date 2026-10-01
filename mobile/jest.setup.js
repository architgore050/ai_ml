/* eslint-env node */

// jest.setup.js
//
// Three things must exist before any test imports the client:
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
//
//  3. reanimated's custom matchers, via setUpTests() at the bottom of this file.

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

// reanimated's `setUpTests()` registers `toHaveAnimatedStyle` /
// `toHaveAnimatedProps` on jest's `expect` (jestUtils/index.ts:314-337). Without
// it those matchers are simply undefined, so an animated assertion reads as
// "not a function" instead of failing on the value.
//
// It is LAST on purpose, and the ordering is load-bearing in one direction only:
// reaching it `require()`s all of reanimated, which happens *after* both
// `jest.mock` calls above have registered. Reanimated does not import
// expo-constants or expo-secure-store itself today (verified), so this order is
// defensive rather than load-bearing-today -- but it costs nothing and it means a
// future reanimated that grows an expo dependency cannot silently capture the
// real module before the mock exists.
//
// What `setUpTests` does NOT do is worth stating, because the deprecated helpers
// are the obvious thing to reach for instead: it never touches timers. The
// deprecated `withReanimatedTimer()` is the only thing here that called
// `jest.useFakeTimers()` (jestUtils/index.ts:243-259), and it is deprecated
// precisely because that side effect was a trap. Time is advanced explicitly in
// the test with `jest.useFakeTimers()` + `jest.advanceTimersByTime()`.
//
// Note this file uses a bare `require`, not `import`: babel-plugin-jest-hoist
// hoists `jest.mock` above ESM imports within the file, so `import` would defeat
// the ordering argued above.
require('react-native-reanimated').setUpTests();
