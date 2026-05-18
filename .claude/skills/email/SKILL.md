---
name: email
version: 0.1.0
description: >-
  Email communication channel via IMAP/SMTP.
  No public IP or SSL required. Use when:
  (1) replying to Email messages,
  (2) sending proactive emails to users,
  (3) managing DM access control (dmPolicy: open/allowlist/owner, dmAllowFrom list),
  (4) configuring the bot (admin CLI),
  (5) troubleshooting Email connection or message delivery issues.
  Config at ~/zylos/components/email/config.json. Service: pm2 zylos-email.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-email
    entry: src/index.js
  data_dir: ~/zylos/components/email
  preserve:
    - config.json
    - data/

upgrade:
  repo: zylos-ai/zylos-email
  branch: main

config:
  required:
    - name: EMAIL_IMAP_HOST
      description: "IMAP server hostname (e.g., imap.gmail.com)"
    - name: EMAIL_IMAP_PORT
      description: "IMAP server port (default: 993)"
    - name: EMAIL_IMAP_USER
      description: "IMAP login username (email address)"
    - name: EMAIL_IMAP_PASSWORD
      description: "IMAP login password (app password for Gmail)"
      sensitive: true
    - name: EMAIL_SMTP_HOST
      description: "SMTP server hostname (e.g., smtp.gmail.com)"
    - name: EMAIL_SMTP_PORT
      description: "SMTP server port (default: 465)"
    - name: EMAIL_SMTP_USER
      description: "SMTP login username (usually same as IMAP user)"
    - name: EMAIL_SMTP_PASSWORD
      description: "SMTP login password (usually same as IMAP password)"
      sensitive: true
  optional:
    - name: EMAIL_FROM_NAME
      description: "Display name for outgoing emails (defaults to SMTP user)"

next-steps: "BEFORE starting the service: 1) Set EMAIL_IMAP_HOST, EMAIL_IMAP_PORT, EMAIL_IMAP_USER, EMAIL_IMAP_PASSWORD, EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER, EMAIL_SMTP_PASSWORD in ~/zylos/.env. 2) For Gmail, create an App Password at https://myaccount.google.com/apppasswords. 3) Start the service (pm2 restart zylos-email). First email to the bot will auto-bind the sender as owner."

dependencies:
  - comm-bridge
---

# Email

Email communication channel for zylos.
Uses IMAP for receiving and SMTP for sending — no public IP, no webhook needed.

Depends on: comm-bridge (C4 message routing).

## Sending Messages

```bash
# Via C4 bridge (standard path)
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "email" "<email_address>" "Hello!"
```

Direct send (bypasses C4 logging, for testing only):
```bash
node ~/zylos/.claude/skills/email/scripts/send.js <email_address> "Hello!"
```

## Admin CLI

```bash
ADM="node ~/zylos/.claude/skills/email/src/admin.js"

# General
$ADM show                                    # Show full config
$ADM show-owner                              # Show current owner
$ADM help                                    # Show all commands

# Credentials
$ADM set-imap <host> <port> <user> <password>
$ADM set-smtp <host> <port> <user> <password>

# DM Access Control
$ADM set-dm-policy <open|allowlist|owner>
$ADM list-dm-allow
$ADM add-dm-allow <email>
$ADM remove-dm-allow <email>
```

After changes, restart: `pm2 restart zylos-email`

## Config Location

- Config: `~/zylos/components/email/config.json`
- Logs: `~/zylos/components/email/logs/`
- Credentials: `~/zylos/.env` (EMAIL_IMAP_*, EMAIL_SMTP_*, EMAIL_FROM_NAME)

## Email Provider Setup

### Gmail

1. Enable 2-Factor Authentication on your Google account
2. Go to [App Passwords](https://myaccount.google.com/apppasswords)
3. Create an app password for "Mail"
4. Use these settings:
   - IMAP: `imap.gmail.com:993`
   - SMTP: `smtp.gmail.com:465`
   - User: your Gmail address
   - Password: the generated app password

### Outlook / Office 365

- IMAP: `outlook.office365.com:993`
- SMTP: `smtp.office365.com:587`

### Custom IMAP/SMTP

Any standard IMAP/SMTP server with TLS support will work.

### Configure

Add to `~/zylos/.env`:
```bash
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=yourbot@gmail.com
EMAIL_IMAP_PASSWORD=your_app_password
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=465
EMAIL_SMTP_USER=yourbot@gmail.com
EMAIL_SMTP_PASSWORD=your_app_password
EMAIL_FROM_NAME=Zylos Bot
```

### Start Service

```bash
pm2 restart zylos-email
```

## How It Works

1. Connects to IMAP server with TLS
2. Polls INBOX for UNSEEN messages every 30 seconds (configurable)
3. Parses sender, subject, and body (prefers text/plain, falls back to stripped HTML)
4. Deduplicates by Message-ID header
5. Checks sender against access policy
6. Forwards to C4 bridge for agent processing
7. Replies sent via SMTP with proper threading (In-Reply-To, Re: subject)

## Access Control

**DM Policy (dmPolicy):**
1. Owner -> always allowed
2. `open` -> anyone can email the bot
3. `owner` -> owner only (default)
4. `allowlist` -> check `dmAllowFrom` list

## Service Management

```bash
pm2 status zylos-email
pm2 logs zylos-email
pm2 restart zylos-email
```
