import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './stores/theme';
import { AuthProvider } from './stores/auth';
import { PlayerProvider } from './stores/player';
import { ToastProvider } from './stores/toast';
import { NavigationProvider } from './context/NavigationContext';
import { DemoModeProvider } from './context/DemoModeContext';
import { AppRouter } from './app/router';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <NavigationProvider>
            <DemoModeProvider>
              <PlayerProvider>
                <AppRouter />
              </PlayerProvider>
            </DemoModeProvider>
          </NavigationProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
