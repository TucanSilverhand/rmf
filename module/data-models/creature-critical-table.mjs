/**
 * RMF System - Creature Critical Table item DataModel (A-10.10.7/8/9).
 *
 * Mechanically identical to a standard critical table (CriticalTableData):
 * roll bands × columns of `{text, effects, variants?}` cells parsed by the
 * same `parseCriticalEffects` engine. Two differences, both data-only:
 *
 *   - Columns are WEAPON ENCHANTMENT CLASSES (Normal / Magic / Mithril /
 *     Holy Arms / Slaying), or just Normal / Slaying on the "spells against
 *     creatures" tables — not the A–E severity of the standard tables.
 *   - Roll bands run far past 100 (… 101-150 … 251+); the shared
 *     `findAttackRow` already matches and high-clamps those, so no engine
 *     change is needed.
 *
 * `critType` here names the creature scope this table serves ("Large
 * Creature", "Super Large Creature"); the effects notation is the same RMF
 * ASCII token set as the standard criticals.
 *
 * @see module/tables/critical.mjs   (parser + lookup + resolver, reused)
 */

import { lookupCritical } from "../tables/critical.mjs";
import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for one roll-band row: a band + per-column result cells. */
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

export class CreatureCriticalTableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Book section id, e.g. "A-10.10.7".
      tableId:  str(""),
      // Creature scope served (e.g. "Large Creature", "Super Large Creature").
      critType: str(""),
      // Ordered column definitions: weapon enchantment classes (or
      // Normal/Slaying on the spells-against-creatures tables).
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
   * Resolve a single cell: critical roll + column → cell with parsed effects.
   * @param {number} roll    The (modified) critical d100 roll/total.
   * @param {string} column  Column key (weapon class).
   */
  lookup(roll, column) {
    return lookupCritical(this, roll, column);
  }
}
