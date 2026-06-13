/**
 * RMF Tables — spell-failure engine (A-10.11.2).
 *
 * Same matrix shape as the critical/fumble tables (roll bands × column cells)
 * but the columns are SPELL CLASSES — attack spells (Elemental / Force) live
 * in one table, non-attack spells (Informational / Other) in another (the
 * book's single A-10.11.2 is split into two `spellFailureTable` items). Roll
 * bands extend far past 100 (up to 301+). Resolved on a plain d100 + mods.
 *
 * Effects notation (full token set; comma separated, bare token = 1 round):
 *   +NH / NdMH      fixed / rolled concussion hits
 *   Nst / Nstnp     stunned / stunned-no-parry
 *   recast          must restart casting (no PP loss unless losepp present)
 *   losespell       lose the spell
 *   noeffect        spell has no effect
 *   delay:N         casting delayed N rounds
 *   losepp:N|half|all|double   power-point loss (half = rounded down)
 *   nocast:<dur>    lose all spell-casting ability for <dur>
 *   coma:<dur>      coma for <dur>
 *   down:N          knocked down N rounds        ko:<dur>  unconscious
 *   paralyze:waist|neck|torso
 *   selfattack      make a point-blank attack on yourself
 *   crit:<type>:<sev>   chain to a critical table (e.g. crit:impact:A)
 *   (-N) / M(-N) / (-N):<dur> / (-N):*   penalty (timed / ongoing)
 *   -               no mechanical effect (text only)
 *
 * Pure module: `Roll` is used only inside the async resolver.
 *
 * @module tables/spell-failure
 */

import { findAttackRow } from "./lookup.mjs";
import { NONE_TOKENS, splitTokens, consumeCommon, baseEffects, parseDuration } from "./effects-common.mjs";

const PP_LOSS = new Set(["half", "all", "double"]);
const PARALYZE = new Set(["waist", "neck", "torso"]);

/**
 * @typedef {ReturnType<typeof baseEffects> & {
 *   recast:boolean, loseSpell:boolean, noEffect:boolean, castDelay:number,
 *   ppLoss:(number|"half"|"all"|"double"|null), loseCasting:object|null,
 *   coma:object|null, paralyze:(string|null), selfAttack:boolean
 * }} SpellFailureEffects
 */

/**
 * Parse one spell-failure effects string into a structured object.
 * @param {string|null|undefined} raw
 * @returns {SpellFailureEffects}
 */
export function parseSpellFailureEffects(raw) {
  const out = /** @type {SpellFailureEffects} */ (Object.assign(baseEffects(raw), {
    recast: false, loseSpell: false, noEffect: false, castDelay: 0,
    ppLoss: null, loseCasting: null, coma: null, paralyze: null, selfAttack: false
  }));
  if (NONE_TOKENS.has(out.raw)) { out.empty = true; return out; }

  for (const tok of splitTokens(out.raw)) {
    if (consumeCommon(tok, out)) continue;
    let m;
    if (/^recast$/i.test(tok))                 { out.recast = true; continue; }
    if (/^losespell$/i.test(tok))              { out.loseSpell = true; continue; }
    if (/^noeffect$/i.test(tok))               { out.noEffect = true; continue; }
    if ((m = tok.match(/^delay:(\d+)$/i)))     { out.castDelay += Number(m[1]); continue; }
    if ((m = tok.match(/^losepp:(\d+|half|all|double)$/i))) {
      const v = m[1].toLowerCase();
      out.ppLoss = PP_LOSS.has(v) ? v : Number(v);
      continue;
    }
    if ((m = tok.match(/^nocast:(.+)$/i)))     { out.loseCasting = parseDuration(m[1]); continue; }
    if ((m = tok.match(/^coma:(.+)$/i)))       { out.coma = parseDuration(m[1]); continue; }
    if ((m = tok.match(/^paralyze:([a-z]+)$/i)) && PARALYZE.has(m[1].toLowerCase())) { out.paralyze = m[1].toLowerCase(); continue; }
    if (/^selfattack$/i.test(tok))             { out.selfAttack = true; continue; }
    out.other.push(tok);
  }
  return out;
}

/**
 * @typedef {Object} SpellFailureLookup
 * @property {{text:string, effects:string}|null} cell
 * @property {SpellFailureEffects|null} parsed
 * @property {object|null} row
 * @property {string} column
 */

/**
 * Look up a spell-failure cell: roll band + spell-class column → parsed effects.
 * @returns {SpellFailureLookup}
 */
export function lookupSpellFailure(table, roll, column) {
  const row = findAttackRow(table, roll);
  const key = String(column);
  const cell = row?.results?.[key] ?? null;
  const parsed = cell ? parseSpellFailureEffects(cell.effects) : null;
  return { cell, parsed, row: row ?? null, column: key };
}

/**
 * Roll-and-resolve a spell failure. Plain d100 (no open-ending); rolls any
 * dice-hits in the cell.
 *
 * @param {Object} p
 * @param {Object} p.table   spellFailureTable data (DataModel or plain object).
 * @param {string} p.column  Spell-class column key.
 * @param {number} [p.mod=0] Modifier added to the roll.
 * @param {{total:number}} [p.roll] Precomputed roll (tests).
 * @returns {Promise<SpellFailureLookup & {natural:number, total:number, rolledHits:number, rolls:Roll[]}>}
 */
export async function resolveSpellFailure({ table, column, mod = 0, roll } = {}) {
  if (!table) throw new Error("RMF | resolveSpellFailure: missing spell-failure table");
  if (!column) throw new Error("RMF | resolveSpellFailure: missing column");

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
  const res = lookupSpellFailure(table, total, column);

  let rolledHits = res.parsed?.hits ?? 0;
  for (const d of res.parsed?.diceHits ?? []) {
    const dr = new Roll(`${d.n}d${d.faces}`);
    await dr.evaluate();
    rolledHits += dr.total;
    rolls.push(dr);
  }
  return { ...res, natural, total, rolledHits, rolls };
}
