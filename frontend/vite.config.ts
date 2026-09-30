import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Bind the IPv4 loopback explicitly. Without this Vite binds `localhost`,
      // which resolves to BOTH 127.0.0.1 and ::1, so the page can be reached
      // at either. That matters because SameSite treats an IP as its own site:
      // reaching the app at http://[::1]:5173 makes the page site ::1 while
      // the API/media edge is 127.0.0.1, and the SameSite=Lax ef_hls_token
      // cookie is then withheld from hls.js's XHR requests -> every /hls/*
      // 403s with "Missing playback token". 127.0.0.1 only, everywhere.
      host: '127.0.0.1',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
