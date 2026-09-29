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
