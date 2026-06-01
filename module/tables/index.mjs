/**
 * RMF Tables — public API surface (the "engine").
 *
 * This is the clean boundary for the multidimensional-table feature.
 * Everything table-related is reachable from here and from nowhere else,
 * so the whole folder can later be lifted into a standalone module with
 * a mechanical move + a dependency declaration (architecture option C).
 *
 * `RMFHooks` re-exposes this object on `game.rmf.tables` at ready time,
 * mirroring how the importers are surfaced on `game.rmf.*`.
 *
 * @module tables
 */

export { parseCell, describeCell } from "./cell-parser.mjs";
export { findAttackRow, lookupAttack, tableColumns } from "./lookup.mjs";
export { rollOpenEndedD100 } from "./open-ended.mjs";
export { resolveAttack } from "./attack-resolver.mjs";

import { parseCell, describeCell } from "./cell-parser.mjs";
import { findAttackRow, lookupAttack, tableColumns } from "./lookup.mjs";
import { rollOpenEndedD100 } from "./open-ended.mjs";
import { resolveAttack } from "./attack-resolver.mjs";

/**
 * Bundled namespace exposed on `game.rmf.tables`.
 * @type {{
 *   parseCell: typeof parseCell,
 *   describeCell: typeof describeCell,
 *   findAttackRow: typeof findAttackRow,
 *   lookupAttack: typeof lookupAttack,
 *   tableColumns: typeof tableColumns,
 *   rollOpenEndedD100: typeof rollOpenEndedD100,
 *   resolveAttack: typeof resolveAttack
 * }}
 */
export const TablesAPI = {
  parseCell,
  describeCell,
  findAttackRow,
  lookupAttack,
  tableColumns,
  rollOpenEndedD100,
  resolveAttack
};
