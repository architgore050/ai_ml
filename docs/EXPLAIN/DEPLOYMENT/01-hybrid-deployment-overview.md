# Hybrid Deployment Overview

## What Is It?

The **hybrid deployment** splits EchoFlow across two machines to reduce hosting
costs while preserving full functionality:

| Machine | Role | Services | Monthly Cost |
|--------|------|----------|-------------|
| **VPS** (Hetzner CX22 / Oracle A1) | Light services | db, redis_broker, redis_cache, web, celery, celery_feed, celery_beat, nginx | ~$6 (Hetzner) or $0 (Oracle A1) |
| **Laptop** | Heavy media worker | celery_media | $0 (your existing machine) |
| **Cloudflare** | Edge services | R2 (object storage), Tunnel (API ingress), Pages (frontend) | Free tier |

### Why Split?

The `celery_media` worker runs Whisper (1.5 GB), SentenceTransformer (0.5 GB),
KeyBERT (100 MB), and ffmpeg — totaling **4+ GB RAM** for concurrent processing.
A 4 GB VPS cannot handle this load, but a laptop with 8+ GB RAM can.

By keeping all other services on the VPS and only pushing the heavy media
worker to the laptop, we get a **$6/month production-grade deployment** (or
$0 with Oracle Always Free) instead of requiring a larger VPS.

## Architecture Diagram

```
Browser (app.echoflow.in)
  │
  ▼
Cloudflare (TLS termination, Bot Fight Mode)
  │
  │ GET/POST api.echoflow.in
  ▼
Cloudflare Tunnel → VPS cloudflared → nginx (:443) → gunicorn → Django
  │
  │ GET media.echoflow.in/hls/{clip_id}/master.m3u8
  ▼
Cloudflare Custom Domain → R2 (direct, no VPS hop)
  │
  │ Celery task on heavy_media queue
  ▼
VPS Redis (broker: 172.28.0.2) ─Tailscale─ → Laptop docker0
  │                                                      │
  │                                                      ▼
  │                                           celery_media worker
  │                                           downloads from R2
  │                                           processes (Whisper + ST + KeyBERT)
  │                                           uploads HLS to R2 hls/ prefix
  │                                                      │
  │                                                      ▼
  └─ Postgres (db: 172.28.0.4) ← Tailscale ← updates AudioClip row
```

## Service Inventory

### VPS Services (`docker-compose.vps.yml`)

| Service | Image | Purpose | Fixed IP | Memory |
|---------|-------|---------|----------|--------|
| `db` | `pgvector/pgvector:pg16` | PostgreSQL 16 + pgvector | 172.28.0.4 | 2 GB |
| `redis_broker` | `redis:7-alpine` | Celery broker (noeviction) | 172.28.0.2 | 1 GB |
| `redis_cache` | `redis:7-alpine` | Django cache, feed lists (LRU) | 172.28.0.3 | 1 GB |
| `web` | `echoflow-api:latest` | Django + gunicorn | 172.28.0.10 | 1 GB |
| `celery` | `echoflow-api:latest` | Default queue worker | 172.28.0.11 | 1 GB |
| `celery_feed` | `echoflow-api:latest` | Feed refill worker | 172.28.0.12 | 1 GB |
| `celery_beat` | `echoflow-api:latest` | Periodic task scheduler | 172.28.0.13 | 256 MB |
| `nginx` | `nginx:1.27-alpine` | TLS terminator (:80, :443) | — | 128 MB |

**Removed from VPS:** `pgbouncer`, `minio`, `minio-init`, `celery_media`, `prometheus`, `grafana`.

### Laptop Services (`docker-compose.laptop.yml`)

| Service | Image | Purpose | Queue | Memory |
|---------|-------|---------|-------|--------|
| `celery_media` | `echoflow-media:local` | Media processing (Whisper + ST + KeyBERT) | `heavy_media` | 4 GB |

### Cloudflare Services

| Hostname | Product | Purpose |
|----------|---------|---------|
| `api.echoflow.in` | Cloudflare Tunnel | Routes to VPS nginx → gunicorn |
| `media.echoflow.in` | R2 Custom Domain | Direct HLS playback from R2 (no VPS hop) |
| `app.echoflow.in` | Cloudflare Pages | Static React frontend |

## What Was Removed and Why

| Removed | Reason | RAM Saved |
|---------|--------|-----------|
| `pgbouncer` | Direct DB at 50 users is fine | ~256 MB |
| `minio` | R2 replaces it (zero egress, S3-compatible) | 0 |
| `celery_media` | Moved to laptop | 0 (runs on laptop RAM) |
| `prometheus` | Out of scope for 50-user/$6 budget | ~512 MB |
| `grafana` | Out of scope for 50-user/$6 budget | ~512 MB |
| **Total** | | **~1.3 GB + redis_cache 3→1 GB = ~2.3 GB total** |

## File Reference

| File | Branch | Purpose |
|------|--------|---------|
| `docker-compose.vps.yml` | `feat/hybrid-vps` | VPS slim compose (8 services) |
| `.env.vps.example` | `feat/hybrid-vps` | VPS production env template |
| `scripts/vps-deploy.sh` | `feat/hybrid-vps` | One-shot VPS deploy script |
| `docker-compose.laptop.yml` | `feat/hybrid-laptop` | Laptop media worker compose |
| `.env.laptop.example` | `feat/hybrid-laptop` | Laptop env template |
| `scripts/laptop-deploy.sh` | `feat/hybrid-laptop` | One-shot laptop deploy script |
| `scripts/laptop-heartbeat.sh` | `feat/hybrid-laptop` | Background heartbeat to Redis |
| `backend/app/views/system_health.py` | `feat/hybrid-vps` | Media worker health endpoint |
| `backend/EchoFlow/urls.py` | `feat/hybrid-vps` | +1 line: URL route for heartbeat |
| `backend/app/tests/test_system_health.py` | `feat/hybrid-vps` | 4 tests for heartbeat endpoint |

See also: `docs/deployment_v1_full_plan.md` for the complete implementation plan.
