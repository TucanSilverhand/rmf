/**
 * RMF System - Character actor DataModel (FoundryVTT v13.341)
 *
 * Replaces the `template.json:Actor.character` entry. Lives in
 * `actor.system` once `CONFIG.Actor.dataModels.character = CharacterData`
 * is set during `init`.
 *
 * Mirrors the shape that was previously declared in template.json so
 * existing worlds load without any data migration.
 *
 * Reference: Documentation/system-ars/02_Data_Models_y_Schema.md
 */

import { STAT_KEYS_FULL, STAT_FULL_TO_SHORT, RMF_CONSTANTS } from "../utils/constants.mjs";
import { resolveSpecialRole } from "./_identity.mjs";

const fields = foundry.data.fields;

/**
 * Helper: build a SchemaField that mirrors a single chStats entry.
 * Persists temp/pot/basic/race/spec/total so existing worlds load
 * unchanged. `basic`, `total`, and `bonus` are recomputed in
 * prepareDerivedData() — they survive in the DB only as snapshots.
 */
function statBlockField() {
  const num = (initial = 0) =>
    new fields.NumberField({ required: true, nullable: false, integer: true, initial });
  return new fields.SchemaField({
    temp:  num(RMF_CONSTANTS.DEFAULT_STAT),
    pot:   num(RMF_CONSTANTS.DEFAULT_STAT),
    basic: num(0),
    race:  num(0),
    spec:  num(0),
    total: num(0)
  });
}

export class CharacterData extends foundry.abstract.TypeDataModel {

  static defineSchema() {
    const num = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, integer: true, initial, ...opts });
    const str = (initial = "") =>
      new fields.StringField({ required: true, nullable: false, blank: true, initial });

    // Background block — 8 short strings + 1 HTML description.
    const chBackground = new fields.SchemaField({
      chNacionality: str(),
      chHome:        str(),
      chDeity:       str(),
      chPatron:      str(),
      chParents:     str(),
      chSpouse:      str(),
      chChildren:    str(),
      chOther:       str(),
      chDescription: new fields.HTMLField({ required: true, nullable: false, initial: "" })
    });

    // Build the 10 chStats sub-schemas in the canonical order so the
    // serialized JSON matches the legacy template.json layout.
    const chStatsEntries = {};
    for (const key of STAT_KEYS_FULL) chStatsEntries[key] = statBlockField();
    const chStats = new fields.SchemaField(chStatsEntries);

    const derivedStats = new fields.SchemaField({
      hitPoints: new fields.SchemaField({
        base:           num(RMF_CONSTANTS.HP_BASE),
        constitution:   num(0),
        selfDiscipline: num(0),
        max:            num(RMF_CONSTANTS.HP_BASE, { min: 0 }),
        value:          num(RMF_CONSTANTS.HP_BASE, { min: 0 })
      }),
      powerPoints: new fields.SchemaField({
        empathy:   num(0),
        intuition: num(0),
        presence:  num(0),
        max:       num(0, { min: 0 }),
        value:     num(0, { min: 0 })
      }),
      resistances: new fields.SchemaField({
        essence:    num(0),
        channeling: num(0),
        mentalism:  num(0),
        poison:     num(0),
        disease:    num(0)
      })
    });

    // Manual log of stat-gain rolls / package boosts (level 0+): each row
    // records the characteristic and its value before/after the gain. Purely
    // a record — it does not auto-mutate the stat (adjust temp/pot manually).
    const statGainLog = new fields.ArrayField(
      new fields.SchemaField({
        level:    num(0, { min: 0 }),
        stat:     str(),
        previous: num(0),
        final:    num(0)
      }),
      { required: true, nullable: false, initial: [] }
    );

    return {
      chLevel:      num(1, { min: 0, max: 99 }),
      chProfession: str(),
      chRace:       str(),
      chRealm:      str(),
      chExperience: num(0, { min: 0 }),
      chBackground,
      chStats,
      derivedStats,
      statGainLog
    };
  }

  /* ───────────────────────── Derivation ───────────────────────── */

  /**
   * Recalculate stat bonuses, derived attributes, and apply skill-based
   * overrides. Called by Foundry after the schema validates and after
   * embedded items have been prepared.
   *
   * Items (categories then skills) are derived from `this.parent`
   * because the actor owns them; the actor wraps this method to
   * orchestrate the order.
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    this.#calculateStatBonuses();
    this.#calculateSecondaryAttributes();
    // Skill-based overrides (Body Development / Power Point Development)
    // are applied by the parent actor after item derivation runs.
  }

  /**
   * Convert the temp value of every stat block into the canonical
   * RoleMaster basic bonus and recompute `total`/`bonus`. Adds two
   * UI-only flags (hasModifiers, totalModifier) that don't need
   * persisting.
   *
   * @private
   */
  #calculateStatBonuses() {
    // Racial stat modifiers (T-1.1) come from the embedded race item using
    // short keys (ag/co/…) and add to the stat BONUS. Mirrors the race
    // resistance application in #calculateSecondaryAttributes so a race
    // actually shifts the character's stats. When no race is present, the
    // stored `stat.race` value is kept untouched.
    const raceStats = this.parent?.itemTypes?.race?.[0]?.system?.stats || null;
    for (const key of STAT_KEYS_FULL) {
      const stat = this.chStats[key];
      if (!stat) continue;
      if (raceStats) {
        stat.race = Number(raceStats[STAT_FULL_TO_SHORT[key]] ?? 0) || 0;
      }
      stat.basic = CharacterData.#bonusFromStatValue(Number(stat.temp) || 0);
      stat.total = stat.basic + (stat.race || 0) + (stat.spec || 0);
      stat.bonus = stat.total;
      stat.hasModifiers = (stat.race !== 0) || (stat.spec !== 0);
      stat.totalModifier = (stat.race || 0) + (stat.spec || 0);
    }
  }

  /**
   * Compute HP, PP, resistances, defensiveBonus from the stat totals.
   * `value` is reclamped to [0, max] so a previous damage state is
   * preserved across a stat change. Race resistance modifiers are
   * applied on top.
   *
   * @private
   */
  #calculateSecondaryAttributes() {
    const stats = this.chStats;
    const ds = this.derivedStats;

    const previousHPValue = Number(ds.hitPoints?.value);
    const previousPPValue = Number(ds.powerPoints?.value);

    // Hit points
    const HP_BASE = RMF_CONSTANTS.HP_BASE;
    const coBonus = stats.chConstitution?.total || 0;
    const sdBonus = stats.chSelfDiscipline?.total || 0;
    const sdHalf  = Math.floor(sdBonus / 2);
    const maxHP = HP_BASE + coBonus + sdHalf;
    ds.hitPoints.base = HP_BASE;
    ds.hitPoints.constitution = coBonus;
    ds.hitPoints.selfDiscipline = sdHalf;
    ds.hitPoints.max = maxHP;
    ds.hitPoints.value = Number.isFinite(previousHPValue)
      ? Math.max(0, Math.min(previousHPValue, maxHP))
      : maxHP;

    // Power points
    const emBonus = stats.chEmpathy?.total   || 0;
    const inBonus = stats.chIntuition?.total || 0;
    const prBonus = stats.chPresence?.total  || 0;
    const maxPP = emBonus + inBonus + prBonus;
    ds.powerPoints.empathy   = emBonus;
    ds.powerPoints.intuition = inBonus;
    ds.powerPoints.presence  = prBonus;
    ds.powerPoints.max = maxPP;
    ds.powerPoints.value = Number.isFinite(previousPPValue)
      ? Math.max(0, Math.min(previousPPValue, maxPP))
      : maxPP;

    // Resistances (stat × multiplier; race adds on top)
    const RM = RMF_CONSTANTS.RESISTANCE_MULTIPLIER;
    ds.resistances.essence    = Math.floor(emBonus * RM);
    ds.resistances.channeling = Math.floor(inBonus * RM);
    ds.resistances.mentalism  = Math.floor(prBonus * RM);
    ds.resistances.poison     = Math.floor(coBonus * RM);
    ds.resistances.disease    = Math.floor(coBonus * RM);

    try {
      const raceItem = this.parent?.itemTypes?.race?.[0];
      const r = raceItem?.system?.resistances || {};
      ds.resistances.essence    += Number(r.ess  ?? 0) || 0;
      ds.resistances.channeling += Number(r.chan ?? 0) || 0;
      ds.resistances.mentalism  += Number(r.ment ?? 0) || 0;
      ds.resistances.poison     += Number(r.pois ?? 0) || 0;
      ds.resistances.disease    += Number(r.dis  ?? 0) || 0;
    } catch (err) {
      console.warn(`RMF | Failed to apply race resistance modifiers for "${this.parent?.name}":`, err);
    }

    // Defensive bonus (Quickness × multiplier − armor penalty).
    const quBonus = stats.chQuickness?.total || 0;
    ds.armorPenalty   = 0;
    ds.defensiveBonus = (quBonus * RMF_CONSTANTS.DEFENSIVE_MULTIPLIER) - ds.armorPenalty;
  }

  /* ───────────────────────── Helpers ───────────────────────── */

  /**
   * Override max for hitPoints/powerPoints with the totalBonus of the
   * Body Development / Power Point Development skill items. Reclamps
   * `value` to [0, max]. Idempotent — safe to call multiple times.
   *
   * Called from RMFActor.prepareDerivedData() AFTER item derivation,
   * because the skills' totalBonus must already be computed.
   */
  applySkillBasedDerivedStats() {
    const ds = this.derivedStats;
    if (!ds) return;

    // Resolve the HP/PP-driving skills by their internal specialRole tag
    // (locale-independent), falling back to the English name so an
    // un-migrated world still computes the right maxima. See _identity.mjs.
    const skills = this.parent?.itemTypes?.skill ?? [];
    const bonusOfRole = (role) => {
      const sk = skills.find(s => resolveSpecialRole(s.system?.specialRole, s.name) === role);
      return Number(sk?.system?.totalBonus ?? 0) || 0;
    };

    if (ds.hitPoints) {
      const max = bonusOfRole("bodyDevelopment");
      const prev = Number(ds.hitPoints.value);
      ds.hitPoints.max = max;
      ds.hitPoints.value = Number.isFinite(prev)
        ? Math.max(0, Math.min(prev, max))
        : Math.max(0, max);
    }
    if (ds.powerPoints) {
      const max = bonusOfRole("powerPointDevelopment");
      const prev = Number(ds.powerPoints.value);
      ds.powerPoints.max = max;
      ds.powerPoints.value = Number.isFinite(prev)
        ? Math.max(0, Math.min(prev, max))
        : Math.max(0, max);
    }
  }

  /**
   * RoleMaster stat-value → basic-bonus table. Pure function; replaces
   * the `_calculateBonus` private method that lived on RMFActor.
   *
   * @param {number} v - raw stat value (1..101+)
   * @returns {number} bonus (-10..14)
   */
  static #bonusFromStatValue(v) {
    if (v >= 102) return 14;
    if (v === 101) return 12;
    if (v === 100) return 10;
    if (v >= 98)  return 9;
    if (v >= 96)  return 8;
    if (v >= 94)  return 7;
    if (v >= 92)  return 6;
    if (v >= 90)  return 5;
    if (v >= 85)  return 4;
    if (v >= 80)  return 3;
    if (v >= 75)  return 2;
    if (v >= 70)  return 1;
    if (v >= 31)  return 0;
    if (v >= 26)  return -1;
    if (v >= 21)  return -2;
    if (v >= 16)  return -3;
    if (v >= 11)  return -4;
    if (v === 10) return -5;
    if (v >= 8)   return -6;
    if (v >= 6)   return -7;
    if (v >= 4)   return -8;
    if (v >= 2)   return -9;
    return -10;
  }
}
