---
name: slack
version: 0.1.0
description: >-
  Slack communication channel via Socket Mode WebSocket.
  No public IP or SSL required. Use when:
  (1) replying to Slack messages (DM or group),
  (2) sending proactive messages to Slack users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI),
  (6) troubleshooting Slack connection or message delivery issues.
  Config at ~/zylos/components/slack/config.json. Service: pm2 zylos-slack.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-slack
    entry: src/index.js
  data_dir: ~/zylos/components/slack
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-slack
  branch: main

config:
  required:
    - name: SLACK_APP_TOKEN
      description: "App-level token from Slack (starts with xapp-)"
      sensitive: true
    - name: SLACK_BOT_TOKEN
      description: "Bot user OAuth token from Slack (starts with xoxb-)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Set SLACK_APP_TOKEN, SLACK_BOT_TOKEN in ~/zylos/.env. 2) In Slack API dashboard, create an app with Socket Mode enabled and appropriate event subscriptions. 3) Install the app to your workspace. 4) Start the service (pm2 restart zylos-slack). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# Slack

Slack communication channel for zylos.
Uses Socket Mode (WebSocket) — no public IP, no SSL, no callback URL needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "slack" "<channel_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/slack/scripts/send.js <channel_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/slack/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-tokens <appToken> <botToken>

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <user_id>
$ADM remove-dm-allow <user_id>

# Group Management
$ADM list-groups
$ADM add-group <channel_id> <name>
$ADM remove-group <channel_id>
$ADM set-group-policy <disabled|allowlist|open>
```

After changes, restart: `pm2 restart zylos-slack`

## Config Location

- Config: `~/zylos/components/slack/config.json`
- Logs: `~/zylos/components/slack/logs/`
- Credentials: `~/zylos/.env` (SLACK_APP_TOKEN, SLACK_BOT_TOKEN)

## Slack Setup

### 1. Create Slack App

1. Go to [Slack API](https://api.slack.com/apps), click "Create New App" > "From scratch"
2. Name the app and select your workspace
3. Under "Settings" > "Socket Mode", enable Socket Mode
4. Generate an app-level token with `connections:write` scope — this is your `SLACK_APP_TOKEN` (starts with `xapp-`)

### 2. Configure Bot

1. Under "Features" > "Event Subscriptions", enable events
2. Subscribe to bot events: `message.im`, `message.channels`, `message.groups`
3. Under "Features" > "OAuth & Permissions", add bot token scopes:
   - `chat:write` — send messages
   - `users:read` — fetch user display names
   - `channels:history` — read channel messages
   - `groups:history` — read private channel messages
   - `im:history` — read DM messages
   - `channels:read` — get channel info
   - `groups:read` — get private channel info
4. Install the app to your workspace
5. Copy the "Bot User OAuth Token" — this is your `SLACK_BOT_TOKEN` (starts with `xoxb-`)

### 3. Configure

Add to `~/zylos/.env`:
```bash
SLACK_APP_TOKEN=xapp-your-app-level-token
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

### 4. Start Service

```bash
pm2 restart zylos-slack
```

## Message Types

Supported incoming: text messages (no subtype)
Supported outgoing: text (via chat.postMessage API)

## Socket Mode Protocol

- Auth: POST `https://slack.com/api/apps.connections.open` with app-level token → WSS URL
- Connect: `wss://wss-primary.slack.com/link/...`
- Hello: `{"type":"hello"}` on connect
- Events: `{"type":"events_api","envelope_id":"...","payload":{"event":{...}}}`
- Must acknowledge every envelope: `{"envelope_id":"..."}`
- Disconnect: `{"type":"disconnect"}` — reconnect
- Send: POST `https://slack.com/api/chat.postMessage` with bot token

## Access Control

Same model as other channels:

**Private DM (dmPolicy):**
1. Owner → always allowed
2. `open` → anyone
3. `owner` → owner only
4. `allowlist` → check `dmAllowFrom`

**Group (groupPolicy):**
1. `disabled` → no groups
2. `open` → all groups
3. `allowlist` → only configured groups

## Service Management

```bash
pm2 status zylos-slack
pm2 logs zylos-slack
pm2 restart zylos-slack
```
