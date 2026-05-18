---
name: telegram
version: 0.1.0
description: >-
  Telegram communication channel via Long Polling.
  No public IP or SSL required. Use when:
  (1) replying to Telegram messages (DM or group),
  (2) sending proactive messages to Telegram users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) managing group access control (groupPolicy, per-group allowFrom),
  (5) configuring the bot (admin CLI),
  (6) troubleshooting Telegram connection or message delivery issues.
  Config at ~/zylos/components/telegram/config.json. Service: pm2 zylos-telegram.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-telegram
    entry: src/index.js
  data_dir: ~/zylos/components/telegram
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-telegram
  branch: main

config:
  required:
    - name: TELEGRAM_BOT_TOKEN
      description: "Bot token from BotFather (format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)"
      sensitive: true

next-steps: "BEFORE starting the service: 1) Set TELEGRAM_BOT_TOKEN in ~/zylos/.env. 2) Create a bot via @BotFather on Telegram and get the token. 3) Start the service (pm2 restart zylos-telegram). First DM to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# Telegram

Telegram communication channel for zylos.
Uses long polling (getUpdates) — no public IP, no SSL, no webhook URL needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "<chat_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/telegram/scripts/send.js <chat_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/telegram/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Token
$ADM set-token <bot_token>

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <chat_id>
$ADM remove-dm-allow <chat_id>

# Group Management
$ADM list-groups
$ADM add-group <chat_id> <name>
$ADM remove-group <chat_id>
$ADM set-group-policy <disabled|allowlist|open>
```

After changes, restart: `pm2 restart zylos-telegram`

## Config Location

- Config: `~/zylos/components/telegram/config.json`
- Logs: `~/zylos/components/telegram/logs/`
- Credentials: `~/zylos/.env` (TELEGRAM_BOT_TOKEN)

## Telegram Setup

### 1. Create Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create a new bot
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
4. Optionally configure bot description, about text, and profile picture via BotFather

### 2. Configure

Add to `~/zylos/.env`:
```bash
TELEGRAM_BOT_TOKEN=your_bot_token
```

Or use the admin CLI:
```bash
node ~/zylos/.claude/skills/telegram/src/admin.js set-token your_bot_token
```

### 3. Start Service

```bash
pm2 restart zylos-telegram
```

### 4. For Group Usage

1. Add the bot to a Telegram group
2. The bot responds to messages that @mention it
3. Add the group to the allowlist:
   ```bash
   node ~/zylos/.claude/skills/telegram/src/admin.js add-group <chat_id> "Group Name"
   ```

## Message Types

Supported incoming: text, photo, document, voice, video, sticker, location
Supported outgoing: text (with Markdown formatting)

## Long Polling Protocol

- Auth: Bot token from BotFather (env: TELEGRAM_BOT_TOKEN)
- Receive: GET `https://api.telegram.org/bot<token>/getUpdates?offset=X&timeout=30`
- Send: POST `https://api.telegram.org/bot<token>/sendMessage` with {chat_id, text, parse_mode}
- Bot info: GET `https://api.telegram.org/bot<token>/getMe`
- Long messages are split at 4096 characters (Telegram limit)

## Access Control

Same model as DingTalk and WeCom:

**Private DM (dmPolicy):**
1. Owner -> always allowed
2. `open` -> anyone
3. `owner` -> owner only
4. `allowlist` -> check `dmAllowFrom`

**Group (groupPolicy):**
1. `disabled` -> no groups
2. `open` -> all groups
3. `allowlist` -> only configured groups

## Service Management

```bash
pm2 status zylos-telegram
pm2 logs zylos-telegram
pm2 restart zylos-telegram
```
