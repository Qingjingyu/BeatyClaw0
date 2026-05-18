---
name: whatsapp
version: 0.1.0
description: >-
  WhatsApp Business communication channel via Cloud API webhook.
  Requires a public URL for Meta webhook callbacks.
  Use when:
  (1) replying to WhatsApp messages (DM),
  (2) sending proactive messages to WhatsApp users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) configuring the bot (admin CLI),
  (5) troubleshooting WhatsApp connection or message delivery issues.
  Config at ~/zylos/components/whatsapp/config.json. Service: pm2 zylos-whatsapp.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-whatsapp
    entry: src/index.js
  data_dir: ~/zylos/components/whatsapp
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-whatsapp
  branch: main

config:
  required:
    - name: WHATSAPP_ACCESS_TOKEN
      description: "Permanent access token from Meta Business / WhatsApp Business API"
      sensitive: true
    - name: WHATSAPP_PHONE_NUMBER_ID
      description: "Phone Number ID from WhatsApp Business API settings"
    - name: WHATSAPP_VERIFY_TOKEN
      description: "Random string you choose — must match the value set in Meta webhook config"
  optional:
    - name: WHATSAPP_APP_SECRET
      description: "App Secret for webhook signature verification (recommended)"
      sensitive: true

next-steps: >-
  BEFORE starting the service:
  1) Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN in ~/zylos/.env.
  2) Optionally set WHATSAPP_APP_SECRET for webhook signature verification.
  3) Set up a reverse proxy or tunnel (e.g. Caddy, ngrok, Cloudflare Tunnel) to expose
     the webhook port (default 4466) at a public HTTPS URL.
  4) In Meta Developer Portal > WhatsApp > Configuration, set the webhook URL to
     https://your-domain/webhook and the verify token to your WHATSAPP_VERIFY_TOKEN.
  5) Subscribe to the "messages" webhook field.
  6) Start the service (pm2 restart zylos-whatsapp).
  First DM to the bot will auto-bind the sender as owner.

dependencies:
  - comm-bridge
---

# WhatsApp

WhatsApp Business communication channel for zylos.
Uses the WhatsApp Business Cloud API (Meta) with webhook for incoming messages.

Depends on: comm-bridge (C4 message routing).

**Important:** This component requires a public HTTPS URL for Meta to deliver webhook callbacks.
You must set up a reverse proxy or tunnel to expose the webhook port.

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "whatsapp" "<wa_id>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/whatsapp/scripts/send.js <wa_id> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/whatsapp/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-credentials <accessToken> <phoneNumberId> <verifyToken> [appSecret]

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <wa_id>
$ADM remove-dm-allow <wa_id>
```

After changes, restart: `pm2 restart zylos-whatsapp`

## Config Location

- Config: `~/zylos/components/whatsapp/config.json`
- Logs: `~/zylos/components/whatsapp/logs/`
- Credentials: `~/zylos/.env` (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET)

## WhatsApp Setup

### 1. Create Meta App

1. Go to [Meta Developers](https://developers.facebook.com/), create a new app
2. Select "Business" type, add "WhatsApp" product
3. In WhatsApp > Getting Started, note your **Phone Number ID** and **Access Token**
4. For production, generate a permanent System User token via Meta Business Settings

### 2. Get Credentials

In Meta Developer Portal:
- **Access Token** → `WHATSAPP_ACCESS_TOKEN` (use a permanent System User token for production)
- **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
- **Verify Token** → `WHATSAPP_VERIFY_TOKEN` (you choose this — any random string)
- **App Secret** (in App Settings > Basic) → `WHATSAPP_APP_SECRET` (optional but recommended)

### 3. Configure Webhook

1. Set up a reverse proxy or tunnel to expose port 4466:
   - **Caddy:** `reverse_proxy /webhook localhost:4466`
   - **ngrok:** `ngrok http 4466`
   - **Cloudflare Tunnel:** point to `http://localhost:4466`
2. In Meta Developer Portal > WhatsApp > Configuration:
   - Callback URL: `https://your-domain/webhook`
   - Verify token: same value as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to webhook field: **messages**

### 4. Configure

Add to `~/zylos/.env`:
```bash
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_random_verify_token
WHATSAPP_APP_SECRET=your_app_secret
```

### 5. Start Service

```bash
pm2 restart zylos-whatsapp
```

## Architecture

The component runs two HTTP servers:
- **Webhook server** (port 4466, binds 0.0.0.0): receives Meta webhook callbacks
  - `GET /webhook` — verification challenge (returns hub.challenge)
  - `POST /webhook` — incoming messages (verifies signature, parses, forwards to C4)
  - `GET /health` — health check endpoint
- **Internal API** (port 4465, binds 127.0.0.1): used by send.js for outgoing messages

## Message Types

Supported incoming: text, image, video, audio, document, location, sticker, contacts
Supported outgoing: text (via WhatsApp Cloud API)

## Access Control

**Private DM (dmPolicy):**
1. Owner → always allowed
2. `open` → anyone
3. `owner` → owner only
4. `allowlist` → check `dmAllowFrom`

## Service Management

```bash
pm2 status zylos-whatsapp
pm2 logs zylos-whatsapp
pm2 restart zylos-whatsapp
```
