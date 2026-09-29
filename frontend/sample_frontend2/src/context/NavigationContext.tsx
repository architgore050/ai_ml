import { createContext, useContext, ReactNode } from 'react';
import { useNavigate, NavigateOptions } from 'react-router-dom';

interface NavigationContextValue {
  go: (path: string, params?: Record<string, unknown>, options?: NavigateOptions) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  const go = (path: string, params?: Record<string, unknown>, options?: NavigateOptions) => {
    let finalPath = path;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        searchParams.set(key, String(value));
      });
      finalPath = `${path}?${searchParams.toString()}`;
    }
    navigate(finalPath, options);
  };

  return (
    <NavigationContext.Provider value={{ go }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}