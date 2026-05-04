/**
 * RMF Realm Sheet - Specialized Realm Item Interface
 *
 * Realms map a character to one of three Power Point progression
 * tracks (Essence, Channeling, Mentalism) which correspond to the
 * race item's ppEssence / ppChanneling / ppMentalism progressions.
 *
 * @class RMFRealmSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { bindChangeListeners, coerceInputValue, buildEntityTag } from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

const POWER_POINTS_TYPES = ["Essence", "Channeling", "Mentalism"];

export class RMFRealmSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "realm"],
    window: {
      icon: "fas fa-hat-wizard",
      title: "RMF.RealmSheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-realm-sheet"],
      minWidth: 480,
      minHeight: 360
    },
    position: { width: 560, height: "auto" },
    actions: { pickImage: RMFActions.handlers.pickImage }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-realm-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.RealmSheet")}`;
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

    const localize = (key) =>
      game.i18n.has(key) ? game.i18n.localize(key) : key;
    context.powerPointsTypeOptions = POWER_POINTS_TYPES.map((value) => ({
      value,
      label: localize(`RMF.Realm.PowerPointsTypes.${value}`)
    }));
    context.selectedPowerPointsType = system.powerPointsType ?? "Essence";

    // Stat bonus options (full chXxx keys), localized
    const statMap = CONFIG.RMF?.statShortToFull || {};
    const statOptions = Object.values(statMap).map((fullKey) => {
      const lk = `RMF.Stats.${fullKey}`;
      return { value: fullKey, label: game.i18n.has(lk) ? game.i18n.localize(lk) : fullKey };
    });
    statOptions.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    const emptyLabel = game.i18n.has("RMF.Common.Empty") ? game.i18n.localize("RMF.Common.Empty") : "—";
    context.statOptions = [{ value: "", label: emptyLabel }, ...statOptions];
    context.selectedStat1 = system.statBonus?.stat1 ?? "";
    context.selectedStat2 = system.statBonus?.stat2 ?? "";
    context.selectedStat3 = system.statBonus?.stat3 ?? "";

    return context;
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._bindChangeListeners(this.element);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._bindChangeListeners(this.element);
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
      console.debug("RMF DEBUG | RealmSheet granular update", { item: tag, name, value });
    }
    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | Realm update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }
}
