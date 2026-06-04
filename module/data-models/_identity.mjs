/**
 * RMF System — Shared schema fragment for *content* item identity.
 *
 * The 8 content DataModels (skill, category, profession, race, realm,
 * spellList, trainingPackage, attackTable) all carry a stable `slug`.
 * Skills and categories additionally carry a `specialRole` tag so the
 * HP/PP-driving "Body Development" / "Power Point Development" entries are
 * matched by an internal role instead of their English names (which would
 * silently break under translation or a typo).
 *
 * Centralising the field definitions here keeps every content type's
 * identity behaviour byte-for-byte identical and gives migrations one
 * place to evolve.
 *
 * @see module/utils/slug.mjs   (slugify + resolution)
 * @see ./refactor.md           (Fase 0 — Identidad)
 */

import { slugify } from "../utils/slug.mjs";

const fields = foundry.data.fields;

/**
 * The stable identity field. Blank-tolerant FOREVER (it must never gain a
 * non-blank validator): resolution always falls back to the slugified
 * `name`, so a not-yet-backfilled document still loads and resolves.
 * Populated by the `preCreateItem` hook on create, by the importer when the
 * source carries an authored slug, and by the world migration for existing
 * documents — never required from the user.
 *
 * @returns {foundry.data.fields.StringField}
 */
export function slugField() {
  return new fields.StringField({ required: true, nullable: false, blank: true, initial: "" });
}

/**
 * Canonical special-role values. `bodyDevelopment` and
 * `powerPointDevelopment` are the two RMF mechanics that set a character's
 * HP / PP maxima and use race-specific progression tables.
 * @type {readonly string[]}
 */
export const SPECIAL_ROLES = Object.freeze(["none", "bodyDevelopment", "powerPointDevelopment"]);

/**
 * The specialRole tag for skill / category. Defaults to "none".
 * @returns {foundry.data.fields.StringField}
 */
export function specialRoleField() {
  return new fields.StringField({
    required: true, nullable: false, blank: false,
    initial: "none", choices: SPECIAL_ROLES
  });
}

/**
 * Map a known English skill / category name to its specialRole. Used by
 * the importer (new docs) and the world migration (existing docs) to stamp
 * the tag; the runtime resolution also falls back to this so the tag is
 * belt-and-suspenders, never load-bearing on its own.
 *
 * @param {unknown} name
 * @returns {"none"|"bodyDevelopment"|"powerPointDevelopment"}
 */
export function specialRoleFromName(name) {
  switch (slugify(name)) {
    case "body-development":        return "bodyDevelopment";
    case "power-point-development": return "powerPointDevelopment";
    default:                        return "none";
  }
}

/**
 * Resolve the effective special-role of a skill/category given its stored
 * tag and display name: prefer the explicit tag, fall back to the name.
 * The single helper every call-site uses so the fallback rule lives in one
 * place.
 *
 * @param {string|undefined} role - the stored `system.specialRole`
 * @param {unknown} name - the item's display name
 * @returns {"none"|"bodyDevelopment"|"powerPointDevelopment"}
 */
export function resolveSpecialRole(role, name) {
  return (role && role !== "none") ? role : specialRoleFromName(name);
}
