#!/usr/bin/env bash
# apply-provider-token.sh — project provider-access-token.json into agent auth files.
# Supports both single-token and multi-token formats.

set -euo pipefail

AGENT_TYPE_INPUT="${1:-}"
ENV_FILE="${HOME}/.coco-runtime-env"
TOKEN_FILE="${HOME}/.coco/provider-access-token.json"
MULTI_TOKEN_FILE="${HOME}/.coco/provider-access-tokens.json"

if [[ -z "${AGENT_TYPE_INPUT}" && -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

AGENT_TYPE="${AGENT_TYPE_INPUT:-${AGENT_TYPE:-}}"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "[apply-provider-token] Token file missing — skipping"
  exit 0
fi

PROVIDER="$(jq -r '.provider // empty' "${TOKEN_FILE}")"
ACCESS_TOKEN="$(jq -r '.accessToken // empty' "${TOKEN_FILE}")"
PROVIDER_ACCOUNT_ID="$(jq -r '.providerAccountId // empty' "${TOKEN_FILE}")"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -z "${PROVIDER}" || -z "${ACCESS_TOKEN}" ]]; then
  echo "[apply-provider-token] Incomplete token payload — skipping"
  exit 0
fi

extract_chatgpt_account_id() {
  if ! command -v python3 &>/dev/null; then
    return 0
  fi

  python3 -c '
import base64, json, sys
try:
    payload = sys.argv[1].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    data = json.loads(base64.urlsafe_b64decode(payload))
    print(data.get("https://api.openai.com/auth", {}).get("chatgpt_account_id", ""))
except Exception:
    pass
' "${1:-}" 2>/dev/null || true
}

ACCOUNT_ID="$(extract_chatgpt_account_id "${ACCESS_TOKEN}")"
if [[ -z "${ACCOUNT_ID}" ]]; then
  ACCOUNT_ID="${PROVIDER_ACCOUNT_ID}"
fi

if [[ "${PROVIDER}" == "openai" && "${AGENT_TYPE}" == "openclaw" ]]; then
  # OpenClaw reads auth from ~/.openclaw/agents/main/agent/auth-profiles.json.
  # We use the "openai-codex" provider so OpenClaw routes through
  # chatgpt.com/backend-api/codex instead of api.openai.com/v1, which requires
  # the api.responses.write OAuth scope that OpenAI no longer grants.
  OC_AUTH_DIR="${HOME}/.openclaw/agents/main/agent"
  OC_AUTH_FILE="${OC_AUTH_DIR}/auth-profiles.json"
  mkdir -p "${OC_AUTH_DIR}"

  # Check for multi-token file — write multiple profiles for rotation
  if [[ -f "${MULTI_TOKEN_FILE}" ]]; then
    MULTI_TOKEN_COUNT="$(jq -r '.tokens | length' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "0")"
    if [[ "${MULTI_TOKEN_COUNT}" -gt 1 ]]; then
      TMP_FILE="${OC_AUTH_FILE}.tmp"
      # Build profiles object: openai-codex:oauth for primary, openai-codex:oauth:N for extras
      python3 -c "
import json, base64, sys

multi = json.load(open(sys.argv[1]))
tokens = multi.get('tokens', [])
profiles = {}

for i, tok in enumerate(tokens):
    access_token = tok.get('accessToken', '')
    provider_account_id = tok.get('providerAccountId', '')

    # Extract chatgpt_account_id from JWT
    account_id = ''
    try:
        payload_part = access_token.split('.')[1]
        payload_part += '=' * (-len(payload_part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_part))
        account_id = payload.get('https://api.openai.com/auth', {}).get('chatgpt_account_id', '')
    except:
        pass
    if not account_id:
        account_id = provider_account_id

    key = 'openai-codex:oauth' if i == 0 else f'openai-codex:oauth:{i}'
    profile = {
        'mode': 'token',
        'provider': 'openai-codex',
        'token': access_token,
    }
    if account_id:
        profile['accountId'] = account_id
    profiles[key] = profile

json.dump({'profiles': profiles}, open(sys.argv[2], 'w'), indent=2)
" "${MULTI_TOKEN_FILE}" "${TMP_FILE}" 2>/dev/null

      if [[ -f "${TMP_FILE}" ]]; then
        chmod 600 "${TMP_FILE}"
        mv -f "${TMP_FILE}" "${OC_AUTH_FILE}"
        echo "[apply-provider-token] Updated OpenClaw auth-profiles.json with ${MULTI_TOKEN_COUNT} profiles"
        exit 0
      fi
    fi
  fi

  # Fallback: single profile from primary token
  TMP_FILE="${OC_AUTH_FILE}.tmp"
  jq -n \
    --arg accessToken "${ACCESS_TOKEN}" \
    --arg accountId "${ACCOUNT_ID}" \
    '{
      profiles: {
        "openai-codex:oauth": {
          mode: "token",
          provider: "openai-codex",
          token: $accessToken
        }
      }
    }
    | if $accountId != "" then .profiles["openai-codex:oauth"].accountId = $accountId else . end' > "${TMP_FILE}"
  chmod 600 "${TMP_FILE}"
  mv -f "${TMP_FILE}" "${OC_AUTH_FILE}"
  echo "[apply-provider-token] Updated OpenClaw auth-profiles.json for openai-codex provider (account=${ACCOUNT_ID:-unknown})"
  exit 0
fi

# Codex CLI (zylos/claude) only supports a single auth.json — no multi-profile support.
# Multi-token rotation is handled externally: rotate-token.sh updates the single-token
# compat file, which this script projects into auth.json. Codex's built-in 401 recovery
# also reloads auth.json from disk, providing a second layer of token refresh.
if [[ "${PROVIDER}" == "openai" && "${AGENT_TYPE}" =~ ^(zylos|claude)$ ]]; then
  AUTH_DIR="${HOME}/.codex"
  AUTH_FILE="${AUTH_DIR}/auth.json"
  mkdir -p "${AUTH_DIR}"
  TMP_FILE="${AUTH_FILE}.tmp"
  # Codex CLI requires id_token with valid email + chatgpt_plan_type claims for
  # TUI bootstrap (read_chatgpt_account). The access_token JWT already contains
  # all required claims, so we reuse it as id_token. refresh_token placeholder
  # is fine — token-sync refreshes every 30min, well within Codex's 8-day window.
  jq -n \
    --arg accessToken "${ACCESS_TOKEN}" \
    --arg accountId "${ACCOUNT_ID}" \
    --arg lastRefresh "${NOW_ISO}" \
    '{
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: $accessToken,
        id_token: $accessToken,
        refresh_token: "rt_placeholder",
        account_id: $accountId
      },
      last_refresh: $lastRefresh
    }
    | if .tokens.account_id == "" then del(.tokens.account_id) else . end' > "${TMP_FILE}"
  chmod 600 "${TMP_FILE}"
  mv -f "${TMP_FILE}" "${AUTH_FILE}"
  echo "[apply-provider-token] Updated Codex auth.json from provider access token"
  exit 0
fi

echo "[apply-provider-token] No agent-specific apply step for agent=${AGENT_TYPE:-unknown} provider=${PROVIDER}"
