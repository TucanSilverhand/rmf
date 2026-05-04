/**
 * RMF System - Skill Category item DataModel.
 *
 * Mirrors `template.json:Item.category`. Drives the derivation of
 * `totalBonus` used by every embedded skill and by the no-skill
 * untrained-category roll.
 */

import {
  computeCategoryRankBonus,
  normalizeCategoryProgression
} from "../utils/rank-bonus.mjs";
import { totalBoughtRanks, sumActorStatTotals } from "./_shared.mjs";

const fields = foundry.data.fields;

/**
 * Allowed values for `system.group`. Keeping them in one place lets
 * us validate at the schema level instead of re-listing the set in
 * every sheet helper.
 */
export const CATEGORY_GROUPS = Object.freeze([
  "none",
  "Armor",
  "Artistic",
  "Athletic",
  "Awareness",
  "Body Development",
  "Combat Maneuvers",
  "Communications",
  "Craft",
  "Directed Spells",
  "Influence",
  "Lore",
  "Martial Arts",
  "Outdoor",
  "Power Awareness",
  "Power Point Development",
  "Science",
  "Self Control",
  "Subterfuge",
  "Technical",
  "Urban",
  "Weapon"
]);

const CATEGORY_PROGRESSIONS = ["standard", "nonstandard"];

export class CategoryData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const num = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, integer: true, initial, ...opts });
    const numFloat = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, initial, ...opts });
    const str = (initial = "", opts = {}) =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial, ...opts });

    return {
      description: new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      group: str("none", { choices: CATEGORY_GROUPS }),

      // dpCost: schema { price1, price2, price3 } — kept verbatim from
      // template.json. Float-friendly because some categories use 0.5.
      dpCost: new fields.SchemaField({
        price1: numFloat(0, { min: 0 }),
        price2: numFloat(0, { min: 0 }),
        price3: numFloat(0, { min: 0 })
      }),

      // Object keyed by character level (string keys), each holding the
      // number of ranks bought at that level. `0` is reserved for racial
      // ranks granted at character creation. We persist as a plain
      // ObjectField because the keys are dynamic (level numbers).
      boughtByLevel: new fields.ObjectField({ required: true, nullable: false, initial: () => ({}) }),

      freeRanks: numFloat(0, { min: 0 }),

      categoryRankBonusProgression: str("standard", { choices: CATEGORY_PROGRESSIONS }),

      // Legacy: ranks (alias of totalRanks). Kept persisted to avoid
      // breaking older worlds; recomputed each derivation pass.
      ranks: num(0, { min: 0 }),

      statBonus: new fields.SchemaField({
        stat1: str("chAgility"),
        stat2: str("chConstitution"),
        stat3: str("chSelfDiscipline")
      }),

      profBonus:  numFloat(0),
      spec1Bonus: numFloat(0),
      spec2Bonus: numFloat(0),

      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Compute `totalRanks` / `totalRankBonus` / `totalStatsBonus` /
   * `totalBonus`. For "Power Point Development" categories assigned
   * to an actor with a realm, the stat bonus slots are inherited from
   * the realm — matching the legacy behavior in RMFItem.
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    const item = this.parent;

    // Inherit stat bonus slots from the realm for the PP-Dev category.
    if (item?.name === "Power Point Development") {
      const actor = item.parent;
      const realmItem = actor?.documentName === "Actor"
        ? actor.itemTypes?.realm?.[0]
        : null;
      const rb = realmItem?.system?.statBonus;
      if (rb && typeof rb === "object") {
        this.statBonus.stat1 = typeof rb.stat1 === "string" ? rb.stat1 : "";
        this.statBonus.stat2 = typeof rb.stat2 === "string" ? rb.stat2 : "";
        this.statBonus.stat3 = typeof rb.stat3 === "string" ? rb.stat3 : "";
      }
    }

    const totalRanks = totalBoughtRanks(this.boughtByLevel) + (this.freeRanks || 0);
    const progression = normalizeCategoryProgression(this.categoryRankBonusProgression);
    const totalRankBonus = computeCategoryRankBonus(totalRanks, progression);
    const totalStatsBonus = item
      ? sumActorStatTotals(item, [this.statBonus.stat1, this.statBonus.stat2, this.statBonus.stat3])
      : 0;

    // Mirror onto the schema instance so templates can read it as
    // `item.system.totalBonus` etc. These are derived-only values —
    // the schema does not declare them, so they stay in memory and
    // never round-trip to the DB.
    this.totalRanks = totalRanks;
    this.totalRankBonus = totalRankBonus;
    this.totalStatsBonus = totalStatsBonus;
    this.totalBonus = totalRankBonus + totalStatsBonus
      + (this.profBonus || 0) + (this.spec1Bonus || 0) + (this.spec2Bonus || 0);

    // Keep `ranks` in sync for callers that read it directly (legacy alias).
    this.ranks = totalRanks;
  }
}
