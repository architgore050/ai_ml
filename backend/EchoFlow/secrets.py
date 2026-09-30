"""Placeholder-secret vocabulary and the guard that uses it.

WHY THIS MODULE EXISTS
======================

`backend/app/services/hls_token.py` already contained a good guard —
`is_placeholder_secret()` — that correctly rejects empty values, whitespace,
exact literals, ``<...>`` template markers and substring matches. It had
exactly **one** call site, for ``MEDIA_TOKEN_SECRET``.

That is the wrong shape for a security control. A guard that one service
owns is a guard the next two secrets never get, and moving it means editing
the one file that already works. So the vocabulary and the predicate live
here, in the project package, and both `settings.py` and the app services
import from it. Neither has to import from the other.

THE DEFECT THIS CLOSES
======================

Every tracked env template ships documentation placeholders:

  ===========================  ===========================================
  ``.env.example``             ``DJANGO_SECRET_KEY``, ``DB_PASSWORD``,
                               ``MEDIA_TOKEN_SECRET``
  ``.env.vps.example``         the above plus both ``REDIS_*_PASSWORD``
  ``.env.laptop.example``      ``<same-as-vps>`` for all of them
  ===========================  ===========================================

``MEDIA_TOKEN_SECRET`` was checked. The other three were not:

  * ``DJANGO_SECRET_KEY`` was guarded only for **emptiness**
    (``if not SECRET_KEY: raise ImproperlyConfigured``). A known key breaks
    session and CSRF signing, password-reset tokens, and every
    ``django.core.signing.Signer`` user — and it is committed to this
    repository, in three files, in plain text.
  * ``REDIS_BROKER_PASSWORD`` / ``REDIS_CACHE_PASSWORD`` were read with **no
    validation at all**, so a copied example gives an attacker who has read
    the repo full access to the broker (task injection) and the cache.
  * ``DB_PASSWORD`` is **not readable from here**: it appears zero times in
    `settings.py` and is consumed only by docker-compose interpolation, so
    there is no in-process place to guard it. It is called out in
    `.env.example`/`.env.vps.example` and needs a different kind of check
    (compose-level or CI-level). No settings-level guard is invented for it
    here, because a guard that reads nothing protects nothing.

THE TRADE-OFF, STATED PLAINLY
=============================

The substring list deliberately includes ``example`` and ``todo``. A
legitimate generated secret that happens to contain one of those words is
rejected. That is a false positive, and it is the safe direction: the cost is
one operator re-running the generator, whereas the cost of missing a renamed
placeholder is a publicly-known production key. The predicate also rejects
*any* value containing ``<`` or ``>``, which is how ``<same-as-vps>`` is
caught despite containing none of the listed words.

Set membership in :data:`PLACEHOLDER_SECRETS` is *not* a security boundary on
its own — the substring test subsumes it. It is kept because it documents
which exact strings have shipped, and because the fail-closed direction is
what makes adding a new example value safe.

THE ESCAPE HATCHES
==================

A ``DJANGO_SECRET_KEY`` guard runs on **every** process import: gunicorn
workers, all four Celery services, ``manage.py``. The repository's own
harness and dev stack currently pin a placeholder — ``conftest.py`` defaults
``DJANGO_SECRET_KEY`` to ``test-secret-key-not-for-prod`` and ``.env.local``
sets the same value — and neither file is in this change's scope. A guard
with no escape would therefore hard-fail the test suite and the dev stack on
the commit that adds it, which is how security guards get reverted.

Two narrow bypasses exist. Both emit a ``logging.WARNING``; neither is
silent.

``ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS=1``
    Explicit operator opt-out, for tooling that legitimately needs a dummy
    value (``python -c 'import settings'`` smoke checks, ``manage.py
    check``). The value must be exactly ``1`` — a bare presence test, or a
    truthy parse, would let ``=true`` or ``=0``... or a stray empty
    assignment disable the guard, which is precisely the accident this is
    meant to prevent. The name is long and specific so it cannot collide
    with anything.

``DJANGO_DEBUG=true``
    The process has already declared itself non-production. Django's own
    security model says debug output must never be exposed, and this repo's
    `AGENTS.md` requires ``DJANGO_DEBUG=False`` in anything behind the nginx
    terminator, so a placeholder key in a ``DEBUG=True`` process is a
    development artefact rather than a deployment. **This is a real
    weakening and is called out as one**: an operator who ships
    ``DJANGO_DEBUG=True`` gets a placeholder key past the guard. That
    misconfiguration is already catastrophic in every other way (full
    tracebacks, no HSTS, ``SECURE_SSL_REDIRECT`` off), so it is not the
    load-bearing control — but it is a hole, and once `.env*.example` and
    `conftest.py` are fixed the ``allow_in_debug`` branches here can be
    deleted in one edit.
"""

from __future__ import annotations

import logging
import os
import sys

from django.core.exceptions import ImproperlyConfigured

logger = logging.getLogger("django.security.placeholder_secrets")

#: Literal values that have shipped in `.env.example` / `.env.vps.example` /
#: `.env.laptop.example`. Kept in sync by
#: `backend/app/tests/test_throttle_identity_and_secrets.py::
#: TestShippedExampleSecretsAreRejected`, which *reads the files* rather than
#: trusting this list.
PLACEHOLDER_SECRETS = frozenset(
    {
        "change-me-to-a-long-random-string",
        "change-me-strong-password",
        "changeme",
        "change-me",
        "secret",
        "your-secret-here",
        "please-change-me",
        "replace-me",
        "insecure",
    }
)

#: Lower-cased substrings that mark a value as documentation rather than a
#: real secret. See "THE TRADE-OFF, STATED PLAINLY" in the module docstring
#: for why `example` and `todo` belong here despite the false positives.
PLACEHOLDER_SUBSTRINGS = (
    "change-me",
    "changeme",
    "change_me",
    "your-",
    "your_",
    "replace-me",
    "replace_me",
    "example",
    "placeholder",
    "not-for-prod",
    "not_for_prod",
    "todo",
)

# Private aliases. `hls_token.py` historically exposed `_PLACEHOLDER_SECRETS`
# and `_PLACEHOLDER_SUBSTRINGS`; keeping the names available means nothing
# that imported them breaks, and keeps this module's public surface explicit
# about which of the two is the documented one.
_PLACEHOLDER_SECRETS = PLACEHOLDER_SECRETS
_PLACEHOLDER_SUBSTRINGS = PLACEHOLDER_SUBSTRINGS

#: Escape hatch for tooling that needs a dummy value. See the module
#: docstring. Must be exactly ``BYPASS_VALUE``.
BYPASS_ENV_VAR = "ECHOFLOW_ALLOW_PLACEHOLDER_SECRETS"
BYPASS_VALUE = "1"

#: The env var `settings.py` reads to decide DEBUG. Named here rather than
#: imported from settings so this module stays importable during settings
#: import itself.
DEBUG_ENV_VAR = "DJANGO_DEBUG"


def is_placeholder_secret(value: str | None) -> bool:
    """True if `value` is obviously a documentation placeholder.

    Moved verbatim from `backend/app/services/hls_token.py`, which still
    re-exports it (existing tests import it from that module path). The
    behaviour is unchanged; only the owner changed.

    Kept tolerant on purpose: a strict allow-list of exact example strings
    would miss a renamed or reworded placeholder, whereas a substring test
    catches the whole family. The only cost is a false positive on an
    unusual-but-real secret, which is the safe direction — it fails closed.
    """
    if not value:
        return True
    stripped = value.strip()
    # Whitespace-only is as weak as empty. It is also truthy, so it would sail
    # past an `if not secret:` guard above and be used as a real HMAC key.
    if not stripped:
        return True
    # Angle brackets are the conventional template marker and never appear in
    # real key material. This catches placeholders whose wording the substring
    # list below does not anticipate — e.g. .env.laptop.example ships
    # `MEDIA_TOKEN_SECRET=<same-as-vps>`, which is a placeholder in intent but
    # contains none of the listed words.
    if "<" in stripped or ">" in stripped:
        return True
    if stripped.lower() in PLACEHOLDER_SECRETS:
        return True
    lowered = stripped.lower()
    return any(token in lowered for token in PLACEHOLDER_SUBSTRINGS)


def guard_is_bypassed() -> bool:
    """True when the operator has explicitly opted out of the guard.

    Requires the value to be exactly ``"1"``. A truthiness test would be
    defeated by ``=0``, ``=false`` and — worst — by an empty assignment left
    behind by a shell snippet, which is the accident most likely to happen.
    """
    return os.environ.get(BYPASS_ENV_VAR) == BYPASS_VALUE


def debug_enabled() -> bool:
    """True when the process has declared itself a development process."""
    return os.environ.get(DEBUG_ENV_VAR, "False").lower() == "true"


#: Env var `conftest.py` sets to declare "this is a test run". See
#: `testing_enabled` for why the env var alone is not sufficient.
TESTING_ENV_VAR = "ECHOFLOW_TESTING"


def testing_enabled() -> bool:
    """True when the current process is a test run.

    Two signals, because neither is sufficient alone.

    ``ECHOFLOW_TESTING=1`` is the honest declaration, and ``conftest.py`` sets
    it. But it cannot be the *only* signal: pytest-django calls
    ``django.setup()`` while loading initial conftests, which happens BEFORE
    the rootdir ``conftest.py`` module body executes. So on a real pytest run
    the env var is not yet in ``os.environ`` at the moment this module decides
    whether to raise — a fact discovered the hard way, when flipping the local
    compose file from a hardcoded ``DJANGO_DEBUG=True`` to
    ``${DJANGO_DEBUG:-False}`` made the whole suite die at import on the
    placeholder key it had been silently relying on.

    So the second signal is ``"pytest" in sys.modules``. pytest imports itself
    before it initialises Django, so this is reliably True at settings-import
    time on a test run, and reliably False under gunicorn, under every Celery
    service, and under ``manage.py``. It is narrower than checking the
    executable name, which would also be defeated by a wrapper script, and
    narrower than a blanket "is pytest installed", which a production image
    would satisfy while importing nothing.
    """
    if os.environ.get(TESTING_ENV_VAR, "").lower() in ("1", "true", "yes"):
        return True
    return "pytest" in sys.modules


def _warn_bypassed(name: str, value: str, reason: str) -> None:
    """Announce an accepted placeholder. A bypass is never silent.

    Uses an explicit ``sys.stderr`` write rather than ``logging`` alone: this
    runs during `settings.py` import, before Django has configured logging, so
    a root handler installed by an unrelated import could swallow a
    ``logger.warning``. The operator must see this on stderr and in the
    container log regardless.
    """
    message = (
        f"SECURITY: {name} is a documentation placeholder ({value!r}) and was "
        f"accepted because {reason}. This is only safe in a local development "
        f"process. If this is a deployed environment, unset "
        f"{BYPASS_ENV_VAR} and set a real value."
    )
    logger.warning(message)
    print(f"WARNING: {message}", file=sys.stderr)


def require_real_secret(
    name: str,
    value: str | None,
    *,
    purpose: str,
    generate: str,
    allow_in_debug: bool = True,
) -> str:
    """Return `value`, or raise `ImproperlyConfigured` if it is a placeholder.

    Args:
        name: The environment variable name, used verbatim in the error so
            the operator knows which line to edit.
        value: The candidate value. ``None``/empty is always a placeholder.
        purpose: What the secret protects, so the error says why this
            matters rather than only that it is wrong.
        generate: A copy-pasteable command that produces a real value.
        allow_in_debug: Whether ``DJANGO_DEBUG=true`` is a sufficient reason
            to proceed with a warning. See the module docstring for why this
            is a hole and when it can be removed.

    Raises:
        ImproperlyConfigured: The value is a placeholder and no bypass is in
            effect.
    """
    if not is_placeholder_secret(value):
        return value  # type: ignore[return-value]  # narrowed by the guard

    shown = "<empty>" if not value else repr(value)

    if guard_is_bypassed():
        _warn_bypassed(name, shown, f"{BYPASS_ENV_VAR}={BYPASS_VALUE} is set")
        return value  # type: ignore[return-value]

    if allow_in_debug and debug_enabled():
        _warn_bypassed(
            name,
            shown,
            f"{DEBUG_ENV_VAR}=true marks this a development process",
        )
        return value  # type: ignore[return-value]

    if allow_in_debug and testing_enabled():
        # Deliberately separate from the DJANGO_DEBUG branch above, and behind
        # the same `allow_in_debug` flag so that `allow_in_debug=False` still
        # means "no tolerance whatsoever" — a caller that opts out of every
        # bypass must get a raise, including under pytest. Without that, a test
        # asserting the raise path would silently stop testing it.
        #
        # The reason is stated as one: a test run gets its own justification
        # rather than borrowing the DEBUG one, so the DEBUG hole can be closed
        # on its own schedule without taking the suite down with it.
        _warn_bypassed(name, shown, "this process is a test run")
        return value  # type: ignore[return-value]

    raise ImproperlyConfigured(
        f"{name} is a documentation placeholder ({shown}). It is committed to "
        f"this repository in .env.example / .env.vps.example / "
        f".env.laptop.example, so deploying a copy unchanged leaves a "
        f"publicly-known value in {purpose}. A placeholder is treated exactly "
        f"like a missing one. Generate a real one with:\n"
        f"    {generate}\n"
        f"and set the same value on every process in the fleet (gunicorn, all "
        f"Celery services, manage.py) — they must agree, which is why the key "
        f"cannot be generated per process.\n"
        f"If you are running tooling that legitimately needs a dummy value "
        f"(a settings-import smoke check, `manage.py check`), set "
        f"{BYPASS_ENV_VAR}={BYPASS_VALUE} for that invocation only."
    )
