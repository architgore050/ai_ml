import React from 'react';
import { Stack } from 'expo-router';

import { surface } from '../../src/design/tokens';

/**
 * Auth route group. Screens here are only reachable when `status` is
 * `anonymous` or `expired` — the gate is `app/index.tsx`.
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: surface.base },
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
    </Stack>
  );
}
