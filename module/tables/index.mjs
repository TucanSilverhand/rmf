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

export { parseCell, parseModifierCell, describeCell } from "./cell-parser.mjs";
export { findAttackRow, lookupAttack, lookupResistanceMod, tableColumns } from "./lookup.mjs";
export { rollOpenEndedD100 } from "./open-ended.mjs";
export { resolveAttack, resolveResistanceSpell, findUmHighRow } from "./attack-resolver.mjs";
export { parseCriticalEffects, lookupCritical, resolveCritical } from "./critical.mjs";

import { parseCell, parseModifierCell, describeCell } from "./cell-parser.mjs";
import { findAttackRow, lookupAttack, lookupResistanceMod, tableColumns } from "./lookup.mjs";
import { rollOpenEndedD100 } from "./open-ended.mjs";
import { resolveAttack, resolveResistanceSpell, findUmHighRow } from "./attack-resolver.mjs";
import { parseCriticalEffects, lookupCritical, resolveCritical } from "./critical.mjs";

/**
 * Bundled namespace exposed on `game.rmf.tables`.
 * @type {{
 *   parseCell: typeof parseCell,
 *   parseModifierCell: typeof parseModifierCell,
 *   describeCell: typeof describeCell,
 *   findAttackRow: typeof findAttackRow,
 *   lookupAttack: typeof lookupAttack,
 *   lookupResistanceMod: typeof lookupResistanceMod,
 *   tableColumns: typeof tableColumns,
 *   rollOpenEndedD100: typeof rollOpenEndedD100,
 *   resolveAttack: typeof resolveAttack,
 *   resolveResistanceSpell: typeof resolveResistanceSpell,
 *   findUmHighRow: typeof findUmHighRow
 * }}
 */
export const TablesAPI = {
  parseCell,
  parseModifierCell,
  describeCell,
  findAttackRow,
  lookupAttack,
  lookupResistanceMod,
  tableColumns,
  rollOpenEndedD100,
  resolveAttack,
  resolveResistanceSpell,
  findUmHighRow,
  parseCriticalEffects,
  lookupCritical,
  resolveCritical
};
