#!/bin/bash
# Builds the one binary and installs Mail for this user:
#   ~/.local/bin/omarchy-mail              the app: "serve" runs the server, no argument opens the window
#   ~/.config/omarchy-mail/env             OAuth client ids, port (kept if present)
#   ~/.config/systemd/user/omarchy-mail.service
#   a launcher entry "Mail" that runs omarchy-mail: it starts the server if needed, then focuses or opens its window
set -euo pipefail
cd "$(dirname "$0")/.."

bun run build
install -Dm755 dist/server "$HOME/.local/bin/omarchy-mail"

conf="$HOME/.config/omarchy-mail"
mkdir -p "$conf"
if [[ ! -f $conf/env ]]; then
  cat >"$conf/env" <<'ENV'
# Mail's config. Restart after a change: systemctl --user restart omarchy-mail
PORT=6245

# Google Cloud console > APIs & Services > Credentials > OAuth client ID > "Desktop app".
# Consent screen: External, add yourself as a test user, then PUBLISH it ("In production"),
# or the refresh token dies every 7 days. Enable the Gmail API.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Outlook.com: Thunderbird's public desktop client (personal Microsoft accounts can no longer
# register their own app without a directory). It grants IMAP + SMTP for personal accounts, and
# its sign-in returns to http://localhost:PORT/.
MICROSOFT_CLIENT_ID=9e5f94bc-e8a4-4e73-b8be-63364c29d753

# Telemetry goes nowhere unless a VictoriaMetrics stack listens here.
OTEL_SERVICE_NAME=omarchy-mail
VICTORIA_TRACES_URL=http://127.0.0.1:10428/insert/opentelemetry/v1/traces
VICTORIA_LOGS_URL=http://127.0.0.1:9428/insert/jsonline?_msg_field=msg&_time_field=time&_stream_fields=service,side
ENV
  chmod 600 "$conf/env"
fi

unit="$HOME/.config/systemd/user/omarchy-mail.service"
mkdir -p "$(dirname "$unit")"
cat >"$unit" <<'UNIT'
[Unit]
Description=Mail (Gmail + Outlook) for the Omarchy web app
After=graphical-session.target

[Service]
EnvironmentFile=%h/.config/omarchy-mail/env
ExecStart=%h/.local/bin/omarchy-mail serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable omarchy-mail.service
systemctl --user restart omarchy-mail.service

install -Dm644 assets/icon.png "$HOME/.local/share/icons/hicolor/256x256/apps/omarchy-mail.png"
cat >"$HOME/.local/share/applications/Mail.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Name=Mail
Comment=Gmail and Outlook in one window
Exec=$HOME/.local/bin/omarchy-mail
Icon=omarchy-mail
Terminal=false
Type=Application
StartupNotify=true
StartupWMClass=chrome-127.0.0.1__-OmarchyMail
Categories=Network;Email;
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Mail: run omarchy-mail (service: systemctl --user status omarchy-mail)"
