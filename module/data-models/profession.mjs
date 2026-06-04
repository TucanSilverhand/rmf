/**
 * RMF System - Profession item DataModel.
 *
 * Mirrors `template.json:Item.profession`. Most arrays are still empty
 * in the canonical data set (data/professions.json) — the schema is
 * complete so when the user fills them in they pass validation.
 */

import { slugField } from "./_identity.mjs";
import { dpCostFromTriple } from "../utils/dp-cost.mjs";

const fields = foundry.data.fields;

/**
 * `{ name, dpCost }` row used by categoryPrice/spellPrice. `dpCost` is the
 * RMF slash-notation string ("2/5", "3/*", or "" = included / no cost).
 * This is the per-profession DP cost the character pays for that category /
 * spell list. See module/utils/dp-cost.mjs.
 */
function pricedNameEntry() {
  return new fields.SchemaField({
    name:   new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    dpCost: new fields.StringField({ required: true, nullable: false, blank: true, initial: "" })
  });
}

/**
 * `{ name, isChoice }` row used by skill lists (everyman/occupational/restricted).
 *
 * `isChoice` flags entries whose `name` is a free-form placeholder ("any
 * one Combat Maneuver", "choice of one Situational Awareness", …) instead
 * of a canonical skill from `data/skills.json`. Same semantics as the
 * `isChoice` field on `training-package.mjs` rows.
 */
function namedRow() {
  return new fields.SchemaField({
    name:     new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    isChoice: new fields.BooleanField({ required: true, nullable: false, initial: false })
  });
}

/**
 * `{ name, bonus, isChoice }` row used by professionalBonuses.
 * See `namedRow` for the meaning of `isChoice`.
 */
function bonusRow() {
  return new fields.SchemaField({
    name:     new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    bonus:    new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 }),
    isChoice: new fields.BooleanField({ required: true, nullable: false, initial: false })
  });
}

/** `{ name, dpCost }` row used by trainingPackages (single dpCost number). */
function trainingPackageRow() {
  return new fields.SchemaField({
    name:   new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    dpCost: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 })
  });
}

export class ProfessionData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const arrayOf = (entry) =>
      new fields.ArrayField(entry, { required: true, nullable: false, initial: [] });

    return {
      description:         new fields.HTMLField({ required: true, nullable: false, initial: "" }),

      // Each entry is a chXxx key (or empty string for empty slot).
      primeStats:          new fields.ArrayField(
        new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
        { required: true, initial: [] }
      ),
      professionalBonuses: arrayOf(bonusRow()),
      everymanSkills:      arrayOf(namedRow()),
      occupationalSkills:  arrayOf(namedRow()),
      restrictedSkills:    arrayOf(namedRow()),
      categoryPrice:       arrayOf(pricedNameEntry()),
      spellPrice:          arrayOf(pricedNameEntry()),
      trainingPackages:    arrayOf(trainingPackageRow()),

      // Stable identity (locale-independent). See module/utils/slug.mjs.
      slug: slugField(),

      fromBook: new fields.StringField({
        required: true, nullable: false, blank: true, initial: "basic"
      })
    };
  }

  /* ───────────────────────── Migration ───────────────────────── */

  /**
   * Convert legacy dpCost triples on the categoryPrice / spellPrice rows
   * to the slash-notation string before the StringField schema validates.
   * Mirrors the per-model auto-heal used for slugs and category groups.
   *
   * @param {Object} source
   * @returns {Object}
   */
  static migrateData(source) {
    if (source && typeof source === "object") {
      for (const key of ["categoryPrice", "spellPrice"]) {
        if (!Array.isArray(source[key])) continue;
        for (const row of source[key]) {
          if (row && row.dpCost && typeof row.dpCost === "object") {
            row.dpCost = dpCostFromTriple(row.dpCost);
          }
        }
      }
    }
    return super.migrateData(source);
  }
}
