/**
 * RMF Skill Sheet - Specialized Skill Item Interface
 * 
 * Sheet for Item type "skill" following ApplicationV2 patterns and
 * the same granular update approach used in race and generic items.
 *
 * @class RMFSkillSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { coerceInputValue, buildEntityTag, initHeaderAutoHeight, wireTabs, setActiveTab as utilSetActiveTab, bindChangeListeners } from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

export class RMFSkillSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: {
      submitOnChange: false,
      closeOnSubmit: false,
    },
    classes: ["rmf", "sheet", "item", "skill"],
    window: {
      icon: "fas fa-graduation-cap",
      title: "RMF.SkillSheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-skill-sheet"],
      minWidth: 500,
      minHeight: 600
    },
    position: {
      width: 600,
      height: 700
    },
    actions: {
      pickImage: RMFActions.handlers.pickImage
    }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-skill-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "details", icon: "fas fa-info-circle", label: "RMF.Tabs.Details" },
        { id: "progression", icon: "fas fa-chart-line", label: "RMF.Tabs.Progression" },
        { id: "purchases", icon: "fas fa-level-up-alt", label: "RMF.Tabs.Purchases" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.SkillSheet")}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    context.item = doc;
    context.system = doc.system || {};
    context.flags = doc.flags || {};
    context.config = CONFIG.RMF;
    context.isEditable = this.isEditable;

    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        context.system.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {}

    // Normalize DP cost array for the template (show first 6 entries by default)
    const dp = Array.isArray(context.system.dpCost) ? context.system.dpCost.slice() : [];
    while (dp.length < 6) dp.push(0);
    context.dpCostFixed = dp.slice(0, 6);

    // Prepare boughtByLevel entries for display as [level, amount]
    const bought = context.system.boughtByLevel || {};
    context.boughtEntries = Object.entries(bought).map(([level, amount]) => ({ level, amount }));

    return context;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._setupTabs(this.element);
    this._initHeaderAutoHeight(this.element);
    this._bindChangeListeners(this.element);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._setupTabs(this.element);
    if (!this._headerResizeObserver) this._initHeaderAutoHeight(this.element);
    this._bindChangeListeners(this.element);
  }

  // Action handler removed - now using centralized RMFActions

  _setupTabs(html) {
    const element = html?.querySelector ? html : this.element;
    if (!element) return;
    wireTabs(element, (tab, el) => this._setActiveTab(tab, el));
  }

  _setActiveTab(tab, html) {
    this._activeTab = tab;
    const element = html?.querySelector ? html : this.element;
    if (!element) return;
    utilSetActiveTab(tab, element);
  }

  _initHeaderAutoHeight(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    initHeaderAutoHeight(element);
  }

  async _updateObject(event, formData) {
    try {
      if (CONFIG?.RMF?.debug) {
        const keys = Object.keys(formData || {});
        const meaningful = Object.fromEntries(Object.entries(formData || {}).filter(([k]) => k === 'name' || k.startsWith('system.')));
        console.debug("RMF DEBUG | RMFSkillSheet._updateObject called", { keys, eventType: event?.type, meaningful });
      }
    } catch {}
    return super._updateObject(event, formData);
  }

  _bindChangeListeners(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    bindChangeListeners(element, this._onFieldChange.bind(this));
  }

  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.('name');
    if (!name) return;
    const { value } = coerceInputValue(target);
    const type = (target.getAttribute?.('type') || '').toLowerCase();
    const isNumeric = type === 'number' || target.dataset?.dtype === 'Number' || name.startsWith('system.dpCost.') || name.startsWith('system.boughtByLevel.');
    const tag = buildEntityTag(this.document);
    if (CONFIG?.RMF?.debug) {
      console.debug('RMF DEBUG | SkillSheet granular update', { item: tag, name, value, isNumeric, type });
    }
    console.log(`RMF | ${tag} Update ${name} => ${value}`);
    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error('RMF ERROR | Skill update failed', { name, err });
      ui.notifications?.error(err?.message || 'Update failed');
    }
  }
}
