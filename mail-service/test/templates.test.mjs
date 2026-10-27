// Render tests for src/templates.mjs — every kind in TEMPLATE_KINDS must
// render a real template, unknown kinds must throw, and the agent
// credentials mails (agent_welcome / agent_recovery) must carry the
// full recovery chain. Run: node mail-service/test/templates.test.mjs
import { renderMail, TEMPLATE_KINDS } from "../src/templates.mjs";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

const payload = {
  name: "Test Owner", title: "A job", link: "https://exchange.novamail.store/#/reset-password?token=RAWTOKEN",
  agent_name: "RecoveryBot", expires_hours: 72, amount_cents: 1500, asset: "USDC",
  body: "Hello from the platform.", stars: 5, review: "Great work.", winner_name: "Other",
  poster_name: "Poster", category: "research", budget: "$25.00", mode: "bidding",
  when: "just now", source_label: "Changed in your account settings", reset_link: "https://exchange.novamail.store/#/forgot",
  destination: "bc1qexample", reason: "a reason", summary: "a summary", amount: "$15.00",
  amount_label: "Amount", wallet_before: "$0.00", wallet_after: "$15.00", wallet_balance: "$15.00",
  escrow_held: "$0.00", wallet_total: "$15.00", deadline: "soon", notes: "notes",
};

// 1. Every declared kind renders (broadcast included).
for (const kind of TEMPLATE_KINDS) {
  try {
    const out = renderMail({ kind, to_name: "Test Owner", subject: "Broadcast subject", payload });
    check(`kind ${kind} renders subject+text+html`, !!(out.subject && out.text && out.html));
  } catch (e) {
    check(`kind ${kind} renders (threw: ${e.message})`, false);
  }
}

// 2. Unknown kind still throws (no broadcast fallthrough).
let threw = false;
try { renderMail({ kind: "no_such_kind", payload }); } catch { threw = true; }
check("unknown kind throws", threw);

// 3+4. The two credentials mails carry the whole recovery chain.
const expect = [
  ["agent_welcome", "Your agent is registered on the Agent Exchange — your credentials link"],
  ["agent_recovery", "Your Agent Exchange credentials link"],
];
for (const [kind, subject] of expect) {
  const out = renderMail({ kind, to_name: "Test Owner", payload });
  check(`${kind} subject exact`, out.subject === subject);
  check(`${kind} names the agent`, out.text.includes("RecoveryBot") && out.html.includes("RecoveryBot"));
  check(`${kind} carries the claim link`, out.text.includes(payload.link) && out.html.includes(payload.link));
  check(`${kind} states the 72-hour expiry`, out.text.includes("72 hours") && out.html.includes("72 hours"));
  check(`${kind} step 1 (set password / verifies email)`, out.text.includes("set your own password") && out.text.includes("verifies your email"));
  check(`${kind} step 2 (log in)`, out.text.includes("Log in at exchange.novamail.store"));
  check(`${kind} step 3 (My Agents / Rotate API key)`, out.text.includes("My Agents") && out.text.includes("Rotate API key") && out.text.includes("Profile"));
  check(`${kind} ignore line (keys keep working)`, out.text.includes("did not request this, ignore this email") && out.text.includes("existing keys keep working until a new password is set"));
  check(`${kind} html has the CTA button`, out.html.includes("Set my password"));
  check(`${kind} is in TEMPLATE_KINDS`, TEMPLATE_KINDS.has(kind));
}

console.log(`templates.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
