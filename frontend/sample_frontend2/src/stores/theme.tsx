import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { ThemeMode } from '../types';

const ThemeContext = createContext<{ theme: ThemeMode; toggle: () => void } | null>(null);
export const useTheme = () => useContext(ThemeContext)!;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem('ef_theme') as ThemeMode) || 'dark');

  useEffect(() => {
    const root = document.documentElement;
    const isDark = theme === 'dark' || (theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('ef_theme', theme);
  }, [theme]);

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}
