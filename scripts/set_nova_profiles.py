#!/usr/bin/env python3
"""Nova Inc admin identity + Zenas profiles (owner's order, 2026-10-26).
ZERO-MAIL: pure REST PATCHes of existing rows; asserts ex_outbox max id
and the founder wallet are unchanged before/after.
- user 1: 'Nova Fleet' -> 'Nova Inc', verified badge kept, avatar = the
  Nova logo (/nova-icon.png), company bio added.
- user 4 (Zenas Ayansipe): bio = 'CEO & Founder of Nova Inc.',
  nova_affiliate = true.
- agent 13 (Zenas Ayansipe): description (public bio) = same line.
"""
import json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env = {}
for line in (ROOT / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
REST = env["SUPABASE_URL"] + "/rest/v1"
SKEY = env["SUPABASE_SERVICE_ROLE_KEY"]

NOVA_BIO = "The official account of Nova Inc — the software company behind Nova Payments, Nova Domains, the Agent Exchange and the Nova Marketplace."
ZENAS_BIO = "CEO & Founder of Nova Inc."


def rest(path, method="GET", body=None):
    args = ["curl", "-s", "-X", method, REST + path, "-H", f"apikey: {SKEY}",
            "-H", f"Authorization: Bearer {SKEY}", "-H", "Content-Type: application/json",
            "-H", "Prefer: return=representation"]
    if body is not None:
        args += ["--data-binary", json.dumps(body)]
    out = subprocess.run(args, capture_output=True, text=True, timeout=40).stdout
    return json.loads(out) if out else []


def outbox_max():
    rows = rest("/ex_outbox?select=id&order=id.desc&limit=1")
    return rows[0]["id"] if rows else 0


def wallet(uid):
    rows = rest(f"/ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return rows[0] if rows else {}


before_outbox, before_wallet = outbox_max(), wallet(1)
print("before: outbox_max", before_outbox, "founder wallet", before_wallet)

r = rest("/ex_users?id=eq.1", "PATCH", {
    "name": "Nova Inc", "avatar": "/nova-icon.png",
    "verified_badge": True, "bio": NOVA_BIO})
print("user1 ->", [(x["id"], x["name"], x["verified_badge"], x["avatar"], x["bio"]) for x in r])

r = rest("/ex_users?id=eq.4", "PATCH", {"bio": ZENAS_BIO, "nova_affiliate": True})
print("user4 ->", [(x["id"], x["name"], x["verified_badge"], x.get("nova_affiliate"), x["bio"]) for x in r])

r = rest("/ex_agents?id=eq.13", "PATCH", {"description": ZENAS_BIO})
print("agent13 ->", [(x["id"], x["name"], x["description"]) for x in r])

after_outbox, after_wallet = outbox_max(), wallet(1)
assert after_outbox == before_outbox, "OUTBOX CHANGED"
assert after_wallet == before_wallet, "FOUNDER WALLET CHANGED"
print("after: outbox_max", after_outbox, "founder wallet", after_wallet, "— UNCHANGED")
print("DONE")
