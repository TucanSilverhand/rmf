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
    
    // Process character-specific calculations
    if (this.type === "character") {
      this._migrateActorData();
      this._calculateStatBonuses();
      this._calculateSecondaryAttributes();
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
          const newTemp = statChange.temp;
          
          // console.log(`RMF | Recalculating ${statKey} with temp=${newTemp}`);
          
          // Calculate new basic bonus using RoleMaster table
          const newBasic = this._calculateBonus(newTemp);
          
          // Preserve current race and spec modifiers
          const race = statChange.race !== undefined ? statChange.race : (currentStat.race || 0);
          const spec = statChange.spec !== undefined ? statChange.spec : (currentStat.spec || 0);
          
          // Calculate new total
          const newTotal = newBasic + race + spec;
          
          console.log(`RMF | ${statKey}: basic=${newBasic}, race=${race}, spec=${spec}, total=${newTotal}`);
          
          // Apply calculated changes to the update object
          if (!changed.system.chStats[statKey]) {
            changed.system.chStats[statKey] = {};
          }
          
          changed.system.chStats[statKey].basic = newBasic;
          changed.system.chStats[statKey].total = newTotal;
          changed.system.chStats[statKey].bonus = newTotal;
        }
      }
    }
  }

  /**
   * Handle post-update processing to refresh UI elements
   * 
   * Triggers re-rendering of any open character sheets when
   * statistics are updated to ensure UI consistency.
   * 
   * @override
   * @async
   * @memberof RMFActor
   * @param {Object} changed - The changes that were applied
   * @param {Object} options - Update options
   * @param {string} userId - ID of the user who made the changes
   */
  async _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    
    // Force re-render of open sheets when stats change
    if (changed.system?.chStats) {
      for (let sheet of Object.values(this.apps)) {
        if (sheet.rendered) {
          sheet.render(false);
        }
      }
    }
  }

  /**
   * Migrate actor data to current format if needed
   * 
   * Ensures that existing actors have the complete stat structure
   * required by the current version of the system. This handles
   * backwards compatibility when the data model changes.
   * 
   * @private
   * @memberof RMFActor
   */
  _migrateActorData() {
    const system = this.system;
    
    // Initialize chStats if missing or invalid
    if (!system.chStats || typeof system.chStats !== 'object') {
      console.log(`RMF | Migrating actor data: ${this.name}`);
      
      // Basic stat structure according to template.json
      system.chStats = {
        chAgility: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chConstitution: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chMemory: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chReasoning: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chSelfDiscipline: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chEmpathy: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chIntuition: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chPresence: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chQuickness: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 },
        chStrength: { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 }
      };
      
      // Update actor with new structure
      this.updateSource({ system: { chStats: system.chStats } });
    }
    
    // Verify each stat has complete structure
    const requiredStats = ['chAgility', 'chConstitution', 'chMemory', 'chReasoning', 
                          'chSelfDiscipline', 'chEmpathy', 'chIntuition', 'chPresence', 
                          'chQuickness', 'chStrength'];
    
    for (const statKey of requiredStats) {
      if (!system.chStats[statKey] || typeof system.chStats[statKey] !== 'object') {
        system.chStats[statKey] = { temp: 35, pot: 35, basic: 0, race: 0, spec: 0, total: 0 };
      }
    }
    
    // Initialize derived stats if missing
    if (!system.derivedStats) {
      system.derivedStats = {
        hitPoints: { base: 50, constitution: 0, selfDiscipline: 0, total: 50, current: 50 },
        powerPoints: { empathy: 0, intuition: 0, presence: 0, total: 0, current: 0 },
        resistances: { essence: 0, channeling: 0, mentalism: 0, poison: 0, disease: 0 }
      };
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
    
    // Verify stats exist before calculating
    if (!stats) {
      return; // Migration should have handled this
    }
    
    // Initialize derived stats structure if missing
    system.derivedStats = system.derivedStats || {
      hitPoints: { base: 50, constitution: 0, selfDiscipline: 0, total: 50, current: 50 },
      powerPoints: { empathy: 0, intuition: 0, presence: 0, total: 0, current: 0 },
      resistances: { essence: 0, channeling: 0, mentalism: 0, poison: 0, disease: 0 }
    };

    const previousHPCurrent = Number(system.derivedStats?.hitPoints?.current);
    const previousPPCurrent = Number(system.derivedStats?.powerPoints?.current);
    
    // Calculate hit points using RoleMaster formula
    if (stats.chConstitution && stats.chSelfDiscipline) {
      const coBonus = stats.chConstitution.total || 0;
      const sdBonus = stats.chSelfDiscipline.total || 0;
      const totalHP = 50 + coBonus + Math.floor(sdBonus / 2);
      const currentHP = Number.isFinite(previousHPCurrent)
        ? Math.max(0, Math.min(previousHPCurrent, totalHP))
        : totalHP;
      system.derivedStats.hitPoints = {
        base: 50,
        constitution: coBonus,
        selfDiscipline: Math.floor(sdBonus / 2),
        total: totalHP,
        current: currentHP
      };
    } else {
      // Default values if stats are not available
      const defaultHP = 50;
      const currentHP = Number.isFinite(previousHPCurrent)
        ? Math.max(0, Math.min(previousHPCurrent, defaultHP))
        : defaultHP;
      system.derivedStats.hitPoints = {
        base: defaultHP,
        constitution: 0,
        selfDiscipline: 0,
        total: defaultHP,
        current: currentHP
      };
    }

    // Calculate power points for magic use
    if (stats.chEmpathy && stats.chIntuition && stats.chPresence) {
      const emBonus = stats.chEmpathy.total || 0;
      const inBonus = stats.chIntuition.total || 0;
      const prBonus = stats.chPresence.total || 0;
      const totalPP = emBonus + inBonus + prBonus;
      const currentPP = Number.isFinite(previousPPCurrent)
        ? Math.max(0, Math.min(previousPPCurrent, totalPP))
        : totalPP;
      
      system.derivedStats.powerPoints = {
        empathy: emBonus,
        intuition: inBonus,
        presence: prBonus,
        total: totalPP,
        current: currentPP
      };
    } else {
      // Default values if stats are not available
      system.derivedStats.powerPoints = {
        empathy: 0,
        intuition: 0,
        presence: 0,
        total: 0,
        current: 0
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
    } catch (_) {}
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
        data.hp = this.system.derivedStats.hitPoints?.total || 0;
        data.pp = this.system.derivedStats.powerPoints?.total || 0;
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
      
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this }),
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

    const currentHP = Number(hp.current ?? hp.total ?? 0) || 0;
    const newTotal = Math.max(0, currentHP - amount);
    
    await this.update({
      "system.derivedStats.hitPoints.current": newTotal
    });

    if (options.chatMessage !== false) {
      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this }),
        content: game.i18n.format("RMF.Messages.DamageApplied", {
          name: this.name,
          damage: amount,
          remaining: newTotal
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

    // Calculate metadata for UI display
    system.hasStatBonuses = Object.values(system.stats).some(val => val !== 0);
    system.hasResistances = Object.values(system.resistances).some(val => val !== 0);
    system.totalStatBonus = Object.values(system.stats).reduce((sum, val) => sum + val, 0);
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
    const progressionRaw = typeof system.categoryRankBonusProgression === 'string' ? system.categoryRankBonusProgression.trim() : '';
    const progressionNormalized = progressionRaw.toLowerCase();
    if (!progressionNormalized || progressionNormalized === 'standard') {
      system.categoryRankBonusProgression = 'standard';
    } else if (['notapplicable', 'not-applicable', 'na', 'none', 'other'].includes(progressionNormalized)) {
      system.categoryRankBonusProgression = 'notApplicable';
    } else {
      system.categoryRankBonusProgression = 'standard';
    }
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

    // Calculate totalBonus for display in actor sheets
    const totalBoughtRanks = this._computeTotalBoughtRanks(system.boughtByLevel);
    const totalRanks = totalBoughtRanks + (system.freeRanks || 0);
    const totalRankBonus = this._computeRankBonus(totalRanks, system.categoryRankBonusProgression);
    const totalStatsBonus = this._computeSelectedStatSum(system.statBonus?.stat1, system.statBonus?.stat2, system.statBonus?.stat3);
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
   * Compute rank bonus based on total ranks and progression type
   * @private
   */
  _computeRankBonus(totalRanks, progression) {
    const ranks = Math.max(0, Number(totalRanks ?? 0));
    const mode = (progression || 'standard').toLowerCase();
    if (mode === 'notapplicable' || mode === 'not-applicable' || mode === 'none' || mode === 'na' || mode === 'other') return 0;
    if (ranks === 0) return -15;
    const tier1 = Math.min(ranks, 10);
    const tier2 = Math.min(Math.max(ranks - 10, 0), 10);
    const tier3 = Math.min(Math.max(ranks - 20, 0), 10);
    const halfSteps = (tier1 * 4) + (tier2 * 2) + (tier3 * 1);
    return halfSteps / 2;
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

  // Removed: race application helpers (applyToActor) as part of Option B cleanup

  

  /**
   * Get item context menu options
   * @returns {Array} Context menu options
   */
  getContextMenuOptions() { return []; }
  // Removed: context menu and bulk-apply helpers for races
}
