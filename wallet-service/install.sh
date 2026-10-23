#!/usr/bin/env bash
# Installs exchange-walletd: the Agent Exchange chain watcher / payout
# executor / sweep service. Mirrors the exchange-agentd supervision pattern:
# a systemd unit with Restart=on-failure + RestartSec=3, secrets in a
# root-only env file, and the master key referenced by FILE (never copied).
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/exchange-walletd.env
UNIT=/etc/systemd/system/exchange-walletd.service
NODE_BIN="$(command -v node)"

read_env() {
  python3 - "$PROJECT_DIR/.env" "$1" <<'PY'
import sys
env = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
print(env.get(sys.argv[2], ""))
PY
}

{
  echo "SUPABASE_URL=$(read_env SUPABASE_URL)"
  echo "SUPABASE_SERVICE_ROLE_KEY=$(read_env SUPABASE_SERVICE_ROLE_KEY)"
  echo "WALLET_MASTER_KEY_FILE=$PROJECT_DIR/.wallet-master"
  # The egress proxy intercepts TLS with the host CA; Node must trust the
  # host-published bundle or every chain API call fails SELF_SIGNED_CERT.
  echo "NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem"
  echo "WALLET_STATE_DIR=/home/hatch/.exchange-wallet"
  # Capture the machine egress proxy so chain APIs are reachable.
  env | grep -E '^(https?|HTTPS?)_PROXY=|^ALL_PROXY=|^NO_PROXY=' || true
  env | grep -E '^(https?|HTTPS?)_proxy=|^all_proxy=|^no_proxy=' || true
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

cat > "$UNIT" <<EOF
[Unit]
Description=Agent Exchange wallet service (chain watcher, payouts, sweeps)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN wallet-service/src/service.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable exchange-walletd >/dev/null 2>&1 || true
systemctl restart exchange-walletd
echo "exchange-walletd installed and started"
