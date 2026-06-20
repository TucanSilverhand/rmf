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
import { slugField, specialRoleField, resolveSpecialRole } from "./_identity.mjs";
import { parseDPCost, dpCostFromTriple } from "../utils/dp-cost.mjs";

const fields = foundry.data.fields;

/**
 * Allowed values for `system.group`, paired with their i18n label
 * keys. Single source of truth: the schema validates against the
 * `value`s, the sheet renders the `label`s. Adding a group here
 * exposes it everywhere automatically.
 */
export const CATEGORY_GROUP_OPTIONS = Object.freeze([
  { value: "none",                    label: "RMF.Category.Groups.None" },
  { value: "Armor",                   label: "RMF.Category.Groups.Armor" },
  { value: "Artistic",                label: "RMF.Category.Groups.Artistic" },
  { value: "Athletic",                label: "RMF.Category.Groups.Athletic" },
  { value: "Awareness",               label: "RMF.Category.Groups.Awareness" },
  { value: "Body Development",        label: "RMF.Category.Groups.BodyDevelopment" },
  { value: "Combat Maneuvers",        label: "RMF.Category.Groups.CombatManeuvers" },
  { value: "Communications",          label: "RMF.Category.Groups.Communications" },
  { value: "Craft",                   label: "RMF.Category.Groups.Craft" },
  { value: "Directed Spells",         label: "RMF.Category.Groups.DirectedSpells" },
  { value: "Influence",               label: "RMF.Category.Groups.Influence" },
  { value: "Lore",                    label: "RMF.Category.Groups.Lore" },
  { value: "Martial Arts",            label: "RMF.Category.Groups.MartialArts" },
  { value: "Outdoor",                 label: "RMF.Category.Groups.Outdoor" },
  { value: "Power Awareness",         label: "RMF.Category.Groups.PowerAwareness" },
  { value: "Power Point Development", label: "RMF.Category.Groups.PowerPointDevelopment" },
  { value: "Science",                 label: "RMF.Category.Groups.Science" },
  { value: "Self Control",            label: "RMF.Category.Groups.SelfControl" },
  { value: "Spells",                  label: "RMF.Category.Groups.Spells" },
  { value: "Subterfuge",              label: "RMF.Category.Groups.Subterfuge" },
  { value: "Technical",               label: "RMF.Category.Groups.Technical" },
  { value: "Urban",                   label: "RMF.Category.Groups.Urban" },
  { value: "Weapon",                  label: "RMF.Category.Groups.Weapon" }
]);

/** Plain values, derived for `choices` validation in the schema. */
export const CATEGORY_GROUPS = Object.freeze(CATEGORY_GROUP_OPTIONS.map(g => g.value));

/**
 * Map legacy / variant `group` values to the canonical set above. Used by
 * `migrateData` (auto-heals existing world items at load time) and by the
 * importer (defense-in-depth so freshly-imported documents are clean).
 *
 * @param {*} value
 * @returns {string} A canonical group value, or "none" when unrecognised.
 */
export function normalizeCategoryGroup(value) {
  if (typeof value !== "string" || !value.length) return "none";
  if (CATEGORY_GROUPS.includes(value)) return value;
  // Common legacy spellings observed in pre-existing data dumps. Used
  // by both CategoryData.migrateData and SkillData.migrateData (skills
  // share the same group enum).
  if (value === "None") return "none";
  if (value === "Spell" || value === "Spell List") return "Spells";
  if (value === "Power") return "Power Awareness";
  if (value === "Technical/Trade") return "Technical";
  return "none";
}

const CATEGORY_PROGRESSIONS = ["standard", "nonstandard"];

export class CategoryData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const numFloat = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, initial, ...opts });
    const str = (initial = "", opts = {}) =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial, ...opts });

    return {
      description: new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      group: str("none", { choices: CATEGORY_GROUPS }),

      // dpCost: RMF slash-notation string ("2/5", "2/2/2", "20", "3/*").
      // Empty = no cost / not applicable. Parsed to `dpCostParsed` in
      // prepareDerivedData, mirroring how race.mjs handles its "0/6/4/2/1"
      // progression strings. See module/utils/dp-cost.mjs.
      dpCost: str(""),

      // Object keyed by character level (string keys), each holding the
      // number of ranks bought at that level. `0` is reserved for racial
      // ranks granted at character creation. We persist as a plain
      // ObjectField because the keys are dynamic (level numbers).
      boughtByLevel: new fields.ObjectField({ required: true, nullable: false, initial: () => ({}) }),

      freeRanks: numFloat(0, { min: 0 }),

      categoryRankBonusProgression: str("standard", { choices: CATEGORY_PROGRESSIONS }),

      // NOTE: the legacy persisted `ranks` counter was removed in 0.4.0 (R8).
      // Total ranks derive from boughtByLevel + freeRanks; `this.ranks` is
      // still exposed as an in-memory alias in prepareDerivedData.

      statBonus: new fields.SchemaField({
        stat1: str("chAgility"),
        stat2: str("chConstitution"),
        stat3: str("chSelfDiscipline")
      }),

      profBonus:  numFloat(0),
      spec1Bonus: numFloat(0),
      spec2Bonus: numFloat(0),

      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),
      // HP/PP-driving role; "none" for ordinary categories. Matched
      // instead of the English name. See ./_identity.mjs.
      specialRole: specialRoleField(),

      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Migration ───────────────────────── */

  /**
   * Heal pre-existing items whose `group` field uses a legacy spelling
   * ("None" instead of "none", "Spell" instead of "Spells", …) before
   * the schema's `choices` validator runs and rejects them. Foundry
   * calls this once per source object, prior to validation.
   *
   * @param {Object} source - Raw `system` data being initialised
   * @returns {Object} The (possibly mutated) source
   */
  static migrateData(source) {
    if (source && typeof source === "object") {
      if ("group" in source) source.group = normalizeCategoryGroup(source.group);
      // Legacy dpCost triple { price1, price2, price3 } → slash string,
      // so old worlds load against the new StringField schema.
      if (source.dpCost && typeof source.dpCost === "object") {
        source.dpCost = dpCostFromTriple(source.dpCost);
      }
    }
    return super.migrateData(source);
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

    // Structured view of the DP cost for sheets/engines (ephemeral).
    this.dpCostParsed = parseDPCost(this.dpCost);

    const item = this.parent;

    // Inherit stat bonus slots from the realm for categories whose applicable
    // stat IS the realm stat: Power Point Development and the Spells categories
    // (A-4.18 — a spell-list skill uses the caster's realm stat: Em/In/Pr).
    // PP-Dev is matched by its locale-independent specialRole tag (name fallback);
    // the Spells categories are matched by their group. See _identity.mjs.
    const role = resolveSpecialRole(this.specialRole, item?.name);
    if (role === "powerPointDevelopment" || this.group === "Spells") {
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
