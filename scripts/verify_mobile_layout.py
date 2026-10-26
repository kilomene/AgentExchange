#!/usr/bin/env python3
"""Agent Exchange — mobile layout proof for the form rows (owner mobile rule,
2026-10-26: "mobile view should be mobile view, desktop view should remain
desktop view").

Renders the verbatim post-form / bid-row / attempt-controls / capability-panel
markup from public/app.js against the REAL public/style.css in headless
Chromium (Playwright) at 390px and 1280px, and measures:
 - no page-level horizontal overflow at either width;
 - at 390px every field sits inside the viewport and the .frow rows stack
   into full-width single columns (the call-window row becomes 4 lines);
 - at 1280px the same rows stay side-by-side multi-column (desktop unchanged).
Exits 1 on any failure. Requires playwright + chromium (present on the VM).
"""
import json
import sys
from pathlib import Path

ROOT = Path.home() / "workspace" / "agent-exchange"
HARNESS_PATH = Path("/tmp/mobile_harness.html")

HARNESS = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="file://__CSS__">
</head><body>
<main id="app" class="wrap">
  <div class="panel post-card rv in">
    <h2 style="font-size:24px;display:flex;align-items:center;gap:10px">Post a job</h2>
    <label>Job title</label><input id="j-title" placeholder="What needs doing?">
    <label>Description</label><textarea id="j-desc" rows="6"></textarea>
    <label>Category</label><select id="j-cat"><option value="personal">Personal</option></select>
    <div class="flex frow"><div class="grow"><label>Budget (USD)</label><input id="j-budget" type="number" step="0.01" min="1"></div>
    <div class="grow"><label>Mode</label><select id="j-mode"><option value="bidding">Open bidding</option><option value="fixed">Fixed price — first claim wins</option></select></div>
    <div class="grow"><label>Bidding window (hours)</label><input id="j-deadline" type="number" min="1" value="48"></div></div>
    <label>Job type</label><select id="j-kind"><option value="contract">Contract call</option></select>
    <div id="contract-fields">
      <div class="flex frow"><div class="grow"><label>Contact name</label><input id="c-name" placeholder="Who is being called?"></div>
      <div class="grow"><label>Contact phone number</label><input id="c-phone" placeholder="+1 555 123 4567"></div></div>
      <label>What the call is about</label><textarea id="c-brief" rows="2"></textarea>
      <div class="flex frow"><div class="grow"><label>Call window starts</label><input id="c-wstart" type="datetime-local"></div>
      <div class="grow"><label>Call window ends</label><input id="c-wend" type="datetime-local"></div>
      <div class="grow"><label>Timezone</label><input id="c-tz" value="UTC"></div>
      <div class="grow"><label>Max attempts (1–5)</label><input id="c-attempts" type="number" min="1" max="5" value="3"></div></div>
      <label>How the winner is paid</label><select id="c-paypreset"><option value="perminute">Pay per minute — pay for answered call time</option></select>
      <div id="c-payminute">
        <div class="flex frow"><div class="grow"><label>Rate per answered minute (USD)</label><input id="c-pm-rate" type="number" step="0.01" min="0.10" value="2.50"></div>
        <div class="grow"><label>Max paid minutes (1–600)</label><input id="c-pm-max" type="number" min="1" max="600" value="30"></div></div>
      </div>
      <label>Your attestation (required)</label><textarea id="c-attest" rows="2"></textarea>
    </div>
    <label class="mt">Milestones (optional)</label>
    <div id="ms-rows"><div class="flex ms-row" style="gap:6px;margin-top:6px"><input class="ms-t grow" placeholder="Milestone title (e.g. First draft)"><input class="ms-p" type="number" min="5" max="95" value="50" style="max-width:90px"><span class="small mut">%</span></div></div>
    <button class="btn green mt" style="width:100%" id="j-go">Lock escrow &amp; post job</button>
  </div>

  <div class="panel rv">
    <h4 class="mt">Place a bid</h4>
    <label>Bid as agent</label><select id="bid-agent"><option>Agent One</option></select>
    <div class="flex frow"><div class="grow"><label>Your price (USD)</label><input id="bid-amt" type="number" step="0.01" min="0.5"></div>
    <div class="grow"><label>ETA (hours)</label><input id="bid-eta" type="number" min="1" value="24"></div></div>
    <div class="deliv-box"><h4>Contract call — the brief</h4>
      <div class="flex mt" style="flex-wrap:wrap;gap:8px"><select id="att-outcome"><option value="answered_completed">answered completed</option></select><input id="att-dur" type="number" min="0" placeholder="call seconds" style="max-width:130px"><button class="btn sm green" id="att-close">Close attempt #7</button></div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:16px"><h3>Contract capabilities</h3>
    <div class="notif" style="align-items:flex-start"><div class="grow"><b>Agent One</b> <span class="pill">not verified</span>
      <div class="flex mt" style="flex-wrap:wrap;gap:8px"><input id="cap-phone-1" placeholder="Caller number, e.g. +1 555 123 4567" value="" style="min-width:220px"><button class="btn sm">Attest number</button><button class="btn sm green">Start the Call Test</button></div>
      <div class="mt" style="border-top:1px solid var(--line);padding-top:10px"><b>Call Test challenge</b>
        <div class="flex mt" style="flex-wrap:wrap;gap:8px"><input type="file" id="ct-file-1" accept="audio/*"></div>
        <label>Transcript of the test call</label><textarea id="ct-tr-1" rows="3"></textarea>
        <label>Answer 1</label><input id="ct-a1-1"><label>Answer 2</label><input id="ct-a2-1">
      </div>
    </div></div>
  </div>
</main>
</body></html>
"""

FIELDS = ["j-budget", "j-mode", "j-deadline", "c-name", "c-phone", "c-wstart",
          "c-wend", "c-tz", "c-attempts", "c-pm-rate", "c-pm-max",
          "bid-amt", "bid-eta", "att-outcome", "att-dur", "cap-phone-1"]

MEASURE = """(ids) => {
  const out = { innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth, fields: {} };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out.fields[id] = null; continue; }
    const r = el.getBoundingClientRect();
    out.fields[id] = { left: Math.round(r.left), right: Math.round(r.right),
                       top: Math.round(r.top), width: Math.round(r.width) };
  }
  return out;
}"""


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed — layout check cannot run here")
        return 1
    HARNESS_PATH.write_text(HARNESS.replace("__CSS__", str(ROOT / "public" / "style.css")))
    fails = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ---- phone: 390px — true single-column mobile layout
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(HARNESS_PATH.as_uri())
        pg.wait_for_timeout(400)
        m = pg.evaluate(MEASURE, FIELDS)
        print("390px:", json.dumps(m))
        if m["docScrollWidth"] > m["innerWidth"]:
            fails.append(f"390: page horizontal overflow {m['docScrollWidth']} > {m['innerWidth']}")
        for fid, box in m["fields"].items():
            if box is None:
                fails.append(f"390: field #{fid} missing")
            elif box["right"] > 391 or box["left"] < -1:
                fails.append(f"390: #{fid} out of viewport L{box['left']} R{box['right']}")
        tops = {k: m["fields"][k]["top"] for k in ("c-wstart", "c-wend", "c-tz", "c-attempts")}
        if len(set(tops.values())) != 4:
            fails.append(f"390: window row NOT stacked into 4 lines: {tops}")
        else:
            print("390: window row stacks to 4 full-width lines")
        pm = {k: m["fields"][k]["top"] for k in ("c-pm-rate", "c-pm-max")}
        if len(set(pm.values())) != 2:
            fails.append(f"390: per-minute row NOT stacked: {pm}")
        pg.close()
        # ---- desktop: 1280px — must remain the multi-column layout
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(HARNESS_PATH.as_uri())
        pg.wait_for_timeout(400)
        m = pg.evaluate(MEASURE, FIELDS)
        print("1280px:", json.dumps(m))
        if m["docScrollWidth"] > m["innerWidth"]:
            fails.append(f"1280: page horizontal overflow {m['docScrollWidth']} > {m['innerWidth']}")

        def one_row(keys):
            boxes = [m["fields"][k] for k in keys]
            lefts = [x["left"] for x in boxes]
            tops = [x["top"] for x in boxes]
            return lefts == sorted(lefts) and len(set(lefts)) == len(lefts) and max(tops) - min(tops) < 40

        for name, keys in (("window", ("c-wstart", "c-wend", "c-tz", "c-attempts")),
                           ("budget", ("j-budget", "j-mode", "j-deadline")),
                           ("per-minute", ("c-pm-rate", "c-pm-max"))):
            if not one_row(keys):
                fails.append(f"1280: {name} row NOT one desktop row")
            else:
                print(f"1280: {name} row stays one side-by-side desktop row")
        pg.close()
        b.close()
    if fails:
        print("\nMOBILE CHECK FAILURES:")
        for f in fails:
            print(" -", f)
        return 1
    print("\nMOBILE CHECK: ALL PASS (390 stacked, no overflow; 1280 unchanged)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
