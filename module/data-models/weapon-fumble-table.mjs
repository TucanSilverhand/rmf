/**
 * RMF System - Weapon Fumble Table item DataModel (A-10.11.1).
 *
 * Same matrix shape as the critical tables (roll bands × column cells of
 * `{text, effects}`) but the columns are WEAPON CATEGORIES (one-handed,
 * two-handed, polearms, mounted, thrown, missile) and the `effects` use the
 * richer fumble notation (dice hits, drop/reload/breakage, crit chains, …)
 * parsed by `module/tables/fumble.mjs`. Resolved on a plain d100 when the
 * attacker's natural die lands in the weapon's fumble range.
 *
 * @see module/tables/fumble.mjs   (parser + lookup + resolver)
 */

import { lookupFumble } from "../tables/fumble.mjs";
import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for one roll-band row: a band + per-weapon-category result cells. */
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

export class WeaponFumbleTableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Book section id, e.g. "A-10.11.1".
      tableId:  str(""),
      // Ordered column definitions: weapon categories.
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
   * Resolve a single cell: fumble roll + weapon-category column → cell with
   * parsed effects.
   * @param {number} roll    The (modified) fumble d100 roll/total.
   * @param {string} column  Column key (weapon category).
   */
  lookup(roll, column) {
    return lookupFumble(this, roll, column);
  }
}
