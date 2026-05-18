/**
 * RMF Spell List Sheet
 *
 * Three-tab layout (same helper-driven architecture as the training
 * package / profession sheets):
 *  - "details": read-only summary — meta + the 10-level spell ladder +
 *    special notes.
 *  - "advanced": fully editable form — meta selects, the spell ladder
 *    (name / area / duration / range / type / rrMod / codes /
 *    description) and the special-notes list.
 *  - "key": read-only Spell Description Key (the static rules legend
 *    pulled from `CONFIG.RMF.spellDescriptionKey`, NOT persisted on the
 *    item).
 *
 * Indexed array edits rewrite the whole `spells[]` / `specialNotes[]`
 * array atomically — the same trick the training-package / profession
 * sheets use to dodge Foundry's array-→-object path-update conversion.
 *
 * @class RMFSpellListSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  bindChangeListeners,
  buildEntityTag,
  coerceInputValue,
  initHeaderAutoHeight,
  setActiveTab as utilSetActiveTab,
  wireTabs
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";

const REALM_CHOICES      = ["Channeling", "Essence", "Mentalism"];
const LIST_TYPE_CHOICES  = ["Open", "Closed", "Base"];
const PROFESSION_CHOICES = ["", "Cleric", "Ranger", "Magician", "Dabbler", "Mentalist", "Bard"];

export class RMFSpellListSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "spellList"],
    window: {
      icon: "fas fa-scroll",
      title: "RMF.SpellListSheet",
      resizable: true,
      minimizable: true,
      contentClasses: ["rmf-spell-list-sheet"],
      minWidth: 620,
      minHeight: 620
    },
    position: { width: 820, height: 780 },
    actions: { pickImage: RMFActions.handlers.pickImage }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-spell-list-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "details",  icon: "fas fa-info-circle", label: "RMF.Tabs.Details" },
        { id: "advanced", icon: "fas fa-cog",         label: "RMF.Tabs.Advanced" },
        { id: "key",      icon: "fas fa-key",         label: "RMF.SpellList.KeyTab" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.SpellListSheet")}`;
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

    // Static rules legend — read straight from config, never persisted.
    context.key = CONFIG.RMF?.spellDescriptionKey ?? {};

    context.realmOptions = REALM_CHOICES.map(v => ({
      value: v, label: v, selected: sys.realm === v
    }));
    context.listTypeOptions = LIST_TYPE_CHOICES.map(v => ({
      value: v, label: v, selected: sys.listType === v
    }));
    context.professionOptions = PROFESSION_CHOICES.map(v => ({
      value: v,
      label: v || game.i18n.localize("RMF.SpellList.NoProfession"),
      selected: (sys.profession ?? "") === v
    }));

    // Code glyph + tooltip pulled from the key (no lang needed; the
    // legend text is canonical English in CONFIG.RMF).
    const specialCodes = context.key?.specialCodes ?? {};
    const codeKeys = ["instantaneous", "noPowerPoints", "spellSet"];
    const codeMeta = Object.fromEntries(codeKeys.map(k => [k, {
      sym:   specialCodes?.[k]?.symbol ?? k,
      label: specialCodes?.[k]?.description ?? k
    }]));
    context.codeLegend = codeKeys.map(k => ({ key: k, ...codeMeta[k] }));

    // The spell ladder. Each row carries its index, the raw fields, and
    // a per-code `checked` map so the template can render code toggles
    // without a Handlebars `includes` helper. Descriptions are enriched
    // for the read-only details tab.
    const spells = Array.isArray(sys.spells) ? sys.spells : [];
    context.spellRows = await Promise.all(spells.map(async (s, index) => {
      const codes = Array.isArray(s?.codes) ? s.codes : [];
      let enriched = "";
      try {
        enriched = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
          s?.description || "",
          { async: true, secrets: doc?.isOwner ?? false }
        );
      } catch { enriched = s?.description || ""; }
      return {
        index,
        level:        Number(s?.level) || (index + 1),
        name:         typeof s?.name === "string" ? s.name : "",
        areaOfEffect: typeof s?.areaOfEffect === "string" ? s.areaOfEffect : "",
        duration:     typeof s?.duration === "string" ? s.duration : "",
        range:        typeof s?.range === "string" ? s.range : "",
        type:         typeof s?.type === "string" ? s.type : "",
        rrMod:        (s?.rrMod ?? s?.rrMod === 0) ? s.rrMod : null,
        rrModStr:     (s?.rrMod === null || s?.rrMod === undefined) ? "" : String(s.rrMod),
        description:  typeof s?.description === "string" ? s.description : "",
        enrichedDescription: enriched,
        isEmpty:      !s?.name,
        codeFlags:    codeKeys.map(k => ({
          key: k, checked: codes.includes(k),
          sym: codeMeta[k].sym, label: codeMeta[k].label
        }))
      };
    }));

    context.specialNoteRows = (Array.isArray(sys.specialNotes) ? sys.specialNotes : [])
      .map((note, index) => ({ index, note: typeof note === "string" ? note : "" }));

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
   * Granular change handler. Indexed lists (spells[], specialNotes[])
   * are rebuilt and written whole so Foundry keeps them as arrays.
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
      if (CONFIG?.RMF?.debug) {
        console.debug("RMF DEBUG | SpellListSheet update", {
          item: buildEntityTag(this.document), name, value
        });
      }

      // spells[i].codes.<codeKey> (checkbox toggle)
      const codeMatch = name.match(/^system\.spells\.(\d+)\.codes\.([a-zA-Z]+)$/);
      // spells[i].<field>
      const spellMatch = name.match(/^system\.spells\.(\d+)\.(name|areaOfEffect|duration|range|type|rrMod|description)$/);
      // specialNotes[i]
      const noteMatch = name.match(/^system\.specialNotes\.(\d+)$/);

      if (codeMatch) {
        const index = Number(codeMatch[1]);
        const codeKey = codeMatch[2];
        const spells = foundry.utils.duplicate(this.document.system?.spells ?? []);
        if (!spells[index] || typeof spells[index] !== "object") return;
        const set = new Set(Array.isArray(spells[index].codes) ? spells[index].codes : []);
        if (value) set.add(codeKey); else set.delete(codeKey);
        // Preserve the canonical order (instantaneous, noPowerPoints, spellSet).
        spells[index] = { ...spells[index],
          codes: ["instantaneous", "noPowerPoints", "spellSet"].filter(k => set.has(k)) };
        await this.document.update({ "system.spells": spells });
        return;
      }

      if (spellMatch) {
        const index = Number(spellMatch[1]);
        const field = spellMatch[2];
        const spells = foundry.utils.duplicate(this.document.system?.spells ?? []);
        if (!spells[index] || typeof spells[index] !== "object") return;
        spells[index] = { ...spells[index] };
        if (field === "rrMod") {
          const raw = String(value ?? "").trim();
          spells[index].rrMod = raw === "" ? null : (Number.parseInt(raw, 10) || 0);
        } else {
          spells[index][field] = String(value ?? "");
        }
        await this.document.update({ "system.spells": spells });
        return;
      }

      if (noteMatch) {
        const index = Number(noteMatch[1]);
        const notes = foundry.utils.duplicate(this.document.system?.specialNotes ?? []);
        notes[index] = String(value ?? "");
        await this.document.update({ "system.specialNotes": notes });
        return;
      }

      // Top-level scalars (name, system.realm, system.listType, ...).
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | SpellListSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }
}
