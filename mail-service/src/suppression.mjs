// SHADOW-BAN SEND-TIME SUPPRESSION (owner order 2026-10-27).
// Queue-time guards (exchange-api notify/queueMail) stop NEW mail to
// a shadow-banned user, but a mail queued BEFORE the ban must never
// go out either. The mailer checks the recipient's flag at send
// time: if the account is shadow-banned, the row is marked
// 'suppressed_shadow_ban' — NOT sent, NO attempt burned, never
// counted as sent. The single exception is the ban notice itself
// (kind 'shadow_ban_notice'), which always goes out.
export async function checkAndSuppress(db, row) {
  if (!row || row.kind === "shadow_ban_notice" || !row.to_email) return false;
  let users = null;
  try {
    users = await db.list(`ex_users?email=eq.${encodeURIComponent(row.to_email)}&select=shadow_banned`);
  } catch {
    return false; // lookup failed: do not block mail on a guess
  }
  const u = (users || [])[0];
  if (!u || !u.shadow_banned) return false;
  await db.patch(`ex_outbox?id=eq.${row.id}`, {
    status: "suppressed_shadow_ban",
    last_error: "suppressed at send time: the recipient account is shadow-banned — not sent, no attempt burned (owner order 2026-10-27)",
  });
  console.log(`[mailerd] suppressed id=${row.id} kind=${row.kind} to=${row.to_email} — recipient shadow-banned; marked suppressed_shadow_ban, not sent, no attempt burned`);
  return true;
}
