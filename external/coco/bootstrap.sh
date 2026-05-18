#!/usr/bin/env bash
#
# bootstrap.sh — COCO AI VM boot-time bootstrap.
#
# Baked into the Golden Image at /opt/coco/bootstrap.sh.
# Triggered by coco-bootstrap.service on first boot.
#
# Reads GCE instance metadata and Secret Manager to configure
# and start the appropriate agent application (openclaw or zylos).
#
# Prerequisites (provided by Golden Image):
#   - Ubuntu 24.04, Node.js 22 (nvm under cocoai), Caddy, jq, curl
#   - VM service account with roles/secretmanager.secretAccessor
#
set -euo pipefail

readonly BOOTSTRAP_FLAG="/opt/coco/bootstrap-complete"
readonly LOG_FILE="/var/log/coco-bootstrap.log"
readonly METADATA_URL="http://metadata.google.internal/computeMetadata/v1"
readonly METADATA_HEADER="Metadata-Flavor: Google"

# ── Logging ──────────────────────────────────────────────────────────
install -m 600 /dev/null "${LOG_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

log()  { printf '[bootstrap %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FATAL: $*"; exit 1; }

# ── Helpers ──────────────────────────────────────────────────────────
metadata_get() {
  local path="$1"
  local response
  if ! response=$(curl -sf --max-time 10 --retry 3 --retry-delay 2 \
    -H "${METADATA_HEADER}" "${METADATA_URL}/${path}"); then
    echo ""
    return 1
  fi
  echo "${response}"
}

json_field() {
  echo "${SECRET_JSON}" | jq -r ".${1} // empty"
}

# ── OpenClaw installation ────────────────────────────────────────────
# Uses a QUOTED heredoc (<<'EOSCRIPT') to prevent shell injection from
# secret values. All config is passed via exported environment variables.
install_openclaw() {
  # Channel credentials (feishu, telegram) are NOT configured here.
  # Channel plugins and config are deployed by the provision service's
  # configureOpenClawChannel() after the VM is online — configuring them
  # here causes "duplicate plugin id" warnings that fail the deploy chain.
  export COCO_CLAUDE_SETUP_TOKEN="${CLAUDE_SETUP_TOKEN}"
  export COCO_CLAUDE_OAUTH_TOKEN="${CLAUDE_OAUTH_TOKEN}"
  export COCO_PROVIDER_ACCESS_TOKEN="${PROVIDER_ACCESS_TOKEN}"
  export COCO_PROVIDER_ACCESS_TOKEN_EXPIRES_AT="${PROVIDER_ACCESS_TOKEN_EXPIRES_AT}"
  export COCO_PROVIDER_ACCOUNT_ID="${PROVIDER_ACCOUNT_ID}"
  export COCO_DOMAIN="${DOMAIN}"
  export COCO_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
  export COCO_DASHBOARD_ORIGIN="${DASHBOARD_ORIGIN}"
  export COCO_INTERNAL_IP="${INTERNAL_IP}"
  export COCO_LLM_PROVIDER="${LLM_PROVIDER}"
  export COCO_LLM_MODEL="${LLM_MODEL}"
  export COCO_OPENCLAW_VERSION="${OPENCLAW_VERSION}"

  # Enable lingering BEFORE entering cocoai context so systemd user session bus is available
  loginctl enable-linger cocoai 2>/dev/null || true

  sudo --preserve-env=COCO_CLAUDE_SETUP_TOKEN,COCO_CLAUDE_OAUTH_TOKEN,COCO_PROVIDER_ACCESS_TOKEN,COCO_PROVIDER_ACCESS_TOKEN_EXPIRES_AT,COCO_PROVIDER_ACCOUNT_ID,COCO_DOMAIN,COCO_GATEWAY_TOKEN,COCO_DASHBOARD_ORIGIN,COCO_INTERNAL_IP,COCO_LLM_PROVIDER,COCO_LLM_MODEL,COCO_OPENCLAW_VERSION \
    -iu cocoai bash <<'EOSCRIPT' || fail "OpenClaw installation failed"
set -euo pipefail

export NVM_DIR="${HOME}/.nvm"
source "${NVM_DIR}/nvm.sh"

# ── OpenClaw install (skip if pre-installed in golden image) ──
OPENCLAW_VERSION="${COCO_OPENCLAW_VERSION:-latest}"
INSTALLED_OPENCLAW_VERSION="$(openclaw --version 2>/dev/null || true)"

if [[ -n "${INSTALLED_OPENCLAW_VERSION}" && "${OPENCLAW_VERSION}" == "latest" ]]; then
  echo "OpenClaw already installed (${INSTALLED_OPENCLAW_VERSION}), skipping npm install."
elif [[ -n "${INSTALLED_OPENCLAW_VERSION}" && "${INSTALLED_OPENCLAW_VERSION}" == "${OPENCLAW_VERSION}" ]]; then
  echo "OpenClaw ${INSTALLED_OPENCLAW_VERSION} matches requested version, skipping npm install."
else
  echo "Installing OpenClaw ${OPENCLAW_VERSION} ..."
  npm install -g "openclaw@${OPENCLAW_VERSION}"
fi
npm ls -g @larksuiteoapi/node-sdk >/dev/null 2>&1 || npm install -g @larksuiteoapi/node-sdk@latest
echo "OpenClaw version: $(openclaw --version 2>/dev/null || echo 'unknown')"

# ── Configuration (built safely with jq) ──
OPENCLAW_DIR="${HOME}/.openclaw"
mkdir -p "${OPENCLAW_DIR}"
chmod 700 "${OPENCLAW_DIR}"

CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"

# Base config only — no channel config here.
# Channel plugins and credentials are deployed by the provision service's
# configureOpenClawChannel() after the VM comes online.
LLM_PROVIDER="${COCO_LLM_PROVIDER:-anthropic}"
LLM_MODEL="${COCO_LLM_MODEL:-anthropic/claude-opus-4-6}"

# OpenAI OAuth tokens lack api.responses.write scope (OpenAI revoked it from the
# Codex client). Route through chatgpt.com/backend-api/codex instead, which accepts
# the standard Codex OAuth JWT without requiring that scope. Use the "openai-codex"
# provider prefix so OpenClaw selects the Codex backend API path.
if [[ "${LLM_PROVIDER}" == "openai" ]]; then
  LLM_MODEL="${LLM_MODEL/openai\//openai-codex/}"
fi

CONFIG_JSON="$(jq -cn --arg model "${LLM_MODEL}" '{agents:{defaults:{model:{primary:$model},compaction:{mode:"default",model:"anthropic/claude-sonnet-4-6",reserveTokensFloor:40000},contextPruning:{mode:"cache-ttl",ttl:"1h"}}}}')"
echo "${CONFIG_JSON}" | jq '.' > "${CONFIG_FILE}"

# ── Gateway config ──
openclaw config set gateway.mode local 2>/dev/null || true
openclaw config set gateway.trustedProxies '["127.0.0.1"]' 2>/dev/null || true
openclaw config set gateway.controlUi.dangerouslyDisableDeviceAuth true 2>/dev/null || true
if [[ -n "${COCO_DASHBOARD_ORIGIN}" ]]; then
  ALLOWED_ORIGINS_JSON="$(jq -cn --arg origin "${COCO_DASHBOARD_ORIGIN}" '[$origin]')"
  openclaw config set gateway.controlUi.allowedOrigins "${ALLOWED_ORIGINS_JSON}" 2>/dev/null || true
fi
if [[ -n "${COCO_GATEWAY_TOKEN}" ]]; then
  openclaw config set gateway.auth.mode token 2>/dev/null || true
  openclaw config set gateway.auth.token "${COCO_GATEWAY_TOKEN}" 2>/dev/null || true
else
  FALLBACK_GATEWAY_TOKEN="$(openssl rand -hex 24)"
  openclaw config set gateway.auth.mode token 2>/dev/null || true
  openclaw config set gateway.auth.token "${FALLBACK_GATEWAY_TOKEN}" 2>/dev/null || true
  echo "WARNING: COCO_GATEWAY_TOKEN missing, fallback token generated during bootstrap."
fi
openclaw doctor --fix 2>/dev/null || true

# ── Auth ──
if [[ -n "${COCO_CLAUDE_SETUP_TOKEN}" ]]; then
  AUTH_DIR="${OPENCLAW_DIR}/agents/main/agent"
  mkdir -p "${AUTH_DIR}"
  jq -n --arg token "${COCO_CLAUDE_SETUP_TOKEN}" \
    '{profiles: {"anthropic:manual": {mode: "token", provider: "anthropic", token: $token}}}' \
    > "${AUTH_DIR}/auth-profiles.json"
  chmod 600 "${AUTH_DIR}/auth-profiles.json"
  openclaw config set "auth.profiles.anthropic:manual.provider" anthropic || echo "WARNING: openclaw config set auth provider failed (non-fatal, auth-profiles.json was written directly)"
  openclaw config set "auth.profiles.anthropic:manual.mode" token || echo "WARNING: openclaw config set auth mode failed (non-fatal, auth-profiles.json was written directly)"
elif [[ -n "${COCO_CLAUDE_OAUTH_TOKEN}" ]]; then
  AUTH_DIR="${OPENCLAW_DIR}/agents/main/agent"
  mkdir -p "${AUTH_DIR}"
  jq -n --arg token "${COCO_CLAUDE_OAUTH_TOKEN}" \
    '{profiles: {"anthropic:manual": {mode: "token", provider: "anthropic", token: $token}}}' \
    > "${AUTH_DIR}/auth-profiles.json"
  chmod 600 "${AUTH_DIR}/auth-profiles.json"
  openclaw config set "auth.profiles.anthropic:manual.provider" anthropic || echo "WARNING: openclaw config set auth provider failed (non-fatal, auth-profiles.json was written directly)"
  openclaw config set "auth.profiles.anthropic:manual.mode" token || echo "WARNING: openclaw config set auth mode failed (non-fatal, auth-profiles.json was written directly)"
elif [[ "${LLM_PROVIDER}" == "openai" && -n "${COCO_PROVIDER_ACCESS_TOKEN}" ]]; then
  COCOAI_HOME="$(getent passwd cocoai | cut -d: -f6)"
  TOKEN_DIR="${COCOAI_HOME}/.coco"
  install -d -m 700 -o cocoai -g cocoai "${TOKEN_DIR}"
  jq -n \
    --arg provider "openai" \
    --arg accessToken "${COCO_PROVIDER_ACCESS_TOKEN}" \
    --arg expiresAt "${COCO_PROVIDER_ACCESS_TOKEN_EXPIRES_AT:-}" \
    --arg providerAccountId "${COCO_PROVIDER_ACCOUNT_ID:-}" \
    --argjson refreshVersion 0 \
    '{
      provider: $provider,
      accessToken: $accessToken,
      providerAccountId: $providerAccountId,
      refreshVersion: $refreshVersion
    }
    | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' \
    | install -m 600 -o cocoai -g cocoai /dev/stdin "${TOKEN_DIR}/provider-access-token.json"
  sudo -u cocoai /opt/coco/apply-provider-token.sh openclaw || echo "WARNING: failed to seed Codex auth.json from provider access token"
fi

# Channel plugins are NOT installed here — the provision service handles
# plugin installation and config via configureOpenClawChannel().

# ── Caddyfile ──
# Channel-specific webhook routes (lark, feishu) are added dynamically by the
# provisioner's ensureCaddyRoute() after channel deployment — not baked into the
# base Caddyfile. This avoids port mismatches when routes change across versions.
INTERNAL_LISTEN_IP="${COCO_INTERNAL_IP:-0.0.0.0}"

sudo tee /etc/caddy/Caddyfile > /dev/null <<EOCADDY
:80 {
	handle /healthz {
		respond "ok" 200
	}
	handle /hooks/* {
		reverse_proxy 127.0.0.1:18789
	}
	handle {
		respond "Access OpenClaw console via coco-dashboard" 403
	}
}

${INTERNAL_LISTEN_IP}:8080 {
	handle {
		reverse_proxy 127.0.0.1:18789
	}
}
EOCADDY

# ── Systemd user service for openclaw-gateway ──
SERVICE_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SERVICE_DIR}"

NODE_BIN="$(dirname "$(which node)")"
NVM_CURRENT="${HOME}/.nvm/current"
ln -sfn "${NODE_BIN}/.." "${NVM_CURRENT}"

cat > "${SERVICE_DIR}/openclaw-gateway.service" <<EOSVC
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=${NVM_CURRENT}/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${NVM_CURRENT}/bin/openclaw gateway --verbose
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOSVC

# Set XDG_RUNTIME_DIR so systemctl --user can connect to D-Bus session bus
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

systemctl --user daemon-reload
systemctl --user enable openclaw-gateway.service
systemctl --user start openclaw-gateway.service

# Try to auto-approve the latest OpenClaw device pairing request.
# This is best-effort: in some runs there may be no pending request yet.
# If approval succeeds, restart gateway to pick up the approved device session.
PAIR_APPROVED=0
for i in {1..6}; do
  if openclaw devices approve --latest >/dev/null 2>&1; then
    PAIR_APPROVED=1
    break
  fi
  sleep 5
done
if [[ "${PAIR_APPROVED}" == "1" ]]; then
  systemctl --user restart openclaw-gateway.service || true
  echo "OpenClaw device pairing approved automatically."
else
  echo "OpenClaw device pairing auto-approve skipped (no pending device or unsupported command)."
fi

# ── Background upgrade to latest (non-blocking) ──
# If pre-installed from golden image, the version may be behind @latest.
# Upgrade in the background so the user can start using the bot immediately.
# Only run when no explicit version was pinned (COCO_OPENCLAW_VERSION=latest
# or unset), since a pinned version means the operator wants that exact version.
if [[ "${COCO_OPENCLAW_VERSION:-latest}" == "latest" ]]; then
  CURRENT_VER="$(openclaw --version 2>/dev/null || true)"
  (
    sleep 15
    export NVM_DIR="${HOME}/.nvm"
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
    npm install -g openclaw@latest 2>/dev/null || exit 0
    npm ls -g @larksuiteoapi/node-sdk >/dev/null 2>&1 || npm install -g @larksuiteoapi/node-sdk@latest 2>/dev/null || true
    NEW_VER="$(openclaw --version 2>/dev/null || true)"
    if [[ -n "${NEW_VER}" && "${NEW_VER}" != "${CURRENT_VER}" ]]; then
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
      systemctl --user restart openclaw-gateway.service 2>/dev/null || true
      echo "[bootstrap bg] OpenClaw upgraded: ${CURRENT_VER} -> ${NEW_VER}, gateway restarted."
    fi
  ) >> "${HOME}/logs/openclaw-upgrade.log" 2>&1 &
  disown
  echo "Background upgrade to openclaw@latest scheduled."
fi

echo "OpenClaw installation complete."
EOSCRIPT

  # Clear exported secrets from root environment
  unset COCO_CLAUDE_SETUP_TOKEN COCO_CLAUDE_OAUTH_TOKEN COCO_PROVIDER_ACCESS_TOKEN
  unset COCO_PROVIDER_ACCESS_TOKEN_EXPIRES_AT COCO_PROVIDER_ACCOUNT_ID COCO_DOMAIN
  unset COCO_GATEWAY_TOKEN COCO_DASHBOARD_ORIGIN COCO_INTERNAL_IP COCO_OPENCLAW_VERSION

  # Start Caddy (system service)
  systemctl enable caddy
  systemctl restart caddy

  log "OpenClaw installed and services started."
}

# ── Zylos installation ───────────────────────────────────────────────
install_zylos() {
  # Pass channel credentials + setup token via env vars (QUOTED heredoc prevents shell expansion)
  export COCO_FEISHU_APP_ID="${FEISHU_APP_ID}"
  export COCO_FEISHU_APP_SECRET="${FEISHU_APP_SECRET}"
  export COCO_FEISHU_VERIFICATION_TOKEN="${FEISHU_VERIFICATION_TOKEN}"
  export COCO_FEISHU_ENCRYPT_KEY="${FEISHU_ENCRYPT_KEY}"
  export COCO_FEISHU_IS_LARK="${FEISHU_IS_LARK}"
  export COCO_FEISHU_CONNECTION_MODE="${FEISHU_CONNECTION_MODE}"
  export COCO_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
  export COCO_WECOM_BOT_ID="${WECOM_BOT_ID}"
  export COCO_WECOM_BOT_SECRET="${WECOM_BOT_SECRET}"
  export COCO_WECOM_AGENT_ID="${WECOM_AGENT_ID}"
  export COCO_WECOM_TOKEN="${WECOM_TOKEN}"
  export COCO_WECOM_ENCODING_AES_KEY="${WECOM_ENCODING_AES_KEY}"
  export COCO_DOMAIN="${DOMAIN}"
  export COCO_INTERNAL_IP="${INTERNAL_IP}"
  export COCO_LLM_PROVIDER="${LLM_PROVIDER}"
  export COCO_PROVIDER_ACCESS_TOKEN="${PROVIDER_ACCESS_TOKEN}"
  # OpenAI provider path must not inject provider token into Claude auth env.
  if [[ "${COCO_LLM_PROVIDER,,}" == "openai" ]]; then
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_SETUP_TOKEN:-${CLAUDE_OAUTH_TOKEN:-}}"
  else
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_SETUP_TOKEN:-${CLAUDE_OAUTH_TOKEN:-${COCO_PROVIDER_ACCESS_TOKEN:-}}}"
  fi
  if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN}" ]]; then
    unset CLAUDE_CODE_OAUTH_TOKEN
  fi
  # Pre-write WEB_CONSOLE_PASSWORD directly to cocoai's .env as root.
  # This bypasses the unreliable env-var-through-sudo path: `sudo -i` (login
  # shell) sources cocoai's profile scripts, which may clear env vars that
  # --preserve-env passed in.  When WEB_CONSOLE_PASSWORD is absent from
  # process.env, zylos init generates a *random* password and stores it as
  # ZYLOS_WEB_PASSWORD — which mismatches the password the Orchestrator already
  # persisted in its DB, causing all subsequent web-console auth attempts to
  # fail (HTTP 401 → WebSocket 1011).  Writing the file here (before the sudo
  # heredoc) ensures ensureWebConsolePassword() always finds the value and
  # never falls through to random generation.
  COCOAI_HOME="/home/cocoai"
  COCOAI_ENV="${COCOAI_HOME}/zylos/.env"
  mkdir -p "${COCOAI_HOME}/zylos"
  # Use printf to avoid echo interpreting escape sequences in the password.
  printf 'WEB_CONSOLE_PASSWORD=%s\n' "${WC_PASSWORD}" > "${COCOAI_ENV}"
  chown cocoai:cocoai "${COCOAI_ENV}"
  chmod 600 "${COCOAI_ENV}"

  # Ensure the entire zylos directory tree is owned by cocoai before handing
  # control to the sudo heredoc.  mkdir -p runs as root, so any directories
  # created above (zylos/ itself, and any subdirs written by earlier steps) are
  # root-owned by default — which causes zylos init to fail when it tries to
  # create .zylos/ inside.  This chown -R is a belt-and-suspenders guard that
  # catches any future root-owned paths added to this section without an
  # explicit chown.
  chown -R cocoai:cocoai "${COCOAI_HOME}/zylos"

  # Also export for --preserve-env in case zylos reads process.env directly
  # (defense-in-depth; the .env file above is the reliable path).
  export WEB_CONSOLE_PASSWORD="${WC_PASSWORD}"

  sudo --preserve-env=COCO_FEISHU_APP_ID,COCO_FEISHU_APP_SECRET,COCO_FEISHU_VERIFICATION_TOKEN,COCO_FEISHU_ENCRYPT_KEY,COCO_FEISHU_IS_LARK,COCO_FEISHU_CONNECTION_MODE,COCO_TELEGRAM_BOT_TOKEN,COCO_WECOM_BOT_ID,COCO_WECOM_BOT_SECRET,COCO_WECOM_AGENT_ID,COCO_WECOM_TOKEN,COCO_WECOM_ENCODING_AES_KEY,COCO_DOMAIN,COCO_INTERNAL_IP,COCO_LLM_PROVIDER,COCO_PROVIDER_ACCESS_TOKEN,CLAUDE_CODE_OAUTH_TOKEN,WEB_CONSOLE_PASSWORD \
    -iu cocoai bash <<'EOSCRIPT' || fail "Zylos installation failed"
set -euo pipefail

export NVM_DIR="${HOME}/.nvm"
source "${NVM_DIR}/nvm.sh"
export PATH="${HOME}/.local/bin:${PATH}"

# ── Install zylos-core CLI ──
# Force all git operations to use HTTPS (VM has no GitHub SSH deploy key).
# npm sometimes resolves GitHub repo URLs via git+ssh, which fails without a key.
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
git config --global url."https://github.com/".insteadOf "git@github.com:"

# Use tarball URL to avoid npm's git+ssh resolution entirely.
npm install -g --install-links https://github.com/zylos-ai/zylos-core/tarball/main
echo "Zylos installed: $(zylos --version 2>/dev/null || echo 'installed')"

# ── Fix /tmp symlink issue (#1504) ──
# npm install -g --install-links extracts the GitHub tarball into /tmp and creates
# a symlink from node_modules/zylos → /tmp/zylos-core-<tag>. On VM reboot,
# systemd-tmpfiles-clean removes /tmp entries older than 10 days, leaving a
# dangling symlink that breaks all zylos services.
# Fix: replace the symlink with a real copy of the directory contents.
ZYLOS_MODULE="$(npm root -g)/zylos"
if [ -L "$ZYLOS_MODULE" ]; then
  LINK_TARGET="$(readlink -f "$ZYLOS_MODULE" 2>/dev/null || true)"
  if [[ "$LINK_TARGET" == /tmp/* ]]; then
    echo "Replacing /tmp symlink with real copy: $ZYLOS_MODULE → $LINK_TARGET"
    cp -rL "$ZYLOS_MODULE" "${ZYLOS_MODULE}.real"
    rm -f "$ZYLOS_MODULE"
    mv "${ZYLOS_MODULE}.real" "$ZYLOS_MODULE"
    echo "Symlink replaced. zylos version: $(zylos --version 2>/dev/null || echo 'ok')"
  fi
fi

# ── Pre-write runtime config BEFORE zylos init ──
# zylos init starts PM2 services including activity-monitor. The activity-monitor
# reads config.json to determine the runtime (claude vs codex). Without this
# pre-write, the runtime field is missing → defaults to "claude" → openai
# instances get stuck in an auth_failed loop. (Fixes #981)
ZYLOS_CONFIG="${HOME}/zylos/.zylos/config.json"
if [[ "${COCO_LLM_PROVIDER,,}" == "openai" ]]; then
  PRE_RUNTIME="codex"
else
  PRE_RUNTIME="claude"
fi
mkdir -p "$(dirname "${ZYLOS_CONFIG}")"
printf '{"runtime":"%s"}\n' "${PRE_RUNTIME}" > "${ZYLOS_CONFIG}"
chmod 644 "${ZYLOS_CONFIG}"
echo "Pre-wrote runtime='${PRE_RUNTIME}' to config.json (before zylos init)"

# ── Initialize zylos (non-interactive) ──
# --yes: skips all prompts, auto-detects timezone, starts PM2 services
# --no-caddy: Caddy is configured separately by bootstrap.sh
# CLAUDE_CODE_OAUTH_TOKEN: auto-detected by zylos init for Claude auth
# WEB_CONSOLE_PASSWORD: auto-detected by zylos init for web console
cd "${HOME}" && zylos init --yes --no-caddy
echo "Zylos initialized."

# ── Install pre-baked WeCom component (if present) ──
WECOM_PRESET_SRC="/opt/coco/preset-components/wecom"
WECOM_SKILL_DIR="${HOME}/zylos/.claude/skills/wecom"
WECOM_DATA_DIR="${HOME}/zylos/components/wecom"
WECOM_COMPONENTS_FILE="${HOME}/zylos/.zylos/components.json"
if [[ -d "${WECOM_PRESET_SRC}" && ! -d "${WECOM_SKILL_DIR}" ]]; then
  mkdir -p "$(dirname "${WECOM_SKILL_DIR}")" "${WECOM_DATA_DIR}" "$(dirname "${WECOM_COMPONENTS_FILE}")"
  cp -R "${WECOM_PRESET_SRC}" "${WECOM_SKILL_DIR}"
  if [[ -f "${WECOM_SKILL_DIR}/hooks/post-install.js" ]]; then
    node "${WECOM_SKILL_DIR}/hooks/post-install.js" >/tmp/wecom-post-install.log 2>&1 || {
      echo "WARNING: WeCom post-install hook failed:"
      cat /tmp/wecom-post-install.log
    }
    rm -f /tmp/wecom-post-install.log
  fi

  WECOM_VERSION="$(node -p "try { require('${WECOM_SKILL_DIR}/package.json').version || '0.0.0' } catch { '0.0.0' }")"
  if [[ -f "${WECOM_COMPONENTS_FILE}" ]]; then
    TMP_COMPONENTS="$(mktemp)"
    jq --arg version "${WECOM_VERSION}" \
       --arg skillDir "${WECOM_SKILL_DIR}" \
       --arg dataDir "${WECOM_DATA_DIR}" \
       '.wecom = {
         version: $version,
         repo: "zylos-ai/zylos-wecom",
         type: "declarative",
         isThirdParty: false,
         installedAt: (now | todateiso8601),
         skillDir: $skillDir,
         dataDir: $dataDir,
         tag: "v0.1.3"
       }' "${WECOM_COMPONENTS_FILE}" > "${TMP_COMPONENTS}" && mv "${TMP_COMPONENTS}" "${WECOM_COMPONENTS_FILE}"
  else
    cat > "${WECOM_COMPONENTS_FILE}" <<EOF
{
  "wecom": {
    "version": "${WECOM_VERSION}",
    "repo": "zylos-ai/zylos-wecom",
    "type": "declarative",
    "isThirdParty": false,
    "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "skillDir": "${WECOM_SKILL_DIR}",
    "dataDir": "${WECOM_DATA_DIR}",
    "tag": "v0.1.3"
  }
}
EOF
  fi
  echo "Pre-baked WeCom component installed (tag: v0.1.3)."
fi

# ── Install preset capability bundles ──
CAPABILITIES_SRC="/opt/coco/capabilities"
CAPABILITIES_DST="${HOME}/zylos/capabilities"

if [[ -d "${CAPABILITIES_SRC}" ]]; then
  mkdir -p "${CAPABILITIES_DST}"
  cp -r "${CAPABILITIES_SRC}/." "${CAPABILITIES_DST}/"

  # Install role-manager CLI and make helper scripts executable
  mkdir -p "${HOME}/.local/bin"
  cp "${CAPABILITIES_DST}/role-manager/role-manager.sh" "${HOME}/.local/bin/role-manager"
  chmod +x "${HOME}/.local/bin/role-manager"
  chmod +x "${CAPABILITIES_DST}/role-manager/role-sync-check.sh"

  # Set default active role
  echo "general-assistant" > "${CAPABILITIES_DST}/.active-role"

  # Generate initial active-role.md from general-assistant bundle
  MEMORY_DIR="${HOME}/zylos/memory"
  mkdir -p "${MEMORY_DIR}"
  {
    echo "---"
    echo "# Active Role: general-assistant"
    echo "# Default role set at bootstrap. Use role-manager to change."
    echo "---"
    echo ""
    cat "${CAPABILITIES_DST}/general-assistant/system-prompt.md"
  } > "${MEMORY_DIR}/active-role.md"

  # Add role injection SessionStart hook to zylos .claude/settings.json
  ZYLOS_SETTINGS="${HOME}/zylos/.claude/settings.json"
  if [[ -f "${ZYLOS_SETTINGS}" ]]; then
    # Install hook script
    mkdir -p "${HOME}/zylos/.claude/skills/role-manager"
    cp "${CAPABILITIES_DST}/role-manager/role-inject-hook.sh" \
       "${HOME}/zylos/.claude/skills/role-manager/role-inject-hook.sh"
    chmod +x "${HOME}/zylos/.claude/skills/role-manager/role-inject-hook.sh"

    # Inject new SessionStart hook entry using jq
    HOOK_CMD="bash ${HOME}/zylos/.claude/skills/role-manager/role-inject-hook.sh"
    UPDATED_SETTINGS=$(jq --arg cmd "${HOOK_CMD}" '
      .hooks.SessionStart[0].hooks += [{
        "type": "command",
        "command": $cmd,
        "timeout": 3000
      }]
    ' "${ZYLOS_SETTINGS}")
    if [ -z "${UPDATED_SETTINGS}" ]; then
      echo "Warning: jq failed to update ${ZYLOS_SETTINGS} — role injection hook not added."
    else
      echo "${UPDATED_SETTINGS}" > "${ZYLOS_SETTINGS}"
      echo "Role injection hook added to SessionStart."
    fi
  fi

  # Install foundation.md to memory (injected at every session start, all roles)
  FOUNDATION_SRC="${CAPABILITIES_DST}/foundation/foundation.md"
  if [[ -f "${FOUNDATION_SRC}" ]]; then
    cp "${FOUNDATION_SRC}" "${MEMORY_DIR}/foundation.md"
    echo "Foundation capabilities installed to memory."
  fi

  echo "Capability bundles installed (13 roles). Default: general-assistant."

  # ── Patch CLAUDE.md with coco-specific onboarding supplement ──
  # Appends a preset roles section so the bot introduces available roles to
  # new users during onboarding Step 2 — across all channels (Telegram, Lark,
  # Web Console). The <!-- coco-capabilities:begin/end --> markers allow
  # idempotent re-application on re-bootstrap.
  CLAUDE_MD="${HOME}/zylos/CLAUDE.md"
  if [[ -f "${CLAUDE_MD}" ]] && ! grep -q 'coco-capabilities:begin' "${CLAUDE_MD}"; then
    cat >> "${CLAUDE_MD}" << 'EOONBOARD'

<!-- coco-capabilities:begin -->
## Preset Agent Roles

This instance has 13 specialist roles pre-installed on the VM. They are ready immediately — no installation needed. Users can switch roles at any time from any channel.

**How users activate roles:**
- In conversation: say "switch to [role name]" or "act as a [role]"
- CLI: `role-manager activate <role-id>` then `/clear` to reload the session
- List all roles: `role-manager list`

**During onboarding Step 2**, if the user has no specific task, introduce the preset roles. Say something like: *"I come with 13 specialist roles pre-installed — competitive intelligence, code review, financial analysis, and more. Just tell me what you need and I'll activate the right one, or say 'show me your roles' to see the full list."*

**Available roles:**
- 🤖 `general-assistant` — Versatile assistant for any task (default)
- 🔍 `competitive-intelligence` — Market monitoring & competitor tracking
- 📱 `social-media` — Content creation & trend research
- 👥 `recruitment` — JD writing & candidate screening
- 📄 `document-analysis` — Document review & key info extraction
- 💻 `code-review` — Code quality & security review
- ⚖️ `contract-review` — Legal contract analysis & risk flagging
- 📊 `financial-analyst` — Financial modeling & report interpretation
- 🔍 `seo-strategist` — SEO audits & content optimization
- 📈 `data-analyst` — Data analysis & visualization
- 🎯 `product-manager` — PRD writing & feature scoping
- 🔬 `research-analyst` — Deep research & synthesis
- 🛠️ `tech-researcher` — Technology scouting & evaluation
<!-- coco-capabilities:end -->
EOONBOARD
    echo "Preset roles capability guide appended to CLAUDE.md."
  fi
else
  echo "WARNING: Capability bundles not found at ${CAPABILITIES_SRC}. Skipping."
fi

# ── Set up voice-asr (gated by features.json) ──
# NOTE: features.json is written AFTER install_zylos() returns,
# in the main flow (see "Write features.json" section below step 5).
# Creates ~/zylos/bin/transcribe — the stable entry point called by all IM bots.
# The wrapper checks features.json before running; exits with a message if disabled.
# Requires /opt/coco/voice-asr/transcribe.py (installed by setup-base.sh).
VOICE_ASR_SCRIPT="/opt/coco/voice-asr/transcribe.py"
VOICE_ASR_BIN="${HOME}/zylos/bin/transcribe"
if [[ -f "${VOICE_ASR_SCRIPT}" ]]; then
  mkdir -p "${HOME}/zylos/bin"
  cat > "${VOICE_ASR_BIN}" <<'EOWRAPPER'
#!/bin/sh
# voice-asr: transcribe audio to text via Whisper
# Usage: transcribe <audio_file>
# Checks plan-based feature flag before running.

FEATURES_FILE="${HOME}/zylos/.features.json"
if [ -f "$FEATURES_FILE" ]; then
  ENABLED=$(python3 -c "import json,sys;print(json.load(open('$FEATURES_FILE')).get('features',{}).get('voiceAsr',False))" 2>/dev/null || echo "False")
  if [ "$ENABLED" != "True" ]; then
    echo "Voice ASR is not included in your current plan. Upgrade to Pro or Ultra to unlock this feature." >&2
    exit 1
  fi
fi

exec python3 /opt/coco/voice-asr/transcribe.py "$@"
EOWRAPPER
  chmod 755 "${VOICE_ASR_BIN}"
  echo "Voice ASR wrapper created: ${VOICE_ASR_BIN}"
else
  echo "Voice-asr script not found — voice ASR not available on this instance."
fi

# ── Sync web console password variable name ──
# zylos init writes ZYLOS_WEB_PASSWORD but web-console server.js reads
# WEB_CONSOLE_PASSWORD. Copy the value under the expected name if missing.
# Uses sed text substitution to avoid expanding the secret value in shell.
ZYLOS_ENV="${HOME}/zylos/.env"
if grep -q '^ZYLOS_WEB_PASSWORD=' "${ZYLOS_ENV}" && ! grep -q '^WEB_CONSOLE_PASSWORD=' "${ZYLOS_ENV}"; then
  sed -n 's/^ZYLOS_WEB_PASSWORD=/WEB_CONSOLE_PASSWORD=/p' "${ZYLOS_ENV}" >> "${ZYLOS_ENV}"
  echo "Web console password synced (ZYLOS_WEB_PASSWORD -> WEB_CONSOLE_PASSWORD)."
fi

# ── Inject domain and networking info into zylos memory ──
ZYLOS_REFS="${HOME}/zylos/memory/references.md"
if [[ -f "${ZYLOS_REFS}" && -n "${COCO_DOMAIN}" ]]; then
  cat >> "${ZYLOS_REFS}" <<EONET

## Networking
- **Domain**: ${COCO_DOMAIN}
- **Internal IP**: ${COCO_INTERNAL_IP}
- **Reverse Proxy**: Caddy on port 80 (system service at /etc/caddy/Caddyfile)
- **External HTTPS**: Handled by Cloudflare (SSL termination before reaching this VM)
- All internal services must be exposed through Caddy reverse proxy on port 80
- Caddy listens on :80, Cloudflare handles HTTPS → HTTP forwarding
- To add a new service route, update /etc/caddy/Caddyfile and run: sudo systemctl reload caddy
EONET
  echo "Domain and networking info injected into zylos memory."
fi

# ── Deploy channel credentials to .env ──
# Note: CLAUDE_CODE_OAUTH_TOKEN and WEB_CONSOLE_PASSWORD are handled by zylos init above.
# Only channel-specific credentials need manual deployment here.
ZYLOS_ENV="${HOME}/zylos/.env"

if [[ -n "${COCO_TELEGRAM_BOT_TOKEN}" ]]; then
  sed -i '/^TELEGRAM_BOT_TOKEN=/d' "${ZYLOS_ENV}" 2>/dev/null || true
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "${COCO_TELEGRAM_BOT_TOKEN}" >> "${ZYLOS_ENV}"
  echo "Telegram bot token deployed."
fi

if [[ -n "${COCO_FEISHU_APP_ID}" ]]; then
  if [[ "${COCO_FEISHU_IS_LARK}" =~ ^[Yy]$ ]]; then
    # Lark (international): use LARK_* env vars + components/lark/
    sed -i '/^LARK_APP_ID=/d; /^LARK_APP_SECRET=/d; /^FEISHU_IS_LARK=/d' "${ZYLOS_ENV}" 2>/dev/null || true
    printf 'FEISHU_IS_LARK=Y\n' >> "${ZYLOS_ENV}"
    printf 'LARK_APP_ID=%s\n' "${COCO_FEISHU_APP_ID}" >> "${ZYLOS_ENV}"
    printf 'LARK_APP_SECRET=%s\n' "${COCO_FEISHU_APP_SECRET}" >> "${ZYLOS_ENV}"

    COMPONENT_DIR="${HOME}/zylos/components/lark"
    mkdir -p "${COMPONENT_DIR}"
    CONFIG_PATCH='{}'
    if [[ -n "${COCO_FEISHU_VERIFICATION_TOKEN}" ]]; then
      CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg t "${COCO_FEISHU_VERIFICATION_TOKEN}" '.bot.verification_token = $t')
    fi
    if [[ -n "${COCO_FEISHU_ENCRYPT_KEY}" ]]; then
      CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg k "${COCO_FEISHU_ENCRYPT_KEY}" '.bot.encrypt_key = $k')
    fi
    echo "${CONFIG_PATCH}" | jq '.' > "${COMPONENT_DIR}/config.json"
    echo "Lark credentials deployed."
  else
    # Feishu (China): use FEISHU_* env vars + components/feishu/
    sed -i '/^FEISHU_APP_ID=/d; /^FEISHU_APP_SECRET=/d; /^FEISHU_IS_LARK=/d' "${ZYLOS_ENV}" 2>/dev/null || true
    printf 'FEISHU_IS_LARK=N\n' >> "${ZYLOS_ENV}"
    printf 'FEISHU_APP_ID=%s\n' "${COCO_FEISHU_APP_ID}" >> "${ZYLOS_ENV}"
    printf 'FEISHU_APP_SECRET=%s\n' "${COCO_FEISHU_APP_SECRET}" >> "${ZYLOS_ENV}"

    COMPONENT_DIR="${HOME}/zylos/components/feishu"
    mkdir -p "${COMPONENT_DIR}"
    FEISHU_CONN_MODE="${COCO_FEISHU_CONNECTION_MODE:-webhook}"
    if [[ "${FEISHU_CONN_MODE}" == "websocket" ]]; then
      CONFIG_PATCH='{"connection_mode":"websocket"}'
    else
      CONFIG_PATCH='{"connection_mode":"webhook","webhook_port":3458}'
      if [[ -n "${COCO_FEISHU_VERIFICATION_TOKEN}" ]]; then
        CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg t "${COCO_FEISHU_VERIFICATION_TOKEN}" '.bot.verification_token = $t')
      fi
      if [[ -n "${COCO_FEISHU_ENCRYPT_KEY}" ]]; then
        CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg k "${COCO_FEISHU_ENCRYPT_KEY}" '.bot.encrypt_key = $k')
      fi
    fi
    echo "${CONFIG_PATCH}" | jq '.' > "${COMPONENT_DIR}/config.json"
    echo "Feishu credentials deployed (mode: ${FEISHU_CONN_MODE})."
  fi
fi

if [[ -n "${COCO_WECOM_BOT_ID}" ]]; then
  sed -i '/^WECOM_BOT_ID=/d; /^WECOM_BOT_SECRET=/d; /^WECOM_AGENT_ID=/d; /^WECOM_TOKEN=/d; /^WECOM_ENCODING_AES_KEY=/d' "${ZYLOS_ENV}" 2>/dev/null || true
  printf 'WECOM_BOT_ID=%s\n' "${COCO_WECOM_BOT_ID}" >> "${ZYLOS_ENV}"
  [[ -n "${COCO_WECOM_BOT_SECRET}" ]] && printf 'WECOM_BOT_SECRET=%s\n' "${COCO_WECOM_BOT_SECRET}" >> "${ZYLOS_ENV}"
  [[ -n "${COCO_WECOM_AGENT_ID}" ]] && printf 'WECOM_AGENT_ID=%s\n' "${COCO_WECOM_AGENT_ID}" >> "${ZYLOS_ENV}"

  COMPONENT_DIR="${HOME}/zylos/components/wecom"
  mkdir -p "${COMPONENT_DIR}"
  CONFIG_PATCH='{}'
  if [[ -n "${COCO_WECOM_TOKEN}" ]]; then
    CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg t "${COCO_WECOM_TOKEN}" '.bot.token = $t')
  fi
  if [[ -n "${COCO_WECOM_ENCODING_AES_KEY}" ]]; then
    CONFIG_PATCH=$(echo "${CONFIG_PATCH}" | jq --arg k "${COCO_WECOM_ENCODING_AES_KEY}" '.bot.encoding_aes_key = $k')
  fi
  echo "${CONFIG_PATCH}" | jq '.' > "${COMPONENT_DIR}/config.json"
  echo "WeCom credentials deployed."
fi

# Restart PM2 to pick up channel credentials added after init
if [[ -n "${COCO_TELEGRAM_BOT_TOKEN}" || -n "${COCO_FEISHU_APP_ID}" || -n "${COCO_WECOM_BOT_ID}" ]]; then
  pm2 restart all 2>/dev/null || true
  pm2 save 2>/dev/null || true
fi

echo "Zylos installation complete."
EOSCRIPT

  # ── Start pm2-cocoai.service so PM2 has its own systemd supervisor ────────
  # zylos init runs `pm2 startup systemd` which creates and enables the unit,
  # but does not start it — PM2 remains inside coco-bootstrap.service's cgroup.
  # Starting the unit now lets systemd track the running PM2 daemon via its PID
  # file. If PM2 dies for any reason, systemd's Restart=on-failure will resurrect
  # it under pm2-cocoai.service's own cgroup (outside bootstrap's).
  # Combined with KillMode=process in coco-bootstrap.service, this provides
  # defense-in-depth against the needrestart/daemon-reexec kill path.
  # See: https://github.com/coco-xyz/coco-dashboard/issues/1467
  if systemctl is-enabled pm2-cocoai.service &>/dev/null; then
    if systemctl start pm2-cocoai.service; then
      log "pm2-cocoai.service started (PM2 supervised by its own systemd unit)"
    else
      log "WARNING: pm2-cocoai.service start failed (non-fatal, PM2 still running in bootstrap cgroup)"
    fi
  else
    log "pm2-cocoai.service not found or not enabled — skipping (zylos init may not have created it)"
  fi

  # ── Sync actual VM web console password back to Orchestrator DB ──────────
  # After zylos init runs, read whatever password it actually stored and write
  # it back to the Orchestrator. This ensures the DB always reflects the VM's
  # real password — even if zylos generated a random one (old zylos version,
  # sudo env-stripping, etc.) instead of using the one the Orchestrator issued.
  # Non-fatal: failure falls back to gatewayToken auth path.
  if [[ -n "${EMPLOYEE_ID}" && -n "${INTERNAL_API_SECRET}" && -n "${CONTROL_PLANE_URL}" ]]; then
    _COCOAI_ENV="/home/cocoai/zylos/.env"
    _WC_PASS="$(grep '^ZYLOS_WEB_PASSWORD=' "${_COCOAI_ENV}" 2>/dev/null | sed 's/^ZYLOS_WEB_PASSWORD=//' | head -1)"
    [[ -z "${_WC_PASS}" ]] && \
      _WC_PASS="$(grep '^WEB_CONSOLE_PASSWORD=' "${_COCOAI_ENV}" 2>/dev/null | sed 's/^WEB_CONSOLE_PASSWORD=//' | head -1)"
    if [[ -n "${_WC_PASS}" ]]; then
      _PAYLOAD="$(jq -cn --arg p "${_WC_PASS}" '{"password":$p}')"
      if curl -sf -X PUT "${CONTROL_PLANE_URL}/v1/internal/instances/${EMPLOYEE_ID}/wc-password" \
          -H "X-Internal-Token: ${INTERNAL_API_SECRET}" \
          -H "Content-Type: application/json" \
          -d "${_PAYLOAD}"; then
        log "WC password synced to Orchestrator DB."
      else
        log "WC password sync failed (non-fatal, auth may fall back to gatewayToken)."
      fi
      unset _WC_PASS _PAYLOAD
    else
      log "WC password not found in cocoai .env — skipping DB sync."
    fi
    unset _COCOAI_ENV
  fi

  # Clear exported secrets from root environment
  unset COCO_FEISHU_APP_ID COCO_FEISHU_APP_SECRET COCO_FEISHU_VERIFICATION_TOKEN COCO_FEISHU_ENCRYPT_KEY COCO_FEISHU_IS_LARK COCO_FEISHU_CONNECTION_MODE
  unset COCO_TELEGRAM_BOT_TOKEN COCO_DOMAIN COCO_INTERNAL_IP COCO_LLM_PROVIDER COCO_PROVIDER_ACCESS_TOKEN
  unset CLAUDE_CODE_OAUTH_TOKEN WEB_CONSOLE_PASSWORD

  # ── Caddyfile for zylos ──
  # Channel-specific webhook routes (lark, feishu, wecom) are added dynamically
  # by the provisioner's ensureCaddyRoute() — not baked into the base Caddyfile.
  sudo tee /etc/caddy/Caddyfile > /dev/null <<EOCADDY
:80 {
	handle /healthz {
		respond "ok" 200
	}
	handle {
		reverse_proxy 127.0.0.1:3456
	}
}
EOCADDY

  # Start Caddy (system service)
  systemctl enable caddy
  systemctl restart caddy

  log "Zylos installed and services started."
}

# ── 1. Idempotency check ────────────────────────────────────────────
if [[ -f "${BOOTSTRAP_FLAG}" ]]; then
  log "Bootstrap already completed (${BOOTSTRAP_FLAG} exists). Skipping."
  exit 0
fi

log "Starting COCO AI bootstrap ..."
log "bootstrap.sh sha256=$(sha256sum "$0" | cut -d' ' -f1)"

# ── 2. Read GCE instance metadata ───────────────────────────────────
AGENT_TYPE="$(metadata_get 'instance/attributes/coco-agent-type')"
DOMAIN="$(metadata_get 'instance/attributes/coco-domain')"
CONTROL_PLANE_URL="$(metadata_get 'instance/attributes/coco-control-plane-url')"
INSTANCE_NAME="$(metadata_get 'instance/name')"
INTERNAL_IP="$(metadata_get 'instance/network-interfaces/0/ip')"
GCP_PROJECT="$(metadata_get 'project/project-id')"

# Detect bootstrap mode: token (new) vs SM (legacy)
BOOTSTRAP_TOKEN="$(metadata_get 'instance/attributes/coco-bootstrap-token' 2>/dev/null || true)"
EMPLOYEE_ID_META="$(metadata_get 'instance/attributes/coco-employee-id' 2>/dev/null || true)"
BOOTSTRAP_SECRET_ID="$(metadata_get 'instance/attributes/coco-bootstrap-secret' 2>/dev/null || true)"

[[ -n "${AGENT_TYPE}" ]]        || fail "Missing metadata: coco-agent-type"
[[ -n "${DOMAIN}" ]]            || fail "Missing metadata: coco-domain"
[[ -n "${CONTROL_PLANE_URL}" ]] || fail "Missing metadata: coco-control-plane-url"
[[ -n "${INTERNAL_IP}" ]]       || fail "Missing metadata: instance/network-interfaces/0/ip"
[[ -n "${GCP_PROJECT}" ]]       || fail "Could not determine GCP project ID"

# At least one bootstrap method must be available
if [[ -z "${BOOTSTRAP_TOKEN}" && -z "${BOOTSTRAP_SECRET_ID}" ]]; then
  fail "Missing metadata: either coco-bootstrap-token or coco-bootstrap-secret is required"
fi

log "agent-type=${AGENT_TYPE} domain=${DOMAIN} instance=${INSTANCE_NAME} internal-ip=${INTERNAL_IP}"

# ── 3. Fetch bootstrap config ────────────────────────────────────────
if [[ -n "${BOOTSTRAP_TOKEN}" ]]; then
  # --- TOKEN MODE: pull config from Dashboard API ---
  log "Fetching bootstrap config from Dashboard API (token mode) ..."
  [[ -n "${EMPLOYEE_ID_META}" ]] || fail "Missing metadata: coco-employee-id (required for token mode)"

  BOOTSTRAP_URL="${CONTROL_PLANE_URL}/internal/bootstrap-config?employeeId=${EMPLOYEE_ID_META}"

  SECRET_JSON="$(curl -sf --max-time 30 --retry 5 --retry-delay 5 --retry-max-time 120 \
    -H "Authorization: Bearer ${BOOTSTRAP_TOKEN}" \
    "${BOOTSTRAP_URL}")" || fail "Bootstrap config API call failed"

  log "Bootstrap config fetched successfully (token mode)."
else
  # --- SM MODE (legacy): fetch from Secret Manager ---
  log "Fetching bootstrap secret from Secret Manager ..."
  [[ -n "${BOOTSTRAP_SECRET_ID}" ]] || fail "Missing metadata: coco-bootstrap-secret"

  TOKEN_JSON="$(metadata_get 'instance/service-accounts/default/token')" \
    || fail "Could not reach metadata server for access token"
  SM_ACCESS_TOKEN="$(echo "${TOKEN_JSON}" | jq -r '.access_token // empty')"
  [[ -n "${SM_ACCESS_TOKEN}" ]] || fail "Could not obtain access token from metadata server"

  SM_URL="https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${BOOTSTRAP_SECRET_ID}/versions/latest:access"

  SM_RESPONSE="$(curl -sf --max-time 30 --retry 3 --retry-delay 2 \
    -H "Authorization: Bearer ${SM_ACCESS_TOKEN}" \
    "${SM_URL}")" || fail "Secret Manager API call failed"

  # Payload is base64-encoded in .payload.data
  SECRET_JSON="$(echo "${SM_RESPONSE}" | jq -r '.payload.data' | base64 -d)" \
    || fail "Failed to decode secret payload"

  unset TOKEN_JSON SM_ACCESS_TOKEN SM_RESPONSE
  log "Bootstrap secret fetched successfully (SM mode)."
fi

# ── 4. Extract config from secret payload ────────────────────────────
EMPLOYEE_ID="$(json_field 'employeeId')"
BOOTSTRAP_CALLBACK_SECRET="$(json_field 'bootstrapCallbackSecret')"
CLAUDE_SETUP_TOKEN="$(json_field 'claudeSetupToken')"
CLAUDE_OAUTH_TOKEN="$(echo "${SECRET_JSON}" | jq -r '.claudeOAuthToken.access_token // empty')"
CLAUDE_REFRESH_TOKEN="$(echo "${SECRET_JSON}" | jq -r '.claudeOAuthToken.refresh_token // empty')"
PROVIDER_ACCESS_TOKEN="$(json_field 'providerAccessToken')"
PROVIDER_ACCESS_TOKEN_EXPIRES_AT="$(json_field 'providerAccessTokenExpiresAt')"
PROVIDER_ACCOUNT_ID="$(json_field 'providerAccountId')"
FEISHU_APP_ID="$(json_field 'feishuAppId')"
FEISHU_APP_SECRET="$(json_field 'feishuAppSecret')"
FEISHU_VERIFICATION_TOKEN="$(json_field 'feishuVerificationToken')"
FEISHU_ENCRYPT_KEY="$(json_field 'feishuEncryptKey')"
FEISHU_IS_LARK="$(json_field 'feishuIsLark')"
FEISHU_CONNECTION_MODE="$(json_field 'feishuConnectionMode')"
TELEGRAM_BOT_TOKEN="$(json_field 'telegramBotToken')"
WECOM_BOT_ID="$(json_field 'wecomBotId')"
WECOM_BOT_SECRET="$(json_field 'wecomBotSecret')"
WECOM_AGENT_ID="$(json_field 'wecomAgentId')"
WECOM_TOKEN="$(json_field 'wecomToken')"
WECOM_ENCODING_AES_KEY="$(json_field 'wecomEncodingAesKey')"
GATEWAY_TOKEN="$(json_field 'gatewayToken')"
DASHBOARD_ORIGIN="$(json_field 'dashboardOrigin')"
LLM_PROVIDER="$(json_field 'llmProvider')"
LLM_MODEL="$(json_field 'llmModel')"
OPENCLAW_VERSION="$(json_field 'openclawVersion')"
WC_PASSWORD="$(json_field 'webConsolePassword')"
# Fall back to gatewayToken when webConsolePassword is not provided (Issue #866).
# This happens when VM_ORCH_WC_PASSWORD_ENCRYPTION_KEY is not configured on the
# orchestrator, which causes it to skip wcPassword generation entirely.
if [[ -z "${WC_PASSWORD}" ]]; then
  WC_PASSWORD="${GATEWAY_TOKEN}"
fi
INTERNAL_API_SECRET="$(json_field 'internalApiSecret')"
INSTANCE_PULL_SECRET="$(json_field 'instancePullSecret')"
PLAN_CODE="$(json_field 'planCode')"
OPS_AGENT_API_URL="$(json_field 'opsAgentApiUrl')"
OPS_AGENT_TOKEN="$(json_field 'opsAgentToken')"
OPS_AGENT_GCS_BUCKET="$(json_field 'opsAgentGcsBucket')"

# Clear raw secret data from memory (except Claude tokens needed in step 5b)
unset SECRET_JSON

log "Config extracted: agentType=${AGENT_TYPE} planCode=${PLAN_CODE}"

# ── 5. Install application ──────────────────────────────────────────
case "${AGENT_TYPE}" in
  openclaw)
    [[ -n "${GATEWAY_TOKEN}" ]] || fail "Missing bootstrap secret field: gatewayToken"
    [[ -n "${DASHBOARD_ORIGIN}" ]] || fail "Missing bootstrap secret field: dashboardOrigin"
    log "Installing OpenClaw ..."
    install_openclaw
    ;;
  zylos|claude)
    log "Installing Zylos ..."
    install_zylos
    ;;
  *)
    fail "Unknown agent type: ${AGENT_TYPE}"
    ;;
esac

# ── 5-runtime. Set active runtime in zylos config.json ───────────
# The zylos-core RuntimeAdapter reads ~/.zylos/config.json { "runtime": "claude"|"codex" }
# to decide which AI CLI to launch. Defaults to "claude" when not set.
# For zylos/claude agents: runtime determined by LLM_PROVIDER
#   - anthropic → claude (Claude Code)
#   - openai   → codex  (Codex CLI)
# For openclaw agents: runtime is always "openclaw" (handled by OpenClaw itself)
if [[ "${AGENT_TYPE}" == "zylos" || "${AGENT_TYPE}" == "claude" ]]; then
  COCOAI_HOME="$(getent passwd cocoai | cut -d: -f6)"
  ZYLOS_CONFIG="${COCOAI_HOME}/zylos/.zylos/config.json"
  ZYLOS_CONFIG_TMP="$(mktemp)"
  if [[ "${LLM_PROVIDER,,}" == "openai" ]]; then
    RUNTIME="codex"
  else
    RUNTIME="claude"
  fi
  mkdir -p "$(dirname "${ZYLOS_CONFIG}")"
  if [[ -f "${ZYLOS_CONFIG}" ]] && jq -e . "${ZYLOS_CONFIG}" >/dev/null 2>&1; then
    jq --arg rt "${RUNTIME}" '. + {runtime: $rt}' "${ZYLOS_CONFIG}" > "${ZYLOS_CONFIG_TMP}"
  else
    jq -n --arg rt "${RUNTIME}" '{runtime: $rt}' > "${ZYLOS_CONFIG_TMP}"
  fi
  install -m 644 -o cocoai -g cocoai "${ZYLOS_CONFIG_TMP}" "${ZYLOS_CONFIG}"
  rm -f "${ZYLOS_CONFIG_TMP}"
  log "Runtime set to '${RUNTIME}' in ${ZYLOS_CONFIG}"

  # For Codex runtime: set reasoning effort to medium in ~/.codex/config.toml
  # This balances quality vs speed for customer-facing bots.
  if [[ "${RUNTIME}" == "codex" ]]; then
    CODEX_CONFIG_DIR="${COCOAI_HOME}/.codex"
    CODEX_CONFIG="${CODEX_CONFIG_DIR}/config.toml"
    install -d -m 700 -o cocoai -g cocoai "${CODEX_CONFIG_DIR}"
    CODEX_CONFIG_TMP="$(mktemp)"
    if [[ -f "${CODEX_CONFIG}" ]] && grep -q '^model_reasoning_effort' "${CODEX_CONFIG}"; then
      sed 's/^model_reasoning_effort.*/model_reasoning_effort = "medium"/' "${CODEX_CONFIG}" > "${CODEX_CONFIG_TMP}"
    elif [[ -f "${CODEX_CONFIG}" ]]; then
      cat "${CODEX_CONFIG}" > "${CODEX_CONFIG_TMP}"
      echo 'model_reasoning_effort = "medium"' >> "${CODEX_CONFIG_TMP}"
    else
      echo 'model_reasoning_effort = "medium"' > "${CODEX_CONFIG_TMP}"
    fi
    install -m 644 -o cocoai -g cocoai "${CODEX_CONFIG_TMP}" "${CODEX_CONFIG}"
    rm -f "${CODEX_CONFIG_TMP}"
    log "Codex reasoning effort set to 'medium' in ${CODEX_CONFIG}"
  fi
fi

# ── 5a. Write features.json (plan-based feature flags) ───────────
# Placed here (after config extraction + install) so PLAN_CODE is definitely set.
# Air plan: voice ASR not activated by default (user can install manually).
# Pro/Ultra: voice ASR activated out of the box.
# The feature-sync systemd timer keeps this file updated after plan changes.
if [[ "${AGENT_TYPE}" == "zylos" || "${AGENT_TYPE}" == "claude" ]]; then
  FEATURES_FILE="$(getent passwd cocoai | cut -d: -f6)/zylos/.features.json"
  PLAN_LOWER="$(echo "${PLAN_CODE}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${PLAN_LOWER}" == "pro" || "${PLAN_LOWER}" == "ultra" ]]; then
    VOICE_ASR_ENABLED=true
  else
    VOICE_ASR_ENABLED=false
  fi
  cat > "${FEATURES_FILE}" <<EOFEATURES
{"plan":"${PLAN_LOWER}","features":{"voiceAsr":${VOICE_ASR_ENABLED}}}
EOFEATURES
  chown cocoai:cocoai "${FEATURES_FILE}"
  chmod 644 "${FEATURES_FILE}"
  log "Features file written: plan=${PLAN_LOWER} voiceAsr=${VOICE_ASR_ENABLED}"
fi

# ── 5b. Deploy Claude Code token (setup token or OAuth token) ─────────
# Setup tokens (long-lived, from token pool) take priority over OAuth tokens.
# If neither is available, skip credential deployment.
COCOAI_HOME="$(getent passwd cocoai | cut -d: -f6)"
EFFECTIVE_TOKEN=""
IS_SETUP_TOKEN=false

if [[ -n "${CLAUDE_SETUP_TOKEN}" ]]; then
  log "Deploying Claude Code setup token (long-lived, from token pool) ..."
  EFFECTIVE_TOKEN="${CLAUDE_SETUP_TOKEN}"
  IS_SETUP_TOKEN=true

  # Setup tokens use CLAUDE_CODE_OAUTH_TOKEN env var only — no .credentials.json needed.
  # This avoids empty refreshToken triggering unnecessary refresh attempts.
  install -d -m 700 -o cocoai -g cocoai "${COCOAI_HOME}/.claude"

elif [[ -n "${CLAUDE_OAUTH_TOKEN}" ]]; then
  log "Deploying Claude Code OAuth token ..."
  EFFECTIVE_TOKEN="${CLAUDE_OAUTH_TOKEN}"

  # Claude Code expects expiresAt as epoch milliseconds (not ISO string)
  EXPIRES_AT_MS="$(( $(date -u -d '+8 hours' +%s 2>/dev/null || date -u +%s) * 1000 ))"

  install -d -m 700 -o cocoai -g cocoai "${COCOAI_HOME}/.claude"

  jq -n \
    --arg at "${CLAUDE_OAUTH_TOKEN}" \
    --arg rt "${CLAUDE_REFRESH_TOKEN}" \
    --argjson exp "${EXPIRES_AT_MS}" \
    '{
      claudeAiOauth: {
        accessToken: $at,
        refreshToken: $rt,
        expiresAt: $exp,
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
        scopes: ["user:inference","user:mcp_servers","user:profile","user:sessions:claude_code"]
      }
    }' \
    | install -m 600 -o cocoai -g cocoai /dev/stdin "${COCOAI_HOME}/.claude/.credentials.json"
elif [[ -n "${PROVIDER_ACCESS_TOKEN}" && ( "${AGENT_TYPE}" == "zylos" || "${AGENT_TYPE}" == "claude" ) && "${LLM_PROVIDER,,}" != "openai" ]]; then
  log "Deploying Claude Code access token from control-plane managed OAuth credential ..."
  EFFECTIVE_TOKEN="${PROVIDER_ACCESS_TOKEN}"
  install -d -m 700 -o cocoai -g cocoai "${COCOAI_HOME}/.claude"

fi

if [[ -n "${EFFECTIVE_TOKEN}" ]]; then
  # Detect installed Claude Code version for version-gated dialog suppression
  CLAUDE_CODE_VERSION="$(sudo -u cocoai bash -c 'export PATH="$HOME/.local/bin:$HOME/.claude/local/bin:$PATH" && claude --version 2>/dev/null | head -1 | awk "{print \$1}"' || echo "2.1.69")"
  log "Claude Code version: ${CLAUDE_CODE_VERSION}"

  # Pre-configure .claude.json to suppress ALL interactive dialogs.
  # Without these fields, Claude Code blocks on stdin prompts which causes
  # heartbeat timeout → health=DOWN → restart loop on headless VMs.
  #
  # Dialog inventory (each field suppresses one or more dialogs):
  #   numStartups >= 2       → bypass first-startup checks (root cause of #25503)
  #   hasCompletedOnboarding → skip theme picker + welcome wizard
  #   lastOnboardingVersion  → prevent re-onboarding after upgrade
  #   lastReleaseNotesSeen   → prevent release notes popup
  #   theme                  → prevent theme picker (requires any valid value)
  #   hasTrustDialogAccepted → skip "trust this directory?" per-project dialog
  #   effortCalloutDismissed → skip effort level suggestion popup
  #   remoteDialogSeen       → skip remote control first-use dialog
  #   *MigrationComplete     → skip model migration notices
  jq -n --arg ver "${CLAUDE_CODE_VERSION}" '{
    numStartups: 100,
    theme: "dark",
    autoUpdates: false,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: $ver,
    lastReleaseNotesSeen: $ver,
    hasCompletedClaudeInChromeOnboarding: true,
    remoteDialogSeen: true,
    effortCalloutDismissed: true,
    effortCalloutV2Dismissed: true,
    sonnet45MigrationComplete: true,
    opus45MigrationComplete: true,
    opusProMigrationComplete: true,
    thinkingMigrationComplete: true,
    sonnet1m45MigrationComplete: true,
    subscriptionNoticeCount: 99,
    voiceNoticeSeenCount: 99,
    showSpinnerTree: false,
    projects: {
      "/home/cocoai":       { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, hasClaudeMdExternalIncludesApproved: true, projectOnboardingSeenCount: 5 },
      "/home/cocoai/zylos": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, hasClaudeMdExternalIncludesApproved: true, projectOnboardingSeenCount: 5 }
    }
  }' | install -m 644 -o cocoai -g cocoai /dev/stdin "${COCOAI_HOME}/.claude.json"

  # Merge skipDangerousModePermissionPrompt into existing settings.json
  # (zylos init may have already written env.CLAUDE_CODE_OAUTH_TOKEN there)
  SETTINGS_FILE="${COCOAI_HOME}/.claude/settings.json"
  if [[ -f "${SETTINGS_FILE}" ]]; then
    jq '. + { skipDangerousModePermissionPrompt: true }' "${SETTINGS_FILE}" \
      | install -m 644 -o cocoai -g cocoai /dev/stdin "${SETTINGS_FILE}"
  else
    jq -n '{ skipDangerousModePermissionPrompt: true }' \
      | install -m 644 -o cocoai -g cocoai /dev/stdin "${SETTINGS_FILE}"
  fi

  # Write env file for systemd services
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\nexport CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1\n' "${EFFECTIVE_TOKEN}" \
    | install -m 600 -o cocoai -g cocoai /dev/stdin "${COCOAI_HOME}/.claude-env"

  # Keep zylos runtime env in sync with the latest token assignment.
  # This avoids stale placeholder values in ~/zylos/.env on reused images.
  ZYLOS_ENV_PATH="${COCOAI_HOME}/zylos/.env"
  if [[ -f "${ZYLOS_ENV_PATH}" ]]; then
    sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "${ZYLOS_ENV_PATH}" 2>/dev/null || true
    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "${EFFECTIVE_TOKEN}" >> "${ZYLOS_ENV_PATH}"
    chown cocoai:cocoai "${ZYLOS_ENV_PATH}" 2>/dev/null || true
  fi

  # Seed an initial conversation so `claude --continue` works on first guardian start.
  # Also validates credentials actually work. Run as cocoai user.
  log "Verifying Claude Code auth (seed conversation)..."
  if sudo -u cocoai bash -c 'export PATH="$HOME/.local/bin:$HOME/.claude/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH"; [ -f "$HOME/.claude-env" ] && source "$HOME/.claude-env"; cd ~/zylos && echo "bootstrap auth check" | claude --print --dangerously-skip-permissions 2>&1' | head -5; then
    log "Claude Code auth verified ✅"
  else
    log "WARNING: Claude Code auth verification failed (non-fatal, will retry at next guardian start)"
  fi

  # Restart activity monitor so it picks up the now-valid credentials.
  # IMPORTANT: Do NOT use `pm2 restart --update-env` — it overwrites
  # the correct ecosystem.config.cjs env (NODE_ENV, CLAUDE_BYPASS_PERMISSIONS,
  # ENHANCED_PATH with ~/.claude/bin) with a bare shell env, causing
  # auth failures and missing PATH entries.
  # Instead, delete + re-add from ecosystem.config.cjs so PM2 fully
  # re-evaluates the JS config and picks up the complete env.
  if sudo -u cocoai bash -c 'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" && pm2 delete activity-monitor 2>/dev/null; pm2 start "$HOME/zylos/pm2/ecosystem.config.cjs" --only activity-monitor 2>/dev/null'; then
    log "Activity monitor restarted (re-added from ecosystem.config.cjs)"
  fi

  log "Claude Code token deployed."
elif [[ "${LLM_PROVIDER,,}" == "openai" ]]; then
  # Ensure stale Claude token env does not leak into OpenAI OAuth sessions.
  rm -f "${COCOAI_HOME}/.claude-env"
  ZYLOS_ENV_PATH="${COCOAI_HOME}/zylos/.env"
  if [[ -f "${ZYLOS_ENV_PATH}" ]]; then
    sed -i '/^CLAUDE_CODE_OAUTH_TOKEN=/d' "${ZYLOS_ENV_PATH}" 2>/dev/null || true
    chown cocoai:cocoai "${ZYLOS_ENV_PATH}" 2>/dev/null || true
  fi

  # For zylos+openai: verify Codex CLI auth works after ~/.codex/auth.json
  # is seeded by step 5c below. We verify here conditionally since the
  # token file may not exist yet (it's written in 5c). The actual
  # verification runs post-5c via a deferred check.
  log "OpenAI provider selected — Claude Code auth cleared, Codex auth will be seeded in step 5c."
fi
unset CLAUDE_OAUTH_TOKEN CLAUDE_REFRESH_TOKEN CLAUDE_SETUP_TOKEN EFFECTIVE_TOKEN IS_SETUP_TOKEN

# ── 5c. Seed runtime provider token and agent auth readers ─────────
# Ensure runtime token directories exist with correct ownership even before
# tokens are written, so watcher/sync services started as cocoai can write
# cursor/state files safely.
TOKEN_DIR="${COCOAI_HOME}/.coco"
install -d -m 700 -o cocoai -g cocoai "${TOKEN_DIR}"
install -d -m 700 -o cocoai -g cocoai "${TOKEN_DIR}/.rotation-cursors"

if [[ -n "${PROVIDER_ACCESS_TOKEN}" ]]; then
  jq -n \
    --arg provider "${LLM_PROVIDER:-}" \
    --arg accessToken "${PROVIDER_ACCESS_TOKEN}" \
    --arg expiresAt "${PROVIDER_ACCESS_TOKEN_EXPIRES_AT:-}" \
    --arg providerAccountId "${PROVIDER_ACCOUNT_ID:-}" \
    --argjson refreshVersion 0 \
    '{
      provider: $provider,
      accessToken: $accessToken,
      providerAccountId: $providerAccountId,
      refreshVersion: $refreshVersion
    }
    | if $expiresAt == "" then . else . + {expiresAt: $expiresAt} end' \
    | install -m 600 -o cocoai -g cocoai /dev/stdin "${TOKEN_DIR}/provider-access-token.json"

  if [[ ( "${AGENT_TYPE}" == "zylos" || "${AGENT_TYPE}" == "claude" ) && "${LLM_PROVIDER,,}" != "openai" ]]; then
    SETTINGS_FILE="${COCOAI_HOME}/.claude/settings.json"
    if [[ -f "${SETTINGS_FILE}" ]]; then
      jq '. + { apiKeyHelper: "/opt/coco/provider-token-helper.sh" }' "${SETTINGS_FILE}" \
        | install -m 644 -o cocoai -g cocoai /dev/stdin "${SETTINGS_FILE}"
    else
      jq -n '{ apiKeyHelper: "/opt/coco/provider-token-helper.sh" }' \
        | install -m 644 -o cocoai -g cocoai /dev/stdin "${SETTINGS_FILE}"
    fi
    printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\nexport CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1\n' "${PROVIDER_ACCESS_TOKEN}" \
      | install -m 600 -o cocoai -g cocoai /dev/stdin "${COCOAI_HOME}/.claude-env"
  fi

  sudo -u cocoai /opt/coco/apply-provider-token.sh "${AGENT_TYPE}" || \
    log "WARNING: failed to apply initial provider access token"

  # For zylos/claude + openai: verify Codex auth and restart activity monitor
  # so it detects the openai runtime. The activity monitor reads LLM_PROVIDER
  # from .coco-runtime-env (written in 5e) to decide whether to use Claude
  # Code or Codex as the agent process.
  if [[ ( "${AGENT_TYPE}" == "zylos" || "${AGENT_TYPE}" == "claude" ) && "${LLM_PROVIDER,,}" == "openai" ]]; then
    log "Verifying Codex CLI auth ..."
    if sudo -u cocoai bash -c 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; command -v codex >/dev/null 2>&1 && [ -f "$HOME/.codex/auth.json" ] && echo "codex_auth_ok"' | grep -q 'codex_auth_ok'; then
      log "Codex CLI auth verified ✅"
    else
      log "WARNING: Codex CLI or auth.json not found (non-fatal, will retry at next guardian start)"
    fi

    # Restart activity monitor to pick up the openai runtime config.
    if sudo -u cocoai bash -c 'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" && pm2 delete activity-monitor 2>/dev/null; pm2 start "$HOME/zylos/pm2/ecosystem.config.cjs" --only activity-monitor 2>/dev/null'; then
      log "Activity monitor restarted for Codex runtime"
    fi
  fi
fi

# ── 5d. Deploy usage report config ─────────────────────────────────
if [[ -n "${EMPLOYEE_ID}" && -n "${INTERNAL_API_SECRET}" && -n "${CONTROL_PLANE_URL}" ]]; then
  log "Deploying usage report config ..."
  COCOAI_HOME="$(getent passwd cocoai | cut -d: -f6)"

  {
    echo "INSTANCE_ID=${EMPLOYEE_ID}"
    # Internal routes are registered under /internal/ prefix (v1.7.1+)
    echo "COCO_API_URL=${CONTROL_PLANE_URL}"
    echo "INTERNAL_API_SECRET=${INTERNAL_API_SECRET}"
    # Setup token: pass via env var (no .credentials.json); OAuth: point to credentials file
    if [[ -f "${COCOAI_HOME}/.claude/.credentials.json" ]]; then
      echo "CLAUDE_CREDENTIALS=${COCOAI_HOME}/.claude/.credentials.json"
    fi
    if [[ -f "${COCOAI_HOME}/.claude-env" ]]; then
      grep '^CLAUDE_CODE_OAUTH_TOKEN=' "${COCOAI_HOME}/.claude-env" || true
    fi
  } > "${COCOAI_HOME}/.coco-usage-env"
  chown cocoai:cocoai "${COCOAI_HOME}/.coco-usage-env"
  chmod 600 "${COCOAI_HOME}/.coco-usage-env"

  systemctl start coco-usage-report.timer 2>/dev/null || true
  systemctl start coco-ship-logs.timer 2>/dev/null || true
  systemctl start coco-token-usage.timer 2>/dev/null || true

  # Force immediate first run — timers may have already fired (OnBootSec=2min)
  # before bootstrap created .coco-usage-env, causing the first run to fail.
  # Use --no-block so 429 retries in usage-report don't delay bootstrap-complete.
  systemctl start --no-block coco-usage-report.service 2>/dev/null || true
  systemctl start --no-block coco-ship-logs.service 2>/dev/null || true
  systemctl start --no-block coco-token-usage.service 2>/dev/null || true
  log "Usage report + log/metrics shipper + token usage timers started (env at ${COCOAI_HOME}/.coco-usage-env)."

  # Write sync env vars to ~/zylos/.env for feature-sync and role-sync timers.
  # These systemd services load EnvironmentFile=-~/zylos/.env and need
  # CONTROL_PLANE_URL, EMPLOYEE_ID, INTERNAL_API_SECRET to call internal APIs.
  ZYLOS_ENV="${COCOAI_HOME}/zylos/.env"
  if [[ -f "${ZYLOS_ENV}" ]]; then
    for VAR_NAME in CONTROL_PLANE_URL EMPLOYEE_ID INTERNAL_API_SECRET; do
      if ! grep -q "^${VAR_NAME}=" "${ZYLOS_ENV}" 2>/dev/null; then
        case "${VAR_NAME}" in
          CONTROL_PLANE_URL)  echo "CONTROL_PLANE_URL=${CONTROL_PLANE_URL}" >> "${ZYLOS_ENV}" ;;
          EMPLOYEE_ID)        echo "EMPLOYEE_ID=${EMPLOYEE_ID}" >> "${ZYLOS_ENV}" ;;
          INTERNAL_API_SECRET) echo "INTERNAL_API_SECRET=${INTERNAL_API_SECRET}" >> "${ZYLOS_ENV}" ;;
        esac
      fi
    done
    chown cocoai:cocoai "${ZYLOS_ENV}"
    log "Sync env vars written to ${ZYLOS_ENV}"
  fi
else
  log "Skipping usage report config (missing employeeId, internalApiSecret, or controlPlaneUrl)."
fi

# ── 5e. Write runtime token-sync env ───────────────────────────────
if [[ -n "${EMPLOYEE_ID}" && -n "${CONTROL_PLANE_URL}" && -n "${INSTANCE_PULL_SECRET}" ]]; then
  COCOAI_HOME="$(getent passwd cocoai | cut -d: -f6)"
  PROVIDER_TOKEN_SYNC_ENABLED="0"
  if [[ -n "${PROVIDER_ACCESS_TOKEN}" ]]; then
    PROVIDER_TOKEN_SYNC_ENABLED="1"
  fi
  {
    echo "EMPLOYEE_ID=${EMPLOYEE_ID}"
    echo "AGENT_TYPE=${AGENT_TYPE}"
    echo "LLM_PROVIDER=${LLM_PROVIDER}"
    echo "CONTROL_PLANE_URL=${CONTROL_PLANE_URL}"
    echo "INSTANCE_PULL_SECRET=${INSTANCE_PULL_SECRET}"
    echo "PROVIDER_TOKEN_SYNC_ENABLED=${PROVIDER_TOKEN_SYNC_ENABLED}"
  } > "${COCOAI_HOME}/.coco-runtime-env"
  chown cocoai:cocoai "${COCOAI_HOME}/.coco-runtime-env"
  chmod 600 "${COCOAI_HOME}/.coco-runtime-env"

  ZYLOS_ENV="${COCOAI_HOME}/zylos/.env"
  if [[ -f "${ZYLOS_ENV}" ]]; then
    sed -i '/^INSTANCE_PULL_SECRET=/d' "${ZYLOS_ENV}" 2>/dev/null || true
    echo "INSTANCE_PULL_SECRET=${INSTANCE_PULL_SECRET}" >> "${ZYLOS_ENV}"
    # Write LLM_PROVIDER to zylos .env so framework components (activity-monitor,
    # comm-bridge dispatcher) can determine which AI runtime to use.
    sed -i '/^LLM_PROVIDER=/d' "${ZYLOS_ENV}" 2>/dev/null || true
    echo "LLM_PROVIDER=${LLM_PROVIDER}" >> "${ZYLOS_ENV}"
    chown cocoai:cocoai "${ZYLOS_ENV}"
  fi

  # Force an immediate token sync on first boot for provider-managed OAuth.
  # Without this, the VM starts with only the bootstrap primary token and waits
  # until coco-token-sync.timer (OnBootSec=3min) before seeing the full
  # multi-credential set, which temporarily under-delivers Pro/Ultra fallback
  # capacity on fresh provision.
  if [[ "${PROVIDER_TOKEN_SYNC_ENABLED}" == "1" ]]; then
    systemctl start --no-block coco-token-sync.service 2>/dev/null || true
    log "Triggered immediate provider token sync after runtime env write"
  fi
fi

unset GATEWAY_TOKEN DASHBOARD_ORIGIN OPENCLAW_VERSION INTERNAL_IP WC_PASSWORD INTERNAL_API_SECRET

# ── 5g. Write bootstrap-complete marker (before ops-agent, which reads it) ──
# Must be written BEFORE ops-agent starts — the agent reads this file at
# startup to determine runtime type. If missing, it falls back to 'claude',
# causing false alerts on non-Claude instances.
mkdir -p /opt/coco
install -m 644 /dev/null "${BOOTSTRAP_FLAG}"
cat > "${BOOTSTRAP_FLAG}" <<EOF
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
agent_type=${AGENT_TYPE}
llm_provider=${LLM_PROVIDER}
domain=${DOMAIN}
instance=${INSTANCE_NAME}
EOF
log "Bootstrap flag written: ${BOOTSTRAP_FLAG}"

# ── 5h. Install ops-agent (monitoring) ─────────────────────────────
# Only runs if the orchestrator injected opsAgentApiUrl into the bootstrap secret.
# When absent, this entire block is silently skipped (feature off).
if [[ -n "${OPS_AGENT_API_URL}" && -n "${OPS_AGENT_TOKEN}" && -n "${EMPLOYEE_ID}" ]]; then
  log "Installing ops-agent ..."
  OPS_AGENT_DIR="/opt/ops-agent"
  mkdir -p "${OPS_AGENT_DIR}"

  OPS_AGENT_DOWNLOADED=false

  # Strategy 1: Download from GCS bucket (preferred — fast, no admin-api dependency)
  if [[ -n "${OPS_AGENT_GCS_BUCKET}" ]]; then
    # Find the latest package in the bucket
    OPS_LATEST="$(gsutil ls "${OPS_AGENT_GCS_BUCKET}/ops-agent-*.tar.gz" 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -n "${OPS_LATEST}" ]]; then
      if gsutil cp "${OPS_LATEST}" /tmp/ops-agent.tar.gz 2>/dev/null; then
        OPS_AGENT_DOWNLOADED=true
        log "ops-agent downloaded from GCS: ${OPS_LATEST}"
      else
        log "WARNING: Failed to download ops-agent from GCS, falling back to admin-api."
      fi
    else
      log "WARNING: No ops-agent packages found in ${OPS_AGENT_GCS_BUCKET}, falling back to admin-api."
    fi
  fi

  # Strategy 2: Download from admin-api (fallback)
  if [[ "${OPS_AGENT_DOWNLOADED}" != "true" ]]; then
    if curl -sf --max-time 60 --retry 3 --retry-delay 5 \
      -H "x-ops-monitor-token: ${OPS_AGENT_TOKEN}" \
      -o /tmp/ops-agent.tar.gz \
      "${OPS_AGENT_API_URL}/internal/ops/agent-package?version=latest" 2>/dev/null; then
      OPS_AGENT_DOWNLOADED=true
      log "ops-agent downloaded from admin-api."
    else
      log "WARNING: Failed to download ops-agent from admin-api."
    fi
  fi

  if [[ "${OPS_AGENT_DOWNLOADED}" == "true" ]]; then
    tar xzf /tmp/ops-agent.tar.gz -C "${OPS_AGENT_DIR}" 2>/dev/null || {
      log "WARNING: Failed to extract ops-agent tarball. Skipping."
      OPS_AGENT_DOWNLOADED=false
    }
    rm -f /tmp/ops-agent.tar.gz
  fi

  if [[ "${OPS_AGENT_DOWNLOADED}" == "true" ]]; then
    # Write .env config
    cat > "${OPS_AGENT_DIR}/.env" <<OPSEOF
OPS_AGENT_EMPLOYEE_ID=${EMPLOYEE_ID}
OPS_AGENT_INTERNAL_TOKEN=${OPS_AGENT_TOKEN}
OPS_AGENT_ADMIN_API_BASE_URL=${OPS_AGENT_API_URL}
OPSEOF
    chmod 600 "${OPS_AGENT_DIR}/.env"

    # Generate ecosystem.config.cjs (not included in tarball)
    cat > "${OPS_AGENT_DIR}/ecosystem.config.cjs" <<'ECOEOF'
module.exports = {
  apps: [{
    name: "ops-agent",
    script: "dist/index.js",
    cwd: "/opt/ops-agent",
    env: { NODE_ENV: "production" }
  }]
};
ECOEOF

    chown -R cocoai:cocoai "${OPS_AGENT_DIR}"

    # Start via PM2 as cocoai (explicit NVM PATH — bash -lc doesn't load NVM due to .bashrc non-interactive guard)
    if sudo -u cocoai bash -c 'export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" && cd /opt/ops-agent && pm2 start ecosystem.config.cjs && pm2 save' 2>&1 | tail -5; then
      log "ops-agent started via PM2."
    else
      log "WARNING: ops-agent pm2 start failed."
    fi
  else
    log "WARNING: ops-agent installation skipped (download failed)."
  fi

  unset OPS_AGENT_DOWNLOADED OPS_LATEST
else
  log "Skipping ops-agent (not configured in bootstrap secret)."
fi
unset OPS_AGENT_API_URL OPS_AGENT_TOKEN OPS_AGENT_GCS_BUCKET

# (bootstrap-complete already written in step 5g above)

# ── 6. Callback to control plane ────────────────────────────────────
# Determine callback auth method: token mode uses Bearer token, SM mode uses bootstrapSecret
if [[ -n "${BOOTSTRAP_TOKEN}" || -n "${BOOTSTRAP_CALLBACK_SECRET}" ]] && [[ -n "${CONTROL_PLANE_URL}" ]]; then
  log "Sending bootstrap callback to ${CONTROL_PLANE_URL} ..."

  CALLBACK_INSTANCE_ID="${EMPLOYEE_ID:-${INSTANCE_NAME}}"
  if [[ -z "${EMPLOYEE_ID}" ]]; then
    log "WARNING: employeeId missing in bootstrap secret; falling back to instanceName for callback id."
  fi

  # Build callback request based on auth mode
  if [[ -n "${BOOTSTRAP_TOKEN}" ]]; then
    # Token mode: Bearer token auth, body only has instanceId
    CALLBACK_BODY=$(jq -n --arg instance "${CALLBACK_INSTANCE_ID}" '{instanceId: $instance}')
    CALLBACK_AUTH_HEADER="Authorization: Bearer ${BOOTSTRAP_TOKEN}"
  else
    # SM mode (legacy): bootstrapSecret in body
    CALLBACK_BODY=$(jq -n \
      --arg secret "${BOOTSTRAP_CALLBACK_SECRET}" \
      --arg instance "${CALLBACK_INSTANCE_ID}" \
      '{bootstrapSecret: $secret, instanceId: $instance}')
    CALLBACK_AUTH_HEADER=""
  fi

  CALLBACK_STATUS="000"
  CALLBACK_CURL_EXIT=0
  CALLBACK_RESPONSE_SNIPPET=""
  CALLBACK_DELAY=5
  for CALLBACK_ATTEMPT in 1 2 3 4 5 6; do
    CALLBACK_RESPONSE_FILE="$(mktemp)"
    CALLBACK_CURL_ARGS=(
      -sS -o "${CALLBACK_RESPONSE_FILE}" -w '%{http_code}'
      --max-time 30 --retry 3 --retry-delay 2
      -X POST "${CONTROL_PLANE_URL}/internal/bootstrap"
      -H "Content-Type: application/json"
      -d "${CALLBACK_BODY}"
    )
    if [[ -n "${CALLBACK_AUTH_HEADER}" ]]; then
      CALLBACK_CURL_ARGS+=(-H "${CALLBACK_AUTH_HEADER}")
    fi
    set +e
    CALLBACK_STATUS=$(curl "${CALLBACK_CURL_ARGS[@]}")
    CALLBACK_CURL_EXIT=$?
    set -e
    if [[ -s "${CALLBACK_RESPONSE_FILE}" ]]; then
      CALLBACK_RESPONSE_SNIPPET="$(tr '\n' ' ' < "${CALLBACK_RESPONSE_FILE}" | tr -s ' ' | cut -c1-200)"
    else
      CALLBACK_RESPONSE_SNIPPET=""
    fi
    rm -f "${CALLBACK_RESPONSE_FILE}"

    if [[ ${CALLBACK_CURL_EXIT} -eq 0 && ( "${CALLBACK_STATUS}" == "200" || "${CALLBACK_STATUS}" == "204" ) ]]; then
      break
    fi
    # 410 Gone = token expired/consumed — retrying won't help
    if [[ "${CALLBACK_STATUS}" == "410" ]]; then
      log "WARNING: Bootstrap callback returned HTTP 410 (token expired/consumed). Giving up."
      break
    fi
    if [[ "${CALLBACK_ATTEMPT}" -lt 6 ]]; then
      if [[ ${CALLBACK_CURL_EXIT} -ne 0 ]]; then
        log "WARNING: Bootstrap callback attempt ${CALLBACK_ATTEMPT} failed with curl exit ${CALLBACK_CURL_EXIT}; retrying in ${CALLBACK_DELAY}s."
      elif [[ "${CALLBACK_STATUS}" == "401" ]]; then
        log "WARNING: Bootstrap callback attempt ${CALLBACK_ATTEMPT} returned HTTP 401 Unauthorized. Retrying in ${CALLBACK_DELAY}s."
      else
        log "WARNING: Bootstrap callback attempt ${CALLBACK_ATTEMPT} returned HTTP ${CALLBACK_STATUS}. Response='${CALLBACK_RESPONSE_SNIPPET:-<empty>}' Retrying in ${CALLBACK_DELAY}s."
      fi
      sleep "${CALLBACK_DELAY}"
      if [[ "${CALLBACK_DELAY}" -lt 60 ]]; then
        CALLBACK_DELAY=$(( CALLBACK_DELAY * 2 ))
        if [[ "${CALLBACK_DELAY}" -gt 60 ]]; then
          CALLBACK_DELAY=60
        fi
      fi
    fi
  done

  # Clear bootstrap token from memory after callback
  unset BOOTSTRAP_TOKEN

  if [[ ${CALLBACK_CURL_EXIT} -eq 0 && ( "${CALLBACK_STATUS}" == "200" || "${CALLBACK_STATUS}" == "204" ) ]]; then
    log "Bootstrap callback succeeded (HTTP ${CALLBACK_STATUS})."
  elif [[ ${CALLBACK_CURL_EXIT} -ne 0 ]]; then
    log "WARNING: Bootstrap callback failed after retries with curl exit ${CALLBACK_CURL_EXIT}. VM is running but control plane was not notified."
  elif [[ "${CALLBACK_STATUS}" == "401" ]]; then
    log "WARNING: Bootstrap callback returned HTTP 401 Unauthorized after retries."
  else
    log "WARNING: Bootstrap callback returned HTTP ${CALLBACK_STATUS} after retries. Response='${CALLBACK_RESPONSE_SNIPPET:-<empty>}' VM is running but control plane was not notified."
  fi
else
  log "Skipping bootstrap callback (no token/secret or URL configured)."
fi

log "Bootstrap completed successfully."
