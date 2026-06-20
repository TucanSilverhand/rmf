/**
 * RMF Character Sheet using ApplicationV2 Architecture
 * 
 * Modern actor sheet implementation for RoleMaster Fantasy system using
 * FoundryVTT v13.341's ApplicationV2 with HandlebarsApplicationMixin.
 * Features responsive design, tabbed navigation, declarative actions,
 * and integrated stat/skill rolling mechanics.
 * 
 * @class RMFActorSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  coerceInputValue,
  buildEntityTag,
  wireTabs,
  setActiveTab as utilSetActiveTab,
  initHeaderAutoHeight,
  ACTOR_HEADER_BREAKPOINTS,
  splitInHalf
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";
import { RMF_CONSTANTS } from "./utils/constants.mjs";
import { dpConsumptionByLevel } from "./utils/dp-cost.mjs";
import { resolveTrainingPackageCost } from "./profession-cost.mjs";
import { matchesIdentity, buildSlugIndex, resolveFromIndex, identityKey } from "./utils/slug.mjs";

export class RMFActorSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2) {

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    
    // Form configuration
    form: {
      submitOnChange: false,
      closeOnSubmit: false,
    },
    
    // CSS classes
    classes: ['rmf', 'sheet', 'actor', 'character-sheet'],
    
    // Window configuration
    window: {
      icon: 'fas fa-user',
      title: 'RMF.CharacterSheet',
      resizable: true,
      positioned: true,
      contentClasses: ['rmf-actor-sheet'],
      minimizable: true
    },
    
    // Position and size configuration
    position: {
      width: 700,
      height: 522
    },
    
    // Declarative actions - using centralized RMFActions
    actions: {
      rollStat: RMFActions.handlers.rollStat,
      rollSkill: RMFActions.handlers.rollSkill,
      rollDefensive: RMFActions.handlers.rollDefensive,
      rollResistance: RMFActions.handlers.rollResistance,
      rollCategory: RMFActions.handlers.rollCategory,
      rollCategoryNoSkill: RMFActions.handlers.rollCategoryNoSkill,
      editItem: RMFActions.handlers.editItem,
      deleteItem: RMFActions.handlers.deleteItem,
      createItem: RMFActions.handlers.createItem,
      pickImage: RMFActions.handlers.pickImage,
      // Stat-gain log row management (thin wrappers so `this` = the sheet).
      addStatGain(event, target) { return this._onAddStatGain(event, target); },
      deleteStatGain(event, target) { return this._onDeleteStatGain(event, target); },
    },
    
    // Drag and drop
    dragDrop: [
      { dragSelector: '.item', dropSelector: null }
    ]
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/actor-sheet.hbs",
      // Declaramos contenedor scrollable siguiendo patrón ARS (ver doc 05_ApplicationV2_Sheets_Advanced.md)
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        {
          id: 'background',
          icon: 'fas fa-user',
          label: 'RMF.Tabs.Background'
        },
        {
          id: 'stats',
          icon: 'fas fa-chart-bar',
          label: 'RMF.Tabs.Stats'
        },
        {
          id: 'skills',
          icon: 'fas fa-list',
          label: 'RMF.Tabs.Skills'
        },
        {
          id: 'equipment',
          icon: 'fas fa-shield-alt',
          label: 'RMF.Tabs.Equipment'
        },
        {
          id: 'manageplayer',
          icon: 'fas fa-user-cog',
          label: 'RMF.Tabs.ManagePlayer'
        }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.CharacterSheet")}`;
  }

  /**
   * Prepare context data for template rendering
   * 
   * Aggregates actor data, items organized by type, derived statistics,
   * and UI configuration for the character sheet template.
   * 
   * @param {ApplicationRenderOptions} options - Rendering options
   * @returns {Promise<Object>} Complete template context with actor data
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    
    // Add document data
    context.actor = this.document;
    context.system = this.document.system;
    context.flags = this.document.flags;
    
    // Add system configuration
    context.config = CONFIG.RMF;
    
    // Add editor properties for compatibility
    context.owner = this.document.isOwner;
    context.editable = this.isEditable;
    
    // Organize items by type
    context.items = {};
    for (let item of this.document.items) {
      const type = item.type;
      if (!context.items[type]) context.items[type] = [];
      context.items[type].push(item);
    }
    // Keep each item-type group alphabetically sorted for stable UX in Manage Player.
    for (const groupedItems of Object.values(context.items)) {
      groupedItems.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), game.i18n.lang));
    }

    // Group skills under their parent category for the Skills tab.
    // The relation is resolved by stable identity (slug, falling back to
    // slugified name) so it tolerates case, the "·" middot, and renames.
    // See module/utils/slug.mjs.
    const categories = context.items.category || [];
    const skills = context.items.skill || [];
    const categoryIndex = buildSlugIndex(categories);
    const skillsByCategoryId = new Map(categories.map(c => [c.id, []]));
    const uncategorized = [];

    for (const skill of skills) {
      const cat = resolveFromIndex(categoryIndex, skill.system?.category);
      if (cat) skillsByCategoryId.get(cat.id).push(skill);
      else uncategorized.push(skill);
    }

    const sortByName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), game.i18n.lang);
    context.categoriesWithSkills = categories.map(category => {
      const categoryTotal = Number(category.system?.totalBonus ?? 0) || 0;
      const progression = String(category.system?.categoryRankBonusProgression ?? "").trim().toLowerCase();
      return {
        category,
        noSkillTotal: categoryTotal + RMF_CONSTANTS.NO_SKILL_PENALTY,
        // The -15 untrained penalty only makes sense for the standard progression.
        // Non-standard categories don't expose the No-skill action.
        showNoSkill: progression === "standard",
        skills: skillsByCategoryId.get(category.id).sort(sortByName)
      };
    });
    context.uncategorizedSkills = uncategorized.sort(sortByName);

    // Stat-gain log rows enriched with a localized stat <select> option list
    // (the template avoids relying on an `eq` helper).
    const statKeys = Object.keys(this.document.system.chStats ?? {});
    context.statGainRows = (this.document.system.statGainLog ?? []).map((row, index) => ({
      index,
      level: row.level,
      stat: row.stat,
      previous: row.previous,
      final: row.final,
      options: statKeys.map(k => ({
        key: k,
        label: game.i18n.localize(`RMF.Stats.${k}`),
        selected: k === row.stat
      }))
    }));

    // Stat-modifications table (manual temp/pot edit), split into two columns.
    const statAdjustRows = statKeys.map(k => {
      const s = this.document.system.chStats[k] || {};
      return { key: k, label: game.i18n.localize(`RMF.Stats.${k}`), temp: s.temp, pot: s.pot };
    });
    const statAdjustSplit = splitInHalf(statAdjustRows);
    context.statAdjustLeft = statAdjustSplit.left;
    context.statAdjustRight = statAdjustSplit.right;

    // DP consumption grouped by character level (ranks bought at level >= 1).
    // The per-rank cost resets each level; cost comes from each item's
    // dpCostParsed (assigned from the profession's categoryPrice).
    const dpLang = game.i18n.lang;
    const dpKindLabel = {
      category: game.i18n.localize("RMF.DPConsumption.KindCategory"),
      skill: game.i18n.localize("RMF.DPConsumption.KindSkill"),
      trainingPackage: game.i18n.localize("RMF.DPConsumption.KindTrainingPackage")
    };
    const dpLevelMap = new Map();
    const dpBucket = (level) => {
      if (!dpLevelMap.has(level)) dpLevelMap.set(level, { level, total: 0, rows: [] });
      return dpLevelMap.get(level);
    };
    const addDpItem = (item, kind) => {
      for (const { level, ranks, dp } of dpConsumptionByLevel(item.system?.boughtByLevel, item.system?.dpCostParsed)) {
        const bucket = dpBucket(level);
        bucket.rows.push({ kind, kindLabel: dpKindLabel[kind], name: item.name, ranks, dp });
        bucket.total += dp;
      }
    };
    for (const item of this.document.itemTypes.category ?? []) addDpItem(item, "category");
    for (const item of this.document.itemTypes.skill ?? []) addDpItem(item, "skill");
    // Training packages: each shows at its takenAtLevel with the DP cost from
    // the actor's profession (profession.trainingPackages, matched by slug).
    for (const tp of this.document.itemTypes.trainingPackage ?? []) {
      const level = Math.max(0, Math.floor(Number(tp.system?.takenAtLevel) || 0));
      const dp = Number(resolveTrainingPackageCost(tp, this.document)) || 0;
      const bucket = dpBucket(level);
      bucket.rows.push({ kind: "trainingPackage", kindLabel: dpKindLabel.trainingPackage, name: tp.name, ranks: "—", dp });
      bucket.total += dp;
    }
    const dpKindOrder = { category: 0, skill: 1, trainingPackage: 2 };
    const dpLevels = [...dpLevelMap.values()].sort((a, b) => a.level - b.level);
    for (const lvl of dpLevels) {
      lvl.rows.sort((a, b) => (dpKindOrder[a.kind] - dpKindOrder[b.kind])
        || String(a.name).localeCompare(String(b.name), dpLang));
    }
    context.dpLevels = dpLevels;
    context.dpGrandTotal = dpLevels.reduce((s, l) => s + l.total, 0);

    // Add effects
    context.effects = this._prepareEffects();
    
    // Add UI state
    context.isEditable = this.isEditable;
    context.isCharacter = this.document.type === "character";

    return context;
  }

  /**
   * Initialize sheet on first render
   * 
   * Sets up tab navigation and responsive header sizing on the
   * initial render of the character sheet.
   * 
   * @param {Object} context - Prepared template context
   * @param {ApplicationRenderOptions} options - Rendering options
   * @override
   */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._setupTabs(this.element);
    this._initHeaderAutoHeight(this.element);
    
    // Force minimum size after render
    setTimeout(() => {
      this._enforceMinimumSizePostRender();
    }, 50);
  }

  /**
   * Enforce minimum size after the window is fully rendered
   * This approach avoids constructor issues
   */
  _enforceMinimumSizePostRender() {
    // In ApplicationV2, this.element is the root application element
    const windowElement = this.element;
    if (!windowElement) return;

    const minWidth = 700;
    const minHeight = 500;
    
    // Force minimum size via direct style
    windowElement.style.minWidth = `${minWidth}px`;
    windowElement.style.minHeight = `${minHeight}px`;
    
    // Check current size and force resize if needed
    const rect = windowElement.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) {
      const newWidth = Math.max(rect.width, minWidth);
      const newHeight = Math.max(rect.height, minHeight);
      
      // Use FoundryVTT's setPosition method
      this.setPosition({ width: newWidth, height: newHeight });
    }
  }

  /**
   * Refresh sheet components on each render
   * 
   * Reestablishes tab navigation, stat input listeners, and responsive
   * header sizing after template re-rendering.
   * 
   * @param {Object} context - Prepared template context
   * @param {ApplicationRenderOptions} options - Rendering options
   * @override
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this._setupTabs(this.element);
    this._setupStatListeners(this.element);
    this._setupGenericChangeListeners(this.element);
    this._setupNumericSanitizers(this.element);
  // Re-bind header observers each render — the helper detects an existing
  // ResizeObserver on the element and disconnects before re-binding.
  this._initHeaderAutoHeight(this.element);
  // Restore scroll and active tab after re-render
  try {
    if (this._pendingScrollTop != null) {
      const body = (this.element?.querySelector ? this.element : null)?.querySelector?.('.sheet-body');
      if (body) body.scrollTop = this._pendingScrollTop;
      this._pendingScrollTop = null;
    }
    if (this._activeTab) this._setActiveTab(this._activeTab, this.element);
  } catch {}
  }

  /**
   * Initialize tab navigation. Delegates click-binding to the shared
   * `wireTabs` helper; the only sheet-specific concern here is picking
   * the initial tab to activate (preserve last selection across re-renders,
   * fall back to whatever DOM marks as active, then to "stats").
   *
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _setupTabs(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element?.querySelectorAll) return;

    wireTabs(element, (tab, el) => this._setActiveTab(tab, el));

    const currentActive = this._activeTab || element.querySelector('.sheet-tabs .item.active')?.dataset?.tab;
    this._setActiveTab(currentActive || 'stats', element);
  }

  /**
   * Handle drag & drop events on the actor sheet.
   * Implements modern v13 pattern to accept dropped Item documents
   * and embed them in the actor. We primarily care about Item type
   * "race", but support any item drop consistently.
   *
   * References:
   * - Documentation/FoundryVTT_v13/Documents/Actor_System.md:1023
   * - Documentation/FoundryVTT_v13/Documents/Actor_System.md:1039
   *
   * @param {DragEvent} event
   * @returns {Promise<unknown>}
   */
  async _onDrop(event) {
    // Use v13+ namespaced TextEditor to avoid deprecation
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (!data?.type) return super._onDrop?.(event);

    if (data.type === 'Item') {
      return this._onDropItem(event, data);
    }

    // Fallback to super for other drop types
    return super._onDrop?.(event);
  }

  /**
   * Handle dropping an Item on the actor sheet. If the item is external
   * (from sidebar or another actor), create an embedded copy on this actor.
   * If it already exists and is stackable (has quantity), increase it.
   *
   * @param {DragEvent} event
   * @param {object} data
   * @returns {Promise<unknown>}
   */
  async _onDropItem(event, data) {
    if (!this.document.isOwner) return false;

    // Resolve the dropped Item document using the v13 API
    const item = await Item.implementation.fromDropData(data);
    // Ignore if dropping an item already owned by this actor
    if (item?.parent?.id === this.document.id) return false;
    const itemData = item.toObject();

    // Enforce single race per actor
    if (item.type === 'race') {
      const hasRace = this.document.items.some(i => i.type === 'race');
      if (hasRace) {
        ui.notifications?.warn(game.i18n.localize('RMF.Messages.AlreadyHasRace') || 'You already have a race assigned');
        return false;
      }
      // Create race and sync chRace field and stat race modifiers
      delete itemData._id;
      const created = await this.document.createEmbeddedDocuments('Item', [itemData]);
      const raceName = itemData.name || created?.[0]?.name || '';
      const stats = (itemData.system && itemData.system.stats) ? itemData.system.stats : {};
      const updateData = { 'system.chRace': raceName };
      for (const [shortKey, longKey] of Object.entries(CONFIG.RMF.statShortToFull)) {
        const val = Number(stats?.[shortKey] ?? 0) || 0;
        updateData[`system.chStats.${longKey}.race`] = val;
      }
      await this.document.update(updateData);

      // Apply racial ranks: write boughtByLevel.0 on each matching category /
      // skill, auto-creating missing skill items from world or compendium.
      try {
        await this._applyRacialRanksFromRace(itemData?.system?.racialRanks);
      } catch (err) {
        console.error('RMF | Failed applying racial ranks on race drop', err);
      }

      // Apply special skills: tag matching skills as "everyman" / "restricted",
      // auto-creating missing skills the same way racial ranks does.
      try {
        await this._applySpecialSkillsFromRace(itemData?.system?.specialSkills);
      } catch (err) {
        console.error('RMF | Failed applying special skills on race drop', err);
      }
      return created;
    }

    // Enforce single realm per actor
    if (item.type === 'realm') {
      const hasRealm = this.document.items.some(i => i.type === 'realm');
      if (hasRealm) {
        ui.notifications?.warn(game.i18n.localize('RMF.Messages.AlreadyHasRealm') || 'You already have a realm assigned');
        return false;
      }
      // Create realm and sync chRealm field with the realm name
      delete itemData._id;
      const created = await this.document.createEmbeddedDocuments('Item', [itemData]);
      const realmName = itemData.name || created?.[0]?.name || '';
      await this.document.update({ 'system.chRealm': realmName });
      return created;
    }

    // Enforce single profession per actor
    if (item.type === 'profession') {
      const hasProfession = this.document.items.some(i => i.type === 'profession');
      if (hasProfession) {
        ui.notifications?.warn(game.i18n.localize('RMF.Messages.AlreadyHasProfession') || 'You already have a profession assigned');
        return false;
      }
      // Create profession and sync chProfession field with the profession name
      delete itemData._id;
      const created = await this.document.createEmbeddedDocuments('Item', [itemData]);
      const professionName = itemData.name || created?.[0]?.name || '';
      await this.document.update({ 'system.chProfession': professionName });
      return created;
    }

    // Prevent duplicate categories by stable identity (slug → name)
    if (item.type === 'category') {
      const hasCategory = this.document.items.some(i =>
        i.type === 'category' && matchesIdentity(i, item.system?.slug || item.name));
      if (hasCategory) {
        ui.notifications?.warn(game.i18n.localize('RMF.Messages.AlreadyHasCategory') || 'This category is already assigned');
        return false;
      }
    }

    // Optional simple stacking by name+type if quantity exists (non-race)
    const existing = this.document.items.find(i => i.name === item.name && i.type === item.type);
    if (existing && itemData?.system && (existing.system?.quantity ?? undefined) !== undefined) {
      const newQty = Number(existing.system.quantity || 0) + Number(itemData.system.quantity || 1);
      return existing.update({ 'system.quantity': newQty });
    }

    // Create a new embedded instance
    delete itemData._id;
    return this.document.createEmbeddedDocuments('Item', [itemData]);
  }

  /**
   * Apply the racial-ranks block from a race item onto the actor's
   * embedded category and skill items. For each entry:
   *  - Find the matching item by name (case-insensitive).
   *  - Skills missing from the actor are auto-created (sourced from world
   *    items first, then the world.basic-core compendium, falling back to a
   *    minimal stub).
   *  - Set `system.boughtByLevel.0` on the matched/created item to the racial
   *    rank value, replacing any pre-existing value at level 0.
   * Categories are not auto-created; the user is expected to assign them.
   *
   * @param {{categories?: Array<{name: string, ranks: number}>, skills?: Array<{name: string, ranks: number}>}} racialRanks
   * @returns {Promise<void>}
   * @private
   */
  async _applyRacialRanksFromRace(racialRanks) {
    if (!racialRanks || typeof racialRanks !== 'object') return;

    const categories = Array.isArray(racialRanks.categories) ? racialRanks.categories : [];
    const skills = Array.isArray(racialRanks.skills) ? racialRanks.skills : [];

    const findOwnItem = (type, name) => {
      if (!String(name || '').trim()) return null;
      return this.document.items.find(
        i => i.type === type && matchesIdentity(i, name)
      ) ?? null;
    };

    const categoryUpdates = [];
    for (const entry of categories) {
      const name = entry?.name;
      const ranks = Number(entry?.ranks) || 0;
      if (!name) continue;
      const cat = findOwnItem('category', name);
      if (!cat) continue;
      categoryUpdates.push({
        _id: cat.id,
        'system.boughtByLevel.0': ranks
      });
    }
    if (categoryUpdates.length) {
      await this.document.updateEmbeddedDocuments('Item', categoryUpdates);
    }

    if (!skills.length) return;

    // Resolve the source document for any skill that doesn't yet exist on
    // the actor. We query world Items first, then the basic-core compendium.
    // Skills with 0 racial ranks are skipped: there's nothing to seed and
    // we don't want to clutter the actor with empty skills it never gets
    // from the race (existing skills with the same name keep their value).
    const missing = skills.filter(
      e => e?.name && (Number(e?.ranks) || 0) > 0 && !findOwnItem('skill', e.name)
    );
    const skillCreatePayload = [];
    for (const entry of missing) {
      const name = entry.name;
      const ranks = Number(entry.ranks) || 0;
      const sourceData = await this._resolveSkillSourceData(name);
      const itemData = sourceData ?? this._buildStubSkillData(name);
      // Ensure level 0 reflects the racial rank value at creation time.
      itemData.system = itemData.system || {};
      itemData.system.boughtByLevel = { ...(itemData.system.boughtByLevel || {}), 0: ranks };
      skillCreatePayload.push(itemData);
    }
    if (skillCreatePayload.length) {
      await this.document.createEmbeddedDocuments('Item', skillCreatePayload);
    }

    // Now update level-0 on existing skills (those that were already on the
    // actor or just created). We re-query because newly-created docs need
    // their fresh ids.
    const skillUpdates = [];
    for (const entry of skills) {
      const name = entry?.name;
      const ranks = Number(entry?.ranks) || 0;
      if (!name) continue;
      const skill = findOwnItem('skill', name);
      if (!skill) continue;
      // Skip newly-created docs whose level 0 was already seeded above.
      const current = Number(skill.system?.boughtByLevel?.[0] ?? 0);
      if (current === ranks) continue;
      skillUpdates.push({
        _id: skill.id,
        'system.boughtByLevel.0': ranks
      });
    }
    if (skillUpdates.length) {
      await this.document.updateEmbeddedDocuments('Item', skillUpdates);
    }
  }

  /**
   * Apply the special-skills block from a race item onto the actor's embedded
   * skill items. For each entry in `everyman` and `restricted`:
   *  - Find the matching skill by name (case-insensitive).
   *  - Auto-create missing skills (sourced from world items first, then the
   *    world.basic-core compendium, falling back to a minimal stub) so the
   *    flag has a target to live on.
   *  - Set `system.specialStatus` to "everyman" or "restricted".
   * If a skill name appears in both lists, "restricted" wins (last write).
   *
   * @param {{everyman?: Array<{name: string}>, restricted?: Array<{name: string}>}} specialSkills
   * @returns {Promise<void>}
   * @private
   */
  async _applySpecialSkillsFromRace(specialSkills) {
    if (!specialSkills || typeof specialSkills !== 'object') return;

    const everyman = Array.isArray(specialSkills.everyman) ? specialSkills.everyman : [];
    const restricted = Array.isArray(specialSkills.restricted) ? specialSkills.restricted : [];
    if (!everyman.length && !restricted.length) return;

    const findOwnSkill = (name) => {
      if (!String(name || '').trim()) return null;
      return this.document.items.find(
        i => i.type === 'skill' && matchesIdentity(i, name)
      ) ?? null;
    };

    // Build a name → status map ("everyman" first, then "restricted" overrides
    // since restricted is the stronger constraint).
    const statusByName = new Map();
    for (const entry of everyman) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name) continue;
      statusByName.set(identityKey(name), { name, status: 'everyman' });
    }
    for (const entry of restricted) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      if (!name) continue;
      statusByName.set(identityKey(name), { name, status: 'restricted' });
    }
    if (!statusByName.size) return;

    // Auto-create missing skills so the flag has a place to land.
    const missing = [];
    for (const { name } of statusByName.values()) {
      if (!findOwnSkill(name)) missing.push(name);
    }
    const skillCreatePayload = [];
    for (const name of missing) {
      const sourceData = await this._resolveSkillSourceData(name);
      const itemData = sourceData ?? this._buildStubSkillData(name);
      itemData.system = itemData.system || {};
      itemData.system.specialStatus = statusByName.get(identityKey(name)).status;
      skillCreatePayload.push(itemData);
    }
    if (skillCreatePayload.length) {
      await this.document.createEmbeddedDocuments('Item', skillCreatePayload);
    }

    // Update specialStatus on every matched skill (existing or just created).
    const skillUpdates = [];
    for (const { name, status } of statusByName.values()) {
      const skill = findOwnSkill(name);
      if (!skill) continue;
      const current = String(skill.system?.specialStatus ?? 'none');
      if (current === status) continue;
      skillUpdates.push({ _id: skill.id, 'system.specialStatus': status });
    }
    if (skillUpdates.length) {
      await this.document.updateEmbeddedDocuments('Item', skillUpdates);
    }
  }

  /**
   * Locate a skill source document by name. Returns the toObject()-style data
   * (without _id) ready to be embedded. Search order:
   *   1. World items (game.items)
   *   2. Compendium pack "world.basic-core"
   * Returns null when not found anywhere.
   *
   * @param {string} name
   * @returns {Promise<object|null>}
   * @private
   */
  async _resolveSkillSourceData(name) {
    if (!String(name || '').trim()) return null;

    // 1) World items (resolve by stable identity — slug or slugified name)
    const worldHit = game.items.find(
      i => i.type === 'skill' && matchesIdentity(i, name)
    );
    if (worldHit) {
      const data = worldHit.toObject();
      delete data._id;
      delete data.folder;
      return data;
    }

    // 2) Compendium "world.basic-core"
    const pack = game.packs?.get('world.basic-core');
    if (pack && pack.documentName === 'Item') {
      try {
        await pack.getIndex({ fields: ['name', 'type', 'system.slug'] });
        const entry = pack.index.find(
          e => e.type === 'skill' && matchesIdentity(e, name)
        );
        if (entry) {
          const doc = await pack.getDocument(entry._id);
          if (doc) {
            const data = doc.toObject();
            delete data._id;
            delete data.folder;
            return data;
          }
        }
      } catch (err) {
        console.warn('RMF | Compendium lookup for skill failed', name, err);
      }
    }

    return null;
  }

  /**
   * Build a minimal skill payload using the system template defaults when no
   * world / compendium source is available.
   *
   * @param {string} name
   * @returns {object}
   * @private
   */
  _buildStubSkillData(name) {
    const tpl = foundry.utils.getProperty(game.system, 'documentTypes.Item.skill.template');
    const system = tpl ? foundry.utils.duplicate(tpl) : {};
    return {
      name: String(name),
      type: 'skill',
      img: 'icons/svg/book.svg',
      system
    };
  }

  /**
   * Activate specific tab and update UI state
   * 
   * Manages tab button active states and corresponding content panel
   * visibility for the character sheet navigation.
   * 
   * @param {string} tab - Tab identifier to activate
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  /**
   * Activate a tab and remember it for future re-renders. The DOM
   * mutation lives in the shared helper; the only sheet-specific
   * behavior is persisting `this._activeTab`.
   *
   * @param {string} tab
   * @param {HTMLElement} html
   * @private
   */
  _setActiveTab(tab, html) {
    const element = html?.querySelector ? html : this.element;
    if (!element?.querySelectorAll) return;
    this._activeTab = tab;
    utilSetActiveTab(tab, element);
  }

  /**
   * Bind numeric input sanitizers declared via `data-sanitize` attributes.
   * Replaces inline `oninput=` handlers (incompatible with strict CSP).
   *
   * Supported modes:
   *   - "positiveInt2": digits only, max length 2, range 0-99.
   *
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _setupNumericSanitizers(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element?.querySelectorAll) return;

    const inputs = element.querySelectorAll('input[data-sanitize]');
    inputs.forEach(input => {
      if (input._rmfSanitizerBound) return;
      input._rmfSanitizerBound = true;
      const mode = input.dataset.sanitize;
      input.addEventListener('input', () => {
        if (mode === 'positiveInt2') {
          input.value = input.value.replace(/[^0-9]/g, '').slice(0, 2);
        }
      });
    });
  }

  /**
   * Initialize stat input field listeners
   *
   * Binds change handlers to temporary and potential stat input fields
   * to trigger derived stat recalculation on value changes.
   *
   * @param {HTMLElement} html - The sheet's HTML element
   * @private
   */
  _setupStatListeners(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element || !element.querySelector) {
      return;
    }

    // Find all stat input fields (temp and pot)
    const statInputs = element.querySelectorAll('input[name*="chStats"][name*=".temp"], input[name*="chStats"][name*=".pot"]');
    
    statInputs.forEach(input => {
      // Keep a stable bound handler per input to avoid listener duplication on re-render.
      if (input._rmfStatChangeHandler) {
        input.removeEventListener('change', input._rmfStatChangeHandler);
      }

      const boundHandler = this._onStatChange.bind(this);
      input._rmfStatChangeHandler = boundHandler;
      input.addEventListener('change', boundHandler);
    });
  }

  /**
   * Generic change listener to autosave other actor fields (non-stats)
   * Keeps parity with item/race granular updates without double submits.
   * @param {HTMLElement} html
   * @private
   */
  _setupGenericChangeListeners(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element) return;

    // Evitar duplicados en re-render
    if (element._rmfGenericChangeBound) {
      element.removeEventListener('change', element._rmfGenericChangeBound, true);
    }

    const handler = async (ev) => {
      const target = ev.target;
      const name = target?.name || target?.getAttribute?.('name');
      if (!name) return;

      // Ignorar stats temp/pot: tienen su propio listener específico
      if (name.startsWith('system.chStats.') && (name.endsWith('.temp') || name.endsWith('.pot'))) return;

      try {
        // Save UI state before update (active tab + scroll)
        try {
          const root = this.element?.querySelector ? this.element : null;
          const body = root?.querySelector?.('.sheet-body');
          const active = root?.querySelector?.('.sheet-tabs .item.active')?.dataset?.tab;
          if (active) this._activeTab = active;
          if (body) this._pendingScrollTop = body.scrollTop;
        } catch {}
        const value = coerceInputValue(target);
        const tag = buildEntityTag(this.document);
        if (CONFIG?.RMF?.debug) {
          console.debug('RMF DEBUG | ActorSheet granular update', { actor: tag, name, value });
        }

        // Redirigir updates de items embebidos: items.<id>.<path>
        if (name.startsWith('items.')) {
          const parts = name.split('.');
          const itemId = parts[1];
          const itemPath = parts.slice(2).join('.');
          const item = this.document.items.get(itemId);
          if (!item) {
            console.warn(`RMF | Item ${itemId} not found for update path: ${name}`);
            return;
          }
          console.log(`RMF | ${tag} Update ITEM ${itemId} :: ${itemPath} => ${value}`);
          await item.update({ [itemPath]: value });
          return;
        }

        // Indexed stat-gain log rows: rebuild the whole array (dotted
        // array-index updates don't merge reliably in Foundry).
        const gainMatch = name.match(/^system\.statGainLog\.(\d+)\.(level|stat|previous|final)$/);
        if (gainMatch) {
          const idx = Number(gainMatch[1]);
          const field = gainMatch[2];
          const current = foundry.utils.duplicate(this.document.system?.statGainLog ?? []);
          if (!current[idx] || typeof current[idx] !== "object") current[idx] = { level: 0, stat: "", previous: 0, final: 0 };
          current[idx] = { ...current[idx] };
          current[idx][field] = field === "stat" ? String(value ?? "") : (Number(value) || 0);
          console.log(`RMF | ${tag} Update statGainLog[${idx}].${field} => ${value}`);
          await this.document.update({ "system.statGainLog": current });
          return;
        }

        // Update directo al actor para el resto de campos
        console.log(`RMF | ${tag} Update ${name} => ${value}`);
        await this.document.update({ [name]: value });
      } catch (err) {
        console.error('RMF ERROR | Actor generic update failed', err);
        ui.notifications?.error(err?.message || 'Update failed');
      }
    };

    element.addEventListener('change', handler, true);
    element._rmfGenericChangeBound = handler;
  }

  /**
   * Process stat value changes and update actor
   * 
   * Handles input events from stat fields, validates values,
   * and triggers actor data updates with derived stat recalculation.
   * 
   * @param {Event} event - Input change event
   * @returns {Promise<void>}
   * @private
   */
  async _onStatChange(event) {
    const input = event.target;
    const name = input?.name;
    if (!name) return;
    // Save UI state before update (active tab + scroll)
    try {
      const root = this.element?.querySelector ? this.element : null;
      const body = root?.querySelector?.('.sheet-body');
      const active = root?.querySelector?.('.sheet-tabs .item.active')?.dataset?.tab;
      if (active) this._activeTab = active;
      if (body) this._pendingScrollTop = body.scrollTop;
    } catch {}
    let value = coerceInputValue(input);

    // Enforce the temp ≤ pot invariant (PDF p.102): a stat's Temporary value
    // can't exceed its Potential, and Potential can't drop below Temporary.
    const statMatch = name.match(/^system\.chStats\.([A-Za-z]+)\.(temp|pot)$/);
    if (statMatch) {
      const [, statKey, field] = statMatch;
      const stat = this.document.system.chStats?.[statKey];
      const n = Number(value);
      if (stat && Number.isFinite(n)) {
        if (field === "temp") value = Math.min(n, Number(stat.pot) || 0);
        else if (field === "pot") value = Math.max(n, Number(stat.temp) || 0);
      }
    }

    const tag = buildEntityTag(this.document);
    if (CONFIG?.RMF?.debug) {
      console.debug('RMF DEBUG | ActorSheet granular update', { actor: tag, name, value });
    }
    // Visible log identical style to item/race
    console.log(`RMF | ${tag} Update ${name} => ${value}`);

    // Update the actor (granular)
    const updateData = { [name]: value };
    await this.document.update(updateData);
  }

  /**
   * Append a blank row to the stat-gain log (manual level 0+ tracking table).
   * @private
   */
  async _onAddStatGain(event, target) {
    event?.preventDefault?.();
    const current = foundry.utils.duplicate(this.document.system?.statGainLog ?? []);
    current.push({ level: 0, stat: "", previous: 0, final: 0 });
    await this.document.update({ "system.statGainLog": current });
  }

  /**
   * Delete the stat-gain log row identified by the control's data-index.
   * @private
   */
  async _onDeleteStatGain(event, target) {
    event?.preventDefault?.();
    const index = Number(target?.dataset?.index);
    if (!Number.isInteger(index)) return;
    const current = foundry.utils.duplicate(this.document.system?.statGainLog ?? []);
    if (index < 0 || index >= current.length) return;
    current.splice(index, 1);
    await this.document.update({ "system.statGainLog": current });
  }

  /**
   * Organize effects by status for template display
   * 
   * Categorizes actor effects into temporary, passive, and inactive
   * groups for organized UI presentation.
   * 
   * @returns {Object} Effects organized by status category
   * @private
   */
  _prepareEffects() {
    const effects = {
      temporary: [],
      passive: [],
      inactive: []
    };

    for (let effect of this.document.effects) {
      if (effect.disabled) {
        effects.inactive.push(effect);
      } else if (effect.isTemporary) {
        effects.temporary.push(effect);
      } else {
        effects.passive.push(effect);
      }
    }

    return effects;
  }

  // Action handlers removed - now using centralized RMFActions

  /**
   * Initialize dynamic header height adjustment
   * 
   * Calculates the actual header height (including content wrapping on resize)
   * and updates the CSS variable --rmf-header-height used for tab positioning.
   * Responsive pattern adapted from advanced ApplicationV2 sheet techniques.
   * 
   * @param {HTMLElement} root - Root element to initialize
   * @private
   */
  /**
   * Wrapper around the shared `initHeaderAutoHeight` helper. Uses
   * actor-specific breakpoints (taller minimums because the actor header
   * carries name + portrait + level/xp), measures against the sheet
   * element width, and binds a window-resize listener for manual resize.
   *
   * @param {HTMLElement} root
   * @private
   */
  _initHeaderAutoHeight(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    initHeaderAutoHeight(element, {
      breakpoints: ACTOR_HEADER_BREAKPOINTS,
      widthSource: 'sheet',
      bindWindowResize: true
    });
  }

  /**
   * Override setPosition to enforce minimum dimensions
   * @param {Object} position - New position configuration
   * @returns {Object} Applied position
   * @override
   */
  setPosition(position = {}) {
    // Create a copy to avoid modifying the original
    const safePosition = { ...position };
    
    // Enforce minimum dimensions
    if (safePosition.width !== undefined && safePosition.width < 475) {
      safePosition.width = 475;
    }
    
    if (safePosition.height !== undefined && safePosition.height < 500) {
      safePosition.height = 500;
    }
    
    return super.setPosition(safePosition);
  }

  /**
   * Clean up observers and event listeners on sheet close
   * 
   * Prevents memory leaks by properly disconnecting resize observers
   * and removing window event listeners before closing the sheet.
   * 
   * @param {Object} options - Close options
   * @returns {Promise} Super close result
   * @override
   */
  close(options) {
    // Tear down anything attached by initHeaderAutoHeight (the helper
    // stashes observers and the window listener on the DOM root, so we
    // clean them up here too).
    const el = this.element;
    try { el?._rmfHeaderResizeObserver?.disconnect?.(); } catch (_) {}
    try { el?._rmfHeaderMutationObserver?.disconnect?.(); } catch (_) {}
    if (el?._rmfHeaderWindowResizeHandler) {
      window.removeEventListener('resize', el._rmfHeaderWindowResizeHandler);
      el._rmfHeaderWindowResizeHandler = null;
    }
    if (el) {
      el._rmfHeaderResizeObserver = null;
      el._rmfHeaderMutationObserver = null;
    }

    // Clean up the delegated generic-change listener.
    try {
      if (el?._rmfGenericChangeBound) {
        el.removeEventListener('change', el._rmfGenericChangeBound, true);
        el._rmfGenericChangeBound = null;
      }
    } catch (_) {}

    return super.close(options);
  }
}
