import { useWatchTelemetry } from '../hooks/useWatchTelemetry';

/**
 * The app-wide owner of the watch-telemetry session.
 *
 * ## Why a component, and why it renders `null`
 * The session is a mutable reducer (`lib/telemetrySession.ts`) that has to be
 * fed from three places a pure module cannot reach — the player store, the
 * platform `AppState`, and React's unmount — so somebody with a lifecycle has
 * to own it. `PlayerHost.tsx` is the precedent: it is a component rather than a
 * hook because a Zustand store cannot call a hook and `expo-audio`'s status
 * event is not exported from its public entry point.
 *
 * It renders `null` because it has no UI. Nothing here can be shown, and a
 * telemetry session with a view would invite someone to add one.
 *
 * ## Where it goes, and why the position in the tree is load-bearing
 * Mount it in `app/_layout.tsx` AFTER `<PlayerHost />`:
 *
 *     <PlayerHost />
 *     <TelemetryHost />
 *
 * Two sibling effects clean up left-to-right, so the telemetry session is torn
 * down before anything the player host leaves behind. `releasePlayer()`
 * (`app/_layout.tsx:93`) calls `reset()`, which discards `currentTime` and
 * `playingClipId` — the two fields the final flush would read — so a teardown
 * that reset first cannot report anything, correctly.
 *
 * It belongs OUTSIDE `<Stack>` and outside `<ErrorBoundary>` for the same
 * reason `<PlayerHost />` does: an auth-status flip or a render error in one
 * route must not tear down a session that is measuring every other route.
 *
 * ## Props
 * None. Deliberately, and the reasoning is worth stating because the obvious
 * alternative is a prop and it does not work.
 *
 * The one thing a screen needs from this host is the abandonment fact — the
 * user-swipe vs auto-advance distinction that only the feed knows. It has to
 * travel screen → host, and:
 *
 *  - a prop on the SCREEN is unreachable: expo-router renders a route with
 *    `{ route, navigation, params }` (`app/(tabs)/index.tsx:95` says so itself),
 *    so nothing in `app/_layout.tsx` can hand a value to a screen;
 *  - a prop on THIS component is equally unreachable in that direction — it
 *    would be a callback the host invokes, not one the screen invokes, so it
 *    cannot carry the screen's report at all. It would only be usable with a
 *    bridge (a context provider in `app/(tabs)/_layout.tsx`) that does not exist.
 *
 * So the seam is a handle the screen obtains from a module registry — the same
 * shape as `api/client.ts:128`'s `onSessionExpired`. It works today, with no
 * layout wiring, and it renders `null` here rather than carrying a `<Provider>`.
 *
 * A second reason to keep the prop surface at zero: every prop on a root-level
 * null component is a place for the feed screen's navigation state to leak into
 * the telemetry session, and the one value that must never leak is WHICH clip a
 * sample belongs to. That value comes from `playingClipId` and from nowhere else.
 */
export function TelemetryHost(): null {
  useWatchTelemetry();
  return null;
}
