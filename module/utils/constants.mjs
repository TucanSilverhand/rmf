/**
 * RMF System - Centralized constants and stat mappings.
 *
 * Single source of truth for magic numbers and key mappings used across
 * data models, sheets, importers, and actions. Anything that previously
 * appeared as an inline literal (35, 50, -15, ...) lives here.
 *
 * Constants are exported as immutable objects (Object.freeze) so that
 * accidental mutation surfaces immediately.
 *
 * @fileoverview Pure data, no Foundry runtime dependencies.
 */

/**
 * Mapping from short stat key (`ag`, `co`, ...) to the canonical full key
 * used on the actor (`chAgility`, `chConstitution`, ...). Race items, race
 * sheets, and importers all need this conversion.
 */
export const STAT_SHORT_TO_FULL = Object.freeze({
  ag: "chAgility",
  co: "chConstitution",
  me: "chMemory",
  re: "chReasoning",
  sd: "chSelfDiscipline",
  em: "chEmpathy",
  in: "chIntuition",
  pr: "chPresence",
  qu: "chQuickness",
  st: "chStrength"
});

/**
 * Reverse map: `chAgility` → `ag`. Useful for serializing actor stat blocks
 * back to the compact short-key form (e.g. when exporting a race item).
 */
export const STAT_FULL_TO_SHORT = Object.freeze(
  Object.fromEntries(Object.entries(STAT_SHORT_TO_FULL).map(([s, f]) => [f, s]))
);

/**
 * Canonical list of full stat keys, in display order.
 */
export const STAT_KEYS_FULL = Object.freeze(Object.values(STAT_SHORT_TO_FULL));

/**
 * Resolve any stat-name variant to its canonical `chXxx` form.
 *
 * Accepts:
 *   - canonical:        `chConstitution`
 *   - case-insensitive: `chconstitution`
 *   - short keys:       `co`, `CO`
 *   - user-friendly:    `Constitution`, `constitution`, `CONSTITUTION`
 *   - whitespaced:      `"Self Discipline"` → `chSelfDiscipline`
 *   - run-on:           `"SelfDiscipline"` → `chSelfDiscipline`
 *
 * Returns `""` for unknown / empty input. The function is idempotent —
 * already-canonical values pass through unchanged. Sheets call this
 * defensively so legacy data (imported before the chXxx normalization
 * landed) still renders the right `<option>` selected in dropdowns.
 *
 * @param {*} value
 * @returns {string} canonical stat key or empty string
 */
export function normalizeAnyStatKey(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (STAT_KEYS_FULL.includes(trimmed)) return trimmed;
  const key = trimmed.replace(/\s+/g, "").toLowerCase();
  if (key in STAT_SHORT_TO_FULL) return STAT_SHORT_TO_FULL[key];
  for (const full of STAT_KEYS_FULL) {
    if (full.toLowerCase() === key) return full;          // chconstitution
    if (full.slice(2).toLowerCase() === key) return full; // constitution
  }
  return "";
}

/**
 * Gameplay constants. Each block is grouped so it is obvious where the
 * number is consumed; do not split or duplicate them in callers.
 */
export const RMF_CONSTANTS = Object.freeze({
  /** Default temp/pot value for a freshly-rolled stat (typical RM starting). */
  DEFAULT_STAT: 35,

  /** Base hit-point pool before constitution / SD modifiers are applied. */
  HP_BASE: 50,

  /**
   * Penalty applied when rolling against a category with 0 ranks of any
   * relevant skill (canonical Rolemaster -15).
   */
  NO_SKILL_PENALTY: -15,

  /**
   * Unmodified maneuver results (PDF p.44). A natural 66 is an Unusual Event
   * and a natural 100 an Unusual Success: neither takes modifications, and the
   * 100 is explicitly NOT open-ended (it is not re-rolled).
   */
  MANEUVER_UM: Object.freeze({
    UNUSUAL_EVENT: 66,
    UNUSUAL_SUCCESS: 100
  }),

  /** Multiplier used when converting a primary-stat bonus into a resistance. */
  RESISTANCE_MULTIPLIER: 3,

  /** Multiplier used when converting Quickness into the defensive bonus. */
  DEFENSIVE_MULTIPLIER: 3,

  /** Default sheet sizing (used by ApplicationV2 DEFAULT_OPTIONS). */
  SHEET_SIZE: Object.freeze({
    ACTOR_WIDTH: 700,
    ACTOR_HEIGHT: 522,
    ITEM_WIDTH: 500,
    ITEM_HEIGHT: 475
  })
});

/**
 * Spell Description Key (RMF Appendix A-9.3).
 *
 * Static rules reference shared by every spell list: special codes,
 * spell types, sub-types, areas of effect, durations, ranges, and the
 * glossary definitions. It is identical for all 96 spell lists, so it
 * lives here as the single source of truth and is exposed via
 * `CONFIG.RMF.spellDescriptionKey`. It is NOT persisted on each
 * `spellList` item (that would duplicate ~5 KB per document and force a
 * migration to fix any wording). Canonical text is the English book
 * wording; the UI can localize the short labels via `RMF.SpellKey.*`.
 *
 * @see module/data-models/spell-list.mjs - schema validation consumer
 */
function _deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") _deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const SPELL_DESCRIPTION_KEY = _deepFreeze(
  {
    "reference": "A-9.3",
    "specialCodes": {
      "rrMod": {
        "symbol": "[RR Mod #]",
        "description": "Any RRs against the effects of this spell are modified by #. Stored per-spell as numeric `rrMod` field."
      },
      "instantaneous": {
        "symbol": "*",
        "description": "Instantaneous; spell does not require preparation rounds."
      },
      "noPowerPoints": {
        "symbol": "•",
        "description": "Spell does not require power points."
      },
      "spellSet": {
        "symbol": "‡",
        "description": "Part of a set of spells that must be thrown in conjunction with other spells continuously to be effective (or fully effective)."
      }
    },
    "spellTypes": {
      "E": "Elemental spell. These spells use the force of the spell to manipulate physical elements (heat, cold, wind, light, water, earth, sound, smell, taste, touch). These elements (and not the spell) are used to either create a phenomena that can affect the physical environment of the target (e.g., a “wall” spell) or the sense of the target (e.g., an “illusion” spell). Because the elements are real, no Resistance Rolls are normally allowed.",
      "BE": "Ball Elemental spell. These are elemental spells that attack an area with one of the physical elements. Such attacks are resolved on the Ball Spell Attack Table A-10.9.10 (p. 229)—see also Appendix A-10.8 (p. 219).",
      "DE": "Directed Elemental spell. These are elemental spells that directly attack a target with one of the physical elements. Such attacks are resolved on the Bolt Spell Attack Table A-10.9.9 (p. 228)—see also Appendix A-10.7 (p. 219).",
      "F": "Force spell. These spells involve the direct manipulation of matter, energy, the elements, or living beings through the use of a spell’s force. If the spell has a target capable of resisting, the caster makes an attack roll on the Basic Spell Attack Table A-10.9.11 (p. 230)—see also Appendix A-10.6 (p. 218), to determine the RR modification for the target. Determine the type of armor the target is wearing and roll on the appropriate column of the table (using the Other column if nothing else applies). After determining the RR modification, the target makes an RR (on Table T-3.4, p. 230, using the target’s level and the attacker’s level as the indices).",
      "P": "Passive spell. These spells usually only indirectly or passively affect a target. Thus, if an RR is allowed (GM’s discretion), its purpose is only to determine if the target is aware of the spell. Many detection spells are of this type.",
      "U": "Utility spell. These spells only affect the caster, a willing target, or a target incapable of resistance. Thus, RRs are not usually necessary. A willing target who is capable of resisting may still be required to make an RR (GM’s discretion), but it is modified by -50 (i.e., he mostly likely will not resist). Most healing spells are of this type.",
      "I": "Informational spell. These spells involve gathering information through means that do not require RRs."
    },
    "spellSubTypes": {
      "s": "Subconscious spell. These spells are capable of being cast (or triggered) by the subconscious. The caster can always cast a spell of this type as a normal spell. In addition, any subconscious spell can be triggered while the caster is unconscious, asleep, in a trance, etc. A subconscious spell can be triggered by conditions that the spell can affect. A GM may allow a character to set conditions on his subconscious spells by “programming” his subconscious; in such a case the GM may require a maneuver roll modified by +50 plus three times the character’s Self Discipline plus any skill developed for this spell list.",
      "m": "Mental Attack spell. Any spell marked with an ‘m’ is considered a mental attack spell, and is subject to effects and defenses that target mental or mind attacks. These spells are ineffective against any creature or entity that does not have a “mind” per se (e.g., Undead, plants, politicians, etc.)."
    },
    "areasOfEffect": {
      "x target(s)": "The spell affects x number of targets.",
      "x target(s)/lvl": "The spell affects a number of targets equal to the caster’s level times x.",
      "distance R": "The spell affects all within a radius equal to distance in size.",
      "distance R / lvl": "The spell affects all within a radius equal to distance times the caster’s level in size.",
      "area": "The spell affects all within a fixed area of effect. Sometimes area will be specified as a specific target (e.g., 1 herb, 1 limb, etc.).",
      "caster": "The spell affects only the caster.",
      "—": "The spell has no area of effect.",
      "varies": "The exact size of the area of effect depends upon some other aspect of the spell."
    },
    "durations": {
      "time": "The spell has a fixed duration equal to time.",
      "C": "Concentration is required. Concentration requires 50% of the caster’s normal activity each round. Thus, the caster cannot normally cast any other spells while concentrating.",
      "duration (C)": "Concentration is required, except the period of concentration cannot exceed the duration given. The caster can stop concentrating and the spell effect will stop; if the duration has not expired, the caster can concentrate again and the spell effect will resume.",
      "P": "Permanent. The spell has a permanent effect (in the sense of creating a “permanent” physical or mental condition). The effects of permanent spells that manipulate matter and require concentration will disperse according to the normal physical laws once concentration is no longer applied. A spell with a permanent duration may be affected by outside forces (dispelled, cured, or otherwise disturbed by enchantment, physical force, etc.).",
      "varies": "Variable. The exact duration depends upon some other aspect of the spell.",
      "—": "No duration. The effects of this spell require no duration and are applied immediately.",
      "time / level": "The duration is the time multiplied by the level of the caster.",
      "time / # fail": "The duration is based upon the difference between the target’s modified RR and the minimum roll required to resist the spell (see Section 17.0, p. 52). The duration is equal to this difference divided by # and then multiplied by time. Example: 1 rnd/10 fail would mean that if the RR is failed by 16 to 24, the spell would last for 2 rounds."
    },
    "ranges": {
      "self": "The spell can only be cast upon the caster himself.",
      "touch": "The caster must touch the target to create the effect.",
      "distance": "The caster can be no further than distance to the desired area of effect.",
      "distance / lvl": "The distance to the area of effect can be no further than distance times the caster’s level.",
      "unlimited": "There are no limitations placed upon the distance to the area of effect.",
      "varies": "The distance to the area of effect depends upon some other aspect of the spell."
    },
    "definitions": {
      "Basic Attack Spell": "A spell that attacks a target, but which is not an elemental attack spell.",
      "Mass Spell": "A spell with its “# of targets” or its “area of effect” based upon the caster’s level.",
      "Elemental Attack Spell": "A spell which creates and uses fire, cold, water, ice, or electricity to attack a target. The “elements” created by these spells are real.",
      "Lord Spell": "The spell is keyed to a 20th level effect.",
      "True Spell": "A “True” spell is the highest level version of a specific spell type. Its potency will define the upper limit of the effect(s) derived from a given spell."
    }
  }
);

/** Valid spell `type` base codes: E, BE, DE, F, P, U, I. */
export const SPELL_TYPE_CODES = Object.freeze(
  Object.keys(SPELL_DESCRIPTION_KEY.spellTypes)
);

/** Valid spell sub-type codes appended to a base type: s, m. */
export const SPELL_SUBTYPE_CODES = Object.freeze(
  Object.keys(SPELL_DESCRIPTION_KEY.spellSubTypes)
);

/**
 * Valid per-spell special-code keys (instantaneous, noPowerPoints,
 * spellSet). `rrMod` is excluded because it is stored as a numeric
 * `rrMod` field on the spell, not as a code flag.
 */
export const SPELL_SPECIAL_CODES = Object.freeze(
  Object.keys(SPELL_DESCRIPTION_KEY.specialCodes).filter(k => k !== "rrMod")
);

/**
 * Effects-notation legends (the printed "Key" on every table page).
 *
 * These are RULES reference data — identical across every table of a family,
 * so they live here (deep-frozen, exposed on CONFIG.RMF) instead of being
 * duplicated on each `criticalTable` / `creatureCriticalTable` /
 * `weaponFumbleTable` / `spellFailureTable` item. Same rationale as
 * SPELL_DESCRIPTION_KEY above (~no per-document copies, no migration to fix a
 * wording). Genuinely per-table commentary (e.g. a creature table's column
 * description) stays on the item under `system.notes`.
 *
 * IMPORTANT: each key is the human-readable MIRROR of one parser's token set.
 * Keep it in sync with the parser if a token is ever added/changed:
 *   - CRITICAL_EFFECTS_KEY      ↔ module/tables/critical.mjs (parseCriticalEffects)
 *   - WEAPON_FUMBLE_EFFECTS_KEY ↔ module/tables/fumble.mjs (parseFumbleEffects)
 *   - SPELL_FAILURE_EFFECTS_KEY ↔ module/tables/spell-failure.mjs (parseSpellFailureEffects)
 *
 * Attack tables intentionally do NOT use these — their `legend` carries
 * load-bearing structured data (rangeModifiers, modifier, …), not a Key.
 */
export const CRITICAL_EFFECTS_KEY = _deepFreeze({
  key: "Np = must parry N rounds; Nnp = no parry for N rounds; Nst = stunned for N rounds; Nstnp = stunned and unable to parry for N rounds; Nstp = stunned and must parry for N rounds; Nbl = bleed N hits per round; (-N) = foe has -N penalty; (+N) = attacker gets +N next round.",
  hits: "+NH = N concussion hits.",
  rounds: "M(-N) / M(+N) = the penalty/bonus lasts M rounds. A bare token (p, st, bl, ...) = 1 round. Np(-M) = must parry N rounds at a -M penalty.",
  none: "\"-\" = no mechanical effect beyond the text (often death).",
  variants: "Conditional cells (e.g. \"with helmet / w/o helmet\") apply the matching variant."
});

export const WEAPON_FUMBLE_EFFECTS_KEY = _deepFreeze({
  key: "noatk = lose this attack; loseatk:N = lose N attack rounds (may parry); drop / drop:N = drop weapon (recover in N rounds); reload = must reload; breakage = breakage check; break = weapon breaks; bowbreak = bowstring breaks.",
  states: "Nst = stunned N rounds; Nstnp = stunned and unable to parry N rounds; Nnp = no parry N rounds; down:N = knocked down N rounds; out:<dur> = incapacitated; maim = permanently maimed.",
  damage: "+NH = N hits; NdMH = roll NdM hits; Nbl = bleed N/round; (-N) / (-N):* = penalty (ongoing); crit:<type>:<sev> = roll on that critical table; self = applies to you; ally = blow hits closest ally."
});

export const SPELL_FAILURE_EFFECTS_KEY = _deepFreeze({
  key: "recast = begin casting again; losespell = lose the spell; losepp:N|half|all|double = power-point loss; noeffect = spell has no effect; delay:N = casting delayed N rounds.",
  states: "Nst = stunned N rounds; +NH = N hits; NdMH = roll NdM hits; ko:<dur> = unconscious/unable to act; coma:<dur> = coma; nocast:<dur> = lose all spell casting; paralyze:<part> = paralyzed; crit:<type>:<sev> = roll on that critical table.",
  durations: "Durations: bare N = rounds, else N<unit> (h/d/w/mo/min) or dice (d10mo). (-N):<dur> = penalty for that duration. Dice-valued stuns (e.g. 'stunned 2d10 rounds') are kept in the narrative text.",
  none: "\"-\" = no mechanical effect beyond the text (often death)."
});
