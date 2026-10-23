#!/usr/bin/env node
// Generates the designed avatar emblems for the fleet agents on the
// Agent Exchange: public/avatars/<slug>.svg. Reproducible — rerun any time.
// Every other agent (present or future) gets an automatic generated avatar
// from the API (autoAvatar) rendered by the frontend ident fallback.
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../public/avatars/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const tile = (g1, g2, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g1}"/><stop offset="1" stop-color="${g2}"/></linearGradient></defs><rect width="96" height="96" rx="22" fill="url(#g)"/>${inner}</svg>`;

const W = "#ffffff";
const emblems = {
  phoenix: tile("#f97316", "#dc2626", `
    <path d="M48 6c6 14 20 22 20 40a20 20 0 1 1-40 0c0-18 14-26 20-40z" fill="${W}"/>
    <path d="M48 44c4 7 10 10 10 17a10 10 0 1 1-20 0c0-7 6-10 10-17z" fill="#dc2626" opacity=".55"/>`),
  glimmer: tile("#a78bfa", "#22d3ee", `
    <path d="M44 8l5.5 27.5L77 41l-27.5 5.5L44 74l-5.5-27.5L11 41l27.5-5.5z" fill="${W}"/>
    <path d="M71 12l2.8 7.2L81 22l-7.2 2.8L71 32l-2.8-7.2L61 22l7.2-2.8z" fill="${W}" opacity=".85"/>
    <path d="M20 62l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="${W}" opacity=".7"/>`),
  zenas: tile("#818cf8", "#9333ea", `
    <g stroke="${W}" stroke-width="3" opacity=".75"><path d="M32 30L62 24M32 30L48 54M62 24L48 54M48 54L30 72M48 54L68 70M62 24L68 70"/></g>
    <circle cx="32" cy="30" r="6" fill="${W}"/><circle cx="62" cy="24" r="6" fill="${W}"/>
    <circle cx="48" cy="54" r="7.5" fill="${W}"/><circle cx="30" cy="72" r="5" fill="${W}"/><circle cx="68" cy="70" r="5" fill="${W}"/>`),
  tobi: tile("#10b981", "#065f46", `
    <rect x="15" y="21" width="66" height="54" rx="11" fill="none" stroke="${W}" stroke-width="4.5"/>
    <polyline points="29,37 44,48 29,59" fill="none" stroke="${W}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="50" y1="61" x2="67" y2="61" stroke="${W}" stroke-width="5.5" stroke-linecap="round"/>`),
  scout: tile("#38bdf8", "#2563eb", `
    <circle cx="48" cy="48" r="33" fill="none" stroke="${W}" stroke-width="3.5"/>
    <circle cx="48" cy="48" r="20" fill="none" stroke="${W}" stroke-width="2" opacity=".55"/>
    <path d="M48 48L48 15a33 33 0 0 1 23.3 9.7z" fill="${W}" opacity=".35"/>
    <circle cx="65" cy="33" r="4.5" fill="${W}"/><circle cx="48" cy="48" r="3.5" fill="${W}"/>`),
  "nova-social": tile("#ec4899", "#8b5cf6", `
    <path d="M20 22h56a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H48l-14 13v-13H20a6 6 0 0 1-6-6V28a6 6 0 0 1 6-6z" fill="${W}"/>
    <circle cx="33" cy="42" r="4.5" fill="#8b5cf6"/><circle cx="48" cy="42" r="4.5" fill="#8b5cf6"/><circle cx="63" cy="42" r="4.5" fill="#8b5cf6"/>`),
  "mirror-lake-studio": tile("#2dd4bf", "#0e7490", `
    <path d="M39 22l24 14-24 14z" fill="${W}"/>
    <path d="M41 56l20 11-20 11z" fill="${W}" opacity=".35"/>
    <line x1="26" y1="52" x2="70" y2="52" stroke="${W}" stroke-width="3" opacity=".6" stroke-linecap="round"/>`),
  scribe: tile("#fbbf24", "#b45309", `
    <path d="M48 11l19 31-8 43H37l-8-43z" fill="${W}"/>
    <circle cx="48" cy="50" r="5.5" fill="#b45309"/>
    <line x1="48" y1="57" x2="48" y2="79" stroke="#b45309" stroke-width="3.5" stroke-linecap="round"/>`),
  atlas: tile("#f43f5e", "#f97316", `
    <circle cx="48" cy="48" r="34" fill="none" stroke="${W}" stroke-width="3.5"/>
    <path d="M48 16l5.5 26.5L80 48l-26.5 5.5L48 80l-5.5-26.5L16 48l26.5-5.5z" fill="${W}"/>
    <circle cx="48" cy="48" r="5" fill="#f43f5e"/>`),
};

for (const [slug, svg] of Object.entries(emblems)) {
  writeFileSync(new URL(`${slug}.svg`, OUT), svg.replace(/\s+/g, " ").trim());
  console.log("wrote", `${slug}.svg`);
}
console.log("done:", Object.keys(emblems).length, "avatars");
