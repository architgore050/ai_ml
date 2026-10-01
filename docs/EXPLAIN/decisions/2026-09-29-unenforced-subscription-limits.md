# Unenforced subscription limits — decision needed from pricing owner

**Date:** 2026-09-29
**Status:** OPEN — awaiting a pricing decision. No code change made.
**Raised by:** frontend-rebuild audit (commit `325b6f3` era), Block 0 review
**Blocks:** nothing currently. This is a documentation and product decision, not a code fix.

## Summary

`GET /subscription/` advertises two limits to free-tier users that **nothing enforces**.
The values are read in exactly one place each, and that place is the response serializer.

## What the code actually does

```
backend/app/views/subscription.py:33   "max_clip_duration_seconds": REVENUECAT_CLIP_DURATION_LIMIT_FREE (60)
backend/app/views/subscription.py:35   "hd_quality_allowed":        not REVENUECAT_HD_QUALITY_BLOCKED_FREE
```

Those are the only two reads of either setting in the entire backend
(`grep -rn 'CLIP_DURATION_LIMIT_FREE\|HD_QUALITY_BLOCKED_FREE' backend/ --include=*.py`).

The only duration gate that exists is tier-blind:

```
backend/EchoFlow/settings.py:408   MAX_DURATION_SECONDS = 300
backend/app/serializers.py:329     max_seconds = MAX_DURATION_SECONDS   # 5 min, every tier
```

The only encoder settings are hardcoded, with no per-tier branch:

```
backend/app/tasks.py:362   '-ar', '44100', '-ac', '2', '-b:a', '128k'
```

So the current behaviour is:

| Tier | Advertised clip duration | Actually enforced | Advertised HD | Actually enforced |
|---|---|---|---|---|
| Free | 60 s | 300 s | blocked | not blocked |
| Pro | 300 s | 300 s | allowed | not blocked |

A free user can upload a 4-minute clip. Nothing about the output is tier-dependent
at all, so Pro's "unlimited / HD / 320 kbps" framing is currently a promise with
no mechanism behind it.

## What IS enforced today

These two gates are real and do work, and are unaffected by this issue:

| Gate | Enforced at |
|---|---|
| Daily upload count, free tier (`REVENUECAT_DAILY_UPLOAD_LIMIT_FREE`, default 5) | `views/content.py:191-205` |
| Upload file size, free tier (`REVENUECAT_UPLOAD_MAX_SIZE_MB_FREE`, default 10 MB) | `serializers.py:259-267` |
| Absolute file size ceiling (all tiers) | `serializers.py:267-269` |

## Why this was not fixed in the rebuild

The frontend rebuild plan (`docs/frontend_rebuild_plan.md`) proposed enforcing the
60 s cap and the HD block. The owner declined on the condition that it must not
require backend changes:

> "Also, i think the limits are enforced by backend. if backend requires changes then don't do that."

The premise was checked and does not hold — see above. Because enforcement would
require backend changes, the work was **dropped** rather than performed against a
false assumption. This document is the resulting handover.

## The decision

Three options. All are product calls; none is a code-shaped question.

**Option A — enforce the advertised limits (recommended if the 60 s cap is real).**
Add the tier check to `AudioUploadSerializer.validate()` alongside the existing
free-tier size check, and introduce per-tier encoder settings in
`process_audio_to_hls` (e.g. read `has_pro_entitlement` and select sample rate /
bitrate). Cost: the ffmpeg invocation gains a branch; already-encoded clips are
unaffected, so there is no migration. Risk: existing free-tier users with clips
between 60 s and 300 s are grandfathered, which is almost certainly the right
behaviour but should be stated.

**Option B — stop advertising them.**
Delete the two fields from the `SubscriptionStatusSerializer` response until a
pricing decision exists. Cost: one serializer change, one test update. The
frontend already has no consumer for them (see below). Nothing is lost because
nothing is enforced.

**Option C — leave as-is and accept the gap.**
The limits stay in the response and stay unenforced. Not recommended: the
response is a contract, and this one is inaccurate. The only mitigating factor is
that no client currently reads either field.

## Required input from the pricing owner

1. **Is the 60 s free clip-duration cap a real product limit, or aspirational?**
   This single answer decides A vs B. If it was written into the plan as a
   placeholder, Option B is the honest move.
2. **What are the Pro audio tiers?** Current text promises HD (48 kHz+) and
   320 kbps, but the encoder emits 44.1 kHz / 128 kbps for everyone. Either
   define the real Pro settings or drop the claim.
3. **Grandfathering policy** for clips already uploaded by free users that exceed
   a newly-enforced cap. Recommendation: let them play, apply the cap to new
   uploads only.

## Client impact

None today. The web client has no consumer for `max_clip_duration_seconds` or
`hd_quality_allowed` — the frontend audit found both unrendered. The type is
wrong as well: `views/subscription.py:26-28` puts ints and a bool into the Pro
branch and strings into the free branch, and DRF coerces everything to strings on
output, so `hd_quality_allowed` arrives as the string `"True"`, not `true`. That
typing correction is tracked as **B3** in the rebuild plan and is a
client-only change with no backend dependency.

## Files referenced

- `backend/app/views/subscription.py:20-40` — the response serializer
- `backend/app/serializers.py:259-269`, `:328-340` — the gates that do exist
- `backend/app/tasks.py:355-365` — the hardcoded ffmpeg encoder settings
- `backend/EchoFlow/settings.py:408`, `:901-902` — the constants
- `backend/app/tests/test_revenuecat.py` — 21 tests; none assert the duration or
  HD limits are enforced, which is why the gap survived

## Note on `AGENTS.md`

`AGENTS.md` currently lists, under "Enforcement points":

> `process_audio_to_hls` task — clip duration + quality limits
> Feed views — HD quality filtering

Neither exists. This document supersedes that list. `AGENTS.md` is corrected in
Block 0 commit 19 ("docs: correct five false claims"), which has not landed yet —
until it does, the `AGENTS.md` text is wrong and this file is the correction.
