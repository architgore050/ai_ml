# Frontend notes

- `xhr.withCredentials` on the hls.js instance: **done**. See
  `src/stores/player.tsx` (`xhrSetup` in the `new Hls({...})` config) and the
  native/Safari path, which sets `audio.crossOrigin = "use-credentials"`
  because `"anonymous"` will not send the cookie cross-origin. The token itself
  is minted by `mediaAPI.getPlaybackToken()` in `src/api/client.ts` (POST,
  `credentials: "include"`). Do not reintroduce a "fall back to direct HLS" path
  on token failure — the `hls/` prefix is not public-read and is validated at
  the edge, so the fallback only 403s.
- `npm run dev` needs `VITE_API_BASE_URL` set to the nginx terminator
  (`https://localhost`), not a bare `localhost:8005`. There is no mock backend
  any more; `server.ts` was removed.
- `npx tsc` / `npm run lint` works and is scoped to `src/` via `tsconfig.json`
  `include`. `strict` is still OFF — turning it on is the next step and will
  surface a batch of implicit-any errors, because `@types/react` was missing
  until this pass and every React state hook was silently `any`.
