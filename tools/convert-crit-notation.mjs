/**
 * Dev-tool (one-off, idempotent): convert the critical-table effects
 * notation in data/system_tables/critical_tables/*.json from the book's
 * symbol Key to the RMF ASCII token notation.
 *
 *   book        →  RMF          meaning
 *   ─────────────────────────────────────────────────────────────
 *   +12H        →  +12H         12 concussion hits (unchanged)
 *   8π          →  8p           must parry 8 rounds
 *   8∏          →  8np          no parry for 8 rounds
 *   8∑          →  8st          stunned for 8 rounds
 *   8∑∏         →  8stnp        stunned AND unable to parry 8 rounds
 *   8∑π         →  8stp         stunned AND must parry 8 rounds
 *   8∫          →  8bl          bleed 8 hits per round
 *   (-8) M(-8)  →  (unchanged)  foe penalty (for M rounds)
 *   (+8) M(+8)  →  (unchanged)  attacker bonus next round (for M rounds)
 *   (2π-15)     →  2p(-15)      must parry 2 rounds at -15
 *   π(-10)      →  p(-10)       (same — the book spells it both ways)
 *   —           →  -            no mechanical effect beyond the text
 *
 * A bare token (no leading number) means 1 round/hit, as in the book.
 * Token separator changes from " – " (en dash) to ", " so free-text
 * fragments survive verbatim. Unrecognised fragments are kept as-is and
 * reported.
 *
 * The script self-verifies: every string is parsed with the OLD and the
 * NEW grammar and both results must be semantically identical.
 *
 * Usage:  node tools/convert-crit-notation.mjs [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "data", "system_tables", "critical_tables");
const DRY = process.argv.includes("--dry-run");

const NONE = new Set(["", "-", "—", "–"]);

/** Shared empty parse result. */
function blank(raw) {
  return { hits: 0, stun: 0, stunNoParry: 0, stunMustParry: 0, mustParry: 0,
    noParry: 0, bleed: 0, penalty: null, bonus: null, parryPenalty: null,
    other: [], raw, empty: false };
}

/** Parse with the legacy (book-symbol) grammar — mirror of the old engine. */
function parseOld(raw) {
  const text = String(raw ?? "").trim();
  const out = blank(text);
  if (NONE.has(text)) { out.empty = true; return out; }
  for (const tok of text.split(/\s*[–,]\s*/).map(t => t.trim()).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^\+?(\d+)\s*H$/i)))             { out.hits += Number(m[1]); continue; }
    if ((m = tok.match(/^(\d*)∑∏$/)))                   { out.stunNoParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∑π$/)))                   { out.stunMustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∑$/)))                    { out.stun += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∏$/)))                    { out.noParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)π$/)))                    { out.mustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∫$/)))                    { out.bleed += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)\(\s*-\s*(\d+)\s*\)$/)))  { out.penalty = { value: -Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    if ((m = tok.match(/^(\d*)\(\s*\+\s*(\d+)\s*\)$/))) { out.bonus = { value: Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    if ((m = tok.match(/^\((\d*)π\s*-\s*(\d+)\)$/)) || (m = tok.match(/^(\d*)π\(\s*-\s*(\d+)\s*\)$/))) {
      const rounds = Number(m[1] || 1);
      out.mustParry += rounds;
      out.parryPenalty = { value: -Number(m[2]), rounds };
      continue;
    }
    out.other.push(tok);
  }
  return out;
}

/** Parse with the new (RMF ASCII token) grammar — mirror of the new engine. */
function parseNew(raw) {
  const text = String(raw ?? "").trim();
  const out = blank(text);
  if (NONE.has(text)) { out.empty = true; return out; }
  for (const tok of text.split(/\s*[–,]\s*/).map(t => t.trim()).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^\+?(\d+)\s*H$/i)))             { out.hits += Number(m[1]); continue; }
    if ((m = tok.match(/^(\d*)stnp$/i)))                { out.stunNoParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)stp$/i)))                 { out.stunMustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)st$/i)))                  { out.stun += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)np$/i)))                  { out.noParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)bl$/i)))                  { out.bleed += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)p\(\s*-\s*(\d+)\s*\)$/i))) {
      const rounds = Number(m[1] || 1);
      out.mustParry += rounds;
      out.parryPenalty = { value: -Number(m[2]), rounds };
      continue;
    }
    if ((m = tok.match(/^(\d*)p$/i)))                   { out.mustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)\(\s*-\s*(\d+)\s*\)$/)))  { out.penalty = { value: -Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    if ((m = tok.match(/^(\d*)\(\s*\+\s*(\d+)\s*\)$/))) { out.bonus = { value: Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    out.other.push(tok);
  }
  return out;
}

const unmapped = new Map();

/** Convert one token. Returns the new spelling (verbatim if unknown). */
function convertToken(tok, where) {
  let m;
  if ((m = tok.match(/^\+?(\d+)\s*H$/i)))             return `+${m[1]}H`;
  if ((m = tok.match(/^(\d*)∑∏$/)))                   return `${m[1]}stnp`;
  if ((m = tok.match(/^(\d*)∑π$/)))                   return `${m[1]}stp`;
  if ((m = tok.match(/^(\d*)∑$/)))                    return `${m[1]}st`;
  if ((m = tok.match(/^(\d*)∏$/)))                    return `${m[1]}np`;
  if ((m = tok.match(/^(\d*)π$/)))                    return `${m[1]}p`;
  if ((m = tok.match(/^(\d*)∫$/)))                    return `${m[1]}bl`;
  if ((m = tok.match(/^(\d*)\(\s*-\s*(\d+)\s*\)$/)))  return `${m[1]}(-${m[2]})`;
  if ((m = tok.match(/^(\d*)\(\s*\+\s*(\d+)\s*\)$/))) return `${m[1]}(+${m[2]})`;
  if ((m = tok.match(/^\((\d*)π\s*-\s*(\d+)\)$/)) || (m = tok.match(/^(\d*)π\(\s*-\s*(\d+)\s*\)$/)))
    return `${m[1]}p(-${m[2]})`;
  // Already-converted (idempotency) or free text: keep verbatim.
  if (!/^[+]?\d*[Hh]$|^(\d*)(stnp|stp|st|np|bl|p)$|^(\d*)p\(-\d+\)$/i.test(tok) && /[π∏∑∫]/.test(tok)) {
    if (!unmapped.has(tok)) unmapped.set(tok, where);
  }
  return tok;
}

/** Convert one effects string. */
function convertEffects(raw, where) {
  const text = String(raw ?? "").trim();
  if (text === "") return "";
  if (NONE.has(text)) return "-";
  return text.split(/\s*[–,]\s*/).map(t => t.trim()).filter(Boolean)
    .map(t => convertToken(t, where)).join(", ");
}

const LEGEND = {
  key: "Np = must parry N rounds; Nnp = no parry for N rounds; Nst = stunned for N rounds; Nstnp = stunned and unable to parry for N rounds; Nbl = bleed N hits per round; (-N) = foe has -N penalty; (+N) = attacker gets +N next round.",
  hits: "+NH = N concussion hits.",
  rounds: "M(-N) / M(+N) = the penalty/bonus lasts M rounds. A bare token (p, st, bl, ...) = 1 round. Np(-M) = must parry N rounds at a -M penalty.",
  none: "\"-\" = no mechanical effect beyond the text (often death).",
  variants: "Conditional cells (e.g. \"with helmet / w/o helmet\") apply the matching variant."
};

/** Compare old-vs-new parse results (semantic equality). */
function sameParse(a, b) {
  const flat = x => JSON.stringify([x.empty, x.hits, x.stun, x.stunNoParry,
    x.stunMustParry, x.mustParry, x.noParry, x.bleed, x.penalty, x.bonus,
    x.parryPenalty, x.other]);
  return flat(a) === flat(b);
}

let converted = 0, mismatches = 0;
for (const file of fs.readdirSync(DIR).filter(f => f.endsWith(".json")).sort()) {
  const fp = path.join(DIR, file);
  const json = JSON.parse(fs.readFileSync(fp, "utf8"));
  for (const row of json.rows ?? []) {
    for (const [col, cell] of Object.entries(row.results ?? {})) {
      const where = `${file} ${row.label} ${col}`;
      const apply = (obj) => {
        const before = obj.effects ?? "";
        const after = convertEffects(before, where);
        if (after === before) return; // already converted — nothing to verify
        if (!sameParse(parseOld(before), parseNew(after))) {
          mismatches++;
          console.error(`MISMATCH ${where}: "${before}" → "${after}"`);
        }
        obj.effects = after;
        converted++;
      };
      apply(cell);
      for (const v of cell.variants ?? []) apply(v);
    }
  }
  json.legend = { ...LEGEND };
  if (!DRY) fs.writeFileSync(fp, JSON.stringify(json, null, 2) + "\n");
  console.log(`${DRY ? "[dry] " : ""}${file}: ok`);
}

if (unmapped.size) {
  console.error("\nUnmapped symbol tokens (kept verbatim):");
  for (const [tok, where] of unmapped) console.error(`  "${tok}"  first seen at ${where}`);
}
console.log(`\n${converted} effects strings converted; ${mismatches} parse mismatches; ${unmapped.size} unmapped symbol tokens.`);
process.exit(mismatches || unmapped.size ? 1 : 0);
