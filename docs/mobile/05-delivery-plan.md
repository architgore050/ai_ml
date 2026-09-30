# Mobile delivery plan

Date: 2026-09-30. This plan deliberately defers real-device verification until
the build lane is configured. It does not claim a preview artifact or a public
release exists yet.

## Outcome and gates

| Milestone | Outcome | Gate |
| --- | --- | --- |
| Build foundation | repeatable Android development, internal preview, and store profiles | `eas.json`, HTTPS config checks, mobile CI |
| Listener beta | listeners can discover, play, react, share, and manage a profile | shared-clip playback, avatar update, replies after backend fix, double-tap, accessibility review |
| Creator/account beta | creators can publish and users can manage account/compliance work | Studio, moderation flow, settings/legal/data work, Sentry |
| Release candidate | testers can install a signed artifact and execute regression flows | Maestro, metadata, internal distribution, staged device pass |

## 1. Build foundation — current work

1. Add the three EAS profiles:
   - `development`: internal development client, `development` update channel,
     `1.0.0-development` runtime.
   - `preview`: installable Android APK for testers, `preview` update channel,
     `1.0.0-preview` runtime.
   - `production`: Play-store artifact, `production` update channel, `1.0.0`
     runtime and remote Android build-number increments.
2. Keep `EXPO_PUBLIC_API_BASE_URL` in EAS environment variables, scoped to the
   corresponding EAS environment. It is public bundle configuration, but it
   must be HTTPS. Preview and production config evaluation fails when it is
   absent; neither may fall back to localhost.
3. Add mobile CI that installs the tracked dependency graph, typechecks, runs
   Jest, validates a valid HTTPS preview config, and proves an HTTP production
   config fails.
4. Configure the EAS project and upload the three API origins using `eas env:set`.
   This requires the actual development/preview/production hostnames and Expo
   account ownership; neither is guessed in source control.

**Acceptance:** `npx eas build --platform android --profile development`,
`preview`, and `production` resolve distinct channel/runtime/origin tuples.

## 2. Listener beta

1. Add shared-clip playback from Inbox using the existing player/token path,
   not a second audio player.
2. Add `PATCH /profile/me/update/` avatar selection/upload with explicit size,
   MIME and failed-upload states.
3. Wait for the backend parent/clip validation commit and its test before
   enabling replies. Then send `parent` only with the same clip as the sheet.
4. Design double-tap like as a new gesture with a bounded heart animation;
   preserve the action button's in-flight toggle guard.
5. Audit all new controls for 44 pt iOS / 48 dp Android touch targets, labels,
   focus order, contrast, busy/error announcements, and reduced-motion behaviour.

## 3. Creator and account beta

1. Replace Studio with recording and library pick, local duration/free-tier
   validation, a cancellable XHR upload, moderation approval, processing poll,
   and a my-clips list.
2. Add subscription state and web-portal upgrade, never native IAP.
3. Add compliance contacts, grievance submission, data summary, and two-stage
   account erasure with truthful pending-state copy.
4. Configure Sentry by environment; no DSN belongs in committed config.

## 4. Release quality

1. Add three Maestro flows: authenticate/play; like/comment/share; record,
   upload, approve and publish.
2. Produce Android listing metadata, privacy policy/support URLs, signing
   ownership record, screenshots and release notes.
3. Run preview against staging on physical Android, then distribute the signed
   internal build. Promote only after the recorded regression pass succeeds.

## Known external inputs

- Exact HTTPS API origins for the three environments.
- Expo organization/project ownership and Android signing ownership.
- Committed backend reply invariant before reply UI.
- Device/staging verification is intentionally deferred by the owner.
