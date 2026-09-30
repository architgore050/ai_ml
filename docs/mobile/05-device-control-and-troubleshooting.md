# Mobile device control and troubleshooting

This runbook explains how EchoFlow is exercised on a connected Android device,
what the local development topology is, and how to tell an app defect from a
local-stack defect. It is deliberately specific about the commands because the
mobile client crosses four networks: Android, Metro, nginx, and the local HLS
Worker.

## What is controlled

The development client has Android package `com.echoflow.audio`. It loads the
JavaScript bundle from Metro; it is not an installed production build. Android
Debug Bridge (ADB) is used only for development actions:

- listing the device and setting a port reverse;
- opening the development-client deep link;
- restarting the app after a native or JavaScript configuration change;
- reading the accessibility tree and device logs; and
- taking a screenshot for visual verification.

Do not use ADB to bypass authentication, extract SecureStore data, or test
with a real customer account. Create a disposable local test account through
the normal registration UI.

## Start the local services

From the repository root, start the stack exactly as follows:

```bash
docker compose -f docker-compose.local.yml --env-file .env.local up -d
curl -kI https://localhost:18443/health/
```

The Android app calls the HTTPS nginx endpoint on port `18443`. HLS URLs point
at nginx on port `19443`, which forwards `/hls/*` to the local HLS Worker. The
Worker is a host process, not a Docker service, so it must be started separately:

```bash
bash scripts/run-hls-worker-local.sh
curl -fsS http://127.0.0.1:8787/healthz
```

Keep this terminal open. The script generates the ignored Worker `.dev.vars`
from `.env.local`, keeping its token secret and MinIO credentials aligned with
Django. If it is absent, nginx returns `502` for every HLS manifest because its
upstream at `host.docker.internal:8787` refuses the connection.

## Connect Metro to Android

Run Metro in the `mobile/` directory. The development client normally reaches
it through ADB reverse, so it does not need the host LAN address.

```bash
cd mobile
npx expo start --dev-client --localhost
```

In another terminal:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
curl -fsS http://127.0.0.1:8081/status
```

The last command must return `packager-status:running`. Open the development
client with its deep link:

```bash
adb shell am start -a android.intent.action.VIEW \
  -d 'exp+echoflow-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'
```

The application scheme is declared in `mobile/app.config.ts`. If the client
shows its **Tools** launcher rather than the app, repeat the deep-link command
while Metro is running. If it shows `ECONNREFUSED` for a LAN address, do not
switch to that address unless Metro was deliberately started with LAN binding;
keep the `127.0.0.1` URL and restore `adb reverse`.

## Inspect the device without guessing

These commands provide reproducible evidence for screen state:

```bash
# Accessibility labels and visible text
adb shell uiautomator dump /sdcard/window.xml >/dev/null
adb shell cat /sdcard/window.xml

# Screenshot for visual control size/shape inspection
adb exec-out screencap -p > /tmp/echoflow-phone.png

# React Native/native errors after reproducing a problem
adb logcat -d -v brief | rg 'ReactNativeJS|ExpoNetworkInspector|Network request'
```

Prefer accessibility labels when tapping controls. Coordinates are a last
resort because keyboard visibility, font scale, and device rotation move UI
elements. For example, the Discover control is exposed as `Play <clip title>`
or `Pause <clip title>`.

## HLS origin and authentication contract

The Worker has an explicit CORS allowlist in
`workers/hls-token-worker/src/index.ts`. Metro development origins are allowed:

- `http://localhost:8081`
- `http://127.0.0.1:8081`

Native ExoPlayer requests ordinarily have no `Origin` header. They are still
authorized because the mobile player sends the clip-scoped
`X-EchoFlow-Media-Token` header on the manifest and every segment. CORS does
not grant media access; the token and its HLS path scope do.

Verify the browser/dev CORS rule with:

```bash
curl -sS -D - -o /dev/null -X OPTIONS \
  http://127.0.0.1:8787/hls/example/master.m3u8 \
  -H 'Origin: http://127.0.0.1:8081' \
  -H 'Access-Control-Request-Method: GET'
```

Expect `204`, `Access-Control-Allow-Origin: http://127.0.0.1:8081`, and
`Access-Control-Allow-Credentials: true`. A tokenless playlist request should
remain `403`.

For an end-to-end check, sign in as a disposable account, mint a playback
token through the app, and press a visible reel or Discover play button. nginx
should log a `200` for the manifest followed by playlist and segment requests.
A `206` for a segment is expected for a range request.

## Issues observed during the 2026-10-01 device pass

| Symptom | Evidence | Cause | Resolution |
|---|---|---|---|
| No audio, HLS manifest returned 502 | nginx logged `connect() failed (111)` to `host.docker.internal:8787` | The local HLS Worker was not running | Start `scripts/run-hls-worker-local.sh`; authenticated manifest, playlist, segment, and range requests then returned 200/206 |
| Discover had no obvious playback action | Cards only displayed text | Discover was not connected to the shared player | A fixed 52px accessible play/pause control now mints a token and loads the selected clip |
| Idle reel looked non-interactive | The full-card touch target existed but its overlay was hidden | Visibility only showed a transient playing state or a paused latch | Idle playable reels now show the central play triangle |
| Feed stayed on “Loading feed” despite successful `/feed/` 200 responses | Device nginx logs showed pages arriving; accessibility tree still showed the spinner | Android did not dispatch the first tab-route `onLayout`, leaving viewport height at zero | Feed now starts with `Dimensions.get('window').height - layout.navClearance`, then replaces it with the measured layout height |
| Local dev client opened Tools or a stale LAN error | Development-client launcher appeared, or `ECONNREFUSED` named the host LAN address | Metro only listened on loopback while the client had a cached LAN project URL | Run Metro, restore `adb reverse tcp:8081 tcp:8081`, and open the explicit loopback deep link |

## Feed cold start

Interest selection is not required for a listener to see content. `/feed/` may
briefly return `202` while its personalised Redis queue is being filled, but the
mobile screen falls back to the non-destructive `/suggestions/?category=all`
listing. A persistent loading spinner was a viewport/layout defect, not a
cold-start ranking failure.

The feed endpoint is destructive: each successful request consumes queue rows.
During debugging, avoid repeatedly restarting or refreshing the feed with a
single account, because that can exhaust its local queue and produce a valid
`202`. Use Discover for repeatable content checks.

## Next device verification

After source changes, run:

```bash
cd mobile
npm run typecheck
npm test -- --runInBand
```

Then verify on the phone in this order:

1. Sign in with a disposable account and confirm the feed shows a reel rather
   than a permanent loading spinner.
2. Press the centre play affordance and confirm a manifest, playlist, and
   segment request return through nginx.
3. Open Discover and confirm the control keeps its square shape at device
   scale, has a `Play <title>` label, and toggles to Pause after playback starts.
4. Exercise one like, comment, share, follow, and profile navigation action.
5. Record any remaining visual differences with a screenshot and the Android
   model, font scale, and display scale used.

Before a preview build, repeat this pass against staging with a non-local
HTTPS hostname and a deployed HLS Worker. A development client plus `adb
reverse` is intentionally a local verification path, not a distribution
configuration.

## The complete request path

There are two independent paths involved in listening. Keeping them separate
is useful when diagnosing a failure:

```text
Android JavaScript bundle
        │
        ├── Metro :8081 (development code only)
        │
        └── HTTPS API :18443
              │ nginx :443 inside the local compose network
              └── Django :8000

Playback token: mobile ──POST /media/playback-token/<clip>/──> Django
Audio bytes:   native player ──HLS URL + media-token header──> nginx :19443
                                                       └──> Worker :8787
                                                            └──> MinIO :19000
```

The API response and the HLS response are therefore different checks. A
successful `/feed/` request proves that authentication and Django are working;
it says nothing about whether the media Worker is listening. A successful token
mint proves that Django issued a credential; it does not prove that the HLS
object exists. The useful sequence is:

1. Confirm Metro is serving the current bundle.
2. Confirm the app can call `/profile/me/` and `/feed/` through nginx.
3. Confirm `POST /media/playback-token/<id>/` returns a native token.
4. Confirm the manifest returns `200` with that token.
5. Confirm the variant playlist and at least one segment return `200` or
   `206`.
6. Confirm the native player status changes from idle/loading to playing.

Stopping at step 2 is how a healthy API can be mistaken for a broken audio
stack.

## What the mobile playback code does

The feed owns one application-wide native player through `PlayerHost` and the
Zustand player store. A reel is not allowed to create its own player. This is
important because a card is recycled by `FlatList`; a player owned by a card
would be destroyed during a swipe and audio would stop or continue against the
wrong title.

When a reel becomes active, `usePlaybackToken` obtains a short-lived token. The
feed passes the clip URL and token to `loadClip` in `src/store/player.ts`.
`loadClip` uses the server-provided `hls_playlist_url` verbatim and supplies
`X-EchoFlow-Media-Token` as a per-source header. It does not rebuild the URL
from the API base URL and it does not depend on a browser cookie. Android's
native media stack cannot be assumed to share the JavaScript cookie jar.

Discover follows the same player contract. Its play button sets a one-item
queue for lock-screen metadata, mints a token, and invokes `loadClip`. Pressing
the same button while playing calls `pause`; pressing it while paused calls
`resume`. A pending token request disables only that card and exposes a busy
accessibility state.

The HLS Worker validates both the token signature and the requested clip path
before asking MinIO for `hls/<clip-id>/...`. A valid token for clip A cannot be
replayed against clip B. CORS is an additional browser policy; it is not an
authorization mechanism and it is not a substitute for the media token.

## Why the feed spinner happened

The feed screen previously withheld its `FlatList` until an `onLayout` callback
reported a non-zero height. That was intended to prevent zero-height
`FlatList` cells, because `pagingEnabled` needs a real page size. On the test
phone, Android rendered the tab scene but did not deliver that first layout
callback. The request completed successfully, but the list was never mounted,
so the only visible state remained `Loading feed`.

The fix keeps exact layout measurements when available, but initializes the
viewport to `window height - layout.navClearance`. The fallback is only a
bootstrap value; a later `onLayout` replaces it. This handles the device that
exhibited the problem while preserving the measured-height contract for
orientation and inset changes.

The trace also showed several `/feed/` requests. That is expected when the
buffer sees a low queue-health value, but `/feed/` is destructive: every
successful page consumes Redis queue entries. During diagnosis, use the
non-destructive Discover suggestions endpoint for repeated checks and avoid
refreshing one disposable account in a tight loop.

## Investigation method used for the phone issue

The diagnosis was made from independent evidence rather than from the spinner
text alone:

- The API was queried with a valid disposable account. `/feed/` returned
  ready clips and `/suggestions/?category=all` returned a populated fallback.
- nginx access logs showed the phone's `okhttp` requests and successful `200`
  responses, ruling out an interests-only cold-start explanation.
- The accessibility tree continued to expose `Loading feed` after those
  responses, which narrowed the problem to rendering/layout state.
- A temporary diagnostic log in `useFeedBuffer` confirmed the request entered,
  resolved, and exited. Those logs were removed before committing.
- The screen was then changed to use the height fallback and its render tests
  were updated to assert content before the first layout callback.

This sequence is worth repeating for future device bugs: establish server
truth, establish client request truth, inspect rendered accessibility state,
then change one boundary at a time.

## Gotchas and non-obvious constraints

### Compose and hostnames

The local stack is not interchangeable with the default compose project. Always
pass both `-f docker-compose.local.yml` and `--env-file .env.local`. Omitting
the env file can point at a different database password; combining compose
files can create a different project and orphan the services that were being
tested.

The HLS Worker is a host process. It cannot resolve Docker-only names such as
`minio-local`; the run script therefore uses the host-published MinIO port
`127.0.0.1:19000`. Conversely, nginx is in Docker and reaches the Worker using
`host.docker.internal:8787`, which is why the Worker binds `0.0.0.0` rather than
only `127.0.0.1`.

### HTTPS and certificates

The mobile API URL must be HTTPS because nginx is the supported public entry
point. The local certificate is self-signed, so the Android development build
contains the debug network-security configuration needed to trust the local CA.
That trust is a development convenience. A preview build must use a publicly
trusted staging certificate and must never ship the local CA trust rule as a
production workaround.

### Metro and ADB reverse

`adb reverse tcp:8081 tcp:8081` maps the device's loopback port to the host's
Metro port. It is not a general network bridge: it does not make API port
`18443` or HLS port `19443` available. Those services are reached through the
API URL already baked into the Expo configuration.

The reverse rule disappears when the device or ADB daemon is reset. A stale
development-client URL can also refer to a LAN address even though Metro is
bound to loopback. `ECONNREFUSED` naming the host LAN address is therefore a
transport setup problem, not a JavaScript bundle problem.

### Test Store RevenueCat

The development build uses the RevenueCat Test Store key through an environment
variable. It is deliberately not hardcoded in committed source. A successful
Test Store purchase updates native CustomerInfo immediately, but the local
backend subscription display may remain on Free until its server sync path is
configured. Do not interpret that UI mismatch as a failed native purchase, and
do not put a production Google Play service-account credential into this local
workflow.

### Logs and secrets

nginx logs contain paths and status codes, while token bodies and authorization
headers must never be copied into documentation or pasted into issue reports.
When collecting evidence, record the clip UUID only if it is needed to
reproduce the issue, redact access tokens, and prefer status/latency lines over
full request dumps. `.env.local`, `.dev.vars`, and `mobile/.env.local` remain
ignored local files.

## Ownership and hand-off boundaries

Mobile owns the feed layout, player store, token request integration, Discover
controls, accessibility labels, and the Expo/ADB workflow. The backend owner
owns Django token issuance, feed queue semantics, serializers, and database
state. The storage/edge owner owns the Worker, nginx media listener, MinIO/R2
object layout, and production CORS configuration.

When reporting an issue across that boundary, include the smallest evidence
that identifies the owner:

- `401` on `/feed/`: auth/token lifecycle or backend auth configuration;
- `200` on `/feed/` but spinner: mobile rendering/layout;
- `409` from playback-token: media processing state/backend contract;
- `403` from HLS with a newly minted token: token secret, path scope, or header
  transport;
- `502` from HLS: Worker process, nginx upstream, or MinIO reachability;
- `200` manifest but no segments: playlist object paths, Range handling, or
  native player request headers.

## Open work after this pass

The next device session should verify the new feed-height fallback on a clean
restart, then press the central play button and capture the native playback
status. Discover should be checked at the device's actual font/display scale,
including a long title and a loading state.

After local verification, the release path still needs a staging HTTPS backend,
a deployed HLS Worker, a preview EAS build, and Maestro coverage for
authenticate/play, like/comment/share, and create/upload/publish. The local
development client proves integration mechanics; it is not evidence that an
Android internal-distribution artifact is ready.
