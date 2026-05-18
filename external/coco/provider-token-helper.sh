#!/usr/bin/env bash
# provider-token-helper.sh — Claude Code apiKeyHelper for control-plane-managed access tokens.

set -euo pipefail

TOKEN_FILE="${HOME}/.coco/provider-access-token.json"
CREDENTIALS_FILE="${HOME}/.claude/.credentials.json"

if [[ -f "${TOKEN_FILE}" ]]; then
  PROVIDER="$(jq -r '.provider // empty' "${TOKEN_FILE}")"
  ACCESS_TOKEN="$(jq -r '.accessToken // empty' "${TOKEN_FILE}")"
  if [[ "${PROVIDER}" == "anthropic" && -n "${ACCESS_TOKEN}" ]]; then
    printf '%s\n' "${ACCESS_TOKEN}"
    exit 0
  fi
fi

if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  printf '%s\n' "${CLAUDE_CODE_OAUTH_TOKEN}"
  exit 0
fi

if [[ -f "${CREDENTIALS_FILE}" ]]; then
  ACCESS_TOKEN="$(jq -r '.claudeAiOauth.accessToken // empty' "${CREDENTIALS_FILE}")"
  if [[ -n "${ACCESS_TOKEN}" ]]; then
    printf '%s\n' "${ACCESS_TOKEN}"
    exit 0
  fi
fi

echo "[provider-token-helper] No Claude token source available" >&2
exit 1
