/**
 * RMF System - Realm item DataModel.
 *
 * Mirrors `template.json:Item.realm`. A realm picks the magical realm
 * (Essence/Channeling/Mentalism) and the prime stats that drive its
 * Power Point Development category.
 */

import { STAT_KEYS_FULL } from "../utils/constants.mjs";

const fields = foundry.data.fields;

const POWER_POINTS_TYPE_CHOICES = ["Essence", "Channeling", "Mentalism"];

export class RealmData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    // statBonus.statN holds either the empty string (no stat) or a
    // canonical chXxx key. We keep it as a free StringField (rather
    // than `choices: STAT_KEYS_FULL`) because the empty string is a
    // legitimate value and `choices` would forbid it without manual
    // nullable handling.
    const statKey = (initial = "") => new fields.StringField({
      required: true, nullable: false, blank: true, initial
    });

    return {
      description: new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      powerPointsType: new fields.StringField({
        required: true, nullable: false, blank: false,
        initial: "Mentalism",
        choices: POWER_POINTS_TYPE_CHOICES
      }),
      statBonus: new fields.SchemaField({
        stat1: statKey("chPresence"),
        stat2: statKey(""),
        stat3: statKey("")
      }),
      fromBook: new fields.StringField({
        required: true, nullable: false, blank: true, initial: "basic"
      })
    };
  }

  /**
   * Derived: `powerPointsField` is the matching attribute name on a
   * race item (`ppEssence` / `ppChanneling` / `ppMentalism`), used by
   * the special-progression resolver in SkillData.
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    this.powerPointsField = `pp${this.powerPointsType}`;
  }
}

// Re-export the canonical stat keys so consumers can validate against
// them without importing utils/constants directly.
export { STAT_KEYS_FULL };
