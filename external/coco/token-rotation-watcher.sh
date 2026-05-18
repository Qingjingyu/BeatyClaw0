#!/usr/bin/env bash
# token-rotation-watcher.sh — Lightweight daemon that watches for 429 rate limit
# errors and triggers automatic token rotation.
#
# Monitors PM2 error logs and journald for HTTP 429 / rate-limit patterns.
# On detection, rotates to the next token and restarts the agent process.
#
# Uses byte-offset cursors per log file so old 429 entries are never re-scanned.
# Runs as a long-lived systemd service.

set -euo pipefail

TOKEN_DIR="${HOME}/.coco"
MULTI_TOKEN_FILE="${TOKEN_DIR}/provider-access-tokens.json"
STATE_FILE="${TOKEN_DIR}/.token-rotation-state"
CURSOR_DIR="${TOKEN_DIR}/.rotation-cursors"
ENV_FILE="${HOME}/.coco-runtime-env"
LOG_PREFIX="[token-rotation-watcher]"

# Cooldown: minimum seconds between rotations (prevents storm when all tokens are exhausted)
ROTATION_COOLDOWN_SECS="${TOKEN_ROTATION_COOLDOWN_SECS:-120}"

log() { echo "${LOG_PREFIX} $(date -u +%H:%M:%S) $*"; }

# --- Pre-flight checks ---
if [[ ! -f "${ENV_FILE}" ]]; then
  log "Runtime env file missing — exiting"
  exit 0
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

SYNC_ENABLED="${PROVIDER_TOKEN_SYNC_ENABLED:-}"
if [[ "${SYNC_ENABLED}" != "1" ]]; then
  if [[ ! -f "${MULTI_TOKEN_FILE}" ]]; then
    log "Provider token sync disabled and no multi-token file — exiting"
    exit 0
  fi
fi

AGENT_TYPE="${AGENT_TYPE:-}"
if [[ -z "${AGENT_TYPE}" ]]; then
  log "AGENT_TYPE not set — exiting"
  exit 0
fi

# Ensure cursor directory is writable. If ~/.coco has bad ownership/permissions
# on existing VMs, fall back to /tmp to avoid a startup crash loop.
if ! mkdir -p "${CURSOR_DIR}" 2>/dev/null; then
  FALLBACK_CURSOR_DIR="/tmp/.coco-rotation-cursors-${USER:-cocoai}"
  log "Cursor dir not writable (${CURSOR_DIR}); falling back to ${FALLBACK_CURSOR_DIR}"
  CURSOR_DIR="${FALLBACK_CURSOR_DIR}"
  mkdir -p "${CURSOR_DIR}"
fi
chmod 700 "${CURSOR_DIR}" 2>/dev/null || true

# 429 patterns from different runtimes:
#   - OpenAI API:     "429" / "rate_limit_exceeded" / "Rate limit reached"
#   - Codex CLI:      "429" / "rate limit" / "Too Many Requests"
#   - OpenClaw GW:    "429" / "rate_limit" / "RateLimitError"
RATE_LIMIT_PATTERN='429|rate.?limit|too many requests|RateLimitError|rate_limit_exceeded'

last_rotation_epoch=0
if [[ -f "${STATE_FILE}" ]]; then
  last_rotation_ts="$(jq -r '.lastRotatedAt // empty' "${STATE_FILE}" 2>/dev/null || echo "")"
  if [[ -n "${last_rotation_ts}" ]]; then
    last_rotation_epoch="$(date -d "${last_rotation_ts}" +%s 2>/dev/null || echo "0")"
  fi
fi

# Track journald cursor for incremental reads
JOURNAL_CURSOR_FILE="${CURSOR_DIR}/journald.cursor"

check_cooldown() {
  local now
  now="$(date +%s)"
  local elapsed=$(( now - last_rotation_epoch ))
  if [[ "${elapsed}" -lt "${ROTATION_COOLDOWN_SECS}" ]]; then
    return 1  # still in cooldown
  fi
  return 0
}

# Read new lines from a log file since last cursor position.
# Returns 0 if 429 pattern found in new lines, 1 otherwise.
check_logfile_incremental() {
  local logfile="${1}"
  local basename
  basename="$(basename "${logfile}")"
  local cursor_file="${CURSOR_DIR}/${basename}.offset"

  if [[ ! -f "${logfile}" ]]; then
    return 1
  fi

  local current_size
  current_size="$(stat -c%s "${logfile}" 2>/dev/null || echo "0")"
  local saved_inode=""
  local saved_offset=0

  if [[ -f "${cursor_file}" ]]; then
    saved_inode="$(head -1 "${cursor_file}" 2>/dev/null || echo "")"
    saved_offset="$(tail -1 "${cursor_file}" 2>/dev/null || echo "0")"
  fi

  local current_inode
  current_inode="$(stat -c%i "${logfile}" 2>/dev/null || echo "")"

  # Log was rotated (different inode) or truncated (smaller) — reset cursor
  if [[ "${current_inode}" != "${saved_inode}" || "${current_size}" -lt "${saved_offset}" ]]; then
    saved_offset=0
  fi

  # No new data
  if [[ "${current_size}" -le "${saved_offset}" ]]; then
    printf '%s\n%s\n' "${current_inode}" "${current_size}" > "${cursor_file}"
    return 1
  fi

  # Read only new bytes and check for pattern
  local found=1
  if dd if="${logfile}" bs=1 skip="${saved_offset}" count=$(( current_size - saved_offset )) 2>/dev/null \
     | grep -qiE "${RATE_LIMIT_PATTERN}" 2>/dev/null; then
    found=0
  fi

  # Update cursor to current size
  printf '%s\n%s\n' "${current_inode}" "${current_size}" > "${cursor_file}"
  return "${found}"
}

do_rotate() {
  local reason="${1:-429-detected}"
  log "Rate limit detected — triggering rotation (reason: ${reason})"

  if ! check_cooldown; then
    log "Cooldown active (${ROTATION_COOLDOWN_SECS}s) — skipping rotation"
    return
  fi

  if [[ ! -f "${MULTI_TOKEN_FILE}" ]]; then
    log "Multi-token file missing — cannot rotate"
    return
  fi

  local count
  count="$(jq -r '.tokens | length' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "0")"
  if [[ "${count}" -le 1 ]]; then
    log "Only ${count} token(s) — cannot rotate"
    return
  fi

  if /opt/coco/rotate-token.sh; then
    last_rotation_epoch="$(date +%s)"

    # Check if all tokens are exhausted (all in per-token cooldown)
    ALL_EXHAUSTED="$(jq -r '.allTokensExhausted // false' "${STATE_FILE}" 2>/dev/null || echo "false")"
    if [[ "${ALL_EXHAUSTED}" == "true" ]]; then
      log "WARNING: All tokens exhausted — agent restart skipped (no valid token to switch to)"
      # Don't restart agent when all tokens are rate-limited; the selected token
      # is the one with the earliest cooldown expiry. Restarting would just cause
      # another immediate 429. The next poll cycle will re-check.
    else
      log "Token rotated successfully — restarting agent runtime"
      restart_agent
    fi
  else
    log "ERROR: rotate-token.sh failed"
  fi
}

restart_agent() {
  case "${AGENT_TYPE}" in
    openclaw)
      if systemctl is-active --quiet openclaw-gateway 2>/dev/null; then
        systemctl restart openclaw-gateway || log "WARNING: Failed to restart openclaw-gateway"
      fi
      ;;
    zylos|claude)
      # Kill the tmux session first so the old agent (with old credentials) exits.
      # activity-monitor will detect the offline state and launch a new session
      # that reads fresh tokens from disk.
      tmux kill-session -t claude-main 2>/dev/null || true
      tmux kill-session -t codex-main 2>/dev/null || true
      log "Killed tmux agent session"

      local NVM_DIR="${HOME}/.nvm"
      if [[ -f "${NVM_DIR}/nvm.sh" ]]; then
        # nvm.sh uses unset variables internally and may toggle set -e;
        # snapshot all shell options and restore after sourcing.
        local _saved_opts; _saved_opts=$(set +o; shopt -p)
        set +u
        # shellcheck disable=SC1091
        source "${NVM_DIR}/nvm.sh" || log "WARNING: nvm.sh failed to source"
        eval "${_saved_opts}"
      fi
      if command -v pm2 &>/dev/null; then
        pm2 restart activity-monitor 2>/dev/null || log "WARNING: pm2 restart activity-monitor failed"
      fi
      ;;
    *)
      log "Unknown agent type: ${AGENT_TYPE} — skipping restart"
      ;;
  esac
}

# --- Main watch loop ---
log "Starting token rotation watcher (agent=${AGENT_TYPE}, cooldown=${ROTATION_COOLDOWN_SECS}s)"

POLL_INTERVAL="${TOKEN_ROTATION_POLL_SECS:-30}"
PM2_LOG_DIR="${HOME}/.pm2/logs"

while true; do
  sleep "${POLL_INTERVAL}"

  # Skip if no multi-token file (single token = nothing to rotate to)
  if [[ ! -f "${MULTI_TOKEN_FILE}" ]]; then
    continue
  fi

  DETECTED=false

  # Check PM2 error logs with byte-offset cursors (only new lines)
  if [[ -d "${PM2_LOG_DIR}" ]]; then
    for logfile in "${PM2_LOG_DIR}"/*-error.log; do
      if check_logfile_incremental "${logfile}"; then
        DETECTED=true
        log "429 pattern found in new lines of $(basename "${logfile}")"
        break
      fi
    done
  fi

  # Check journald with cursor (only new entries from agent-related units)
  # Filter to agent runtime units only — prevents false triggers from unrelated
  # services (timers, sync scripts, etc.) that may log "429" or "rate limit" text.
  if [[ "${DETECTED}" == "false" ]]; then
    JOURNAL_ARGS=(--no-pager -q --output=cat)

    # Only scan units relevant to the agent runtime
    case "${AGENT_TYPE}" in
      openclaw)
        JOURNAL_ARGS+=(-u openclaw-gateway -u openclaw-config)
        ;;
      zylos|claude)
        # zylos/claude agents run in tmux via PM2 (checked above), but also
        # check the bootstrap and token-sync units for auth-related 429s
        JOURNAL_ARGS+=(-t codex -t claude -t coco-bootstrap)
        ;;
    esac

    if [[ -f "${JOURNAL_CURSOR_FILE}" ]]; then
      SAVED_CURSOR="$(cat "${JOURNAL_CURSOR_FILE}" 2>/dev/null || echo "")"
      if [[ -n "${SAVED_CURSOR}" ]]; then
        JOURNAL_ARGS+=(--after-cursor="${SAVED_CURSOR}")
      fi
    else
      # First run: only look at entries from now
      JOURNAL_ARGS+=(--since="now")
    fi

    # Capture journal output and new cursor
    JOURNAL_OUTPUT=""
    if JOURNAL_OUTPUT="$(journalctl "${JOURNAL_ARGS[@]}" --show-cursor 2>/dev/null)"; then
      # Extract cursor from last line (format: "-- cursor: s=...")
      # Grep non-match is expected on some journalctl outputs; keep it non-fatal.
      NEW_CURSOR="$(echo "${JOURNAL_OUTPUT}" | grep '^-- cursor:' | tail -1 | sed 's/^-- cursor: //' || true)"
      if [[ -n "${NEW_CURSOR}" ]]; then
        echo "${NEW_CURSOR}" > "${JOURNAL_CURSOR_FILE}"
      fi
      # Check content (excluding cursor line) for 429 patterns
      JOURNAL_CONTENT="$(echo "${JOURNAL_OUTPUT}" | grep -v '^-- cursor:' || true)"
      if echo "${JOURNAL_CONTENT}" | grep -qiE "${RATE_LIMIT_PATTERN}" 2>/dev/null; then
        DETECTED=true
        log "429 pattern found in new journald entries"
      fi
    fi
  fi

  if [[ "${DETECTED}" == "true" ]]; then
    do_rotate "429-detected-in-logs"
  fi
done
