# References

## Configuration Sources
- Environment: ~/zylos/.env (TZ, DOMAIN, PROXY, API keys)
- Installed components: ~/zylos/.zylos/components.json

## Key Paths
- Memory: ~/zylos/memory/
- Skills: ~/zylos/.claude/skills/
- C4 Database: ~/zylos/comm-bridge/c4.db

## Services
- Scheduler: PM2-managed, see ~/zylos/pm2/ecosystem.config.cjs
- HTTP proxy: see .env PROXY

## Active IDs
- Owner: o9cq808vlCdQXsxYyAK4dwe9h3zc@im.wechat (WeChat)
- Platform Identities:
  - (Record your display name on each platform here, so you can recognize when someone mentions or @s you)

## Notes
- For TZ, domain, proxy: see .env
- This file is a pointer/index. Do NOT duplicate config values here.

## Networking
- **Domain**: subai
- **Internal IP**: 10.100.255.194
- **Reverse Proxy**: Caddy on port 80 (system service at /etc/caddy/Caddyfile)
- **External HTTPS**: Handled by Cloudflare (SSL termination before reaching this VM)
- All internal services must be exposed through Caddy reverse proxy on port 80
- Caddy listens on :80, Cloudflare handles HTTPS → HTTP forwarding
- To add a new service route, update /etc/caddy/Caddyfile and run: sudo systemctl reload caddy
