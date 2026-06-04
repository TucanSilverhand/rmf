/**
 * RMF System - Profession item DataModel.
 *
 * Mirrors `template.json:Item.profession`. Most arrays are still empty
 * in the canonical data set (data/professions.json) — the schema is
 * complete so when the user fills them in they pass validation.
 */

import { slugField } from "./_identity.mjs";

const fields = foundry.data.fields;

/** Schema for `{ price1, price2, price3 }` blocks shared by category/spell prices. */
function dpCostBlock() {
  return new fields.SchemaField({
    price1: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 }),
    price2: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 }),
    price3: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0, min: 0 })
  });
}

/** `{ name, dpCost: {price1,price2,price3} }` row used by categoryPrice/spellPrice. */
function pricedNameEntry() {
  return new fields.SchemaField({
    name:   new fields.StringField({ required: true, nullable: false, blank: true,  initial: "" }),
    dpCost: dpCostBlock()
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
}
