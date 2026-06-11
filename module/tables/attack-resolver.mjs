/**
 * RMF Tables — attack resolver.
 *
 * The orchestration layer that ties the pieces together for a single
 * weapon attack:
 *
 *   1. roll an open-ended d100 (or accept a precomputed roll for tests)
 *   2. fumble check on the UNMODIFIED natural die
 *   3. attackTotal = roll + OB + mods − target DB
 *   4. look up [attackTotal][targetAT] in the weapon's attack table
 *   5. surface hits + (critType, severity) so the caller can chain into
 *      the matching critical table
 *
 * Critical resolution itself is deliberately NOT done here yet — the
 * critical tables are a separate data set (a follow-up). The result
 * carries `critType` + `cell.critSeverity` so the next step is unambiguous.
 *
 * @module tables/attack-resolver
 */

import { lookupAttack, lookupResistanceMod } from "./lookup.mjs";
import { parseCell, parseModifierCell } from "./cell-parser.mjs";
import { rollOpenEndedD100 } from "./open-ended.mjs";

const DEFAULT_FUMBLE = { min: 1, max: 2 };

/**
 * Find the "UM high" row (e.g. UM 96-97 / 98-99 / 100 on spell tables) whose
 * natural-die band contains `natural`. These rows apply a fixed result with no
 * modifications, so they are checked on the UNMODIFIED first die — like the
 * fumble band, but at the top end. Returns null when the table has none.
 *
 * @param {{umHigh?: Array}} table
 * @param {number} natural  The unmodified first die.
 * @returns {{label:string, results:Object<string,string>}|null}
 */
export function findUmHighRow(table, natural) {
  const rows = Array.isArray(table?.umHigh) ? table.umHigh : [];
  const n = Number(natural);
  for (const row of rows) {
    if (n >= Number(row?.naturalMin) && n <= Number(row?.naturalMax)) return row;
  }
  return null;
}

/**
 * @typedef {Object} AttackResult
 * @property {boolean} fumble
 * @property {number}  natural        Unmodified first die.
 * @property {number}  rollTotal      Open-ended d100 total.
 * @property {boolean} openHigh
 * @property {number}  ob
 * @property {number}  mods
 * @property {number}  targetAT
 * @property {number}  targetDB
 * @property {number}  attackTotal    rollTotal + ob + mods − targetDB.
 * @property {import("./cell-parser.mjs").ParsedCell} cell
 * @property {string}  critType       Critical table to chain into (e.g. "Krush").
 * @property {boolean} needsCritical  True when the cell yielded a severity.
 */

/**
 * Resolve an attack against one target.
 *
 * @param {Object} params
 * @param {Object} params.table       Attack-table data (DataModel instance or plain object).
 * @param {number} [params.ob=0]      Offensive Bonus.
 * @param {number} [params.mods=0]    Situational modifiers (net).
 * @param {number} params.targetAT    Defender's Armor Type (1-20).
 * @param {number} [params.targetDB=0] Defender's Defensive Bonus (subtracted).
 * @param {{min:number,max:number}} [params.fumbleRange] Override the table's fumble band.
 * @param {{natural:number,total:number,openHigh?:boolean}} [params.roll] Precomputed roll (tests).
 * @returns {Promise<AttackResult>}
 */
export async function resolveAttack({
  table, ob = 0, mods = 0, targetAT, targetDB = 0, fumbleRange, roll
} = {}) {
  if (!table) throw new Error("RMF | resolveAttack: missing attack table");
  if (targetAT === undefined || targetAT === null) {
    throw new Error("RMF | resolveAttack: missing targetAT");
  }

  const rolled = roll ?? await rollOpenEndedD100({ high: true, low: false });
  const natural = Number(rolled.natural);
  const rollTotal = Number(rolled.total);

  const fr = fumbleRange ?? table.fumbleRange ?? DEFAULT_FUMBLE;
  const isFumble = natural >= Number(fr.min ?? DEFAULT_FUMBLE.min)
                && natural <= Number(fr.max ?? DEFAULT_FUMBLE.max);

  const attackTotal = rollTotal + Number(ob || 0) + Number(mods || 0) - Number(targetDB || 0);

  const base = {
    fumble: isFumble,
    natural,
    rollTotal,
    openHigh: !!rolled.openHigh,
    ob: Number(ob || 0),
    mods: Number(mods || 0),
    targetAT: Number(targetAT),
    targetDB: Number(targetDB || 0),
    attackTotal,
    critType: table.critType ?? "",
    rolls: rolled.rolls ?? []
  };

  if (isFumble) {
    return {
      ...base,
      cell: { kind: "fumble", hits: 0, critSeverity: null, raw: "F" },
      needsCritical: false,
      umHigh: false
    };
  }

  // High unmodified-die band (spell tables): fixed result, no modifications.
  const umRow = findUmHighRow(table, natural);
  if (umRow) {
    const cell = parseCell(umRow.results?.[String(targetAT)]);
    return {
      ...base,
      cell: { kind: cell.kind, hits: cell.hits, critSeverity: cell.critSeverity, raw: cell.raw },
      needsCritical: !!cell.critSeverity,
      umHigh: true,
      umLabel: umRow.label ?? ""
    };
  }

  const cell = lookupAttack(table, attackTotal, targetAT);
  return {
    ...base,
    cell: { kind: cell.kind, hits: cell.hits, critSeverity: cell.critSeverity, raw: cell.raw },
    needsCritical: !!cell.critSeverity,
    umHigh: false
  };
}

/**
 * @typedef {Object} ResistanceSpellResult
 * @property {boolean} fumble        Natural die in the fumble band → spell fails.
 * @property {boolean} fails         The spell fails (fumble band or an "F" cell).
 * @property {number|null} modifier  RR modifier when the spell lands, else null.
 * @property {number}  natural
 * @property {number}  rollTotal
 * @property {boolean} openHigh
 * @property {number}  attackTotal   rollTotal + ob + mods − targetDB.
 * @property {string}  column        Categorical column key used for the lookup.
 * @property {boolean} umHigh        Result came from a UM 96-100 band.
 */

/**
 * Resolve a basic (resistance) spell attack on a `tableKind: "resistanceMod"`
 * table: same open-ended roll / fumble / UM-high pipeline as resolveAttack,
 * but the column is categorical (e.g. "metal-armor") and the outcome is a
 * Resistance-Roll modifier or a spell failure — never damage.
 *
 * @param {Object} params
 * @param {Object} params.table        resistanceMod table (DataModel or plain object).
 * @param {string} params.column       Column key from the table's `columnDefs`.
 * @param {number} [params.ob=0]       Attacker's bonus (skill rank, items, …).
 * @param {number} [params.mods=0]     Situational modifiers (net).
 * @param {number} [params.targetDB=0] Defender's bonus (subtracted).
 * @param {{min:number,max:number}} [params.fumbleRange] Override the table's band.
 * @param {{natural:number,total:number,openHigh?:boolean}} [params.roll] Precomputed roll (tests).
 * @returns {Promise<ResistanceSpellResult>}
 */
export async function resolveResistanceSpell({
  table, column, ob = 0, mods = 0, targetDB = 0, fumbleRange, roll
} = {}) {
  if (!table) throw new Error("RMF | resolveResistanceSpell: missing table");
  if (!column) throw new Error("RMF | resolveResistanceSpell: missing column");

  const rolled = roll ?? await rollOpenEndedD100({ high: true, low: false });
  const natural = Number(rolled.natural);
  const rollTotal = Number(rolled.total);

  const fr = fumbleRange ?? table.fumbleRange ?? DEFAULT_FUMBLE;
  const isFumble = natural >= Number(fr.min ?? DEFAULT_FUMBLE.min)
                && natural <= Number(fr.max ?? DEFAULT_FUMBLE.max);

  const attackTotal = rollTotal + Number(ob || 0) + Number(mods || 0) - Number(targetDB || 0);

  const base = {
    fumble: isFumble,
    natural,
    rollTotal,
    openHigh: !!rolled.openHigh,
    ob: Number(ob || 0),
    mods: Number(mods || 0),
    targetDB: Number(targetDB || 0),
    attackTotal,
    column: String(column),
    rolls: rolled.rolls ?? []
  };

  if (isFumble) return { ...base, fails: true, modifier: null, umHigh: false };

  const umRow = findUmHighRow(table, natural);
  if (umRow) {
    const cell = parseModifierCell(umRow.results?.[String(column)]);
    return {
      ...base,
      fails: cell.kind === "fail",
      modifier: cell.kind === "modifier" ? cell.modifier : null,
      umHigh: true,
      umLabel: umRow.label ?? ""
    };
  }

  const cell = lookupResistanceMod(table, attackTotal, column);
  return {
    ...base,
    fails: cell.kind === "fail",
    modifier: cell.kind === "modifier" ? cell.modifier : null,
    umHigh: false
  };
}
