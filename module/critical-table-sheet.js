/**
 * RMF Critical Table Sheet
 *
 * Two-tab layout (same helper-driven architecture as the attack-table
 * sheet):
 *  - "table":   read-only matrix — severity columns (A-E) by roll band;
 *               each cell shows the effects notation (bold) over the
 *               narrative text. Conditional cells list their variants.
 *  - "resolve": severity select + roll modifier + a "Roll Critical"
 *               button that runs `game.rmf.tables.resolveCritical`,
 *               shows the result inline and posts a chat card.
 *
 * The grid is read-only: tables are edited via JSON import
 * (`game.rmf.importCriticalTables` / `syncCriticalTablesToCompendium`),
 * exactly like the attack tables.
 *
 * @class RMFCriticalTableSheet
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
import { parseCriticalEffects } from "./tables/index.mjs";

/** Build the short human summary of a parsed effects object. */
function describeEffects(parsed, L) {
  if (!parsed || parsed.empty) return "";
  const bits = [];
  if (parsed.hits)        bits.push(`${parsed.hits} ${L("RMF.AttackTable.Hits")}`);
  if (parsed.stunNoParry) bits.push(L("RMF.CriticalTable.StunNoParry").replace("{n}", parsed.stunNoParry));
  if (parsed.stun)        bits.push(L("RMF.CriticalTable.Stunned").replace("{n}", parsed.stun));
  if (parsed.noParry)     bits.push(L("RMF.CriticalTable.NoParry").replace("{n}", parsed.noParry));
  if (parsed.mustParry)   bits.push(L("RMF.CriticalTable.MustParry").replace("{n}", parsed.mustParry)
                            + (parsed.parryPenalty ? ` (${parsed.parryPenalty.value})` : ""));
  if (parsed.bleed)       bits.push(L("RMF.CriticalTable.Bleed").replace("{n}", parsed.bleed));
  if (parsed.penalty)     bits.push(`${parsed.penalty.value}${parsed.penalty.rounds > 1 ? ` (${parsed.penalty.rounds}r)` : ""}`);
  if (parsed.bonus)       bits.push(`+${parsed.bonus.value} → ${L("RMF.CriticalTable.Attacker")}`);
  if (parsed.other.length) bits.push(parsed.other.join(" · "));
  return bits.join(", ");
}

export class RMFCriticalTableSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item", "criticalTable"],
    window: {
      icon: "fas fa-skull",
      title: "RMF.CriticalTableSheet",
      resizable: true,
      minimizable: true,
      contentClasses: ["rmf-critical-table-sheet"],
      minWidth: 760,
      minHeight: 560
    },
    position: { width: 1080, height: 780 },
    actions: {
      pickImage: RMFActions.handlers.pickImage,
      resolveCritical: RMFCriticalTableSheet.#onResolveCritical,
      addRow: RMFCriticalTableSheet.#onAddRow,
      removeRow: RMFCriticalTableSheet.#onRemoveRow,
      addColumn: RMFCriticalTableSheet.#onAddColumn,
      removeColumn: RMFCriticalTableSheet.#onRemoveColumn
    }
  };

  static PARTS = {
    ...super.PARTS,
    form: {
      template: "systems/rmf/templates/item-critical-table-sheet.hbs",
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
    return `${this.document.name} - ${game.i18n.localize("RMF.CriticalTableSheet")}`;
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

    const L = k => game.i18n.localize(k);
    const defs = Array.isArray(sys.columnDefs) ? sys.columnDefs : [];
    context.columns = defs.map(d => d.label || d.key);

    // Grid: every cell carries the raw notation, a parsed human summary
    // (tooltip) and any conditional variants.
    const rows = Array.isArray(sys.rows) ? sys.rows : [];
    context.gridRows = rows.map(row => ({
      label: row?.label ?? "",
      cells: defs.map(d => {
        const cell = row?.results?.[d.key] ?? null;
        const variants = Array.isArray(cell?.variants) ? cell.variants : [];
        return {
          key: d.key,
          text: cell?.text ?? "",
          effects: cell?.effects ?? "",
          summary: variants.length ? "" : describeEffects(parseCriticalEffects(cell?.effects), L),
          variants: variants.map(v => ({
            condition: v.condition,
            effects: v.effects,
            summary: describeEffects(parseCriticalEffects(v.effects), L)
          }))
        };
      })
    }));

    // Legend: the universal Key comes from CONFIG.RMF (single source of truth,
    // not persisted per item) + any per-table notes (system.notes).
    const effectsKey = CONFIG.RMF?.criticalEffectsKey ?? {};
    const notes = sys.notes && typeof sys.notes === "object" ? sys.notes : {};
    context.legendRows = [...Object.entries(effectsKey), ...Object.entries(notes)]
      .filter(([, text]) => typeof text === "string")
      .map(([key, text]) => ({ key, text }));
    // Editable per-table notes only (the universal Key is read-only CONFIG data).
    context.notesRows = Object.entries(notes)
      .filter(([, text]) => typeof text === "string")
      .map(([key, text]) => ({ key, text }));

    // Editable-grid context (Editar tab): raw cell values, no parsing.
    context.columnLabel = L("RMF.CriticalTable.Severity");
    context.namePlaceholder = L("RMF.CriticalTable.NamePlaceholder");
    context.editColumns = defs.map((d, index) => ({ index, key: d.key, label: d.label ?? "" }));
    context.editRows = rows.map((row, index) => ({
      index,
      label: row?.label ?? "",
      rollMin: (row?.rollMin === null || row?.rollMin === undefined) ? "" : row.rollMin,
      rollMax: row?.rollMax ?? 0,
      cells: defs.map(d => ({
        key: d.key,
        text: row?.results?.[d.key]?.text ?? "",
        effects: row?.results?.[d.key]?.effects ?? ""
      }))
    }));

    // Resolve-form state + last result.
    const defaultColumn = defs[0]?.key ?? "";
    context.resolve = this._resolveState ?? { mod: 0, column: defaultColumn };
    context.resolveColumns = defs.map(d => ({
      key: d.key,
      label: d.label || d.key,
      selected: (this._resolveState?.column ?? defaultColumn) === d.key
    }));
    context.lastResult = this._lastResult ? this.#viewResult(this._lastResult) : null;

    return context;
  }

  /** Shape an engine result for inline/chat display. */
  #viewResult(r) {
    const L = k => game.i18n.localize(k);
    return {
      natural: r.natural,
      total: r.total,
      column: r.column,
      band: r.row?.label ?? "",
      text: r.cell?.text ?? "",
      effects: r.cell?.effects ?? "",
      summary: r.parsed ? describeEffects(r.parsed, L) : "",
      variants: (r.variants ?? []).map(v => ({
        condition: v.condition,
        effects: v.effects,
        summary: describeEffects(v.parsed, L)
      }))
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

  /** Resolve-form inputs cache on the instance; meta inputs write through. */
  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.("name");
    if (!name) return;

    if (name.startsWith("resolve.")) {
      const key = name.slice("resolve.".length);
      this._resolveState = { ...(this._resolveState ?? { mod: 0, column: "" }) };
      this._resolveState[key] = (key === "column")
        ? String(coerceInputValue(target) ?? "")
        : (Number(coerceInputValue(target)) || 0);
      return;
    }

    try {
      // Array-backed fields (Editar tab) are rewritten whole — Foundry turns
      // deep array-path updates into objects.
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
      if ((m = name.match(/^system\.rows\.(\d+)\.results\.([^.]+)\.(text|effects)$/))) {
        const i = Number(m[1]), col = m[2], field = m[3];
        const rows = dup(this.document.system.rows);
        if (!rows[i]) return;
        rows[i].results ??= {};
        rows[i].results[col] = { text: "", effects: "", ...(rows[i].results[col] ?? {}) };
        rows[i].results[col][field] = String(target.value ?? "");
        return void await this.document.update({ "system.rows": rows });
      }
      if ((m = name.match(/^system\.columnDefs\.(\d+)\.(key|label)$/))) {
        const j = Number(m[1]), field = m[2];
        const defs = dup(this.document.system.columnDefs);
        if (!defs[j]) return;
        defs[j][field] = String(target.value ?? "");
        return void await this.document.update({ "system.columnDefs": defs });
      }
      const value = coerceInputValue(target);
      await this.document.update({ [name]: value });
    } catch (err) {
      console.error("RMF ERROR | CriticalTableSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }

  /* ───────────────────────── Actions ───────────────────────── */

  static #dupRows(doc) { return foundry.utils.duplicate(Array.isArray(doc.system.rows) ? doc.system.rows : []); }
  static #dupDefs(doc) { return foundry.utils.duplicate(Array.isArray(doc.system.columnDefs) ? doc.system.columnDefs : []); }

  static async #onAddRow() {
    const rows = RMFCriticalTableSheet.#dupRows(this.document);
    const last = rows[rows.length - 1];
    const nextMin = last && Number.isFinite(last.rollMax) ? last.rollMax + 1 : 1;
    rows.push({ label: "", rollMin: rows.length ? nextMin : null, rollMax: nextMin, results: {} });
    await this.document.update({ "system.rows": rows });
  }
  static async #onRemoveRow(event, target) {
    const i = Number(target?.dataset?.index);
    const rows = RMFCriticalTableSheet.#dupRows(this.document);
    if (Number.isInteger(i) && i >= 0 && i < rows.length) { rows.splice(i, 1); await this.document.update({ "system.rows": rows }); }
  }
  static async #onAddColumn() {
    const defs = RMFCriticalTableSheet.#dupDefs(this.document);
    let n = defs.length + 1, key = `col${n}`;
    while (defs.some(d => d.key === key)) key = `col${++n}`;
    defs.push({ key, label: "" });
    const rows = RMFCriticalTableSheet.#dupRows(this.document);
    for (const r of rows) { r.results ??= {}; r.results[key] = { text: "", effects: "" }; }
    await this.document.update({ "system.columnDefs": defs, "system.rows": rows });
  }
  static async #onRemoveColumn(event, target) {
    const key = String(target?.dataset?.key ?? "");
    if (!key) return;
    const defs = RMFCriticalTableSheet.#dupDefs(this.document).filter(d => d.key !== key);
    const rows = RMFCriticalTableSheet.#dupRows(this.document);
    for (const r of rows) { if (r.results) delete r.results[key]; }
    await this.document.update({ "system.columnDefs": defs, "system.rows": rows });
  }

  static async #onResolveCritical(event, target) {
    event?.preventDefault?.();
    const root = this.element;
    const sys = this.document.system;

    const colEl = root?.querySelector?.(`[name="resolve.column"]`);
    const modEl = root?.querySelector?.(`[name="resolve.mod"]`);
    const column = String(colEl?.value || sys.columnDefs?.[0]?.key || "");
    const mod = Number(modEl?.value) || 0;
    this._resolveState = { mod, column };

    try {
      const result = await game.rmf.tables.resolveCritical({ table: sys, column, mod });
      this._lastResult = result;
      await this.#postChat(result);
      await this.render();
    } catch (err) {
      console.error("RMF ERROR | resolveCritical failed", err);
      ui.notifications?.error(err?.message || "Critical resolution failed");
    }
  }

  /** Post a compact critical chat card (dice attached). */
  async #postChat(result) {
    const L = k => game.i18n.localize(k);
    const view = this.#viewResult(result);
    const title = game.i18n.format("RMF.CriticalTable.ChatTitle", {
      name: this.document.name, column: view.column
    });
    const esc = s => Handlebars.escapeExpression(s);

    const variantHtml = view.variants.length
      ? `<ul class="variants">${view.variants.map(v =>
          `<li><b>${esc(v.condition)}:</b> ${esc(v.effects || "—")}${v.summary ? ` <i>(${esc(v.summary)})</i>` : ""}</li>`
        ).join("")}</ul>`
      : "";

    const content = `
      <div class="rmf-critical-card">
        <h3>${esc(title)}</h3>
        <div class="line"><span>${L("RMF.AttackTable.NaturalRoll")}:</span> <b>${view.natural}</b>${result.total !== result.natural ? ` → ${view.total}` : ""} <span class="band">[${esc(view.band)}]</span></div>
        <p class="crit-text">${esc(view.text)}</p>
        ${view.effects ? `<div class="outcome is-crit">${esc(view.effects)}</div>` : ""}
        ${view.summary ? `<div class="crit-hint">${esc(view.summary)}</div>` : ""}
        ${variantHtml}
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
