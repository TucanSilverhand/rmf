/**
 * RMF Profession Sheet - Specialized Profession Item Interface
 *
 * Two-tab layout aligned with the race / category sheets:
 *  - "details": read-only enriched description + summary tables
 *  - "advanced": fully editable form (description, source, prime stats,
 *    professional bonuses, skill lists, dpCost tables, training packages)
 *
 * Mirrors the category sheet's helper-driven architecture: shared
 * sheet-helpers wire tabs, header auto-height and granular change
 * listeners; the only profession-specific logic lives inside the
 * field-change handler that rewrites indexed arrays atomically (the same
 * trick race-sheet uses for racialRanks / specialSkills rows).
 *
 * @class RMFProfessionSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  buildEntityTag,
  coerceInputValue,
  initHeaderAutoHeight,
  wireTabs,
  setActiveTab as utilSetActiveTab,
  bindChangeListeners
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

export class RMFProfessionSheet extends HandlebarsApplicationMixin(
  foundry.applications.sheets.ItemSheetV2
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "profession"],
    window: {
      icon: "fas fa-user-shield",
      title: "RMF.ProfessionSheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-profession-sheet"],
      minWidth: 560,
      minHeight: 600
    },
    position: { width: 720, height: 760 },
    actions: { pickImage: RMFActions.handlers.pickImage }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-profession-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "details",  icon: "fas fa-info-circle", label: "RMF.Tabs.Details" },
        { id: "advanced", icon: "fas fa-cog",         label: "RMF.Tabs.Advanced" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.ProfessionSheet")}`;
  }

  /**
   * @override
   */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const doc = this.document;
    const sys = doc?.system ?? {};
    context.item = doc;
    context.system = sys;
    context.flags = doc?.flags ?? {};
    context.config = CONFIG.RMF;
    context.isProfession = true;
    context.isEditable = this.isEditable;
    context.owner = doc?.isOwner;
    context.editable = this.isEditable;

    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        sys.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {
      context.enrichedDescription = "";
    }

    // Indexed rows for every editable list, so dot-notation field names
    // can be built from row.index in the template.
    //
    // primeStats persist as canonical chXxx keys; the row carries both
    // the raw `value` (for the <select> in advanced) and a localized
    // `label` resolved against `RMF.Stats.<chXxx>` so the read-only
    // details tab shows "Constitution" / "Constitución" depending on
    // the active language.
    context.primeStatRows = this._preparePrimeStatRows(sys.primeStats);
    context.professionalBonusRows = this._prepareProfessionalBonusRows();
    context.everymanSkillRows = this._prepareNameRows(sys.everymanSkills, { kind: "object" });
    context.occupationalSkillRows = this._prepareNameRows(sys.occupationalSkills, { kind: "object" });
    context.restrictedSkillRows = this._prepareNameRows(sys.restrictedSkills, { kind: "object" });
    context.categoryPriceRows = this._prepareDpCostRows(sys.categoryPrice);
    context.spellPriceRows = this._prepareDpCostRows(sys.spellPrice);
    context.trainingPackageRows = this._prepareTrainingPackageRows();

    // Split helper: long lists render as two side-by-side tables in
    // both the details (read-only) and advanced (editable) tabs to
    // make better use of horizontal space.
    const half = (arr) => {
      const cut = Math.ceil(arr.length / 2);
      return { left: arr.slice(0, cut), right: arr.slice(cut) };
    };
    const catSplit = half(context.categoryPriceRows);
    const tpSplit  = half(context.trainingPackageRows);
    context.categoryPriceLeft       = catSplit.left;
    context.categoryPriceRight      = catSplit.right;
    context.trainingPackagesLeft    = tpSplit.left;
    context.trainingPackagesRight   = tpSplit.right;

    // Stat options for primeStats select inputs (canonical full chXxx keys).
    context.statOptions = this._prepareStatOptions();

    return context;
  }

  /**
   * Prepare indexed `{index, name}` rows. Accepts both string arrays
   * (`kind: "string"`) and object arrays with a `name` field
   * (`kind: "object"`).
   * @param {*} list
   * @param {{kind: "string"|"object"}} options
   * @returns {Array<{index: number, name: string}>}
   * @private
   */
  _prepareNameRows(list, { kind }) {
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => {
      const raw = kind === "object" ? entry?.name : entry;
      return { index, name: typeof raw === "string" ? raw : "" };
    });
  }

  /**
   * Prepare indexed rows for primeStats. Each entry is the canonical
   * stat key (chXxx); the row carries:
   *   - `index` for dot-notation form names
   *   - `value` (raw chXxx, used by the <select> in advanced)
   *   - `label` localized via `RMF.Stats.<chXxx>` for the details view
   *   - `name` (alias of `value`, kept for advanced.hbs which iterates
   *     `primeStatRows` and reads `row.name` for the select's selected check)
   *
   * @param {*} list
   * @returns {Array<{index:number, value:string, name:string, label:string}>}
   * @private
   */
  _preparePrimeStatRows(list) {
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => {
      const value = typeof entry === "string" ? entry : "";
      const labelKey = value ? `RMF.Stats.${value}` : "";
      const label = labelKey && game.i18n.has(labelKey)
        ? game.i18n.localize(labelKey)
        : value;
      return { index, value, name: value, label };
    });
  }

  /**
   * @returns {Array<{index: number, name: string, bonus: number}>}
   * @private
   */
  _prepareProfessionalBonusRows() {
    const list = this.document.system?.professionalBonuses;
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => ({
      index,
      name: typeof entry?.name === "string" ? entry.name : "",
      bonus: Number(entry?.bonus) || 0
    }));
  }

  /**
   * @param {*} list
   * @returns {Array<{index: number, name: string, price1: number, price2: number, price3: number}>}
   * @private
   */
  _prepareDpCostRows(list) {
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => ({
      index,
      name: typeof entry?.name === "string" ? entry.name : "",
      price1: Number(entry?.dpCost?.price1) || 0,
      price2: Number(entry?.dpCost?.price2) || 0,
      price3: Number(entry?.dpCost?.price3) || 0
    }));
  }

  /**
   * @returns {Array<{index: number, name: string, dpCost: number}>}
   * @private
   */
  _prepareTrainingPackageRows() {
    const list = this.document.system?.trainingPackages;
    if (!Array.isArray(list)) return [];
    return list.map((entry, index) => ({
      index,
      name: typeof entry?.name === "string" ? entry.name : "",
      dpCost: Number(entry?.dpCost) || 0
    }));
  }

  /**
   * Build the {value,label} list of canonical chXxx stat keys for the
   * primeStats select inputs. Includes a leading empty-option so a row can
   * be cleared.
   * @returns {Array<{value: string, label: string}>}
   * @private
   */
  _prepareStatOptions() {
    const map = CONFIG.RMF?.statShortToFull || {};
    const options = Object.values(map).map((fullKey) => {
      const lk = `RMF.Stats.${fullKey}`;
      return { value: fullKey, label: game.i18n.has(lk) ? game.i18n.localize(lk) : fullKey };
    });
    options.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    const emptyLabel = game.i18n.has("RMF.Common.Empty") ? game.i18n.localize("RMF.Common.Empty") : "—";
    return [{ value: "", label: emptyLabel }, ...options];
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
    if (!this.element?._rmfHeaderResizeObserver) this._initHeaderAutoHeight(this.element);
    this._bindChangeListeners(this.element);

    const element = this.element?.querySelector ? this.element : null;
    if (!element) return;

    const fallbackTab = this.constructor.TABS?.primary?.tabs?.[0]?.id ?? null;
    const existing = element.querySelector(".sheet-tabs .item.active")?.dataset?.tab;
    const active = this._activeTab || existing || fallbackTab;
    if (active) this._setActiveTab(active, element);
  }

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

  _bindChangeListeners(root) {
    const element = root?.querySelector ? root : this.element;
    if (!element) return;
    bindChangeListeners(element, this._onFieldChange.bind(this));
  }

  /**
   * Granular change handler. Foundry stores arrays atomically, so any row
   * edit on an indexed list (primeStats, professionalBonuses, skill lists,
   * categoryPrice/spellPrice/trainingPackages) must rewrite the entire list
   * to avoid the array-→-object conversion trap.
   * @param {Event} event
   * @private
   */
  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.("name");
    if (!name) return;

    try {
      const value = coerceInputValue(target);
      const tag = buildEntityTag(this.document);
      if (CONFIG?.RMF?.debug) {
        console.debug("RMF DEBUG | ProfessionSheet update", { item: tag, name, value });
      }

      // Prime stats: array of canonical full chXxx strings.
      const primeMatch = name.match(/^system\.primeStats\.(\d+)$/);
      // Professional bonuses: array of {name, bonus}.
      const profBonusMatch = name.match(/^system\.professionalBonuses\.(\d+)\.(name|bonus)$/);
      // Skill lists: arrays of {name}.
      const skillListMatch = name.match(/^system\.(everymanSkills|occupationalSkills|restrictedSkills)\.(\d+)\.name$/);
      // dpCost tables: arrays of {name, dpCost: {price1..3}}.
      const dpCostMatch = name.match(/^system\.(categoryPrice|spellPrice)\.(\d+)\.(?:name|dpCost\.(price1|price2|price3))$/);
      // Training packages: array of {name, dpCost: number}.
      const tpMatch = name.match(/^system\.trainingPackages\.(\d+)\.(name|dpCost)$/);

      if (primeMatch) {
        const index = Number(primeMatch[1]);
        const current = foundry.utils.duplicate(this.document.system?.primeStats ?? []);
        current[index] = String(value ?? "");
        await this.document.update({ "system.primeStats": current });
      } else if (profBonusMatch) {
        const index = Number(profBonusMatch[1]);
        const field = profBonusMatch[2];
        const current = foundry.utils.duplicate(this.document.system?.professionalBonuses ?? []);
        if (!current[index] || typeof current[index] !== "object") current[index] = { name: "", bonus: 0 };
        current[index] = { ...current[index] };
        current[index][field] = field === "bonus" ? Number(value) || 0 : String(value ?? "");
        await this.document.update({ "system.professionalBonuses": current });
      } else if (skillListMatch) {
        const kind = skillListMatch[1];
        const index = Number(skillListMatch[2]);
        const current = foundry.utils.duplicate(this.document.system?.[kind] ?? []);
        if (!current[index] || typeof current[index] !== "object") current[index] = { name: "" };
        current[index] = { ...current[index], name: String(value ?? "") };
        await this.document.update({ [`system.${kind}`]: current });
      } else if (dpCostMatch) {
        const kind = dpCostMatch[1];
        const index = Number(dpCostMatch[2]);
        const priceField = dpCostMatch[3]; // undefined when editing the row's name
        const current = foundry.utils.duplicate(this.document.system?.[kind] ?? []);
        if (!current[index] || typeof current[index] !== "object") {
          current[index] = { name: "", dpCost: { price1: 0, price2: 0, price3: 0 } };
        }
        current[index] = { ...current[index] };
        if (priceField) {
          current[index].dpCost = { ...(current[index].dpCost ?? {}) };
          current[index].dpCost[priceField] = Number(value) || 0;
        } else {
          current[index].name = String(value ?? "");
        }
        await this.document.update({ [`system.${kind}`]: current });
      } else if (tpMatch) {
        const index = Number(tpMatch[1]);
        const field = tpMatch[2];
        const current = foundry.utils.duplicate(this.document.system?.trainingPackages ?? []);
        if (!current[index] || typeof current[index] !== "object") current[index] = { name: "", dpCost: 0 };
        current[index] = { ...current[index] };
        current[index][field] = field === "dpCost" ? Number(value) || 0 : String(value ?? "");
        await this.document.update({ "system.trainingPackages": current });
      } else {
        await this.document.update({ [name]: value });
      }
    } catch (err) {
      console.error("RMF ERROR | ProfessionSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }
}
