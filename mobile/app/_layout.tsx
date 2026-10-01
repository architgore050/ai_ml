import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Lexend_300Light,
  Lexend_400Regular,
  Lexend_500Medium,
  Lexend_600SemiBold,
  Lexend_700Bold,
  Lexend_800ExtraBold,
  Lexend_900Black,
  useFonts,
} from '@expo-google-fonts/lexend';

import { surface } from '../src/design/tokens';
import { ThemeProvider } from '../src/design/theme';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { useAuthStore } from '../src/store/auth';
import { applyPlaybackAudioMode } from '../src/lib/audioMode';
import { releasePlayer } from '../src/store/player';
import { PlayerHost } from '../src/hooks/PlayerHost';
import { TelemetryHost } from '../src/components/TelemetryHost';
import { RevenueCatHost } from '../src/components/RevenueCatHost';
import { initMobileSentry } from '../src/lib/sentry';

/**
 * Root layout. Providers only — no navigation decisions, no data fetching.
 *
 * Auth routing is decided in `app/index.tsx` (a redirect), not by conditionally
 * rendering stacks here. Two reasons: a conditional stack means every screen
 * unmounts on a status flip (losing player position, in Phase 2), and it makes
 * the back stack ambiguous after a re-login. Route groups plus `<Redirect>`
 * give a deterministic stack.
 *
 * Fonts are gated: the app renders nothing until Lexend loads. The design
 * system's identity is the type (globals.css:77-78, "weight + tracking do the
 * work"), and a first paint in the system font reflows every screen when the
 * real font arrives — a visible flash on every cold start.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // D4: TanStack Query owns every server read. The old app hand-rolled
      // cache state in useEffect, which is what produced defects 1 and 3.
      staleTime: 30_000,
      retry: 1,
      // A 4xx is not transient; retrying a 400 or 401 just delays the error.
      retryOnMount: true,
    },
  },
});

initMobileSentry();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Lexend_300Light,
    Lexend_400Regular,
    Lexend_500Medium,
    Lexend_600SemiBold,
    Lexend_700Bold,
    Lexend_800ExtraBold,
    Lexend_900Black,
  });

  const init = useAuthStore((s) => s.init);
  const status = useAuthStore((s) => s.status);

  useEffect(() => {
    void init();
  }, [init]);

  /**
   * ONE audio session and ONE player for the whole app, established here at the
   * root — deliberately OUTSIDE the `<Stack>`, and outside anything that
   * unmounts when the auth status flips.
   *
   * Two separate reasons, both from defects the old app shipped:
   *  1. The old app owned its player inside a feed card, so it unmounted with
   *     the view and every swipe killed playback (plan §10).
   *  2. `applyPlaybackAudioMode` reconfigures the platform audio session. On
   *     Android, re-issuing it re-acquires audio focus, which can drop the
   *     current stream. Doing it once, at startup, is the only safe place.
   */
  useEffect(() => {
    // SECURITY/robustness: a rejecting `setAudioModeAsync` would otherwise be
    // an unhandled rejection and audio would silently never be configured.
    void applyPlaybackAudioMode().catch(() => {
      // The mode is applied once and cached; a retry would not help, and the
      // NetworkBanner already tells the user something is wrong.
    });
    return () => releasePlayer();
  }, []);

  // Block first paint until the font resolves, but do not block forever: a font
  // CDN failure should degrade to the system font, not hang the app on a splash.
  const fontsSettled = fontsLoaded || fontError != null;

  if (!fontsSettled) {
    return <View style={{ flex: 1, backgroundColor: surface.base }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <StatusBar style="light" />
            {/* Owns the one AudioPlayer: creates it, mirrors its status into
                the store, and registers lock-screen controls. Renders null.
                Inside the providers but outside <Stack> so an auth-status flip
                cannot unmount it and kill playback. */}
            <PlayerHost />
            {/* Mounted AFTER <PlayerHost /> as a sibling. The sibling order is
                what matters, not nesting: React runs parent cleanups before
                child ones, so the parent's releasePlayer() -> reset() is NOT
                what sequences this - it has already nulled playingClipId by the
                time any child cleanup runs, and TelemetryHost's send-time gate
                correctly refuses the final sample rather than reporting a clip
                the player no longer holds. Sibling order keeps the two hosts
                independent so an auth-status flip cannot unmount either.
                Renders null. */}
            <TelemetryHost />
            <RevenueCatHost />
            <ErrorBoundary>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: surface.base },
                  // Nothing may navigate until the session question is settled.
                  animation: status === 'initialising' ? 'none' : 'slide_from_right',
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(tabs)" />
              </Stack>
            </ErrorBoundary>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
