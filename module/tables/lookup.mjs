/**
 * RMF Tables — multidimensional lookup engine.
 *
 * RoleMaster "tables" look two-dimensional on paper (rows = the modified
 * roll total, columns = the defender's Armor Type) but only ONE axis is
 * random: the roll. The column (AT) is known before you look anything
 * up. So an N-dimensional table collapses to a 1-D lookup at query time:
 *
 *   1. the caller already knows the column (the AT) → pick that key
 *   2. find the row whose [rollMin, rollMax] band contains the total
 *   3. read the cell at row.results[column] and parse it
 *
 * Two edge rules live HERE, not in the data, so the JSON stays clean:
 *   - low catch-all: a row with rollMin === null matches any total <= its
 *     rollMax (the "XX-33" band at the bottom of the table).
 *   - high clamp: open-ended rolls can exceed the printed maximum, so a
 *     total above every band uses the highest band.
 *
 * Pure module (no Foundry deps). Operates on plain table-shaped objects,
 * so it works equally on a SpellListData-style DataModel instance or on
 * a raw parsed JSON object.
 *
 * @module tables/lookup
 */

import { parseCell } from "./cell-parser.mjs";

/**
 * @typedef {Object} TableRow
 * @property {string}  [label]
 * @property {number|null} rollMin   null = low catch-all.
 * @property {number}  rollMax
 * @property {Object<string,string>} results  AT (as string key) → cell text.
 */

/**
 * Find the row whose roll band contains `total`, applying the low
 * catch-all and high-clamp rules described above.
 *
 * @param {{rows: TableRow[]}} table
 * @param {number} total  The fully-modified attack total.
 * @returns {TableRow|null}
 */
export function findAttackRow(table, total) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  if (!rows.length) return null;

  const n = Number(total);
  if (!Number.isFinite(n)) return null;

  let highest = null; // track the band with the greatest rollMax for clamping

  for (const row of rows) {
    const max = Number(row?.rollMax);
    if (!Number.isFinite(max)) continue;

    if (!highest || max > Number(highest.rollMax)) highest = row;

    const min = (row?.rollMin === null || row?.rollMin === undefined)
      ? -Infinity                 // low catch-all
      : Number(row.rollMin);

    if (n >= min && n <= max) return row;
  }

  // Total exceeds every printed band (open-ended) → clamp to the top band.
  if (highest && n > Number(highest.rollMax)) return highest;

  return null;
}

/**
 * Resolve a full lookup: total + column (AT) → parsed cell.
 *
 * @param {{rows: TableRow[]}} table
 * @param {number} total
 * @param {number|string} column  Armor Type (1-20) or any column key.
 * @returns {import("./cell-parser.mjs").ParsedCell & {row: TableRow|null, column: string}}
 */
export function lookupAttack(table, total, column) {
  const row = findAttackRow(table, total);
  const key = String(column);
  const raw = row?.results?.[key];
  return { ...parseCell(raw), row, column: key };
}

/**
 * The set of column keys the table exposes, derived from the first row's
 * `results` (falls back to scanning every row). Sorted descending so a
 * sheet renders AT 20 → 1 like the printed page.
 *
 * @param {{rows: TableRow[]}} table
 * @returns {number[]}
 */
export function tableColumns(table) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const keys = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row?.results ?? {})) keys.add(Number(k));
    if (keys.size) break; // first non-empty row is representative
  }
  return [...keys].filter(Number.isFinite).sort((a, b) => b - a);
}
