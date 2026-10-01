import React from 'react';
import { Redirect } from 'expo-router';

import { useAuthStore } from '../src/store/auth';
import { Spinner } from '../src/components/ui/Button';
import { surface } from '../src/design/tokens';
import { View } from 'react-native';

/**
 * Auth gate. The only place that decides which stack the user sees.
 *
 * `initialising` renders a spinner and nothing else — no navigation at all —
 * because redirecting before the Keychain has been read would bounce an
 * authenticated user to the login screen and back. That is the race the old
 * `AuthContext` had: `isLoading` and `isAuthenticated` were separate booleans
 * and screens checked one or the other inconsistently.
 *
 * `expired` routes to login like `anonymous` does; the login screen shows the
 * "session expired" copy so the user is told what happened rather than simply
 * being presented with a form they did not ask for.
 */
export default function Index() {
  const status = useAuthStore((s) => s.status);

  if (status === 'initialising') {
    return (
      <View style={{ flex: 1, backgroundColor: surface.base, justifyContent: 'center' }}>
        <Spinner label="Restoring your session" />
      </View>
    );
  }

  if (status === 'authenticated') {
    return <Redirect href="/(tabs)" />;
  }

  return <Redirect href="/(auth)/login" />;
}
