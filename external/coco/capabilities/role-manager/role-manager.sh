#!/usr/bin/env bash
# role-manager.sh — Zylos Capability Bundle Manager
# Manages role activation, deactivation, and status for preset agent capabilities.
#
# Usage:
#   role-manager list                  — List all available roles
#   role-manager activate <role-id>   — Activate a role (writes system prompt + memory init)
#   role-manager current              — Show currently active role
#   role-manager reset                — Reset to general-assistant (default)
#
# Paths:
#   CAPABILITIES_DIR  — Where role bundles are installed (set at bootstrap time)
#   ACTIVE_ROLE_FILE  — Records which role is currently active
#   ROLE_PROMPT_FILE  — Contains the active role's system prompt (injected at session start)
#   ROLE_MEMORY_FILE  — Contains the active role's memory init data

set -euo pipefail

CAPABILITIES_DIR="${CAPABILITIES_DIR:-$HOME/zylos/capabilities}"
ZYLOS_MEMORY_DIR="${ZYLOS_MEMORY_DIR:-$HOME/zylos/memory}"
ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"
ACTIVE_ROLE_FILE="$CAPABILITIES_DIR/.active-role"
ROLE_PROMPT_FILE="$ZYLOS_MEMORY_DIR/active-role.md"

# ── Tool permission helpers ──────────────────────────────────────────────────

# apply_tool_permissions <bundle_dir>
# Reads tools.json from the bundle and writes a permissions.deny list to
# ~/zylos/.claude/settings.json so Claude Code actually enforces the restrictions.
apply_tool_permissions() {
  local bundle_dir="$1"
  local tools_file="$bundle_dir/tools.json"
  local zylos_settings="$ZYLOS_DIR/.claude/settings.json"

  [ -f "$tools_file" ] || return 0
  [ -f "$zylos_settings" ] || return 0
  command -v node &>/dev/null || return 0

  local updated
  updated=$(node -e "
    const tools = require(process.argv[1]);
    const raw   = require('fs').readFileSync(process.argv[2], 'utf8');
    const settings = JSON.parse(raw);
    const p = tools.tool_permissions || {};
    const deny = [];
    if (p.bash_execution === false)  deny.push('Bash');
    if (p.file_read === false)       deny.push('Read', 'Glob');
    if (p.file_write === false)      deny.push('Write', 'Edit');
    // network_access:false is superset of web_search:false
    if (p.network_access === false)  { deny.push('WebFetch', 'WebSearch'); }
    else if (p.web_search === false) { deny.push('WebSearch'); }
    if (!settings.permissions) settings.permissions = {};
    settings.permissions.deny = deny;
    process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
  " "$tools_file" "$zylos_settings" 2>/dev/null || echo "")
  [ -n "$updated" ] && echo "$updated" > "$zylos_settings"
}

# clear_tool_permissions
# Removes all deny entries from ~/zylos/.claude/settings.json (used on reset).
clear_tool_permissions() {
  local zylos_settings="$ZYLOS_DIR/.claude/settings.json"

  [ -f "$zylos_settings" ] || return 0
  command -v node &>/dev/null || return 0

  node -e "
    const raw = require('fs').readFileSync(process.argv[1], 'utf8');
    const settings = JSON.parse(raw);
    if (settings.permissions) settings.permissions.deny = [];
    require('fs').writeFileSync(process.argv[1], JSON.stringify(settings, null, 2) + '\n');
  " "$zylos_settings" 2>/dev/null || true
}

usage() {
  echo "Usage: role-manager <command> [args]"
  echo ""
  echo "Commands:"
  echo "  list                  List all available roles"
  echo "  activate <role-id>    Activate a capability bundle"
  echo "  current               Show currently active role"
  echo "  reset                 Reset to general-assistant"
  echo ""
  echo "Available role IDs:"
  list_roles_brief
}

list_roles_brief() {
  if [ ! -f "$CAPABILITIES_DIR/registry.json" ]; then
    echo "  (capabilities not installed — run bootstrap first)"
    return
  fi
  node -e "
    const r = require('$CAPABILITIES_DIR/registry.json');
    r.roles.forEach(role => {
      const active = require('fs').existsSync('$ACTIVE_ROLE_FILE') &&
        require('fs').readFileSync('$ACTIVE_ROLE_FILE','utf8').trim() === role.id;
      console.log('  ' + (active ? '* ' : '  ') + role.id + ' — ' + role.name_zh);
    });
  " 2>/dev/null || {
    # Fallback if node not available: list directories
    for dir in "$CAPABILITIES_DIR"/*/; do
      role_id=$(basename "$dir")
      [ "$role_id" = "role-manager" ] && continue
      [ "$role_id" = "foundation" ] && continue
      echo "  $role_id"
    done
  }
}

cmd_list() {
  if [ ! -f "$CAPABILITIES_DIR/registry.json" ]; then
    echo "Error: capabilities not installed at $CAPABILITIES_DIR"
    exit 1
  fi

  current_role=""
  [ -f "$ACTIVE_ROLE_FILE" ] && current_role=$(cat "$ACTIVE_ROLE_FILE")

  echo "Available Capability Bundles:"
  echo ""

  node -e "
    const r = require('$CAPABILITIES_DIR/registry.json');
    const current = '$current_role';
    r.roles.forEach(role => {
      const marker = role.id === current ? ' [ACTIVE]' : '';
      console.log('  ' + role.icon + '  ' + role.name_zh + ' (' + role.name + ')' + marker);
      console.log('     ID: ' + role.id);
      console.log('     ' + role.tagline_zh);
      console.log('     适合: ' + role.suitable_for_zh);
      if (role.requires_scheduler) console.log('     ⚡ 需要调度器（定时任务）');
      if (role.requires_connect) console.log('     📡 需要 connect 组件（渠道推送）');
      console.log('');
    });
  " 2>/dev/null || {
    echo "  (node not available, listing directories)"
    list_roles_brief
  }
}

cmd_activate() {
  local role_id="$1"

  if [ -z "$role_id" ]; then
    echo "Error: role-id required"
    echo "Run 'role-manager list' to see available roles"
    exit 1
  fi

  local bundle_dir="$CAPABILITIES_DIR/$role_id"

  # Validate against registry (rejects unknown directories not registered as roles)
  if [ -f "$CAPABILITIES_DIR/registry.json" ]; then
    local is_registered
    is_registered=$(node -e "
      const r = require(process.argv[1]);
      console.log(r.roles.some(x => x.id === process.argv[2]) ? 'true' : 'false');
    " "$CAPABILITIES_DIR/registry.json" "$role_id" 2>/dev/null || echo "unknown")
    if [ "$is_registered" = "false" ]; then
      echo "Error: Role '$role_id' is not registered in registry.json"
      echo "Run 'role-manager list' to see available roles"
      exit 1
    fi
  fi

  if [ ! -d "$bundle_dir" ]; then
    echo "Error: Role '$role_id' not found at $bundle_dir"
    echo "Run 'role-manager list' to see available roles"
    exit 1
  fi

  # 1. Write active role ID (atomic: write to temp then rename)
  local tmp_role_file
  tmp_role_file=$(mktemp "${ACTIVE_ROLE_FILE}.XXXXXX")
  echo "$role_id" > "$tmp_role_file"
  mv "$tmp_role_file" "$ACTIVE_ROLE_FILE"

  # 2. Write role system prompt to memory (injected at next session start)
  local prompt_file="$bundle_dir/system-prompt.md"
  if [ -f "$prompt_file" ]; then
    mkdir -p "$ZYLOS_MEMORY_DIR"
    {
      echo "---"
      echo "# Active Role: $role_id"
      echo "# This file is auto-generated by role-manager. Do not edit manually."
      echo "# To change role: run 'role-manager activate <role-id>'"
      echo "---"
      echo ""
      cat "$prompt_file"
    } > "$ROLE_PROMPT_FILE"
  fi

  # 3. Initialize role memory
  local memory_file="$bundle_dir/memory-init.json"
  if [ -f "$memory_file" ]; then
    local role_memory_dir="$ZYLOS_MEMORY_DIR/roles"
    mkdir -p "$role_memory_dir"
    # Only write if not already initialized (preserve user's existing role memory)
    local role_mem_target="$role_memory_dir/$role_id.json"
    if [ ! -f "$role_mem_target" ]; then
      # First activation: write initial memory with timestamp
      node -e "
        const init = require('$memory_file');
        init.activated_at = new Date().toISOString();
        require('fs').writeFileSync('$role_mem_target', JSON.stringify(init, null, 2));
      " 2>/dev/null || cp "$memory_file" "$role_mem_target"
    else
      # Re-activation: update activated_at only
      node -e "
        const existing = require('$role_mem_target');
        existing.activated_at = new Date().toISOString();
        require('fs').writeFileSync('$role_mem_target', JSON.stringify(existing, null, 2));
      " 2>/dev/null || true
    fi
  fi

  # 4. Apply tool permissions from tools.json to Claude Code settings
  apply_tool_permissions "$bundle_dir"

  # 5. Get role display name
  local role_name="$role_id"
  if [ -f "$CAPABILITIES_DIR/registry.json" ]; then
    role_name=$(node -e "
      const r = require('$CAPABILITIES_DIR/registry.json');
      const role = r.roles.find(x => x.id === '$role_id');
      if (role) console.log(role.name_zh + ' (' + role.name + ')');
      else console.log('$role_id');
    " 2>/dev/null || echo "$role_id")
  fi

  echo "✓ Role activated: $role_name"
  echo ""
  echo "The role system prompt is now loaded at: $ROLE_PROMPT_FILE"
  echo "It will be injected at the next session start (run /clear to reload)."
  echo ""

  # 6. Show onboarding hint for roles that need setup
  if [ -f "$CAPABILITIES_DIR/registry.json" ]; then
    local needs_scheduler needs_connect
    read -r needs_scheduler needs_connect < <(node -e "
      const r = require(process.argv[1]);
      const role = r.roles.find(x => x.id === process.argv[2]);
      console.log([
        role && role.requires_scheduler ? 'true' : 'false',
        role && role.requires_connect   ? 'true' : 'false'
      ].join(' '));
    " "$CAPABILITIES_DIR/registry.json" "$role_id" 2>/dev/null || echo "false false")

    if [ "$needs_scheduler" = "true" ]; then
      echo "⚡ This role uses scheduled tasks. On first use, the agent will guide you to configure monitoring frequency and output channel."
    fi
    if [ "$needs_connect" = "true" ]; then
      echo "📡 This role pushes reports to your messaging channels. Make sure your connect component (Telegram/Lark) is configured."
    fi
  fi
}

cmd_current() {
  if [ ! -f "$ACTIVE_ROLE_FILE" ]; then
    echo "No role explicitly activated. Default: general-assistant"
    return
  fi

  local current_role
  current_role=$(cat "$ACTIVE_ROLE_FILE")

  if [ -f "$CAPABILITIES_DIR/registry.json" ]; then
    node -e "
      const r = require('$CAPABILITIES_DIR/registry.json');
      const role = r.roles.find(x => x.id === '$current_role');
      if (role) {
        console.log('Active role: ' + role.icon + '  ' + role.name_zh + ' (' + role.name + ')');
        console.log('Type: ' + role.type);
      } else {
        console.log('Active role: $current_role (unknown)');
      }
    " 2>/dev/null || echo "Active role: $current_role"
  else
    echo "Active role: $current_role"
  fi
}

cmd_reset() {
  echo "general-assistant" > "$ACTIVE_ROLE_FILE"

  local bundle_dir="$CAPABILITIES_DIR/general-assistant"
  if [ -f "$bundle_dir/system-prompt.md" ]; then
    mkdir -p "$ZYLOS_MEMORY_DIR"
    {
      echo "---"
      echo "# Active Role: general-assistant"
      echo "# Reset to default by role-manager"
      echo "---"
      echo ""
      cat "$bundle_dir/system-prompt.md"
    } > "$ROLE_PROMPT_FILE"
  fi

  # Restore full tool permissions (general-assistant has no restrictions)
  clear_tool_permissions

  echo "✓ Reset to General Assistant (default)"
  echo "Run /clear to reload the session with the default role."
}

# ── Main ─────────────────────────────────────────────────────────────────────

CMD="${1:-}"

case "$CMD" in
  list)    cmd_list ;;
  activate)
    if [ -z "${2:-}" ]; then
      echo "Error: role-id required. Usage: role-manager activate <role-id>"
      exit 1
    fi
    cmd_activate "$2"
    ;;
  current) cmd_current ;;
  reset)   cmd_reset ;;
  ""|help|-h|--help) usage ;;
  *)
    echo "Unknown command: $CMD"
    usage
    exit 1
    ;;
esac
