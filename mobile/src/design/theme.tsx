import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import {
  accent,
  border,
  content,
  m3,
  radius,
  spacing,
  status,
  surface,
  type as typeScale,
} from './tokens';
import { typography } from './typography';

/**
 * Theme object. Dark-only at MVP (plan §12: "Light theme — tokens ship it,
 * dark-only at MVP"). The token values for a light theme exist in globals.css
 * [data-theme="light"] (lines 97-118) and are intentionally NOT wired up: a
 * half-built light theme is worse than none, and `userInterfaceStyle: "dark"`
 * in app.config.ts means the OS will never request one.
 *
 * The palette below is a *view* of the tokens, not a second source — every value
 * is read from tokens.ts, which is transcribed from the design source.
 */

export type ThemePalette = {
  dark: true;
  background: string;
  surface: typeof surface;
  content: typeof content;
  border: typeof border;
  accent: typeof accent;
  status: typeof status;
  m3: typeof m3;
};

const palette: ThemePalette = {
  dark: true,
  background: surface.base,
  surface,
  content,
  border,
  accent,
  status,
  m3,
};

export type Theme = {
  palette: ThemePalette;
  radius: typeof radius;
  spacing: typeof spacing;
  typeScale: typeof typeScale;
  typography: typeof typography;
  colorScheme: 'dark';
};

const theme: Theme = {
  palette,
  radius,
  spacing,
  typeScale,
  typography,
  colorScheme: 'dark',
};

const ThemeContext = createContext<Theme>(theme);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // HACK: read but ignore. `userInterfaceStyle: "dark"` pins the app dark, but
  // reading the scheme here would make `colorScheme` look conditional when it is
  // not — and a future light theme would then need this component rewritten, not
  // just the palette swapped. Kept explicit so the "dark-only" decision is
  // visible at the seam rather than inferred.
  const scheme = useColorScheme();
  void scheme;
  const value = useMemo(() => theme, []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
