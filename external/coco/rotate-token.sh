#!/usr/bin/env bash
# rotate-token.sh — Rotate to the next provider access token from the multi-token pool.
#
# Reads ~/.coco/provider-access-tokens.json, cycles to the next token,
# updates the single-token compat file, and re-projects to agent auth files.
# Tracks rotation state in ~/.coco/.token-rotation-state.
#
# Usage:
#   rotate-token.sh              # Rotate to next token
#   rotate-token.sh --status     # Print current rotation state
#   rotate-token.sh --skip <id>  # Skip a specific credential and rotate to next

set -euo pipefail

TOKEN_DIR="${HOME}/.coco"
MULTI_TOKEN_FILE="${TOKEN_DIR}/provider-access-tokens.json"
SINGLE_TOKEN_FILE="${TOKEN_DIR}/provider-access-token.json"
STATE_FILE="${TOKEN_DIR}/.token-rotation-state"
ENV_FILE="${HOME}/.coco-runtime-env"
LOG_PREFIX="[rotate-token]"

log() { echo "${LOG_PREFIX} $*"; }

# --- Status mode ---
if [[ "${1:-}" == "--status" ]]; then
  if [[ -f "${STATE_FILE}" ]]; then
    jq '.' "${STATE_FILE}"
  else
    echo '{"activeIndex": 0, "rotations": 0}'
  fi
  exit 0
fi

# --- Validate multi-token file ---
if [[ ! -f "${MULTI_TOKEN_FILE}" ]]; then
  log "No multi-token file found — nothing to rotate"
  exit 0
fi

TOKEN_COUNT="$(jq -r '.tokens | length' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "0")"
if [[ "${TOKEN_COUNT}" -le 1 ]]; then
  log "Only ${TOKEN_COUNT} token(s) available — rotation not possible"
  exit 0
fi

# Per-token cooldown: when a token is rotated away due to 429, it is marked
# "in cooldown" for PER_TOKEN_COOLDOWN_SECS (default 60s). The next rotation
# skips tokens still in cooldown, preventing the blind rotate-cooldown-rotate
# cycle when multiple tokens are rate-limited simultaneously.
# This is a VM-side environment variable — set in golden image, bootstrap, or
# ~/.coco-runtime-env to override the default.
PER_TOKEN_COOLDOWN_SECS="${PER_TOKEN_COOLDOWN_SECS:-60}"

# --- Read current state ---
CURRENT_INDEX=0
ROTATIONS=0
SKIP_CRED_ID=""
COOLDOWN_MAP="{}"

# --skip <credentialId>: allows manual exclusion of a known-bad token
# (e.g., revoked or rate-limited) by skipping directly past it.
if [[ "${1:-}" == "--skip" && -n "${2:-}" ]]; then
  SKIP_CRED_ID="${2}"
fi

if [[ -f "${STATE_FILE}" ]]; then
  CURRENT_INDEX="$(jq -r '.activeIndex // 0' "${STATE_FILE}" 2>/dev/null || echo "0")"
  ROTATIONS="$(jq -r '.rotations // 0' "${STATE_FILE}" 2>/dev/null || echo "0")"
  COOLDOWN_MAP="$(jq -r '.perTokenCooldown // {}' "${STATE_FILE}" 2>/dev/null || echo "{}")"
fi

NOW_EPOCH="$(date +%s)"

# Mark the current (rate-limited) token as in cooldown
CURRENT_CRED_ID="$(jq -r --argjson idx "${CURRENT_INDEX}" \
  '.tokens[$idx].credentialId // empty' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "")"
if [[ -n "${CURRENT_CRED_ID}" ]]; then
  COOLDOWN_UNTIL=$(( NOW_EPOCH + PER_TOKEN_COOLDOWN_SECS ))
  COOLDOWN_MAP="$(echo "${COOLDOWN_MAP}" | jq --arg cid "${CURRENT_CRED_ID}" \
    --argjson until "${COOLDOWN_UNTIL}" '. + {($cid): $until}')"
fi

# --- Calculate next index (cooldown-aware) ---
NEXT_INDEX=-1
ALL_IN_COOLDOWN=false

if [[ -n "${SKIP_CRED_ID}" ]]; then
  # --skip mode: find the credential to skip, then look for next non-cooldown token
  SKIP_INDEX="$(jq -r --arg cid "${SKIP_CRED_ID}" \
    '[.tokens | to_entries[] | select(.value.credentialId == $cid) | .key] | first // -1' \
    "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "-1")"
  START_FROM="${SKIP_INDEX}"
  if [[ "${START_FROM}" == "-1" ]]; then
    log "Credential ${SKIP_CRED_ID} not found in token pool"
    START_FROM="${CURRENT_INDEX}"
  fi
else
  START_FROM="${CURRENT_INDEX}"
fi

# Scan all tokens starting from the one after START_FROM, prefer non-cooldown
for (( i = 1; i <= TOKEN_COUNT; i++ )); do
  CANDIDATE=$(( (START_FROM + i) % TOKEN_COUNT ))
  CANDIDATE_CRED_ID="$(jq -r --argjson idx "${CANDIDATE}" \
    '.tokens[$idx].credentialId // empty' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "")"
  CANDIDATE_COOLDOWN="$(echo "${COOLDOWN_MAP}" | jq -r \
    --arg cid "${CANDIDATE_CRED_ID}" '.[$cid] // 0' 2>/dev/null || echo "0")"
  if [[ "${CANDIDATE_COOLDOWN}" -le "${NOW_EPOCH}" ]]; then
    NEXT_INDEX="${CANDIDATE}"
    break
  fi
done

if [[ "${NEXT_INDEX}" -eq -1 ]]; then
  # All tokens in cooldown — pick the one whose cooldown expires soonest
  ALL_IN_COOLDOWN=true
  EARLIEST_EXPIRY=99999999999
  for (( i = 0; i < TOKEN_COUNT; i++ )); do
    CRED_ID="$(jq -r --argjson idx "$i" \
      '.tokens[$idx].credentialId // empty' "${MULTI_TOKEN_FILE}" 2>/dev/null || echo "")"
    EXPIRY="$(echo "${COOLDOWN_MAP}" | jq -r \
      --arg cid "${CRED_ID}" '.[$cid] // 0' 2>/dev/null || echo "0")"
    if [[ "${EXPIRY}" -lt "${EARLIEST_EXPIRY}" ]]; then
      EARLIEST_EXPIRY="${EXPIRY}"
      NEXT_INDEX="$i"
    fi
  done
  WAIT_SECS=$(( EARLIEST_EXPIRY - NOW_EPOCH ))
  if [[ "${WAIT_SECS}" -lt 0 ]]; then WAIT_SECS=0; fi
  log "WARNING: All ${TOKEN_COUNT} tokens in cooldown — using index ${NEXT_INDEX} (earliest reset in ${WAIT_SECS}s)"
fi

# --- Extract the target token ---
NEW_TOKEN="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].accessToken // empty' "${MULTI_TOKEN_FILE}")"
NEW_PROVIDER="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].provider // empty' "${MULTI_TOKEN_FILE}")"
NEW_CRED_ID="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].credentialId // empty' "${MULTI_TOKEN_FILE}")"
NEW_ACCOUNT_ID="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].providerAccountId // empty' "${MULTI_TOKEN_FILE}")"
NEW_REFRESH_VERSION="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].refreshVersion // 0' "${MULTI_TOKEN_FILE}")"
NEW_EXPIRES_AT="$(jq -r --argjson idx "${NEXT_INDEX}" '.tokens[$idx].expiresAt // empty' "${MULTI_TOKEN_FILE}")"

if [[ -z "${NEW_TOKEN}" || -z "${NEW_PROVIDER}" ]]; then
  log "ERROR: Token at index ${NEXT_INDEX} is incomplete — aborting"
  exit 1
fi

# --- Update single-token compat file ---
TMP_FILE="${SINGLE_TOKEN_FILE}.tmp"
jq -n \
  --arg provider "${NEW_PROVIDER}" \
  --arg accessToken "${NEW_TOKEN}" \
  --arg expiresAt "${NEW_EXPIRES_AT}" \
  --arg providerAccountId "${NEW_ACCOUNT_ID}" \
  --argjson refreshVersion "${NEW_REFRESH_VERSION}" \
  '{
    provider: $provider,
    accessToken: $accessToken,
    providerAccountId: $providerAccountId,
    refreshVersion: $refreshVersion
  }
  | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' > "${TMP_FILE}"
chmod 600 "${TMP_FILE}"
mv -f "${TMP_FILE}" "${SINGLE_TOKEN_FILE}"

# --- Apply to agent auth files ---
AGENT_TYPE=""
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  AGENT_TYPE="${AGENT_TYPE:-}"
fi

if [[ -x "/opt/coco/apply-provider-token.sh" ]]; then
  /opt/coco/apply-provider-token.sh "${AGENT_TYPE}" || \
    log "WARNING: Failed to apply rotated token to agent auth files"
fi

# --- Update rotation state (flock to prevent concurrent writes with token-sync.sh) ---
ROTATIONS=$(( ROTATIONS + 1 ))
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Clean up expired cooldowns from the map (keep only entries with expiry > now)
CLEANED_COOLDOWN="$(echo "${COOLDOWN_MAP}" | jq --argjson now "${NOW_EPOCH}" \
  'to_entries | map(select(.value > $now)) | from_entries' 2>/dev/null || echo "{}")"

ROTATION_LOCK="/tmp/.coco-rotation-state.lock"
(
  flock -x -w 5 200 || { log "WARNING: Failed to acquire rotation state lock"; exit 1; }
  STATE_TMP="${STATE_FILE}.tmp"
  jq -n \
    --argjson activeIndex "${NEXT_INDEX}" \
    --argjson previousIndex "${CURRENT_INDEX}" \
    --argjson rotations "${ROTATIONS}" \
    --argjson tokenCount "${TOKEN_COUNT}" \
    --arg credentialId "${NEW_CRED_ID}" \
    --arg rotatedAt "${NOW_ISO}" \
    --arg reason "${SKIP_CRED_ID:+skip:${SKIP_CRED_ID}}" \
    --argjson perTokenCooldown "${CLEANED_COOLDOWN}" \
    --argjson allExhausted "${ALL_IN_COOLDOWN}" \
    '{
      activeIndex: $activeIndex,
      previousIndex: $previousIndex,
      rotations: $rotations,
      tokenCount: $tokenCount,
      activeCredentialId: $credentialId,
      lastRotatedAt: $rotatedAt,
      perTokenCooldown: $perTokenCooldown,
      allTokensExhausted: $allExhausted
    }
    | if $reason != "" then . + {reason: $reason} else . end' > "${STATE_TMP}"
  chmod 600 "${STATE_TMP}"
  mv -f "${STATE_TMP}" "${STATE_FILE}"
) 200>"${ROTATION_LOCK}"

OLD_CRED_ID="$(jq -r --argjson idx "${CURRENT_INDEX}" '.tokens[$idx].credentialId // "unknown"' "${MULTI_TOKEN_FILE}")"
log "Rotated: index ${CURRENT_INDEX}→${NEXT_INDEX}, cred ${OLD_CRED_ID}→${NEW_CRED_ID}, total rotations=${ROTATIONS}${ALL_IN_COOLDOWN:+, ALL TOKENS EXHAUSTED}"
