/**
 * RMF Training Package Sheet
 *
 * Two-tab layout aligned with the profession sheet:
 *  - "details": read-only enriched description + summary tables
 *  - "advanced": fully editable form (description, meta scalars, special[]
 *    rows, and the categoryRanks[] tree with nested skills[])
 *
 * Mirrors profession-sheet's helper-driven architecture: shared
 * sheet-helpers wire tabs, header auto-height and granular change
 * listeners. Indexed array edits rewrite the whole array (or nested
 * array) atomically — same trick race/profession sheets use to avoid
 * Foundry's array-→-object conversion trap.
 *
 * @class RMFTrainingPackageSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  bindChangeListeners,
  buildEntityTag,
  coerceInputValue,
  initHeaderAutoHeight,
  setActiveTab as utilSetActiveTab,
  splitInHalf,
  wireTabs
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";
import { applyTrainingPackageToActor, unapplyTrainingPackageFromActor } from "./training-package-apply.mjs";

/**
 * Compendium pack key holding the canonical Categories and Skills used
 * to populate the choice-row dropdowns. Matches the default used by the
 * importer/sync helpers (see `module/importers.mjs`).
 * @type {string}
 */
const BASIC_CORE_PACK = "world.basic-core";

export class RMFTrainingPackageSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  /**
   * Cached list of canonical names from the basic-core compendium.
   * Populated lazily on first sheet render. Invalidate with
   * `RMFTrainingPackageSheet.invalidateChoiceOptionsCache()` after a
   * sync run that changes the canon (importers do not auto-invalidate
   * to keep the dependency direction sheet → importer one-way).
   *
   * @type {{ categories: string[], skills: string[] }|null}
   * @private
   */
  static _choiceOptionsCache = null;

  /**
   * Read the basic-core pack index and return canonical category/skill
   * names sorted in the active locale. Returns empty arrays when the
   * pack is missing (e.g. a fresh world before the user runs the
   * sync helpers) — the template falls back to a plain text input.
   *
   * @returns {Promise<{categories: string[], skills: string[]}>}
   */
  static async getChoiceOptions() {
    if (this._choiceOptionsCache) return this._choiceOptionsCache;
    const pack = game.packs?.get(BASIC_CORE_PACK);
    if (!pack || pack.documentName !== "Item") {
      this._choiceOptionsCache = { categories: [], skills: [] };
      return this._choiceOptionsCache;
    }
    try {
      await pack.getIndex({ fields: ["name", "type"] });
    } catch (err) {
      console.warn("RMF | Failed to read basic-core index", err);
      this._choiceOptionsCache = { categories: [], skills: [] };
      return this._choiceOptionsCache;
    }
    const categories = [];
    const skills = [];
    for (const entry of pack.index) {
      if (entry.type === "category") categories.push(entry.name);
      else if (entry.type === "skill") skills.push(entry.name);
    }
    const cmp = (a, b) => a.localeCompare(b, game.i18n?.lang ?? undefined);
    categories.sort(cmp);
    skills.sort(cmp);
    this._choiceOptionsCache = { categories, skills };
    return this._choiceOptionsCache;
  }

  /** Drop the cached basic-core index so the next sheet render re-reads it. */
  static invalidateChoiceOptionsCache() {
    this._choiceOptionsCache = null;
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "trainingPackage"],
    window: {
      icon: "fas fa-graduation-cap",
      title: "RMF.TrainingPackageSheet",
      resizable: true,
      minimizable: true,
      contentClasses: ["rmf-training-package-sheet"],
      minWidth: 560,
      minHeight: 600
    },
    position: { width: 720, height: 760 },
    actions: {
      pickImage: RMFActions.handlers.pickImage,
      // Thin wrappers so `this` (the sheet instance) reaches the methods.
      applyTrainingPackage(event, target) { return this._onApplyRanks(event, target); },
      recoverTrainingPackage(event, target) { return this._onRecoverRanks(event, target); }
    }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-training-package-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "details",  icon: "fas fa-info-circle", label: "RMF.Tabs.Details" },
        { id: "managed",  icon: "fas fa-sliders",     label: "RMF.Tabs.Managed" },
        { id: "advanced", icon: "fas fa-cog",         label: "RMF.Tabs.Advanced" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.TrainingPackageSheet")}`;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    const sys = doc?.system ?? {};
    context.item       = doc;
    context.system     = sys;
    context.flags      = doc?.flags ?? {};
    context.config     = CONFIG.RMF;
    context.isEditable = this.isEditable;
    context.owner      = doc?.isOwner;
    context.editable   = this.isEditable;

    // Per-actor application controls (Apply / Recover ranks). Only meaningful
    // when the package is embedded on a character; standalone (sidebar /
    // compendium) copies hide them. `actorLevel` caps the "taken at" input.
    const parentActor  = (doc?.parent?.documentName === "Actor") ? doc.parent : null;
    context.isOnActor   = !!parentActor;
    context.applied     = !!sys.applied;
    context.takenAtLevel = Number(sys.takenAtLevel) || 0;
    context.actorLevel  = parentActor ? (Number(parentActor.system?.chLevel) || 0) : 0;

    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        sys.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {
      context.enrichedDescription = "";
    }

    // Indexed rows for the editable special table (advanced tab) and
    // the read-only summary (details tab).
    context.specialRows = (sys.special ?? []).map((entry, index) => ({
      index,
      name:   typeof entry?.name === "string" ? entry.name : "",
      dpCost: Number(entry?.dpCost) || 0
    }));

    // Choice dropdowns: pull canonical names from world.basic-core.
    // Each choice row gets its own `options` array with `selected`
    // pre-stamped so the template doesn't need a `../row.name` path.
    const { categories: catNames, skills: skillNames } =
      await this.constructor.getChoiceOptions();

    // Indexed rows for the editable categoryRanks tree (advanced tab).
    // Each category carries its own skills array with nested skillIndex.
    // For `isChoice` rows we attach `categoryOptions` / `skillOptions`
    // built from the basic-core canon plus the row's `placeholderName`
    // (so the GM can revert to the original choice text after picking).
    context.categoryRankRows = (sys.categoryRanks ?? []).map((cat, catIndex) => {
      const category = typeof cat?.category === "string" ? cat.category : "";
      const isChoice = !!cat?.isChoice;
      const placeholder = (typeof cat?.placeholderName === "string" && cat.placeholderName.length)
        ? cat.placeholderName
        : (isChoice ? category : "");
      return {
        catIndex,
        category,
        ranks:           Number(cat?.ranks) || 0,
        isChoice,
        placeholderName: placeholder,
        categoryOptions: isChoice ? this._buildChoiceOptions(category, placeholder, catNames) : null,
        skills: (cat?.skills ?? []).map((sk, skillIndex) => {
          const name = typeof sk?.name === "string" ? sk.name : "";
          const skIsChoice = !!sk?.isChoice;
          const skPlaceholder = (typeof sk?.placeholderName === "string" && sk.placeholderName.length)
            ? sk.placeholderName
            : (skIsChoice ? name : "");
          return {
            skillIndex,
            name,
            ranks:           Number(sk?.ranks) || 0,
            isChoice:        skIsChoice,
            placeholderName: skPlaceholder,
            skillOptions:    skIsChoice ? this._buildChoiceOptions(name, skPlaceholder, skillNames) : null
          };
        })
      };
    });

    // Two-column splits used by both tabs. categoryRankRows is split by
    // category-block (skills travel with their parent), so a heavy
    // category lands in one column rather than splitting its skills across
    // both — easier to read.
    const specialSplit = splitInHalf(context.specialRows);
    const catSplit     = splitInHalf(context.categoryRankRows);
    context.specialRowsLeft     = specialSplit.left;
    context.specialRowsRight    = specialSplit.right;
    context.categoryRankRowsLeft  = catSplit.left;
    context.categoryRankRowsRight = catSplit.right;

    return context;
  }

  /**
   * Build the option list for a choice-row dropdown.
   *
   * Composition (in order):
   *   1. Placeholder option (the original isChoice text). Always shown
   *      so the GM can revert to "unresolved" after picking a real entry.
   *   2. All canonical names from basic-core, alphabetical.
   *
   * If the placeholder name happens to coincide with a canonical name
   * (rare; typically placeholders are free-form like "choice of one
   * skill") we collapse the duplicate so the option only appears once.
   * The currently-selected `name` is marked accordingly.
   *
   * @param {string} currentName - The row's current `name` value
   * @param {string} placeholderName - The original choice text
   * @param {string[]} canonNames - Sorted list of canonical names
   * @returns {Array<{value: string, label: string, selected: boolean, isPlaceholder: boolean}>}
   * @private
   */
  _buildChoiceOptions(currentName, placeholderName, canonNames) {
    const options = [];
    const safePlaceholder = (placeholderName && placeholderName.length) ? placeholderName : currentName;
    // Placeholder always first; selected if currentName matches it.
    options.push({
      value: safePlaceholder,
      label: safePlaceholder,
      selected: currentName === safePlaceholder,
      isPlaceholder: true
    });
    for (const n of canonNames) {
      if (n === safePlaceholder) continue; // collapse rare duplicate
      options.push({
        value: n,
        label: n,
        selected: currentName === n,
        isPlaceholder: false
      });
    }
    return options;
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
   * Granular change handler. For indexed lists (special[],
   * categoryRanks[], categoryRanks[].skills[]) we rebuild the whole
   * (or nested) array and write it atomically — Foundry stores arrays
   * as objects when path-updated and we want to preserve array shape.
   *
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
        console.debug("RMF DEBUG | TrainingPackageSheet update", { item: tag, name, value });
      }

      // special[i].(name|dpCost)
      const specialMatch = name.match(/^system\.special\.(\d+)\.(name|dpCost)$/);
      // categoryRanks[i].(category|ranks|isChoice)
      const catMatch = name.match(/^system\.categoryRanks\.(\d+)\.(category|ranks|isChoice)$/);
      // categoryRanks[i].skills[j].(name|ranks|isChoice)
      const skillMatch = name.match(/^system\.categoryRanks\.(\d+)\.skills\.(\d+)\.(name|ranks|isChoice)$/);

      if (specialMatch) {
        const index = Number(specialMatch[1]);
        const field = specialMatch[2];
        const current = foundry.utils.duplicate(this.document.system?.special ?? []);
        if (!current[index] || typeof current[index] !== "object") current[index] = { name: "", dpCost: 0 };
        current[index] = { ...current[index] };
        current[index][field] = field === "dpCost" ? Number(value) || 0 : String(value ?? "");
        await this.document.update({ "system.special": current });
        return;
      }

      if (skillMatch) {
        const catIndex = Number(skillMatch[1]);
        const skIndex  = Number(skillMatch[2]);
        const field    = skillMatch[3];
        const current = foundry.utils.duplicate(this.document.system?.categoryRanks ?? []);
        if (!current[catIndex] || typeof current[catIndex] !== "object") {
          current[catIndex] = { category: "", ranks: 0, isChoice: false, skills: [] };
        }
        current[catIndex] = { ...current[catIndex] };
        const skills = Array.isArray(current[catIndex].skills) ? [...current[catIndex].skills] : [];
        if (!skills[skIndex] || typeof skills[skIndex] !== "object") {
          skills[skIndex] = { name: "", ranks: 0, isChoice: false };
        }
        skills[skIndex] = { ...skills[skIndex] };
        if (field === "ranks") skills[skIndex].ranks = Number(value) || 0;
        else if (field === "isChoice") skills[skIndex].isChoice = !!value;
        else skills[skIndex].name = String(value ?? "");
        current[catIndex].skills = skills;
        await this.document.update({ "system.categoryRanks": current });
        return;
      }

      if (catMatch) {
        const catIndex = Number(catMatch[1]);
        const field    = catMatch[2];
        const current = foundry.utils.duplicate(this.document.system?.categoryRanks ?? []);
        if (!current[catIndex] || typeof current[catIndex] !== "object") {
          current[catIndex] = { category: "", ranks: 0, isChoice: false, skills: [] };
        }
        current[catIndex] = { ...current[catIndex] };
        if (field === "ranks") current[catIndex].ranks = Number(value) || 0;
        else if (field === "isChoice") current[catIndex].isChoice = !!value;
        else current[catIndex].category = String(value ?? "");
        await this.document.update({ "system.categoryRanks": current });
        return;
      }

      // Top-level scalars (name, system.description, system.type, …).
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | TrainingPackageSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }

  /**
   * "Apply ranks" button — sum this package's resolved category/skill ranks
   * onto the owning character at the chosen level, then mark it applied.
   * Blocked by the apply logic when it is already applied.
   *
   * @param {Event} event
   * @param {HTMLElement} target
   * @private
   */
  async _onApplyRanks(event, target) {
    event?.preventDefault?.();
    const ok = await applyTrainingPackageToActor(this.document);
    if (ok) this.render(false);
  }

  /**
   * "Recover ranks" button — subtract this package's ranks back off the
   * character and clear the applied flag.
   *
   * @param {Event} event
   * @param {HTMLElement} target
   * @private
   */
  async _onRecoverRanks(event, target) {
    event?.preventDefault?.();
    const ok = await unapplyTrainingPackageFromActor(this.document);
    if (ok) this.render(false);
  }
}
