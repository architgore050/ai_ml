# Laptop Media Worker Setup Guide

This document explains how to set up the laptop half of the hybrid deployment.

> **Update (this revision):** the Troubleshooting section below has a new
> entry — "Worker connects to nothing, but ping/tailscale ping work fine" —
> covering a failure mode that isn't a Redis or Tailscale problem in the
> usual sense, and won't be fixed by anything in this file alone. Read it
> before assuming your VPS-side setup is broken if you hit this.

## Prerequisites

1. **Laptop** with Docker installed
2. **8+ GB RAM** (required for Whisper + SentenceTransformer + KeyBERT)
3. **Tailscale** installed on both laptop and VPS
4. **Stable internet connection** (for Tailscale tunnel to VPS)
5. **HuggingFace API token** (`HF_TOKEN`) — for building the media Docker image

## Step 1: Install Tailscale on Laptop

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --accept-routes
```

Both the laptop and VPS must be on the same Tailscale tailnet. The VPS
must advertise the `172.28.0.0/16` subnet (see VPS setup guide), and you
must approve it in the Tailscale admin console.

**On Linux, `--accept-routes` is required and does not default to on.**
Without it, the laptop will see the VPS as reachable but will never
receive the `172.28.0.0/16` route into its own routing table, and every
connection to a VPS container IP will fail immediately rather than time
out. If you already ran `tailscale up` without this flag, re-run:

```bash
sudo tailscale up --accept-routes
```

You do not need `--reset` for this — adding a flag that wasn't previously
set doesn't require it, and using `--reset` unnecessarily on the VPS side
has caused route-approval issues in this project before (see VPS setup
guide, Step 5). The same caution is worth extending to the laptop even
though the laptop isn't the one advertising routes.

**Also enable IP forwarding on the laptop**, even though the laptop is not
acting as a subnet router itself. This was found to matter in practice
during setup, not just as a theoretical precaution:

```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale-subnet.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale-subnet.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale-subnet.conf
```

Confirm both took effect:

```bash
cat /proc/sys/net/ipv4/ip_forward
cat /proc/sys/net/ipv6/conf/all/forwarding
```

Both should print `1`.

## Step 1a: Verify actual TCP reachability before building anything (new)

Don't skip straight to building the media image. Confirm the network path
works first — the media image build is slow (Whisper + SentenceTransformer
+ KeyBERT baked in), and discovering a network problem after a 20+ minute
build wastes time you don't need to lose.

Run this sequence, in this order, and don't stop at the first success —
each check exercises a different layer, and earlier ones passing does not
guarantee later ones will:

```bash
# 1. Basic Tailscale reachability to the VPS's Tailscale IP
ping -c 2 <vps-tailscale-ip>

# 2. tailscaled-to-tailscaled reachability (confirms the daemons can talk)
tailscale ping <vps-tailscale-ip>

# 3. WireGuard-level reachability to the container itself, not just the VPS host
tailscale ping --tsmp 172.28.0.4

# 4. Actual TCP, which is what the worker will really do
nc -zv -w3 172.28.0.4 5432
nc -zv -w3 172.28.0.2 6379
```

If steps 1–3 succeed but step 4 times out, this is **not** a Tailscale
configuration problem on the laptop side — it's almost certainly the
firewall issue described in the VPS setup guide, Step 5a. Go fix it there;
nothing on the laptop side will resolve it.

## Step 2: Build the Media Image

The `media` Docker image bakes in HuggingFace models at build time (Whisper,
SentenceTransformer, KeyBERT). The `HF_TOKEN` is passed via BuildKit secret —
it never appears in the image layers.

```bash
git clone https://github.com/your-org/echoflow.git
cd echoflow
git checkout feat/hybrid-laptop
cp .env.laptop.example .env
# EDIT .env with real values:
#   - DJANGO_SECRET_KEY = same as VPS (must match!)
#   - DB_PASSWORD = same as VPS
#   - AWS_ACCESS_KEY_ID / SECRET = R2 credentials
#   - AWS_S3_ENDPOINT_URL = your R2 endpoint
#   - HF_TOKEN = your HuggingFace token
#   - FIELD_ENCRYPTION_KEY = same as VPS (must match!)
#   - REDIS_BROKER_URL / REDIS_CACHE_URL — see note below

# Build the media image with the HuggingFace token as a build secret
export HF_TOKEN=hf_your_token_here
docker build --target media -t echoflow-media:local --secret id=hf_token,env=HF_TOKEN .
```

**Double-check `REDIS_BROKER_URL` and `REDIS_CACHE_URL` against the fixed
IP table in the VPS setup guide before building.** A misconfigured URL
here (for example, pointing `REDIS_BROKER_URL` at the database's IP
instead of the broker's) will not fail at build time — it only surfaces
later as a connection timeout once the worker actually tries to connect,
which is harder to diagnose after the fact than catching it now:

```
REDIS_BROKER_URL=redis://172.28.0.2:6379/0    # NOT 172.28.0.4 — that's the DB
REDIS_CACHE_URL=redis://172.28.0.3:6379/0
```

If the VPS has been set up with Redis authentication per the VPS guide's
Step 5b, both URLs need the password embedded:

```
REDIS_BROKER_URL=redis://:<broker-password>@172.28.0.2:6379/0
REDIS_CACHE_URL=redis://:<cache-password>@172.28.0.3:6379/0
```

These passwords must be **identical** to whatever was generated on the VPS
side — this is shared infrastructure, not a laptop-local secret.

## Step 3: Start the Media Worker

```bash
bash scripts/laptop-deploy.sh
```

The script:
1. Validates `HF_TOKEN` is set
2. Checks Tailscale connectivity to VPS services
3. Builds the media image (if not already built)
4. Starts `celery_media` worker via `docker compose -f docker-compose.laptop.yml up -d`
5. Starts the heartbeat script in the background

The `celery_media` worker:
- Connects to the VPS Redis broker (`172.28.0.2:6379`) via Tailscale
- Connects to the VPS PostgreSQL (`172.28.0.4:5432`) via Tailscale
- Downloads original uploads from R2
- Runs Whisper transcription, acoustic/semantic vector extraction, KeyBERT tagging
- Encodes HLS segments and uploads to R2 `hls/{clip_id}/` prefix
- Updates `AudioClip` rows with HLS URL and status

## Step 4: Verify

```bash
# Check worker logs
docker compose -f docker-compose.laptop.yml logs -f celery_media

# Check heartbeat (should return {"media_worker_alive": true})
curl https://api.echo-flow.in/api/v1/health/media-worker/

# Upload a clip on the VPS, approve moderation, and watch the laptop process it
```

## Heartbeat Mechanism

The heartbeat is a simple background script that writes to the broker Redis:

```bash
nohup bash scripts/laptop-heartbeat.sh > /tmp/heartbeat.log 2>&1 &
```

Every 30 seconds, it writes:
```
SET media_worker:alive <unix_timestamp> EX 60
```

The API endpoint `GET /api/v1/health/media-worker/` reads this key:
- **Key exists** → `{"media_worker_alive": true}` (200)
- **Key missing** → `{"media_worker_alive": false}` (200)
- **Redis unreachable** → `{"media_worker_alive": false}` (503)

If the script stops (laptop asleep, Tailscale disconnects), the key expires
after 60 seconds and the API correctly reports the worker as offline.

## Resource Usage

| Component | Estimated RAM |
|-----------|--------------|
| Whisper model (baked in image) | ~1.5 GB |
| SentenceTransformer model | ~500 MB |
| KeyBERT + librosa + Python runtime | ~200 MB |
| ffmpeg + audio scratch space | ~500 MB |
| Docker overhead | ~300 MB |
| **Total** | **~2.5-3 GB resident** |

The compose file limits `celery_media` to 4 GB with `--pool=prefork
--concurrency=2`. This means at most 2 clips are processed simultaneously,
each using ~2 GB.

## Troubleshooting

### Worker can't connect to Redis

```
ConnectionRefusedError: [Errno 111] Connection refused
```

**Fix:** Verify Tailscale is running and the VPS subnet is approved:
```bash
tailscale ip  # Show your Tailscale IP
ping 172.28.0.2  # Test connectivity to VPS Redis
```

Note this specific error (`Connection refused`) is different from a
timeout. Refused means a packet reached something that actively rejected
the connection — usually the route isn't approved yet, or the wrong IP
is configured. A timeout (no error, just hanging) is the different failure
mode covered in the new entry immediately below.

### Worker connects to nothing, but ping/tailscale ping work fine (new)

```
Attempt 1/120 failed: connection to server at "172.28.0.4", port 5432 failed: Connection timed out
```

...repeating for many attempts, while `ping <vps-ip>` and
`tailscale ping <vps-ip>` both succeed without issue.

**This is not a Tailscale problem, despite appearances.** ICMP ping and
Tailscale's own ping protocol both take a different path through the
tunnel than a real TCP connection does, and a specific firewall
misconfiguration on the VPS can allow the former while silently dropping
the latter. See the VPS setup guide, Step 5a, for the exact cause (an
`nftables` rule in `table ip raw` dropping packets to container IPs that
don't arrive via the Docker bridge) and the fix. There is nothing to
change on the laptop side for this failure mode — confirm with Step 1a's
four-step check above, and if steps 1–3 pass while step 4 fails, this is
where you're at.

### R2 upload fails

```
botocore.exceptions.EndpointConnectionError
```

**Fix:** Check `AWS_S3_ENDPOINT_URL` in `.env`. It must be the full R2 URL:
`https://<accountid>.r2.cloudflarestorage.com`

### Models not found

```
OSError: Fetched 1 files but failed to do so
```

**Fix:** The media image was built without `HF_TOKEN`, so models weren't
baked in. Rebuild with the secret:
```bash
export HF_TOKEN=hf_your_token_here
docker build --target media -t echoflow-media:local --secret id=hf_token,env=HF_TOKEN .
```
