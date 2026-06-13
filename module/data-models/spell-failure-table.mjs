/**
 * RMF System - Spell Failure Table item DataModel (A-10.11.2).
 *
 * Same matrix shape as the critical tables (roll bands × column cells of
 * `{text, effects}`). The book's single A-10.11.2 is split into TWO items:
 *   - spellMode "attack"    → columns Elemental / Force
 *   - spellMode "nonAttack" → columns Informational / Other
 * Roll bands run far past 100 (… 251-300 … 301+). The `effects` use the spell
 * failure notation (lose spell / lose PP / coma / crit chain, …) parsed by
 * `module/tables/spell-failure.mjs`.
 *
 * @see module/tables/spell-failure.mjs   (parser + lookup + resolver)
 */

import { lookupSpellFailure } from "../tables/spell-failure.mjs";
import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for one roll-band row: a band + per-spell-class result cells. */
function rowEntry() {
  return new fields.SchemaField({
    label:   new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    // null = low catch-all band (matches any roll <= rollMax).
    rollMin: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
    rollMax: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    // Column key → { text, effects }.
    results: new fields.ObjectField({ required: true, nullable: false, initial: {} })
  });
}

export class SpellFailureTableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Book section id, e.g. "A-10.11.2".
      tableId:  str(""),
      // Which half of A-10.11.2 this item is: "attack" | "nonAttack".
      spellMode: new fields.StringField({
        required: true, nullable: false, blank: false,
        choices: ["attack", "nonAttack"], initial: "attack"
      }),
      // Ordered column definitions: spell classes.
      columnDefs: new fields.ArrayField(
        new fields.SchemaField({ key: str(""), label: str("") }),
        { required: true, nullable: false, initial: [] }
      ),
      // Per-table commentary (e.g. a creature table's column description).
      // The universal effects "Key" lives in CONFIG.RMF.*EffectsKey, not here.
      notes: new fields.ObjectField({ required: false, nullable: true, initial: null }),
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
   * Resolve a single cell: failure roll + spell-class column → cell with
   * parsed effects.
   * @param {number} roll    The (modified) failure d100 roll/total.
   * @param {string} column  Column key (spell class).
   */
  lookup(roll, column) {
    return lookupSpellFailure(this, roll, column);
  }
}
