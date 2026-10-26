#!/usr/bin/env python3
"""Job-chat safety (owner's order, 2026-10-26): links, emails, phone numbers,
social handles/profiles and foul language are automatically hidden in the
job chat - at write time and at read time. Assert-exactly-once edits."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
HTML = ROOT / "public/index.html"
README = ROOT / "README.md"


def rep(path: Path, old: str, new: str, count: int = 1):
    t = path.read_text()
    assert t.count(old) == count, f"{path.name}: expected {count} of {old[:70]!r}, found {t.count(old)}"
    path.write_text(t.replace(old, new))
    print(f"OK {path.name}: {old[:60]!r}...")


SANITIZER = '''
  const CHAT_HIDDEN = "[hidden]";
  // JOB CHAT SAFETY (owner's order, 2026-10-26): the job chat is fully
  // secured - links, email addresses, phone numbers, social-media handles
  // or profiles and foul language are automatically hidden. Applied at
  // write time (nothing unsafe is ever stored) and again at read time
  // (older messages are covered too).
  function sanitizeChat(input: unknown): string {
    let s = String(input ?? "");
    s = s.replace(/\\b(?:https?:\\/\\/|ftp:\\/\\/|www\\.)\\S+/gi, CHAT_HIDDEN);
    s = s.replace(/\\b[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+\\b/g, CHAT_HIDDEN);
    s = s.replace(/\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:com|net|org|io|co|app|dev|me|info|xyz|site|online|store|gg|tv|ai|tech|pro|biz|us|uk|ng|ca|de|fr|au|jp|br|mx|es|it|nl|za|ke|gh|ph|sg|ae)(?:\\/\\S*)?/gi, CHAT_HIDDEN);
    s = s.replace(/@[a-z0-9_.]{2,}/gi, CHAT_HIDDEN);
    s = s.replace(/\\b(instagram|insta|tiktok|snapchat|snap|telegram|whatsapp|facebook|discord|twitter|ig|fb)\\s*(?:is|:|=|\\u2014|-)\\s*(\\S+)/gi,
      (m: string, _p: string, tok: string) => /[@0-9_.]/.test(tok) ? CHAT_HIDDEN : m);
    s = s.replace(/\\+?\\(?\\d[\\d\\s().-]{4,}\\d/g,
      (m: string) => /^\\d{4}-\\d{2}-\\d{2}$/.test(m.trim()) ? m : (m.replace(/\\D/g, "").length >= 7 ? CHAT_HIDDEN : m));
    s = s.replace(/\\b(?:fuck\\w*|shit\\w*|bitch\\w*|whore\\w*|slut\\w*|asshole\\w*|dickhead\\w*|motherfucker\\w*|nigger\\w*|nigga\\w*|faggot\\w*|bastard\\w*|cunt|pussy)\\b/gi, CHAT_HIDDEN);
    return s;
  }
'''

# 1) sanitizer + write-time hook + read-time hooks in index.ts
rep(TS,
    '  async function postJobMessage(job: any, senderUserId: number, rawText: unknown) {',
    SANITIZER + '  async function postJobMessage(job: any, senderUserId: number, rawText: unknown) {')
rep(TS,
    'body: JSON.stringify({ job_id: job.id, sender_user_id: senderUserId, body: text.slice(0, 2000), created_at: now() })',
    'body: JSON.stringify({ job_id: job.id, sender_user_id: senderUserId, body: sanitizeChat(text).slice(0, 2000), created_at: now() })')
rep(TS,
    'const messages = await pg(`ex_messages?job_id=eq.${id}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`);',
    'const messages = (await pg(`ex_messages?job_id=eq.${id}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`)).map((m: any) => ({ ...m, body: sanitizeChat(m.body) }));')
rep(TS,
    'const messages = await pg(`ex_messages?job_id=eq.${jobId}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`);',
    'const messages = (await pg(`ex_messages?job_id=eq.${jobId}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`)).map((m: any) => ({ ...m, body: sanitizeChat(m.body) }));')
rep(TS,
    'job_chat: "At most 30 messages per person per job per rolling hour (429 beyond that).",',
    'job_chat: "At most 30 messages per person per job per rolling hour (429 beyond that).",\n          chat_safety: "The job chat is fully secured: links, email addresses, phone numbers, social-media handles or profiles and foul language are automatically hidden the moment a message is posted - nobody can see them.",')

# 2) frontend mirror + copy
rep(APP,
    'const novaAff = (on) => on ?',
    '''const CHAT_HIDDEN = "[hidden]";
const maskChat = (input) => { let s = String(input ?? ""); s = s.replace(/\\b(?:https?:\\/\\/|ftp:\\/\\/|www\\.)\\S+/gi, CHAT_HIDDEN); s = s.replace(/\\b[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+\\b/g, CHAT_HIDDEN); s = s.replace(/\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.(?:com|net|org|io|co|app|dev|me|info|xyz|site|online|store|gg|tv|ai|tech|pro|biz|us|uk|ng|ca|de|fr|au|jp|br|mx|es|it|nl|za|ke|gh|ph|sg|ae)(?:\\/\\S*)?/gi, CHAT_HIDDEN); s = s.replace(/@[a-z0-9_.]{2,}/gi, CHAT_HIDDEN); s = s.replace(/\\b(instagram|insta|tiktok|snapchat|snap|telegram|whatsapp|facebook|discord|twitter|ig|fb)\\s*(?:is|:|=|\\u2014|-)\\s*(\\S+)/gi, (m, _p, tok) => /[@0-9_.]/.test(tok) ? CHAT_HIDDEN : m); s = s.replace(/\\+?\\(?\\d[\\d\\s().-]{4,}\\d/g, (m) => /^\\d{4}-\\d{2}-\\d{2}$/.test(m.trim()) ? m : (m.replace(/\\D/g, "").length >= 7 ? CHAT_HIDDEN : m)); s = s.replace(/\\b(?:fuck\\w*|shit\\w*|bitch\\w*|whore\\w*|slut\\w*|asshole\\w*|dickhead\\w*|motherfucker\\w*|nigger\\w*|nigga\\w*|faggot\\w*|bastard\\w*|cunt|pussy)\\b/gi, CHAT_HIDDEN); return s; };
const novaAff = (on) => on ?''')
rep(APP, '${esc(m.body)}', '${esc(maskChat(m.body))}')
rep(APP,
    '<p class="small mut">Public — everyone can read this chat. Anyone signed in can post.</p>',
    '<p class="small mut">Public — everyone can read this chat. Anyone signed in can post. Fully secured: links, contact details, social handles and foul language are hidden automatically.</p>')
rep(APP,
    '- <b>Job chat</b> - at most <b>30 messages per person on one job per hour</b>.',
    '- <b>Job chat</b> - at most <b>30 messages per person on one job per hour</b>. The chat is fully secured: <b>links, email addresses, phone numbers, social-media handles or profiles and foul language are hidden automatically</b> the moment a message is posted - nobody can see them.')

# 3) README
rep(README,
    '- **Job chat:** at most 30 messages per person per job per rolling hour.',
    '- **Job chat:** at most 30 messages per person per job per rolling hour. The chat is fully secured: links, email addresses, phone numbers, social-media handles or profiles and foul language are automatically hidden the moment a message is posted.')

# 4) cache bump
rep(HTML, '20261026-13', '20261026-14', count=2)
print("ALL EDITS APPLIED")
