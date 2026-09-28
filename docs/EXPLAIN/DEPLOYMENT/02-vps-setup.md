# VPS Setup Guide

This document explains how to set up the VPS half of the hybrid deployment.

> **Update (this revision):** Sections 5, 5a, and 5b below have been
> corrected or added based on a real production incident where the
> documented Tailscale command left the laptop unable to reach the VPS
> Docker network over TCP, and a firewall rule was found blocking that
> traffic even after Tailscale itself was working correctly. If you set
> this up before this revision, re-read Steps 5, 5a, and 5b even if your
> deployment is "already working" — `ping` and `tailscale ping` succeeding
> does **not** mean TCP to the database/Redis actually works.

## Prerequisites

1. **VPS instance** — Hetzner CX22 (2 vCPU, 4 GB RAM, 20 GB NVMe) or Oracle A1
   (4 x ARM AMP, 24 GB RAM, $0/mo). This guide assumes 4 GB RAM.
2. **Docker + Compose V2** — `docker compose` (not `docker-compose`).
3. **Cloudflare account** — with `echo-flow.in` domain pointed via Cloudflare
   nameservers.
4. **cloudflared** — installed separately on the VPS for the tunnel.
5. **Tailscale** — installed separately for subnet router.

## Step 1: Cloudflare R2 Bucket Setup

1. In the Cloudflare dashboard, go to **R2** → **Create bucket**.
2. Name: `echoflow-media`
3. Create an **API token** with `Object Read & Write` permissions scoped
    to this bucket.
4. R2 bucket starts fully private by default. Do **not** add a public-read
    policy for `hls/*` — HLS token protection is handled by the Cloudflare
    Worker (see `docs/EXPLAIN/storage/04-hls-token-protection.md`,
    "Option A — Cloudflare Worker").

## Step 2: Cloudflare Tunnel Setup

1. In the Cloudflare dashboard, go to **Tunnels** → **Create tunnel**.
2. Name it `echoflow-vps`.
3. Download the credentials file JSON and save it on the VPS at:
   `/etc/cloudflared/<tunnel-uuid>.json`
4. Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: api.echo-flow.in
    service: http://localhost:80
  - service: http_status:404
```

5. Start the tunnel:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml run
```

6. In the Cloudflare dashboard, add a public hostname `api.echo-flow.in`
   pointing to the tunnel.

## Step 3: Cloudflare Custom Domain for HLS

1. In the **R2** bucket settings, go to **Custom Domains**.
2. Add `media.echo-flow.in` as a custom domain.
3. Cloudflare will provision TLS automatically (Universal SSL).
4. **HLS playback** is now served directly from R2 via
   `https://media.echo-flow.in/hls/{clip_id}/master.m3u8` — no VPS hop.

## Step 4: Deploy on VPS

```bash
# Clone and checkout
git clone https://github.com/your-org/echoflow.git
cd echoflow
git checkout feat/hybrid-vps

# Create .env from template
cp .env.vps.example .env
# EDIT .env with real values:
#   - DJANGO_SECRET_KEY (generate with python -c "...")
#   - DB_PASSWORD
#   - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (R2 credentials)
#   - AWS_S3_ENDPOINT_URL (your R2 endpoint)
#   - FIELD_ENCRYPTION_KEY (generate with python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

# One-shot deploy
bash scripts/vps-deploy.sh
```

The deploy script:
1. Validates pre-flight checks
2. Runs `docker compose -f docker-compose.vps.yml up -d --build`
3. Creates the `vector` extension on the `db` service
4. Runs Django migrations
5. Collects static files
6. Sets up Tailscale subnet router (`--advertise-routes=172.28.0.0/16`)
7. Installs a daily pg_dump backup cron job (uploads to R2)

> **Check what your deploy script actually passed to `tailscale up`.**
> If `scripts/vps-deploy.sh` ran the bare `--advertise-routes` flag with no
> `--accept-routes`, that is very likely fine for the VPS itself (it doesn't
> need to accept anyone else's routes), but confirm against Step 5 below,
> which is the corrected, verified sequence.

## Step 5: Tailscale Subnet Router (corrected)

**IP forwarding must be enabled before advertising routes**, or the route
will silently fail to carry traffic even though Tailscale reports it as
advertised. This was previously omitted from this guide and caused a real
outage. Do this first:

```bash
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf
```

Both the IPv4 and IPv6 lines matter. In one incident, IPv4 forwarding was
already on (common default) but IPv6 forwarding was off, and that alone
was enough to break the setup partway through debugging — don't assume
IPv4 forwarding being correct means IPv6 is too; check both explicitly:

```bash
cat /proc/sys/net/ipv4/ip_forward           # should print 1
cat /proc/sys/net/ipv6/conf/all/forwarding   # should print 1
```

Install Tailscale and bring it up:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-routes=172.28.0.0/16 --accept-routes
```

**Do not re-run this with `--reset` once the route below has been approved.**
`tailscale up --reset` clears previously-granted admin console route
approvals. If you need to change flags later, re-run `tailscale up` with
the full set of desired flags but without `--reset` — Tailscale will only
complain if you're trying to change something implicitly, and the CLI will
tell you exactly what to add if that happens.

In the Tailscale admin console (`https://login.tailscale.com/admin/machines`),
find this VPS's entry, open its **Subnets** section, and approve
`172.28.0.0/16`. This step has no CLI equivalent — it must be done in the
web console. Until this is approved, other Tailscale devices will not
receive this route even if the VPS is advertising it correctly.

**Result:** The VPS Docker network (172.28.0.0/16) becomes reachable from
any Tailscale client, including the laptop media worker — *once Step 5a
below is also done.*

| VPS Container | Fixed IP | Purpose |
|---------------|----------|---------|
| `redis_broker` | 172.28.0.2 | Celery broker |
| `redis_cache` | 172.28.0.3 | Django cache |
| `db` | 172.28.0.4 | PostgreSQL |
| `web` | 172.28.0.10 | Django/gunicorn |
| `celery` | 172.28.0.11 | Default queue |
| `celery_feed` | 172.28.0.12 | Feed queue |
| `celery_beat` | 172.28.0.13 | Scheduler |

## Step 5a: Firewall rule required for the subnet route to actually pass TCP (new)

This step did not exist in earlier revisions of this guide and is the
direct result of a real incident: Tailscale reported the route as
advertised and approved, `ping` across the tunnel worked, and
`tailscale ping` worked — but every TCP connection from the laptop to
`172.28.0.4:5432` or `172.28.0.2:6379` timed out. ICMP and Tailscale's own
ping protocol take a different code path than a real TCP SYN, so this
class of failure does not show up in the basic connectivity checks in
Step 6.

The root cause: on some Docker + nftables setups, a rule exists in
`table ip raw`, chain `PREROUTING`, that drops any packet addressed to a
container's fixed IP if that packet did not arrive via the Docker bridge
interface. This silently discards subnet-router traffic arriving over
`tailscale0`, because from the kernel's point of view that traffic is
coming in on the wrong interface, even though it's completely legitimate.

Check whether this applies to you:

```bash
sudo nft list ruleset | grep -A 12 'table ip raw'
```

If you see lines like `ip daddr 172.28.0.4 iifname != "br-..." drop`, this
is your problem. Fix it by adding an explicit accept for Tailscale traffic
**before** those drop rules, scoped to your laptop's specific Tailscale IP
rather than the whole interface (see the security note below for why this
distinction matters):

```bash
# Get your laptop's Tailscale IP first (run this ON the laptop):
#   tailscale status
# Then, ON THE VPS, insert the scoped accept rule:
sudo nft insert rule ip raw PREROUTING ip saddr <laptop-tailscale-ip> iifname "tailscale0" accept
```

**Do not use a bare `iifname "tailscale0" accept` with no `ip saddr`
scoping.** That accepts traffic from *every* device on your tailnet, not
just the laptop that's supposed to be talking to this subnet — including
any other machine you've ever added to the same Tailscale account. Scope
it to the specific peer that needs access.

This rule is **not persistent across reboots** by default. Depending on
what generated the original drop rules on your box (Docker's own
integration, or UFW's Docker fix, or something else), you'll need to
either add this to `/etc/nftables.conf` if `nftables.service` is enabled,
or create a small systemd oneshot unit that reapplies it after
`docker.service` starts. Verify which applies to your VPS:

```bash
systemctl status nftables 2>/dev/null
```

If that returns "not found" or inactive, use a systemd unit instead:

```ini
# /etc/systemd/system/echoflow-nft-rules.service
[Unit]
Description=Re-apply EchoFlow subnet-router firewall exception
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/echoflow-nft-rules.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

with the `nft insert rule` command from above in
`/usr/local/bin/echoflow-nft-rules.sh` (`chmod +x` it), then
`systemctl daemon-reload && systemctl enable --now echoflow-nft-rules.service`.

## Step 5b: Redis requires a password before this is exposed to the tailnet (new)

By default, `redis_broker` and `redis_cache` in `docker-compose.vps.yml` run
with no `requirepass` set. This is fine as long as nothing outside the
Docker bridge can reach them — but Step 5a, by design, opens a path from
the Tailscale tunnel to these containers. Once that path exists, an
unauthenticated Redis instance means **any device that can reach the
subnet route has unauthenticated read/write access to your task queue and
cache.** Scoping the `nft` rule in 5a to a single laptop IP limits this to
that one device, but that device should still not have blanket
unauthenticated access to Redis as a matter of defense in depth — a
misconfigured or compromised laptop shouldn't mean a compromised broker.

Set a password on both:

1. Generate two passwords:
   ```bash
   openssl rand -base64 32   # for redis_broker
   openssl rand -base64 32   # for redis_cache
   ```
2. In `docker-compose.vps.yml`, add `--requirepass` to each service's
   `command:`:
   ```yaml
   redis_broker:
     command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction --requirepass ${REDIS_BROKER_PASSWORD}
   redis_cache:
     command: redis-server --appendonly yes --maxmemory 1gb --maxmemory-policy allkeys-lru --requirepass ${REDIS_CACHE_PASSWORD}
   ```
3. Add both passwords to `.env` on the VPS:
   ```
   REDIS_BROKER_PASSWORD=<generated password>
   REDIS_CACHE_PASSWORD=<generated password>
   ```
4. Update `REDIS_BROKER_URL` and `REDIS_CACHE_URL` in `.env` (VPS **and**
   laptop — they must match) to the authenticated form:
   ```
   REDIS_BROKER_URL=redis://:<broker-password>@172.28.0.2:6379/0
   REDIS_CACHE_URL=redis://:<cache-password>@172.28.0.3:6379/0
   ```
5. Recreate the containers so the new command line takes effect:
   ```bash
   docker compose -f docker-compose.vps.yml up -d
   ```
6. Verify auth is actually required:
   ```bash
   docker exec echoflow_redis_broker redis-cli ping
   # expect: (error) NOAUTH Authentication required.
   docker exec echoflow_redis_broker redis-cli -a '<broker-password>' ping
   # expect: PONG
   ```

Postgres (`db`) does **not** need an equivalent fix — it already enforces
`scram-sha-256` authentication regardless of which network path a
connection arrives from, so a bare TCP path to `172.28.0.4:5432` still
requires valid database credentials.

## Step 6: Verify

```bash
# API health
curl -I https://api.echo-flow.in/health/

# Media worker heartbeat (should return false until laptop worker starts)
curl https://api.echo-flow.in/api/v1/health/media-worker/

# Django admin (create superuser first)
open https://api.echo-flow.in/admin/
```

**Also verify actual TCP reachability from the laptop, not just ICMP.**
`ping` and `tailscale ping` succeeding is not sufficient evidence that the
setup works — see Step 5a for why. From the laptop:

```bash
nc -zv -w3 172.28.0.4 5432   # Postgres
nc -zv -w3 172.28.0.2 6379   # Redis broker
```

Both should report "succeeded." If either times out despite Tailscale
itself looking healthy, go back to Step 5a.

## Resource Usage at 50 Users

| Component | Estimated RAM |
|-----------|--------------|
| PostgreSQL + pgvector | ~200 MB |
| Redis broker (512 MB maxmemory) | ~512 MB |
| Redis cache (1 GB maxmemory) | ~1 GB |
| Gunicorn (2 workers × 4 threads) | ~400 MB |
| Celery default worker | ~300 MB |
| Celery feed worker (concurrency=4) | ~300 MB |
| Celery Beat | ~100 MB |
| nginx | ~30 MB |
| **Total** | **~2.9 GB** |

A 4 GB VPS has ~1 GB headroom for Docker overhead, kernel buffers, and
burstable spikes.
