// SHADOW-BAN SEND-TIME SUPPRESSION — logic test with a stub DB
// (owner order 2026-10-27). Proves: mail to a shadow-banned user is
// suppressed (row marked, no send), the ban notice itself is exempt,
// unbanned users and unknown recipients are never suppressed.
import assert from "node:assert";
import { checkAndSuppress } from "../src/suppression.mjs";

function stubDb(usersByEmail) {
  const patches = [];
  return {
    patches,
    async list(path) {
      const m = decodeURIComponent(path).match(/email=eq\.(.+?)&/);
      const email = m ? m[1] : "";
      const u = usersByEmail[email];
      return u ? [u] : [];
    },
    async patch(path, body) { patches.push({ path, body }); return [{}]; },
  };
}

const banned = { "banned@folk.com": { shadow_banned: true } };

// 1. banned + ordinary kind -> suppressed, row marked, no attempt fields touched
{
  const db = stubDb(banned);
  const row = { id: 11, kind: "job_awarded", to_email: "banned@folk.com", attempts: 0 };
  assert.equal(await checkAndSuppress(db, row), true, "banned recipient must be suppressed");
  assert.equal(db.patches.length, 1);
  assert.equal(db.patches[0].body.status, "suppressed_shadow_ban");
  assert.ok(!("attempts" in db.patches[0].body), "suppression must not burn an attempt");
}
// 2. banned + the notice kind -> NOT suppressed (the one allowed email)
{
  const db = stubDb(banned);
  const row = { id: 12, kind: "shadow_ban_notice", to_email: "banned@folk.com", attempts: 0 };
  assert.equal(await checkAndSuppress(db, row), false, "the ban notice itself must go out");
  assert.equal(db.patches.length, 0);
}
// 3. unbanned user -> not suppressed
{
  const db = stubDb({ "ok@folk.com": { shadow_banned: false } });
  const row = { id: 13, kind: "job_awarded", to_email: "ok@folk.com", attempts: 0 };
  assert.equal(await checkAndSuppress(db, row), false);
  assert.equal(db.patches.length, 0);
}
// 4. unknown recipient (no account) -> not suppressed
{
  const db = stubDb({});
  const row = { id: 14, kind: "job_awarded", to_email: "ghost@folk.com", attempts: 0 };
  assert.equal(await checkAndSuppress(db, row), false);
  assert.equal(db.patches.length, 0);
}
console.log("suppression.test.mjs: ALL PASS");
