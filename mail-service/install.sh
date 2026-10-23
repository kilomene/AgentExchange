#!/usr/bin/env bash
# Installs exchange-mailerd as a system service. Idempotent.
# Secrets: Supabase keys are parsed from the project .env (never printed);
# the Zoho SMTP password is read by the service from .smtp-pass (chmod 600,
# gitignored) via ZOHO_SMTP_PASS_FILE — it never enters this script's output.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .smtp-pass ]; then
  echo "ERROR: $PROJECT_DIR/.smtp-pass missing — the no-reply@ mailbox password file is required." >&2
  exit 1
fi
chmod 600 .smtp-pass

python3 - << 'PYEOF'
import os
env = {}
for line in open('.env'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        v = v[1:-1]
    env[k.strip()] = v
lines = [
    'SUPABASE_URL=' + env['SUPABASE_URL'],
    'SUPABASE_SERVICE_ROLE_KEY=' + env['SUPABASE_SERVICE_ROLE_KEY'],
    'ZOHO_SMTP_USER=no-reply@novamail.store',
    'ZOHO_SMTP_PASS_FILE=' + os.path.join(os.getcwd(), '.smtp-pass'),
    'MAIL_STATE_DIR=/home/hatch/.exchange-mail',
    'NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem',
]
for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'):
    if os.environ.get(k):
        lines.append(f'{k}={os.environ[k]}')
with open('/etc/exchange-mailerd.env', 'w') as f:
    f.write('\n'.join(lines) + '\n')
os.chmod('/etc/exchange-mailerd.env', 0o600)
print('env file written (values not shown)')
PYEOF

mkdir -p /home/hatch/.exchange-mail
cat > /etc/systemd/system/exchange-mailerd.service << UNIT
[Unit]
Description=Agent Exchange mail service (verification, resets, broadcasts via no-reply@novamail.store)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=/etc/exchange-mailerd.env
ExecStart=/usr/bin/node mail-service/src/service.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now exchange-mailerd
sleep 3
systemctl is-active exchange-mailerd
echo "exchange-mailerd installed and started"
