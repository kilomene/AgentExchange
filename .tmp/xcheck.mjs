import { readFileSync } from "fs";
const dir = "/home/hatch/workspace/agent-exchange/public/";
const html = readFileSync(dir + "index.html", "utf8");
const js = readFileSync(dir + "app.js", "utf8");
const css = readFileSync(dir + "style.css", "utf8");

let fail = 0;
const referenced = new Set([...js.matchAll(/\$\("#([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
const inHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const createdByJs = new Set([...js.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
const missingIds = [...referenced].filter(id => !inHtml.has(id) && !createdByJs.has(id));
console.log(`ids referenced in JS: ${referenced.size}; static in HTML: ${[...inHtml].join(",")}`);
console.log(missingIds.length ? `MISSING IDS: ${missingIds.join(", ")}` : "IDS OK: every referenced id exists (static or JS-created)");
if (missingIds.length) fail = 1;

const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map(m => m[1]));
const usedJs = new Set([...js.matchAll(/\bic\("([a-z0-9-]+)"/g)].map(m => m[1]));
const usedHtml = new Set([...html.matchAll(/use href="#i-([a-z0-9-]+)"/g)].map(m => m[1]));
const missingIcons = [...new Set([...usedJs, ...usedHtml])].filter(n => !symbols.has(n));
console.log(`icon symbols defined: ${symbols.size}; used: ${new Set([...usedJs, ...usedHtml]).size}`);
console.log(missingIcons.length ? `MISSING ICONS: ${missingIcons.join(", ")}` : "ICONS OK: every referenced icon has a symbol");
if (missingIcons.length) fail = 1;

for (const attr of ["data-award", "data-edit", "data-key", "data-resolve", "data-dep", "data-pay", "data-asus", "data-usus", "data-credit"]) {
  const present = js.includes(`${attr}=`);
  console.log(`${attr}: present-in-templates=${present}`);
  if (!present) fail = 1;
}

const classes = ["btn", "ghost", "green", "red", "sm", "pill", "feat", "purple", "acard", "panel", "kpi", "kpis", "notif", "unread", "msg", "me", "empty", "sec", "sub", "hero", "stat", "stats", "searchbar", "cats", "cat", "on", "toolbar", "grid", "ticker", "ticker-item", "ring", "ident", "ava-wrap", "stars", "skel", "rv", "count", "badge-dot", "wallet-chip", "feed-ic", "hire-chip", "rank", "eyebrow", "modal", "box", "toast", "tabs", "cols", "flex", "grow", "mut", "small", "big", "mt", "sticky-side", "auth-card", "post-card", "side-note"];
const missingCss = classes.filter(c => !new RegExp(`\\.${c}(?![a-zA-Z0-9_-])`).test(css));
console.log(missingCss.length ? `CLASSES WITHOUT CSS: ${missingCss.join(", ")}` : "CSS OK: all key classes styled");
if (missingCss.length) fail = 1;

const emojiLines = js.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /\p{Extended_Pictographic}/u.test(l));
console.log("emoji-bearing lines in app.js:", emojiLines.length ? emojiLines.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`).join(" | ") : "none");

const cfg = readFileSync(dir + "config.js", "utf8");
console.log("config.js:", cfg.includes("xjpfyqzqqjeejrxzafth") ? "points at live API OK" : "CONFIG CHANGED?!");
process.exit(fail);
