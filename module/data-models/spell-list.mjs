/**
 * RMF System - Spell List item DataModel.
 *
 * Mirrors the shape of the `data/*-lists.json` import sources (one Item
 * per spell list, e.g. "Barrier Law", "Fire Law"). A spell list bundles
 * up to 10 spells (one per level 1-10; a level with no spell keeps an
 * entry with an empty `name` so the sheet always renders all 10 rows).
 *
 * The static rules legend (special codes, spell types, durations, etc.)
 * is intentionally NOT stored here — it is identical for every list and
 * lives in `module/utils/constants.mjs` (`SPELL_DESCRIPTION_KEY`),
 * exposed via `CONFIG.RMF.spellDescriptionKey`.
 *
 * Field-name note: the source JSON calls the Open/Closed/Base axis
 * `type`, which collides with the Foundry document `type`. The importer
 * maps it to `listType` here. The per-spell `type` (E/F/P/...) is nested
 * and has no collision.
 */

import {
  SPELL_SPECIAL_CODES,
  SPELL_TYPE_CODES,
  SPELL_SUBTYPE_CODES
} from "../utils/constants.mjs";

const fields = foundry.data.fields;

const REALM_CHOICES     = ["Channeling", "Essence", "Mentalism"];
const LIST_TYPE_CHOICES = ["Open", "Closed", "Base"];

/**
 * Schema for one spell row. `name === ""` marks an empty level (the
 * book leaves some levels with no spell); the sheet still renders the
 * level so the 1-10 ladder stays intact.
 */
function spellEntry() {
  const str = (initial = "") =>
    new fields.StringField({ required: true, nullable: false, blank: true, initial });

  return new fields.SchemaField({
    level: new fields.NumberField({
      required: true, nullable: false, integer: true, min: 1, max: 10, initial: 1
    }),
    name:         str(""),
    // Per-spell special codes (`*` → instantaneous, `•` → noPowerPoints,
    // `‡` → spellSet). `rrMod` is a separate numeric field, not a code.
    codes: new fields.ArrayField(
      new fields.StringField({
        required: true, nullable: false, blank: false,
        choices: SPELL_SPECIAL_CODES
      }),
      { required: true, nullable: false, initial: [] }
    ),
    // `[RR Mod #]` modifier. null = the spell has no RR modifier.
    rrMod: new fields.NumberField({
      required: false, nullable: true, integer: true, initial: null
    }),
    areaOfEffect: str(""),
    duration:     str(""),
    range:        str(""),
    // Composite spell type, e.g. "E", "DE", "Fm", "Us", "Pm". Kept as a
    // free string (a `choices` set would need the base×sub-type product);
    // validity is reported via prepareDerivedData against the key.
    type:         str(""),
    description:  new fields.HTMLField({ required: true, nullable: false, initial: "" })
  });
}

export class SpellListData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    return {
      realm: new fields.StringField({
        required: true, nullable: false, blank: false,
        initial: "Channeling", choices: REALM_CHOICES
      }),
      // Open / Closed / Base (the JSON's `type`, renamed to dodge the
      // Foundry document-type collision).
      listType: new fields.StringField({
        required: true, nullable: false, blank: false,
        initial: "Open", choices: LIST_TYPE_CHOICES
      }),
      // Owning profession for Base lists (Cleric/Ranger/Magician/
      // Dabbler/Mentalist/Bard). Empty for Open/Closed lists.
      profession:   str(""),
      // Book section id, e.g. "A-9.5.1".
      reference:    str(""),
      specialNotes: new fields.ArrayField(
        new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
        { required: true, nullable: false, initial: [] }
      ),
      spells: new fields.ArrayField(spellEntry(), { required: true, nullable: false, initial: [] }),
      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Convenience aggregates for the sheet:
   *   - filledSpells:  spells that actually have a name
   *   - emptyLevels:   level numbers with no spell
   *   - hasSpellSet:   any spell flagged spellSet (‡)
   *   - invalidTypes:  spell types not resolvable against the key
   *                    (base + optional s/m); empty when all valid
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    const spells = this.spells ?? [];
    const filled = [];
    const emptyLevels = [];
    let hasSpellSet = false;
    const invalidTypes = [];

    for (const s of spells) {
      if (!s?.name) { emptyLevels.push(s?.level); continue; }
      filled.push(s);
      if ((s.codes ?? []).includes("spellSet")) hasSpellSet = true;
      if (!SpellListData.isValidSpellType(s.type)) invalidTypes.push(s.type);
    }

    this.filledSpells = filled;
    this.totalSpells  = filled.length;
    this.emptyLevels  = emptyLevels;
    this.hasSpellSet  = hasSpellSet;
    this.invalidTypes = invalidTypes;
    this.isBaseList   = this.listType === "Base";
  }

  /**
   * A spell type is a base code (E/BE/DE/F/P/U/I) optionally followed
   * by sub-type letters (s and/or m), e.g. "Fm", "Us", "Pm". An empty
   * type is treated as invalid only for filled spells (handled above).
   *
   * @param {string} type
   * @returns {boolean}
   */
  static isValidSpellType(type) {
    if (typeof type !== "string" || !type) return false;
    // Longest base code first so "DE"/"BE" win over "D"/"B".
    const base = [...SPELL_TYPE_CODES]
      .sort((a, b) => b.length - a.length)
      .find(code => type.startsWith(code));
    if (!base) return false;
    const rest = type.slice(base.length);
    return [...rest].every(ch => SPELL_SUBTYPE_CODES.includes(ch));
  }
}
