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
import { parseCell, parseModifierCell } from "./tables/index.mjs";

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
      resolveAttack: RMFAttackTableSheet.#onResolveAttack,
      addRow: RMFAttackTableSheet.#onAddRow,
      removeRow: RMFAttackTableSheet.#onRemoveRow
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
        { id: "table",   icon: "fas fa-table-cells", label: "RMF.Tabs.View" },
        { id: "edit",    icon: "fas fa-pen",         label: "RMF.Tabs.Edit" },
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

    // Table kind drives both the column model and how cells are parsed:
    //  - "attack" (default): AT 1-20 columns grouped under armor names,
    //    cells are hits + optional critical.
    //  - "resistanceMod": categorical columns from `columnDefs`, cells are
    //    signed Resistance-Roll modifiers (or "F" = spell fails).
    const isResistance = sys.tableKind === "resistanceMod";
    context.isResistanceTable = isResistance;

    let columnOrder, headers;
    if (isResistance) {
      const defs = Array.isArray(sys.columnDefs) ? sys.columnDefs : [];
      columnOrder = defs.map(d => d.key);
      headers = defs.map(d => d.label || d.key);
      context.armorGroups = [];
    } else {
      // Column order is driven by the armor-type groups so the header and
      // the body always line up. Fall back to the derived (descending) AT
      // list when the table has no explicit groups.
      const groups = Array.isArray(sys.armorTypes) && sys.armorTypes.length
        ? sys.armorTypes
        : [{ name: "", ats: Array.isArray(sys.columns) ? sys.columns : [] }];
      columnOrder = groups.flatMap(g => (Array.isArray(g.ats) ? g.ats : []));
      headers = columnOrder;
      context.armorGroups = groups.map(g => ({
        name: g.name ?? "",
        span: Array.isArray(g.ats) ? g.ats.length : 0
      }));
    }
    context.columns = headers;

    // One cell shaper per kind, so both grids share the row pipeline below.
    // Modifier cells reuse the fumble tint for "F" (spell fails) and the
    // miss tint for "-" — no new CSS needed.
    const shapeCell = isResistance
      ? (key, raw) => {
          const parsed = parseModifierCell(raw);
          return {
            at: key,
            text: parsed.kind === "none" ? "" : (parsed.raw || ""),
            kind: parsed.kind === "fail" ? "fumble" : (parsed.kind === "none" ? "miss" : parsed.kind),
            hasCrit: false
          };
        }
      : (key, raw) => {
          const parsed = parseCell(raw);
          return {
            at: key,
            text: (parsed.kind === "miss") ? "" : (parsed.raw || ""),
            kind: parsed.kind,
            hasCrit: !!parsed.critSeverity
          };
        };

    const shapeRow = (label, results) => ({
      label: label ?? "",
      cells: columnOrder.map(key => shapeCell(key, results?.[String(key)]))
    });

    // High unmodified-die rows (UM 96-100), rendered above the roll bands
    // like the printed page.
    context.umHighRows = (Array.isArray(sys.umHigh) ? sys.umHigh : [])
      .slice()
      .sort((a, b) => Number(b?.naturalMax ?? 0) - Number(a?.naturalMax ?? 0))
      .map(u => shapeRow(u?.label, u?.results));

    // Build the visible grid. Each cell carries its raw text and a CSS
    // modifier so the stylesheet can tint hits / crits / misses / fumbles.
    const rows = Array.isArray(sys.rows) ? sys.rows : [];
    context.gridRows = rows.map(row => shapeRow(row?.label, row?.results));

    // Fumble row (rendered as a footer band).
    context.fumbleRow = {
      label: sys.fumble?.label ?? "",
      cells: columnOrder.map(key => ({ at: key, text: sys.fumble?.results?.[String(key)] ?? "" }))
    };

    // The crit type / OB mod / max result per attack form (the book's "ATTACK
    // TYPE DATA / SPELL DATA" box) is per-attacker data (weapon item), no longer
    // carried on the shared attack table.
    context.hasAttackTypes = false;

    // Sticky resolve-form state + last result. Resistance tables pick a
    // categorical column instead of a numeric AT.
    const defaultColumn = isResistance ? (columnOrder[0] ?? "") : null;
    context.resolve = this._resolveState
      ?? { ob: 0, mods: 0, targetAT: 1, targetDB: 0, column: defaultColumn };
    context.resolveColumns = isResistance
      ? (Array.isArray(sys.columnDefs) ? sys.columnDefs : []).map(d => ({
          key: d.key,
          label: d.label || d.key,
          selected: (this._resolveState?.column ?? defaultColumn) === d.key
        }))
      : [];
    context.lastResult = this._lastResult ? this.#viewResult(this._lastResult) : null;

    // Legend entries (cell-notation key), if present in the source. Only
    // string values render in the <dl>; the structured `rangeModifiers`
    // array (spell tables) gets its own small table.
    const legend = sys.legend && typeof sys.legend === "object" ? sys.legend : {};
    context.legendRows = Object.entries(legend)
      .filter(([, text]) => typeof text === "string")
      .map(([key, text]) => ({ key, text }));
    context.rangeModifiers = Array.isArray(legend.rangeModifiers)
      ? legend.rangeModifiers.filter(r => r && typeof r === "object")
      : [];

    // Editable-grid context (Editar tab): string cells keyed by the same
    // columnOrder as the read-only grid; columns are structural (AT / column
    // keys) so only labels/cells/bands are edited, not the column set.
    context.editColumns = columnOrder.map((key, index) => ({ index, key: String(key), label: String(headers[index] ?? key) }));
    context.editRows = rows.map((row, index) => ({
      index,
      label: row?.label ?? "",
      rollMin: (row?.rollMin === null || row?.rollMin === undefined) ? "" : row.rollMin,
      rollMax: row?.rollMax ?? 0,
      cells: columnOrder.map(key => ({ key: String(key), value: String(row?.results?.[String(key)] ?? "") }))
    }));
    context.editFumble = {
      label: sys.fumble?.label ?? "",
      cells: columnOrder.map(key => ({ key: String(key), value: String(sys.fumble?.results?.[String(key)] ?? "") }))
    };
    context.columnLabel = game.i18n.localize(isResistance ? "RMF.AttackTable.Column" : "RMF.AttackTable.ArmorType");

    return context;
  }

  /** Shape an engine result for display (localised, pre-formatted). */
  #viewResult(r) {
    const localize = k => game.i18n.localize(k);

    // Resistance-spell result: a RR modifier or a spell failure.
    if ("modifier" in r) {
      let outcome;
      if (r.fails) outcome = localize("RMF.AttackTable.SpellFails");
      else if (r.modifier === null) outcome = localize("RMF.AttackTable.Miss");
      else {
        const sign = r.modifier > 0 ? `+${r.modifier}` : String(r.modifier);
        outcome = game.i18n.format("RMF.AttackTable.RRModifier", { modifier: sign });
      }
      const colDef = (this.document.system.columnDefs ?? []).find(d => d.key === r.column);
      return {
        natural: r.natural,
        rollTotal: r.rollTotal,
        openHigh: r.openHigh,
        attackTotal: r.attackTotal,
        targetAT: colDef?.label ?? r.column,
        outcome,
        needsCritical: false,
        critHint: "",
        umHigh: !!r.umHigh,
        umLabel: r.umLabel ?? ""
      };
    }

    let outcome;
    if (r.fumble) outcome = localize("RMF.AttackTable.Fumble");
    else if (r.cell?.kind === "miss") outcome = localize("RMF.AttackTable.Miss");
    else {
      outcome = `${r.cell?.hits ?? 0} ${localize("RMF.AttackTable.Hits")}`;
      if (r.cell?.critSeverity) outcome += ` + ${r.cell.critSeverity}`;
    }
    return {
      natural: r.natural,
      rollTotal: r.rollTotal,
      openHigh: r.openHigh,
      attackTotal: r.attackTotal,
      targetAT: r.targetAT,
      outcome,
      needsCritical: r.needsCritical,
      // The critical TYPE comes from the attacking weapon, not the table.
      critHint: r.needsCritical
        ? game.i18n.format("RMF.AttackTable.ChatNeedsCrit", { severity: r.cell.critSeverity })
        : "",
      umHigh: !!r.umHigh,
      umLabel: r.umLabel ?? ""
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
    // rolling restores them; never written to the document. `column` is the
    // categorical key on resistance tables (string); the rest are numbers.
    if (name.startsWith("resolve.")) {
      const key = name.slice("resolve.".length);
      this._resolveState = { ...(this._resolveState ?? { ob: 0, mods: 0, targetAT: 1, targetDB: 0 }) };
      this._resolveState[key] = (key === "column")
        ? String(coerceInputValue(target) ?? "")
        : (Number(coerceInputValue(target)) || 0);
      return;
    }

    try {
      // Editar tab: rows is an array (Foundry mangles deep array-path updates),
      // so rewrite it whole. Attack cells are plain strings ("12E").
      const dup = (arr) => foundry.utils.duplicate(Array.isArray(arr) ? arr : []);
      let m;
      if ((m = name.match(/^system\.rows\.(\d+)\.(label|rollMin|rollMax)$/))) {
        const i = Number(m[1]), field = m[2];
        const rows = dup(this.document.system.rows);
        if (!rows[i]) return;
        if (field === "rollMin") {
          const raw = String(target.value ?? "").trim();
          rows[i].rollMin = raw === "" ? null : (Number.parseInt(raw, 10) || 0);
        } else if (field === "rollMax") rows[i].rollMax = Number.parseInt(target.value, 10) || 0;
        else rows[i].label = String(target.value ?? "");
        return void await this.document.update({ "system.rows": rows });
      }
      if ((m = name.match(/^system\.rows\.(\d+)\.results\.(.+)$/))) {
        const i = Number(m[1]), key = m[2];
        const rows = dup(this.document.system.rows);
        if (!rows[i]) return;
        rows[i].results ??= {};
        rows[i].results[key] = String(target.value ?? "");
        return void await this.document.update({ "system.rows": rows });
      }
      if ((m = name.match(/^system\.columnDefs\.(\d+)\.(key|label)$/))) {
        const j = Number(m[1]), field = m[2];
        const defs = dup(this.document.system.columnDefs);
        if (!defs[j]) return;
        defs[j][field] = String(target.value ?? "");
        return void await this.document.update({ "system.columnDefs": defs });
      }
      // Fumble results (object) + scalars write through directly.
      const value = coerceInputValue(target);
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | AttackTableSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }

  /* ───────────────────────── Actions ───────────────────────── */

  static async #onAddRow() {
    const rows = foundry.utils.duplicate(Array.isArray(this.document.system.rows) ? this.document.system.rows : []);
    const last = rows[rows.length - 1];
    const nextMin = last && Number.isFinite(last.rollMax) ? last.rollMax + 1 : 1;
    rows.push({ label: "", rollMin: rows.length ? nextMin : null, rollMax: nextMin, results: {} });
    await this.document.update({ "system.rows": rows });
  }
  static async #onRemoveRow(event, target) {
    const i = Number(target?.dataset?.index);
    const rows = foundry.utils.duplicate(Array.isArray(this.document.system.rows) ? this.document.system.rows : []);
    if (Number.isInteger(i) && i >= 0 && i < rows.length) { rows.splice(i, 1); await this.document.update({ "system.rows": rows }); }
  }

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

    const sys = this.document.system;
    const isResistance = sys.tableKind === "resistanceMod";

    try {
      let result;
      if (isResistance) {
        const colEl = root?.querySelector?.(`[name="resolve.column"]`);
        const column = String(colEl?.value || sys.columnDefs?.[0]?.key || "");
        const params = {
          table: sys, column,
          ob: num("ob"), mods: num("mods"), targetDB: num("targetDB")
        };
        this._resolveState = { ob: params.ob, mods: params.mods, targetDB: params.targetDB, column };
        result = await game.rmf.tables.resolveResistanceSpell(params);
      } else {
        const params = {
          table: sys,
          ob: num("ob"), mods: num("mods"),
          targetAT: num("targetAT", 1), targetDB: num("targetDB")
        };
        this._resolveState = { ob: params.ob, mods: params.mods, targetAT: params.targetAT, targetDB: params.targetDB };
        result = await game.rmf.tables.resolveAttack(params);
      }
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
      name: this.document.name, at: view.targetAT
    });

    let rollLine = result.openHigh
      ? `${result.natural} → ${result.rollTotal} (${L("RMF.AttackTable.OpenEnded")})`
      : `${result.natural}`;
    if (view.umHigh && view.umLabel) rollLine += ` [${view.umLabel}]`;

    const esc = s => Handlebars.escapeExpression(s);
    const content = `
      <div class="rmf-attack-card">
        <h3>${esc(title)}</h3>
        <div class="line"><span>${L("RMF.AttackTable.NaturalRoll")}:</span> <b>${rollLine}</b></div>
        <div class="line"><span>${L("RMF.AttackTable.AttackTotal")}:</span> <b>${result.attackTotal}</b></div>
        <div class="outcome ${(result.fumble || result.fails) ? "is-fumble" : (result.needsCritical ? "is-crit" : "")}">${esc(view.outcome)}</div>
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
