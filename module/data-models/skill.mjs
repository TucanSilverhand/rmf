/**
 * RMF System - Skill item DataModel.
 *
 * Mirrors `template.json:Item.skill`. Drives the per-roll bonus that
 * RMFActions.#rollSkill consumes via `system.bonus` (alias of
 * `system.totalBonus`).
 */

import {
  computeSkillRankBonus,
  formatSkillRankBonusBreakdown,
  normalizeSkillProgression,
  normalizeSkillClassification,
  SKILL_CLASSIFICATIONS
} from "../utils/rank-bonus.mjs";
import { totalBoughtRanks } from "./_shared.mjs";
import { CATEGORY_GROUPS, normalizeCategoryGroup } from "./category.mjs";
import { slugField, specialRoleField, resolveSpecialRole } from "./_identity.mjs";
import { matchesIdentity } from "../utils/slug.mjs";

const fields = foundry.data.fields;

const SKILL_PROGRESSIONS = ["standard", "combined", "limited", "special"];
const SPECIAL_STATUS_CHOICES = ["none", "everyman", "occupational", "restricted"];

export class SkillData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const num = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, integer: true, initial, ...opts });
    const numFloat = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, initial, ...opts });
    const str = (initial = "", opts = {}) =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial, ...opts });

    return {
      description: new fields.HTMLField({ required: true, nullable: false, initial: "" }),

      // Legacy `rank` field — superseded by totalBoughtRanks but kept
      // persisted so older worlds load. Derivation overwrites it.
      rank: num(0, { min: 0 }),

      // Reference to a category by name. Free-form string because users
      // may type a custom category that doesn't exist in the world yet.
      category: str(""),
      group: str("none", { choices: CATEGORY_GROUPS }),

      classification: str("movingManeuver", { choices: SKILL_CLASSIFICATIONS }),

      dpCost: new fields.SchemaField({
        price1: numFloat(0, { min: 0 }),
        price2: numFloat(0, { min: 0 }),
        price3: numFloat(0, { min: 0 })
      }),

      boughtByLevel: new fields.ObjectField({ required: true, nullable: false, initial: () => ({}) }),

      skillRankBonusProgression: str("standard", { choices: SKILL_PROGRESSIONS }),
      commonlyUsed: new fields.BooleanField({ required: true, nullable: false, initial: false }),

      profBonus:  numFloat(0),
      spec1Bonus: numFloat(0),
      spec2Bonus: numFloat(0),

      specialStatus: str("none", { choices: SPECIAL_STATUS_CHOICES }),

      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),
      // HP/PP-driving role; "none" for ordinary skills. The Body /
      // Power Point Development skills are matched by this tag instead
      // of their English names. See ./_identity.mjs.
      specialRole: specialRoleField(),

      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Migration ───────────────────────── */

  /**
   * Heal pre-existing skills whose `group` field uses a legacy spelling
   * ("None" instead of "none", "Power" instead of "Power Awareness",
   * "Technical/Trade" instead of "Technical", …) before the schema's
   * `choices` validator runs. Shares the normalizer with CategoryData.
   *
   * @param {Object} source - Raw `system` data being initialised
   * @returns {Object} The (possibly mutated) source
   */
  static migrateData(source) {
    if (source && typeof source === "object" && "group" in source) {
      source.group = normalizeCategoryGroup(source.group);
    }
    return super.migrateData(source);
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Compute totalRanks, totalRankBonus, categoryBonus, totalBonus.
   * Resolves the special-progression override table when the parent
   * actor has a race+realm and this is a Body / Power Point Development
   * skill.
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    const item = this.parent;
    const actor = item?.parent;

    const totalBought = totalBoughtRanks(this.boughtByLevel);
    // Skills don't have freeRanks today; racial ranks are stored under
    // boughtByLevel.0, so they're already accounted for.
    const totalRanks = totalBought;

    const progression = normalizeSkillProgression(this.skillRankBonusProgression);
    const overrideTable = this.#resolveSpecialSkillTable(progression, item, actor);
    const rankBonus = computeSkillRankBonus(totalRanks, progression, overrideTable);

    let categoryBonus = 0;
    if (actor?.documentName === "Actor" && this.category) {
      // Resolve by stable identity (slug, falling back to slugified name)
      // so the join survives renames, translation, case, and the "·"
      // middot in names like "Armor · Heavy". See module/utils/slug.mjs.
      const parentCategory = actor.items.find(i =>
        i.type === "category" && matchesIdentity(i, this.category)
      );
      if (parentCategory) categoryBonus = Number(parentCategory.system?.totalBonus ?? 0) || 0;
    }

    this.totalRanks = totalRanks;
    this.totalRankBonus = rankBonus;
    this.categoryBonus = categoryBonus;
    this.totalBonus = rankBonus + categoryBonus
      + (this.profBonus || 0) + (this.spec1Bonus || 0) + (this.spec2Bonus || 0);
    // Human-readable breakdown of the rank bonus (e.g. "10*3 + 5*2 = 40")
    // used by the skill sheet header. Persisted on the model so the
    // sheet doesn't need to know about overrideTable resolution.
    this.rankBonusSummary = formatSkillRankBonusBreakdown(totalRanks, progression, overrideTable);
    // Alias used by RMFActions.#rollSkill — keeps actions.mjs untouched.
    this.bonus = this.totalBonus;
    // Normalize classification onto `this` so template lookups land
    // even when the persisted value was an older variant.
    this.classification = normalizeSkillClassification(this.classification);
  }

  /**
   * Resolve the override progression table for skills with the
   * "special" progression. Mappings:
   *   - "Body Development" → race.bodyDevelopmentTable
   *   - "Power Point Development" → race[`${realm.powerPointsField}Table`]
   * Returns null when there's no actor / no race / not a special skill.
   *
   * @private
   */
  #resolveSpecialSkillTable(progression, item, actor) {
    if (progression !== "special") return null;
    if (actor?.documentName !== "Actor") return null;
    const raceItem = actor.itemTypes?.race?.[0];
    if (!raceItem) return null;

    // Match by the internal specialRole tag (locale-independent), falling
    // back to the English name so un-migrated docs still resolve.
    const role = resolveSpecialRole(this.specialRole, item.name);

    if (role === "bodyDevelopment") {
      return raceItem.system?.bodyDevelopmentTable ?? null;
    }
    if (role === "powerPointDevelopment") {
      const realmItem = actor.itemTypes?.realm?.[0];
      const field = realmItem?.system?.powerPointsField;
      if (typeof field !== "string" || !field) return null;
      return raceItem.system?.[`${field}Table`] ?? null;
    }
    return null;
  }
}
