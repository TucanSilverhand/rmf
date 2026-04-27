/**
 * RMF Category Sheet - Specialized Category Item Interface
 *
 * @class RMFCategorySheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { buildEntityTag, coerceInputValue, initHeaderAutoHeight, wireTabs, setActiveTab as utilSetActiveTab, bindChangeListeners } from "./utils/sheet-helpers.mjs";
import {
  CATEGORY_PROGRESSIONS,
  computeCategoryRankBonus,
  formatCategoryRankBonusBreakdown,
  normalizeCategoryProgression
} from "./utils/rank-bonus.mjs";
import { RMFActions } from "./actions.mjs";

export class RMFCategorySheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "category"],
    window: {
      icon: "fas fa-layer-group",
      title: "RMF.CategorySheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-category-sheet"],
      minWidth: 560,
      minHeight: 600
    },
    position: { width: 640, height: 720 },
    actions: { pickImage: RMFActions.handlers.pickImage }
  };

  static PARTS = {
    ...super.PARTS,
    form: { template: "systems/rmf/templates/item-category-sheet.hbs", scrollable: [".sheet-body"] }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "basic", icon: "fas fa-info-circle", label: "RMF.Tabs.Basic" },
        { id: "advanced", icon: "fas fa-cog", label: "RMF.Tabs.Advanced" }
      ]
    }
  };

  get title() { return `${this.document.name} - ${game.i18n.localize("RMF.CategorySheet")}`; }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    context.item = doc;
    context.system = doc.system || {};
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
        context.system.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {}

    // Normalize stat options and current selections
    const normalizedStat1 = this._normalizeStatKey(context.system?.statBonus?.stat1);
    const normalizedStat2 = this._normalizeStatKey(context.system?.statBonus?.stat2);
    const normalizedStat3 = this._normalizeStatKey(context.system?.statBonus?.stat3);
    context.statOptions = this._prepareStatOptions();
    context.selectedStat1 = normalizedStat1;
    context.selectedStat2 = normalizedStat2;
    context.selectedStat3 = normalizedStat3;
    context.statLabels = this._prepareStatLabels(normalizedStat1, normalizedStat2, normalizedStat3);
    context.statLabelSummary = this._formatStatLabelSummary(context.statLabels);
    context.statShortSummary = this._formatStatShortSummary(normalizedStat1, normalizedStat2, normalizedStat3);
    context.groupOptions = CATEGORY_GROUPS.map((entry) => ({
      value: entry.value,
      label: game.i18n.has(entry.label) ? game.i18n.localize(entry.label) : entry.value
    }));

    context.progressionOptions = CATEGORY_PROGRESSIONS.map((value) => ({
      value,
      label: this._localizeRankProgression(value)
    }));
    context.selectedProgression = normalizeCategoryProgression(context.system?.categoryRankBonusProgression);

    context.totalStatsBonus = this._computeSelectedStatSum(normalizedStat1, normalizedStat2, normalizedStat3);
    context.dpCostSummary = this._formatDPCost(context.system?.dpCost);

    const totalBoughtRanks = this._computeTotalBoughtRanks(context.system?.boughtByLevel);
    const freeRanks = Number(context.system?.freeRanks ?? 0);
    const racialRanks = Number(context.system?.racialRanks ?? 0);
    context.totalBoughtRanks = totalBoughtRanks;
    context.freeRanks = freeRanks;
    context.racialRanks = racialRanks;
    context.totalRanks = totalBoughtRanks + freeRanks + racialRanks;
    const progression = context.system?.categoryRankBonusProgression || 'standard';
    context.totalRankBonus = this._computeRankBonus(context.totalRanks, progression);

    context.professionBonus = Number(context.system?.profBonus ?? 0);
    context.spec1Bonus = Number(context.system?.spec1Bonus ?? 0);
    context.spec2Bonus = Number(context.system?.spec2Bonus ?? 0);
    
    // Use pre-calculated totalBonus from prepareDerivedData (data-models.mjs)
    // Falls back to manual calculation if not available for any reason
    context.totalBonus = context.system?.totalBonus ?? (context.totalRankBonus + context.totalStatsBonus + context.professionBonus + context.spec1Bonus + context.spec2Bonus);
    context.rankBonusProgressionLabel = this._localizeRankProgression(progression);
    context.rankBonusSummary = this._formatRankBonusBreakdown(context.totalRanks, progression);

    const parentLevel = Number(doc?.parent?.system?.chLevel ?? 0);
    context.parentLevel = parentLevel;
    context.hasActorParent = doc?.parent?.documentName === "Actor";
    context.levelEntries = this._prepareLevelEntries(context.system?.boughtByLevel, parentLevel);

    return context;
  }

  _normalizeStatKey(value) {
    if (!value || typeof value !== 'string') return '';
    if (value.startsWith('ch')) return value;
    const map = CONFIG.RMF?.statShortToFull || {};
    return map[value] || value;
  }

  _prepareStatOptions() {
    const map = CONFIG.RMF?.statShortToFull || {};
    const options = Object.entries(map).map(([shortKey, fullKey]) => {
      const localizationKey = `RMF.Stats.${fullKey}`;
      const label = game.i18n.has(localizationKey) ? game.i18n.localize(localizationKey) : fullKey;
      return { value: fullKey, label };
    });
    options.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    const emptyLabel = game.i18n?.localize ? game.i18n.localize("RMF.Common.Empty") : "—";
    return [{ value: "", label: emptyLabel }, ...options];
  }

  _prepareStatLabels(stat1, stat2, stat3) {
    const labelFor = (fullKey) => {
      if (!fullKey) return '';
      const localizationKey = `RMF.Stats.${fullKey}`;
      return game.i18n.has(localizationKey) ? game.i18n.localize(localizationKey) : fullKey;
    };
    return {
      stat1: labelFor(stat1),
      stat2: labelFor(stat2),
      stat3: labelFor(stat3)
    };
  }

  _formatStatLabelSummary(labels) {
    const labelList = [labels?.stat1, labels?.stat2, labels?.stat3].filter(Boolean);
    if (!labelList.length) {
      return game.i18n?.localize ? game.i18n.localize("RMF.Common.Empty") : "—";
    }
    return labelList.join(" + ");
  }

  _formatStatShortSummary(stat1, stat2, stat3) {
    const map = CONFIG.RMF?.statShortToFull || {};
    const inverse = Object.fromEntries(Object.entries(map).map(([shortKey, fullKey]) => [fullKey, shortKey]));
    const shortList = [stat1, stat2, stat3]
      .map((key) => {
        if (!key) return null;
        return inverse[key] || key;
      })
      .filter(Boolean);
    if (!shortList.length) {
      return game.i18n?.localize ? game.i18n.localize("RMF.Common.Empty") : "—";
    }
    return shortList.join("/");
  }

  _computeRankBonus(totalRanks, progression) {
    return computeCategoryRankBonus(totalRanks, progression);
  }

  _formatRankBonusBreakdown(totalRanks, progression) {
    return formatCategoryRankBonusBreakdown(totalRanks, progression);
  }

  /**
   * Compute the sum of the selected stats' totals from the parent actor, if any.
   * Falls back to 0 when the item is not embedded in an Actor.
   * @param {string} s1 - normalized stat key (e.g., chAgility)
   * @param {string} s2 - normalized stat key (e.g., chConstitution)
   * @param {string} s3 - normalized stat key (e.g., chSelfDiscipline)
   * @returns {number}
   * @private
   */
  _computeSelectedStatSum(s1, s2, s3) {
    const parent = this.document.parent;
    if (!parent || parent.documentName !== 'Actor') return 0;
    const ch = parent.system?.chStats ?? {};
    const keys = [s1, s2, s3].filter(Boolean);
    return keys.reduce((acc, k) => acc + (Number(ch[k]?.total || 0)), 0);
  }

  _formatDPCost(cost) {
    const prices = cost && typeof cost === 'object' ? cost : {};
    const p1 = Number(prices.price1 ?? 0);
    const p2 = Number(prices.price2 ?? 0);
    const p3 = Number(prices.price3 ?? 0);
    return `${p1}/${p2}/${p3}`;
  }

  _computeTotalBoughtRanks(boughtByLevel) {
    if (!boughtByLevel || typeof boughtByLevel !== 'object') return 0;
    return Object.values(boughtByLevel).reduce((sum, value) => sum + Number(value ?? 0), 0);
  }

  _localizeRankProgression(value) {
    const normalized = normalizeCategoryProgression(value);
    const keySuffix = normalized === "nonstandard" ? "NonStandard" : "Standard";
    const key = `RMF.Category.Progressions.${keySuffix}`;
    return game.i18n.has(key) ? game.i18n.localize(key) : normalized;
  }

  _prepareLevelEntries(boughtByLevel, maxLevel) {
    const entries = [];
    const source = boughtByLevel && typeof boughtByLevel === 'object' ? boughtByLevel : {};
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
    const element = this.element?.querySelector ? this.element : null;
    if (!element) return;

    const fallbackTab = this.constructor.TABS?.primary?.tabs?.[0]?.id ?? null;
    const existing = element.querySelector(".sheet-tabs .item.active")?.dataset?.tab;
    const active = this._activeTab || existing || fallbackTab;
    if (active) this._setActiveTab(active, element);
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
    const { value } = coerceInputValue(target);
    const tag = buildEntityTag(this.document);
    if (CONFIG?.RMF?.debug) {
      console.debug("RMF DEBUG | CategorySheet granular update", { item: tag, name, value });
    }
    console.log(`RMF | ${tag} Update ${name} => ${value}`);
    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | Category update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
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

}
const CATEGORY_GROUPS = Object.freeze([
  { value: "none", label: "RMF.Category.Groups.None" },
  { value: "Armor", label: "RMF.Category.Groups.Armor" },
  { value: "Artistic", label: "RMF.Category.Groups.Artistic" },
  { value: "Athletic", label: "RMF.Category.Groups.Athletic" },
  { value: "Awareness", label: "RMF.Category.Groups.Awareness" },
  { value: "Body Development", label: "RMF.Category.Groups.BodyDevelopment" },
  { value: "Combat Maneuvers", label: "RMF.Category.Groups.CombatManeuvers" },
  { value: "Communications", label: "RMF.Category.Groups.Communications" },
  { value: "Craft", label: "RMF.Category.Groups.Craft" },
  { value: "Directed Spells", label: "RMF.Category.Groups.DirectedSpells" },
  { value: "Influence", label: "RMF.Category.Groups.Influence" },
  { value: "Lore", label: "RMF.Category.Groups.Lore" },
  { value: "Martial Arts", label: "RMF.Category.Groups.MartialArts" },
  { value: "Outdoor", label: "RMF.Category.Groups.Outdoor" },
  { value: "Power Awareness", label: "RMF.Category.Groups.PowerAwareness" },
  { value: "Power Point Development", label: "RMF.Category.Groups.PowerPointDevelopment" },
  { value: "Science", label: "RMF.Category.Groups.Science" },
  { value: "Self Control", label: "RMF.Category.Groups.SelfControl" },
  { value: "Subterfuge", label: "RMF.Category.Groups.Subterfuge" },
  { value: "Technical", label: "RMF.Category.Groups.Technical" },
  { value: "Urban", label: "RMF.Category.Groups.Urban" },
  { value: "Weapon", label: "RMF.Category.Groups.Weapon" }
]);
