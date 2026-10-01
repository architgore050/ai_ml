import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';

/**
 * The nginx TLS terminator already uses these; reuse them so the browser
 * sees one trusted certificate for page, API and media and does not prompt
 * twice. Also `docker/nginx.conf` and `docker/nginx.local.conf` bind-mount the
 * same pair.
 */
function resolveCert(name: string): string {
  return path.resolve(__dirname, '..', 'docker', 'certs', name);
}

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
      // HTTPS is load-bearing, not cosmetic. Chrome compares SameSite on
      // SCHEME + site (schemeful same-site), so an `http://` page does not
      // count as same-site with the `https://` API and media edge. The
      // SameSite=Lax ef_hls_token cookie is then withheld from the hls.js
      // XHR and every /hls/* request 403s with "Missing playback token" --
      // with the cookie stored correctly and CORS fully allowed, so neither
      // check explains it. curl cannot catch this: it ignores SameSite.
      //
      // Production is all-https on one registrable domain (app./api./media.
      // echoflow.in), so it is same-site there. Serving the dev page over
      // TLS reproduces that instead of weakening the cookie to
      // SameSite=None. The cert's SANs cover IP 127.0.0.1 and DNS localhost.
      //
      // An https page changes the Origin to https://127.0.0.1:5173, which
      // must also be on the CORS allowlists (Django settings +
      // workers/hls-token-worker ALLOWED_ORIGINS) or requests fail CORS.
      https: {
        key: readFileSync(resolveCert('localhost.key')),
        cert: readFileSync(resolveCert('localhost.crt')),
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
