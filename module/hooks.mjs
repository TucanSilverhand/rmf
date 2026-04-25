/**
 * RMF System - Centralized Hooks Manager
 * 
 * Organizes all FoundryVTT hooks for the RMF system in a single location.
 * Follows best practices for hook management and provides clear separation
 * of concerns for system initialization, document lifecycle, and UI events.
 * 
 * @fileoverview Centralized hook management system
 * @version 1.0.0
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 * 
 * @see Documentation/api/01_Core_System.md
 */

import {
  importRaces,
  importCategories,
  importSkills,
  syncCategoriesToCompendium,
  syncRacesToCompendium,
  syncSkillsToCompendium
} from "./importers.mjs";

/**
 * Centralized hook management for the RMF system
 * 
 * This class organizes all FoundryVTT hooks into logical categories and
 * provides a single initialization point for the entire hook system.
 * 
 * @class RMFHooks
 */
export class RMFHooks {
  
  /**
   * Initialize all system hooks
   * 
   * Call this once during system initialization to register all hooks
   * with FoundryVTT. Hooks are organized by lifecycle stage and purpose.
   * 
   * @static
   */
  static initialize() {
    // The init/ready callbacks are owned by rmf.mjs because RMFHooks.initialize()
    // itself runs inside the init hook; any further Hooks.once("init", ...) added
    // here would never fire. Only register hooks that dispatch later.
    Hooks.once("ready", this.#onReady.bind(this));

    // Document lifecycle hooks
    Hooks.on("createActor", this.#onCreateActor.bind(this));
    Hooks.on("preUpdateActor", this.#onPreUpdateActor.bind(this));
    Hooks.on("updateActor", this.#onUpdateActor.bind(this));
    Hooks.on("updateToken", this.#onUpdateToken.bind(this));

    // UI hooks
    Hooks.on("renderSettingsConfig", this.#onRenderSettingsConfig.bind(this));
    // v13 replaces renderChatMessage with renderChatMessageHTML.
    Hooks.on("renderChatMessageHTML", this.#onRenderChatMessage.bind(this));
  }

  // =====================
  // LIFECYCLE HOOKS
  // =====================

  /**
   * System ready hook
   *
   * Executes after all systems and modules are loaded. Sets up
   * global API endpoints and performs post-initialization tasks.
   *
   * @private
   * @static
   * @async
   */
  static async #onReady() {
    console.log("RMF | System ready");

    // Expose import functions to global game object
    game.rmf = game.rmf || {};
    game.rmf.importRaces = importRaces;
    game.rmf.importCategories = importCategories;
    game.rmf.importSkills = importSkills;
    game.rmf.syncCategoriesToCompendium = syncCategoriesToCompendium;
    game.rmf.syncRacesToCompendium = syncRacesToCompendium;
    game.rmf.syncSkillsToCompendium = syncSkillsToCompendium;

    // Log system information
    console.log(`RMF | Version: ${game.system.version}`);
    console.log(`RMF | FoundryVTT: ${game.version}`);

    if (CONFIG.RMF?.debug) {
      console.log("RMF DEBUG | Ready hook completed");
      console.log("RMF DEBUG | Global API exposed:", Object.keys(game.rmf));
    }
  }

  // =====================
  // DOCUMENT LIFECYCLE HOOKS
  // =====================

  /**
   * Actor creation hook
   * 
   * Automatically attaches category items from the "basic-core" compendium
   * folder "Categories" when a new character actor is created.
   * 
   * @private
   * @static
   * @async
   * @param {Actor} actor - The newly created actor
   * @param {Object} options - Creation options
   * @param {string} userId - ID of the user who created the actor
   */
  static async #onCreateActor(actor, options, userId) {
    // Only process for character actors
    if (actor.type !== "character") return;
    
    // Only process if current user created the actor
    if (game.userId !== userId) return;

    // Allow explicit opt-out from programmatic actor creation flows
    if (options?.rmfSkipAutoCategories) return;

    const sourceItems = await this.#collectBasicCoreCategorySources();
    if (!sourceItems.length) return;

    // Get existing category names to avoid duplicates
    const existingCategoryNames = new Set(
      actor.items
        .filter(item => item.type === "category")
        .map(item => item.name)
    );

    // Prepare payload for creation
    const payload = sourceItems
      .filter(item => !existingCategoryNames.has(item.name))
      .map(item => {
        const data = foundry.utils.duplicate(item.toObject());
        delete data._id;
        delete data.folder;
        data.flags = foundry.utils.mergeObject(data.flags ?? {}, {
          rmf: {
            sourceRuleBook: item.system?.fromBook ?? "basic",
            sourceCompendium: item.pack ?? "world.basic-core"
          }
        });
        return data;
      });

    if (!payload.length) return;

    // Create embedded category items
    try {
      await actor.createEmbeddedDocuments("Item", payload);
      
      if (CONFIG.RMF?.debug) {
        console.debug(
          `RMF DEBUG | Added ${payload.length} category items to ${actor.name} from basic-core/Categories`
        );
      }
    } catch (error) {
      console.error("RMF | Failed to attach compendium categories:", error);
    }
  }

  /**
   * Actor pre-update hook
   * 
   * Performs validation and pre-processing before actor updates are applied.
   * Can be used for enforcing business rules or preparing derived data.
   * 
   * @private
   * @static
   * @async
   * @param {Actor} actor - The actor being updated
   * @param {Object} changes - The changes being applied
   * @param {Object} options - Update options
   * @param {string} userId - ID of the user making the update
   */
  static async #onPreUpdateActor(actor, changes, options, userId) {
    // Pre-update logic is handled in RMFActor._preUpdate
    // This hook is reserved for system-wide pre-update operations
    
    if (CONFIG.RMF?.debug && Object.keys(changes).length > 0) {
      console.log(`RMF DEBUG | Pre-update actor: ${actor.name}`, changes);
    }
  }

  /**
   * Actor update hook
   * 
   * Handles post-update operations like UI refresh or derived data recalculation.
   * 
   * @private
   * @static
   * @async
   * @param {Actor} actor - The actor that was updated
   * @param {Object} changes - The changes that were applied
   * @param {Object} options - Update options
   * @param {string} userId - ID of the user who made the update
   */
  static async #onUpdateActor(actor, changes, options, userId) {
    // Post-update logic is handled in RMFActor._onUpdate
    // This hook is reserved for system-wide post-update operations
    
    if (CONFIG.RMF?.debug && Object.keys(changes).length > 0) {
      console.log(`RMF DEBUG | Updated actor: ${actor.name}`, changes);
    }
  }

  /**
   * Token update hook
   * 
   * Ensures derived statistics are recalculated when token actor data changes.
   * 
   * @private
   * @static
   * @async
   * @param {Token} token - The token being updated
   * @param {Object} updates - The update data
   * @param {Object} options - Update options
   * @param {string} userId - ID of the user making the update
   */
  static async #onUpdateToken(token, updates, options, userId) {
    // Only process if actor data was updated
    if (!updates.actorData) return;
    
    const actor = token.actor;
    if (!actor || actor.type !== "character") return;
    
    // Trigger derived data recalculation
    actor.prepareDerivedData();
    
    if (CONFIG.RMF?.debug) {
      console.log(`RMF DEBUG | Token actor data updated: ${actor.name}`);
    }
  }

  // =====================
  // UI HOOKS
  // =====================

  /**
   * Settings config render hook
   * 
   * Enhances the settings menu with custom UI for rule book selection.
   * Replaces the default text input with checkboxes for better UX.
   * 
   * @private
   * @static
   * @param {SettingsConfig} app - The settings config application
   * @param {HTMLElement} html - The rendered HTML element
   */
  static #onRenderSettingsConfig(app, html) {
    // Convert to HTMLElement if needed
    const element = html instanceof HTMLElement ? html : html[0];
    if (!element) return;

    // Find the rule books setting
    const setting = element.querySelector('input[name="rmf.ruleBooks"]');
    if (!setting) return;

    const current = game.settings.get("rmf", "ruleBooks");
    const currentSet = new Set(Array.isArray(current) ? current : []);

    // Define available rule books
    const books = [
      { value: "none", labelKey: "RMF.Settings.RuleBooks.Options.None" },
      { value: "basic", labelKey: "RMF.Settings.RuleBooks.Options.Basic" }
    ];

    // Build checkbox container
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'rmf-rulebooks-checkboxes';
    
    for (const book of books) {
      const label = document.createElement('label');
      label.className = 'checkbox';
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = `rmf.ruleBooks.${book.value}`;
      checkbox.value = book.value;
      checkbox.checked = currentSet.has(book.value);
      
      const span = document.createElement('span');
      span.textContent = game.i18n.localize(book.labelKey);
      
      label.appendChild(checkbox);
      label.appendChild(span);
      checkboxContainer.appendChild(label);
    }

    // Find form group and replace input with checkboxes
    const formGroup = setting.closest('.form-group');
    if (!formGroup) return;
    
    setting.replaceWith(checkboxContainer);

    // Create container for hidden inputs (one per selected value)
    const hiddenContainer = document.createElement('div');
    hiddenContainer.className = 'rmf-rulebooks-hidden';
    hiddenContainer.style.display = 'none';
    formGroup.appendChild(hiddenContainer);

    // Function to update hidden inputs based on checkbox state
    const updateHiddenInputs = () => {
      hiddenContainer.innerHTML = '';
      const selected = [];
      const checkboxes = formGroup.querySelectorAll('input[name^="rmf.ruleBooks."]:checked');
      
      checkboxes.forEach(cb => {
        selected.push(cb.value);
        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = 'rmf.ruleBooks';
        hiddenInput.value = cb.value;
        hiddenContainer.appendChild(hiddenInput);
      });

      // If nothing selected, add "none" as default
      if (selected.length === 0) {
        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = 'rmf.ruleBooks';
        hiddenInput.value = 'none';
        hiddenContainer.appendChild(hiddenInput);
      }

      if (CONFIG.RMF?.debug) {
        console.log("RMF DEBUG | Rule books selection updated:", selected);
      }
    };

    // Add change listeners to checkboxes
    const allCheckboxes = checkboxContainer.querySelectorAll('input[type="checkbox"]');
    allCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        // If "none" is checked, uncheck all others
        if (checkbox.value === 'none' && checkbox.checked) {
          allCheckboxes.forEach(cb => {
            if (cb !== checkbox) cb.checked = false;
          });
        }
        // If any other is checked, uncheck "none"
        else if (checkbox.value !== 'none' && checkbox.checked) {
          allCheckboxes.forEach(cb => {
            if (cb.value === 'none') cb.checked = false;
          });
        }
        
        updateHiddenInputs();
      });
    });

    // Initialize hidden inputs
    updateHiddenInputs();

    if (CONFIG.RMF?.debug) {
      console.log("RMF DEBUG | Enhanced rule books setting UI");
    }
  }

  /**
   * Chat message render hook
   * 
   * Customizes the appearance of chat messages generated by the RMF system.
   * Can be used to add special formatting, tooltips, or interactive elements.
   * 
   * @private
   * @static
   * @async
   * @param {ChatMessage} message - The chat message being rendered
   * @param {HTMLElement} html - The rendered HTML element
   * @param {Object} data - Message data
   */
  static async #onRenderChatMessage(message, html, data) {
    const root = html?.querySelector ? html : html?.[0];
    const addClass = (className) => {
      if (root?.classList) root.classList.add(className);
      if (typeof html?.addClass === "function") html.addClass(className);
    };

    // Mark RMF roll messages (stat/skill/defense/resistance/category) for optional styling hooks.
    if (message.rolls?.length > 0 && message.flavor) {
      addClass("rmf-roll-message");
    }

    if (CONFIG.RMF?.debug) {
      // Add debug information to chat messages
      if (message.speaker?.actor) {
        const actor = game.actors.get(message.speaker.actor);
        if (actor) {
          console.log(`RMF DEBUG | Chat message from: ${actor.name}`);
        }
      }
    }
  }

  // =====================
  // HELPER METHODS
  // =====================

  /**
   * Collect category items from compendium "basic-core" folder "Categories".
   *
   * @private
   * @static
   * @async
   * @returns {Promise<Array<Item>>} Array of category source items
   */
  static async #collectBasicCoreCategorySources() {
    const preferredCollection = "world.basic-core";
    const candidatePacks = [
      preferredCollection,
      `${game.system.id}.basic-core`,
      ...game.packs
        .map(pack => pack.collection)
        .filter(collection => collection.endsWith(".basic-core"))
    ];

    const collection = [...new Set(candidatePacks)].find(c => game.packs.has(c));
    if (!collection) {
      console.warn("RMF | No compendium pack found for basic-core");
      return [];
    }

    const pack = game.packs.get(collection);
    if (!pack) return [];

    const allDocs = await pack.getDocuments();
    const categoryDocs = allDocs.filter(doc => doc.type === "category");
    if (!categoryDocs.length) return [];

    const folderName = "categories";
    const categoryFolderIds = new Set();

    const folders = pack.folders ? Array.from(pack.folders.values()) : [];
    for (const folder of folders) {
      if ((folder.name ?? "").trim().toLowerCase() === folderName) {
        categoryFolderIds.add(folder.id);
      }
    }

    const matchesFolder = (doc) => {
      const folder = doc.folder;
      if (!folder) return false;
      if (typeof folder === "string") return categoryFolderIds.has(folder);
      if (typeof folder === "object") {
        if ((folder.name ?? "").trim().toLowerCase() === folderName) return true;
        if (folder.id) return categoryFolderIds.has(folder.id);
      }
      return false;
    };

    const filtered = categoryDocs.filter(matchesFolder);
    if (!filtered.length && CONFIG.RMF?.debug) {
      console.warn(`RMF | No category documents found in folder "Categories" for pack ${collection}`);
    }
    return filtered;
  }
}
