"""Client IP resolution for audit records.

SECURITY: This module exists because two audit paths need the same answer and
one of them was silently wrong.

nginx is the only public entrypoint (see docs/EXPLAIN/docker/
05-https-tls-termination.md). It sets three distinct headers, and they do not
mean the same thing:

  proxy_set_header X-Real-IP        $remote_addr;
  proxy_set_header X-Forwarded-For  $proxy_add_x_forwarded_for;

* ``X-Real-IP`` is **set** to the peer address nginx actually saw. nginx
  overwrites whatever the client sent, so it cannot be spoofed through the
  terminator. This is the authoritative client address.

* ``X-Forwarded-For`` **appends** (``$proxy_add_x_forwarded_for``). A client
  may send ``X-Forwarded-For: 1.2.3.4`` and nginx will forward
  ``1.2.3.4, <real client>``. The first entry is therefore client-controlled
  and must not be trusted. The *last* entry is the one nginx appended, and is
  only meaningful if every hop in between is trusted — which is not knowable
  from inside Django. So XFF is used only as a last-resort fallback, and only
  when no X-Real-IP and no REMOTE_ADDR is present.

* ``REMOTE_ADDR`` is the address of the immediate peer. Behind nginx that is
  the nginx container's IP (e.g. ``172.29.0.9``), which is useless for
  identifying a user.

The previous implementation in ``CorrelationIdMiddleware`` was::

    request.META.get('REMOTE_ADDR') or request.META.get('HTTP_X_FORWARDED_FOR', '')

— i.e. REMOTE_ADDR was checked **first**. Behind the terminator that branch
always matches, so the XFF fallback could never execute and every audit row
recorded the proxy. Verified against the running stack before fixing::

    AuditLog.ip_address -> 172.29.0.13, 172.29.0.9   (nginx container IPs)

DPDP §5(1) notice evidence and CERT-In 2022 identity retention both depend on
this value being the user's address. Recording the proxy makes the audit trail
attributable to nobody.
"""
from __future__ import annotations

import ipaddress

from django.http import HttpRequest

#: Headers consulted, in strict precedence order. Kept as a tuple so the
#: ordering is obvious at the point of use and easy to test.
_PRECEDENCE = (
    # Set by nginx from $remote_addr; overwrites any client-supplied value.
    "HTTP_X_REAL_IP",
    # Direct connection (bare-metal dev, or the :8005 debug escape hatch).
    "REMOTE_ADDR",
    # Appended by nginx. First entry is client-controlled, so this is only
    # reached when nothing better exists — see module docstring.
    "HTTP_X_FORWARDED_FOR",
)


def _valid_ip(value: str | None) -> str | None:
    """Return `value` if it parses as an IP address, else None.

    A malformed or hostile value must not reach ``GenericIPAddressField``,
    which would raise and turn an audit write into a 500. This also rejects
    the empty string and whitespace, which ``.strip()`` alone would miss.
    """
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return None
    return candidate


def get_client_ip(request: HttpRequest | None) -> str | None:
    """Resolve the originating client's IP address, or None.

    Returns a string suitable for ``GenericIPAddressField``. See the module
    docstring for why ``X-Forwarded-For`` is not trusted first.

    On a direct (non-proxied) connection this is just ``REMOTE_ADDR``. Behind
    nginx it is the value of ``X-Real-IP``. Both are covered by tests so a
    future refactor cannot silently regress either path.
    """
    if request is None:
        return None

    meta = getattr(request, "META", None) or {}

    for header in _PRECEDENCE:
        resolved = _valid_ip(meta.get(header))
        if resolved:
            return resolved

    # XFF is a comma-separated chain; take the LAST hop, which is the one
    # appended by our own terminator. Reached only when neither X-Real-IP nor
    # REMOTE_ADDR is present, which in practice means a proxy that forwarded
    # the chain but did not set either.
    xff = meta.get("HTTP_X_FORWARDED_FOR") or ""
    for candidate in reversed([part.strip() for part in xff.split(",")]):
        resolved = _valid_ip(candidate)
        if resolved:
            return resolved
    return None
