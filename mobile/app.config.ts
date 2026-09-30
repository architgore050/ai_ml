import type { ExpoConfig, ConfigContext } from 'expo/config';

// DECISION: app.config.ts rather than app.json, so EXPO_PUBLIC_API_BASE_URL is
// resolvable per EAS build profile (plan D9). app.json cannot interpolate an
// environment variable, so the base URL would have to be hardcoded — which is
// exactly how the old app ended up defaulting to the plaintext debug escape
// hatch http://localhost:8005.
//
// SECURITY (D9): https only, no exceptions. The nginx terminator on :443 is
// the only supported entrypoint; `web:8005` is a debug escape hatch that AGENTS.md
// says to drop, and routing a phone app at it would reintroduce the plaintext
// default with a device-shaped blast radius. `assertHttps` fails the build
// rather than shipping a plaintext app.
const DEFAULT_API_BASE_URL = 'https://localhost:18443';
const APP_VERSION = '1.0.0';
type ReleaseChannel = 'development' | 'preview' | 'production';

// HACK: ConfigContext.env is typed NodeJS.ProcessEnv, which reads as always
// present, but @expo/config evaluates app.config.ts with `env` undefined in
// several paths (notably `expo install`). Destructuring it straight off the
// context therefore throws before the config is ever used — and the error
// surfaces as "Cannot read properties of undefined" from a transpiled
// app.config.js, nowhere near the real line. Default to process.env and then
// to an empty object so a missing env is a missing variable, not a crash.
function readEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env ?? {};
}

function resolveReleaseChannel(env: NodeJS.ProcessEnv): ReleaseChannel {
  const value = env.EXPO_PUBLIC_RELEASE_CHANNEL?.trim() || 'development';
  if (value === 'development' || value === 'preview' || value === 'production') return value;
  throw new Error(`EXPO_PUBLIC_RELEASE_CHANNEL must be development, preview, or production; got "${value}".`);
}

function resolveApiBaseUrl(env: NodeJS.ProcessEnv, channel: ReleaseChannel): string {
  const raw = env.EXPO_PUBLIC_API_BASE_URL?.trim();
  // A localhost default is useful only for an interactive local-development
  // command. Preview and production must name an explicit origin: silently
  // baking localhost into either artifact would ship a dead app.
  if (!raw) {
    if (channel === 'development') return DEFAULT_API_BASE_URL;
    throw new Error(`EXPO_PUBLIC_API_BASE_URL is required for the ${channel} build profile.`);
  }

  // Fail loudly. A silent fallback here is how the old app got `http://` baked
  // in: the URL was wrong and nothing complained until a request failed.
  if (!raw.startsWith('https://')) {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must be https, got "${raw}". ` +
        'nginx :443 is the only supported entrypoint (plan D9).',
    );
  }
  return raw.replace(/\/+$/, '');
}

// SECURITY: no plaintext HTTP, ever. ATS (iOS) and the network security config
// (Android) will reject it at runtime, but failing the build is better than
// failing on a user's device.
function assertHttps(url: string, label: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(`${label} must be https, got "${url}"`);
  }
}

// BRAND: midnight #121416 from the design source (globals.css:53). The template
// ships a light-blue adaptive-icon background (#E6F4FE) and a light
// userInterfaceStyle, both of which contradict the design system's dark-only MVP.
const MIDNIGHT = '#121416';
const TERRACOTTA = '#e8a87c';

export default (_context: ConfigContext): ExpoConfig => {
  // ConfigContext in SDK 57 is {projectRoot, staticConfigPath, packageJsonPath,
  // config} — it has NO `env` member, so the documented `({env}) => …` signature
  // no longer typechecks. `process.env` is the correct source, which is also why
  // the readEnv() guard above still matters: the config is evaluated by
  // `expo install`, `expo prebuild` and EAS, and they do not all populate
  // process.env identically.
  const env = readEnv(process.env);
  const releaseChannel = resolveReleaseChannel(env);
  const apiBaseUrl = resolveApiBaseUrl(env, releaseChannel);
  const runtimeVersion = env.EXPO_PUBLIC_RUNTIME_VERSION?.trim()
    || (releaseChannel === 'production' ? APP_VERSION : `${APP_VERSION}-${releaseChannel}`);
  if (!runtimeVersion) throw new Error('EXPO_PUBLIC_RUNTIME_VERSION must not be empty.');

  return {
    name: 'EchoFlow',
    slug: 'echoflow-mobile',
    version: APP_VERSION,
    runtimeVersion,
    orientation: 'portrait',
    // Keep the product scheme for app links and register RevenueCat's
    // dashboard-generated callback scheme for paywall previews/redemptions.
    // Both are public routing metadata; neither is a credential.
    scheme: ['echoflow', 'rc-72c5c981d7'],
    // D3: expo-router owns the entry point, so `main` moves off index.ts.
    userInterfaceStyle: 'dark',
    icon: './assets/icon.png',
    ios: {
      supportsTablet: false, // MVP, plan §12
      bundleIdentifier: 'com.echoflow.audio',
      infoPlist: {
        UIBackgroundModes: ['audio'],
        NSMicrophoneUsageDescription:
          'EchoFlow needs microphone access so you can record and publish audio clips.',
      },
    },
    android: {
      package: 'com.echoflow.audio',
      adaptiveIcon: {
        backgroundColor: MIDNIGHT,
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      permissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS',
        'android.permission.WAKE_LOCK',
        'android.permission.FOREGROUND_SERVICE',
      ],
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      // Trust the self-signed dev CA so a physical phone can complete the TLS
      // handshake against https://<LAN-IP>:18443. Android 7+ ignores
      // user-installed CAs unless the app opts in, and `android/` is gitignored
      // and wiped by `prebuild --clean`, so this must be a config plugin.
      //
      // It injects into src/debug/ ONLY and no-ops for preview/production — see
      // the SECURITY note in the plugin. It throws if the channel is unset, so
      // a missing env var cannot quietly widen the trust boundary.
      [
        './plugins/withDevCaTrust',
        { releaseChannel },
      ],
      // D3: file-based routing. Auth lives in route groups — app/(auth)/ vs
      // app/(tabs)/ — which is what makes the `scheme: "echoflow"` declared
      // above actually do something. The old app declared it and had zero
      // deep-link handlers. RevenueCat's generated scheme is declared beside
      // it at the top level so Expo emits both native URL registrations.
      'expo-router',
      'expo-secure-store',
      // D2: the reason expo-audio was chosen over react-native-track-player.
      // This plugin emits Android's AudioControlsService (MediaSessionService,
      // for lock-screen transport controls) and iOS's UIBackgroundMode: audio.
      [
        'expo-audio',
        {
          microphonePermission:
            'Allow EchoFlow to access your microphone for recording audio reels.',
        },
      ],
      'expo-font',
      'expo-web-browser',
      '@sentry/react-native',
      // SDK 57 moved the native splash out of the top-level `splash` key (which
      // is now PWA-only per @expo/config-types) and into this plugin. The old
      // app.json's `splash` block would have been silently ignored on iOS and
      // Android while still typechecking, which is the worst combination.
      [
        'expo-splash-screen',
        {
          backgroundColor: MIDNIGHT,
          image: './assets/splash-icon.png',
          resizeMode: 'contain',
          imageWidth: 160,
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      apiBaseUrl,
      releaseChannel,
      // brand tokens surfaced to app.config consumers; runtime code reads
      // src/design/tokens.ts, not this, so there is one source of truth.
      brand: { midnight: MIDNIGHT, terracotta: TERRACOTTA },
    },
  };
};
