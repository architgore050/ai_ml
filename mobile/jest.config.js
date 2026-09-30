/**
 * jest-expo's own babel transformer, read off the preset rather than re-declared.
 *
 * `preset: 'jest-expo'` below merges `transform` with this one
 * (`jest-config/build/normalize.js` -> `mergeOptionWithPreset(options, preset,
 * 'transform')`), so ONLY the extra pattern is declared here and every preset
 * entry -- the asset transformer for `.svg` / `.png` and friends, and the JS/TS
 * transformer with the babel options jest-expo resolved for this project --
 * still applies. Hand-writing `['babel-jest', {...}]` instead does NOT: without
 * jest-expo's options the preset's Flow syntax stops parsing, and
 * `@react-native/jest-preset/jest/setup.js` dies on `value(id: TimeoutID)`.
 */
const JEST_EXPO_TRANSFORM =
  require('jest-expo/jest-preset').transform['\\.[jt]sx?$'];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // `transformIgnorePatterns` is the part everyone gets wrong: jest-expo's
  // default excludes node_modules, but expo-router / react-native-reanimated /
  // @gorhom ship untranspiled ESM, so they must be transformed.
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-reanimated|react-native-worklets|@gorhom/.*|lucide-react-native))',
  ],
  // `lucide-react-native` is above because its `react-native` EXPORT CONDITION
  // points at real ESM -- `dist/esm/lucide-react-native.mjs` (`package.json`
  // `exports['.'].react-native`), which has to be transformed or the import dies
  // with `SyntaxError: Unexpected token 'export'` before a single assertion runs.
  // That is the same class of defect as reanimated/worklets below, but it lands
  // in `transformIgnorePatterns` rather than in `resolver`, so the fix is the
  // allowlist entry and NOT a per-suite `jest.mock` bridge into `dist/cjs/*`.
  // The `exports` map hides `./dist/cjs/*`, so such a bridge had to be an
  // absolute `__dirname` path into the installed package -- a test-only channel
  // that makes a config defect look like a passing suite.
  //
  // It ALSO needs the `.mjs` transform below, because the allowlist only says
  // "do not ignore this file" and jest-expo's transform pattern is `\.[jt]sx?$`
  // (`jest-expo/jest-preset.js`) -- an `.mjs` file matches NO transform rule at
  // all, so the allowlist alone leaves it untransformed and the SyntaxError
  // survives. Both halves are load-bearing; either alone still fails, and that
  // was verified by running the suite with only the allowlist entry in place.
  transform: {
    '\\.mjs$': JEST_EXPO_TRANSFORM,
  },
  // reanimated 4 depends on worklets 0.10, and BOTH crash at IMPORT time under
  // jest, before a single line of test code runs:
  //   TypeError: Cannot read properties of undefined (reading 'loadUnpackers')
  //     at loadUnpackers (react-native-worklets/src/WorkletsModule/NativeWorklets.native.ts:411)
  //     at Object.require (react-native-reanimated/src/index.ts:5)
  // `NativeWorklets.native.ts:35-40` calls `installUnpackers(globalThis.__workletsModuleProxy)`
  // on the assumption the WorkletsModule TurboModule exists. Under jest it does not,
  // so the proxy is undefined and the first property access throws. jest-expo mocks
  // the LEGACY `ReanimatedModule` TurboModule but not the worklets one reanimated 4
  // actually needs -- a version-skew gap that no amount of `jest.mock` can close,
  // because the crash is in a node_modules import, not in anything we control.
  // The worklets-shipped resolver fixes it at the resolution layer: for any request
  // under (or naming) `react-native-worklets` it drops `.native` from `extensions`, so
  // `NativeWorkletsModule` resolves to the non-native spec and the TurboModule lookup
  // never happens. This must be a top-level `resolver`, not part of moduleNameMapper.
  resolver: 'react-native-worklets/jest/resolver',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // Excluded per plan §16: the tokens are the contract, not the rendered
    // output, so coverage is measured on logic only.
    '!src/design/**',
    '!src/components/**',
  ],
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.expo/'],
};
