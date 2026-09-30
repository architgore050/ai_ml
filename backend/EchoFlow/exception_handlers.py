"""DRF exception handler that turns a dead cache into a 503.

WHY THIS FILE EXISTS
====================

A rate limiter has to *read* state on every request, which means a Redis
outage lands in the middle of DRF's request pipeline. `django_redis` wraps
every client error into `django_redis.exceptions.ConnectionInterrupted`, and
that class subclasses **bare `Exception`**, not `APIException`::

    ConnectionInterrupted -> Exception -> BaseException

DRF's `APIView.handle_exception` only knows about `Http404` and
`PermissionDenied`; everything else goes to
`rest_framework.views.exception_handler`, which handles `APIException` and
`Http404` and **returns `None` for anything else**. `None` means "I did not
recognise this", so the exception is re-raised, escapes `dispatch`, and the
client gets an HTTP 500 — a full traceback page whenever
`DJANGO_DEBUG=True`.

That is the wrong answer twice over. 500 says "this request is broken, do
not retry", and a Redis blip is precisely the case a client *should* retry.
It also leaks internals on any deployment that has debug on.

WHY FAIL-CLOSED RATHER THAN FAIL-OPEN
=====================================

The alternative — catch it and return "allowed" — silently removes the rate
limit for exactly as long as the cache is down, which is the one window an
attacker would choose. Rejecting with 503 is honest, is retryable, and
preserves the protection. It also cannot be confused with a 429: a 429 tells
the caller *they* did something wrong and that waiting will help; a 503 tells
them *we* are broken. Conflating the two would push well-behaved clients into
giving up.

SCOPE, AND WHAT IS DELIBERATELY NOT COVERED
===========================================

This only runs for exceptions raised inside a DRF view's `dispatch`. A
`ConnectionInterrupted` raised in a Celery task, a management command, or a
plain Django view still becomes a 500. Covering those needs a middleware or a
logging filter and is out of scope here — it is listed in the report as
follow-up work rather than half-done.

Everything else is delegated to DRF's own handler, unchanged, so this is
provably transparent for every non-Redis exception. That transparency is
pinned by a test, because a custom `EXCEPTION_HANDLER` silently replaces DRF's
for the entire API.
"""

from __future__ import annotations

from django_redis.exceptions import ConnectionInterrupted
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as _drf_exception_handler


def cache_unavailable_handler(exc, context):
    """Map a cache-backend outage to 503; delegate everything else to DRF.

    Registered as ``REST_FRAMEWORK['EXCEPTION_HANDLER']``. The string path is
    resolved lazily by DRF's `import_from_string`, so this module is not
    imported during `settings.py` evaluation.
    """
    if isinstance(exc, ConnectionInterrupted):
        return Response(
            {
                "detail": (
                    "Service temporarily unavailable: the cache backend is not "
                    "reachable. This is a server-side fault, not a problem "
                    "with the request — retry shortly."
                ),
                "code": "cache_unavailable",
            },
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return _drf_exception_handler(exc, context)
