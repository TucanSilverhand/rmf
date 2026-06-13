/**
 * RMF System - Attack Table item DataModel.
 *
 * A RoleMaster attack table is the canonical multidimensional lookup:
 * rows are bands of the modified roll total, columns are the defender's
 * Armor Type (AT 1-20), and each cell encodes hits + an optional
 * critical severity (e.g. "12E"). FoundryVTT has no native 2-D table
 * document, so we model the matrix as Item `system` data (same approach
 * as the spell lists) and resolve lookups with the pure engine in
 * `module/tables/`.
 *
 * Mirrors the shape of `data/system_tables/attack_tables/*.json`. The table is
 * a PURE resolution matrix: it yields hits + an optional critical SEVERITY, but
 * it does NOT decide which critical TYPE (Slash/Krush/…) that severity rolls on.
 * That is per-attacker data (the book's "WEAPON DATA" box) and lives on the
 * weapon item (and, for creatures/spells, on their future attack definitions),
 * NOT on the shared table — a dagger and a broadsword roll the same one-handed
 * table but crit Puncture vs Slash. `fumbleRange` defaults to UM 01 here; the
 * weapon supplies its real range.
 *
 * `results` (per row) and `fumble.results` are stored as ObjectFields
 * keyed by AT — that gives O(1) `results[String(at)]` lookups and keeps
 * the JSON identical to the printed page.
 *
 * @see module/tables/lookup.mjs  (the lookup engine)
 */

import { lookupAttack, lookupResistanceMod, tableColumns } from "../tables/lookup.mjs";
import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for one roll-band row: a band + the 20 armor-type cells. */
function rowEntry() {
  return new fields.SchemaField({
    label:   new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    // null = low catch-all band (matches any total <= rollMax).
    rollMin: new fields.NumberField({ required: false, nullable: true, integer: true, initial: null }),
    rollMax: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    // AT (as string key) → cell text, e.g. { "20": "12E", ..., "1": "23E" }.
    results: new fields.ObjectField({ required: true, nullable: false, initial: {} })
  });
}

export class AttackTableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Book section id, e.g. "A-10.9.1".
      tableId:  str(""),
      // What a cell means. "attack" (default): hits + optional critical, keyed
      // by AT 1-20. "resistanceMod": a signed Resistance-Roll modifier (or "F"),
      // keyed by the categorical columns declared in `columnDefs`.
      tableKind: new fields.StringField({
        required: true, nullable: false, blank: false,
        choices: ["attack", "resistanceMod"], initial: "attack"
      }),
      // Categorical column definitions for non-AT tables (resistanceMod). Order
      // is honoured. Empty for AT-based attack tables (columns derive from 1-20).
      columnDefs: new fields.ArrayField(
        new fields.SchemaField({ key: str(""), label: str("") }),
        { required: false, nullable: false, initial: [] }
      ),
      // Unmodified-die band that forces a fumble. The crit type, OB mod, max
      // result and real fumble range are per-WEAPON (the "WEAPON DATA" box) and
      // live on the weapon item — the table keeps only a UM 01 default here.
      fumbleRange: new fields.SchemaField({
        min: new fields.NumberField({ required: true, nullable: false, integer: true, min: 1, initial: 1 }),
        max: new fields.NumberField({ required: true, nullable: false, integer: true, min: 1, initial: 1 })
      }),
      // Presentation only: groups the 20 AT columns under armor names.
      // Does NOT affect the lookup (which is per-AT).
      armorTypes: new fields.ArrayField(
        new fields.SchemaField({
          name: str(""),
          ats:  new fields.ArrayField(
            new fields.NumberField({ required: true, nullable: false, integer: true }),
            { required: true, nullable: false, initial: [] }
          )
        }),
        { required: true, nullable: false, initial: [] }
      ),
      // Free-form legend (cell-notation key) carried verbatim for the sheet.
      legend: new fields.ObjectField({ required: false, nullable: true, initial: null }),
      // Informational note about how rollMin/rollMax match.
      rollMatchPolicy: str(""),
      // The matrix.
      rows: new fields.ArrayField(rowEntry(), { required: true, nullable: false, initial: [] }),
      // Fumble row: every AT maps to "F" (rolled when natural die is in fumbleRange).
      fumble: new fields.SchemaField({
        label:       str(""),
        description: str(""),
        results:     new fields.ObjectField({ required: true, nullable: false, initial: {} })
      }),
      // "UM high" rows: high unmodified-die bands (e.g. UM 96-97 / 98-99 / 100)
      // that apply a fixed result with no modifications. Keyed off the natural
      // die, not the modified total, so they live apart from `rows`. One entry
      // for bolt tables (natural 100), three for ball tables. Empty = none.
      umHigh: new fields.ArrayField(
        new fields.SchemaField({
          label:       str(""),
          naturalMin:  new fields.NumberField({ required: true, nullable: false, integer: true, min: 1, initial: 100 }),
          naturalMax:  new fields.NumberField({ required: true, nullable: false, integer: true, min: 1, initial: 100 }),
          description: str(""),
          results:     new fields.ObjectField({ required: true, nullable: false, initial: {} })
        }),
        { required: false, nullable: false, initial: [] }
      ),
      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),
      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Convenience aggregates for the sheet:
   *   - columns:  AT keys, descending (20 → 1) like the printed page
   *   - maxRow:   highest rollMax (the open-ended clamp ceiling)
   *   - rowCount: number of roll bands
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    const rows = Array.isArray(this.rows) ? this.rows : [];
    this.columns  = tableColumns(this);
    this.rowCount = rows.length;
    this.maxRow   = rows.reduce((m, r) => Math.max(m, Number(r?.rollMax) || -Infinity), -Infinity);
    if (!Number.isFinite(this.maxRow)) this.maxRow = 0;
  }

  /* ───────────────────────── Lookup API ───────────────────────── */

  /**
   * Resolve a single cell: modified total + column → parsed cell.
   * Dispatches on `tableKind` so attack tables return hits/critical and
   * resistance-modifier tables return a signed RR modifier. Delegates to the
   * shared engine so the DataModel and the resolver never diverge.
   *
   * @param {number} total  Fully-modified attack total.
   * @param {number|string} column  Defender's AT (1-20) or categorical key.
   * @returns {object}
   */
  lookup(total, column) {
    return this.tableKind === "resistanceMod"
      ? lookupResistanceMod(this, total, column)
      : lookupAttack(this, total, column);
  }
}
