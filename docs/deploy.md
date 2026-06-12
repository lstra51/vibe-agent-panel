# Deploying Vibe Agent Panel

This project is designed to run on an Ubuntu server behind Nginx.

## 1. System Requirements

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm python3 make g++ nginx bubblewrap
```

The production server used during initial setup had:

```text
Ubuntu 22.04
Node.js 20
npm 10
Python 3.10
```

## 2. Application Install

```bash
sudo mkdir -p /opt/vibe-coding/app /opt/vibe-coding/profiles /var/lib/vibe-coding /var/log/vibe-coding /home/ubuntu/projects
sudo chown -R ubuntu:ubuntu /opt/vibe-coding /var/lib/vibe-coding /var/log/vibe-coding /home/ubuntu/projects

git clone https://github.com/lstra51/vibe-agent-panel.git /opt/vibe-coding/app
cd /opt/vibe-coding/app
npm ci
npm run build
npm ci --omit=dev
```

## 3. Claude DeepSeek Shim

Install the wrapper and shim:

```bash
sudo install -m 755 scripts/claude-deepseek /usr/local/bin/claude-deepseek
sudo mkdir -p /opt/vibe-coding/anthropic-deepseek
sudo install -m 644 scripts/anthropic_deepseek_shim.py /opt/vibe-coding/anthropic-deepseek/shim.py
```

The shim expects `fastapi`, `uvicorn`, and `httpx` in the Python environment used by the `anthropic-deepseek.service`.

## 4. Agent Chat Beta

The Agent Chat Beta workbench adds a Codex-native conversation path beside the legacy task runner:

- Codex sessions use `codex app-server --stdio`.
- Claude sessions use `claude-deepseek -p` and the local Anthropic-to-DeepSeek shim.
- Session state is stored in SQLite tables `agent_sessions`, `agent_turns`, `agent_events`, and `agent_approvals`.
- WebSocket updates are available at `/ws/agent-sessions/:id`.
- REST endpoints are under `/api/agent-sessions`.

Codex profiles are isolated under `/opt/vibe-coding/profiles/<profile>/codex`. On startup, the default profile imports an existing `/home/ubuntu/.codex/auth.json` once if the profile has no auth file yet. Do not commit auth files, DeepSeek keys, subscriptions, or web passwords.

## 5. systemd Service

Create `/etc/systemd/system/vibe-coding.service`:

```ini
[Unit]
Description=Vibe Agent Panel
After=network-online.target mihomo.service litellm.service
Wants=network-online.target mihomo.service litellm.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/vibe-coding/app
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=PROJECTS_ROOT=/home/ubuntu/projects
Environment=DB_PATH=/var/lib/vibe-coding/tasks.db
Environment=PROFILES_ROOT=/opt/vibe-coding/profiles
ExecStart=/usr/bin/node /opt/vibe-coding/app/src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/vibe-coding/app.log
StandardError=append:/var/log/vibe-coding/app.log

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vibe-coding
```

## 6. Nginx Notes

Nginx must support WebSocket upgrade for task streams, terminals, and Agent Chat Beta sessions:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection upgrade;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Keep Basic Auth or another access control layer enabled before exposing the panel.

## 7. Smoke Checks

```bash
curl -fsS http://127.0.0.1:3000/api/status
curl -fsS http://127.0.0.1:3000/api/profiles
python3 scripts/smoke_task.py
python3 scripts/smoke_codex_login.py
VIBE_SMOKE_AGENT=claude node scripts/smoke_agent_session.mjs
VIBE_SMOKE_AGENT=codex node scripts/smoke_agent_session.mjs
node scripts/smoke_agent_control.mjs
```

The smoke task requires a configured DeepSeek key in the default Vibe Profile.
The Codex login smoke test only verifies that the device-auth flow starts; it does not complete account login.
The Agent Chat smoke checks verify Claude/DeepSeek output, Codex app-server event streaming, WebSocket snapshots, realtime steer, and interrupt.
