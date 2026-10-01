#!/usr/bin/env bash
#
# Mobile dev supervisor — keeps the physical-device path alive.
#
# WHY THIS EXISTS
# The Expo development client is not a one-shot consumer of Metro. Every time
# the app returns to the foreground it calls
# BridgelessDevSupportManager.handleReloadJS() and re-fetches the JS bundle
# from Metro. A JS context that dies while backgrounded is therefore
# unrecoverable until Metro answers again — and the app cannot render its own
# error, because rendering the error IS the bundle it no longer has. Observed
# on 2026-10-01 as `DevLauncher: Unable to load script.` preceded by
# `reactInstance is null` on every foreground return.
#
# Two failure modes bit on that day, both SILENT on the host:
#
#   1. Metro and the HLS Worker are plain host processes. They die with the
#      session that started them. Nothing restarts them. The symptom is a
#      device-side error with no host-side counterpart — nginx still logs
#      502 for every manifest because its upstream is simply gone.
#
#   2. `adb reverse` rules are scoped to the ADB TRANSPORT, not the device.
#      A USB re-enumeration silently drops every rule. The device did not
#      reboot and the adb server did not restart in the observed case; the
#      rules were just gone on the next `adb reverse --list`.
#
# The app's DATA path (API + HLS) is on the LAN and survives both. Its CODE
# path does not. That asymmetry is why the failure looked like "it worked,
# then stopped".
#
# WHAT IT DOES, EVERY TICK
#   - re-asserts adb reverse for 8081 (Metro), 18443 (API), 19443 (media)
#   - starts Metro if 8081 is not answering
#   - starts the HLS Worker if /healthz is not answering
#   - re-logs the dev-client deep link whenever the LAN IP changes
#
# Metro is started with `--host lan` so it binds every interface. That makes
# the bundle reachable over the LAN as well as through adb reverse, so the
# code path no longer depends on the tunnel at all. The tunnel is still
# maintained as a fallback and is still REQUIRED for HLS, because
# PUBLIC_HLS_ENDPOINT_URL is 127.0.0.1 so that the web frontend's page origin
# and media origin share a host for the SameSite=Lax token cookie. Changing it
# to the LAN address would re-break web playback.
#
# USAGE
#   bash scripts/mobile-dev-supervisor.sh            # run the loop
#   bash scripts/mobile-dev-supervisor.sh --once     # one pass, then exit
#   bash scripts/mobile-dev-supervisor.sh --status   # report and exit
#
# Environment:
#   SUPERVISOR_INTERVAL          seconds between ticks (default 30)
#   SUPERVISOR_LOG               log file (default /tmp/mobile-dev-supervisor.log)
#   SUPERVISOR_START_COOLDOWN    minimum seconds between start attempts for the
#                                same service (default 180)
#   MOBILE_SUPERVISOR_PID        lock file; prevents a second instance

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${SUPERVISOR_INTERVAL:-30}"
LOG_FILE="${SUPERVISOR_LOG:-/tmp/mobile-dev-supervisor.log}"
PID_FILE="${MOBILE_SUPERVISOR_PID:-/tmp/mobile-dev-supervisor.pid}"
COOLDOWN="${SUPERVISOR_START_COOLDOWN:-180}"

# adb reverse ports. 8081 is the bundle, 18443 the API, 19443 the media edge.
# All three are needed: see the HLS note above for why 19443 is not optional.
REVERSE_PORTS=(8081 18443 19443)

METRO_PORT=8081
METRO_STATUS_URL="http://127.0.0.1:${METRO_PORT}/status"
WORKER_PORT=8787
WORKER_HEALTH_URL="http://127.0.0.1:${WORKER_PORT}/healthz"

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG_FILE"
}

# Echo the host's LAN address, skipping loopback and the Docker bridges.
# `hostname -I` lists docker bridges (172.17/18/28/29.0.1) alongside the real
# NIC, so filtering keeps the supervisor from advertising an unroutable
# address to the phone.
host_lan_ip() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' \
    | grep -vE '^(127\.|172\.(17|18|28|29)\.)' \
    | head -1
}

device_serial() {
  adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1; exit}'
}

# --- checks ---------------------------------------------------------------

# BOUND IS NOT HEALTHY. Three separate states, and conflating them is what made
# the first version of this supervisor worse than no supervisor:
#
#   1. Bound + answering   -> healthy, leave alone.
#   2. Not bound           -> dead, start it.
#   3. Bound + silent      -> HUNG. Observed as a killed workerd whose wrangler
#                             parent respawned a child that completed the TCP
#                             handshake and then never answered HTTP: curl timed
#                             out after 6s with 0 bytes. Treating "bound" as
#                             "healthy" left audio broken with a green light;
#                             treating "not answering" as "not running" started a
#                             duplicate that lost the port race and died with
#                             "Address already in use", once per tick.
#
# State 3 is the one that must be killed and restarted, not duplicated.
port_bound() {
  ss -ltn 2>/dev/null | grep -q ":$1 "
}

metro_is_healthy() {
  curl -fsS -m 5 "$METRO_STATUS_URL" 2>/dev/null | grep -q 'packager-status:running'
}

worker_is_healthy() {
  curl -fsS -m 5 "$WORKER_HEALTH_URL" >/dev/null 2>&1
}

port_owner_pid() {
  ss -ltnp "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

# Every descendant of a pid, children emitted before their parent.
descendants_of() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    descendants_of "$child"
    printf '%s ' "$child"
  done
}

# Kill everything holding a port, including the whole process group.
#
# Killing only the top ancestor is NOT sufficient, and this was measured rather
# than assumed: `npm exec wrangler` was SIGKILLed, but its `node` and `workerd`
# children were re-parented to init and SURVIVED, one of them still holding
# 8787. Every replacement then died with "Address already in use", so the
# supervisor spun once per tick for four minutes while the port stayed occupied.
# Killing only the port's immediate listener is worse still, because wrangler
# respawns that child and wins the bind again.
#
# So: signal the process group (every service here is started with setsid, so
# it has its own group and this reaches all descendants), then explicitly sweep
# any descendant left behind, then escalate to SIGKILL if the port is still held.
kill_port_tree() {
  local port="$1" pid pgid my_pgid kids i
  pid="$(port_owner_pid "$port")"
  [[ -z "$pid" ]] && return 1

  my_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"

  # Never signal the process group this supervisor itself runs in.
  if [[ -n "$pgid" && "$pgid" != "$my_pgid" ]]; then
    log "ACTION killing hung process group ${pgid} for port ${port} (owner pid ${pid})"
    kill -TERM "-${pgid}" 2>/dev/null
  fi

  kids="$(descendants_of "$pid" | tr ' ' '\n' | grep -v '^$' | tac)"
  if [[ -n "$kids" ]]; then
    while read -r kid; do
      [[ -n "$kid" ]] && kill -TERM "$kid" 2>/dev/null
    done <<<"$kids"
  fi
  kill -TERM "$pid" 2>/dev/null

  for i in $(seq 1 12); do
    port_bound "$port" || return 0
    sleep 0.5
  done

  log "WARN port ${port} still bound after SIGTERM; escalating to SIGKILL"
  if [[ -n "$pgid" && "$pgid" != "$my_pgid" ]]; then
    kill -KILL "-${pgid}" 2>/dev/null
  fi
  while read -r kid; do
    [[ -n "$kid" ]] && kill -KILL "$kid" 2>/dev/null
  done <<<"$kids"
  kill -KILL "$pid" 2>/dev/null
  sleep 1
}

# At most one start attempt per service per cooldown window. Without this a
# service that cannot start produces one doomed attempt every tick.
start_attempt_allowed() {
  local file="/tmp/mobile-dev-supervisor.attempt.$1" last now
  now="$(date +%s)"
  last="$(stat -c %Y "$file" 2>/dev/null || echo 0)"
  if (( now - last < COOLDOWN )); then
    return 1
  fi
  : >"$file"
  return 0
}

# Count of the three forward rules actually present. Used for change detection
# so the log stays readable: a stable healthy stack writes one line per tick,
# not three.
reverse_rule_count() {
  local serial="$1" n=0 port
  for port in "${REVERSE_PORTS[@]}"; do
    if adb -s "$serial" reverse --list 2>/dev/null | grep -q "tcp:${port} "; then
      n=$((n + 1))
    fi
  done
  printf '%s' "$n"
}

# --- actions --------------------------------------------------------------

ensure_reverse() {
  local serial="$1" port
  for port in "${REVERSE_PORTS[@]}"; do
    adb -s "$serial" reverse "tcp:${port}" "tcp:${port}" >/dev/null 2>&1
  done
}

start_metro() {
  local ip="$1"
  # --host lan binds every interface, so the bundle is reachable over the LAN
  # even with no adb reverse at all. Setsid + nohup so the bundler outlives the
  # shell that starts it; without setsid it dies with the launching terminal,
  # which is exactly failure mode 1 above.
  mkdir -p "$REPO_ROOT/mobile"
  (
    cd "$REPO_ROOT/mobile" || exit 1
    setsid nohup npx expo start --dev-client --host lan \
      >/tmp/metro.log 2>&1 </dev/null &
  )
  log "ACTION started Metro (--host lan) -> metro.log; device URL http://${ip}:${METRO_PORT}"
}

start_worker() {
  # Reuses the shared run script so .dev.vars is regenerated from .env.local on
  # every start and the token secret cannot drift from Django's.
  (
    cd "$REPO_ROOT" || exit 1
    setsid nohup bash scripts/run-hls-worker-local.sh \
      >/tmp/hls-worker.log 2>&1 </dev/null &
  )
  log "ACTION started HLS Worker -> hls-worker.log"
}

# Reconcile one service against the three states described above.
#   ensure_service <name> <port> <health_fn> <start_fn> [start_fn_arg]
ensure_service() {
  local name="$1" port="$2" health_fn="$3" start_fn="$4" start_arg="${5:-}"

  "$health_fn" && return 0

  if port_bound "$port"; then
    # Bound but silent: hung. The owning process must go, or it respawns into
    # the port and the replacement loses the bind.
    if ! start_attempt_allowed "$name"; then
      log "WARN ${name} bound on ${port} but not answering; start suppressed by cooldown"
      return 1
    fi
    kill_port_tree "$port"
  else
    if ! start_attempt_allowed "$name"; then
      log "WARN ${name} not listening on ${port}; start suppressed by cooldown"
      return 1
    fi
    log "ACTION ${name} not listening on ${port}; starting it"
  fi

  "$start_fn" "$start_arg"
}

# --- one pass -------------------------------------------------------------

tick() {
  local serial ip rules

  serial="$(device_serial)"
  if [[ -z "$serial" ]]; then
    log "WARN no adb device in 'device' state; skipping tick"
    return 1
  fi

  ip="$(host_lan_ip)"
  if [[ -z "$ip" ]]; then
    log "WARN could not determine a host LAN IP; skipping tick"
    return 1
  fi

  rules="$(reverse_rule_count "$serial")"
  if [[ "$rules" -lt ${#REVERSE_PORTS[@]} ]]; then
    log "ACTION adb reverse was ${rules}/${#REVERSE_PORTS[@]}, re-asserting (transport reset drops these)"
    ensure_reverse "$serial"
  fi

  # Metro first: it is the only dependency whose loss kills the whole app,
  # because the app cannot render an error without a bundle.
  ensure_service "Metro" "$METRO_PORT" metro_is_healthy start_metro "$ip"
  ensure_service "HLS Worker" "$WORKER_PORT" worker_is_healthy start_worker

  # Re-log the deep link only when the LAN IP moves, since the phone caches the
  # URL it was last opened with and a stale one cannot be recovered in-app.
  local stamp_file=/tmp/mobile-dev-supervisor.ip
  if [[ ! -f "$stamp_file" || "$(cat "$stamp_file" 2>/dev/null)" != "$ip" ]]; then
    printf '%s' "$ip" >"$stamp_file"
    log "INFO dev-client deep link for this host IP:"
    log "     adb shell am start -a android.intent.action.VIEW \\"
    log "       -d 'exp+echoflow-mobile://expo-development-client/?url=http%3A%2F%2F${ip}%3A${METRO_PORT}'"
  fi
}

status() {
  local serial ip rules
  serial="$(device_serial)"
  ip="$(host_lan_ip)"
  printf 'device        : %s\n' "${serial:-<none>}"
  printf 'host LAN ip   : %s\n' "${ip:-<none>}"
  rules=0
  [[ -n "$serial" ]] && rules="$(reverse_rule_count "$serial")"
  printf 'adb reverse   : %s/%s\n' "$rules" "${#REVERSE_PORTS[@]}"
  if metro_is_healthy; then
    printf 'metro         : healthy (%s, also http://%s:%s)\n' \
      "$METRO_STATUS_URL" "$ip" "$METRO_PORT"
  elif port_bound "$METRO_PORT"; then
    printf 'metro         : BOUND BUT HUNG on %s\n' "$METRO_PORT"
  else
    printf 'metro         : DOWN\n'
  fi
  if worker_is_healthy; then
    printf 'hls worker    : healthy (%s)\n' "$WORKER_HEALTH_URL"
  elif port_bound "$WORKER_PORT"; then
    printf 'hls worker    : BOUND BUT HUNG on %s\n' "$WORKER_PORT"
  else
    printf 'hls worker    : DOWN\n'
  fi
  printf 'log           : %s\n' "$LOG_FILE"
}

main() {
  case "${1:-}" in
    --once)
      tick
      log "INFO single tick complete"
      exit 0
      ;;
    --status)
      status
      exit 0
      ;;
    ""|--loop) ;;
    *)
      echo "usage: $0 [--once|--status]" >&2
      exit 2
      ;;
  esac

  # Refuse to run twice: two supervisors would fight over Metro and the
  # adb rules, which is its own class of silent breakage.
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "already running (pid $(cat "$PID_FILE")); see --status" >&2
    exit 1
  fi
  printf '%s' "$$" >"$PID_FILE"
  trap 'rm -f "$PID_FILE"' EXIT

  log "INFO supervisor starting (pid $$, interval ${INTERVAL}s)"
  while true; do
    tick || true
    sleep "$INTERVAL"
  done
}

main "$@"