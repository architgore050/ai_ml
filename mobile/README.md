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

`app.json` holds only the identity that survives the rewrite — bundle IDs
`com.echoflow.audio`, `scheme: "echoflow"`, `UIBackgroundModes: ["audio"]`,
and the microphone usage string. It is replaced by `app.config.ts` in task
1.6, because `EXPO_PUBLIC_API_BASE_URL` has to be resolvable per EAS profile.

`SALVAGE.ts` is a read-only reference of the patterns worth keeping from the
old tree, each annotated with its original `file:line` and the reason it
survived. **Delete it once Phase 1 is complete.**

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
