#!/usr/bin/env bash
# credential-sync-watcher.sh — Watch for admin-triggered credential changes via
# GCE instance metadata long-poll. When the control plane sets the
# "coco-credential-sync-trigger" metadata key (via orchestrator), this script
# detects the change instantly and runs token-sync.sh to pull fresh credentials.
# If the credential actually changed, it restarts the agent runtime.
#
# Runs as a long-lived systemd service.

set -euo pipefail

ENV_FILE="${HOME}/.coco-runtime-env"
TOKEN_FILE="${HOME}/.coco/provider-access-token.json"
LOG_PREFIX="[credential-sync-watcher]"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes/coco-credential-sync-trigger"
METADATA_HEADER="Metadata-Flavor: Google"

log() { echo "${LOG_PREFIX} $(date -u +%H:%M:%S) $*"; }

# --- Pre-flight checks ---
if [[ ! -f "${ENV_FILE}" ]]; then
  log "Runtime env file missing — exiting"
  exit 0
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

AGENT_TYPE="${AGENT_TYPE:-zylos}"

CLAUDE_ENV_FILE="${HOME}/.claude-env"

get_credential_id() {
  if [[ -f "${TOKEN_FILE}" ]]; then
    jq -r '.credentialId // .providerAccountId // empty' "${TOKEN_FILE}" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

get_refresh_version() {
  if [[ -f "${TOKEN_FILE}" ]]; then
    jq -r '.refreshVersion // empty' "${TOKEN_FILE}" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

get_claude_token_hash() {
  { grep -E '^(export )?CLAUDE_CODE_OAUTH_TOKEN=' "${CLAUDE_ENV_FILE}" 2>/dev/null || true; } | md5sum | cut -d' ' -f1
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

# --- Initial metadata fetch to get starting etag ---
ETAG=""
log "Starting credential sync watcher (agent_type=${AGENT_TYPE})"

# Try to get the initial etag. The metadata key may not exist yet, which is fine.
INITIAL_RESPONSE=$(curl -sf -H "${METADATA_HEADER}" -D - -o /dev/null \
  "${METADATA_URL}" 2>/dev/null || true)
ETAG=$(echo "${INITIAL_RESPONSE}" | grep -i '^etag:' | awk '{print $2}' | tr -d '\r\n' || true)

log "Initial etag: ${ETAG:-none}"

# --- Main watch loop ---
while true; do
  # Long-poll: blocks until the metadata value changes or timeout (default ~60s by GCE).
  # On network error or metadata-not-found, retry after a short sleep.
  # Note: do NOT use curl -f here — we need the HTTP code even for 4xx responses.
  HTTP_CODE=$(curl -s -H "${METADATA_HEADER}" \
    -o /dev/null -w '%{http_code}' \
    "${METADATA_URL}?wait_for_change=true&timeout_sec=300${ETAG:+&last_etag=${ETAG}}" \
    2>/dev/null || echo "000")

  if [[ "${HTTP_CODE}" == "000" ]]; then
    # Network error or metadata server unreachable — retry
    log "Metadata long-poll failed (network error) — retrying in 10s"
    sleep 10
    continue
  fi

  if [[ "${HTTP_CODE}" == "404" ]]; then
    # Metadata key doesn't exist yet — wait and retry
    sleep 30
    continue
  fi

  if [[ "${HTTP_CODE}" != "200" ]]; then
    log "Metadata long-poll returned HTTP ${HTTP_CODE} — retrying in 10s"
    sleep 10
    continue
  fi

  # Metadata changed — fetch new value and etag
  RESPONSE_HEADERS=$(curl -s -H "${METADATA_HEADER}" -D - -o /dev/null \
    "${METADATA_URL}" 2>/dev/null || true)
  NEW_ETAG=$(echo "${RESPONSE_HEADERS}" | grep -i '^etag:' | awk '{print $2}' | tr -d '\r\n' || true)

  if [[ -n "${NEW_ETAG}" ]]; then
    ETAG="${NEW_ETAG}"
  else
    # If etag fetch failed, sleep to prevent tight loop on next iteration
    log "WARNING: Failed to fetch new etag — sleeping 10s"
    sleep 10
  fi

  log "Credential sync triggered — running token-sync"

  # Capture pre-sync state
  OLD_CRED_ID=$(get_credential_id)
  OLD_REFRESH_VER=$(get_refresh_version)
  OLD_CLAUDE_HASH=$(get_claude_token_hash)

  # Execute token-sync (Codex provider tokens)
  if /opt/coco/token-sync.sh 2>&1; then
    log "token-sync completed successfully"
  else
    log "WARNING: token-sync failed (exit $?)"
  fi

  # Execute claude-token-sync (Claude setup tokens)
  if [[ -x /opt/coco/claude-token-sync.sh ]]; then
    if /opt/coco/claude-token-sync.sh 2>&1; then
      log "claude-token-sync completed successfully"
    else
      log "WARNING: claude-token-sync failed (exit $?)"
    fi
  fi

  # Check if any credential changed
  NEW_CRED_ID=$(get_credential_id)
  NEW_REFRESH_VER=$(get_refresh_version)
  NEW_CLAUDE_HASH=$(get_claude_token_hash)

  NEED_RESTART=false
  if [[ "${OLD_CRED_ID}" != "${NEW_CRED_ID}" ]]; then
    log "Codex credential changed (${OLD_CRED_ID} → ${NEW_CRED_ID}) — need restart"
    NEED_RESTART=true
  elif [[ "${OLD_REFRESH_VER}" != "${NEW_REFRESH_VER}" ]]; then
    log "Refresh version changed (${OLD_REFRESH_VER} → ${NEW_REFRESH_VER}) — need restart"
    NEED_RESTART=true
  fi
  if [[ "${OLD_CLAUDE_HASH}" != "${NEW_CLAUDE_HASH}" ]]; then
    log "Claude token changed — need restart"
    NEED_RESTART=true
  fi

  if [[ "${NEED_RESTART}" == "true" ]]; then
    restart_agent
  else
    log "No credential change detected — skipping restart"
  fi

  # Brief debounce to avoid rapid re-triggers
  sleep 2
done
