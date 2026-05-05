/**
 * RMF Training Package Sheet
 *
 * Read-mostly sheet for training package items: top-level descriptive
 * fields (timeToAcquire, startingMoney, statGains, fromBook) are
 * editable; the special[] and categoryRanks[] tables render read-only
 * because the canonical authoring path is data/training_packages.json
 * + game.rmf.syncTrainingPackagesToCompendium.
 *
 * @class RMFTrainingPackageSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { bindChangeListeners, coerceInputValue, buildEntityTag } from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

export class RMFTrainingPackageSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "trainingPackage"],
    window: {
      icon: "fas fa-graduation-cap",
      title: "RMF.TrainingPackageSheet",
      resizable: true,
      positioned: true,
      minimizable: true,
      contentClasses: ["rmf-training-package-sheet"],
      minWidth: 560,
      minHeight: 600
    },
    position: { width: 640, height: 720 },
    actions: { pickImage: RMFActions.handlers.pickImage }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-training-package-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.TrainingPackageSheet")}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    const system = doc.system || {};
    context.item     = doc;
    context.system   = system;
    context.flags    = doc.flags || {};
    context.config   = CONFIG.RMF;
    context.isEditable = this.isEditable;
    context.owner    = doc.isOwner;
    context.editable = this.isEditable;

    try {
      context.enrichedDescription = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        system.description || "",
        { async: true, secrets: doc?.isOwner ?? false }
      );
    } catch {
      context.enrichedDescription = "";
    }

    // Readable summary rows for the special table.
    context.specialRows = (system.special ?? []).map((entry, index) => ({
      index,
      name:   typeof entry?.name === "string" ? entry.name : "",
      dpCost: Number(entry?.dpCost) || 0
    }));

    // Flatten categoryRanks for an indented summary in the template.
    // Each category emits one row; each nested skill emits a row with
    // `isSkill: true` so the template renders it indented.
    const summary = [];
    for (const cat of (system.categoryRanks ?? [])) {
      summary.push({
        kind: "category",
        name: cat?.category ?? "",
        ranks: Number(cat?.ranks) || 0,
        isChoice: !!cat?.isChoice
      });
      for (const skill of (cat?.skills ?? [])) {
        summary.push({
          kind: "skill",
          name: skill?.name ?? "",
          ranks: Number(skill?.ranks) || 0,
          isChoice: !!skill?.isChoice
        });
      }
    }
    context.categoryRanksSummary = summary;

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
      console.debug("RMF DEBUG | TrainingPackageSheet update", { item: tag, name, value });
    }
    try {
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | Training package update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }
}
