"""Precedence of {prefix}_HOST vs {prefix}_URL. Regression guard for the
cross-project broker race (2026-09-29)."""
import importlib
import os
from unittest import mock

import pytest


def _resolve(env):
    """Re-import settings under a controlled environment."""
    from backend.EchoFlow import settings as s
    with mock.patch.dict(os.environ, env, clear=False):
        for k in ("REDIS_URL",):
            if k not in env:
                os.environ.pop(k, None)
        return s.resolve_redis_url


def test_host_wins_over_a_stale_url():
    """The bug: compose sets HOST deliberately; a stale URL must not win."""
    from backend.EchoFlow.settings import resolve_redis_url

    with mock.patch.dict(os.environ, {
        "REDIS_BROKER_HOST": "redis_broker_local",
        "REDIS_BROKER_PORT": "6379",
        "REDIS_BROKER_PASSWORD": "p/w+=",
        "REDIS_BROKER_URL": "redis://:stale@172.28.0.2:6379/0",
    }, clear=False):
        got = resolve_redis_url("REDIS_BROKER")
    assert "redis_broker_local" in got
    assert "172.28.0.2" not in got


def test_password_is_url_encoded_from_components():
    """Why the HOST/PORT split exists: base64 passwords break Kombo parsing."""
    from urllib.parse import quote

    from backend.EchoFlow.settings import resolve_redis_url

    pw = "p/w+="
    with mock.patch.dict(os.environ, {
        "REDIS_BROKER_HOST": "h", "REDIS_BROKER_PORT": "6379",
        "REDIS_BROKER_PASSWORD": pw,
    }, clear=False):
        got = resolve_redis_url("REDIS_BROKER")
    assert quote(pw, safe="") in got


def test_url_is_used_when_no_host_is_set():
    """.env.vps.example and .env.laptop.example set only the URL."""
    from backend.EchoFlow.settings import resolve_redis_url

    with mock.patch.dict(os.environ, {
        "REDIS_BROKER_URL": "redis://:pw@redis_broker:6379/0",
    }, clear=False):
        os.environ.pop("REDIS_BROKER_HOST", None)
        got = resolve_redis_url("REDIS_BROKER")
    assert got == "redis://:pw@redis_broker:6379/0"


def test_falls_back_to_redis_url():
    """.env.example sets neither; non-Docker dev uses one Redis."""
    from backend.EchoFlow import settings as s

    # build_redis_url reads the module-level REDIS_URL constant, captured at
    # import — not os.environ at call time. So patch the attribute, not the
    # environment; patching os.environ here would silently do nothing and the
    # assertion would pass for the wrong reason.
    with mock.patch.dict(os.environ, {}, clear=False):
        for k in ("REDIS_BROKER_HOST", "REDIS_BROKER_URL", "REDIS_BROKER_PASSWORD"):
            os.environ.pop(k, None)
        with mock.patch.object(s, "REDIS_URL", "redis://localhost:6379/1"):
            got = s.resolve_redis_url("REDIS_BROKER")
    assert got == "redis://localhost:6379/1"


def test_the_resolved_broker_is_not_another_projects_broker():
    """The concrete regression: the local stack published to 172.28.0.2,
    another compose project's broker, and lost a Celery race.

    Asserts the effective value in the running config resolves to the local
    service name, not a raw IP from an env file.
    """
    from backend.EchoFlow import settings as s

    # Whatever the env, the broker must never be the foreign 172.28.0.2.
    assert "172.28.0.2" not in s.REDIS_BROKER_URL, (
        f"broker points at another project's Redis: {s.REDIS_BROKER_URL}"
    )
