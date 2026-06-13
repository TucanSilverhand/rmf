/**
 * RMF Item Sheet using ApplicationV2 Architecture
 *
 * Redefinido para que el proceso de actualización sea IGUAL al de actor-sheet:
 * - Cambios granulares por campo (change) con this.document.update({ [name]: value })
 * - Coerción de tipos (Number, Boolean) según type/data-dtype
 * - Logs claros con path y valor actualizado
 *
 * @class RMFItemSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { coerceInputValue, buildEntityTag, initHeaderAutoHeight, bindChangeListeners, wireTabs, setActiveTab as utilSetActiveTab } from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

const RARITY_CHOICES = ["common", "uncommon", "rare", "very rare", "legendary"];

export class RMFItemSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: {
      submitOnChange: false,
      closeOnSubmit: false,
    },
    classes: ['rmf', 'sheet', 'item'],
    window: {
      icon: 'fas fa-suitcase',
      title: 'RMF.ItemSheet',
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ['rmf-item-sheet'],
      minWidth: 500,
      minHeight: 600,
    },
    position: {
      width: 600,
      height: 800,
      left: 100,
      top: 50,
    },
    actions: {
      toggleEquipped: RMFActions.handlers.toggleEquipped
    }
  };

  static PARTS = {
    ...super.PARTS,
    form: { template: 'systems/rmf/templates/item-sheet.hbs', scrollable: [".sheet-body"] }
  };

  // Tabs apply to the equipment template only; race routes to its own sheet.
  static TABS = {
    primary: {
      tabs: [
        { id: "view", icon: "fas fa-eye", label: "RMF.Tabs.View" },
        { id: "edit", icon: "fas fa-pen", label: "RMF.Tabs.Edit" }
      ]
    }
  };

  get parts() {
    const base = this.constructor.PARTS || {};
    const parts = { ...base };
    if (this.document.type === 'race') {
      parts.form = { template: 'systems/rmf/templates/item-race-sheet.hbs' };
    }
    return parts;
  }

  get position() {
    const base = super.position;
    if (this.document.type === 'race') {
      return {
        ...base,
        width: Math.max(base.width || 600, 600),
        height: Math.max(base.height || 800, 800)
      };
    }
    return base;
  }

  get title() {
    return `${this.document.name} - ${game.i18n.localize('RMF.ItemSheet')}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.document;
    context.system = this.document.system;
    context.flags = this.document.flags;
    context.config = CONFIG.RMF;
    context.isEditable = this.isEditable;
    context.isRace = this.document.type === 'race';

    context.editable = this.isEditable;

    // Enriquecido solo para vistas (no afecta a guardado granular)
    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        this.document.system.description || '',
        { async: true, secrets: this.document.isOwner }
      );
    } catch {}

    // Equipment: rarity select options + read-only display label.
    const sys = this.document.system ?? {};
    const localize = (k) => game.i18n.has(k) ? game.i18n.localize(k) : null;
    context.rarityOptions = RARITY_CHOICES.map((value) => ({
      value, label: localize(`RMF.Items.Rarities.${value}`) ?? value, selected: (sys.rarity ?? "common") === value
    }));
    context.rarityLabel = (localize(`RMF.Items.Rarities.${sys.rarity}`) ?? sys.rarity ?? "");

    return context;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._setupTabs(this.element);
    this._bindChangeListeners(this.element);
    this._initHeaderAutoHeight(this.element);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._setupTabs(this.element);
    this._bindChangeListeners(this.element);
    if (!this._headerResizeObserver) this._initHeaderAutoHeight(this.element);
    const fallback = this.constructor.TABS?.primary?.tabs?.[0]?.id ?? null;
    const existing = this.element?.querySelector?.(".sheet-tabs .item.active")?.dataset?.tab;
    const active = this._activeTab || existing || fallback;
    if (active) this._setActiveTab(active, this.element);
  }

  _setupTabs(html) {
    const element = html?.querySelector ? html : this.element;
    if (element) wireTabs(element, (tab, el) => this._setActiveTab(tab, el));
  }

  _setActiveTab(tab, html) {
    this._activeTab = tab;
    const element = html?.querySelector ? html : this.element;
    if (element) utilSetActiveTab(tab, element);
  }

  /**
   * Initialize dynamic header height variable for CSS layout
   * Sets --rmf-header-height on the sheet root so CSS can position
   * the scrollable body reliably under the header.
   * @param {HTMLElement} root
   * @private
   */
  _initHeaderAutoHeight(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    initHeaderAutoHeight(element);
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

  const value = coerceInputValue(target);
    const type = (target.getAttribute?.('type') || '').toLowerCase();
    const isNumeric = type === 'number' || target.dataset?.dtype === 'Number' || name.startsWith('system.stats.') || name.startsWith('system.resistances.');
    const tag = buildEntityTag(this.document);
    if (CONFIG?.RMF?.debug) {
      console.debug('RMF DEBUG | ItemSheet granular update', { item: tag, name, value, isNumeric, type });
    }
    console.log(`RMF | ${tag} Update ${name} => ${value}`);

    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error('RMF ERROR | Item update failed', { name, err });
      ui.notifications?.error(err?.message || 'Update failed');
    }
  }

  // Coercion handled by shared helper
  // Action handlers now centralized in RMFActions
}
