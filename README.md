# Vibe Agent Panel

Vibe Agent Panel is a remote development dashboard for a single Ubuntu server. It provides a dark "Vibe Remote" workbench for server monitoring, Codex/Claude Code tasks, project-scoped terminals, system logs, and profile-based credential switching.

## Features

- React dashboard inspired by the Vibe Remote mockups.
- Fastify API with SQLite task history.
- Realtime task logs over WebSocket.
- Project-scoped terminal over WebSocket and `node-pty`.
- Profile management for separate `CODEX_HOME` folders and DeepSeek API settings.
- Claude Code wrapper support for profile-specific DeepSeek keys through the local Anthropic-compatible shim.

## Runtime Paths

```text
/opt/vibe-coding/app
/opt/vibe-coding/profiles
/var/lib/vibe-coding/tasks.db
/home/ubuntu/projects
```

## Commands

```bash
npm install
npm run build
npm start
```

Production is normally run by `vibe-coding.service` behind Nginx.

## Security Notes

- The browser never receives DeepSeek API keys or Codex auth tokens.
- Terminals are restricted to `/home/ubuntu/projects`.
- Codex profiles use isolated `CODEX_HOME` directories.
- Keep Nginx Basic Auth or a stronger access layer enabled before exposing this panel.
