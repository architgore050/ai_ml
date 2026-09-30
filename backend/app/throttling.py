"""Custom DRF throttle classes.

WHY THIS FILE EXISTS — CARRIER-GRADE NAT MAKES IP-KEYED THROTTLING WRONG
ON A MOBILE-FIRST API.

`AnonRateThrottle` keys on `REMOTE_ADDR`. On a desktop or server that is a
reasonable proxy for "one caller". On a mobile network it is not: an Indian
mobile carrier puts thousands of subscribers behind a single CGNAT address.
Every one of those subscribers shares one throttle bucket.

Two endpoints broke because of this, and both break in the worst possible
way — they fail for *legitimate* users:

  1. `POST /auth/token/refresh/`. Access tokens live 15 minutes
     (`SIMPLEJWT['ACCESS_TOKEN_LIFETIME']`), so every active user refreshes
     ~4 times/hour. Under the inherited `anon` rate of 100/hour, a single
     NAT gateway exhausts the whole cell's budget within minutes and every
     subscriber is logged out. The endpoint itself was fine; the *key* was
     wrong.

  2. `POST /auth/register/`. The `register` rate is a per-IP account-creation
     spam limit, which is the right *intent* — but a 5/hour per-IP budget
     means a carrier cell can onboard five users per hour. New-user signup is
     the growth metric; throttling it at 5/hour/IP does not stop a determined
     spammer, it just caps the business.

The fix for (1) is to stop keying on IP entirely once the caller proves who
they are. A refresh token is a *signed, verified* credential that already
carries `user_id` in its payload, so we can read the principal out of the
request itself. DRF hands `get_cache_key` the raw request; all we have to do
is verify the token and pull the subject out. The result:

  - a real user gets their own bucket, sized for their own token lifetime
    (4/hour needed, 120/hour allowed), regardless of who else is behind the
    same public IP;
  - an attacker who does not hold a valid token cannot even reach the
    per-user branch, and falls back to the IP bucket — which is still a real
    bound on the flood, because the bucket is per source address.

Verification is not optional here and is not skippable. If we merely
*decoded* the token without checking the signature, an attacker could mint
arbitrary `user_id` values, get a fresh bucket for each one, and convert a
rate limit into no rate limit at all. `RefreshToken(raw)` validates the
signature and expiry and raises `TokenError` otherwise, so the fallback
branch is reached only when the token is genuinely unusable.

For (2) there is no credential to key on — registration is anonymous by
definition — so the IP key has to stay. What changes is the rate, and the
addition of a second, independent limit keyed on the *username* the caller
asked for. Together they bound the abuse that actually matters (bulk
account creation, and repeatedly re-registering one account to reclaim a
username) without capping how many humans behind one NAT can sign up.

The remaining IP-keyed limits on `/legal/`, `/grievance/` and
`/data-subject/` are intentionally left alone: they are user-initiated,
low-frequency, and low-volume, so sharing a bucket across a cell is correct
behaviour there rather than a bug.


THE SECOND, LARGER BUG: THE IDENTITY ITSELF WAS CALLER-CONTROLLED
================================================================

Everything above treats "the caller's IP" as a known quantity. It was not.

`REST_FRAMEWORK['NUM_PROXIES']` was unset, so DRF's
`BaseThrottle.get_ident` fell through to its documented default::

    return ''.join(xff.split()) if xff else remote_addr

— the *entire* client-supplied `X-Forwarded-For` header, whitespace
stripped, verbatim, as the throttle identity. nginx does not overwrite that
header, it appends::

    proxy_set_header X-Real-IP       $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

so a client sending `X-Forwarded-For: 9.9.9.9` reaches DRF as the string
`9.9.9.9,203.0.113.7`, and every distinct header value is a distinct,
never-before-seen bucket. One header defeats every IP-keyed limit in the
project — `login` (10/min, the credential-stuffing gate), `anon`
(100/hour), `register` (200/hour), `clip_public` (120/min) — with no
concurrency, no volume and no infrastructure pressure at all.

The asymmetry that made this a security defect rather than an annoyance:
`EchoFlow/client_ip.py` already resolved the caller *correctly* for the
audit trail — DPDP §5(1) notice evidence and CERT-In identity retention —
by preferring `X-Real-IP`, which nginx **overwrites** from `$remote_addr` and
which therefore cannot be spoofed through the terminator. Evidence was
attributed to the user while the limits protecting those same endpoints were
keyed on a string the attacker picked.

Two layers fix it, and both are needed:

  1. `NUM_PROXIES = 1` in settings. There is exactly one nginx in front, so
     DRF takes the `addrs[-1]` branch — the hop nginx appended. This is the
     guaranteed backstop: it covers the views that declare a bare
     `ScopedRateThrottle` or rely on the inherited `DEFAULT_THROTTLE_CLASSES`.
     It is one line and it is easy to delete by accident.

  2. `TrustedProxyRateThrottle` below. It reuses the resolution the repo
     already trusts, and — unlike layer 1 — validates each candidate through
     `ipaddress.ip_address`, so a garbage `X-Real-IP` degrades to
     `REMOTE_ADDR` instead of becoming a throttle key. Layer 1 alone would
     happily key on `1.2.3.4; DROP TABLE`. Every throttle in this project that
     keys on the caller uses it — including `POST /auth/login/`, the
     credential-stuffing gate, which lists this class itself in
     `backend/app/urls.py` rather than relying on the backstop alone.

The third fix here is fail-closed behaviour: a dead cache must produce 503,
not 500. See `TrustedProxyRateThrottle.allow_request` and
`backend/EchoFlow/exception_handlers.py`.


THIRD BUG: A CLASS-LEVEL `scope` ON A `ScopedRateThrottle` IS DEAD CODE
=====================================================================

`RegisterUsernameRateThrottle` shipped `scope = 'register_username'` and was
listed on `RegisterView`, whose own `throttle_scope` is `'register'`. DRF's
`ScopedRateThrottle.allow_request` opens with::

    self.scope = getattr(view, self.scope_attr, None)

so the view's scope overwrote the class's on the first request, and the
per-username throttle charged every key against `register` — 200/hour. Its
3/hour limit was never in force. The bucket was still per-username, so nothing
leaked across accounts; the limit was simply 66x looser than it read, and
nothing anywhere reported it. The test that appeared to cover it looped 120
times, which is `token_refresh`'s rate, not this scope's.

The second clean DRF mechanism is `get_throttles()` initkwargs — passing
`{'scope': ...}` to the constructor, which `APIView.get_throttles` does not do
on its own. That was not used: the scope then lives on the *view*, so the
throttle class is only correct for as long as someone remembers to pass it, and
a second view reusing the class silently reverts to a dead scope. The fix here
is `TrustedProxyRateThrottle.resolve_scope`, which makes "pin my own scope" an
override the class owns.


FOURTH BUG: `login: 10/min` IS ONE SHARED BUDGET PER CARRIER NAT
==================================================================

Refresh could stop keying on IP because it carries a signed, verified subject
to key on instead. Login cannot: it *is* the credential-stuffing gate, so it
has to stay IP-keyed, and an IP on a mobile network is a cell rather than a
person. 10/min is ~600/hour shared by everyone the carrier has behind that
address.

So login gets the same shape of second limit registration has —
`LoginUsernameRateThrottle`, one bucket per claimed account, alongside the
per-IP `login` bucket rather than in place of it. Neither alone is the right
limit: the IP key bounds the flood, and is unusable on its own; the username
key bounds a sustained attack on one known account, and is trivially sidestepped
by an attacker rotating names. Together the flood is capped and the target
account is capped, without either limit being NAT-bound.
"""

from django_redis.exceptions import ConnectionInterrupted
from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.throttling import ScopedRateThrottle
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from backend.EchoFlow.client_ip import get_client_ip


class ThrottleBackendUnavailable(APIException):
    """503 raised when the throttle counter cannot be read.

    A rate limiter that cannot read its counter has two honest options:
    allow (fail-open, which silently deletes the limit for exactly as long as
    the cache is down — the one window an attacker would pick) or reject
    (fail-closed). This is fail-closed.

    Deliberately *not* `Throttled`. A 429 tells the caller that they did
    something wrong and that waiting will help; this says the server is
    broken and the request is retryable. Conflating them pushes well-behaved
    clients into giving up.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = (
        "Service temporarily unavailable: the cache backend backing the rate "
        "limiter is not reachable. This is a server-side fault — retry "
        "shortly."
    )
    default_code = "throttle_backend_unavailable"


class TrustedProxyRateThrottle(ScopedRateThrottle):
    """`ScopedRateThrottle` whose identity comes from a trusted header.

    The only override is `get_ident`, and it delegates to
    `EchoFlow.client_ip.get_client_ip` — the *same* function the audit trail
    uses. One resolver, one set of precedence rules, one thing to keep
    correct. Do not re-derive the precedence here; `client_ip.py` carries the
    reasoning about which of `X-Real-IP` / `REMOTE_ADDR` /
    `X-Forwarded-For` can be trusted and why.

    Subclass this rather than `ScopedRateThrottle` for any throttle that keys
    on the caller. `NUM_PROXIES` in settings is the backstop, not the fix:
    it is a count that silently re-breaks the moment a second proxy is added
    in front, it validates nothing, and it only reads `X-Forwarded-For`.
    """

    #: Read off the view unless a subclass overrides `resolve_scope`. Named
    #: here so `resolve_scope` does not have to know DRF's attribute name.
    scope_attr = 'throttle_scope'

    def get_ident(self, request):
        """Return the caller's address, or '' when it cannot be resolved.

        '' rather than `None` because DRF interpolates the result straight
        into `cache_format % {...}`; `None` would raise `TypeError` from
        inside the throttle and turn a request into a 500.
        """
        return get_client_ip(request) or ""

    def resolve_scope(self, view):
        """The scope in force for `view`; None means "do not throttle".

        This is DRF's own rule (`ScopedRateThrottle.scope_attr`) behind a
        method, and it exists as a method for one reason: a `ScopedRateThrottle`
        subclass that declares its own `scope` gets it **silently overwritten**
        on the first request, because `allow_request` assigns
        `self.scope = getattr(view, 'throttle_scope', None)` before reading
        the rate. A class attribute is therefore not a scope; it is a default
        that a view's own scope always wins over.

        `RegisterUsernameRateThrottle` shipped that way for a month: its
        `register_username` (3/hour) scope was never read, and it enforced the
        view's `register` rate of 200/hour under a per-username key. A
        subclass that needs a scope of its own overrides this to return it —
        that is the supported way to pin one, and
        `backend/app/tests/test_throttle_scopes_and_db_password.py` fails if a
        class-declared scope and the scope actually enforced disagree.
        """
        return getattr(view, self.scope_attr, None)

    def allow_request(self, request, view):
        """Resolve the scope, re-derive the rate, fail closed on a dead cache.

        Inlined from `ScopedRateThrottle.allow_request` for two reasons, both
        of which are behaviours DRF's version does not have:

          * the scope comes from `resolve_scope`, so a subclass can pin one
            (see its docstring for the defect that made this necessary);
          * the `ConnectionInterrupted` handler wraps the cache read.

        `SimpleRateThrottle.allow_request` reads `self.cache.get(self.key,
        [])`. A stale `django-redis` connection raises
        `ConnectionInterrupted` there, which subclasses bare `Exception` —
        so DRF's `exception_handler` returns `None`, the exception is
        re-raised and the client sees a 500.

        This override is the version that does not depend on
        `REST_FRAMEWORK['EXCEPTION_HANDLER']` being installed, so the two
        custom throttles stay correct on their own. The global handler covers
        the views that declare a bare `ScopedRateThrottle`; together they
        leave no unprotected path. `ConnectionInterrupted` is the exact class
        django-redis raises (it re-raises it around every command in
        `django_redis/client/default.py`), so catching it catches all of
        them without also swallowing genuine bugs.

        `SimpleRateThrottle.allow_request` is called explicitly rather than
        through `super()`: `ScopedRateThrottle.allow_request` is the copy being
        replaced, and it re-reads the scope from the view, which is the bug.
        Rate and `num_requests` are still re-derived on every call, so a
        `THROTTLE_RATES` override applied after instantiation takes effect.

        `SimpleRateThrottle` is imported here rather than at module scope
        because this module's namespace is audited:
        `test_throttle_identity_and_secrets.py::
        TestThrottleCacheFailureIs503::test_no_throttle_shadows_the_inherited_cache`
        walks every `SimpleRateThrottle` subclass reachable from here and
        asserts none of them defines its own `cache`. A top-level import would
        put DRF's own class into that set and fail it.
        """
        from rest_framework.throttling import SimpleRateThrottle

        try:
            self.scope = self.resolve_scope(view)
            if not self.scope:
                return True
            self.rate = self.get_rate()
            self.num_requests, self.duration = self.parse_rate(self.rate)
            return SimpleRateThrottle.allow_request(self, request, view)
        except ConnectionInterrupted:
            raise ThrottleBackendUnavailable() from None


class RefreshTokenRateThrottle(TrustedProxyRateThrottle):
    """Scope-addressed throttle that prefers the token's subject over the IP.

    Registered as scope `token_refresh`; the rate lives in
    `REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['token_refresh']`.

    `ScopedRateThrottle` is used as the base rather than `UserRateThrottle`
    because `request.user` is anonymous on this endpoint — that is the whole
    point, the caller is presenting a refresh token instead of an access
    token. It also lets the rate be declared alongside the other rates
    instead of being hardcoded in `get_rate()`.
    """

    scope = 'token_refresh'

    def get_cache_key(self, request, view):
        """Bucket by verified user id, falling back to the caller's IP.

        `ScopedRateThrottle.cache_format` is
        `'throttle_{scope}_{ident}'`. The fallback identity comes from
        `TrustedProxyRateThrottle.get_ident`, i.e.
        `EchoFlow.client_ip.get_client_ip` — NOT from DRF's default, which
        would return the client-supplied `X-Forwarded-For` header verbatim and
        let the caller rotate their own bucket one header per request.

        The per-subject key is unchanged and is the whole point of this class:
        it is what keeps ~4 refreshes/hour/subscriber off a single carrier
        NAT bucket. Do not "simplify" this into an IP key.
        """
        user_id = self._resolve_user_id(request)
        if user_id is not None:
            ident = f'user:{user_id}'
        else:
            # No usable refresh token. Either the caller sent none, or it
            # failed signature/expiry validation, or the body was not valid
            # JSON and DRF never populated `request.data`. All three are the
            # anonymous case, so the IP key is the correct — and only —
            # available identity.
            ident = f'ip:{self.get_ident(request)}'
        return self.cache_format % {'scope': self.scope, 'ident': ident}

    @staticmethod
    def _resolve_user_id(request):
        """Return the `user_id` embedded in a valid refresh token, else None.

        `request.data` is read defensively: DRF raises if the request body is
        unparseable and we have not accessed `request.data` by the time this
        runs, and a throttle must never be the thing that turns a malformed
        request into a 500.
        """
        try:
            raw = request.data.get('refresh')
        except (APIException, AttributeError, KeyError, TypeError, ValueError):
            # `ParseError` and `UnsupportedMediaType` (both `APIException`) are
            # raised when DRF cannot read the body at all. `ParseError` is NOT
            # a `ValueError` subclass — omitting it here turns a malformed
            # request into a 500 from inside the throttle, which is strictly
            # worse than the 400 the view was about to return. The rest
            # cover a duck-typed request, a non-dict body, and a body whose
            # payload is a list rather than a mapping.
            #
            # Treat an unreadable body as "no token presented": the view
            # returns its own 400 and nothing is charged to anyone's bucket
            # beyond the anonymous IP one.
            return None

        if not raw or not isinstance(raw, str):
            return None

        # RefreshToken(str) verifies the signature AND checks exp/iat. A
        # tampered, expired or malformed token raises TokenError -> None.
        try:
            payload = RefreshToken(raw).payload
        except TokenError:
            return None

        user_id = payload.get('user_id')
        # simplejwt 5.5.1 stringifies the subject on the way in
        # (rest_framework_simplejwt/tokens.py: `user_id = str(user_id)` before
        # it is written to the payload), so a real token's `user_id` arrives
        # as `"1"`, not `1`. An int is accepted too so the throttle keeps
        # working if that ever changes.
        #
        # Everything else is rejected: a container reaching the cache key
        # would raise from a Memcached/Redis backend and turn an ordinary
        # authenticated request into a 500. A throttle must never be that.
        if isinstance(user_id, (str, int)) and not isinstance(user_id, bool):
            return str(user_id)
        return None


class UsernameKeyedRateThrottle(TrustedProxyRateThrottle):
    """Shared keying for the two throttles keyed on a username in the body.

    Neither endpoint is authenticated when the throttle runs — registering and
    logging in are the two requests a caller makes *before* they have a
    credential — so there is no principal to read and the only useful identity
    is the name the caller asked for.

    Subclasses supply their own `scope`; this class pins it and supplies the
    key, which is what makes each caller a bucket of their own.
    """

    def resolve_scope(self, view):
        """Pin `self.scope`, ignoring whatever the view declares.

        Both throttles here are registered *alongside* another throttle on the
        same view, and that view carries a different `throttle_scope` of its
        own — `RegisterView` is `'register'`, `ThrottledTokenObtainPairView` is
        `'login'`. DRF's `ScopedRateThrottle.allow_request` overwrites
        `self.scope` with it before reading the rate, so an unpinned subclass
        runs its own key against someone else's rate and nobody notices.

        Reading `self.scope` rather than the literal is safe because
        `TrustedProxyRateThrottle.allow_request` only ever assigns this
        method's own result back to it, so the value is a fixed point from the
        first call onwards.
        """
        return self.scope

    def get_cache_key(self, request, view):
        username = ''
        try:
            username = request.data.get('username') or ''
        except (APIException, AttributeError, KeyError, TypeError, ValueError):
            # Unparseable body: fall back to the IP key so the attempt is
            # still counted against something, and the view returns 400.
            return self.cache_format % {
                'scope': self.scope,
                'ident': f'ip:{self.get_ident(request)}',
            }

        if not isinstance(username, str):
            username = ''

        if username:
            # Normalise the same way User.username is: Django's
            # UnicodeUsernameValidator is case-sensitive, but a user who
            # tries "Alice" then "alice" is one account fishing for a name,
            # and throttling them as one is the desired behaviour. Lowering
            # is the conservative choice — it can only merge buckets, never
            # split a single attacker's traffic across many.
            return self.cache_format % {
                'scope': self.scope,
                'ident': f'username:{username.lower()[:150]}',
            }

        return self.cache_format % {
            'scope': self.scope,
            'ident': f'ip:{self.get_ident(request)}',
        }


class RegisterUsernameRateThrottle(UsernameKeyedRateThrottle):
    """Scope-addressed throttle keyed on the username being registered.

    Runs alongside the per-IP `register` limit rather than replacing it.
    The per-IP limit bounds how much traffic one source address can generate;
    this one bounds how fast any single account name can be re-created, which
    is the abuse the IP limit cannot see once the rate is raised high enough
    to accommodate a carrier NAT.

    Only counts requests that actually get far enough to be a registration
    attempt. A throttle that counts malformed bodies would let an attacker
    burn another user's budget with garbage — `request.data` is read after
    parsing, and a missing/blank username simply does not consume a token
    from the bucket.
    """

    scope = 'register_username'


class LoginUsernameRateThrottle(UsernameKeyedRateThrottle):
    """Per-account login limit, alongside the per-IP `login` limit.

    `POST /auth/login/` is `login: 10/min`, keyed on the caller's address.
    That key has to stay: login is anonymous, so there is no verified subject
    to key on the way token refresh has one. But a carrier NAT gateway is one
    address for thousands of subscribers, so the 10/min is a budget the whole
    cell shares and the 11th genuine user on a busy cell gets a 429.

    Raising it fixes that and costs the thing the limit exists for: 10/min is
    the credential-stuffing gate. This throttle keeps it — one account, one
    bucket, sized for a human who fat-fingers a password a few times. An
    attacker who is stuffing credentials rotates usernames, so the per-username
    bucket barely constrains them either; the IP limit is what bounds the flood
    and this one is what bounds a sustained attack on a single known account.

    `resolve_scope` pins `login_username` for the same reason
    `RegisterUsernameRateThrottle` pins `register_username`: inheriting the
    view's `login` scope here would run this key at 10/min and quietly make
    the per-account limit indistinguishable from the per-IP one.
    """

    scope = 'login_username'
