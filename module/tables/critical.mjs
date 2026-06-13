/**
 * RMF Tables — critical strike engine.
 *
 * Parses the RMF critical effects notation and resolves lookups on
 * criticalTable data. The canonical notation (ASCII tokens, comma
 * separated — readable replacement for the book's symbol Key):
 *
 *   Np     must parry N rounds           +NH  N concussion hits
 *   Nnp    no parry for N rounds         Nbl  bleed N hits per round
 *   Nst    stunned for N rounds          (-N) foe has -N penalty
 *   Nstnp  stunned AND unable to parry   (+N) attacker gets +N next round
 *   Np(-M) must parry N rounds at a -M penalty
 *   M(-N) / M(+N)  the penalty/bonus lasts M rounds
 *
 * A bare token (p, st, bl, ...) means 1 round. "-" / "" means no
 * mechanical effect (the text says it all — usually death). Anything the
 * parser does not recognise is preserved verbatim in `other[]` so no book
 * content is ever silently dropped.
 *
 * The book's original symbols (ßπ must parry, ß∏ no parry, ß∑ stunned,
 * ß∑∏, ß∫ bleed, (Mπ-N)/Mπ(-N), en-dash separators) are still accepted as
 * a LEGACY grammar so criticalTable items imported before the notation
 * change keep resolving. New data must use the ASCII tokens
 * (data/system_tables/critical_tables/ is already converted — see
 * tools/convert-crit-notation.mjs).
 *
 * Pure module (no Foundry deps at module level) — testable in node.
 *
 * @module tables/critical
 */

import { findAttackRow } from "./lookup.mjs";

/**
 * @typedef {Object} ParsedEffects
 * @property {number} hits        Concussion hits.
 * @property {number} stun        Rounds stunned (parry still possible).
 * @property {number} stunNoParry Rounds stunned AND unable to parry.
 * @property {number} mustParry   Rounds the foe must parry.
 * @property {number} noParry     Rounds the foe cannot parry (not stunned).
 * @property {number} bleed       Bleed hits per round.
 * @property {{value:number, rounds:number}|null} penalty  Foe penalty.
 * @property {{value:number, rounds:number}|null} bonus    Attacker bonus.
 * @property {{value:number, rounds:number}|null} parryPenalty  "Mp(-N)"
 *   (legacy "(Mπ-N)" / "Mπ(-N)"): the foe must parry M rounds AT a -N
 *   penalty (also adds to `mustParry`).
 * @property {string[]} other     Unrecognised fragments, verbatim.
 * @property {string}  raw        The original notation string.
 * @property {boolean} empty      True when the cell has no notation.
 */

const NONE_TOKENS = new Set(["", "-", "—", "–"]);

/**
 * Parse one effects notation string (no variants).
 *
 * @param {string|null|undefined} raw
 * @returns {ParsedEffects}
 */
export function parseCriticalEffects(raw) {
  const text = (raw === null || raw === undefined) ? "" : String(raw).trim();
  const out = {
    hits: 0, stun: 0, stunNoParry: 0, mustParry: 0, noParry: 0, bleed: 0,
    penalty: null, bonus: null, parryPenalty: null, other: [], raw: text, empty: false
  };
  if (NONE_TOKENS.has(text)) { out.empty = true; return out; }

  // Canonical tokens are comma separated; legacy cells used en dashes.
  // No token contains either character, so splitting on both is safe.
  const tokens = text.split(/\s*[,–]\s*/).map(t => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    let m;
    if ((m = tok.match(/^\+?(\d+)\s*H$/i)))            { out.hits        += Number(m[1]); continue; }
    // ── Canonical RMF notation (order matters: stnp/stp before st/np/p) ──
    if ((m = tok.match(/^(\d*)stnp$/i)))               { out.stunNoParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)stp$/i)))                { out.stun        += Number(m[1] || 1); out.mustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)st$/i)))                 { out.stun        += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)np$/i)))                 { out.noParry     += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)bl$/i)))                 { out.bleed       += Number(m[1] || 1); continue; }
    // "Np(-M)": must parry N rounds at a -M penalty (check before bare "Np").
    if ((m = tok.match(/^(\d*)p\(\s*-\s*(\d+)\s*\)$/i))) {
      const rounds = Number(m[1] || 1);
      out.mustParry += rounds;
      out.parryPenalty = { value: -Number(m[2]), rounds };
      continue;
    }
    if ((m = tok.match(/^(\d*)p$/i)))                  { out.mustParry   += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)\(\s*-\s*(\d+)\s*\)$/))) { out.penalty = { value: -Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    if ((m = tok.match(/^(\d*)\(\s*\+\s*(\d+)\s*\)$/))) { out.bonus  = { value:  Number(m[2]), rounds: Number(m[1] || 1) }; continue; }
    // ── Legacy book symbols (pre-conversion documents) ──
    if ((m = tok.match(/^(\d*)∑∏$/)))                  { out.stunNoParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∑π$/)))                  { out.stun        += Number(m[1] || 1); out.mustParry += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∑$/)))                   { out.stun        += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∏$/)))                   { out.noParry     += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)π$/)))                   { out.mustParry   += Number(m[1] || 1); continue; }
    if ((m = tok.match(/^(\d*)∫$/)))                   { out.bleed       += Number(m[1] || 1); continue; }
    // "(Mπ-N)" or "Mπ(-N)": legacy spellings of Mp(-N).
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

/**
 * @typedef {Object} CriticalCell
 * @property {string} text     Narrative result text.
 * @property {string} effects  Effects notation ("" when variants apply).
 * @property {Array<{condition:string, effects:string}>} [variants]
 */

/**
 * @typedef {Object} CriticalLookup
 * @property {CriticalCell|null} cell
 * @property {ParsedEffects|null} parsed   Parsed flat effects (null if the
 *   cell is variant-only — pick a variant and parse it instead).
 * @property {Array<{condition:string, effects:string, parsed:ParsedEffects}>} variants
 * @property {object|null} row
 * @property {string} column
 */

/**
 * Resolve one critical lookup: roll band + column → cell + parsed effects.
 * Same row-band rules as the attack tables (inclusive bands, low catch-all,
 * rolls above the top band clamp to it — that covers modified crit rolls).
 *
 * @param {{rows: Array}} table
 * @param {number} roll
 * @param {string} column
 * @returns {CriticalLookup}
 */
export function lookupCritical(table, roll, column) {
  const row = findAttackRow(table, roll);
  const key = String(column);
  const cell = row?.results?.[key] ?? null;
  const variants = Array.isArray(cell?.variants)
    ? cell.variants.map(v => ({ ...v, parsed: parseCriticalEffects(v.effects) }))
    : [];
  const parsed = (cell && !variants.length) ? parseCriticalEffects(cell.effects) : null;
  return { cell, parsed, variants, row: row ?? null, column: key };
}

/**
 * Roll-and-resolve a critical strike. Critical rolls are a plain d100
 * (NOT open-ended); severity shifts/modifiers are applied by the caller
 * before passing `mod`.
 *
 * @param {Object} params
 * @param {Object} params.table   criticalTable data (DataModel or plain object).
 * @param {string} params.column  Severity / column key (e.g. "C").
 * @param {number} [params.mod=0] Modifier added to the roll (clamped to the table).
 * @param {{total:number}} [params.roll]  Precomputed roll (tests).
 * @returns {Promise<CriticalLookup & {natural:number, total:number, rolls:Roll[]}>}
 */
export async function resolveCritical({ table, column, mod = 0, roll } = {}) {
  if (!table) throw new Error("RMF | resolveCritical: missing critical table");
  if (!column) throw new Error("RMF | resolveCritical: missing column");

  let natural, rolls = [];
  if (roll) {
    natural = Number(roll.total);
  } else {
    const r = new Roll("1d100");
    await r.evaluate();
    natural = r.total;
    rolls = [r];
  }
  const total = natural + Number(mod || 0);
  return { ...lookupCritical(table, total, column), natural, total, rolls };
}
