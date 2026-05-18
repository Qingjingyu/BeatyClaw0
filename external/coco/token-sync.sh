#!/usr/bin/env bash
# token-sync.sh — Pull latest provider access token(s) from control plane.
#
# Reads /home/cocoai/.coco-runtime-env, calls the instance-scoped internal
# token-refresh endpoint, and writes the latest token payload to local files.
# Supports both single-token and multi-token endpoints.
# Agent-specific consumption is handled separately.

set -euo pipefail

ENV_FILE="${HOME}/.coco-runtime-env"
TOKEN_DIR="${HOME}/.coco"
TOKEN_FILE="${TOKEN_DIR}/provider-access-token.json"
MULTI_TOKEN_FILE="${TOKEN_DIR}/provider-access-tokens.json"
TOKEN_DIR_OWNER="$(id -u):$(id -g)"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[token-sync] Runtime env file missing — skipping"
  exit 0
fi

# shellcheck disable=SC1090
source "${ENV_FILE}"

if [[ -z "${CONTROL_PLANE_URL:-}" || -z "${EMPLOYEE_ID:-}" || -z "${INSTANCE_PULL_SECRET:-}" ]]; then
  echo "[token-sync] Required env vars missing — skipping"
  exit 0
fi

sync_enabled="${PROVIDER_TOKEN_SYNC_ENABLED:-}"
if [[ "${sync_enabled}" != "1" ]]; then
  if [[ -z "${sync_enabled}" ]]; then
    if [[ -f "${TOKEN_FILE}" ]]; then
      existing_provider="$(jq -r '.provider // empty' "${TOKEN_FILE}" 2>/dev/null || echo "")"
      if [[ -n "${existing_provider}" ]]; then
        sync_enabled="1"
      fi
    fi
  fi
fi

if [[ "${sync_enabled}" != "1" ]]; then
  echo "[token-sync] Provider token sync disabled for this instance — skipping"
  exit 0
fi

mkdir -p "${TOKEN_DIR}"
chown "${TOKEN_DIR_OWNER}" "${TOKEN_DIR}"
chmod 700 "${TOKEN_DIR}"

# --- Try multi-token endpoint first ---
# Use HTTP status code to distinguish 409 (no credentials) from network errors.
MULTI_TMP_RESP="/tmp/.coco-multi-token-response.json"
MULTI_HTTP_CODE=$(curl -s -o "${MULTI_TMP_RESP}" -w '%{http_code}' \
  --max-time 15 \
  -X POST \
  -H "Authorization: Bearer ${INSTANCE_PULL_SECRET}" \
  "${CONTROL_PLANE_URL}/internal/instances/${EMPLOYEE_ID}/token-refresh-multi" 2>/dev/null || echo "000")

if [[ "${MULTI_HTTP_CODE}" == "409" ]]; then
  # No credentials assigned — clear local token files to prevent stale token usage
  echo "[token-sync] No credentials assigned (409) — clearing local token files"
  rm -f "${TOKEN_FILE}" "${MULTI_TOKEN_FILE}"
  rm -f "${TOKEN_DIR}/.token-rotation-state"
  rm -f "${HOME}/.codex/auth.json" 2>/dev/null
  rm -f "${HOME}/.openclaw/agents/main/agent/auth-profiles.json" 2>/dev/null
  rm -f "${MULTI_TMP_RESP}"
  exit 0
fi

MULTI_RESPONSE=""
if [[ "${MULTI_HTTP_CODE}" == "200" ]]; then
  MULTI_RESPONSE="$(cat "${MULTI_TMP_RESP}" 2>/dev/null || echo "")"
fi
rm -f "${MULTI_TMP_RESP}"

if [[ -n "${MULTI_RESPONSE}" ]]; then
  TOKEN_COUNT="$(echo "${MULTI_RESPONSE}" | jq -r '.data.tokens | length' 2>/dev/null || echo "0")"
  if [[ "${TOKEN_COUNT}" -gt 0 ]]; then
    # Write multi-token file
    MULTI_TMP="${MULTI_TOKEN_FILE}.tmp"
    echo "${MULTI_RESPONSE}" | jq '{
      provider: .data.primary.provider,
      rotationStrategy: .data.rotationStrategy,
      tokens: [.data.tokens[] | {
        accessToken: .accessToken,
        provider: .provider,
        providerAccountId: .providerAccountId,
        credentialId: .credentialId,
        refreshVersion: .refreshVersion,
        expiresAt: (.expiresAt // null)
      }],
      syncedAt: (now | todate)
    }' > "${MULTI_TMP}"
    chmod 600 "${MULTI_TMP}"
    mv -f "${MULTI_TMP}" "${MULTI_TOKEN_FILE}"

    # Write single-token compat file.
    # If rotation state exists, preserve the locally-active token instead of
    # resetting to control-plane primary. This prevents token-sync from undoing
    # a 429-triggered rotation (the watcher rotated away from a rate-limited
    # token, and we must stay on the new one until the next rotation event).
    ROTATION_STATE_FILE="${TOKEN_DIR}/.token-rotation-state"
    RESOLVED_INDEX=-1
    if [[ -f "${ROTATION_STATE_FILE}" ]]; then
      # Prefer credentialId match (stable across list reorder/shrink),
      # fall back to index only if credentialId not found in fresh list.
      ACTIVE_CRED_ID="$(jq -r '.activeCredentialId // empty' "${ROTATION_STATE_FILE}" 2>/dev/null || echo "")"
      ACTIVE_INDEX="$(jq -r '.activeIndex // -1' "${ROTATION_STATE_FILE}" 2>/dev/null || echo "-1")"

      if [[ -n "${ACTIVE_CRED_ID}" ]]; then
        RESOLVED_INDEX="$(jq -r --arg cid "${ACTIVE_CRED_ID}" \
          '[.tokens | to_entries[] | select(.value.credentialId == $cid) | .key] | first // -1' \
          "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "-1")"
      fi
      # Credential not in fresh list (removed/collected) — try index as fallback
      if [[ "${RESOLVED_INDEX}" -lt 0 && "${ACTIVE_INDEX}" -ge 0 && "${ACTIVE_INDEX}" -lt "${TOKEN_COUNT}" ]]; then
        RESOLVED_INDEX="${ACTIVE_INDEX}"
        echo "[token-sync] Active credential ${ACTIVE_CRED_ID:-?} not in fresh list — falling back to index ${ACTIVE_INDEX}"
      fi
    fi

    if [[ "${RESOLVED_INDEX}" -ge 0 && "${RESOLVED_INDEX}" -lt "${TOKEN_COUNT}" ]]; then
      # Use the locally-rotated active token from the freshly-synced multi-token file
      ACTIVE_TOKEN="$(jq -r --argjson idx "${RESOLVED_INDEX}" '.tokens[$idx].accessToken // empty' "${MULTI_TOKEN_FILE}")"
      ACTIVE_PROVIDER="$(jq -r --argjson idx "${RESOLVED_INDEX}" '.tokens[$idx].provider // empty' "${MULTI_TOKEN_FILE}")"
      ACTIVE_EXPIRES_AT="$(jq -r --argjson idx "${RESOLVED_INDEX}" '.tokens[$idx].expiresAt // empty' "${MULTI_TOKEN_FILE}")"
      ACTIVE_ACCOUNT_ID="$(jq -r --argjson idx "${RESOLVED_INDEX}" '.tokens[$idx].providerAccountId // empty' "${MULTI_TOKEN_FILE}")"
      ACTIVE_REFRESH_VERSION="$(jq -r --argjson idx "${RESOLVED_INDEX}" '.tokens[$idx].refreshVersion // 0' "${MULTI_TOKEN_FILE}")"

      if [[ -n "${ACTIVE_TOKEN}" && -n "${ACTIVE_PROVIDER}" ]]; then
        COMPAT_TMP="${TOKEN_FILE}.tmp"
        jq -n \
          --arg provider "${ACTIVE_PROVIDER}" \
          --arg accessToken "${ACTIVE_TOKEN}" \
          --arg expiresAt "${ACTIVE_EXPIRES_AT}" \
          --arg providerAccountId "${ACTIVE_ACCOUNT_ID}" \
          --argjson refreshVersion "${ACTIVE_REFRESH_VERSION}" \
          '{
            provider: $provider,
            accessToken: $accessToken,
            providerAccountId: $providerAccountId,
            refreshVersion: $refreshVersion
          }
          | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' > "${COMPAT_TMP}"
        chmod 600 "${COMPAT_TMP}"
        mv -f "${COMPAT_TMP}" "${TOKEN_FILE}"
        echo "[token-sync] Preserved rotation: credentialId=${ACTIVE_CRED_ID:-?} resolved to index=${RESOLVED_INDEX}"
      fi
    else
      # No rotation state — use control-plane primary as default
      PRIMARY_ACCESS_TOKEN="$(echo "${MULTI_RESPONSE}" | jq -r '.data.primary.accessToken // empty')"
      PRIMARY_PROVIDER="$(echo "${MULTI_RESPONSE}" | jq -r '.data.primary.provider // empty')"
      PRIMARY_EXPIRES_AT="$(echo "${MULTI_RESPONSE}" | jq -r '.data.primary.expiresAt // empty')"
      PRIMARY_ACCOUNT_ID="$(echo "${MULTI_RESPONSE}" | jq -r '.data.primary.providerAccountId // empty')"
      PRIMARY_REFRESH_VERSION="$(echo "${MULTI_RESPONSE}" | jq -r '.data.primary.refreshVersion // 0')"

      if [[ -n "${PRIMARY_ACCESS_TOKEN}" && -n "${PRIMARY_PROVIDER}" ]]; then
        COMPAT_TMP="${TOKEN_FILE}.tmp"
        jq -n \
          --arg provider "${PRIMARY_PROVIDER}" \
          --arg accessToken "${PRIMARY_ACCESS_TOKEN}" \
          --arg expiresAt "${PRIMARY_EXPIRES_AT}" \
          --arg providerAccountId "${PRIMARY_ACCOUNT_ID}" \
          --argjson refreshVersion "${PRIMARY_REFRESH_VERSION}" \
          '{
            provider: $provider,
            accessToken: $accessToken,
            providerAccountId: $providerAccountId,
            refreshVersion: $refreshVersion
          }
          | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' > "${COMPAT_TMP}"
        chmod 600 "${COMPAT_TMP}"
        mv -f "${COMPAT_TMP}" "${TOKEN_FILE}"
      fi
    fi

    # Update rotation state tokenCount so it reflects the fresh token list.
    # This prevents stale tokenCount from misleading rotate-token.sh or debug tools.
    # Uses flock to prevent concurrent writes with rotate-token.sh (which also
    # writes .token-rotation-state on 429-triggered rotation).
    ROTATION_STATE_FILE="${TOKEN_DIR}/.token-rotation-state"
    ROTATION_LOCK="/tmp/.coco-rotation-state.lock"
    if [[ -f "${ROTATION_STATE_FILE}" ]]; then
      (
        flock -x -w 5 200 || { echo "[token-sync] Failed to acquire rotation state lock"; exit 0; }
        OLD_COUNT="$(jq -r '.tokenCount // 0' "${ROTATION_STATE_FILE}" 2>/dev/null || echo "0")"
        if [[ "${OLD_COUNT}" != "${TOKEN_COUNT}" ]]; then
          STATE_TMP="${ROTATION_STATE_FILE}.tmp"
          jq --argjson tc "${TOKEN_COUNT}" '.tokenCount = $tc' "${ROTATION_STATE_FILE}" > "${STATE_TMP}" 2>/dev/null && \
            mv -f "${STATE_TMP}" "${ROTATION_STATE_FILE}" && \
            echo "[token-sync] Updated rotation state tokenCount: ${OLD_COUNT} → ${TOKEN_COUNT}" || \
            rm -f "${STATE_TMP}"
        fi
      ) 200>"${ROTATION_LOCK}"
    fi

    if [[ -x "/opt/coco/apply-provider-token.sh" ]]; then
      /opt/coco/apply-provider-token.sh "${AGENT_TYPE:-}" || \
        echo "[token-sync] Failed to apply token payload to agent auth files"
    fi

    echo "[token-sync] Multi-token sync: ${TOKEN_COUNT} tokens, provider=${ACTIVE_PROVIDER:-${PRIMARY_PROVIDER:-unknown}}"
    exit 0
  fi
fi

# --- Fallback to single-token endpoint ---
# Keep the existing multi-token file until single-token fallback succeeds.
# This avoids dropping the VM into a degraded single-token state when the
# multi-token endpoint fails transiently and the single-token fallback also
# fails/times out in the same run.

SINGLE_TMP_RESP="/tmp/.coco-single-token-response.json"
SINGLE_HTTP_CODE=$(curl -s -o "${SINGLE_TMP_RESP}" -w '%{http_code}' \
  --max-time 15 \
  -X POST \
  -H "Authorization: Bearer ${INSTANCE_PULL_SECRET}" \
  "${CONTROL_PLANE_URL}/internal/instances/${EMPLOYEE_ID}/token-refresh" 2>/dev/null || echo "000")

if [[ "${SINGLE_HTTP_CODE}" == "409" ]]; then
  # No credentials assigned — clear local token files
  echo "[token-sync] No credentials assigned (409) — clearing local token files"
  rm -f "${TOKEN_FILE}" "${MULTI_TOKEN_FILE}"
  rm -f "${TOKEN_DIR}/.token-rotation-state"
  rm -f "${HOME}/.codex/auth.json" 2>/dev/null
  rm -f "${HOME}/.openclaw/agents/main/agent/auth-profiles.json" 2>/dev/null
  rm -f "${SINGLE_TMP_RESP}"
  exit 0
fi

RESPONSE=""
if [[ "${SINGLE_HTTP_CODE}" == "200" ]]; then
  RESPONSE="$(cat "${SINGLE_TMP_RESP}" 2>/dev/null || echo "")"
fi
rm -f "${SINGLE_TMP_RESP}"

if [[ -z "${RESPONSE}" ]]; then
  echo "[token-sync] Token refresh call failed (HTTP ${SINGLE_HTTP_CODE}) — skipping"
  exit 0
fi

ACCESS_TOKEN="$(echo "${RESPONSE}" | jq -r '.data.accessToken // empty')"
PROVIDER="$(echo "${RESPONSE}" | jq -r '.data.provider // empty')"
EXPIRES_AT="$(echo "${RESPONSE}" | jq -r '.data.expiresAt // empty')"
PROVIDER_ACCOUNT_ID="$(echo "${RESPONSE}" | jq -r '.data.providerAccountId // empty')"
REFRESH_VERSION="$(echo "${RESPONSE}" | jq -r '.data.refreshVersion // 0')"

if [[ -z "${ACCESS_TOKEN}" || -z "${PROVIDER}" ]]; then
  echo "[token-sync] Control plane returned no token payload — skipping"
  exit 0
fi

# Single-token fallback succeeded, so the previous multi-token cache is now stale.
if [[ -f "${MULTI_TOKEN_FILE}" ]]; then
  rm -f "${MULTI_TOKEN_FILE}"
  echo "[token-sync] Removed stale multi-token file after successful single-token fallback"
fi

TMP_FILE="${TOKEN_FILE}.tmp"
jq -n \
  --arg provider "${PROVIDER}" \
  --arg accessToken "${ACCESS_TOKEN}" \
  --arg expiresAt "${EXPIRES_AT}" \
  --arg providerAccountId "${PROVIDER_ACCOUNT_ID}" \
  --argjson refreshVersion "${REFRESH_VERSION}" \
  '{
    provider: $provider,
    accessToken: $accessToken,
    providerAccountId: $providerAccountId,
    refreshVersion: $refreshVersion
  }
  | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' > "${TMP_FILE}"

chmod 600 "${TMP_FILE}"
mv -f "${TMP_FILE}" "${TOKEN_FILE}"

if [[ -x "/opt/coco/apply-provider-token.sh" ]]; then
  /opt/coco/apply-provider-token.sh "${AGENT_TYPE:-}" || \
    echo "[token-sync] Failed to apply token payload to agent auth files"
fi

echo "[token-sync] Token file updated: provider=${PROVIDER} refreshVersion=${REFRESH_VERSION}"
