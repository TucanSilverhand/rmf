/**
 * RMF Tables — weapon-fumble engine (A-10.11.1).
 *
 * A fumble table is the same matrix shape as a critical table (roll bands ×
 * columns of `{text, effects}` cells) but its columns are WEAPON CATEGORIES
 * (one-handed, two-handed, polearms, mounted, thrown, missile) and its
 * effects describe mishaps, not damage. Cells are resolved on a plain d100
 * (no open-ending) when the attacker's natural die lands in the weapon's
 * fumble range.
 *
 * Effects notation (full token set; comma separated, bare token = 1 round):
 *   +NH / NdMH      fixed / rolled concussion hits
 *   Nst Nstnp Nnp   stunned / stunned-no-parry / no-parry  (Np, Nbl also accepted)
 *   noatk           lose this attack (may still parry)
 *   loseatk:N       lose N rounds of attack (may still parry)
 *   drop / drop:N   drop weapon (recover in N rounds; may draw a new one)
 *   reload          must reload
 *   breakage        weapon breakage check
 *   break           weapon breaks / shatters
 *   bowbreak        bowstring breaks
 *   down:N          knocked down / prone N rounds
 *   ko:<dur>        knocked out for <dur>     out:<dur>  incapacitated
 *   maim            permanently maimed
 *   self            the listed dice/crit apply to the attacker
 *   ally            perfect blow vs closest ally (dice/crit apply to the ally)
 *   crit:<type>:<sev>   chain to a critical table (type empty = generic)
 *   (-N) / M(-N) / (-N):* / (-N):<dur>   penalty (ongoing with `*`)
 *   -               no mechanical effect (text only)
 *
 * Pure module: `Roll` is used only inside the async resolver.
 *
 * @module tables/fumble
 */

import { findAttackRow } from "./lookup.mjs";
import { NONE_TOKENS, splitTokens, consumeCommon, baseEffects, parseDuration } from "./effects-common.mjs";

/**
 * @typedef {ReturnType<typeof baseEffects> & {
 *   loseAttack:number, dropWeapon:{recover:number}|null, mustReload:boolean,
 *   breakageCheck:boolean, weaponBreaks:boolean, bowstringBreaks:boolean,
 *   out:object|null, maimed:boolean, self:boolean, ally:boolean
 * }} FumbleEffects
 */

/**
 * Parse one weapon-fumble effects string into a structured object.
 * @param {string|null|undefined} raw
 * @returns {FumbleEffects}
 */
export function parseFumbleEffects(raw) {
  const out = /** @type {FumbleEffects} */ (Object.assign(baseEffects(raw), {
    loseAttack: 0, dropWeapon: null, mustReload: false, breakageCheck: false,
    weaponBreaks: false, bowstringBreaks: false, out: null, maimed: false,
    self: false, ally: false
  }));
  if (NONE_TOKENS.has(out.raw)) { out.empty = true; return out; }

  for (const tok of splitTokens(out.raw)) {
    if (consumeCommon(tok, out)) continue;
    let m;
    if (/^noatk$/i.test(tok))                 { out.loseAttack = Math.max(out.loseAttack, 1); continue; }
    if ((m = tok.match(/^loseatk:(\d+)$/i)))  { out.loseAttack += Number(m[1]); continue; }
    if (/^drop$/i.test(tok))                  { out.dropWeapon = { recover: 0 }; continue; }
    if ((m = tok.match(/^drop:(\d+)$/i)))     { out.dropWeapon = { recover: Number(m[1]) }; continue; }
    if (/^reload$/i.test(tok))                { out.mustReload = true; continue; }
    if (/^breakage$/i.test(tok))              { out.breakageCheck = true; continue; }
    if (/^break$/i.test(tok))                 { out.weaponBreaks = true; continue; }
    if (/^bowbreak$/i.test(tok))              { out.bowstringBreaks = true; continue; }
    if ((m = tok.match(/^out:(.+)$/i)))       { out.out = parseDuration(m[1]); continue; }
    if (/^maim$/i.test(tok))                  { out.maimed = true; continue; }
    if (/^self$/i.test(tok))                  { out.self = true; continue; }
    if (/^ally$/i.test(tok))                  { out.ally = true; continue; }
    out.other.push(tok);
  }
  return out;
}

/**
 * @typedef {Object} FumbleLookup
 * @property {{text:string, effects:string}|null} cell
 * @property {FumbleEffects|null} parsed
 * @property {object|null} row
 * @property {string} column
 */

/**
 * Look up a fumble cell: roll band + weapon-category column → parsed effects.
 * Same band rules as the other tables (low catch-all, clamp above the top).
 * @returns {FumbleLookup}
 */
export function lookupFumble(table, roll, column) {
  const row = findAttackRow(table, roll);
  const key = String(column);
  const cell = row?.results?.[key] ?? null;
  const parsed = cell ? parseFumbleEffects(cell.effects) : null;
  return { cell, parsed, row: row ?? null, column: key };
}

/**
 * Roll-and-resolve a weapon fumble. Plain d100 (no open-ending). Rolls any
 * dice-hits in the cell so the result carries concrete numbers.
 *
 * @param {Object} p
 * @param {Object} p.table   weaponFumbleTable data (DataModel or plain object).
 * @param {string} p.column  Weapon-category column key.
 * @param {number} [p.mod=0] Modifier added to the roll.
 * @param {{total:number}} [p.roll] Precomputed roll (tests).
 * @returns {Promise<FumbleLookup & {natural:number, total:number, rolledHits:number, rolls:Roll[]}>}
 */
export async function resolveFumble({ table, column, mod = 0, roll } = {}) {
  if (!table) throw new Error("RMF | resolveFumble: missing fumble table");
  if (!column) throw new Error("RMF | resolveFumble: missing column");

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
  const res = lookupFumble(table, total, column);

  let rolledHits = res.parsed?.hits ?? 0;
  for (const d of res.parsed?.diceHits ?? []) {
    const dr = new Roll(`${d.n}d${d.faces}`);
    await dr.evaluate();
    rolledHits += dr.total;
    rolls.push(dr);
  }
  return { ...res, natural, total, rolledHits, rolls };
}
