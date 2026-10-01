# Feed Exhaustion Recovery

**Status:** Proposed — approval required before implementation  
**Scope:** `ai_ml/pipelines/recommendation.py`, feed-candidate tests

## Problem

`build_feed_candidates()` excludes every clip with a `UserInteraction` from
the preceding 30 days. That exclusion is applied to the Redis-pool path, its
SQL backfill, the vector-ranking fallback, and the cold-start fallback. When
a user has interacted with every eligible clip in a small catalogue,
`refill_user_feed()` receives no candidates and the API can return `202
Preparing your feed...` indefinitely.

## Proposed behavior

1. Keep the current 30-day unseen-first selection unchanged.
2. Only when that selection has no candidates, select from the same eligible
   catalogue again.
3. Re-serve clips in ascending order of the user's most recent interaction
   with each clip (least recently interacted first); ties use current
   engagement/newness ordering.
4. Keep all existing eligibility predicates (`status='ready'`, and the view's
   moderation/licence enforcement) unchanged. This is a candidate-recovery
   policy, not a rights-gate change.

## Why this policy

It preserves discovery whenever unseen material exists, avoids the permanent
empty-feed state, and does not require a new client response shape, storage
field, migration, or scheduler. It is intentionally narrower than reducing
the global 30-day window, which would make repeats routine rather than a
last-resort recovery.

## Alternatives rejected

- Return a terminal “caught up” response: truthful but leaves the primary
  feed unusable in a small catalogue.
- Shorten the normal seen window: restores content earlier but weakens the
  anti-repetition policy for every user and every refill.
- Add a per-user cooldown/history model: more configurable, but requires a
  schema and product-policy design beyond the P1 recovery.

## Implementation outline

- Extract the existing unseen-first logic in `build_feed_candidates()`.
- If and only if it produces no IDs, query ready clips annotated with each
  clip's most recent interaction timestamp for this user and return the
  least-recently-interacted candidates.
- Retain UUID deduplication in the builder.
- Add database-backed tests for:
  - unseen clips remain preferred;
  - an exhausted catalogue returns eligible re-serve candidates in oldest
    interaction order;
  - unready clips never enter recovery;
  - the normal no-catalogue result remains empty.

## Compatibility and failure behavior

The endpoint remains unchanged. A first empty queue can still correctly
produce `202` while Celery runs. After a successful recovery refill, a later
poll returns the normal `200` feed response. A genuinely empty eligible
catalogue continues to return no candidates.

## Atomic commit plan

1. Add candidate-recovery tests that fail against the current builder.
2. Implement the least-recently-interacted fallback.
3. Run the focused feed tests, then the Docker test suite when the stack is
   healthy.
