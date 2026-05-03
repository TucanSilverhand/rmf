/**
 * RMF System - RoleMaster Fantasy System for FoundryVTT v13.341
 * 
 * This is the main entry point for the RMF (RoleMaster Fantasy) system.
 * It implements the classic RoleMaster tabletop RPG mechanics in FoundryVTT
 * using modern ApplicationV2 architecture and best practices.
 * 
 * @fileoverview Main system initialization and configuration
 * @version 1.0.0
 * @author TucanSilverhand
 * @since FoundryVTT v13.341
 * 
 * @requires FoundryVTT v13.330+
 * @implements ApplicationV2 architecture
 * @follows FoundryVTT v13.341 best practices
 */

// Import custom documents and application sheets
import { RMFActorSheet } from "./module/actor-sheet.js";
import { RMFItemSheet } from "./module/item-sheet.js";
import { RMFRaceSheet } from "./module/race-sheet.js";
import { RMFSkillSheet } from "./module/skill-sheet.js";
import { RMFCategorySheet } from "./module/category-sheet.js";
import { RMFRealmSheet } from "./module/realm-sheet.js";
import { RMFProfessionSheet } from "./module/profession-sheet.js";
import { RMFActor, RMFItem } from "./module/data-models.mjs";
import { RMFHooks } from "./module/hooks.mjs";
import { SKILL_CLASSIFICATIONS } from "./module/utils/rank-bonus.mjs";
import { STAT_SHORT_TO_FULL, RMF_CONSTANTS } from "./module/utils/constants.mjs";

/**
 * Global system namespace for RMF system configuration and utilities
 * @global
 * @namespace RMF
 */
globalThis.RMF = {};

/**
 * System initialization hook - Main entry point for RMF system setup
 * 
 * This hook runs once when FoundryVTT initializes and performs all necessary
 * system configuration including document registration, sheet registration,
 * settings, handlebars helpers, and template preloading.
 * 
 * @async
 * @function initializeRMFSystem
 * @memberof Hooks
 * @listens Hooks#init
 */
Hooks.once('init', async function() {
  console.log('RMF | Initializing RoleMaster Fantasy System v13.341');
  
  // Register custom document classes with FoundryVTT
  CONFIG.Actor.documentClass = RMFActor;
  CONFIG.Item.documentClass = RMFItem;
  
  // Register system settings before other initialization
  _registerSystemSettings();

  
  
  // Register ApplicationV2-based document sheets
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, "rmf", RMFActorSheet, { 
    types: ["character"],
    makeDefault: true,
    template: "systems/rmf/templates/actor-sheet.hbs"
  });
  
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf", RMFItemSheet, { 
    types: ["equipment"],
    makeDefault: true,
    label: "RMF.ItemSheet"
  });

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf-race", RMFRaceSheet, { 
    types: ["race"],
    makeDefault: true,
    label: "RMF.RaceSheet"
  });
  
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf-skill", RMFSkillSheet, { 
    types: ["skill"],
    makeDefault: true,
    label: "RMF.SkillSheet"
  });
  
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf-category", RMFCategorySheet, {
    types: ["category"],
    makeDefault: true,
    label: "RMF.CategorySheet"
  });

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf-realm", RMFRealmSheet, {
    types: ["realm"],
    makeDefault: true,
    label: "RMF.RealmSheet"
  });

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, "rmf-profession", RMFProfessionSheet, {
    types: ["profession"],
    makeDefault: true,
    label: "RMF.ProfessionSheet"
  });
  // Initialize RMF system configuration namespace.
  // The version is read from system.json at runtime (game.system.version),
  // so we never duplicate the source of truth.
  CONFIG.RMF = {
    get version() { return game.system?.version ?? null; },
    debug: false, // Will be configured in ready hook based on settings
    
    // RoleMaster-specific configuration mappings
    resistanceTypes: {
      ess: "RMF.Resistances.essence",
      chan: "RMF.Resistances.channeling", 
      ment: "RMF.Resistances.mentalism",
      pois: "RMF.Resistances.poison",
      dis: "RMF.Resistances.disease"
    },
    
    // Stat key mappings for reuse across sheets (short <-> full).
    // Source of truth lives in module/utils/constants.mjs; we expose it on
    // CONFIG.RMF so that handlebars helpers and other runtime callers do
    // not need to import the module directly.
    statShortToFull: STAT_SHORT_TO_FULL,

    itemTypes: ["equipment", "race", "skill", "category", "realm", "profession"],
    actorTypes: ["character"],

    // Canonical skill classifications. Same set used by data-models and importers
    // for normalization. The UI can iterate this list to render <select> options
    // labelled by `RMF.Skills.Classifications.<value>`.
    skillClassifications: SKILL_CLASSIFICATIONS,

    // Gameplay constants (HP_BASE, NO_SKILL_PENALTY, ...). Source of truth
    // lives in module/utils/constants.mjs.
    constants: RMF_CONSTANTS
  };
  
  // Initialize Handlebars integration. `loadTemplates` with the object-form
  // both pre-loads each template and registers it as a partial under the alias
  // (so {{> parts/actor-header}} works without an explicit registerPartial call).
  _registerHandlebarsHelpers();
  await _preloadHandlebarsTemplates();

  // Initialize centralized hooks system
  RMFHooks.initialize();
  
  console.log('RMF | RoleMaster Fantasy System initialized successfully');
});

// All hooks are now managed by RMFHooks - see module/hooks.mjs
Hooks.once("ready", _initializeReadyTimeConfigs);

/**
 * Dynamically import the debug module so its global side-effect
 * (globalThis.RMF_D) only exists when debug mode is on.
 * @returns {Promise<void>}
 * @private
 */
async function _loadDebugModule() {
  if (globalThis.RMF_D) return;
  await import("./module/debug.mjs");
  console.log("RMF | Debug module loaded (RMF_D available)");
}

/**
 * Drop the debug global when the user disables debug mode.
 * The ES module itself stays cached by the browser (modules cannot
 * be unloaded), but the public API surface goes away.
 * @private
 */
function _unloadDebugModule() {
  if (!globalThis.RMF_D) return;
  delete globalThis.RMF_D;
  console.log("RMF | Debug module disabled");
}

/**
 * Register all system settings with FoundryVTT
 * 
 * Configures various system-wide settings including debug mode,
 * initiative formula, auto-calculation options, and default roll modes.
 * All settings are properly categorized and include onChange handlers.
 * 
 * @private
 * @function _registerSystemSettings
 */
function _registerSystemSettings() {
  // Debug mode toggle for development and troubleshooting.
  // When enabled, dynamically loads module/debug.mjs which exposes
  // globalThis.RMF_D for in-console diagnostics.
  game.settings.register("rmf", "debugMode", {
    name: "RMF.Settings.DebugMode.Name",
    hint: "RMF.Settings.DebugMode.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: async value => {
      CONFIG.RMF.debug = value;
      if (value) await _loadDebugModule();
      else _unloadDebugModule();
    }
  });

  // Configurable initiative formula for combat. Uses @stats.<name>
  // because RMFActor.getRollData exposes stats under data.stats.*.
  game.settings.register("rmf", "initiativeFormula", {
    name: "RMF.Settings.InitiativeFormula.Name",
    hint: "RMF.Settings.InitiativeFormula.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "1d100 + @stats.quickness",
    onChange: value => {
      CONFIG.Combat.initiative.formula = value;
    }
  });

  // Automatic calculation of derived statistics
  game.settings.register("rmf", "autoCalculateStats", {
    name: "RMF.Settings.AutoCalculateStats.Name",
    hint: "RMF.Settings.AutoCalculateStats.Hint", 
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Default privacy mode for dice rolls
  game.settings.register("rmf", "defaultRollMode", {
    name: "RMF.Settings.DefaultRollMode.Name",
    hint: "RMF.Settings.DefaultRollMode.Hint",
    scope: "client", 
    config: true,
    type: String,
    choices: {
      "publicroll": "RMF.RollMode.Public",
      "gmroll": "RMF.RollMode.GM", 
      "blindroll": "RMF.RollMode.Blind",
      "selfroll": "RMF.RollMode.Self"
    },
    default: "publicroll"
  });

  // Multi-select rule book availability
  game.settings.register("rmf", "ruleBooks", {
    name: "RMF.Settings.RuleBooks.Name",
    hint: "RMF.Settings.RuleBooks.Hint",
    scope: "world",
    config: true,
    type: Array,
    default: ["none"]
  });
}

/**
 * Register custom Handlebars helpers for RMF system
 * 
 * Provides various template helpers for formatting RoleMaster-specific
 * data including bonuses, abbreviations, currency, and roll formulas.
 * 
 * @private
 * @function _registerHandlebarsHelpers
 */
function _registerHandlebarsHelpers() {
  // Format stat bonus with proper + or - sign
  Handlebars.registerHelper('rmfBonus', function(value) {
    const num = parseInt(value) || 0;
    return num >= 0 ? `+${num}` : `${num}`;
  });

  // Check if numeric value is positive
  Handlebars.registerHelper('rmfIsPositive', function(value) {
    return (parseInt(value) || 0) > 0;
  });

  // Check if numeric value is negative
  Handlebars.registerHelper('rmfIsNegative', function(value) {
    return (parseInt(value) || 0) < 0;
  });

  // Equality helper (rmf-prefixed to avoid clashes with module-registered `eq`).
  Handlebars.registerHelper('rmfEq', function(a, b) { return a === b; });

  // Numeric add helper for index arithmetic in {{#each}} bodies.
  Handlebars.registerHelper('rmfAdd', function(a, b) { return (Number(a) || 0) + (Number(b) || 0); });

  // Format currency values with proper localization
  Handlebars.registerHelper('rmfCurrency', function(value) {
    const num = parseFloat(value) || 0;
    return `${num.toLocaleString()} gp`;
  });

  // Get localized resistance type name
  Handlebars.registerHelper('rmfResistance', function(resistanceKey) {
    return game.i18n.localize(CONFIG.RMF.resistanceTypes[resistanceKey] || resistanceKey);
  });

  // Check if current user can edit the document
  Handlebars.registerHelper('rmfCanEdit', function(document) {
    return document.isOwner;
  });
}

// Helper functions for rule books settings UI (used during init)
// Note: Hook logic has been moved to RMFHooks - see module/hooks.mjs

/**
 * Preload all Handlebars templates and register partials in one pass.
 *
 * Uses the object-form of `loadTemplates`, which both fetches each template
 * and registers it as a Handlebars partial under the alias key. That makes
 * `{{> parts/actor-header}}` work without an explicit `registerPartial` step.
 *
 * @private
 * @async
 * @returns {Promise<Function[]>} Resolves once every template is compiled.
 */
async function _preloadHandlebarsTemplates() {
  const partials = {
    // Top-level sheet templates
    "rmf/actor-sheet": "systems/rmf/templates/actor-sheet.hbs",
    "rmf/item-sheet": "systems/rmf/templates/item-sheet.hbs",
    "rmf/item-race-sheet": "systems/rmf/templates/item-race-sheet.hbs",
    "rmf/item-skill-sheet": "systems/rmf/templates/item-skill-sheet.hbs",
    "rmf/item-category-sheet": "systems/rmf/templates/item-category-sheet.hbs",
    "rmf/item-realm-sheet": "systems/rmf/templates/item-realm-sheet.hbs",
    "rmf/item-profession-sheet": "systems/rmf/templates/item-profession-sheet.hbs",

    // Actor sheet partials
    "parts/actor-header": "systems/rmf/templates/parts/actor-header.hbs",
    "parts/actor-navigation": "systems/rmf/templates/parts/actor-navigation.hbs",
    "parts/actor-background": "systems/rmf/templates/parts/actor-background.hbs",
    "parts/actor-stats": "systems/rmf/templates/parts/actor-stats.hbs",
    "parts/actor-skills": "systems/rmf/templates/parts/actor-skills.hbs",
    "parts/actor-equipment": "systems/rmf/templates/parts/actor-equipment.hbs",
    "parts/actor-manageplayer": "systems/rmf/templates/parts/actor-manageplayer.hbs",

    // Race sheet partials
    "parts/item-race-header": "systems/rmf/templates/parts/item-race-header.hbs",
    "parts/item-race-navigation": "systems/rmf/templates/parts/item-race-navigation.hbs",
    "parts/item-race-details": "systems/rmf/templates/parts/item-race-details.hbs",
    "parts/item-race-advanced": "systems/rmf/templates/parts/item-race-advanced.hbs",

    // Skill sheet partials
    "parts/item-skill-header": "systems/rmf/templates/parts/item-skill-header.hbs",
    "parts/item-skill-navigation": "systems/rmf/templates/parts/item-skill-navigation.hbs",
    "parts/item-skill-details": "systems/rmf/templates/parts/item-skill-details.hbs",
    "parts/item-skill-advanced": "systems/rmf/templates/parts/item-skill-advanced.hbs",

    // Category sheet partials
    "parts/item-category-header": "systems/rmf/templates/parts/item-category-header.hbs",
    "parts/item-category-navigation": "systems/rmf/templates/parts/item-category-navigation.hbs",
    "parts/item-category-details": "systems/rmf/templates/parts/item-category-details.hbs",

    // Realm sheet partials
    "parts/item-realm-header": "systems/rmf/templates/parts/item-realm-header.hbs",
    "parts/item-realm-body": "systems/rmf/templates/parts/item-realm-body.hbs",

    // Profession sheet partials
    "parts/item-profession-header": "systems/rmf/templates/parts/item-profession-header.hbs",
    "parts/item-profession-navigation": "systems/rmf/templates/parts/item-profession-navigation.hbs",
    "parts/item-profession-details": "systems/rmf/templates/parts/item-profession-details.hbs",
    "parts/item-profession-advanced": "systems/rmf/templates/parts/item-profession-advanced.hbs",

    // Chat templates
    "rmf/chat/stat-roll": "systems/rmf/templates/chat/stat-roll.hbs",
    "rmf/chat/race-applied": "systems/rmf/templates/chat/race-applied.hbs"
  };

  return foundry.applications.handlebars.loadTemplates(partials);
}

/**
 * Initialize configurations that require settings to be available
 *
 * Performs final system configuration that depends on user settings
 * being loaded and available. This runs during the 'ready' hook and
 * is async so we can lazy-load module/debug.mjs only when needed.
 *
 * @private
 * @async
 * @function _initializeReadyTimeConfigs
 */
async function _initializeReadyTimeConfigs() {
  // Apply initiative formula from user settings
  const initiativeFormula = game.settings.get("rmf", "initiativeFormula");
  CONFIG.Combat.initiative.formula = initiativeFormula;

  // Apply debug mode setting and lazy-load debug helpers when enabled
  CONFIG.RMF.debug = game.settings.get("rmf", "debugMode");
  if (CONFIG.RMF.debug) await _loadDebugModule();
}

/**
 * Export main system classes for external access
 * 
 * Makes the core system classes available for modules and other
 * systems that might need to interact with RMF components.
 * 
 * @exports RMFActor - Custom Actor document class
 * @exports RMFItem - Custom Item document class  
 * @exports RMFActorSheet - ApplicationV2 Actor sheet
 * @exports RMFItemSheet - ApplicationV2 Item sheet
 * @exports RMFRaceSheet - Specialized Race item sheet
 */
export { RMFActor, RMFItem, RMFActorSheet, RMFItemSheet, RMFRaceSheet, RMFSkillSheet, RMFCategorySheet, RMFRealmSheet, RMFProfessionSheet };
