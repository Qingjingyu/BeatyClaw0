#!/usr/bin/env bash
# feature-sync.sh — Sync plan-based features from GCP metadata or Dashboard API
#
# Two sources (checked in order):
#   1. GCP instance metadata key "coco-features" (push path — instant on plan change)
#   2. Dashboard API GET /internal/instances/:id/features (poll path — fallback)
#
# Updates ~/.zylos/.features.json when the plan changes.
# Run at VM startup and periodically via systemd timer.
#
# Required env vars for API fallback (set by bootstrap.sh → zylos/.env):
#   CONTROL_PLANE_URL   — Dashboard API base URL
#   EMPLOYEE_ID         — This instance's employee ID
#   INTERNAL_API_SECRET — Bearer token for internal API auth
#
set -euo pipefail

FEATURES_FILE="${HOME}/zylos/.features.json"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes/coco-features"

# ── Read local features ───────────────────────────────────────────────────

local_plan=""
local_voice_asr="false"
if [[ -f "$FEATURES_FILE" ]]; then
  local_plan=$(jq -r '.plan // empty' "$FEATURES_FILE" 2>/dev/null || echo "")
  local_voice_asr=$(jq -r '.features.voiceAsr // false' "$FEATURES_FILE" 2>/dev/null || echo "false")
fi

# ── Source 1: GCP instance metadata (push path) ──────────────────────────

remote_plan=""
remote_voice_asr=""

metadata_response=$(curl -sf --max-time 3 -H "Metadata-Flavor: Google" "${METADATA_URL}" 2>/dev/null || echo "")
if [[ -n "$metadata_response" ]]; then
  meta_plan=$(echo "$metadata_response" | jq -r '.plan // empty' 2>/dev/null || echo "")
  meta_voice_asr=$(echo "$metadata_response" | jq -r '.features.voiceAsr // empty' 2>/dev/null || echo "")
  if [[ -n "$meta_plan" && -n "$meta_voice_asr" ]]; then
    remote_plan="$meta_plan"
    remote_voice_asr="$meta_voice_asr"
    echo "[feature-sync] Source: GCP metadata (push)"
  fi
fi

# ── Source 2: Dashboard API (poll fallback) ───────────────────────────────

if [[ -z "$remote_plan" ]]; then
  if [[ -z "${CONTROL_PLANE_URL:-}" || -z "${EMPLOYEE_ID:-}" || -z "${INTERNAL_API_SECRET:-}" ]]; then
    echo "[feature-sync] No metadata and env vars not set — skipping"
    exit 0
  fi

  api_response=$(curl -sf \
    --max-time 10 \
    -H "Authorization: Bearer ${INTERNAL_API_SECRET}" \
    "${CONTROL_PLANE_URL}/internal/instances/${EMPLOYEE_ID}/features" 2>/dev/null || echo "")

  if [[ -z "$api_response" ]]; then
    echo "[feature-sync] API call failed or timed out — skipping"
    exit 0
  fi

  remote_plan=$(echo "$api_response" | jq -r '.data.plan // empty')
  remote_voice_asr=$(echo "$api_response" | jq -r '.data.features.voiceAsr // false')
  echo "[feature-sync] Source: Dashboard API (poll)"
fi

if [[ -z "$remote_plan" ]]; then
  echo "[feature-sync] Could not resolve features from any source — skipping"
  exit 0
fi

# Normalize voiceAsr to JSON boolean string
if [[ "$remote_voice_asr" != "true" ]]; then
  remote_voice_asr="false"
fi

# ── Compare and update ────────────────────────────────────────────────────

if [[ "$remote_plan" == "$local_plan" && "$remote_voice_asr" == "$local_voice_asr" ]]; then
  echo "[feature-sync] Features in sync: plan=$local_plan voiceAsr=$local_voice_asr"
  exit 0
fi

echo "[feature-sync] Feature change detected: plan=$local_plan→$remote_plan voiceAsr=$local_voice_asr→$remote_voice_asr"

cat > "$FEATURES_FILE" <<EOFEATURES
{"plan":"${remote_plan}","features":{"voiceAsr":${remote_voice_asr}}}
EOFEATURES
chmod 644 "$FEATURES_FILE"

echo "[feature-sync] Features updated: plan=$remote_plan voiceAsr=$remote_voice_asr"
