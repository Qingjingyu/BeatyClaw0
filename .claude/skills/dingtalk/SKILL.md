---
name: dingtalk
version: 0.1.0
description: >-
  DingTalk (钉钉) communication channel via Stream mode WebSocket.
  No public IP or SSL required. Use when:
  (1) replying to DingTalk messages (DM or group),
  (2) sending proactive messages to DingTalk users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI),
  (6) troubleshooting DingTalk connection or message delivery issues.
  Config at ~/zylos/components/dingtalk/config.json. Service: pm2 zylos-dingtalk.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dingtalk
    entry: src/index.js
  data_dir: ~/zylos/components/dingtalk
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-dingtalk
  branch: main

config:
  required:
    - name: DINGTALK_CLIENT_ID
      description: "AppKey from DingTalk Open Platform (钉钉开放平台应用凭证中的 AppKey)"
    - name: DINGTALK_CLIENT_SECRET
      description: "AppSecret from DingTalk Open Platform"
      sensitive: true
  optional:
    - name: DINGTALK_ROBOT_CODE
      description: "Robot Code (defaults to AppKey if not set)"

next-steps: "BEFORE starting the service: 1) Set DINGTALK_CLIENT_ID, DINGTALK_CLIENT_SECRET in ~/zylos/.env. 2) In DingTalk Open Platform, create an enterprise internal app with robot capability in Stream mode. 3) Publish the app version with appropriate visibility. 4) Start the service (pm2 restart zylos-dingtalk). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# DingTalk

DingTalk (钉钉) communication channel for zylos.
Uses Stream mode (WebSocket) — no public IP, no SSL, no callback URL needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "dingtalk" "<staff_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/dingtalk/scripts/send.js <staff_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/dingtalk/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-credentials <appKey> <appSecret> [robotCode]

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <staff_id>
$ADM remove-dm-allow <staff_id>

# Group Management
$ADM list-groups
$ADM add-group <conversation_id> <name>
$ADM remove-group <conversation_id>
$ADM set-group-policy <disabled|allowlist|open>
```

After changes, restart: `pm2 restart zylos-dingtalk`

## Config Location

- Config: `~/zylos/components/dingtalk/config.json`
- Logs: `~/zylos/components/dingtalk/logs/`
- Credentials: `~/zylos/.env` (DINGTALK_CLIENT_ID, DINGTALK_CLIENT_SECRET, DINGTALK_ROBOT_CODE)

## DingTalk Setup

### 1. Create Application

1. Go to [DingTalk Open Platform](https://open-dev.dingtalk.com/fe/app), log in with DingTalk
2. Click "Create Application", enter name and description
3. In "Application Capabilities", click "Add Robot"
4. Set message receive mode to **Stream Mode** (no public URL required)
5. Publish a version with appropriate user visibility

### 2. Get Credentials

In "Credentials & Basic Info" page:
- **AppKey** → `DINGTALK_CLIENT_ID`
- **AppSecret** → `DINGTALK_CLIENT_SECRET`
- **RobotCode** → `DINGTALK_ROBOT_CODE` (usually same as AppKey)

### 3. Configure

Add to `~/zylos/.env`:
```bash
DINGTALK_CLIENT_ID=your_app_key
DINGTALK_CLIENT_SECRET=your_app_secret
DINGTALK_ROBOT_CODE=your_robot_code
```

### 4. Start Service

```bash
pm2 restart zylos-dingtalk
```

## Message Types

Supported incoming: text, richText, picture, video, file, audio
Supported outgoing: text (via webhook reply or proactive API)

## Stream Protocol

- Auth: POST `https://api.dingtalk.com/v1.0/gateway/connections/open` with clientId/clientSecret → ticket
- Connect: `wss://...?ticket=<ticket>`
- Messages: type=CALLBACK, topic=/v1.0/im/bot/messages/get
- Must acknowledge every frame with `{code:200, headers:{messageId}, data}`
- Heartbeat: server sends SYSTEM/ping, client must echo back
- Reply: POST to `sessionWebhook` from message data, or proactive via API

## Access Control

Same model as WeCom:

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
pm2 status zylos-dingtalk
pm2 logs zylos-dingtalk
pm2 restart zylos-dingtalk
```
