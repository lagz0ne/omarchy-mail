# Mail

A small mail client for Omarchy: Gmail and Outlook.com in one Swiss-styled window. It is one Bun
binary (server and page together) on `127.0.0.1:6245`, opened as an Omarchy web app.

Built on [Tinker](https://github.com/lagz0ne/tinkered) from the
[tinker-app](https://github.com/lagz0ne/tinker-app) template.

## Install

```bash
./scripts/install.sh
```

Then fill `~/.config/omarchy-mail/env` (the file says where each id comes from) and run
`systemctl --user restart omarchy-mail`. Open **Mail** from the launcher, then **Accounts** →
**Add Gmail** / **Add Outlook**.

## How it works

```text
Omarchy web app (Chromium --app)
   |  /rpc socket: live boxes, calls      /api/att, /api/img: files, images
omarchy-mail (bun --compile, 127.0.0.1 only)
   |-- SQLite ~/.local/share/omarchy-mail/mail.db   list rows, cursors, sources
   |-- keyring (Secret Service, "omarchy-mail")      refresh tokens
   |-- Gmail API (history)  /  Microsoft Graph (delta)   every 2 min + Sync
   '-- ~/.local/state/omarchy/current/theme/colors.toml  live theme
```

- `src/mail`: the feature. `contract.ts` (board + api), `*.server.ts` (store, providers,
  OAuth, sync, render, routes), `inbox.tsx` / `reader.tsx` / `accounts.tsx` (the page).
- `src/theme`: the desktop theme as CSS variables, pushed live to the page.
- A message body is sanitized (`sanitize-html`), locked by a CSP that allows only this
  server's images, and shown in a sandboxed frame with no scripts. Remote images stay off until
  you ask; then they come through a signed proxy, so senders never see your IP.

## Develop

```bash
bun run dev          # Vite :5173 + bun --hot :3001
bun run check:plain  # tinker check: types, rules, graph, tests, exits
bun run check:style
bun run check        # + build: dist/server
```

Env: `PORT`, `MAIL_HOME`, `THEME_FILE`, `MAIL_SYNC_MS` (0 turns the loop off),
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, and the three telemetry
keys from `.env.example`.
