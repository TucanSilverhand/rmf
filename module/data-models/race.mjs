/**
 * RMF System - Race item DataModel.
 *
 * Mirrors `template.json:Item.race`. A race carries:
 *   - per-stat bonuses (short keys ag/co/...)
 *   - resistance modifiers (short keys ess/chan/...)
 *   - body / pp progression strings (e.g. "0/6/4/2/1")
 *   - racial ranks granted to skills/categories at character creation
 *   - special skill lists (everyman / restricted)
 *   - background options & hobby ranks
 */

const fields = foundry.data.fields;

const STAT_SHORT_KEYS = ["ag", "co", "me", "re", "sd", "em", "in", "pr", "qu", "st"];
const RESIST_SHORT_KEYS = ["ess", "chan", "ment", "pois", "dis"];

/**
 * Helper: "racialRanks.categories[]" / "racialRanks.skills[]" each
 * carry { name: string, ranks: number }. Schema-wise they're array
 * of objects with those two fields.
 */
function rankEntry() {
  return new fields.SchemaField({
    name:  new fields.StringField({ required: true, nullable: false, blank: true, initial: "" }),
    ranks: new fields.NumberField({ required: true, nullable: false, integer: true, initial: 0 })
  });
}

/**
 * Helper: specialSkills.everyman / .restricted are arrays of skill
 * names. We model them as ArrayField of StringField for type clarity.
 */
function nameArrayField() {
  return new fields.ArrayField(
    new fields.StringField({ required: true, nullable: false, blank: false }),
    { required: true, nullable: false, initial: [] }
  );
}

export class RaceData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const num = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, integer: true, initial, ...opts });
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });
    const progStr = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    // Stats / resistances: 10 / 5 short-key numeric fields.
    const statsSchema = {};
    for (const k of STAT_SHORT_KEYS) statsSchema[k] = num(0);
    const resistSchema = {};
    for (const k of RESIST_SHORT_KEYS) resistSchema[k] = num(0);

    return {
      description:     new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      racialAbilities: new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      stats:       new fields.SchemaField(statsSchema),
      resistances: new fields.SchemaField(resistSchema),
      backgroundOptions: num(0, { min: 0 }),

      // Progression strings of the form "zero/T1/T2/T3/T4" e.g. "0/6/4/2/1".
      // Kept as plain strings to preserve the existing data shape.
      bodyDevelopment: progStr(""),
      ppChanneling:    progStr(""),
      ppEssence:       progStr(""),
      ppMentalism:     progStr(""),

      hobbyRanks: num(0, { min: 0 }),

      racialRanks: new fields.SchemaField({
        categories: new fields.ArrayField(rankEntry(), { required: true, initial: [] }),
        skills:     new fields.ArrayField(rankEntry(), { required: true, initial: [] })
      }),

      specialSkills: new fields.SchemaField({
        everyman:   nameArrayField(),
        restricted: nameArrayField()
      }),

      standardHobbySkills: str(""),
      fromBook: str("basic")
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Parse the progression strings into structured tables and surface
   * convenience flags / sums used by the race sheet and by skills with
   * the "special" progression (Body Development, PP Development).
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    // Parsed progression tables (ephemeral; not persisted).
    this.bodyDevelopmentTable = parseRaceProgression(this.bodyDevelopment);
    this.ppChannelingTable    = parseRaceProgression(this.ppChanneling);
    this.ppEssenceTable       = parseRaceProgression(this.ppEssence);
    this.ppMentalismTable     = parseRaceProgression(this.ppMentalism);

    // O(1) lookup maps so the actor can resolve a category/skill name
    // to its racial rank value without scanning the arrays.
    this.racialRanksByCategory = Object.freeze(
      Object.fromEntries((this.racialRanks?.categories ?? []).map(e => [e.name, e.ranks]))
    );
    this.racialRanksBySkill = Object.freeze(
      Object.fromEntries((this.racialRanks?.skills ?? []).map(e => [e.name, e.ranks]))
    );

    // UI-only flags / sums.
    const stats = this.stats || {};
    const resistances = this.resistances || {};
    this.hasStatBonuses = Object.values(stats).some(v => v !== 0);
    this.hasResistances = Object.values(resistances).some(v => v !== 0);
    this.totalStatBonus = Object.values(stats).reduce((s, v) => s + (Number(v) || 0), 0);
    this.totalRacialCategoryRanks = (this.racialRanks?.categories ?? [])
      .reduce((s, e) => s + (Number(e.ranks) || 0), 0);
    this.totalRacialSkillRanks = (this.racialRanks?.skills ?? [])
      .reduce((s, e) => s + (Number(e.ranks) || 0), 0);
  }
}

/**
 * Parse a race progression string of the form "zero/T1/T2/T3/T4"
 * (e.g. "0/6/4/2/1") into a structured object. Missing positions
 * default to 0.
 *
 * @param {string} value
 * @returns {{zero:number, tier1:number, tier2:number, tier3:number, tier4:number}}
 */
function parseRaceProgression(value) {
  const empty = { zero: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  if (typeof value !== "string" || !value.trim()) return empty;
  const parts = value.split("/").map(s => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 5) parts.push(0);
  return { zero: parts[0], tier1: parts[1], tier2: parts[2], tier3: parts[3], tier4: parts[4] };
}

export { STAT_SHORT_KEYS, RESIST_SHORT_KEYS };
