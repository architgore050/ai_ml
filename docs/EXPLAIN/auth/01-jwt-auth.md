# JWT Authentication

## Overview

**SimpleJWT** (`djangorestframework-simplejwt==5.5.1`) for stateless JWT authentication.

---

## Configuration (`settings.py:334-339`)

```python
from datetime import timedelta

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
}
```

| Token | Lifetime | Purpose |
|-------|----------|---------|
| Access | 15 minutes | API authorization |
| Refresh | 7 days | Obtain new access tokens |

---

## Token Structure

### Access Token Payload
```json
{
  "token_type": "access",
  "exp": 1705312200,
  "iat": 1705311300,
  "jti": "uuid-v4",
  "user_id": 123
}
```

### Refresh Token Payload
```json
{
  "token_type": "refresh",
  "exp": 1705830900,
  "iat": 1705311300,
  "jti": "uuid-v4",
  "user_id": 123
}
```

**Signing:** HS256 with `DJANGO_SECRET_KEY`

---

## Authentication Flow

```
1. POST /auth/login/ {username, password}
       │
       ▼
2. TokenObtainPairView validates credentials
       │
       ▼
3. Returns: {access, refresh, user}
       │
       ├── access: Bearer token for API requests
       └── refresh: Stored securely, used to obtain new access tokens
       │
       ▼
4. Client includes: Authorization: Bearer <access_token>
       │
       ▼
5. JWTAuthentication middleware:
   ├── Verify signature (HS256 + SECRET_KEY)
   ├── Check expiration (exp claim)
   ├── Fetch user (user_id claim)
   ├── Verify user.is_active
   └── Set request.user
```

---

## Token Refresh Flow

```
1. API returns 401 (access expired)
       │
       ▼
2. Client POST /auth/token/refresh/ {refresh}
       │
       ▼
3. `ThrottledTokenRefreshView` validates (throttled on the **verified** `user_id`
   inside the token, not the client IP — see `04-rate-limiting.md`):
   ├── Signature valid
   ├── Not expired (7 days)
   ├── Not blacklisted (NOT IMPLEMENTED)
   │
   ▼
4. Returns new {access, refresh?}
       │
       ▼
5. Client retries original request with new access token
```

**Frontend Implementation** (`client.ts:50-78`):
```typescript
// Auto-refresh on 401
if (res.status === 401) {
  const refreshToken = getRefreshToken();
  const r = await fetch('/auth/token/refresh/', {refresh: refreshToken});
  if (r.ok) {
    setTokens({access: d.access, refresh: d.refresh || refreshToken});
    // Retry original request
  }
}
```

---

## Endpoints

| Method | Endpoint | View | Auth |
|--------|----------|------|------|
| POST | `/auth/login/` | `TokenObtainPairView` | Public |
| POST | `/auth/register/` | `RegisterView` | Public |
| POST | `/auth/token/refresh/` | `ThrottledTokenRefreshView` | Public |

---

## Registration (`RegisterView`)

```python
class RegisterView(generics.CreateAPIView):
    queryset = User.objects.all()
    permission_classes = (AllowAny,)
    serializer_class = RegisterSerializer

# RegisterSerializer.create():
user = User.objects.create_user(
    username=validated_data['username'],
    email=validated_data['email'],
    password=validated_data['password']
)
return user  # dj-rest-auth returns tokens
```

**Returns:** `{access, refresh, user}` — same as login.

---

## Security Considerations

### Token Storage (Frontend)
```typescript
// sessionStorage (cleared on tab close)
sessionStorage.setItem('ef_access', access);
sessionStorage.setItem('ef_refresh', refresh);
sessionStorage.setItem('ef_user', JSON.stringify(user));
```

| Storage | Pros | Cons |
|---------|------|------|
| sessionStorage | Auto-clear on tab close | XSS accessible |
| localStorage | Persists | XSS accessible |
| HttpOnly Cookie | Not XSS accessible | CSRF risk, needs SameSite |

**Current:** sessionStorage — **XSS vulnerable**

### Missing Security Features

| Feature | Status | Risk |
|---------|--------|------|
| Token blacklist (logout) | ❌ Not implemented | Stolen access token valid 15min |
| Refresh token rotation | ❌ Not implemented | Long-lived refresh token theft |
| Refresh token reuse detection | ❌ Not implemented | No theft detection |
| Device binding | ❌ Not implemented | No session management |
| Short access token (15min) | ✅ | Limits exposure window |

### Recommended: Refresh Token Rotation
```python
# On refresh:
1. Validate refresh token
2. Blacklist old refresh token (Redis, TTL=7d)
3. Issue NEW refresh token + access token
4. Store new refresh token hash in DB
5. On reuse detection → revoke ALL user tokens
```

---

## Custom Claims (Not Used)

```python
# To add custom claims:
from rest_framework_simplejwt.tokens import RefreshToken

class CustomRefreshToken(RefreshToken):
    @classmethod
    def for_user(cls, user):
        token = super().for_user(user)
        token['username'] = user.username
        token['roles'] = user.get_role()
        return token
```

---

## Integration with DRF

```python
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
}
```

**All endpoints require authentication** unless explicitly overridden.

---

## Social Auth (Configured, Not Used)

```python
INSTALLED_APPS += [
    'allauth',
    'allauth.account',
    'allauth.socialaccount',
    'allauth.socialaccount.providers.google',
    'dj_rest_auth',
    'dj_rest_auth.registration',
]
```

**Google OAuth** configured but not wired to JWT flow.

---

## Testing Authentication

### Get Tokens
```bash
curl -X POST http://localhost:8000/auth/login/ \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "testpass"}'

# Response: {"access": "...", "refresh": "...", "user": {...}}
```

### Use Access Token
```bash
curl -H "Authorization: Bearer <access_token>" \
  http://localhost:8000/feed/
```

### Refresh Token
```bash
curl -X POST http://localhost:8000/auth/token/refresh/ \
  -H "Content-Type: application/json" \
  -d '{"refresh": "<refresh_token>"}'
```

---

*Source: `backend/EchoFlow/settings.py:334-339`, `backend/app/urls.py`, `frontend/sample_frontend/src/api/client.ts`, `backend/app/serializers.py:141-161`*