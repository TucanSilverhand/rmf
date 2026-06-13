/**
 * RMF System - Critical Table item DataModel.
 *
 * A RoleMaster critical strike table (A-10.10.x) is the second matrix of
 * the combat chain: an attack-table cell that yields a severity (e.g.
 * "12E") sends the player here. Rows are bands of an UNMODIFIED d100,
 * columns are the severity (A-E on the six standard tables; weapon
 * enchantment classes on the creature tables), and each cell carries the
 * narrative result text plus an effects notation string:
 *
 *   "+10H, 3stnp, (-15)"  → 10 hits, stunned-no-parry 3 rounds, -15 penalty
 *
 * Tokens (RMF ASCII notation, comma separated; bare token = 1 round):
 * Np must parry; Nnp no parry; Nst stunned; Nstnp stunned & no parry;
 * Nbl bleed per round; (-N) foe penalty; (+N) attacker bonus next round;
 * Np(-M) must parry at -M. The book's original symbol Key (ßπ/ß∏/ß∑/ß∫,
 * en-dash separators) is still parsed as a legacy grammar.
 * Some cells are conditional ("with helmet / w/o helmet") — those carry a
 * `variants` array instead of a flat `effects` string.
 *
 * Cells live in per-row `results` ObjectFields keyed by column key (same
 * storage shape as the attack tables), each value being:
 *   { text: string, effects: string, variants?: [{condition, effects}] }
 *
 * Effects parsing is done at runtime by the pure engine in
 * `module/tables/critical.mjs` — the JSON keeps the book's notation verbatim.
 *
 * @see module/tables/critical.mjs   (parser + lookup + resolver)
 */

import { lookupCritical } from "../tables/critical.mjs";
import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for one roll-band row: a band + per-severity result cells. */
function rowEntry() {
  return new fields.SchemaField({
    label:   new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    // null = low catch-all band (matches any roll <= rollMax).
    rollMin: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
    rollMax: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    // Column key → { text, effects, variants? }.
    results: new fields.ObjectField({ required: true, nullable: false, initial: {} })
  });
}

export class CriticalTableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Book section id, e.g. "A-10.10.1".
      tableId:  str(""),
      // Critical type this table resolves (e.g. "Cold", "Krush"). Attack
      // tables chain here via their critType / attackTypes[].criticalType.
      critType: str(""),
      // Ordered column definitions: severities A-E on the standard tables,
      // weapon classes (Normal/Magic/...) on the creature tables.
      columnDefs: new fields.ArrayField(
        new fields.SchemaField({ key: str(""), label: str("") }),
        { required: true, nullable: false, initial: [] }
      ),
      // Free-form legend (the book's Key) carried verbatim for the sheet.
      legend: new fields.ObjectField({ required: false, nullable: true, initial: null }),
      // Informational note about how rollMin/rollMax match.
      rollMatchPolicy: str(""),
      // The matrix.
      rows: new fields.ArrayField(rowEntry(), { required: true, nullable: false, initial: [] }),
      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),
      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Convenience aggregates for the sheet:
   *   - columns:  ordered column keys (from columnDefs)
   *   - maxRow:   highest rollMax (rolls above clamp to the top band)
   *   - rowCount: number of roll bands
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    const rows = Array.isArray(this.rows) ? this.rows : [];
    this.columns  = (this.columnDefs ?? []).map(d => d.key);
    this.rowCount = rows.length;
    this.maxRow   = rows.reduce((m, r) => Math.max(m, Number(r?.rollMax) || -Infinity), -Infinity);
    if (!Number.isFinite(this.maxRow)) this.maxRow = 0;
  }

  /* ───────────────────────── Lookup API ───────────────────────── */

  /**
   * Resolve a single cell: critical roll + severity column → cell with
   * parsed effects. Delegates to the shared engine.
   *
   * @param {number} roll    The (unmodified) critical d100 roll.
   * @param {string} column  Severity / column key (e.g. "A".."E").
   * @returns {import("../tables/critical.mjs").CriticalLookup}
   */
  lookup(roll, column) {
    return lookupCritical(this, roll, column);
  }
}
