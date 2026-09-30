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
