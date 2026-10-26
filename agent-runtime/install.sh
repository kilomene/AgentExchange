#!/usr/bin/env bash
# Install the Agent Exchange runtime as an auto-starting service.
# Root (or sudo): a system service — starts at boot, restarts on failure,
# restarts into updates. Otherwise: a systemd user service.
# The app is copied OUT of the repo so updates can swap the code without
# ever touching the vault (memory, state, queue live elsewhere).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$HOME/.exchange-agent"
DEST="$BASE/app"
NODE_BIN="$(command -v node)"

command -v rsync >/dev/null 2>&1 || { echo "error: rsync is required to install the runtime (e.g. apt install rsync / brew install rsync)" >&2; exit 1; }

mkdir -p "$BASE" "$DEST"
rsync -a --delete --exclude node_modules --exclude .tmp "$SRC/" "$DEST/"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then command -v sudo >/dev/null && SUDO="sudo"; fi

if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
  # Environment file: the daemon inherits the network/proxy environment it
  # was installed under (locked-down VMs route everything via a proxy).
  ENV_FILE="/etc/exchange-agentd.env"
  : > /tmp/exchange-agentd.env.tmp
  for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy NODE_USE_ENV_PROXY PATH; do
    if [ -n "${!v:-}" ]; then printf '%s=%s\n' "$v" "${!v}" >> /tmp/exchange-agentd.env.tmp; fi
  done
  $SUDO install -m 600 /tmp/exchange-agentd.env.tmp "$ENV_FILE"
  rm -f /tmp/exchange-agentd.env.tmp
  $SUDO tee /etc/systemd/system/exchange-agentd.service >/dev/null <<EOF
[Unit]
Description=Agent Exchange runtime (exchange-agentd)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE_BIN $DEST/src/daemon.mjs --config $BASE/config.json
WorkingDirectory=$BASE
EnvironmentFile=$ENV_FILE
Environment=HOME=$HOME
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable exchange-agentd.service
  echo "installed: $DEST (system service exchange-agentd, auto-start enabled)"
else
  # User service. Capture the network/proxy environment exactly like the
  # system-service path above: locked-down VMs route everything via a
  # proxy, and a user service does not inherit the install shell's env.
  ENV_FILE="$BASE/env"
  : > "$ENV_FILE.tmp"
  for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy NODE_USE_ENV_PROXY PATH; do
    if [ -n "${!v:-}" ]; then printf '%s=%s\n' "$v" "${!v}" >> "$ENV_FILE.tmp"; fi
  done
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/exchange-agentd.service" <<EOF
[Unit]
Description=Agent Exchange runtime (exchange-agentd)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE_BIN $DEST/src/daemon.mjs --config $BASE/config.json
WorkingDirectory=$BASE
EnvironmentFile=$ENV_FILE
Environment=HOME=$HOME
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable exchange-agentd.service
  # A user service only starts at boot (before login) if lingering is on.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || echo "warning: 'loginctl enable-linger $USER' failed — the service will start at login instead of boot until lingering is enabled" >&2
  fi
  echo "installed: $DEST (user service exchange-agentd, auto-start enabled)"
fi
echo "next: generate your owner key (node scripts/gen-owner-key.mjs $BASE/owner-key.json), create $BASE/config.json (see config.example.json — pin your owner public key in it), sign it (node scripts/sign-config.mjs $BASE/config.json $BASE/owner-key.json), then start the service."
