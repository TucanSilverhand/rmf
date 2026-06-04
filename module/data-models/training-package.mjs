/**
 * RMF System - Training Package item DataModel.
 *
 * Mirrors the shape of `data/training_packages.json`. A Training
 * Package is a bundle of category/skill ranks plus optional
 * "Special" entries (gear/spell-adders/etc) that the character can
 * "buy" in one go for a fixed list of DP costs.
 *
 * Persistence keeps the canonical name of the referenced category /
 * skill (resolved against `data/categories.json` and
 * `data/skills.json` at import time). Entries flagged `isChoice`
 * carry a free-form descriptive name (e.g. "Weapon/Attack (choice)")
 * that the application logic resolves with a dialog when the package
 * is applied to an actor.
 */

import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for `{ name, dpCost }` rows used by the `special` array. */
function specialEntry() {
  return new fields.SchemaField({
    name:   new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    dpCost: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 })
  });
}

/**
 * Schema for `{ name, ranks, isChoice, placeholderName }` rows inside
 * categoryRanks[].skills. `placeholderName` preserves the original
 * choice text (e.g. "choice of one skill") after the GM resolves the
 * choice via the sheet dropdown — so the placeholder remains as a
 * "revert" option in the select even after a canonical name is picked.
 */
function skillEntry() {
  return new fields.SchemaField({
    name:            new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    ranks:           new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    isChoice:        new fields.BooleanField({ required: true, nullable: false, initial: false }),
    placeholderName: new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" })
  });
}

/**
 * Schema for the outer category-rank entries: a category reference
 * plus the ranks granted to it AND the skills it touches.
 * See `skillEntry` for the meaning of `placeholderName`.
 */
function categoryRankEntry() {
  return new fields.SchemaField({
    category:        new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    ranks:           new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    isChoice:        new fields.BooleanField({ required: true, nullable: false, initial: false }),
    placeholderName: new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    skills:          new fields.ArrayField(skillEntry(), { required: true, nullable: false, initial: [] })
  });
}

export class TrainingPackageData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      // Complexity tier (Low / Medium / High / etc). Free-form to
      // support fan-published TPs that introduce custom tiers.
      type: str(""),

      description:    new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      timeToAcquire:  str(""),
      startingMoney:  str(""),
      statGains:      str(""),

      special:        new fields.ArrayField(specialEntry(),       { required: true, initial: [] }),
      categoryRanks:  new fields.ArrayField(categoryRankEntry(),  { required: true, initial: [] }),

      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),

      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Convenience aggregates for the sheet:
   *   - totalCategoryRanks: sum of ranks across categoryRanks[]
   *   - totalSkillRanks:    sum of ranks across all nested skills
   *   - totalSpecialDPCost: sum of dpCost across the `special` list
   *   - hasChoices:         true if any entry carries isChoice
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    const cats = this.categoryRanks ?? [];
    let categoryRanks = 0;
    let skillRanks = 0;
    let hasChoices = false;
    for (const c of cats) {
      categoryRanks += Number(c.ranks) || 0;
      if (c.isChoice) hasChoices = true;
      for (const s of (c.skills ?? [])) {
        skillRanks += Number(s.ranks) || 0;
        if (s.isChoice) hasChoices = true;
      }
    }
    this.totalCategoryRanks = categoryRanks;
    this.totalSkillRanks    = skillRanks;
    this.totalSpecialDPCost = (this.special ?? []).reduce(
      (sum, e) => sum + (Number(e.dpCost) || 0), 0
    );
    this.hasChoices = hasChoices;
  }
}
