import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useBackendStatus } from '../hooks/useBackendStatus';

interface DemoModeContextValue {
  isDemoMode: boolean;
}

const DemoModeContext = createContext<DemoModeContextValue | null>(null);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState(true);
  const backendStatus = useBackendStatus();

  useEffect(() => {
    if (backendStatus !== null) {
      setIsDemo(!backendStatus);
    }
  }, [backendStatus]);

  return (
    <DemoModeContext.Provider value={{ isDemoMode: isDemo }}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode() {
  const ctx = useContext(DemoModeContext);
  if (!ctx) throw new Error('useDemoMode must be used within DemoModeProvider');
  return ctx.isDemoMode;
}