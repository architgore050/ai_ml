"""RevenueCat REST API integration service.

Handles entitlement verification via the RevenueCat REST API and updates
the local User model's Pro fields. Uses REST API polling only (no webhooks
in Phase 1).

SECURE: REVENUECAT_SECRET_KEY is read from settings and must NEVER be
exposed to the frontend. The public key (REVENUECAT_PUBLIC_KEY) is the
only RevenueCat credential safe for browser use.

PLACEHOLDER GUARD
=================

`REVENUECAT_SECRET_KEY` was the one credential in `settings.py` with no
placeholder check, while `DJANGO_SECRET_KEY` and both Redis passwords run
through `EchoFlow/secrets.require_real_secret`. `.env.example` and
`.env.vps.example` both ship it blank and the gitignored `.env` shipped
`your-revenuecat-secret-key`, so a deployment could reach
`api.revenuecat.com/v1/subscribers/<uuid>` with a repository-known bearer
token. It never *looked* like a breach — RevenueCat answers a bad token with
401, `get_subscriber_info` maps that to `None`, and `sync_entitlements`
preserves the current Pro state — so the symptom was a subscription feature
that silently never works, on every account, in production.

`settings.py` is where the other three are enforced, but it is a different
owner's file, so the check lives here instead: this module is the only place
that decides *whether to make the call*, which is the property that actually
matters. `_verified_secret_key()` is the single choke point, called before
any request is built.

An EMPTY value is deliberately NOT a guard failure and is handled by the
pre-existing early return below, exactly as `settings.py` treats an empty
`DB_PASSWORD`. RevenueCat is optional in this codebase — `sync_entitlements`
already documented "not configured" as a skip — and every shipped template
ships it blank. Treating that as a hard failure would make a documented,
supported deployment shape unbootable. A value that *looks like
documentation* is refused; a value that is absent is skipped.
"""
import logging
import time
import uuid
from datetime import datetime, timezone

import requests
from django.conf import settings
from django.utils import timezone as dt_timezone

from backend.EchoFlow.secrets import require_real_secret

logger = logging.getLogger(__name__)

REVENUECAT_API_BASE = "https://api.revenuecat.com/v1"
REQUEST_TIMEOUT = 15  # seconds


def _verified_secret_key() -> str:
    """Return the configured API key, refusing a documentation placeholder.

    Reuses `require_real_secret` rather than a second, RevenueCat-specific
    predicate, so the vocabulary stays in one place: a renamed placeholder is
    caught by the same substring table that guards the Redis passwords.

    Raises `ImproperlyConfigured`, which is deliberately fatal rather than a
    skip. "The key is a placeholder" is an operator error with no safe
    default — the alternative is silently never syncing entitlements — and the
    error text names the variable and the Dashboard it must be copied from.
    """
    return require_real_secret(
        "REVENUECAT_SECRET_KEY",
        getattr(settings, "REVENUECAT_SECRET_KEY", "") or "",
        purpose=(
            "the RevenueCat REST API (every subscriber lookup, i.e. the whole "
            "Pro entitlement sync)"
        ),
        generate=(
            "RevenueCat dashboard -> Project Settings -> API keys -> Secret "
            "API key (starts with sk_) — it is not generated locally"
        ),
    )


def _headers():
    return {
        "Authorization": f"Bearer {settings.REVENUECAT_SECRET_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def get_subscriber_info(app_user_id: str) -> dict | None:
    """Fetch subscriber info from RevenueCat for a given app_user_id.

    Returns the `subscriber` dict from the response, or None if the
    subscriber doesn't exist or the request fails.
    """
    url = f"{REVENUECAT_API_BASE}/subscribers/{app_user_id}"
    try:
        resp = requests.get(url, headers=_headers(), timeout=REQUEST_TIMEOUT)
        if resp.status_code == 404:
            logger.info("RevenueCat subscriber %s not found", app_user_id)
            return None
        resp.raise_for_status()
        return resp.json().get("subscriber")
    except requests.RequestException as exc:
        logger.warning("RevenueCat API error for %s: %s", app_user_id, exc)
        return None


def _parse_date_ms(date_ms: str | int | None) -> datetime | None:
    """Parse a RevenueCat date-ms string/int into a timezone-aware datetime."""
    if not date_ms:
        return None
    try:
        ms = int(date_ms)
    except (ValueError, TypeError):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _parse_revenuecat_date(value: str | None) -> datetime | None:
    """Parse the ISO-8601 timestamps returned by RevenueCat API v1."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_active_entitlement(subscriber: dict):
    """Determine entitlement status and dates from subscriber info.

    Returns (is_active, expires_at, grace_until).
    """
    if not subscriber:
        return False, None, None

    entitlement_id = getattr(settings, "REVENUECAT_ENTITLEMENT_ID", "pro")
    entitlements = subscriber.get("entitlements", {})
    if not isinstance(entitlements, dict):
        return False, None, None

    # RevenueCat API v1 keys this dictionary by entitlement identifier.  Do
    # not identify an entitlement by its product: a single entitlement can be
    # granted by multiple products (monthly, annual, promotional, etc.).
    ent_data = entitlements.get(entitlement_id)

    # Keep accepting the old internal payload while clients roll over.  The
    # documented API-v1 shape above is always preferred.
    if not isinstance(ent_data, dict):
        ent_data = next(
            (
                data for data in entitlements.values()
                if isinstance(data, dict) and data.get("product_id") == entitlement_id
            ),
            None,
        )
    if not isinstance(ent_data, dict):
        return False, None, None

    expires_at = (
        _parse_revenuecat_date(ent_data.get("expires_date"))
        or _parse_date_ms(ent_data.get("expires_date_ms"))
        or _parse_date_ms(ent_data.get("expire_date_ms"))
    )
    grace_until = (
        _parse_revenuecat_date(ent_data.get("grace_period_expires_date"))
        or _parse_date_ms(ent_data.get("grace_period_expire_date_ms"))
    )

    if "is_active" in ent_data:
        return bool(ent_data["is_active"]), expires_at, grace_until

    raw_expiry = ent_data.get("expires_date")
    if raw_expiry and expires_at is None:
        logger.warning("RevenueCat returned an invalid entitlement expiry for %s", entitlement_id)
        return False, None, grace_until

    # API v1 does not return an is_active field. A present entitlement is
    # active until its expiry; a null expiry represents a lifetime purchase.
    return expires_at is None or expires_at > dt_timezone.now(), expires_at, grace_until


def sync_entitlements(user) -> bool:
    """Sync Pro entitlement state from RevenueCat to the Django User.

    Returns True if the user's Pro status changed.
    """
    if not getattr(settings, "REVENUECAT_SECRET_KEY", ""):
        logger.debug("RevenueCat secret key not configured — skipping sync")
        return False

    # Refuses a placeholder before a single request is built. See the module
    # docstring: empty is "not configured" (skip), documentation-shaped is an
    # operator error (raise).
    _verified_secret_key()

    if not user.revenuecat_app_user_id:
        logger.debug("User %s has no revenuecat_app_user_id — skipping sync", user.id)
        return False

    app_user_id = str(user.revenuecat_app_user_id)
    subscriber = get_subscriber_info(app_user_id)
    # A transport failure (and an unknown remote customer) must not revoke a
    # previously confirmed purchase. Successful subscriber payloads with no
    # matching entitlement still clear access below.
    if subscriber is None:
        logger.warning("RevenueCat lookup unavailable for user %s; preserving current Pro state", user.id)
        return False
    is_active, expires_at, grace_until = _is_active_entitlement(subscriber)

    changed = False
    was_active = user.has_pro_entitlement

    if is_active != was_active:
        user.has_pro_entitlement = is_active
        changed = True

    if expires_at != user.pro_expires_at:
        user.pro_expires_at = expires_at
        changed = True

    if grace_until != user.pro_grace_until:
        user.pro_grace_until = grace_until
        changed = True

    if changed:
        user.pro_last_synced = dt_timezone.now()
        user.save(update_fields=[
            "has_pro_entitlement",
            "pro_expires_at",
            "pro_grace_until",
            "pro_last_synced",
        ])
        logger.info(
            "User %s Pro status updated: active=%s, expires=%s, grace=%s",
            user.id, is_active, expires_at, grace_until,
        )

    return changed


def _app_user_id(user) -> str:
    """Return the user's RevenueCat App User ID.

    There is NO `User.uuid` attribute — `User` extends `AbstractUser`, whose
    primary key is `AbstractUser.id`, an AutoField. An earlier version of
    `get_customer_portal_url` read `str(user.uuid)` on the null branch, which
    raised `AttributeError` and returned HTTP 500 from
    `GET /subscription/manage/`. The `uuid4()` default on the field masked it on
    every account created after migration 0002, so only rows predating the field
    could reach it.

    The field is now NOT NULL (migration 0009, backfilled by 0008), so the
    database can no longer produce the state this branch exists for. The
    tolerance is kept deliberately, as defence-in-depth:

    - a `User` instance that was never reloaded from the database — e.g. built
      in memory, or returned by a `.only()` queryset that omitted the column —
      can still present `None` here, and this function is the single place the
      App User ID is read, so it is the right place to be total;
    - failing closed by raising would turn a missing identifier into a 500 on a
      user-facing screen, which is exactly the bug this replaced.

    The backfill is safe for a billing identity: a NULL id means the row has
    never been sent to RevenueCat, so a fresh uuid4 cannot collide with a real
    remote customer or orphan an existing purchase.
    """
    if not user.revenuecat_app_user_id:
        user.revenuecat_app_user_id = uuid.uuid4()
        user.save(update_fields=["revenuecat_app_user_id"])
    return str(user.revenuecat_app_user_id)


def get_customer_portal_url(user) -> str:
    """Return the RevenueCat Customer Portal URL for a user.

    The URL is generated client-side by RevenueCat's SDK; this returns
    a deep-link that the frontend can redirect the user to.
    """
    app_user_id = _app_user_id(user)

    base = getattr(settings, "REVENUECAT_CUSTOMER_PORTAL_URL", "")
    if base:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}app_user_id={app_user_id}"

    return f"https://rcat.page/p/echoflow?app_user_id={app_user_id}"
