#!/usr/bin/env python3
"""Live probe for the 3-agents-per-account cap (owner's pick, 2026-10-26).

Register creates agent #1; two more via POST /my/agents reach the cap of 3;
the 4th create must be refused on BOTH creation paths with the limit
message; /agent/help must state the cap; suspending one agent frees its
slot so a new create succeeds. Prints every created id for cleanup.
"""
import subprocess, json, sys

API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, extra)


def call(method, url, headers=None, body=None):
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, API + url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    text, code = out.rsplit("\n", 1)
    try:
        return int(code), json.loads(text)
    except Exception:
        return int(code), {"raw": text[:300]}


code, reg = call("POST", "/agent/register", body={
    "name": "Cap Probe", "category": "development",
    "email": "zad112911@gmail.com", "skills": "probing",
    "rate": 10, "tagline": "throwaway cap probe", "description": "throwaway cap probe"})
check("register (agent #1) 201", code == 201, str(reg)[:200])
with open("/tmp/cap_probe_state.json", "w") as f:
    json.dump(reg, f)
agent1 = reg["agent"]["id"]
owner_key = reg.get("owner", {}).get("api_key") or reg.get("owner_api_key")
check("owner personal api key returned", bool(owner_key), str(reg.get("owner"))[:150])
OWN = {"X-API-Key": owner_key}
AG1 = {"X-Agent-Key": reg["api_key"]}
created = [agent1]

code, a2 = call("POST", "/my/agents", OWN, {"name": "Cap Probe Two", "category": "writing", "skills": "writing", "rate": 10})
check("create #2 via /my/agents 201", code == 201, str(a2)[:200])
created.append(a2.get("id"))
code, a3 = call("POST", "/my/agents", OWN, {"name": "Cap Probe Three", "category": "research", "skills": "research", "rate": 10})
check("create #3 via /my/agents 201", code == 201, str(a3)[:200])
created.append(a3.get("id"))

code, a4 = call("POST", "/my/agents", OWN, {"name": "Cap Probe Four", "category": "content", "skills": "content", "rate": 10})
check("4th via /my/agents refused 400", code == 400, f"{code} {str(a4)[:200]}")
check("refusal names the limit", "at most 3 agents" in str(a4.get("error", "")), str(a4)[:200])

code, a5 = call("POST", "/agent/owner/agents", AG1, {"name": "Cap Probe Four", "category": "content", "skills": "content", "rate": 10})
check("4th via /agent/owner/agents refused 400", code == 400 and "at most 3 agents" in str(a5.get("error", "")), f"{code} {str(a5)[:200]}")

code, helpj = call("GET", "/agent/help", AG1)
check("/agent/help states the cap", "max 3 agents per account" in json.dumps(helpj), str(helpj)[:200])

code, dl = call("DELETE", f"/my/agents/{a2['id']}", OWN)
check("suspend agent #2 200", code == 200, str(dl)[:150])
code, a6 = call("POST", "/my/agents", OWN, {"name": "Cap Probe Four", "category": "content", "skills": "content", "rate": 10})
check("create after suspend 201 (slot freed)", code == 201, f"{code} {str(a6)[:200]}")
created.append(a6.get("id"))

print(f"\nRESULT: {ok} passed, {fail} failed")
print(json.dumps({"owner_user": reg["owner"]["id"], "agents": created}))
sys.exit(1 if fail else 0)
