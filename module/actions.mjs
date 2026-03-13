/**
 * RMF System - Centralized Actions Manager
 * 
 * Provides a unified system for handling all user interactions across
 * actor and item sheets. Uses declarative action handlers following
 * ApplicationV2 best practices from FoundryVTT v13.341.
 * 
 * @fileoverview Centralized action handling system
 * @version 1.0.0
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 * 
 * @see Documentation/system-ars/06_Actions_Events_System.md
 * @see Documentation/api/02_Application_System.md
 */

/**
 * Centralized action management system for RMF
 * 
 * This class provides a unified interface for handling all user interactions
 * in actor and item sheets. Each action is registered with metadata about
 * permissions, requirements, and handlers.
 * 
 * @class RMFActions
 * @example
 * // In a sheet class:
 * static DEFAULT_OPTIONS = {
 *   actions: {
 *     rollStat: RMFActions.handlers.rollStat,
 *     pickImage: RMFActions.handlers.pickImage
 *   }
 * }
 */
export class RMFActions {
  
  /**
   * Registry of all available actions with their metadata
   * @static
   * @readonly
   * @type {Object<string, ActionDefinition>}
   */
  static actions = {
    // Actor Sheet Actions
    rollStat: {
      handler: this.#rollStat,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll a character statistic"
    },
    rollSkill: {
      handler: this.#rollSkill,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll a skill check"
    },
    rollDefensive: {
      handler: this.#rollDefensive,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll defensive bonus"
    },
    rollResistance: {
      handler: this.#rollResistance,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll resistance check"
    },
    rollCategory: {
      handler: this.#rollCategory,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll category check"
    },
    
    // Image Selection Actions
    pickImage: {
      handler: this.#pickImage,
      requiresTarget: false,
      permission: "OWNER",
      description: "Open image picker dialog"
    },
    
    // Item Management Actions
    editItem: {
      handler: this.#editItem,
      requiresTarget: true,
      permission: "OWNER",
      description: "Open item sheet for editing"
    },
    deleteItem: {
      handler: this.#deleteItem,
      requiresTarget: true,
      permission: "OWNER",
      description: "Delete an item from actor"
    },
    createItem: {
      handler: this.#createItem,
      requiresTarget: false,
      permission: "OWNER",
      description: "Create a new item on actor"
    },
    toggleEquipped: {
      handler: this.#toggleEquipped,
      requiresTarget: true,
      permission: "OWNER",
      description: "Toggle item equipped status"
    },
    
    // Skill Management Actions
    incrementSkillRank: {
      handler: this.#incrementSkillRank,
      requiresTarget: true,
      permission: "OWNER",
      description: "Increase skill rank by 1"
    },
    decrementSkillRank: {
      handler: this.#decrementSkillRank,
      requiresTarget: true,
      permission: "OWNER",
      description: "Decrease skill rank by 1"
    }
  };

  /**
   * Public handlers object for easy import and use in sheets
   * @static
   * @readonly
   * @type {Object<string, Function>}
   */
  static handlers = Object.fromEntries(
    Object.entries(this.actions).map(([key, action]) => [key, action.handler])
  );

  /**
   * Perform an action with validation and error handling
   * 
   * @static
   * @async
   * @param {string} actionName - Name of the action to perform
   * @param {Object} context - Context object (typically the sheet instance)
   * @param {Event} event - The triggering event
   * @param {HTMLElement} target - The target element
   * @returns {Promise<*>} Result of the action handler
   * @throws {Error} If action is not found or validation fails
   */
  static async perform(actionName, context, event, target) {
    const action = this.actions[actionName];
    
    if (!action) {
      console.error(`RMF | Unknown action: ${actionName}`);
      throw new Error(`Unknown action: ${actionName}`);
    }

    // Validate requirements
    if (action.requiresTarget && !target) {
      console.error(`RMF | Action ${actionName} requires a target element`);
      throw new Error(`Action ${actionName} requires a target element`);
    }

    // Check permissions
    if (action.permission && context.document) {
      const hasPermission = context.document.testUserPermission(
        game.user,
        action.permission
      );
      
      if (!hasPermission) {
        ui.notifications.warn(game.i18n.localize("RMF.Notifications.InsufficientPermissions"));
        return null;
      }
    }

    try {
      return await action.handler.call(context, event, target);
    } catch (error) {
      console.error(`RMF | Error performing action ${actionName}:`, error);
      ui.notifications.error(game.i18n.localize("RMF.Notifications.ActionFailed"));
      throw error;
    }
  }

  // =====================
  // ACTOR ROLLING ACTIONS
  // =====================

  /**
   * Post a roll using the RMF custom chat card template.
   *
   * @private
   * @static
   * @async
   * @param {object} params
   * @param {Actor} params.actor
   * @param {Roll} params.roll
   * @param {number} [params.bonus=0]
   * @param {string} params.flavor
   * @param {string} [params.label]
   */
  static async #postStyledRollMessage({ actor, roll, bonus = 0, flavor, label = "" }) {
    const baseRoll = Number(roll.dice?.[0]?.total ?? roll.total ?? 0);
    const bonusValue = Number(bonus) || 0;
    const bonusAbs = Math.abs(bonusValue);
    const bonusOperator = bonusValue < 0 ? "-" : "+";
    const hasBonus = bonusAbs !== 0;

    const content = await foundry.applications.handlebars.renderTemplate(
      "systems/rmf/templates/chat/stat-roll.hbs",
      {
        actor,
        statName: label || flavor,
        roll,
        bonus: bonusValue,
        formula: roll.formula,
        baseRoll,
        bonusOperator,
        bonusAbs,
        hasBonus
      }
    );

    await roll.toMessage({
      speaker: ChatMessage.implementation.getSpeaker({ actor }),
      flavor,
      content,
      rollMode: game.settings.get("core", "rollMode")
    });
  }

  /**
   * Roll a character statistic
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollStat(event, target) {
    event.preventDefault();
    
    const statKey = target.dataset.stat;
    const stat = this.document.system.chStats[statKey];
    
    if (!stat) {
      console.error(`RMF | Invalid stat key: ${statKey}`);
      return;
    }

    // Construct roll formula
    const bonus = stat.total || 0;
    const formula = `1d100${bonus >= 0 ? '+' : ''}${bonus}`;
    
    // Execute roll
    const roll = await new Roll(formula).evaluate();
    
    // Get stat label for display
    const statLabel = game.i18n.localize(`RMF.Stats.${statKey}`) || statKey;

    await RMFActions.#postStyledRollMessage({
      actor: this.document,
      roll,
      bonus,
      flavor: `${statLabel} Roll`,
      label: statLabel
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Stat Roll: ${statKey} = ${roll.total}`);
    }
  }

  /**
   * Roll a skill check
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollSkill(event, target) {
    event.preventDefault();
    
    const itemId = target.closest('[data-item-id]')?.dataset.itemId;
    if (!itemId) {
      console.error("RMF | Skill roll requires item-id");
      return;
    }

    const skill = this.document.items.get(itemId);
    if (!skill) {
      console.error(`RMF | Skill not found: ${itemId}`);
      return;
    }

    // Get skill bonus (from category + stats + special)
    const skillBonus = skill.system.bonus || 0;
    const formula = `1d100${skillBonus >= 0 ? '+' : ''}${skillBonus}`;
    
    // Execute roll
    const roll = await new Roll(formula).evaluate();
    
    await RMFActions.#postStyledRollMessage({
      actor: this.document,
      roll,
      bonus: skillBonus,
      flavor: `${skill.name} Roll`,
      label: skill.name
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Skill Roll: ${skill.name} = ${roll.total}`);
    }
  }

  /**
   * Roll defensive bonus
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollDefensive(event, target) {
    event.preventDefault();
    
    const actor = this.document;
    
    // Use defensive bonus value directly from derived stats
    const bonus = actor.system.derivedStats?.defensiveBonus || 0;
    const formula = `1d100${bonus >= 0 ? '+' : ''}${bonus}`;
    
    const roll = await new Roll(formula).evaluate();
    
    await RMFActions.#postStyledRollMessage({
      actor,
      roll,
      bonus,
      flavor: "Defense Roll",
      label: game.i18n.localize("RMF.DerivedStats.DefensiveBonus")
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Defense Roll = ${roll.total}`);
    }
  }

  /**
   * Roll resistance check
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollResistance(event, target) {
    event.preventDefault();
    
    const resistType = target.dataset.resistance;
    const actor = this.document;
    
    // Get resistance bonus from derived stats
    const resistance = actor.system.derivedStats?.resistances?.[resistType] || 0;
    const formula = `1d100${resistance >= 0 ? '+' : ''}${resistance}`;
    
    const roll = await new Roll(formula).evaluate();
    
    const resistLabel = game.i18n.localize(`RMF.Resistances.${resistType}`) || resistType;
    
    await RMFActions.#postStyledRollMessage({
      actor,
      roll,
      bonus: resistance,
      flavor: `${resistLabel} Resistance Roll`,
      label: resistLabel
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Resistance Roll: ${resistType} = ${roll.total}`);
    }
  }

  /**
   * Roll category check
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollCategory(event, target) {
    event.preventDefault();
    
    const itemId = target.dataset.itemId;
    if (!itemId) {
      console.error("RMF | Category roll requires item-id");
      return;
    }

    const category = this.document.items.get(itemId);
    if (!category) {
      console.error(`RMF | Category not found: ${itemId}`);
      return;
    }

    // Get category total bonus
    const bonus = category.system.totalBonus || 0;
    const formula = `1d100${bonus >= 0 ? '+' : ''}${bonus}`;
    
    // Execute roll
    const roll = await new Roll(formula).evaluate();
    
    await RMFActions.#postStyledRollMessage({
      actor: this.document,
      roll,
      bonus,
      flavor: `${category.name} Roll`,
      label: category.name
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Category Roll: ${category.name} = ${roll.total}`);
    }
  }

  // ======================
  // IMAGE PICKER ACTIONS
  // ======================

  /**
   * Open image picker dialog
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {ApplicationV2} Sheet instance
   */
  static async #pickImage(event, target) {
    event.preventDefault();
    
    const current = this.document.img;
    
    // Use modern FilePicker implementation
    const fp = new foundry.applications.apps.FilePicker({
      type: "image",
      current: current,
      callback: async (path) => {
        await this.document.update({ img: path });
        
        if (CONFIG.RMF?.debug) {
          console.log(`RMF DEBUG | Image updated: ${path}`);
        }
      },
      top: this.position.top + 40,
      left: this.position.left + 10
    });
    
    return fp.browse();
  }

  // ======================
  // ITEM MANAGEMENT ACTIONS
  // ======================

  /**
   * Open item sheet for editing
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #editItem(event, target) {
    event.preventDefault();
    
    const itemId = target.closest('[data-item-id]')?.dataset.itemId;
    if (!itemId) {
      console.error("RMF | Edit item requires item-id");
      return;
    }

    const item = this.document.items.get(itemId);
    if (!item) {
      console.error(`RMF | Item not found: ${itemId}`);
      return;
    }

    // Render the item's sheet
    item.sheet.render(true);

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Editing item: ${item.name} (${itemId})`);
    }
  }

  /**
   * Delete an item from actor
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #deleteItem(event, target) {
    event.preventDefault();
    
    const itemId = target.closest('[data-item-id]')?.dataset.itemId;
    if (!itemId) {
      console.error("RMF | Delete item requires item-id");
      return;
    }

    const item = this.document.items.get(itemId);
    if (!item) {
      console.error(`RMF | Item not found: ${itemId}`);
      return;
    }

    // Confirm deletion
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("RMF.Dialogs.DeleteItem") },
      content: game.i18n.format("RMF.Dialogs.DeleteItemConfirm", { name: item.name }),
      rejectClose: false,
      modal: true
    });

    if (!confirmed) return;

    // Delete the item
    await item.delete();
    
    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Deleted item: ${item.name} (${itemId})`);
    }
  }

  /**
   * Create a new item on actor
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #createItem(event, target) {
    event.preventDefault();
    
    const itemType = target.dataset.type || "equipment";
    const itemTypeLabel = game.i18n.localize(`TYPES.Item.${itemType}`);
    const localizedNewItem = game.i18n.localize(`RMF.NewItem.${itemType}`);
    const fallbackName = `${game.i18n.localize("RMF.Actions.Create")} ${itemTypeLabel}`;
    
    // Create default item data
    const itemData = {
      name: (localizedNewItem === `RMF.NewItem.${itemType}`) ? fallbackName : localizedNewItem,
      type: itemType,
      system: {}
    };

    // Create the item
    const [created] = await this.document.createEmbeddedDocuments("Item", [itemData]);
    
    // Open the sheet for the new item
    created.sheet.render(true);

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Created item: ${created.name} (${itemType})`);
    }
  }

  /**
   * Toggle item equipped status
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFItemSheet} Sheet instance
   */
  static async #toggleEquipped(event, target) {
    event.preventDefault();
    
    const currentState = this.document.system.equipped || false;
    await this.document.update({ "system.equipped": !currentState });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Toggled equipped: ${this.document.name} => ${!currentState}`);
    }
  }

  // ======================
  // SKILL MANAGEMENT ACTIONS
  // ======================

  /**
   * Increment skill rank by 1
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFSkillSheet} Sheet instance
   */
  static async #incrementSkillRank(event, target) {
    event.preventDefault();
    
    const currentRank = Number(this.document.system.rank || 0);
    const level = parseInt(target.dataset.level) || 1;
    
    // Get current bought for this level
    const bought = this.document.system.boughtByLevel || {};
    const currentBought = Number(bought[level] || 0);
    
    // Maximum 3 ranks per level
    if (currentBought >= 3) {
      ui.notifications.warn(game.i18n.localize("RMF.Skill.MaxRanksPerLevel"));
      return;
    }

    // Update
    await this.document.update({
      "system.rank": currentRank + 1,
      [`system.boughtByLevel.${level}`]: currentBought + 1
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Incremented skill rank: ${this.document.name} level ${level} => ${currentBought + 1}`);
    }
  }

  /**
   * Decrement skill rank by 1
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFSkillSheet} Sheet instance
   */
  static async #decrementSkillRank(event, target) {
    event.preventDefault();
    
    const currentRank = Number(this.document.system.rank || 0);
    if (currentRank <= 0) return;
    
    const level = parseInt(target.dataset.level) || 1;
    const bought = this.document.system.boughtByLevel || {};
    const currentBought = Number(bought[level] || 0);
    
    if (currentBought <= 0) return;

    // Update
    await this.document.update({
      "system.rank": currentRank - 1,
      [`system.boughtByLevel.${level}`]: currentBought - 1
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Decremented skill rank: ${this.document.name} level ${level} => ${currentBought - 1}`);
    }
  }
}

/**
 * @typedef {Object} ActionDefinition
 * @property {Function} handler - The function that handles this action
 * @property {boolean} requiresTarget - Whether the action requires a target element
 * @property {string} permission - Required permission level (OWNER, LIMITED, OBSERVER, NONE)
 * @property {string} description - Human-readable description of the action
 */
