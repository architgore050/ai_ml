# Rate Limiting

> **Partially historical.** The sections *Critical Gaps* and *Recommended
> Improvements* below are an early architecture audit (pre-`ScopedRateThrottle`
> scopes) and are kept for the record. Most of what they list as missing —
> per-endpoint scopes, telemetry caps, Redis-backed counting — has since
> shipped. **The accurate current state is the three sections immediately
> below.** Read those, not the audit.
>
> The CGNAT problem — IP-keyed throttling applied to a mobile network, where
> one carrier NAT gateway is thousands of callers — was found and fixed on
> 2026-09-28 and is **not** visible in the historical sections at all. See
> `../decisions/2026-09-28-native-media-auth-and-cgnat-throttling.md`.

## Current Configuration (`backend/EchoFlow/settings.py`, `DEFAULT_THROTTLE_RATES`)

```python
REST_FRAMEWORK = {
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon':              '100/hour',
        'user':             '1000/hour',
        'telemetry':          '60/min',    # log_telemetry — the abuse vector
        'upload':             '20/hour',   # /clips/ (storage DoS guard)
        'register':          '200/hour',   # /auth/register/ (per IP)
        'register_username':   '3/hour',   # /auth/register/ (per username)
        'login':              '10/min',
        'token_refresh':     '120/hour',   # /auth/token/refresh/ (per verified subject)
        'comment':            '60/hour',
        'share_send':        '100/hour',
        'share_poll':       '1000/hour',
        'interaction':        '60/min',
        'legal':              '30/hour',
        'grievance':          '10/hour',
        'data_subject':        5/hour,
        'subscription_sync':   '10/hour',
    },
}
```

> `ScopedRateThrottle` is a **silent no-op** on a view that declares no
> `throttle_scope` — it reads the scope from the view at request time and
> allows everything. Listing the class without the attribute disables
> throttling with no error. See §Throttle Classes below.

## Throttle Classes

### AnonRateThrottle
- **Scope:** `anon`
- **Limit:** 100 requests/hour
- **Identification:** Client IP address
- **Applies to:** `AllowAny` endpoints not overriding `throttle_classes`
- **⚠️ Not appropriate for a mobile API.** A carrier NAT gateway is
  thousands of subscribers behind one address, so they share one bucket.

### UserRateThrottle
- **Scope:** `user`
- **Limit:** 1000 requests/hour
- **Identification:** Authenticated user ID
- **Applies to:** All authenticated endpoints. **One shared budget** — feed,
  telemetry, comments and tokens all draw from it.

### ScopedRateThrottle
- **Scopes:** the table above
- **Identification:** the view's `throttle_scope`, keyed by IP or user
- **⚠️ Requires `throttle_scope` on the view.** Absent, it allows everything.
  `RegisterView` and `ThrottledTokenRefreshView` both declare it, and
  `backend/app/tests/test_throttling.py::TestRefreshThrottleWiring` asserts it
  because a wiring mistake raises nothing.

### RefreshTokenRateThrottle (`backend/app/throttling.py`)
- **Scope:** `token_refresh`, 120/hour
- **Identification:** the **verified `user_id` inside the refresh token**,
  falling back to the caller's IP only when no usable token is presented
- **Why:** `/auth/token/refresh/` is the endpoint most broken by IP keying.
  Access tokens live 15 minutes, so every active user refreshes ~4x/hour. On
  `anon` (100/hour/IP) a single cell exhausts the shared budget within
  minutes and **every subscriber on it is logged out**, with no server error
  — each response was a correct 401.
- **Verification is mandatory.** `RefreshToken(raw)` checks the signature and
  expiry. Decoding the payload alone would let an attacker flip `user_id` in
  a stolen token and mint a fresh bucket per forged subject.
- **The subject is a `str`, not an `int`** — simplejwt does
  `user_id = str(user_id)` before writing the payload. An int-only guard
  silently falls back to IP keying for every real token.

### RegisterUsernameRateThrottle (`backend/app/throttling.py`)
- **Scope:** `register_username`, 3/hour
- **Identification:** the lower-cased username in the request body, falling
  back to IP when absent
- **Why:** registration is anonymous, so the IP key cannot be removed. This
  is the second axis that bounds what an IP key cannot express — one host
  cycling through accounts, and repeated re-registration to squat or reclaim
  a handle. Lower-casing can only merge buckets, never fan an attacker out.
- **Applies alongside** `register` (200/hour, per IP), which is sized to let
  a carrier NAT onboard normally.

## Implementation Details

### Throttle Backend
- **Default:** Django cache (`django.core.cache.cache`)
- **Dev:** Local memory cache (per-process)
- **Prod:** Redis cache (shared)

### Cache Key Format
```
throttle_{scope}_{ident}
# e.g., throttle_user_123, throttle_anon_192.168.1.1
#      throttle_token_refresh_user:7   (verified subject)
#      throttle_register_username_username:alice
```

> The custom classes use `user:` / `ip:` / `username:` prefixes so a key's
> origin is readable in Redis. `bool` subjects are rejected explicitly —
> `isinstance(True, int)` is `True` in Python, and a container reaching the
> key would raise from a Memcached/Redis backend and turn an ordinary
> authenticated request into a 500.

### Testing note
Throttle tests run against a private `LocMemCache`, not the shared Redis the
Celery workers use. `SimpleRateThrottle.cache` is bound to the Django default
cache at import, so 120 sequential round-trips intermittently blew through
django-redis' socket timeout and failed for reasons unrelated to the
throttle. Counting is pure logic; it does not need shared infrastructure.

### Response Headers
```
Retry-After: 3600  (on 429)
```
> DRF does **not** emit `X-RateLimit-Limit` / `-Remaining` / `-Reset`. The
> three-header set shown in the historical section below is not implemented
> and should not be relied on by any client.

### 429 Response
```json
{
  "detail": "Request was throttled. Expected available in 3600 seconds."
}
```

---

## Current Limits Analysis

| Endpoint | Auth | Scope | Limit | Key | Risk |
|----------|------|-------|-------|-----|------|
| `/auth/token/refresh/` | anon | `token_refresh` | 120/hr | verified user_id | Low (was **critical**: mass logout on CGNAT) |
| `/auth/register/` | anon | `register` + `register_username` | 200/hr IP, 3/hr username | IP + username | Low (was **critical**: capped signup behind CGNAT) |
| `/auth/login/` | anon | `login` | 10/min | IP | Low (brute force) |
| `/interactions/*/log-telemetry/` | user | `telemetry` | 60/min | user | **Critical** (engagement-fraud vector) |
| `/clips/` | user | `upload` | 20/hr | user | Medium (storage DoS) |
| `/comments/` | user | `comment` | 60/hr | user | Low |
| `/share/*/send-share/` | user | `share_send` | 100/hr | user | Low |
| `/share/inbox/` | user | `share_poll` | 1000/hr | user | Low (30s polling) |
| `/feed/` | user | `user` | 1000/hr | user | Medium — **shared** with every other authed call |
| `/legal/`, `/grievance/`, `/data-subject/` | mixed | `legal` / `grievance` / `data_subject` | 30/hr, 10/hr, 5/hr | IP | Low |

> `/legal/`, `/grievance/` and `/data-subject/` keep IP-keyed limits by
> design: they are user-initiated, low-frequency and low-volume, so sharing
> a bucket across a cell is correct there rather than a bug.


## Critical Gaps (Architecture Audit)

### 1. No Per-Endpoint Overrides
```python
# Current: Global only
# Needed: Per-endpoint
class TelemetryThrottle(UserRateThrottle):
    scope = 'telemetry'
    rate = '60/minute'  # Stricter for telemetry

class FeedThrottle(UserRateThrottle):
    scope = 'feed'
    rate = '200/hour'  # Stricter for feed
```

### 2. No Redis-Backed Distributed Throttling
- **Dev:** Local memory → each worker has separate count
- **Prod:** Redis needed for accurate distributed limits

### 3. Telemetry Spam Risk
```
Attacker script:
  for i in range(1000):
      POST /interactions/clip_id/log-telemetry/
          {action_type: "view", watch_time_ms: 60000}
```
- 1000 requests → within 1000/hr limit
- Artificially inflates `completion_rate` → boosts clip ranking
- **No server-side validation** of `watch_time_ms` vs actual clip duration

### 4. No Burst Protection
- Sustained 1000/hr = ~17 req/min average
- Burst of 1000 in 1 minute → allowed
- Should have **burst + sustained** tiers

---

## Recommended Improvements

### 1. Per-Endpoint Throttles
```python
# views.py
class ClipInteractionViewSet(...):
    @action(..., throttle_classes=[TelemetryThrottle])
    def log_telemetry(self, ...):
        ...

class FastFeedViewSet(...):
    throttle_classes = [FeedThrottle]
```

### 2. Redis Token Bucket (Distributed)
```python
class DistributedTokenBucketThrottle:
    def __init__(self, redis_client):
        self.redis = redis_client
    
    def allow_request(self, key, rate_per_minute, burst_multiplier=2):
        bucket_key = f"throttle:{key}"
        
        # Token bucket algorithm
        now = time.time()
        bucket = self.redis.hgetall(bucket_key)
        
        if not bucket:
            # Initialize with burst capacity
            self.redis.hset(bucket_key, mapping={
                'tokens': str(rate_per_minute * burst_multiplier),
                'last_refill': str(now)
            })
            self.redis.expire(bucket_key, 3600)
            return True
        
        tokens = float(bucket['tokens'])
        last_refill = float(bucket['last_refill'])
        
        # Refill tokens
        elapsed = now - last_refill
        refill_rate = rate_per_minute / 60.0
        tokens = min(rate_per_minute * burst_multiplier, tokens + elapsed * refill_rate)
        
        if tokens >= 1:
            tokens -= 1
            self.redis.hset(bucket_key, mapping={
                'tokens': str(tokens),
                'last_refill': str(now)
            })
            return True
        
        return False
```

### 3. Server-Side Telemetry Validation
```python
def log_telemetry(self, request, pk=None):
    clip = self.get_object()
    watch_time_ms = serializer.validated_data['watch_time_ms']
    
    # VALIDATE: Can't watch more than clip duration
    max_watch = clip.duration_ms
    if watch_time_ms > max_watch * 1.1:  # 10% tolerance
        watch_time_ms = max_watch  # Cap it
    
    # VALIDATE: Minimum time between telemetry for same clip
    last_telemetry = UserInteraction.objects.filter(
        user=request.user, clip=clip, interaction_type='view'
    ).order_by('-updated_at').first()
    
    if last_telemetry:
        min_interval = 1000  # 1 second minimum
        if (timezone.now() - last_telemetry.updated_at).total_seconds() * 1000 < min_interval:
            return Response({'detail': 'Telemetry too frequent'}, status=429)
```

### 4. IP + User Composite Throttling
```python
class CompositeThrottle:
    def get_ident(self, request):
        # Combine IP + User for stricter limits
        user_id = request.user.id if request.user.is_authenticated else 'anon'
        ip = self.get_client_ip(request)
        return f"{user_id}:{ip}"
```

---

## Monitoring Throttle Metrics

### Prometheus Metrics (Not Implemented)
```python
THROTTLE_HITS = Counter('throttle_hits_total', 'Throttle hits', ['scope', 'result'])
THROTTLE_CURRENT = Gauge('throttle_current_usage', 'Current throttle usage', ['scope', 'user'])
```

### Logs
```python
# Log throttled requests
logger.warning("Rate limit exceeded", extra={
    'scope': scope,
    'user_id': user_id,
    'ip': ip,
    'endpoint': request.path
})
```

---

## Testing Throttles

```bash
# Test anon limit
for i in {1..105}; do curl -X POST http://localhost:8000/auth/login/ -d '{"username":"x","password":"y"}'; done

# Test user limit (with token)
for i in {1..1005}; do curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/feed/; done
```

---

*Source: `backend/EchoFlow/settings.py:324-331`, `backend/app/views.py:308-377`*