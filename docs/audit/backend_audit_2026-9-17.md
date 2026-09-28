# Mobile / Backend Contract Audit

Date: 2026-09-17

## Status

Initial draft. Findings below come from the mobile source already reviewed. Full documentation review, remaining mobile files, backend verification, severity calibration, and checks are in progress. This is not yet a completed audit.

Scope: first-party source and configuration under `mobile/`, assessed against every document under `docs/EXPLAIN/`. Installed dependencies and generated bundles are not first-party source; their metadata and configuration will be assessed separately. No application code changes are intended.

## Initial findings requiring final verification

- **Authentication entrypoint absent:** `mobile/App.tsx` always renders the five application tabs. The reviewed authentication context can persist supplied tokens but no reviewed entrypoint obtains them. Verify remaining screens before concluding that fresh installs cannot sign in.
- **Unsupported HTTP defaults:** `mobile/src/services/api.ts` defaults to cleartext HTTP on debug port 8005, whereas the repository operational contract requires the nginx HTTPS entrypoint. Check current compose/settings and deployed overrides.
- **HLS authorization not integrated:** `mobile/src/services/audioPlayer.ts` directly opens `hls_playlist_url`; the reviewed API layer has no playback-token request. Verify the backend token contract and distinguish browser-cookie behavior from native player behavior.
- **Feed reload tied to playback state:** `FeedScreen.loadFeed` depends on `currentClip` and is invoked by an effect. Playback and like updates change `currentClip`, potentially requesting and replacing another feed batch.
- **Stale scroll callback:** `FeedScreen.onViewableItemsChanged` is retained from the initial render with `useRef`, capturing the initial empty `clips` array and initial index.
- **Playback races and false success:** concurrent `loadAndPlay` calls have no generation guard; load failures are swallowed while `PlayerProvider.playClip` unconditionally sets playing state true.
- **Telemetry measures elapsed wall time:** `flushTelemetry` includes pauses, buffering, and failed loads rather than accumulated playback. Natural completion invokes `skipNext`, which also registers a skip.
- **Auth/storage lifecycle mismatch:** failed refresh clears persistent credentials without notifying `AuthContext`; startup profile errors are not caught; the player is not reset on logout.

## Pending completion

Read all remaining first-party mobile files and all EXPLAIN documents; validate endpoint and response contracts against implementation; run available static checks; add source line references, impact, remediation, test recommendations, coverage inventory, and explicit limitations.
