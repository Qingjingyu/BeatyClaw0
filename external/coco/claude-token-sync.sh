#!/usr/bin/env bash
# claude-token-sync.sh — Pull latest Claude setup token from control plane.
#
# Called by credential-sync-watcher.sh when metadata trigger fires.
# Writes CLAUDE_CODE_OAUTH_TOKEN to ~/.claude-env and ~/zylos/.env.
# On 409 (no token assigned), clears the local token to enforce release.
# On network error, preserves existing token (no false-positive clearing).

set -euo pipefail

ENV_FILE="${HOME}/.coco-runtime-env"
CLAUDE_ENV="${HOME}/.claude-env"
ZYLOS_ENV="${HOME}/zylos/.env"
TMP_RESPONSE="/tmp/.coco-claude-token-response.json"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[claude-token-sync] Runtime env file missing — skipping"
  exit 0
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

if [[ -z "${CONTROL_PLANE_URL:-}" || -z "${EMPLOYEE_ID:-}" || -z "${INSTANCE_PULL_SECRET:-}" ]]; then
  echo "[claude-token-sync] Required env vars missing — skipping"
  exit 0
fi

# Call the claude-token-refresh endpoint, capture HTTP status code
HTTP_CODE=$(curl -s -o "${TMP_RESPONSE}" -w '%{http_code}' \
  --max-time 15 \
  -X POST \
  -H "Authorization: Bearer ${INSTANCE_PULL_SECRET}" \
  "${CONTROL_PLANE_URL}/internal/instances/${EMPLOYEE_ID}/claude-token-refresh" 2>/dev/null || echo "000")

case "${HTTP_CODE}" in
  200)
    SETUP_TOKEN=$(jq -r '.data.setupToken // empty' "${TMP_RESPONSE}" 2>/dev/null || echo "")
    if [[ -n "${SETUP_TOKEN}" ]]; then
      # Update ~/.claude-env
      if [[ -f "${CLAUDE_ENV}" ]]; then
        sed -i -E '/^(export )?CLAUDE_CODE_OAUTH_TOKEN=/d' "${CLAUDE_ENV}"
      fi
      echo "CLAUDE_CODE_OAUTH_TOKEN=${SETUP_TOKEN}" >> "${CLAUDE_ENV}"
      chmod 600 "${CLAUDE_ENV}"

      # Update ~/zylos/.env
      if [[ -f "${ZYLOS_ENV}" ]]; then
        sed -i -E '/^(export )?CLAUDE_CODE_OAUTH_TOKEN=/d' "${ZYLOS_ENV}"
        echo "CLAUDE_CODE_OAUTH_TOKEN=${SETUP_TOKEN}" >> "${ZYLOS_ENV}"
        chmod 600 "${ZYLOS_ENV}"
      fi

      echo "[claude-token-sync] Setup token updated"
    else
      echo "[claude-token-sync] 200 but no token in response — skipping"
    fi
    ;;
  409)
    # No Claude token assigned — clear local token (release scenario)
    if [[ -f "${CLAUDE_ENV}" ]]; then
      sed -i -E '/^(export )?CLAUDE_CODE_OAUTH_TOKEN=/d' "${CLAUDE_ENV}"
    fi
    if [[ -f "${ZYLOS_ENV}" ]]; then
      sed -i -E '/^(export )?CLAUDE_CODE_OAUTH_TOKEN=/d' "${ZYLOS_ENV}"
    fi
    echo "[claude-token-sync] No token assigned (409) — cleared local token"
    ;;
  *)
    # Network error or other — preserve existing token, do NOT clear
    echo "[claude-token-sync] API call failed (HTTP ${HTTP_CODE}) — skipping"
    ;;
esac

rm -f "${TMP_RESPONSE}"
exit 0
