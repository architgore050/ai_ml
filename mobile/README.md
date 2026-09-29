# EchoFlow Mobile

**EchoFlow — TikTok for your ears** on iOS and Android.

> **Rebuild in progress.** This directory was cleared in Phase 0 of the
> rebuild tracked in [`docs/mobile-rebuild-plan.md`](../docs/mobile-rebuild-plan.md).
> The previous tree (Expo SDK 52, `expo-av`, 3,313 LOC) was removed because
> playback had no media auth, scrolling never changed the track, and natural
> track completion was counted as a skip. Git history retains it — `git show
> 782ffec:mobile/src/...`.
>
> **Phase status:** Phase 1 (scaffold + auth) in progress. Playback arrives in
> Phase 2 and is **not** claimed at Phase 1.
>
> Do not add app code here until the plan's Phase 1 tasks are done.

## Current state

**Phase 0 and Phase 1 are complete.** The app scaffolds, bundles for iOS and
Android, typechecks clean, and passes 37 unit tests. What it does *not* do is
play audio — that is Phase 2, and nothing in Phase 1 fetches a media token or
touches `expo-audio` playback.

Verified at commit time:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx jest` | 37 passed / 3 suites |
| `npx expo-doctor` | 21/21 checks passed |
| `npx expo install --check` | dependencies up to date |
| `npx expo export --platform ios` | 6.8 MB Hermes bundle |
| `npx expo export --platform android` | bundles |

**Not yet verified:** a running app on a simulator or device. The export proves
Metro resolves the whole router tree; it does not prove a screen renders. First
real boot is the next thing to do.

### Layout

```
app/                          expo-router (D3 — file-based routing)
  _layout.tsx                 providers, font gate, error boundary
  index.tsx                   the auth gate — the only place routing is decided
  +not-found.tsx              404 (the old app had zero deep-link handlers)
  (auth)/login.tsx  (auth)/register.tsx
  (tabs)/index|explore|studio|inbox|profile.tsx    placeholders, Phase 2-5
src/
  api/        client.ts (refresh mutex) · schema.ts (zod) · tokenStore.ts
  design/     tokens.ts · typography.ts · shadows.ts · categories.ts · theme.tsx
  components/ ui/ (primitives, Button) · ErrorBoundary · NetworkBanner
  hooks/      useBackendStatus.ts
  store/      auth.ts
```

### Two things that surprise people

**`app.json` is gone, replaced by `app.config.ts`.** The base URL has to be
resolvable per EAS build profile, and `app.json` cannot interpolate an
environment variable. In SDK 57 the native splash also moved out of the
top-level `splash` key (now PWA-only) into the `expo-splash-screen` plugin — a
stale `splash` block typechecks but is silently ignored on iOS and Android.

**`src/design/categories.ts` is the only place a category string is written.**
`AudioClip.category` is free text server-side, and
`/suggestions/?category=` matches on exact equality, so a near-miss like
`"Lo-Fi"` vs `"Lo-Fi Beats"` returns an empty list rather than an error. The 5
branded categories and 6 legacy values, and their colours, all come from that
one file (decision O2).

## Known friction

**No committed lockfile.** The root `.gitignore:34` ignores
`mobile/package-lock.json` (and `frontend/package-lock.json`) — a pre-existing
repo convention, not something this branch introduced. It means `npm install`
resolves fresh on every machine, so the SDK-aligned versions that
`npx expo install` selected are not reproducible, and two developers can end up
on different trees. Left alone deliberately: changing it affects `frontend/`
too and is a repo-wide reproducibility decision, not a mobile one. Worth an
explicit decision.

**Typed routes need one command.** `experiments.typedRoutes` is on, but
`.expo/types/router.d.ts` is generated and gitignored. Run `npx expo start` or
`npx expo customize tsconfig.json` once after cloning, or `router.push('/…')`
will not be typechecked.

**`SALVAGE.ts` is temporary.** Delete it once Phase 1 is signed off.

## Requirements

- **Expo SDK 57** (owner-approved 2026-09-29). Not 55 — `latest` was 57.0.25
  at the time of decision and the old app was on 52.0.37, so this is a
  three-major scaffold, not an upgrade.
- Install every dependency with `npx expo install`. Hand-written version
  ranges drift from the SDK's compatible set, and the failure surfaces later
  as a native-module mismatch at build time rather than as a version warning.
- Continuous Native Generation: **no committed `ios/` or `android/`.**
  `npx expo prebuild` generates them at build time.

## Backend

The API base URL is **https only** and comes from `EXPO_PUBLIC_API_BASE_URL`,
set per EAS build profile. The old default was `http://localhost:8005` /
`http://10.0.2.2:8005` — the plaintext debug escape hatch that `AGENTS.md`
says to drop. `web:8005` is not a supported path.

A physical device additionally needs `https://<LAN-IP>:18443` (API) and
`https://<LAN-IP>:19443` (HLS), plus a certificate covering that LAN IP.
`docker/certs/localhost.crt` does not cover one, so certificate setup is
**manual and documented, not committed**. Until that is solved, only a
simulator can exercise playback — see `docs/mobile-rebuild-plan.md` §I9.
Simulator verification is not device verification and must not be reported as
such.

## Docs

- [`docs/mobile-rebuild-plan.md`](../docs/mobile-rebuild-plan.md) — the
  architecture, the 13 defects, decisions D1–D10, the token system, the build
  phases, and the salvage list
- [`docs/EXPLAIN/decisions/2026-09-29-mobile-phase-0-1-detail.md`](../docs/EXPLAIN/decisions/2026-09-29-mobile-phase-0-1-detail.md)
  — Phase 0 + 1 execution detail and the todo list
- [`docs/EXPLAIN/decisions/2026-09-29-mobile-task-list.md`](../docs/EXPLAIN/decisions/2026-09-29-mobile-task-list.md)
  — the phase overview
- [`docs/FRONTEND-REQUIREMENTS.md`](../docs/FRONTEND-REQUIREMENTS.md) — the
  API contract, including the four coexisting response envelopes and the
  behaviours no backend supports
