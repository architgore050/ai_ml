import React from 'react';
import { Tabs } from 'expo-router';
import { Headphones, Compass, PlusCircle, Inbox, User } from 'lucide-react-native';

import { surface, content, accent, border, layout } from '../../src/design/tokens';

/**
 * Tab shell. Five tabs, matching the product's IA: Feed, Discover, Studio,
 * Inbox, Profile.
 *
 * `tabBarIcon` sizes come from tokens (type.icon = 22) and the bar reserves
 * `layout.navClearance` (100px) so the feed's last reel is not hidden behind
 * it — the old app hardcoded `height: 60` and computed reel height as
 * `SCREEN_HEIGHT - 130`, a magic number that drifted with device size.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent.base,
        tabBarInactiveTintColor: content.tertiary,
        tabBarStyle: {
          backgroundColor: surface.containerLow,
          borderTopColor: border.default,
          height: layout.navClearance,
          paddingBottom: 20,
          paddingTop: 12,
        },
        tabBarLabelStyle: { fontSize: 9, fontWeight: '700', letterSpacing: 0.08 },
        sceneStyle: { backgroundColor: surface.base },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarAccessibilityLabel: 'Feed',
          tabBarIcon: ({ color, size }) => <Headphones size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Discover',
          tabBarAccessibilityLabel: 'Discover',
          tabBarIcon: ({ color, size }) => <Compass size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="studio"
        options={{
          title: 'Studio',
          tabBarAccessibilityLabel: 'Upload a clip',
          tabBarIcon: ({ color, size }) => <PlusCircle size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarAccessibilityLabel: 'Inbox',
          tabBarIcon: ({ color, size }) => <Inbox size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarAccessibilityLabel: 'Profile',
          tabBarIcon: ({ color, size }) => <User size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
