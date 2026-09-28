# Phase 0 + Phase 1 — Detailed Execution Plan

**Status:** awaiting approval. Nothing in `mobile/` has been modified.

Companion to `2026-09-29-mobile-task-list.md` (the phase overview) and
`docs/mobile-rebuild-plan.md` §15 (the phase table). This document is the
**execution detail** for the first two phases: every finding is cited to a
`file:line`, and every task states the exact value or command.

The overview said "read ALL the relevant files". These were read in full:

| File | Read for |
|---|---|
| `mobile/package.json`, `app.json`, `babel.config.js`, `tsconfig.json`, `index.js`, `App.tsx`, `README.md` | Phase 0 deletion set, salvage list |
| `mobile/src/services/{api,audioPlayer}.ts` | Token handling, telemetry, playback transport |
| `mobile/src/context/{AuthContext,PlayerContext}.tsx` | Session lifecycle, skip-on-finish, player ownership |
| `mobile/src/screens/{Feed,Upload}Screen.tsx` | Defects 1/2/8, recording preset, upload form |
| `mobile/src/components/{AudioVisualizer,CommentModal,ShareModal}.tsx` | Salvage (sheet composition), `Math.random`, share-link defect |
| `mobile/src/types/index.ts` | Response shape assumptions |
| `backend/app/serializers.py` | `RegisterSerializer`, `AudioUploadSerializer`, `ALLOWED_EXT`, `ALLOWED_MIMES` |
| `backend/app/views/auth.py`, `views/legal.py`, `backend/app/urls.py` | Register throttle stack, compliance payload, exact routes |
| `backend/EchoFlow/settings.py` | `SIMPLEJWT` lifetimes, full `DEFAULT_THROTTLE_RATES` |
| `frontend/sample_frontend2/src/styles/globals.css`, `tailwind.config.js` | Token source of truth (D7) |
| `docs/mobile-rebuild-plan.md` §9, §10, §12, §13, §14, §15, §20 | D1–D10, playback sequence, scope, tokens, layout, phases, salvage |

---

## 1. Read this first — five things the overview got wrong

These change the work. They are corrections, not nitpicks.

### 1.1 The SDK pin in D1 is stale. `expo` `latest` is now **SDK 57**.

Verified against the npm registry today:

```
latest: 57.0.25 · sdk-57: 57.0.25 · sdk-56: 56.0.22 · sdk-55: 55.0.31
canary: 58.0.0-canary-20260909
```

D1 says "Expo SDK 55". That is two stable releases behind, and
`npx create-expo-app` with no pin will scaffold **57**. So the plan's version
constraint does not describe what the command will actually do, which means it
cannot be followed literally.

**This is owner decision O1 (§5).** It is not mine to pick: 57 is `latest` and
gets the newest `expo-audio` (currently `57.0.5`, i.e. aligned to 57, not 55),
but 55 is what the doc was written against. Pick a number, then **pin every
dependency with `npx expo install`**, never by hand-editing version ranges —
`expo install` is the only thing that knows which version of a package is
aligned to which SDK.

### 1.2 The old app is on **SDK 52**, not 55.

`mobile/package.json:17` → `"expo": "~52.0.37"`, `react-native: 0.76.7`,
`react: 18.3.1`. `README.md:3` says SDK 52. `expo-av: ~15.0.2`.

The plan's Phase 0 says "remove `expo-av` (removed SDK 55)". It has been
deprecated since 53, so the real jump is **52 → (55|57)**: three to five SDK
majors, crossing the New Architecture default flip and the `expo-av` →
`expo-audio` migration together. Treat Phase 1 as a scaffold, not an upgrade —
there is nothing worth upgrading in place.

### 1.3 `isMeteringEnabled` is **not** in the old app.

Plan §12 line 614: "live level meter (`isMeteringEnabled` is already on and
unused in the old app)".

```
$ grep -rn "isMeteringEnabled\|metering" mobile/src/
  (no output)
```

`UploadScreen.tsx:58-60` calls `Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY)`
with no metering option. The level meter is **net-new work**, not a wiring-up
of dead code. Recording options become explicit.

### 1.4 `license_type` and `copyright_owner_name` are **optional**.

Task list 6.6 says the last three are "required by `AudioUploadSerializer`".
From `serializers.py:154-168`:

| Field | Required? | Default |
|---|---|---|
| `copyright_acknowledgement` | **`required=True`** (`serializers.py:165`) | none — omitting it 400s |
| `license_type` | `required=False` (`:154`) | `"Unknown"` |
| `copyright_owner_name` | `required=False`, `allow_null` (`:159`) | `null` |

So only the acknowledgement is mandatory. But `"Unknown"` is not free
(`serializers.py:186-190`): it logs `warning("Upload with Unknown license type
— audit trail required.")`. **The app should still make the picker mandatory** —
not because the server demands it, but because the server is telling us it wants
an audit trail and the Copyright Act 1957 question is real. That is a product
decision dressed as a UX decision, and it is why it belongs in the form.

### 1.5 `category` is **free text**. There are two competing taxonomies.

`models.py:112` → `category = models.CharField(max_length=50, blank=True)`. No
`choices`. The serializer does not constrain it.

Meanwhile there are two incompatible vocabularies in the repo:

| Source | Categories |
|---|---|
| `mobile/src/screens/UploadScreen.tsx:17-24` | Field Recordings · Ambient & Drone · Synthesizer · Cyberpunk · Lo-Fi Beats · Speech & Poetry |
| Plan §13 `CATS` (from `sample_frontend2`) | instrumental · funny · news · science · music |

The backend accepts both. The 5 design-source categories also carry brand
colours (`#00e5a0`, `#f59e0b`, `#60a5fa`, `#8b5cf6`, `#ff6b35`) that the old
taxonomy has no mapping for, and `/suggestions/?category=X` filters on exact
string equality. **Clips already in the database carry the old 6 values**, so
switching the picker to the design-source 5 does not re-label existing data.

This is owner decision **O2 (§5)**. It is a real fork: design fidelity vs.
continuity with stored data.

---

## 2. Also worth knowing before you start

Not corrections, but they change how the tasks are written.

- **`ROTATE_REFRESH_TOKENS: True` + `BLACKLIST_AFTER_ROTATION: True`**
  (`settings.py:776-777`). Every refresh returns a **new** refresh token and
  blacklists the old one. The old client's `data.refresh || tokens.refresh`
  (`api.ts:100`) is a fallback that can never fire today and would silently
  resurrect a blacklisted token if rotation were ever disabled. Require
  `data.refresh`; do not carry a fallback.
- **Access 15 min, refresh 7 days** (`settings.py:770-771`). The 13-minute
  proactive refresh is right, but the **7-day refresh expiry is the real session
  boundary** and needs its own "please sign in again" path.
- **Registration can lock a user out for an hour.** `RegisterView`
  (`views/auth.py:47`) runs `ScopedRateThrottle` (`register`, 200/hour, IP) **and**
  `RegisterUsernameRateThrottle` (`register_username`, **3/hour, per username**).
  Three typos of the same handle and that username is blocked for an hour with no
  way to recover. The form must not submit on every keystroke and should say so.
- **`GET /legal/compliance/` is `AllowAny`** with scope `legal` at **30/hour**,
  IP-keyed (`views/legal.py:8-10`, `settings.py` `DEFAULT_THROTTLE_RATES`). Fetch
  it on registration-screen mount. Do not poll it.
- **Three assets are referenced and none exist.** `app.json:7` `icon.png`,
  `:10` `splash.png`, `:27` `adaptive-icon.png`. There is no `mobile/assets/`
  directory at all. Every build of the old app fails at bundle time.
- **`surface-bright` is defined twice with different values.**
  `globals.css:11` → `#38393c`; `tailwind.config.js:14` → `#282a2c`, which is
  `globals.css`'s `--surface-container-high`. One is wrong and it is not
  recorded which. This is one of the "16 catalogued design-extraction defects"
  the plan defers; it has to be resolved **before** `tokens.ts` is written, or
  the wrong value gets typed in and looks authoritative forever.
- **`babel.config.js:5` puts `react-native-reanimated/plugin` in the plugin
  list.** `babel-preset-expo` includes the Reanimated plugin on recent SDKs and
  warns about the manual one. Start from a fresh template, do not carry this
  file over.
- **`ShareModal.tsx:47` shares `clip.hls_playlist_url`.** That is a
  token-gated edge URL; the recipient gets a 403. A real defect, in the
  salvage-adjacent file, and the reason share links are Phase 3 work.
- **`models.py` has no `CATEGORY_CHOICES`** — confirmed by grep. See 1.5.
- **`mobile/dist/` and `mobile/node_modules/` are already gitignored**
  (`.gitignore:101` `node_modules/`, `:125` `dist/`). 20 files are tracked.

---

## 3. Phase 0 — remove the old tree

One commit. `git` keeps the history, so this is reversible.

Measured baseline for the commit message: 3,313 LOC across
`src/` + `App.tsx` + `index.js`; 125 hardcoded hex values; 8 `StyleSheet.create`
blocks.

| # | Task | Command / detail | Salvage first? |
|---|---|---|---|
| 0.1 | Record the baseline | `find mobile/src mobile/App.tsx mobile/index.js -name "*.ts*" \| xargs wc -l` → 3313 | — |
| 0.2 | `git rm` the whole source tree | `git rm -r mobile/src mobile/App.tsx mobile/index.js` | **Yes — §4** |
| 0.3 | Remove `expo-av` from `app.json` plugins | `app.json:38-45` references an `expo-av` config plugin for a package that will not exist | — |
| 0.4 | Remove the three asset paths from `app.json` | `:7`, `:10`, `:27` — the files do not exist, so these are broken references, not lost files | — |
| 0.5 | Keep `app.json`; it is rewritten as `app.config.ts` in 1.x | `README.md:79` documents the file, so the rewrite needs a README update too | Yes |
| 0.6 | `git rm mobile/babel.config.js` | `:5` reanimated plugin; the template regenerates it | — |
| 0.7 | `git rm mobile/package.json`, rewrite in 1.1 | Keep `name`, `version`, `private: true` (`:1-3`, `:40`) | Yes |
| 0.8 | `rm -rf mobile/node_modules mobile/dist mobile/package-lock.json` | Untracked/ignored; a 52-era lockfile will fight the new tree | — |
| 0.9 | Rewrite `mobile/README.md` | `:3` claims SDK 52; `:75-103` documents the deleted tree. It is more misleading than absent | — |
| 0.10 | Confirm | `git status` shows 20 deletions; `ls mobile/` shows only `README.md` + `tsconfig.json` | — |

**Exit criteria:** `mobile/` contains no application code; the repo builds
without referencing it (nothing outside `mobile/` imports it — verify with
`grep -rn "mobile/" --include=*.yml --include=*.json --include=*.py .` and
expect CI-only hits).

---

## 4. Salvage — extract before deleting

Copy these into the new tree as you build, not afterwards. Git history preserves
the old file, but the *pattern* has to be re-typed, and re-typing from a
remembered summary loses the detail.

| From | Take | Note |
|---|---|---|
| `api.ts:75-114` | The `refreshPromise` single-flight mutex | The one correct thing in the old client. **Rewrite the body**: require `data.refresh` (§2), add `AbortController`, `204`, structured errors, `skipAuth`, 429 backoff |
| `audioPlayer.ts:19-25` | `setAudioModeAsync({ playsInSilentModeIOS, staysActiveInBackground, shouldDuckAndroid })` | Retarget to `expo-audio`'s `setAudioModeAsync`. Add `allowsRecording: false/true` per mode |
| `UploadScreen.tsx:58-60` | `HIGH_QUALITY` preset | `.m4a`/AAC/44.1k/stereo/128kbps. `.m4a` **is** in `ALLOWED_EXT` (`serializers.py:129`) |
| `CommentModal.tsx:75-79` | `KeyboardAvoidingView` + drag-indicator composition | Keep the composition. Reimplement as `@gorhom/bottom-sheet` |
| `app.json:16,25,37` | `com.echoflow.audio` (both platforms), `scheme: "echoflow"` | D3 makes the scheme real for the first time — the old app declared it and had zero handlers |
| `app.json:18-20` | `UIBackgroundModes: ["audio"]` | `expo-audio`'s plugin emits this automatically; declare the intent anyway |
| `app.json:19` | `NSMicrophoneUsageDescription` | Carries real copy. Keep the sentence |

**Discard** (confirmed by reading, not just by the plan's table):

| Discard | Why |
|---|---|
| The entire styling layer | 125 hex values, 8 `StyleSheet.create`, no tokens, palette is `frontend/src`'s orange `#FF6321`, not the design source's terracotta `#e8a87c` |
| `App.tsx` navigation | Bottom tabs, `navigation: any`, no linking, no param typing, no error boundary, no auth gate |
| `AuthContext.tsx` | `isAuthenticated: !!user` (`:75`) is derived, not authoritative; `login()` is unreachable (nothing calls it, and there is no register or login function anywhere in `api.ts` — `authAPI` has only `logout`); `loadAuth` (`:34-48`) calls `refreshProfile()` in a `try` with no `catch` and is itself unawaited, so a failure escapes as an unhandled rejection |
| `UploadScreen.tsx:34` | `consentAccepted = useState(true)` — pre-ticked consent, DPDP §11 |
| `FeedScreen.tsx:93-104` | `useRef(...).current` captures `currentIndex` and `clips` from the first render. `clips[index]` is `undefined` forever, so **scrolling never changes the track** (defect 1) |
| `PlayerContext.tsx:136-140` + `:70-77` | On `didJustFinish` it calls `skipNext()`, which calls `registerSkip` with `0/0/0`. Natural completion is counted as a skip (defect 2) |
| `audioPlayer.ts:53-59` | `createAsync({uri}, …)` passes **no headers**. There is no media auth at all in the old app; against the token-gated edge this 403s on every clip |
| `audioPlayer.ts:112-128` | `flushTelemetry` measures `Date.now() - startTimeMs` (defect 6) |
| `AudioVisualizer.tsx:26` | `Math.random()` re-rolled per animation cycle |
| `api.ts:245` | `toggleFollow` sends **GET** to a POST-only route. Undetectable in the old app only because `InboxScreen`/`ProfileScreen` never called it |
| `api.ts:15-21` | Base URL is `http://localhost:8005` / `http://10.0.2.2:8005` — the plaintext debug escape hatch `AGENTS.md` says to drop (D9) |
| `ShareModal.tsx:47` | Shares a token-gated HLS URL the recipient cannot fetch |
| `app.json:40-45` | `expo-av` plugin; `expo-asset` plugin |
| 7 unused deps | See 1.x |

---

## 5. Owner decisions needed before 1.1

Three forks I will not pick alone. Each is cheap now and expensive later.

| # | Decision | Options | My recommendation, with reasoning |
|---|---|---|---|
| **O1** | Target Expo SDK | 55 (`sdk-55`, what D1 says) · 56 · **57** (`latest`) | **57**, then amend D1. Reasoning: 55 is two stable releases stale; `expo-audio` is already at `57.0.5` so 57 is where audio support is best; and a brand-new scaffold has no migration cost, so "stay conservative" buys nothing here. The real risk of 57 is `expo-audio` API churn, which is lowest on the newest SDK. Amend D1 in the plan so the doc stops lying. |
| **O2** | Category taxonomy | design-source 5 (instrumental/funny/news/science/music) · old 6 (Field Recordings/…) · union with a fallback colour | **Design-source 5, plus a documented neutral fallback for unknown values.** Reasoning: they are the only ones with brand colours, the plan's CATS line depends on them, and `suggestions?category=` filters by exact string so a fixed 5 keeps the filter pills honest. Cost: existing clips keep their old values and need the fallback. If you want continuity instead, take the old 6 and drop the CATS colours. |
| **O3** | `surface-bright` | `globals.css:11` `#38393c` · `tailwind.config.js:14` `#282a2c` | **Needs your call — I cannot resolve it from the code.** The other four surface steps run `#0c0e10 → #1a1c1e → #1e2022 → #282a2c → #333537` in `globals.css`, which makes `#38393c` the odd one out and `tailwind`'s value the consistent one. But `globals.css` is the file the plan names as authoritative, and it says `#38393c`. If `globals.css` is right, the 5-step ramp has a gap. Say which, and it goes in `tokens.ts` with a comment saying which file won. |

Two smaller ones, flagging rather than asking:

- **`terms_version` source.** Fetch `current_terms_version` from
  `GET /legal/compliance/` at registration-screen mount (1.15). Hardcoding
  `v1.0` 400s the day `TERMS_VERSIONS` grows a version, and
  `RegisterSerializer.validate_terms_version` (`serializers.py:~110`) returns
  the allowed list in the error, so the failure is self-correcting but only
  after a bad UX. Fetch it.
- **`_enforce_free_limits` is 10 MB, not duration.** `serializers.py:197-206`
  checks file size only. `MAX_DURATION_SECONDS=300` is enforced globally by a
  pydub probe (`serializers.py:~271`+). The advertised 60 s free cap is
  **server-side unenforced**, so the client is the only place it exists (1.19).

---

## 6. Phase 1 — scaffold and auth

Gate: O1, O2, O3 answered. Nothing blocks on backend work.

### 1.1–1.4 — scaffold

| # | Task | Detail |
|---|---|---|
| 1.1 | `npx create-expo-app` into a temp dir, pinned to O1 | `--template` with the SDK tag. Do **not** run it over `mobile/` in place — you want to see the generated file list before adopting it |
| 1.2 | Verify the generated `package.json` SDK line against O1 | If `create-expo-app` gave you a different SDK than you pinned, stop and re-pin before going further |
| 1.3 | Replace `mobile/` contents with the template | Keep `name: echoflow-mobile`, `version`, `private: true` |
| 1.4 | Confirm CNG: no committed `ios/`, no committed `android/` | D1. `npx expo prebuild` generates them. Verify `.gitignore` gained the entries |
| 1.5 | `npx expo install` every dependency — **never hand-write a version** | The set: `expo-audio`, `expo-secure-store`, `expo-router`, `expo-haptics`, `expo-linear-gradient`, `expo-blur`, `expo-updates`, `expo-notifications`, `expo-image-picker`, `expo-font`, `@expo-google-fonts/lexend`, `react-native-safe-area-context`, `react-native-screens`, `react-native-gesture-handler`, `react-native-reanimated`, `react-native-svg`, `@shopify/flash-list` (or `FlatList` — your call), `@tanstack/react-query`, `zustand`, `zod`, `@gorhom/bottom-sheet` |
| 1.6 | `app.config.ts` (not `app.json`) | Needed for `EXPO_PUBLIC_API_BASE_URL` per EAS profile (D9). Port the salvaged bundle IDs, `scheme`, `UIBackgroundModes` |
| 1.7 | Register the `expo-audio` config plugin | Emits Android `AudioControlsService` (MediaSessionService) and iOS `UIBackgroundMode: audio` — D2's whole reason for choosing it over RNTP |
| 1.8 | **Generate the three assets** | `icon.png`, `splash.png`, `adaptive-icon.png`, plus a notification icon. The old `app.json` referenced all three and none existed — a 52 build could never have succeeded |
| 1.9 | Add `mobile/` scripts: `typecheck`, `test`, `lint` | Phase 1 exit criteria run them |

### 1.5–1.11 — design system

| # | Task | Detail |
|---|---|---|
| 1.5 | `src/design/tokens.ts` | From `globals.css` + `tailwind.config.js` (D7). **Resolve O3 first.** Full value list in the table below |
| 1.6 | `src/design/shadows.ts` | `Platform.select`. iOS: `shadowColor`/`shadowOpacity`/`shadowRadius` + `shadowOffset:{0,0}`. Android: `expo-linear-gradient` glow rings on the create FAB and liked heart only. Documented degradation, not hidden |
| 1.7 | `src/design/typography.ts` | Lexend 300–900. Register via `useFonts` in `app/_layout.tsx`; **block first paint until loaded** or the app renders in the system font and reflows |
| 1.8 | `src/design/theme.tsx` | Dark-only at MVP; the light values ship in `tokens.ts` unused |
| 1.9 | `src/components/ui/` | `Glass` · `Chip` · `Button` · `Sheet` · `Toast` · `Spinner` · `Waveform` · `Equalizer` |
| 1.10 | Do **not** port | CRT `scan-line` · `Math.random()` waveform · `alert()` in comment handlers · Light/Dark segmented control · Settings theme bug · the 16 extraction defects |
| 1.11 | Drop the dot-matrix `radial-gradient` overlay | No RN equivalent. Dropping is the honest MVP call |

Token values, for `tokens.ts` — verbatim from `globals.css`, with the
tailwind-only entries marked:

```
FONT      Lexend 300–900                     globals.css:1
BG        #121416                            :53
SURFACES  #0c0e10 / #1a1c1e / #1e2022 / #282a2c / #333537
                                                 :12-16
          surface-bright  ← O3 UNRESOLVED     globals.css:11 says #38393c
                                                 tailwind:14 says #282a2c
BRAND     terracotta #e8a87c (:56) · hover #d4956a (:64) · 135° gradient
2ND       sage #aad0b1 (:29)        3RD  honey-gold #f1ce6d (:35)
LIKE/ERR  #ffb4ab (:37)                    (white icon + count, salmon glow)
ON-SURF   #e2e2e5 (:17)   ON-SURF-VAR #d5c3b9 (:18)
OUTLINE   #9d8e84 (:21)   OUTLINE-VAR #51443d (:22)
GLASS     rgba(18,20,22,0.6) (:60) + blur(20px) (:221)
TINT      ${c}08 / 0A / 18 / 22 / 33 / 44 / 55        plan §13
RADIUS    sm .5rem :81 · md 1.5rem :82 · lg 2rem :83 · xl 3rem :84 · full 9999 :85
LAYOUT    gutter 16px :89 · stack 24px :90 · tap 64px :91 · margin-mobile 20px :88
GLOW      0 0 {6,8,12,16,20,24,32}px rgba(232,168,124,0.25)  :65
          + glow-sage / glow-gold, same radius, 0.25 alpha     tailwind:47-48
BLUR      6 scrim · 8 scrim · 10 button · 16 modal · 20 chrome
EASE      pop .35s cubic-bezier(.34,1.56,.64,1) :216
          slide .32s cubic-bezier(.22,.61,.36,1) :218
          shimmer 1.4s :205 · waveBar 1s :208 · popIn :216 · fadeUp .3s :217
          slideUp :218 · ripple :176 · pulse-soft :179 · toastIn :183
Z         nav 200 < sheet 800 < toast 5000 < onboarding 7000 < netbanner 8000
GLYPHS    22 icon · 9 nav · 10 count · 11 label · 13 body · 20 title · 28 page
TRACKING  +0.02em title → +0.08em uppercase micro-labels
PACING    1000ms after progress ≥ 0.99, then advance
CATS      see O2
```

The `tap-target: 64px` token exists and the web violates it everywhere (plan
§13). On mobile, enforce the platform minimums instead: **≥44 pt iOS /
≥48 dp Android**, with `accessibilityRole`, `accessibilityLabel`, and `hitSlop`
on every icon-only control. Do not copy `64px` as the target — copy it as the
*ideal*, and let the minimum be the floor.

### 1.12–1.15 — API client

| # | Task | Detail |
|---|---|---|
| 1.12 | `src/api/client.ts` — the `refreshPromise` mutex, rewritten | Requires `data.refresh` (rotation is on — §2). Adds `AbortController` timeout, `204` → `null`, structured `ApiError` (`status`, `body`, `fieldErrors` for DRF's `{field: [msg]}` shape), `skipAuth`, 429 backoff with `Retry-After` |
| 1.13 | Base URL is **https only** | D9. Default was `http://localhost:8005`. `EXPO_PUBLIC_API_BASE_URL` per EAS profile. **Fail loudly on a non-https base in dev** — otherwise the plaintext mistake comes back silently |
| 1.14 | `src/api/schema.ts` — zod, all four envelopes | PageNumber `{count,next,previous,results}` · Cursor `{next,previous,results}` **no `count`** · hand-rolled `{"results":…}` with `next === "auto_trigger"` (`serializers.py`/views) · **bare array** (`/share/inbox/`, which the old client defensively handled at `api.ts:209-211` — keep that defensiveness). Plus: `GET /feed/` can return **202** with `retry_after_ms`; `SubscriptionStatusSerializer.limits` is `DictField(child=CharField)` so every value is a **string** |
| 1.15 | `src/api/endpoints/*.ts` | Thin, typed, one function per endpoint. No logic — that belongs in hooks |

### 1.16–1.22 — auth

| # | Task | Detail |
|---|---|---|
| 1.16 | `src/store/auth.ts` (Zustand) | Authoritative `status: 'loading' \| 'authed' \| 'anon'`, not `!!user`. Holds `user`, never tokens |
| 1.17 | Tokens → `expo-secure-store` | Keychain/Keystore. **Not** MMKV (D4), **not** `AsyncStorage` (what the old app used — `api.ts:1`, unencrypted on Android) |
| 1.18 | `app/(auth)/register.tsx` sends `username`, `email`, `password`, **`consent_accepted`**, **`terms_version`**, **`dob`**, `parent_email` if under 18 | `RegisterSerializer` (`serializers.py:~180`). `dob` is `required=True`; the old days of `required=False` are the bypass DPDP §9 was closed over |
| 1.19 | Fetch `current_terms_version` at screen mount | `GET /legal/compliance/`, `AllowAny`, scope `legal` 30/hour IP-keyed. **Do not hardcode** `v1.0` |
| 1.20 | `consent_accepted` **unchecked by default** | The old app shipped `useState(true)` (`UploadScreen.tsx:34`) — DPDP §11 |
| 1.21 | Age gate in the form | If computed age < 18, show the guardian-email field and say *why*: the backend sets `is_minor=True` and then **403s telemetry** for that account (`AGENTS.md` age-gate note). Minor accounts can still like/skip — the 403 is telemetry-only, and the UI should not imply otherwise |
| 1.22 | `register` returns **no tokens** — follow up with `login` | `Meta.fields` is username/password/email/consent/dob/parent_email with `password` and `email` `write_only` (`serializers.py:~176`). `FRONTEND-REQUIREMENTS.md` §9 confirms: by design, not a bug |
| 1.23 | Registration UX: **do not submit on blur/keystroke** | `register_username` is **3/hour per username** (`views/auth.py:47`). Three typos = locked out for an hour. Show the throttle consequence in the helper text, and on a 429 name the username as the likely cause |
| 1.24 | `app/(auth)/login.tsx` → `POST /auth/login/` | Throttle scope `login`, **10/min/IP** (`urls.py:~29`). This is the credential-stuffing limit, so it is strict on purpose — a 429 here should read as "wait", not "wrong password" |
| 1.25 | Proactive refresh at **13 min**; refresh TTL **7 days** | 15-min access (`settings.py:770`). The 7-day refresh expiry is the real session boundary — needs its own signed-out path distinct from a 401 |
| 1.26 | 401 → refresh → **replay once** → on failure, sign out and emit a **session-expired** signal | One replay, never a loop |
| 1.27 | Silent restore on cold start | Read both tokens from SecureStore, validate the access token, then `refreshProfile`. **Never trust the stored user object** — the old `AuthContext` did (`:40`) |
| 1.28 | `POST /auth/logout/` blacklists the refresh | `urls.py:62` `LogoutView`. `IsAuthenticated`. 400 on a missing/invalid `refresh`. The one backend capability no client consumes (`FRONTEND-REQUIREMENTS.md` §8) — use it, and clear local state in a `finally` |
| 1.29 | `app/(tabs)/` shell + `useBackendStatus` on a **30 s** timer | `FRONTEND-REQUIREMENTS.md` §4.9 — the current hook checks once, so the banner never recovers |
| 1.30 | Error boundary at the navigator root | `App.tsx` has none |

### 1.31–1.32 — phase 1 test floor

| # | Task | Detail |
|---|---|---|
| 1.31 | Jest + `jest-expo` | 1.12's refresh rotation + 401 replay + 429 backoff · 1.14's four envelopes + string `limits` · session restore |
| 1.32 | No component snapshots | Plan §16. The tokens are the contract, not the rendered output |

---

## 7. Todo list

Work top to bottom. Each line is a commit boundary or an explicit checkpoint.

**Decide first**
- [ ] O1 — target Expo SDK (55 / 56 / **57**). Amend D1 in `mobile-rebuild-plan.md` to match
- [ ] O2 — category taxonomy (design 5 / old 6 / union+fallback)
- [ ] O3 — `surface-bright`: `#38393c` or `#282a2c`

**Phase 0 — remove (one commit)**
- [ ] 0.1 Record baseline: 3313 LOC, 125 hex, 8 `StyleSheet.create`
- [ ] 0.2 Extract the §4 salvage table into the scratchpad
- [ ] 0.3 `git rm -r mobile/src mobile/App.tsx mobile/index.js mobile/babel.config.js mobile/package.json`
- [ ] 0.4 `rm -rf mobile/node_modules mobile/dist mobile/package-lock.json`
- [ ] 0.5 Strip asset paths and the `expo-av` plugin from `app.json`
- [ ] 0.6 Rewrite `mobile/README.md` (it currently documents the deleted tree and claims SDK 52)
- [ ] 0.7 Verify no non-`mobile/` file references `mobile/`
- [ ] 0.8 `git commit` — Phase 0

**Phase 1a — scaffold**
- [ ] 1.1 `create-expo-app` into a temp dir, pinned to O1's SDK
- [ ] 1.2 Check the generated SDK matches O1
- [ ] 1.3 Adopt into `mobile/`, keeping name/version/private
- [ ] 1.4 Confirm no committed `ios/`+`android/`
- [ ] 1.5 `npx expo install` the full dependency set — no hand-written versions
- [ ] 1.6 `app.config.ts` with `EXPO_PUBLIC_API_BASE_URL`; port bundle IDs, `scheme`, `UIBackgroundModes`, mic copy
- [ ] 1.7 Register the `expo-audio` plugin
- [ ] 1.8 **Generate `assets/`** — icon, splash, adaptive-icon, notification icon
- [ ] 1.9 Add `typecheck` / `test` / `lint` scripts

**Phase 1b — design system**
- [ ] 1.10 `src/design/tokens.ts` — §6 value table, with O3 resolved and a comment naming the winning file
- [ ] 1.11 `src/design/shadows.ts` — `Platform.select` glow
- [ ] 1.12 `src/design/typography.ts` + `useFonts` gating first paint
- [ ] 1.13 `src/design/theme.tsx` — dark only
- [ ] 1.14 `src/components/ui/` — Glass, Chip, Button, Sheet, Toast, Spinner, Waveform, Equalizer
- [ ] 1.15 Confirm none of the "not ported" list leaked in

**Phase 1c — API layer**
- [ ] 1.16 `src/api/client.ts` — mutex rewritten, rotation required, timeout, 204, `ApiError`, `skipAuth`, 429 backoff
- [ ] 1.17 https-only base URL + dev-time loud failure on plaintext
- [ ] 1.18 `src/api/schema.ts` — all four envelopes + 202 + string `limits`
- [ ] 1.19 `src/api/endpoints/*.ts` — thin and typed

**Phase 1d — auth**
- [ ] 1.20 `src/store/auth.ts` — authoritative status enum
- [ ] 1.21 `expo-secure-store` for tokens; purge any `AsyncStorage` keys
- [ ] 1.22 `register` with all six fields; `dob` present
- [ ] 1.23 `current_terms_version` from `/legal/compliance/` at mount
- [ ] 1.24 consent unchecked by default
- [ ] 1.25 age gate + guardian email, with the telemetry-403 consequence stated
- [ ] 1.26 register → follow-up login (no tokens in the register response)
- [ ] 1.27 registration UX respecting `register_username` 3/hour
- [ ] 1.28 `login` + 429 reads as "wait", not "wrong password"
- [ ] 1.29 proactive refresh at 13 min; 7-day refresh-expiry path
- [ ] 1.30 401 → refresh → replay once → session-expired signal
- [ ] 1.31 silent cold-start restore; re-fetch, never trust the cached user
- [ ] 1.32 `logout` blacklists the refresh; local state cleared in `finally`
- [ ] 1.33 `(tabs)` shell + `useBackendStatus` 30 s
- [ ] 1.34 error boundary at the navigator root

**Phase 1e — verify**
- [ ] 1.35 Jest: refresh rotation, 401 replay, 429 backoff, four envelopes, session restore
- [ ] 1.36 `npx tsc --noEmit` clean
- [ ] 1.37 Fresh install → register → land in `(tabs)` → logout → re-login
- [ ] 1.38 Under-18 registration reaches the guardian branch and telemetry is not sent
- [ ] 1.39 Confirm registration is HTTPS-only and hits `:443`, not `:8005`
- [ ] 1.40 `git commit` — Phase 1

---

## 8. Phase 1 exit criteria

1. A fresh install registers, lands in `(tabs)`, logs out, logs back in.
2. `tsc --noEmit` clean. Jest green.
3. Registration works for an adult **and** for an under-18 user, and the
   under-18 path never calls `log-telemetry`.
4. Tokens are in the Keychain/Keystore, not `AsyncStorage`.
5. Every request is HTTPS. `:8005` appears nowhere.
6. `GET /legal/compliance/` supplies `terms_version`; no version string is
   hardcoded in the app.
7. Consent checkboxes are unchecked on first paint.
8. The three assets exist and a build produces a launchable binary.
9. Backend suite re-run **twice**, failure **sets** compared against the
   37-failure baseline. Plan §I8: the count drifts, the set must not grow.

**Not claimed at this phase:** playback. Nothing in Phase 1 fetches a media
token or touches `expo-audio` playback. Phase 2 owns that, and until the §10
phone-dev-loop problem is solved only a simulator can exercise it.
