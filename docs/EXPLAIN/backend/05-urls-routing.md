# Backend URL Routing

## Root URL Configuration

**File:** `backend/EchoFlow/urls.py`

```python
from django.contrib import admin
from django.urls import path, include
from django_prometheus.exports import ExportToDjangoView
from .health import health_check, readiness_check

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('backend.app.urls')),
    path('health/', health_check, name='health_check'),
    path('ready/', readiness_check, name='readiness_check'),
    path('metrics/', ExportToDjangoView, name='prometheus_django_metrics'),
]
```

**Endpoints:**
| Path | View | Purpose |
|------|------|---------|
| `/admin/` | Django admin | Admin interface |
| `/` | `backend.app.urls` | All API routes |
| `/health/` | `health_check` | Liveness probe (process alive) |
| `/ready/` | `readiness_check` | Readiness probe (DB connected) |
| `/metrics/` | `ExportToDjangoView` | Prometheus metrics export |

---

## App URL Configuration

**File:** `backend/app/urls.py`

```python
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    AudioUploadViewSet, FastFeedViewSet, ClipInteractionViewSet,
    ShareViewSet, CommentViewSet, FollowViewSet, 
    TagsViewSet, SuggestionViewSet, RegisterView, ProfileViewSet
)
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView
from .throttling import RefreshTokenRateThrottle

# Both token endpoints are rate-limited, and both declare `throttle_scope` on
# the VIEW — `ScopedRateThrottle` reads it there and allows everything when
# it is absent, so omitting the attribute is a silent no-op.
class ThrottledTokenObtainPairView(TokenObtainPairView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

class ThrottledTokenRefreshView(TokenRefreshView):
    throttle_classes = [RefreshTokenRateThrottle]  # keyed on the verified subject
    throttle_scope = 'token_refresh'


router = DefaultRouter()
router.register(r'feed', FastFeedViewSet, basename='feed')
router.register(r'clips', AudioUploadViewSet, basename='clips')
router.register(r'interactions', ClipInteractionViewSet, basename='interactions')
router.register(r'share', ShareViewSet, basename='share')
router.register(r'comments', CommentViewSet, basename='comments')
router.register(r'follow', FollowViewSet, basename='follow')
router.register(r'tags', TagsViewSet, basename='tags')
router.register(r'suggestions', SuggestionViewSet, basename='suggestions')
router.register(r'profile', ProfileViewSet, basename='profile')

urlpatterns = [
    path('', include(router.urls)),
    path('auth/login/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('auth/register/', RegisterView.as_view(), name='register'),
    path('auth/token/refresh/', ThrottledTokenRefreshView.as_view(), name='token_refresh'),
    # NOTE: no /media/ route — media served via S3/MinIO signed URLs
]
```

---

## Complete API Endpoint Map

### Authentication
| Method | Endpoint | View | Auth |
|--------|----------|------|------|
| POST | `/auth/register/` | `RegisterView` (200/hr per IP + 3/hr per username) | Public |
| POST | `/auth/login/` | `TokenObtainPairView` | Public |
| POST | `/auth/token/refresh/` | `ThrottledTokenRefreshView` | Public |

### Clips (AudioUploadViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| POST | `/clips/` | `create` | ✓ |
| GET | `/clips/` | `list` | ✓ |
| GET | `/clips/{id}/` | `retrieve` | ✓ |
| PATCH | `/clips/{id}/` | `partial_update` | ✓ |
| PUT | `/clips/{id}/` | `update` | ✓ |
| DELETE | `/clips/{id}/` | `destroy` | ✓ |

### Feed (FastFeedViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| GET | `/feed/` | `list` | ✓ |

### Interactions (ClipInteractionViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| POST | `/interactions/{id}/toggle-like/` | `toggle_like` | ✓ |
| POST | `/interactions/{id}/register-skip/` | `register_skip` | ✓ |
| POST | `/interactions/{id}/log-telemetry/` | `log_telemetry` | ✓ |

### Share (ShareViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| GET | `/share/` | `list` (inbox) | ✓ |
| GET | `/share/find-user/?username=` | `find_user` | ✓ |
| POST | `/share/{id}/send-share/` | `send_share` | ✓ |
| DELETE | `/share/{id}/share-delete/` | `share_delete` | ✓ |
| PATCH | `/share/{id}/mark-read/` | `mark_read` | ✓ |
| GET | `/share/inbox/` | `inbox` | ✓ |
| GET | `/share/unread-count/` | `unread_count` | ✓ |

### Comments (CommentViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| GET | `/comments/?clip={id}` | `list` (filtered) | ✓ |
| GET | `/comments/?parent={id}` | `list` (replies) | ✓ |
| POST | `/comments/` | `create` | ✓ |
| GET | `/comments/{id}/` | `retrieve` | ✓ |
| PATCH | `/comments/{id}/` | `partial_update` | ✓ |
| DELETE | `/comments/{id}/` | `destroy` | ✓ |

### Follow (FollowViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| POST | `/follow/{id}/toggle-follow/` | `toggle_follow` | ✓ |

### Tags (TagsViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| POST | `/tags/initialize/` | `initialize_vectors` | ✓ |

### Suggestions (SuggestionViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| GET | `/suggestions/?category=` | `list` | ✓ |

### Profile (ProfileViewSet)
| Method | Endpoint | Action | Auth |
|--------|----------|--------|------|
| GET | `/profile/me/` | `me` | ✓ |
| PATCH | `/profile/me/update/` | `update_me` | ✓ |
| GET | `/profile/{id}/` | `retrieve` | ✓ |
| GET | `/profile/{id}/clips/` | `user_clips` | ✓ |

---

## Health & Monitoring Endpoints

### `/health/` (Liveness)
```python
def health_check(request):
    return JsonResponse({
        "status": "healthy",
        "timestamp": time.time(),
    })
```
- **Purpose:** Process is alive
- **Used by:** Docker healthcheck, load balancer liveness
- **No dependencies** — returns immediately

### `/ready/` (Readiness)
```python
def readiness_check(request):
    try:
        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return JsonResponse({
            "status": "ready",
            "database": "connected",
            "timestamp": time.time(),
        })
    except Exception:
        return JsonResponse({
            "status": "not_ready",
            "database": "error",
            "timestamp": time.time(),
        }, status=503)
```
- **Purpose:** App can serve traffic (DB connected)
- **Used by:** Docker healthcheck, load balancer readiness
- **Checks:** PostgreSQL connectivity

### `/metrics/` (Prometheus)
```python
path('metrics/', ExportToDjangoView)
```
- **Purpose:** Prometheus metrics scraping
- **Provided by:** `django-prometheus` (includes Django, DB, cache metrics)
- **Format:** Prometheus text exposition format

---

## Media Serving (Intentional Absence)

```python
# NOTE: no /media/ route anymore, on purpose. Media now lives in S3-
# compatible object storage (see settings.STORAGES["default"]), not on
# this container's disk — there is nothing local left to serve, and a
# django.views.static.serve route here would 404 on every request
# regardless of DEBUG. Playback URLs come from FeedClipSerializer, which
# asks default_storage for a freshly signed URL per request instead.
```

**Key points:**
- No `static(settings.MEDIA_URL, ...)` route
- No local media serving in production
- All media URLs generated at serialization time via `media_urls.py`
- HLS: unsigned public URLs (`hls/` prefix)
- Uploads: signed URLs (`uploads/` prefix)

---

## Router Basenames

| ViewSet | basename | URL Pattern Prefix |
|---------|----------|-------------------|
| `FastFeedViewSet` | `feed` | `/feed/` |
| `AudioUploadViewSet` | `clips` | `/clips/` |
| `ClipInteractionViewSet` | `interactions` | `/interactions/` |
| `ShareViewSet` | `share` | `/share/` |
| `CommentViewSet` | `comments` | `/comments/` |
| `FollowViewSet` | `follow` | `/follow/` |
| `TagsViewSet` | `tags` | `/tags/` |
| `SuggestionViewSet` | `suggestions` | `/suggestions/` |
| `ProfileViewSet` | `profile` | `/profile/` |

**Reverse URL examples:**
```python
reverse('feed-list')           # /feed/
reverse('clips-list')          # /clips/
reverse('interactions-toggle-like', kwargs={'pk': clip_id})  # /interactions/{id}/toggle-like/
reverse('share-send-share', kwargs={'pk': clip_id})          # /share/{id}/send-share/
reverse('profile-me')          # /profile/me/
```

---

## JWT Authentication Flow

```
POST /auth/login/ {username, password}
    │
    ▼
TokenObtainPairView → {access, refresh, user}
    │
    ├── access: 15 min lifetime (SIMPLE_JWT)
    └── refresh: 7 day lifetime (SIMPLE_JWT)

POST /auth/token/refresh/ {refresh}
    │
    ▼
{access, refresh?}
```

**Frontend integration:** `frontend/sample_frontend/src/api/client.ts` handles auto-refresh on 401.

---

*Source: `backend/EchoFlow/urls.py`, `backend/app/urls.py`, `backend/EchoFlow/health.py`, `backend/app/views.py`*