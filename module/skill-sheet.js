/**
 * RMF Skill Sheet - Specialized Skill Item Interface
 *
 * Sheet for Item type "skill" mirroring the structure of the Category sheet:
 * - Details (read-only summary)
 * - Progression (DP cost + rank-bonus progression)
 * - Advanced (editable: category select, source, bought-by-level, description)
 *
 * @class RMFSkillSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { coerceInputValue, buildEntityTag, initHeaderAutoHeight, wireTabs, setActiveTab as utilSetActiveTab, bindChangeListeners } from "./utils/sheet-helpers.mjs";
import {
  SKILL_PROGRESSIONS,
  normalizeSkillProgression
} from "./utils/rank-bonus.mjs";
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
      minWidth: 560,
      minHeight: 600
    },
    position: {
      width: 640,
      height: 720
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
        { id: "advanced", icon: "fas fa-cog", label: "RMF.Tabs.Advanced" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.SkillSheet")}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    const system = doc.system || {};
    context.item = doc;
    context.system = system;
    context.flags = doc.flags || {};
    context.config = CONFIG.RMF;
    context.isEditable = this.isEditable;
    context.owner = doc.isOwner;
    context.editable = this.isEditable;

    try {
      const HTMLField = foundry?.data?.fields?.HTMLField;
      context.descriptionField = HTMLField ? new HTMLField() : null;
    } catch {
      context.descriptionField = null;
    }

    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        system.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {
      context.enrichedDescription = "";
    }

    context.dpCostSummary = this._formatDPCost(system.dpCost);

    // Progression options driven by the rank-bonus helper (single source of truth).
    const localizeProgression = (value) => {
      const suffix = value.charAt(0).toUpperCase() + value.slice(1);
      const key = `RMF.Skill.Progressions.${suffix}`;
      return game.i18n.has(key) ? game.i18n.localize(key) : value;
    };
    context.progressionOptions = SKILL_PROGRESSIONS.map((value) => ({ value, label: localizeProgression(value) }));
    context.selectedProgression = normalizeSkillProgression(system.skillRankBonusProgression);
    context.rankBonusProgressionLabel = localizeProgression(context.selectedProgression);

    // Totals are pre-computed by SkillData.prepareDerivedData and live
    // on `system.*`. The sheet only re-exposes them under shorter aliases
    // for templates.
    context.totalRanks       = Number(system.totalRanks       ?? 0);
    context.totalRankBonus   = Number(system.totalRankBonus   ?? 0);
    context.categoryBonus    = Number(system.categoryBonus    ?? 0);
    context.professionBonus  = Number(system.profBonus        ?? 0);
    context.spec1Bonus       = Number(system.spec1Bonus       ?? 0);
    context.spec2Bonus       = Number(system.spec2Bonus       ?? 0);
    context.totalBonus       = Number(system.totalBonus       ?? 0);
    context.rankBonusSummary = String(system.rankBonusSummary ?? "0");

    // Category select: when embedded on an actor, expose its categories so the user picks
    // from a deterministic list. Otherwise let them type the name freely.
    const actor = doc.parent;
    if (actor?.documentName === "Actor") {
      const categories = actor.items.filter(i => i.type === "category");
      const emptyLabel = game.i18n?.localize ? game.i18n.localize("RMF.Common.Empty") : "—";
      context.categoryMode = "select";
      context.categoryOptions = [
        { value: "", label: emptyLabel },
        ...categories
          .map(c => ({ value: c.name, label: c.name }))
          .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang))
      ];
    } else {
      context.categoryMode = "text";
      context.categoryOptions = [];
    }
    context.selectedCategory = system.category ?? "";

    // Bought-by-level entries up to the parent actor's level (parity with category sheet).
    const parentLevel = Number(actor?.system?.chLevel ?? 0);
    context.parentLevel = parentLevel;
    context.hasActorParent = actor?.documentName === "Actor";
    context.levelEntries = this._prepareLevelEntries(system.boughtByLevel, parentLevel);

    return context;
  }

  _formatDPCost(cost) {
    const prices = cost && typeof cost === "object" ? cost : {};
    const p1 = Number(prices.price1 ?? prices[0] ?? 0) || 0;
    const p2 = Number(prices.price2 ?? prices[1] ?? 0) || 0;
    const p3 = Number(prices.price3 ?? prices[2] ?? 0) || 0;
    return `${p1}/${p2}/${p3}`;
  }

  _prepareLevelEntries(boughtByLevel, maxLevel) {
    const entries = [];
    const source = boughtByLevel && typeof boughtByLevel === "object" ? boughtByLevel : {};
    const limit = Number.isFinite(maxLevel) && maxLevel >= 0 ? Math.floor(maxLevel) : 0;
    for (let level = 0; level <= limit; level += 1) {
      const key = String(level);
      entries.push({ level: key, amount: Number(source[key] ?? 0) });
    }
    return entries;
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

    const fallbackTab = this.constructor.TABS?.primary?.tabs?.[0]?.id ?? null;
    const existing = this.element?.querySelector?.(".sheet-tabs .item.active")?.dataset?.tab;
    const active = this._activeTab || existing || fallbackTab;
    if (active) this._setActiveTab(active, this.element);
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

  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.("name");
    if (!name) return;
    const value = coerceInputValue(target);
    const tag = buildEntityTag(this.document);
    if (CONFIG?.RMF?.debug) {
      console.debug("RMF DEBUG | SkillSheet granular update", { item: tag, name, value });
    }
    console.log(`RMF | ${tag} Update ${name} => ${value}`);
    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | Skill update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }
}
