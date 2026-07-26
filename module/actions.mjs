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

import { RMF_CONSTANTS } from "./utils/constants.mjs";
import { rollOpenEndedD100 } from "./tables/open-ended.mjs";
import { rollManeuver, postRollMessage, safeBonus } from "./utils/maneuver-roll.mjs";

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
    rollCategoryNoSkill: {
      handler: this.#rollCategoryNoSkill,
      requiresTarget: true,
      permission: "OWNER",
      description: "Roll category check applying the -15 untrained-skill penalty"
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

    // Get stat label for display
    const statLabel = game.i18n.localize(`RMF.Stats.${statKey}`) || statKey;

    // A bare stat check stands in for the book's "no applicable skill" static
    // maneuver (T-4.3), so it carries the UM 66/100 band.
    const openEnded = await rollManeuver({
      actor: this.document,
      bonus: stat.total,
      flavor: `${statLabel} Roll`,
      label: statLabel,
      staticManeuver: true
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Stat Roll: ${statKey} = ${openEnded.total} (natural ${openEnded.natural})`);
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

    // Skill bonus already folds in category + stats + special bonuses.
    // Only a static-maneuver skill carries the T-4.3 UM 66/100 band; moving
    // maneuvers (T-4.1) have none, so their 100 still explodes.
    const openEnded = await rollManeuver({
      actor: this.document,
      bonus: skill.system.bonus,
      flavor: `${skill.name} Roll`,
      label: skill.name,
      staticManeuver: skill.system.classification === "staticManeuver"
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Skill Roll: ${skill.name} = ${openEnded.total} (natural ${openEnded.natural})`);
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

    // The book never rolls the DB (it is subtracted from the attacker's roll),
    // so there is no canonical UM band here: this convenience roll is plain
    // open-ended in both directions like any other d100 action roll.
    const openEnded = await rollOpenEndedD100({ high: true, low: true });

    await postRollMessage({
      actor,
      openEnded,
      bonus: safeBonus(actor.system.derivedStats?.defensiveBonus),
      flavor: "Defense Roll",
      label: game.i18n.localize("RMF.DerivedStats.DefensiveBonus")
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Defense Roll = ${openEnded.total} (natural ${openEnded.natural})`);
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

    // Resistance Rolls are open-ended (high + low) — PDF p.53. NaN-safe bonus.
    const rawBonus = Number(actor.system.derivedStats?.resistances?.[resistType]);
    const resistance = Number.isFinite(rawBonus) ? Math.trunc(rawBonus) : 0;

    const openEnded = await rollOpenEndedD100({ high: true, low: true });

    const resistLabel = game.i18n.localize(`RMF.Resistances.${resistType}`) || resistType;

    await postRollMessage({
      actor,
      openEnded,
      bonus: resistance,
      flavor: `${resistLabel} Resistance Roll`,
      label: resistLabel
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Resistance Roll: ${resistType} = ${openEnded.total + resistance}`);
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

    // A category has no classification of its own, so a bare category check is
    // treated as a static maneuver (T-4.3, the untrained-skill case the book
    // describes). Flip this flag if your table rules it a moving maneuver.
    const openEnded = await rollManeuver({
      actor: this.document,
      bonus: category.system.totalBonus,
      flavor: `${category.name} Roll`,
      label: category.name,
      staticManeuver: true
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Category Roll: ${category.name} = ${openEnded.total} (natural ${openEnded.natural})`);
    }
  }

  /**
   * Roll a category check assuming no trained skill (applies the
   * canonical -15 penalty on top of the category total bonus).
   * @private
   * @static
   * @async
   * @param {Event} event - The click event
   * @param {HTMLElement} target - The clicked element
   * @this {RMFActorSheet} Sheet instance
   */
  static async #rollCategoryNoSkill(event, target) {
    event.preventDefault();

    const itemId = target.dataset.itemId;
    if (!itemId) {
      console.error("RMF | Category-no-skill roll requires item-id");
      return;
    }

    const category = this.document.items.get(itemId);
    if (!category) {
      console.error(`RMF | Category not found: ${itemId}`);
      return;
    }

    const baseBonus = safeBonus(category.system.totalBonus);
    const noSkillLabel = game.i18n.has("RMF.NoSkill")
      ? game.i18n.localize("RMF.NoSkill")
      : "No skill";
    const label = `${category.name} (${noSkillLabel})`;

    // Same assumption as #rollCategory: an untrained check is a static maneuver.
    const openEnded = await rollManeuver({
      actor: this.document,
      bonus: baseBonus + RMF_CONSTANTS.NO_SKILL_PENALTY,
      flavor: `${label} Roll`,
      label,
      staticManeuver: true
    });

    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Category-no-skill Roll: ${category.name} = ${openEnded.total} (natural ${openEnded.natural})`);
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
    
    // Resolve the configured FilePicker class. In v13 core classes are
    // exposed as a base + a swappable `.implementation` accessor (same
    // idiom as `Item.implementation`); fall back to the base class on
    // builds where the accessor is absent so this can't regress.
    const FilePickerClass = foundry.applications.apps.FilePicker.implementation
      ?? foundry.applications.apps.FilePicker;
    const fp = new FilePickerClass({
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

    const parsedLevel = parseInt(target.dataset.level);
    const level = Number.isFinite(parsedLevel) ? parsedLevel : 1;

    // Get current bought for this level
    const bought = this.document.system.boughtByLevel || {};
    const currentBought = Number(bought[level] || 0);

    // Max ranks/level from the slash-notation cost (1/2/3/* → 1/2/3/∞).
    // When the skill carries no own cost (cost lives in the profession),
    // fall back to the classic 3-per-level cap.
    const rpl = Number(this.document.system.dpCostParsed?.ranksPerLevel);
    const maxRanks = rpl === Infinity ? Infinity : (rpl > 0 ? rpl : 3);
    if (currentBought >= maxRanks) {
      ui.notifications.warn(game.i18n.localize("RMF.Skill.MaxRanksPerLevel"));
      return;
    }

    // Total ranks are derived from boughtByLevel only — there is no
    // separate persisted `rank` counter to keep in sync (see R8 / Fase 1).
    await this.document.update({
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

    const parsedLevel = parseInt(target.dataset.level);
    const level = Number.isFinite(parsedLevel) ? parsedLevel : 1;
    const bought = this.document.system.boughtByLevel || {};
    const currentBought = Number(bought[level] || 0);

    if (currentBought <= 0) return;

    // boughtByLevel is the single source of truth (see R8 / Fase 1).
    await this.document.update({
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
