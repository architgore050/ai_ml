# Compliance task — `license_type` is writable, defaulted, and read by nothing

**Status:** Open. Logged 2026-09-29 during the audio-scraper restore. Not a
regression; a pre-existing gap that the scraper work made visible.
**Type:** Product + legal decision. Not a mechanical patch.

## The gap

`AudioClip.license_type` is:

- declared `CharField(max_length=100, blank=True, null=True)` with **no
  default** (`backend/app/models.py:169`)
- a `ChoiceField` on `AudioUploadSerializer` with `required=False`, so it
  defaults to `"Unknown"` (`serializers.py:210`)
- **read by no view, service, gate, or task in the codebase**

Grepping every read of `license_type` outside `serializers.py` returns nothing.
`FeedClipSerializer` does not expose it. Nothing in `views/`, `services/`, or
`tasks/` consults it.

The serializer emits a warning and moves on (`serializers.py:245-247`):

```python
if license_type == "Unknown":
    logger.warning("Upload with Unknown license type — audit trail required.")
```

It does not reject the row, does not set `is_noncommercial`, and does not
enqueue any review.

## Why it matters

`license_type` is a *different column* from the pair the rights gate actually
reads (`is_noncommercial` / `requires_share_alike`). The gate
(`views/feed.py:115/137/173`, `services/entitlements.py:67`) never looks at it.

So: **a user who uploads a non-commercial recording and leaves the picker on
the default gets a clip the feed will serve commercially, with no flag set and
no review queued.** `SCRAPER_ALLOW_NC` does not apply — that flag governs the
importer, not the upload path.

This is a live Copyright Act 1957 exposure and an IT Rules 2021 audit-trail
question, in the *upload* path. It is independent of the scraper: restoring
the scraper neither fixes nor worsens it.

Note the asymmetry that makes this sharp:

| Path | Can declare "this is NC"? | Enforcement |
|---|---|---|
| API upload | **No** — `is_noncommercial` is not in `Meta.fields` | none |
| Scraper | Yes, via `normalize_license` | gated by `SCRAPER_ENABLED` (off) |

The path with a classifier is switched off. The path without one is wide open.

## Options, for a decision

None of these is mechanical; each changes the product contract.

1. **Reject `Unknown` on upload.** Make `license_type` `required=True` with an
   explicit choice. Strongest, but adds friction to every upload and DPDP
   §11 wants affirmative consent, not just a non-default.
2. **Accept `Unknown` but quarantine it.** Set
   `moderation_approved=False` when `license_type == "Unknown"` and require an
   operator `approve-moderation` call, mirroring how ShareAlike items are
   already handled. Reuses an existing gate; no new column.
3. **Expose the flags to the uploader.** Add `is_noncommercial` (and
   `requires_share_alike`) to `AudioUploadSerializer.Meta.fields` so a user can
   declare their own rights. Makes the API and the scraper symmetric, but
   means a client-supplied flag becomes an input to a rights gate — it then
   needs its own validation and a trust story.
4. **Move the gate onto `license_type`.** Make the feed filter on the
   declared licence family rather than the two booleans. Largest change;
   touches the gate every other consumer depends on.

Option 2 is the smallest that closes the exposure without inventing a trust
model, and it is consistent with the existing ShareAlike treatment. But
choosing between them is a product call, not an engineering one.

## Related, for whoever picks this up

- `docs/EXPLAIN/INDIA-REGULATORY-READINESS.md` and the Copyright Act 1957 /
  IT Rules 2021 sections in `AGENTS.md` both treat licensing as
  operator-gated. That framing assumes the importer is the only source of
  third-party content, which the upload path contradicts.
- `AGENTS.md` task 6.6 already notes the `"Unknown"` warning and calls for a
  mandatory picker in the UI. That is a client-side mitigation; it does not
  close the server-side gap for a direct API caller.
