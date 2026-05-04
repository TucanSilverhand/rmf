/**
 * Shared helpers for item DataModels.
 * Pure functions; no Foundry runtime side-effects.
 */

import { STAT_SHORT_TO_FULL } from "../utils/constants.mjs";

/**
 * Sum the values of `system.boughtByLevel` (an object keyed by level
 * with numeric values). Non-numeric / negative entries fall back to 0.
 *
 * @param {Object|null|undefined} boughtByLevel
 * @returns {number}
 */
export function totalBoughtRanks(boughtByLevel) {
  if (!boughtByLevel || typeof boughtByLevel !== "object") return 0;
  return Object.values(boughtByLevel).reduce(
    (sum, val) => sum + (Number(val) || 0),
    0
  );
}

/**
 * Normalize a stat key (`ag` → `chAgility`, `chAgility` → `chAgility`).
 * Empty / non-string inputs produce "".
 *
 * @param {*} value
 * @returns {string}
 */
export function normalizeStatKey(value) {
  if (!value || typeof value !== "string") return "";
  if (value.startsWith("ch")) return value;
  return STAT_SHORT_TO_FULL[value] ?? value;
}

/**
 * Sum the .total of up to three stats on the parent actor for the
 * given stat keys (short or full form). Returns 0 when there is no
 * Actor parent (e.g. world-side category not yet assigned).
 *
 * @param {Item} item
 * @param {string[]} statKeys - up to 3 keys (any of "" / "ag" / "chAgility" form)
 * @returns {number}
 */
export function sumActorStatTotals(item, statKeys) {
  const actor = item.parent;
  if (!actor || actor.documentName !== "Actor") return 0;
  const stats = actor.system?.chStats;
  if (!stats) return 0;
  let sum = 0;
  for (const key of statKeys) {
    const norm = normalizeStatKey(key);
    if (!norm) continue;
    const stat = stats[norm];
    if (stat && Number.isFinite(stat.total)) sum += stat.total;
  }
  return sum;
}

/**
 * Coerce a possibly-malformed dpCost block into the canonical
 * `{ price1, price2, price3 }` shape. Used by importers before the
 * data hits the schema validator.
 *
 * @param {*} raw
 * @returns {{price1:number, price2:number, price3:number}}
 */
export function normalizeDpCost(raw) {
  const out = { price1: 0, price2: 0, price3: 0 };
  if (Array.isArray(raw)) {
    out.price1 = Number(raw[0]) || 0;
    out.price2 = Number(raw[1]) || 0;
    out.price3 = Number(raw[2]) || 0;
  } else if (raw && typeof raw === "object") {
    out.price1 = Number(raw.price1 ?? raw[0] ?? raw[1]) || 0;
    out.price2 = Number(raw.price2 ?? raw[1] ?? raw[2]) || 0;
    out.price3 = Number(raw.price3 ?? raw[2] ?? raw[3]) || 0;
  }
  return out;
}
