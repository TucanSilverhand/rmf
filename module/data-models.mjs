/**
 * RMF System Data Models
 *
 * Custom Actor and Item document classes that extend FoundryVTT's base
 * classes with RoleMaster-specific functionality and automatic calculations.
 *
 * @fileoverview Extended document classes for RMF system
 * @version 1.0.0
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 */

import {
  computeCategoryRankBonus,
  computeSkillRankBonus,
  normalizeCategoryProgression,
  normalizeSkillProgression,
  normalizeSkillClassification
} from "./utils/rank-bonus.mjs";

/**
 * Parse a race progression string of the form "zero/tier1/tier2/tier3/tier4"
 * (e.g. "0/6/4/2/1") into a structured object. Missing positions default to 0.
 * Empty / non-string inputs return a zeroed table so callers don't need guards.
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

/**
 * Extended Actor class for RoleMaster Fantasy characters
 * 
 * Handles automatic calculation of RoleMaster statistics, derived attributes,
 * and provides methods for dice rolling and damage application.
 * 
 * @extends Actor
 * @class RMFActor
 */
export class RMFActor extends Actor {
  /**
   * Prepare base data for the actor
   *
   * Establishes default in-memory structures (e.g. missing chStats blocks
   * after a model change) without persisting them. Persisting from
   * prepare* hooks is unsafe — the actual update happens the next time
   * the user edits the actor and triggers a normal write.
   *
   * @override
   * @memberof RMFActor
   */
  prepareBaseData() {
    super.prepareBaseData();
    if (this.type === "character") {
      this._ensureCharacterDefaults();
    }
  }

  /**
   * Prepare derived data for the actor
   *
   * Calculates stat bonuses, secondary attributes, and other derived
   * values based on the character's primary statistics.
   *
   * @override
   * @memberof RMFActor
   */
  prepareDerivedData() {
    super.prepareDerivedData();

    if (this.type === "character") {
      this._calculateStatBonuses();
      this._calculateSecondaryAttributes();

      // Foundry prepares embedded items BEFORE the actor's prepareDerivedData,
      // so when an item runs its derivation the actor's chStats[*].total is
      // still zero. Re-run the category items first (they depend on actor
      // stats) and then the skill items (they depend on the category
      // totalBonus computed in the previous pass).
      for (const item of this.items) {
        if (item.type === "category") item.prepareDerivedData?.();
      }
      for (const item of this.items) {
        if (item.type === "skill") item.prepareDerivedData?.();
      }
      // Skills are now up-to-date — override HP/PP max from the relevant skills.
      this._applySkillBasedDerivedStats();
    }
  }

  /**
   * Override derivedStats.hitPoints.max and derivedStats.powerPoints.max
   * with the totalBonus of the "Body Development" and "Power Point Development"
   * skills respectively. Falls back to 0 when the skill is missing.
   * `value` is reclamped to [0, max] so it never exceeds the new max.
   *
   * @private
   * @memberof RMFActor
   */
  _applySkillBasedDerivedStats() {
    const ds = this.system?.derivedStats;
    if (!ds) return;

    const findSkill = (name) => this.items.find(i => i.type === "skill" && i.name === name);
    const skillTotal = (skill) => Number(skill?.system?.totalBonus ?? 0) || 0;

    if (ds.hitPoints) {
      const max = skillTotal(findSkill("Body Development"));
      const prev = Number(ds.hitPoints.value);
      ds.hitPoints.max = max;
      ds.hitPoints.value = Number.isFinite(prev)
        ? Math.max(0, Math.min(prev, max))
        : Math.max(0, max);
    }

    if (ds.powerPoints) {
      const max = skillTotal(findSkill("Power Point Development"));
      const prev = Number(ds.powerPoints.value);
      ds.powerPoints.max = max;
      ds.powerPoints.value = Number.isFinite(prev)
        ? Math.max(0, Math.min(prev, max))
        : Math.max(0, max);
    }
  }

  /**
   * Pre-process updates to automatically recalculate dependent values
   * 
   * When character statistics are updated, this method automatically
   * recalculates bonuses and totals according to RoleMaster rules.
   * 
   * @override
   * @async
   * @memberof RMFActor
   * @param {Object} changed - The changes being applied
   * @param {Object} options - Update options
   * @param {User} user - The user making the changes
   */
  async _preUpdate(changed, options, user) {
    await super._preUpdate(changed, options, user);
    
    // console.log("RMF | _preUpdate called with:", changed);
    
    // Auto-recalculate bonuses when stats are updated
    if (changed.system?.chStats) {
      // console.log("RMF | Processing stats changes:", changed.system.chStats);
      
      // Recalculate bonuses for each changed stat
      for (const statKey in changed.system.chStats) {
        const statChange = changed.system.chStats[statKey];

        // When temp value changes, recalculate basic, total and bonus
        if (statChange && 'temp' in statChange) {
          const currentStat = this.system.chStats[statKey] || {};
          const newTemp = Number(statChange.temp);

          // Reject non-finite inputs (empty string, "abc", NaN) — fall back
          // to the previous persisted value so we never write NaN to the DB.
          if (!Number.isFinite(newTemp)) {
            statChange.temp = Number(currentStat.temp) || 0;
            continue;
          }

          // Calculate new basic bonus using RoleMaster table
          const newBasic = this._calculateBonus(newTemp);

          // Preserve current race and spec modifiers (coerce to finite numbers)
          const rawRace = statChange.race !== undefined ? statChange.race : currentStat.race;
          const rawSpec = statChange.spec !== undefined ? statChange.spec : currentStat.spec;
          const race = Number.isFinite(Number(rawRace)) ? Number(rawRace) : 0;
          const spec = Number.isFinite(Number(rawSpec)) ? Number(rawSpec) : 0;

          // Calculate new total
          const newTotal = newBasic + race + spec;

          // Apply calculated changes to the update object
          statChange.temp = newTemp;
          statChange.basic = newBasic;
          statChange.total = newTotal;
          statChange.bonus = newTotal;
        }
      }
    }
  }

  /**
   * Ensure the in-memory character system structure is complete.
   *
   * Fills in any missing chStats / derivedStats blocks so calculations
   * can run without guards. Also performs a one-shot legacy rename of
   * derivedStats `current/total` (pre-v1.0 contract) to Foundry's
   * standard `value/max` token-bar contract.
   *
   * Runs every prepareBaseData; it does not write to the source.
   *
   * @private
   * @memberof RMFActor
   */
  _ensureCharacterDefaults() {
    const system = this.system;
    const defaultStat = () => ({ temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 });

    if (!system.chStats || typeof system.chStats !== "object") {
      system.chStats = {};
    }
    const requiredStats = [
      "chAgility", "chConstitution", "chMemory", "chReasoning",
      "chSelfDiscipline", "chEmpathy", "chIntuition", "chPresence",
      "chQuickness", "chStrength"
    ];
    for (const statKey of requiredStats) {
      if (!system.chStats[statKey] || typeof system.chStats[statKey] !== "object") {
        system.chStats[statKey] = defaultStat();
      }
    }

    if (!system.derivedStats || typeof system.derivedStats !== "object") {
      system.derivedStats = {};
    }
    const ds = system.derivedStats;

    // Legacy current/total → value/max rename (in-memory only).
    if (ds.hitPoints) {
      if (ds.hitPoints.value === undefined && ds.hitPoints.current !== undefined) {
        ds.hitPoints.value = ds.hitPoints.current;
      }
      if (ds.hitPoints.max === undefined && ds.hitPoints.total !== undefined) {
        ds.hitPoints.max = ds.hitPoints.total;
      }
    }
    if (ds.powerPoints) {
      if (ds.powerPoints.value === undefined && ds.powerPoints.current !== undefined) {
        ds.powerPoints.value = ds.powerPoints.current;
      }
      if (ds.powerPoints.max === undefined && ds.powerPoints.total !== undefined) {
        ds.powerPoints.max = ds.powerPoints.total;
      }
    }

    if (!ds.hitPoints) {
      ds.hitPoints = { base: 50, constitution: 0, selfDiscipline: 0, max: 50, value: 50 };
    }
    if (!ds.powerPoints) {
      ds.powerPoints = { empathy: 0, intuition: 0, presence: 0, max: 0, value: 0 };
    }
    if (!ds.resistances) {
      ds.resistances = { essence: 0, channeling: 0, mentalism: 0, poison: 0, disease: 0 };
    }
  }

  /**
   * Calculate stat bonuses using RoleMaster bonus table
   * 
   * Processes each character statistic and calculates the basic bonus
   * according to the official RoleMaster rules, then adds racial and
   * special modifiers to get the final total.
   * 
   * @private
   * @memberof RMFActor
   */
  _calculateStatBonuses() {
    const stats = this.system.chStats;
    
    // Verify stats exist before processing
    if (!stats) {
      return; // Migration should have handled this
    }
    
    for (const statKey in stats) {
      if (stats.hasOwnProperty(statKey)) {
        const stat = stats[statKey];
        if (stat && typeof stat === 'object' && 'temp' in stat) {
          stat.basic = this._calculateBonus(stat.temp);
          stat.race = stat.race || 0;
          stat.spec = stat.spec || 0;
          stat.total = stat.basic + stat.race + stat.spec;
          
          // Final bonus is the same as total in RoleMaster
          stat.bonus = stat.total;
          
          // Add modifier information for UI
          stat.hasModifiers = stat.race !== 0 || stat.spec !== 0;
          stat.totalModifier = stat.race + stat.spec;
        }
      }
    }
  }

  /**
   * Calculate secondary attributes derived from primary stats
   * 
   * Computes hit points, power points, and resistances based on
   * the character's primary statistics according to RoleMaster rules.
   * 
   * @private
   * @memberof RMFActor
   */
  _calculateSecondaryAttributes() {
    const stats = this.system.chStats;
    const system = this.system;

    if (!stats) return;

    // _ensureCharacterDefaults guarantees derivedStats exists.
    const previousHPValue = Number(system.derivedStats.hitPoints?.value);
    const previousPPValue = Number(system.derivedStats.powerPoints?.value);

    // Calculate hit points using RoleMaster formula
    if (stats.chConstitution && stats.chSelfDiscipline) {
      const coBonus = stats.chConstitution.total || 0;
      const sdBonus = stats.chSelfDiscipline.total || 0;
      const maxHP = 50 + coBonus + Math.floor(sdBonus / 2);
      const valueHP = Number.isFinite(previousHPValue)
        ? Math.max(0, Math.min(previousHPValue, maxHP))
        : maxHP;
      system.derivedStats.hitPoints = {
        base: 50,
        constitution: coBonus,
        selfDiscipline: Math.floor(sdBonus / 2),
        max: maxHP,
        value: valueHP
      };
    } else {
      const defaultHP = 50;
      const valueHP = Number.isFinite(previousHPValue)
        ? Math.max(0, Math.min(previousHPValue, defaultHP))
        : defaultHP;
      system.derivedStats.hitPoints = {
        base: defaultHP,
        constitution: 0,
        selfDiscipline: 0,
        max: defaultHP,
        value: valueHP
      };
    }

    // Calculate power points for magic use
    if (stats.chEmpathy && stats.chIntuition && stats.chPresence) {
      const emBonus = stats.chEmpathy.total || 0;
      const inBonus = stats.chIntuition.total || 0;
      const prBonus = stats.chPresence.total || 0;
      const maxPP = emBonus + inBonus + prBonus;
      const valuePP = Number.isFinite(previousPPValue)
        ? Math.max(0, Math.min(previousPPValue, maxPP))
        : maxPP;

      system.derivedStats.powerPoints = {
        empathy: emBonus,
        intuition: inBonus,
        presence: prBonus,
        max: maxPP,
        value: valuePP
      };
    } else {
      system.derivedStats.powerPoints = {
        empathy: 0,
        intuition: 0,
        presence: 0,
        max: 0,
        value: 0
      };
    }

    // Calculate basic resistances
    if (stats.chSelfDiscipline && stats.chIntuition) {
      const coBonus = stats.chConstitution.total || 0;
      const sdBonus = stats.chSelfDiscipline.total || 0;
      const inBonus = stats.chIntuition.total || 0;
      const esBonus = stats.chEmpathy.total || 0;
      const prBonus = stats.chPresence.total || 0;
      
      system.derivedStats.resistances = {
        essence: Math.floor(esBonus * 3),
        channeling: Math.floor(inBonus * 3),
        mentalism: Math.floor(prBonus * 3),
        poison: Math.floor(coBonus * 3),
        disease: Math.floor(coBonus * 3),
      };
    } else {
      // Default values if stats are not available
      system.derivedStats.resistances = {
        essence: 0,
        channeling: 0,
        mentalism: 0,
        poison: 0,
        disease: 0
      };
    }

    // Armor Penalty and Defensive Bonus
    // For now, armor penalty is 0; Defensive Bonus = (Quickness total * 3) - Armor Penalty
    const quBonus = stats.chQuickness?.total || 0;
    const armorPenalty = 0;
    system.derivedStats.armorPenalty = armorPenalty;
    system.derivedStats.defensiveBonus = (quBonus * 3) - armorPenalty;

    // Apply race item resistance modifiers (if a race is assigned)
    try {
      const raceItem = this.items.find(i => i.type === 'race');
      const r = raceItem?.system?.resistances || {};
      const addEss = Number(r.ess ?? 0) || 0;
      const addChan = Number(r.chan ?? 0) || 0;
      const addMent = Number(r.ment ?? 0) || 0;
      const addPois = Number(r.pois ?? 0) || 0;
      const addDis = Number(r.dis ?? 0) || 0;
      system.derivedStats.resistances.essence += addEss;
      system.derivedStats.resistances.channeling += addChan;
      system.derivedStats.resistances.mentalism += addMent;
      system.derivedStats.resistances.poison += addPois;
      system.derivedStats.resistances.disease += addDis;
    } catch (err) {
      console.warn(`RMF | Failed to apply race resistance modifiers for "${this.name}":`, err);
    }
  }

  /**
   * Calculate bonus based on stat value using RoleMaster table
   * 
   * Implements the official RoleMaster stat bonus table that converts
   * raw stat values (1-101+) into modifier bonuses (-10 to +14).
   * 
   * @private
   * @memberof RMFActor
   * @param {number} statValue - The raw stat value (1-101+)
   * @returns {number} The calculated bonus modifier
   */
  _calculateBonus(statValue) {
    if (statValue >= 102) return 14;
    if (statValue === 101) return 12;
    if (statValue === 100) return 10;
    if (statValue >= 98) return 9;
    if (statValue >= 96) return 8;
    if (statValue >= 94) return 7;
    if (statValue >= 92) return 6;
    if (statValue >= 90) return 5;
    if (statValue >= 85) return 4;
    if (statValue >= 80) return 3;
    if (statValue >= 75) return 2;
    if (statValue >= 70) return 1;
    if (statValue >= 31) return 0;
    if (statValue >= 26) return -1;
    if (statValue >= 21) return -2;
    if (statValue >= 16) return -3;
    if (statValue >= 11) return -4;
    if (statValue === 10) return -5;
    if (statValue >= 8) return -6;
    if (statValue >= 6) return -7;
    if (statValue >= 4) return -8;
    if (statValue >= 2) return -9;
    return -10;
  }

  /**
   * Prepare roll data for dice formulas
   * 
   * Creates a data object that can be used in Roll formulas, providing
   * easy access to stat bonuses and derived attributes.
   * 
   * @override
   * @memberof RMFActor
   * @returns {Object} Roll data object with stats and derived values
   */
  getRollData() {
    const data = super.getRollData();
    
    // Add calculated bonuses to roll data for character actors
    if (this.type === "character") {
      const rollStats = {};
      const stats = this.system.chStats;
      
      // Verify stats exist before processing
      if (stats) {
        for (const statKey in stats) {
          if (stats.hasOwnProperty(statKey)) {
            const stat = stats[statKey];
            if (stat && typeof stat === 'object') {
              // Create easy access names for formulas
              const cleanKey = statKey.replace('ch', '').toLowerCase();
              rollStats[cleanKey] = stat.total || 0;
              rollStats[statKey] = stat.total || 0;
            }
          }
        }
      }
      
      data.stats = rollStats;

      // Add derived attributes for roll formulas
      if (this.system.derivedStats) {
        data.hp = this.system.derivedStats.hitPoints?.max || 0;
        data.pp = this.system.derivedStats.powerPoints?.max || 0;
      }
    }

    return data;
  }

  /**
   * Perform a statistical roll for the character
   * 
   * Rolls dice for a specific character statistic, applying the
   * appropriate bonus and displaying results in chat.
   * 
   * @async
   * @memberof RMFActor
   * @param {string} statKey - The stat to roll (e.g., 'chAgility')
   * @param {Object} [options={}] - Roll configuration options
   * @param {string} [options.formula] - Custom formula override
   * @param {boolean} [options.chatMessage=true] - Whether to post to chat
   * @returns {Promise<Roll|null>} The roll result or null if invalid
   */
  async rollStat(statKey, options = {}) {
    const stat = this.system.chStats?.[statKey];
    if (!stat) {
      ui.notifications.warn(game.i18n.format("RMF.Messages.StatNotFound", { stat: statKey }));
      return null;
    }

    const rollData = this.getRollData();
    const bonus = stat.total || 0;
    const formula = options.formula || "1d100 + @bonus";
    
    const roll = new Roll(formula, { 
      ...rollData, 
      bonus: bonus,
      stat: bonus 
    });
    
    await roll.evaluate();

    // Create chat message if requested
    if (options.chatMessage !== false) {
      const statName = game.i18n.localize(`RMF.Stats.${statKey}`) || statKey;

      ChatMessage.implementation.create({
        speaker: ChatMessage.implementation.getSpeaker({ actor: this }),
        content: await foundry.applications.handlebars.renderTemplate("systems/rmf/templates/chat/stat-roll.hbs", {
          actor: this,
          statName: statName,
          roll: roll,
          bonus: bonus,
          formula: roll.formula,
          baseRoll: Number(roll.dice?.[0]?.total ?? roll.total ?? 0),
          bonusOperator: bonus < 0 ? "-" : "+",
          bonusAbs: Math.abs(Number(bonus) || 0),
          hasBonus: Math.abs(Number(bonus) || 0) !== 0
        }),
        rolls: [roll]
      });
    }

    return roll;
  }

  /**
   * Apply damage to the character
   * 
   * Reduces the character's current hit points by the specified amount
   * and optionally displays a chat message about the damage taken.
   * 
   * @async
   * @memberof RMFActor
   * @param {number} amount - Amount of damage to apply
   * @param {Object} [options={}] - Damage application options
   * @param {boolean} [options.chatMessage=true] - Whether to post to chat
   */
  async applyDamage(amount, options = {}) {
    const hp = this.system.derivedStats?.hitPoints;
    if (!hp) return;

    const currentHP = Number(hp.value ?? hp.max ?? 0) || 0;
    const newValue = Math.max(0, currentHP - amount);

    await this.update({
      "system.derivedStats.hitPoints.value": newValue
    });

    if (options.chatMessage !== false) {
      ChatMessage.implementation.create({
        speaker: ChatMessage.implementation.getSpeaker({ actor: this }),
        content: game.i18n.format("RMF.Messages.DamageApplied", {
          name: this.name,
          damage: amount,
          remaining: newValue
        })
      });
    }
  }
}

/**
 * Extended Item class for RoleMaster Fantasy items
 * 
 * Handles equipment and race items. Provides automatic calculations and
 * specialized functionality for supported item types.
 * 
 * @extends Item
 * @class RMFItem
 */
export class RMFItem extends Item {
  /**
   * Prepare derived data for the item
   * 
   * Calculates type-specific derived properties and metadata
   * based on the item's type and base properties.
   * 
   * @override
   * @memberof RMFItem
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    
    // Type-specific preparation for remaining item categories
    switch (this.type) {
      case "race":
        this._prepareRaceData();
        break;
      case "equipment":
        this._prepareEquipmentData();
        break;
      case "category":
        this._prepareCategoryData();
        break;
      case "skill":
        this._prepareSkillData();
        break;
      case "realm":
        this._prepareRealmData();
        break;
    }
  }

  /**
   * Prepare race-specific derived data
   * 
   * Ensures race items have complete stat and resistance structures
   * and calculates helpful metadata for the UI.
   * 
   * @private
   * @memberof RMFItem
   */
    /**
   * Prepare race-specific derived data and metadata
   * 
   * Ensures complete stat and resistance structures with default values,
   * calculates UI display flags, and validates race data integrity.
   * 
   * @private
   * @memberof RMFItem
   */
  _prepareRaceData() {
    const system = this.system;

    // Ensure complete stat structure with default values
    if (!system.stats) {
      system.stats = {
        ag: 0, co: 0, me: 0, re: 0, sd: 0,
        em: 0, in: 0, pr: 0, qu: 0, st: 0
      };
    }

    // Ensure complete resistance structure with default values
    if (!system.resistances) {
      system.resistances = {
        ess: 0, chan: 0, ment: 0, pois: 0, dis: 0
      };
    }

    // Ensure background options field exists
    if (system.backgroundOptions === undefined) {
      system.backgroundOptions = 0;
    }

    // Race progression strings: format "zero/tier1/tier2/tier3/tier4".
    // Storage stays as the user-facing string; a parsed table object is exposed
    // as a derived field for programmatic consumption.
    const PROGRESSION_FIELDS = ["bodyDevelopment", "ppChanneling", "ppEssence", "ppMentalism"];
    for (const field of PROGRESSION_FIELDS) {
      if (typeof system[field] !== "string") system[field] = "";
      system[`${field}Table`] = parseRaceProgression(system[field]);
    }

    if (typeof system.fromBook !== "string") system.fromBook = "basic";

    // Hobby ranks: free ranks granted by the race for any skill/category at creation
    if (typeof system.hobbyRanks !== "number") {
      const num = Number(system.hobbyRanks);
      system.hobbyRanks = Number.isFinite(num) ? num : 0;
    }

    // Racial ranks: predetermined free ranks granted by the race
    // for specific categories and skills (by name).
    if (!system.racialRanks || typeof system.racialRanks !== "object") {
      system.racialRanks = { categories: [], skills: [] };
    }
    system.racialRanks.categories = Array.isArray(system.racialRanks.categories)
      ? system.racialRanks.categories
          .filter(e => e && typeof e === "object" && typeof e.name === "string")
          .map(e => ({ name: e.name, ranks: Number(e.ranks) || 0 }))
      : [];
    system.racialRanks.skills = Array.isArray(system.racialRanks.skills)
      ? system.racialRanks.skills
          .filter(e => e && typeof e === "object" && typeof e.name === "string")
          .map(e => ({ name: e.name, ranks: Number(e.ranks) || 0 }))
      : [];

    // Convenience lookup maps so other parts of the system can resolve a
    // category/skill name to its racial rank value in O(1).
    system.racialRanksByCategory = Object.freeze(
      Object.fromEntries(system.racialRanks.categories.map(e => [e.name, e.ranks]))
    );
    system.racialRanksBySkill = Object.freeze(
      Object.fromEntries(system.racialRanks.skills.map(e => [e.name, e.ranks]))
    );

    // Calculate metadata for UI display
    system.hasStatBonuses = Object.values(system.stats).some(val => val !== 0);
    system.hasResistances = Object.values(system.resistances).some(val => val !== 0);
    system.totalStatBonus = Object.values(system.stats).reduce((sum, val) => sum + val, 0);
    system.totalRacialCategoryRanks = system.racialRanks.categories.reduce((sum, e) => sum + (Number(e.ranks) || 0), 0);
    system.totalRacialSkillRanks = system.racialRanks.skills.reduce((sum, e) => sum + (Number(e.ranks) || 0), 0);
  }

  

  /**
   * Prepare equipment-specific derived data
   * 
   * Calculates encumbrance values and determines item
   * rarity based on cost for UI display.
   * 
   * @private
   * @memberof RMFItem
   */
  _prepareEquipmentData() {
    const system = this.system;

    // Normalize legacy "price" field into current "cost" field.
    if (system.cost === undefined && system.price !== undefined) {
      const legacyCost = Number(system.price);
      system.cost = Number.isFinite(legacyCost) ? legacyCost : 0;
    }
    
    // Calculate total encumbrance including quantity
    system.encumbrance = (system.weight || 0) * (system.quantity || 1);
    
    // Auto-determine item rarity based on cost
    if (system.cost) {
      system.rarity = system.cost >= 1000 ? "legendary" :
                     system.cost >= 500 ? "rare" :
                     system.cost >= 100 ? "uncommon" : "common";
    }
  }

  /**
   * Prepare category-specific derived/default data
   * Ensures category items have a complete system structure
   */
  _prepareCategoryData() {
    const system = this.system || (this.system = {});
    if (!system.dpCost || typeof system.dpCost !== 'object') system.dpCost = { price1: 0, price2: 0, price3: 0 };
    if (!system.boughtByLevel || typeof system.boughtByLevel !== 'object') system.boughtByLevel = {};
    system.categoryRankBonusProgression = normalizeCategoryProgression(system.categoryRankBonusProgression);
    if (typeof system.ranks !== 'number') {
      system.ranks = typeof system.rank === 'number' ? system.rank : 0;
    }
    if (typeof system.freeRanks !== 'number') system.freeRanks = 0;
    if (Reflect.has(system, 'rank')) delete system.rank;
    if (!system.statBonus || typeof system.statBonus !== 'object') system.statBonus = { stat1: 'ag', stat2: 'co', stat3: 'sd' };
    if (typeof system.profBonus !== 'number') system.profBonus = 0;
    if (typeof system.spec1Bonus !== 'number') system.spec1Bonus = 0;
    if (typeof system.spec2Bonus !== 'number') system.spec2Bonus = 0;
    if (typeof system.fromBook !== 'string') system.fromBook = 'basic';
    if (typeof system.description !== 'string') system.description = '';
    const allowedGroups = new Set([
      'none',
      'Armor',
      'Artistic',
      'Athletic',
      'Awareness',
      'Body Development',
      'Combat Maneuvers',
      'Communications',
      'Craft',
      'Directed Spells',
      'Influence',
      'Lore',
      'Martial Arts',
      'Outdoor',
      'Power Awareness',
      'Power Point Development',
      'Science',
      'Self Control',
      'Subterfuge',
      'Technical',
      'Urban',
      'Weapon'
    ]);
    const rawGroup = typeof system.group === 'string' ? system.group.trim() : '';
    system.group = allowedGroups.has(rawGroup) ? rawGroup : 'none';

    // The "Power Point Development" category inherits its stat slots from the
    // realm item assigned to the parent actor. Empty slots in the realm map
    // through verbatim so they don't contribute to the stats sum.
    if (this.name === "Power Point Development") {
      const actor = this.parent;
      const realmItem = actor?.documentName === "Actor"
        ? actor.items.find(i => i.type === "realm")
        : null;
      const rb = realmItem?.system?.statBonus;
      if (rb && typeof rb === "object") {
        system.statBonus = {
          stat1: typeof rb.stat1 === "string" ? rb.stat1 : "",
          stat2: typeof rb.stat2 === "string" ? rb.stat2 : "",
          stat3: typeof rb.stat3 === "string" ? rb.stat3 : ""
        };
      }
    }

    // Calculate totalBonus for display in actor sheets.
    // Racial ranks are written into boughtByLevel.0 when the race is dropped on
    // the actor, so they're already counted in totalBoughtRanks below.
    const totalBoughtRanks = this._computeTotalBoughtRanks(system.boughtByLevel);
    const totalRanks = totalBoughtRanks + (system.freeRanks || 0);
    const totalRankBonus = this._computeRankBonus(totalRanks, system.categoryRankBonusProgression);
    const totalStatsBonus = this._computeSelectedStatSum(system.statBonus?.stat1, system.statBonus?.stat2, system.statBonus?.stat3);
    system.totalRanks = totalRanks;
    system.totalRankBonus = totalRankBonus;
    system.totalStatsBonus = totalStatsBonus;
    system.totalBonus = totalRankBonus + totalStatsBonus + (system.profBonus || 0) + (system.spec1Bonus || 0) + (system.spec2Bonus || 0);
  }

  /**
   * Compute total bought ranks from boughtByLevel object
   * @private
   */
  _computeTotalBoughtRanks(boughtByLevel) {
    if (!boughtByLevel || typeof boughtByLevel !== 'object') return 0;
    return Object.values(boughtByLevel).reduce((sum, val) => sum + (Number(val) || 0), 0);
  }

  /**
   * Compute the rank bonus for a category given its total ranks and progression.
   * Delegates to the shared rank-bonus helper (single source of truth).
   * @private
   */
  _computeRankBonus(totalRanks, progression) {
    return computeCategoryRankBonus(totalRanks, progression);
  }

  /**
   * Compute sum of selected stats from parent actor
   * @private
   */
  _computeSelectedStatSum(stat1, stat2, stat3) {
    const actor = this.parent;
    if (!actor || actor.documentName !== 'Actor') return 0;
    
    const stats = actor.system?.chStats;
    if (!stats) return 0;

    let sum = 0;
    for (const statKey of [stat1, stat2, stat3]) {
      if (!statKey || typeof statKey !== 'string') continue;
      const normalized = this._normalizeStatKey(statKey);
      const stat = stats[normalized];
      if (stat && typeof stat.total === 'number') {
        sum += stat.total;
      }
    }
    return sum;
  }

  /**
   * Normalize stat key (convert short codes to full keys)
   * @private
   */
  _normalizeStatKey(value) {
    if (!value || typeof value !== 'string') return '';
    if (value.startsWith('ch')) return value;
    const map = CONFIG.RMF?.statShortToFull || {};
    return map[value] || value;
  }

  /**
   * Prepare derived data for a skill item.
   *
   * Calculates totalRanks, rankBonus and totalBonus following the
   * skill-progression tables in module/utils/rank-bonus.mjs. When the
   * skill is embedded on an Actor and its system.category matches the
   * name of an embedded category item, that category's totalBonus is
   * added so the skill's totalBonus is the value that goes into rolls.
   *
   * `system.bonus` is exposed as an alias of `totalBonus` so the
   * existing roll handler in module/actions.mjs (#rollSkill) keeps
   * working unchanged.
   *
   * @private
   * @memberof RMFItem
   */
  _prepareSkillData() {
    const system = this.system || (this.system = {});

    if (!system.boughtByLevel || typeof system.boughtByLevel !== "object") system.boughtByLevel = {};
    {
      const raw = system.dpCost;
      const next = { price1: 0, price2: 0, price3: 0 };
      if (Array.isArray(raw)) {
        next.price1 = Number(raw[0]) || 0;
        next.price2 = Number(raw[1]) || 0;
        next.price3 = Number(raw[2]) || 0;
      } else if (raw && typeof raw === "object") {
        next.price1 = Number(raw.price1 ?? raw[0] ?? raw[1]) || 0;
        next.price2 = Number(raw.price2 ?? raw[1] ?? raw[2]) || 0;
        next.price3 = Number(raw.price3 ?? raw[2] ?? raw[3]) || 0;
      }
      system.dpCost = next;
    }
    if (typeof system.rank !== "number") system.rank = 0;
    if (typeof system.category !== "string") system.category = "";
    system.classification = normalizeSkillClassification(system.classification);
    if (typeof system.profBonus !== "number") system.profBonus = 0;
    if (typeof system.spec1Bonus !== "number") system.spec1Bonus = 0;
    if (typeof system.spec2Bonus !== "number") system.spec2Bonus = 0;
    if (typeof system.fromBook !== "string") system.fromBook = "basic";

    system.skillRankBonusProgression = normalizeSkillProgression(system.skillRankBonusProgression);

    const totalBoughtRanks = this._computeTotalBoughtRanks(system.boughtByLevel);
    // Skills don't have freeRanks today, but expose totalRanks for parity with
    // categories. Racial ranks are stored in boughtByLevel.0, so they're already
    // counted in totalBoughtRanks.
    const totalRanks = totalBoughtRanks;
    const specialOverride = this._resolveSpecialSkillTable(system.skillRankBonusProgression);
    const rankBonus = computeSkillRankBonus(totalRanks, system.skillRankBonusProgression, specialOverride);

    let categoryBonus = 0;
    const actor = this.parent;
    if (actor?.documentName === "Actor" && system.category) {
      const target = String(system.category).trim().toLowerCase();
      const parentCategory = actor.items.find(i =>
        i.type === "category" && String(i.name || "").trim().toLowerCase() === target
      );
      if (parentCategory) categoryBonus = Number(parentCategory.system?.totalBonus ?? 0) || 0;
    }

    system.totalRanks = totalRanks;
    system.totalRankBonus = rankBonus;
    system.categoryBonus = categoryBonus;
    system.totalBonus = rankBonus + categoryBonus + (system.profBonus || 0) + (system.spec1Bonus || 0) + (system.spec2Bonus || 0);
    // Alias consumed by RMFActions.#rollSkill — keeps actions.mjs untouched.
    system.bonus = system.totalBonus;
  }

  /**
   * Prepare derived data for a realm item.
   *
   * Realms map a character's magical realm to one of three
   * Power Point progression tracks. Storage is the user-facing
   * label ("Essence" | "Channeling" | "Mentalism") and an exposed
   * derived field `powerPointsField` resolves to the matching
   * field name on race items (`ppEssence` | `ppChanneling` | `ppMentalism`).
   *
   * @private
   * @memberof RMFItem
   */
  _prepareRealmData() {
    const system = this.system || (this.system = {});
    if (typeof system.description !== "string") system.description = "";
    if (typeof system.fromBook !== "string") system.fromBook = "basic";

    const allowed = ["Essence", "Channeling", "Mentalism"];
    const raw = typeof system.powerPointsType === "string" ? system.powerPointsType.trim() : "";
    const match = allowed.find(v => v.toLowerCase() === raw.toLowerCase());
    system.powerPointsType = match ?? "Essence";

    // Convenience derived: the race-item progression field this realm consumes.
    system.powerPointsField = `pp${system.powerPointsType}`;

    // Stat bonus: three slots referencing actor chStats keys (full form chXxx).
    if (!system.statBonus || typeof system.statBonus !== "object") {
      system.statBonus = { stat1: "chPresence", stat2: "chEmpathy", stat3: "chIntuition" };
    }
    for (const slot of ["stat1", "stat2", "stat3"]) {
      const value = system.statBonus[slot];
      system.statBonus[slot] = typeof value === "string" ? value : "";
    }
  }

  /**
   * Resolve the override progression table for skills with the "special"
   * progression. Special-cased mappings:
   *   - skill name === "Body Development" → race.bodyDevelopmentTable
   *   - skill name === "Power Point Development" →
   *       race[`${realm.powerPointsField}Table`]
   *       (realm.powerPointsField is "ppEssence"|"ppChanneling"|"ppMentalism",
   *        derived in _prepareRealmData from realm.powerPointsType)
   * Any other skill (or absent race / absent realm) yields null, which makes
   * the rank-bonus helpers fall back to the default zero-table for "special".
   *
   * @private
   * @param {string} progression
   * @returns {object|null}
   */
  _resolveSpecialSkillTable(progression) {
    if (progression !== "special") return null;
    const actor = this.parent;
    if (actor?.documentName !== "Actor") return null;
    const raceItem = actor.items.find(i => i.type === "race");
    if (!raceItem) return null;

    if (this.name === "Body Development") {
      return raceItem.system?.bodyDevelopmentTable ?? null;
    }

    if (this.name === "Power Point Development") {
      const realmItem = actor.items.find(i => i.type === "realm");
      const field = realmItem?.system?.powerPointsField;
      if (typeof field !== "string" || !field) return null;
      return raceItem.system?.[`${field}Table`] ?? null;
    }

    return null;
  }
}
