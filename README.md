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

## Use

| Keys                   |                                     |
| ---------------------- | ----------------------------------- |
| `Ctrl`/`Alt` + `1`–`9` | open the Nth mailbox in the sidebar |
| `j` / `k`              | next / previous mail                |
| `gg` / `G`             | first / last mail                   |
| `u`                    | mark unread                         |
| `i`                    | load this mail's images once        |
| `Esc`                  | back to the list                    |
| `/`                    | search                              |
| `Ctrl` + `\\`          | fold the sidebar                    |

- Accounts → Appearance: any installed Omarchy theme, or follow the desktop.
- The shield in a mail trusts its sender's domain: its images load by themselves (still through
  the proxy). Accounts → "Images load by themselves from" lists and removes them.
- Drag the edge of the sidebar or the list to resize (double-click resets). Narrow windows show
  one pane at a time.
- New mail in an inbox pops a desktop notification (`notify-send`); the first sync of an account
  stays quiet.

## How it works

```text
Omarchy web app (Chromium --app)
   |  /rpc socket: live boxes, calls      /api/att, /api/img: files, images
omarchy-mail (bun --compile, 127.0.0.1 only)
   |-- SQLite ~/.local/share/omarchy-mail/mail.db   list rows, cursors, sources
   |-- keyring (Secret Service, "omarchy-mail")      refresh tokens
   |-- Gmail API (history)  /  Outlook IMAP (XOAUTH2)   every 2 min + Sync
   '-- ~/.local/state/omarchy/current/theme/colors.toml  live theme
```

- `src/mail`: the feature. `contract.ts` (board + api), `*.server.ts` (store, providers,
  OAuth, sync, render, routes), `inbox.tsx` / `reader.tsx` / `accounts.tsx` (the page).
- `src/theme`: the desktop theme as CSS variables, pushed live to the page.
- Outlook.com signs in with Thunderbird's public desktop client: Microsoft no longer lets a
  personal account register an app outside a directory, and that client grants IMAP and SMTP.
  Its sign-in returns to the bare root, `http://localhost:<port>/`. Microsoft may block it any
  time; then an own registration (in a tenant) can replace it with `MICROSOFT_CLIENT_ID`.
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

Telemetry goes to a local VictoriaLogs (`:9428`, JSON lines) and VictoriaTraces (`:10428`, OTLP),
run from `~/.local/share/victoria/compose.yml`. Failed or slow provider calls are logged as
`provider.*`: open http://127.0.0.1:9428/select/vmui and query `_msg:provider`.

Env: `PORT`, `MAIL_HOME`, `THEME_FILE`, `MAIL_SYNC_MS` (0 turns the loop off),
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, and the three telemetry
keys from `.env.example`.
