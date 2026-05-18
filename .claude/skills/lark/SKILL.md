---
name: lark
version: 0.1.0
description: >-
  Lark/Feishu (飞书) communication channel via WebSocket long connection.
  No public IP or SSL required. Use when:
  (1) replying to Lark messages (DM or group),
  (2) sending proactive messages to Lark users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI),
  (6) troubleshooting Lark connection or message delivery issues.
  Config at ~/zylos/components/lark/config.json. Service: pm2 zylos-lark.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-lark
    entry: src/index.js
  data_dir: ~/zylos/components/lark
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-lark
  branch: main

config:
  required:
    - name: LARK_APP_ID
      description: "App ID from Lark Open Platform (飞书开放平台应用凭证中的 App ID)"
    - name: LARK_APP_SECRET
      description: "App Secret from Lark Open Platform"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Set LARK_APP_ID, LARK_APP_SECRET in ~/zylos/.env. 2) In Lark Open Platform, create an enterprise internal app with bot capability and enable WebSocket long connection mode. 3) Publish the app version with appropriate visibility. 4) Start the service (pm2 restart zylos-lark). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# Lark

Lark/Feishu (飞书) communication channel for zylos.
Uses WebSocket long connection — no public IP, no SSL, no callback URL needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "<open_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/lark/scripts/send.js <open_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/lark/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-credentials <appId> <appSecret>

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <open_id>
$ADM remove-dm-allow <open_id>

# Group Management
$ADM list-groups
$ADM add-group <chat_id> <name>
$ADM remove-group <chat_id>
$ADM set-group-policy <disabled|allowlist|open>
```

After changes, restart: `pm2 restart zylos-lark`

## Config Location

- Config: `~/zylos/components/lark/config.json`
- Logs: `~/zylos/components/lark/logs/`
- Credentials: `~/zylos/.env` (LARK_APP_ID, LARK_APP_SECRET)

## Lark Setup

### 1. Create Application

1. Go to [Lark Open Platform](https://open.feishu.cn/app), log in with Lark/Feishu
2. Click "Create Custom App", enter name and description
3. In "Bot" capability, enable the bot
4. In "Events & Callbacks", set subscription mode to **WebSocket** (长连接模式, no public URL required)
5. Add event subscription: `im.message.receive_v1` (Receive messages)
6. Publish a version with appropriate user visibility

### 2. Get Credentials

In "Credentials & Basic Info" page:
- **App ID** → `LARK_APP_ID`
- **App Secret** → `LARK_APP_SECRET`

### 3. Configure

Add to `~/zylos/.env`:
```bash
LARK_APP_ID=your_app_id
LARK_APP_SECRET=your_app_secret
```

### 4. Start Service

```bash
pm2 restart zylos-lark
```

## Message Types

Supported incoming: text, post (rich text), image, file, audio, video, sticker
Supported outgoing: text (via Lark API)

## WebSocket Protocol

- Auth: POST `https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal/` with app_id/app_secret → app_access_token
- Endpoint: POST `https://open.feishu.cn/callback/ws/endpoint` with Bearer token → WSS URL
- Connect: `wss://...`
- Messages: type=event, header.event_type=im.message.receive_v1
- Heartbeat: server sends pong frames
- Send: POST `https://open.feishu.cn/open-apis/im/v1/messages` with receive_id_type parameter

## Access Control

Same model as DingTalk/WeCom:

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
pm2 status zylos-lark
pm2 logs zylos-lark
pm2 restart zylos-lark
```
