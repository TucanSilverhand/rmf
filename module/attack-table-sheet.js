/**
 * RMF Attack Table Sheet
 *
 * Two-tab layout (same helper-driven architecture as the spell-list /
 * profession sheets):
 *  - "table":   read-only matrix — armor-group headers, the AT columns
 *               (20 → 1) and every roll band, each cell colour-coded by
 *               its parsed kind (plain hit / critical / miss / fumble).
 *  - "resolve": a small form (OB / mods / target AT / target DB) plus a
 *               "Roll Attack" button that runs the table engine
 *               (`game.rmf.tables.resolveAttack`), shows the result inline
 *               and posts a chat card.
 *
 * The grid is intentionally read-only: a 40×20 table is edited via JSON
 * import (`game.rmf.importAttackTables` / `syncAttackTablesToCompendium`),
 * not by hand — exactly how the spell lists work.
 *
 * @class RMFAttackTableSheet
 * @extends {HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)}
 */
const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  bindChangeListeners,
  coerceInputValue,
  initHeaderAutoHeight,
  setActiveTab as utilSetActiveTab,
  wireTabs
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";
import { parseCell } from "./tables/index.mjs";

export class RMFAttackTableSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "attackTable"],
    window: {
      icon: "fas fa-table-cells",
      title: "RMF.AttackTableSheet",
      resizable: true,
      minimizable: true,
      contentClasses: ["rmf-attack-table-sheet"],
      minWidth: 720,
      minHeight: 560
    },
    position: { width: 980, height: 760 },
    actions: {
      pickImage: RMFActions.handlers.pickImage,
      resolveAttack: RMFAttackTableSheet.#onResolveAttack
    }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-attack-table-sheet.hbs",
      scrollable: [".sheet-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "table",   icon: "fas fa-table-cells", label: "RMF.AttackTable.TableTab" },
        { id: "resolve", icon: "fas fa-dice-d20",    label: "RMF.AttackTable.ResolveTab" }
      ]
    }
  };

  get title() {
    return `${this.document.name} - ${game.i18n.localize("RMF.AttackTableSheet")}`;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    const sys = doc?.system ?? {};
    context.item       = doc;
    context.system     = sys;
    context.config     = CONFIG.RMF;
    context.isEditable = this.isEditable;
    context.editable   = this.isEditable;

    // Column order is driven by the armor-type groups so the header and
    // the body always line up. Fall back to the derived (descending) AT
    // list when the table has no explicit groups.
    const groups = Array.isArray(sys.armorTypes) && sys.armorTypes.length
      ? sys.armorTypes
      : [{ name: "", ats: Array.isArray(sys.columns) ? sys.columns : [] }];
    const columnOrder = groups.flatMap(g => (Array.isArray(g.ats) ? g.ats : []));

    context.armorGroups = groups.map(g => ({
      name: g.name ?? "",
      span: Array.isArray(g.ats) ? g.ats.length : 0
    }));
    context.columns = columnOrder;

    // Build the visible grid. Each cell carries its raw text and a CSS
    // modifier so the stylesheet can tint hits / crits / misses / fumbles.
    const rows = Array.isArray(sys.rows) ? sys.rows : [];
    context.gridRows = rows.map(row => ({
      label: row?.label ?? "",
      cells: columnOrder.map(at => {
        const raw = row?.results?.[String(at)];
        const parsed = parseCell(raw);
        return {
          at,
          text: (parsed.kind === "miss") ? "" : (parsed.raw || ""),
          kind: parsed.kind,
          hasCrit: !!parsed.critSeverity
        };
      })
    }));

    // Fumble row (rendered as a footer band).
    context.fumbleRow = {
      label: sys.fumble?.label ?? "",
      cells: columnOrder.map(at => ({ at, text: sys.fumble?.results?.[String(at)] ?? "" }))
    };

    // Sticky resolve-form state + last result.
    context.resolve = this._resolveState ?? { ob: 0, mods: 0, targetAT: 1, targetDB: 0 };
    context.lastResult = this._lastResult ? this.#viewResult(this._lastResult) : null;

    // Legend entries (cell-notation key), if present in the source.
    const legend = sys.legend && typeof sys.legend === "object" ? sys.legend : {};
    context.legendRows = Object.entries(legend).map(([key, text]) => ({ key, text }));

    return context;
  }

  /** Shape an engine result for display (localised, pre-formatted). */
  #viewResult(r) {
    const localize = k => game.i18n.localize(k);
    let outcome;
    if (r.fumble) outcome = localize("RMF.AttackTable.Fumble");
    else if (r.cell?.kind === "miss") outcome = localize("RMF.AttackTable.Miss");
    else {
      outcome = `${r.cell?.hits ?? 0} ${localize("RMF.AttackTable.Hits")}`;
      if (r.cell?.critSeverity) outcome += ` + ${r.cell.critSeverity} ${r.critType}`.trimEnd();
    }
    return {
      natural: r.natural,
      rollTotal: r.rollTotal,
      openHigh: r.openHigh,
      attackTotal: r.attackTotal,
      targetAT: r.targetAT,
      outcome,
      needsCritical: r.needsCritical,
      critHint: r.needsCritical
        ? game.i18n.format("RMF.AttackTable.ChatNeedsCrit", {
            severity: r.cell.critSeverity, critType: r.critType
          })
        : ""
    };
  }

  /* ───────────────────────── Lifecycle ───────────────────────── */

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
   * Change handler. Resolve-form inputs are cached on the instance (not
   * persisted); meta inputs (name + system scalars) write through.
   *
   * @param {Event} event
   * @private
   */
  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.("name");
    if (!name) return;

    // Resolve form — keep the values on the instance so a re-render after
    // rolling restores them; never written to the document.
    if (name.startsWith("resolve.")) {
      const key = name.slice("resolve.".length);
      this._resolveState = { ...(this._resolveState ?? { ob: 0, mods: 0, targetAT: 1, targetDB: 0 }) };
      this._resolveState[key] = Number(coerceInputValue(target)) || 0;
      return;
    }

    try {
      const value = coerceInputValue(target);
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | AttackTableSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }

  /* ───────────────────────── Actions ───────────────────────── */

  /**
   * "Roll Attack" handler. Reads the resolve form, runs the engine,
   * stores the result for inline display and posts a chat card.
   *
   * @this {RMFAttackTableSheet}
   * @param {Event} event
   * @param {HTMLElement} target
   * @private
   */
  static async #onResolveAttack(event, target) {
    event?.preventDefault?.();
    const root = this.element;
    const num = (key, def = 0) => {
      const el = root?.querySelector?.(`[name="resolve.${key}"]`);
      const n = Number(el?.value);
      return Number.isFinite(n) ? n : def;
    };

    const params = {
      table: this.document.system,
      ob: num("ob"),
      mods: num("mods"),
      targetAT: num("targetAT", 1),
      targetDB: num("targetDB")
    };
    this._resolveState = { ob: params.ob, mods: params.mods, targetAT: params.targetAT, targetDB: params.targetDB };

    try {
      const result = await game.rmf.tables.resolveAttack(params);
      this._lastResult = result;
      await this.#postChat(result);
      await this.render();
    } catch (err) {
      console.error("RMF ERROR | resolveAttack failed", err);
      ui.notifications?.error(err?.message || "Attack resolution failed");
    }
  }

  /** Post a compact attack chat card (with the open-ended dice attached). */
  async #postChat(result) {
    const L = k => game.i18n.localize(k);
    const view = this.#viewResult(result);
    const title = game.i18n.format("RMF.AttackTable.ChatTitle", {
      name: this.document.name, at: result.targetAT
    });

    const rollLine = result.openHigh
      ? `${result.natural} → ${result.rollTotal} (${L("RMF.AttackTable.OpenEnded")})`
      : `${result.natural}`;

    const esc = s => Handlebars.escapeExpression(s);
    const content = `
      <div class="rmf-attack-card">
        <h3>${esc(title)}</h3>
        <div class="line"><span>${L("RMF.AttackTable.NaturalRoll")}:</span> <b>${rollLine}</b></div>
        <div class="line"><span>${L("RMF.AttackTable.AttackTotal")}:</span> <b>${result.attackTotal}</b></div>
        <div class="outcome ${result.fumble ? "is-fumble" : (result.needsCritical ? "is-crit" : "")}">${esc(view.outcome)}</div>
        ${view.needsCritical ? `<div class="crit-hint">${esc(view.critHint)}</div>` : ""}
      </div>`;

    const messageData = {
      speaker: ChatMessage.getSpeaker(),
      content,
      rolls: Array.isArray(result.rolls) ? result.rolls : [],
      flavor: this.document.name
    };
    const rollMode = game.settings.get("rmf", "defaultRollMode");
    ChatMessage.applyRollMode(messageData, rollMode);
    await ChatMessage.create(messageData);
  }
}
