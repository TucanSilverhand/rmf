/**
 * RMF System - Document subclasses
 *
 * Thin extensions of `Actor` and `Item`. The data shape and per-type
 * derivations live in `module/data-models/*.mjs` (registered on
 * `CONFIG.{Actor,Item}.dataModels`); these classes only handle:
 *
 *   - Orchestrating the order of derivation between an Actor and its
 *     embedded items (categories must derive before skills).
 *   - Behavior-only methods that don't belong on a TypeDataModel
 *     (rolls, damage application, exposing roll data).
 *
 * @fileoverview Behavior-only Actor/Item subclasses.
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 */

/**
 * Extended Actor for RoleMaster Fantasy characters.
 *
 * Foundry calls `system.prepareDerivedData()` automatically as part of
 * `Actor.prepareDerivedData()` via the registered TypeDataModel. The
 * override below adds the orchestration layer:
 *
 *   1. CharacterData derives stat bonuses + base derived attributes.
 *   2. Each embedded `category` item derives totalBonus.
 *   3. Each embedded `skill` item derives totalBonus (uses category totals).
 *   4. CharacterData applies skill-based HP/PP overrides.
 *
 * @extends Actor
 */
export class RMFActor extends Actor {
  /**
   * @override
   * @memberof RMFActor
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.type !== "character") return;

    // `actor.itemTypes.<type>` is pre-bucketed by Foundry; no extra scan.
    const categories = this.itemTypes?.category ?? [];
    const skills     = this.itemTypes?.skill    ?? [];

    // Foundry has already prepared each item's system once; we re-run
    // the category and skill passes here so they see the up-to-date
    // chStats totals computed by CharacterData.
    for (const item of categories) item.prepareDerivedData?.();
    for (const item of skills)     item.prepareDerivedData?.();

    // After skills know their totalBonus, override HP/PP max.
    this.system?.applySkillBasedDerivedStats?.();
  }

  /**
   * Expose data consumable by user-written Roll formulas / macros.
   *
   * Exposes:
   *   data.stats.<chXxx>     ─ stat total (full canonical key)
   *   data.stats.<short>     ─ stat total (lowercase short, e.g. "qu")
   *   data.hp                ─ derivedStats.hitPoints.max
   *   data.pp                ─ derivedStats.powerPoints.max
   *   data.db                ─ derivedStats.defensiveBonus
   *   data.armorPenalty      ─ derivedStats.armorPenalty
   *   data.res.<key>         ─ resistance total (essence/channeling/
   *                            mentalism/poison/disease)
   *   data.resistances.<key> ─ same as data.res, full alias
   *   data.level             ─ chLevel
   *
   * Examples for user formulas:
   *   1d100 + @stats.quickness
   *   1d100 + @db
   *   1d100 + @res.poison
   *   @level
   *
   * @override
   */
  getRollData() {
    const data = super.getRollData();
    if (this.type !== "character") return data;

    // Stat totals — both `chXxx` and `<short>` variants so users can
    // pick whichever they prefer in their roll formulas.
    const stats = this.system?.chStats ?? {};
    const rollStats = {};
    for (const [key, stat] of Object.entries(stats)) {
      if (!stat || typeof stat !== "object") continue;
      const total = stat.total || 0;
      rollStats[key] = total;
      rollStats[key.replace("ch", "").toLowerCase()] = total;
    }
    data.stats = rollStats;

    // Derived attributes
    const ds = this.system?.derivedStats ?? {};
    data.hp           = ds.hitPoints?.max   || 0;
    data.pp           = ds.powerPoints?.max || 0;
    data.db           = ds.defensiveBonus   || 0;
    data.armorPenalty = ds.armorPenalty     || 0;

    // Resistances — exposed under both `data.res.*` (short) and
    // `data.resistances.*` (full) for ergonomic alias.
    const res = ds.resistances ?? {};
    const resistances = {
      essence:    res.essence    || 0,
      channeling: res.channeling || 0,
      mentalism:  res.mentalism  || 0,
      poison:     res.poison     || 0,
      disease:    res.disease    || 0
    };
    data.res = resistances;
    data.resistances = resistances;

    // Convenience scalars
    data.level = Number(this.system?.chLevel) || 0;

    return data;
  }

  /**
   * Roll a specific stat. Posts a styled chat card unless suppressed.
   *
   * @async
   * @param {string} statKey - canonical stat key (e.g. "chAgility")
   * @param {Object} [options]
   * @param {string} [options.formula="1d100 + @bonus"]
   * @param {boolean} [options.chatMessage=true]
   * @returns {Promise<Roll|null>}
   */
  async rollStat(statKey, options = {}) {
    const stat = this.system?.chStats?.[statKey];
    if (!stat) {
      ui.notifications?.warn(game.i18n.format("RMF.Messages.StatNotFound", { stat: statKey }));
      return null;
    }

    const rollData = this.getRollData();
    const bonus = Number(stat.total) || 0;
    const formula = options.formula || "1d100 + @bonus";
    const roll = new Roll(formula, { ...rollData, bonus, stat: bonus });
    await roll.evaluate();

    if (options.chatMessage !== false) {
      const statName = game.i18n.localize(`RMF.Stats.${statKey}`) || statKey;
      ChatMessage.implementation.create({
        speaker: ChatMessage.implementation.getSpeaker({ actor: this }),
        content: await foundry.applications.handlebars.renderTemplate(
          "systems/rmf/templates/chat/stat-roll.hbs", {
            actor: this,
            statName,
            roll,
            bonus,
            formula: roll.formula,
            baseRoll: Number(roll.dice?.[0]?.total ?? roll.total ?? 0),
            bonusOperator: bonus < 0 ? "-" : "+",
            bonusAbs: Math.abs(bonus),
            hasBonus: Math.abs(bonus) !== 0
          }
        ),
        rolls: [roll]
      });
    }
    return roll;
  }

  /**
   * Apply damage to derivedStats.hitPoints.value (clamped to 0..max).
   * Posts a chat message unless suppressed.
   *
   * @async
   * @param {number} amount
   * @param {Object} [options]
   * @param {boolean} [options.chatMessage=true]
   */
  async applyDamage(amount, options = {}) {
    const hp = this.system?.derivedStats?.hitPoints;
    if (!hp) return;
    const currentHP = Number(hp.value ?? hp.max ?? 0) || 0;
    const newValue = Math.max(0, currentHP - amount);
    await this.update({ "system.derivedStats.hitPoints.value": newValue });

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
 * Extended Item for RoleMaster Fantasy. The schema and per-type
 * derivation live in module/data-models/*.mjs. There's nothing to add
 * here at the Item level; the class exists so we can register
 * `CONFIG.Item.documentClass` and have a stable hook point for future
 * behavior additions.
 *
 * @extends Item
 */
export class RMFItem extends Item {}
