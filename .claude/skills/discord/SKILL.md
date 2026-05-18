---
name: discord
version: 0.1.0
description: >-
  Discord communication channel via Gateway WebSocket.
  No public IP or SSL required. Use when:
  (1) replying to Discord messages (DM or group),
  (2) sending proactive messages to Discord users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI),
  (6) troubleshooting Discord connection or message delivery issues.
  Config at ~/zylos/components/discord/config.json. Service: pm2 zylos-discord.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-discord
    entry: src/index.js
  data_dir: ~/zylos/components/discord
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-discord
  branch: main

config:
  required:
    - name: DISCORD_BOT_TOKEN
      description: "Bot token from Discord Developer Portal (Bot section)"
      sensitive: true
    - name: DISCORD_APP_ID
      description: "Application ID from Discord Developer Portal (General Information)"
  optional: []

next-steps: "BEFORE starting the service: 1) Set DISCORD_BOT_TOKEN and DISCORD_APP_ID in ~/zylos/.env. 2) In Discord Developer Portal, create an application with a Bot user. 3) Enable MESSAGE CONTENT intent in Bot settings. 4) Invite the bot to your server with appropriate permissions. 5) Start the service (pm2 restart zylos-discord). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# Discord

Discord communication channel for zylos.
Uses Gateway WebSocket — no public IP, no SSL, no callback URL needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "discord" "<channel_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/discord/scripts/send.js <channel_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/discord/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-token <bot_token> [app_id]

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <user_id>
$ADM remove-dm-allow <user_id>

# Group Management
$ADM list-groups
$ADM add-group <channel_id|guild_id> <name>
$ADM remove-group <channel_id|guild_id>
$ADM set-group-policy <disabled|allowlist|open>
```

After changes, restart: `pm2 restart zylos-discord`

## Config Location

- Config: `~/zylos/components/discord/config.json`
- Logs: `~/zylos/components/discord/logs/`
- Credentials: `~/zylos/.env` (DISCORD_BOT_TOKEN, DISCORD_APP_ID)

## Discord Setup

### 1. Create Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications), log in
2. Click "New Application", enter name
3. Go to "Bot" section, click "Add Bot" (if not already created)
4. Copy the **Bot Token** → `DISCORD_BOT_TOKEN`
5. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
6. Copy **Application ID** from General Information → `DISCORD_APP_ID`

### 2. Invite Bot to Server

Generate an invite URL with these permissions:
- Send Messages
- Read Message History
- View Channels

OAuth2 URL format:
```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=68608&scope=bot
```

### 3. Configure

Add to `~/zylos/.env`:
```bash
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_APP_ID=your_app_id
```

### 4. Start Service

```bash
pm2 restart zylos-discord
```

## Message Types

Supported incoming: text messages (with mentions detection)
Supported outgoing: text (via REST API, auto-split at 2000 chars)

## Gateway Protocol

- Auth: GET `https://discord.com/api/v10/gateway/bot` with `Authorization: Bot <token>` → WSS URL
- Connect: `wss://gateway.discord.gg/?v=10&encoding=json`
- Opcodes: 10 (Hello), 2 (Identify), 0 (Dispatch), 1 (Heartbeat), 11 (HeartbeatAck), 7 (Reconnect), 9 (InvalidSession), 6 (Resume)
- Intents: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT = 37377
- Messages: opcode 0, event type MESSAGE_CREATE
- Must send heartbeat at server-specified interval
- Resume: reconnect with opcode 6 using session_id and last sequence number
- Send: POST `https://discord.com/api/v10/channels/{channel_id}/messages`

## Access Control

Same model as other zylos channels:

**Private DM (dmPolicy):**
1. Owner → always allowed
2. `open` → anyone
3. `owner` → owner only
4. `allowlist` → check `dmAllowFrom`

**Group (groupPolicy):**
1. `disabled` → no groups
2. `open` → all groups
3. `allowlist` → only configured groups (by channel ID or guild ID)

In group chats, the bot only responds when @mentioned.

## Service Management

```bash
pm2 status zylos-discord
pm2 logs zylos-discord
pm2 restart zylos-discord
```
