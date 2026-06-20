/**
 * RMF Matrix Table Sheets — shared base for the three "lookup matrix" item
 * types added on top of the critical tables:
 *
 *   - creatureCriticalTable  (A-10.10.7/8/9)  reuses parseCriticalEffects
 *   - weaponFumbleTable       (A-10.11.1)       parseFumbleEffects
 *   - spellFailureTable       (A-10.11.2)       parseSpellFailureEffects
 *
 * All three render the same two-tab UI as the critical sheet (read-only
 * matrix + resolve form) over generic `parts/item-tablematrix-*` partials, so
 * the per-type subclasses only declare their template, parser, summary
 * formatter and engine resolver. Fumble/failure resolves also follow any
 * `crit:` chain in the cell and attach the chained critical roll to the card.
 *
 * @module matrix-table-sheets
 */

const { HandlebarsApplicationMixin } = foundry.applications.api;
import {
  bindChangeListeners, coerceInputValue, initHeaderAutoHeight,
  setActiveTab as utilSetActiveTab, wireTabs
} from "./utils/sheet-helpers.mjs";
import { RMFActions } from "./actions.mjs";
import {
  parseCriticalEffects, parseFumbleEffects, parseSpellFailureEffects,
  resolveCritical, resolveFumble, resolveSpellFailure, resolveChainedCritical
} from "./tables/index.mjs";

const L = k => game.i18n.localize(k);
const F = (k, d) => game.i18n.format(k, d);

/** Format a parsed duration object ({value|dice, unit, ongoing}) for display. */
function fmtDuration(dur) {
  if (!dur) return "";
  if (dur.ongoing) return L("RMF.TableMatrix.Ongoing");
  const val = dur.dice ? `${dur.dice.n === 1 ? "" : dur.dice.n}d${dur.dice.faces}` : String(dur.value ?? "");
  const unit = L(`RMF.TableMatrix.Unit_${dur.unit || "round"}`);
  return `${val} ${unit}`.trim();
}

/** Format a parsed chain ref ({table, severity}) for display. */
function fmtChain(c) {
  return c.table
    ? F("RMF.TableMatrix.Chain", { type: c.table, sev: c.severity })
    : F("RMF.TableMatrix.ChainGeneric", { sev: c.severity });
}

/** Shared "X hits / Y stunned / ..." bits common to all three parsers. */
function commonBits(p, bits) {
  if (p.hits) bits.push(F("RMF.TableMatrix.Hits", { n: p.hits }));
  for (const d of p.diceHits ?? []) bits.push(F("RMF.TableMatrix.DiceHits", { n: `${d.n}d${d.faces}` }));
  if (p.stunNoParry) bits.push(F("RMF.TableMatrix.StunNoParry", { n: p.stunNoParry }));
  if (p.stun)        bits.push(F("RMF.TableMatrix.Stunned", { n: p.stun }));
  if (p.noParry)     bits.push(F("RMF.TableMatrix.NoParry", { n: p.noParry }));
  if (p.mustParry)   bits.push(F("RMF.TableMatrix.MustParry", { n: p.mustParry }));
  if (p.bleed)       bits.push(F("RMF.TableMatrix.Bleed", { n: p.bleed }));
  if (p.down)        bits.push(F("RMF.TableMatrix.Down", { n: p.down }));
  if (p.ko)          bits.push(F("RMF.TableMatrix.KO", { d: fmtDuration(p.ko) }));
  for (const pen of p.penalties ?? []) bits.push(`${pen.value}${pen.duration && !(pen.duration.value === 1 && pen.duration.unit === "round") ? ` (${fmtDuration(pen.duration)})` : ""}`);
  if (p.bonus)       bits.push(`+${p.bonus.value}`);
  for (const c of p.chains ?? []) bits.push(fmtChain(c));
}

export class RMFMatrixTableSheet extends HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    form: { submitOnChange: false, closeOnSubmit: false },
    classes: ["rmf", "sheet", "item"],
    window: { resizable: true, minimizable: true, minWidth: 760, minHeight: 560 },
    position: { width: 1100, height: 800 },
    actions: {
      pickImage: RMFActions.handlers.pickImage,
      resolveTable: RMFMatrixTableSheet.#onResolve,
      addRow: RMFMatrixTableSheet.#onAddRow,
      removeRow: RMFMatrixTableSheet.#onRemoveRow,
      addColumn: RMFMatrixTableSheet.#onAddColumn,
      removeColumn: RMFMatrixTableSheet.#onRemoveColumn
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

  /* ── Subclass hooks (override per type) ───────────────────────── */
  /** Parse a cell's effects string → structured object. */
  _parseEffects(str) { return parseCriticalEffects(str); }
  /** Human summary of a parsed object. */
  _describeEffects(_p) { return ""; }
  /** Run the engine resolver for this table. */
  async _resolveEngine({ table, column, mod }) { return resolveCritical({ table, column, mod }); }
  /** Localized label for the column axis (severity / weapon class / spell class). */
  _columnLabel() { return L("RMF.TableMatrix.Column"); }
  /** The shared effects-notation Key (CONFIG.RMF). Default = critical key. */
  _effectsKey() { return CONFIG.RMF?.criticalEffectsKey ?? {}; }
  /** i18n key for the chat-card title (formatted with {name, column}). */
  get _chatTitleKey() { return "RMF.TableMatrix.ChatTitle"; }
  /** i18n key for the name input placeholder. */
  get _namePlaceholderKey() { return "RMF.TableMatrix.NamePlaceholder"; }

  get title() {
    return `${this.document.name} - ${L(this.options.window.title ?? "RMF.TableMatrix.Title")}`;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const doc = this.document;
    const sys = doc?.system ?? {};
    context.item = doc; context.system = sys; context.config = CONFIG.RMF;
    context.isEditable = this.isEditable; context.editable = this.isEditable;
    context.columnLabel = this._columnLabel();
    context.namePlaceholder = L(this._namePlaceholderKey);

    const defs = Array.isArray(sys.columnDefs) ? sys.columnDefs : [];
    context.columns = defs.map(d => d.label || d.key);

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
          summary: variants.length ? "" : this._describeEffects(this._parseEffects(cell?.effects)),
          variants: variants.map(v => ({
            condition: v.condition, effects: v.effects,
            summary: this._describeEffects(this._parseEffects(v.effects))
          }))
        };
      })
    }));

    // Legend: universal Key from CONFIG.RMF (per-subclass), not persisted on
    // the item, + any per-table notes (system.notes).
    const effectsKey = this._effectsKey() ?? {};
    const notes = sys.notes && typeof sys.notes === "object" ? sys.notes : {};
    context.legendRows = [...Object.entries(effectsKey), ...Object.entries(notes)]
      .filter(([, t]) => typeof t === "string").map(([key, text]) => ({ key, text }));
    // Editable per-table notes only (the universal Key is read-only CONFIG data).
    context.notesRows = Object.entries(notes)
      .filter(([, t]) => typeof t === "string").map(([key, text]) => ({ key, text }));

    // Editable-grid context (Editar tab): raw cell values, no parsing.
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

    const defaultColumn = defs[0]?.key ?? "";
    context.resolve = this._resolveState ?? { mod: 0, column: defaultColumn };
    context.resolveColumns = defs.map(d => ({
      key: d.key, label: d.label || d.key,
      selected: (this._resolveState?.column ?? defaultColumn) === d.key
    }));
    context.lastResult = this._lastResult ? this.#viewResult(this._lastResult) : null;
    return context;
  }

  /** Shape an engine result (+ chained crits) for inline/chat display. */
  #viewResult(r) {
    return {
      natural: r.natural, total: r.total, column: r.column,
      band: r.row?.label ?? "", text: r.cell?.text ?? "", effects: r.cell?.effects ?? "",
      summary: r.parsed ? this._describeEffects(r.parsed) : "",
      rolledHits: r.rolledHits ?? null,
      variants: (r.variants ?? []).map(v => ({
        condition: v.condition, effects: v.effects, summary: this._describeEffects(v.parsed)
      })),
      chained: (r.chainResults ?? []).map(cr => cr.found
        ? { found: true, label: `${cr.type || "?"} ${cr.severity}`, band: cr.result?.row?.label ?? "", text: cr.result?.cell?.text ?? "", effects: cr.result?.cell?.effects ?? "", natural: cr.result?.natural, total: cr.result?.total }
        : { found: false, label: `${cr.type || "?"} ${cr.severity}` })
    };
  }

  /* ── Lifecycle (identical to the critical sheet) ──────────────── */
  _onFirstRender(c, o) { super._onFirstRender?.(c, o); this._setupTabs(this.element); this._initHeaderAutoHeight(this.element); this._bindChangeListeners(this.element); }
  _onRender(c, o) {
    super._onRender?.(c, o);
    this._setupTabs(this.element);
    if (!this.element?._rmfHeaderResizeObserver) this._initHeaderAutoHeight(this.element);
    this._bindChangeListeners(this.element);
    const el = this.element?.querySelector ? this.element : null;
    if (!el) return;
    const fallback = this.constructor.TABS?.primary?.tabs?.[0]?.id ?? null;
    const existing = el.querySelector(".sheet-tabs .item.active")?.dataset?.tab;
    const active = this._activeTab || existing || fallback;
    if (active) this._setActiveTab(active, el);
  }
  _setupTabs(html) { const el = html?.querySelector ? html : this.element; if (el) wireTabs(el, (t, e) => this._setActiveTab(t, e)); }
  _setActiveTab(tab, html) { this._activeTab = tab; const el = html?.querySelector ? html : this.element; if (el) utilSetActiveTab(tab, el); }
  _initHeaderAutoHeight(root) { const el = root?.querySelector ? root : this.element; if (el) initHeaderAutoHeight(el); }
  _bindChangeListeners(root) { const el = root?.querySelector ? root : this.element; if (el) bindChangeListeners(el, this._onFieldChange.bind(this)); }

  async _onFieldChange(event) {
    const target = event.target;
    const name = target?.name || target?.getAttribute?.("name");
    if (!name) return;
    if (name.startsWith("resolve.")) {
      const key = name.slice("resolve.".length);
      this._resolveState = { ...(this._resolveState ?? { mod: 0, column: "" }) };
      this._resolveState[key] = (key === "column") ? String(coerceInputValue(target) ?? "") : (Number(coerceInputValue(target)) || 0);
      return;
    }
    try {
      // Array-backed fields are rewritten whole (Foundry turns deep array-path
      // updates into objects), mirroring the profession/spell-list sheets.
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
      // Legend (object) + simple header fields (tableId/critType/spellMode/fromBook/name).
      await this.document.update({ [name]: coerceInputValue(target) });
    } catch (err) {
      console.error("RMF ERROR | MatrixTableSheet update failed", { name, err });
      ui.notifications?.error(err?.message || "Update failed");
    }
  }

  /* ── Edit-grid actions (array rewrites) ───────────────────────── */
  static #dupRows(doc) { return foundry.utils.duplicate(Array.isArray(doc.system.rows) ? doc.system.rows : []); }
  static #dupDefs(doc) { return foundry.utils.duplicate(Array.isArray(doc.system.columnDefs) ? doc.system.columnDefs : []); }

  static async #onAddRow() {
    const rows = RMFMatrixTableSheet.#dupRows(this.document);
    const last = rows[rows.length - 1];
    const nextMin = last && Number.isFinite(last.rollMax) ? last.rollMax + 1 : 1;
    rows.push({ label: "", rollMin: rows.length ? nextMin : null, rollMax: nextMin, results: {} });
    await this.document.update({ "system.rows": rows });
  }
  static async #onRemoveRow(event, target) {
    const i = Number(target?.dataset?.index);
    const rows = RMFMatrixTableSheet.#dupRows(this.document);
    if (Number.isInteger(i) && i >= 0 && i < rows.length) { rows.splice(i, 1); await this.document.update({ "system.rows": rows }); }
  }
  static async #onAddColumn() {
    const defs = RMFMatrixTableSheet.#dupDefs(this.document);
    let n = defs.length + 1, key = `col${n}`;
    while (defs.some(d => d.key === key)) key = `col${++n}`;
    defs.push({ key, label: "" });
    const rows = RMFMatrixTableSheet.#dupRows(this.document);
    for (const r of rows) { r.results ??= {}; r.results[key] = { text: "", effects: "" }; }
    await this.document.update({ "system.columnDefs": defs, "system.rows": rows });
  }
  static async #onRemoveColumn(event, target) {
    const key = String(target?.dataset?.key ?? "");
    if (!key) return;
    const defs = RMFMatrixTableSheet.#dupDefs(this.document).filter(d => d.key !== key);
    const rows = RMFMatrixTableSheet.#dupRows(this.document);
    for (const r of rows) { if (r.results) delete r.results[key]; }
    await this.document.update({ "system.columnDefs": defs, "system.rows": rows });
  }

  /* ── Resolve action ──────────────────────────────────────────── */
  static async #onResolve(event) {
    event?.preventDefault?.();
    const root = this.element;
    const sys = this.document.system;
    const colEl = root?.querySelector?.(`[name="resolve.column"]`);
    const modEl = root?.querySelector?.(`[name="resolve.mod"]`);
    const column = String(colEl?.value || sys.columnDefs?.[0]?.key || "");
    const mod = Number(modEl?.value) || 0;
    this._resolveState = { mod, column };
    try {
      const result = await this._resolveEngine({ table: sys, column, mod });
      // Follow any crit: chains the cell carries (best-effort).
      const chains = result.parsed?.chains ?? [];
      if (chains.length) {
        result.chainResults = [];
        for (const ch of chains) result.chainResults.push(await resolveChainedCritical(ch));
      }
      this._lastResult = result;
      await this.#postChat(result);
      await this.render();
    } catch (err) {
      console.error("RMF ERROR | matrix resolve failed", err);
      ui.notifications?.error(err?.message || "Resolution failed");
    }
  }

  async #postChat(result) {
    const view = this.#viewResult(result);
    const esc = s => Handlebars.escapeExpression(s);
    const title = F(this._chatTitleKey, { name: this.document.name, column: view.column });

    const variantHtml = view.variants.length
      ? `<ul class="variants">${view.variants.map(v => `<li><b>${esc(v.condition)}:</b> ${esc(v.effects || "—")}${v.summary ? ` <i>(${esc(v.summary)})</i>` : ""}</li>`).join("")}</ul>` : "";
    const chainHtml = view.chained.length
      ? `<div class="chained">${view.chained.map(c => c.found
          ? `<div class="line"><b>${L("RMF.TableMatrix.ChainedResult")}:</b> ${esc(c.label)} — ${esc(c.band)} (${c.natural}${c.total !== c.natural ? `→${c.total}` : ""})<br>${esc(c.text)}${c.effects ? ` <span class="outcome is-crit">${esc(c.effects)}</span>` : ""}</div>`
          : `<div class="line muted"><b>${L("RMF.TableMatrix.ChainedResult")}:</b> ${esc(c.label)} — ${L("RMF.TableMatrix.ChainMissing")}</div>`).join("")}</div>` : "";

    const content = `
      <div class="rmf-critical-card rmf-matrix-card">
        <h3>${esc(title)}</h3>
        <div class="line"><span>${L("RMF.AttackTable.NaturalRoll")}:</span> <b>${view.natural}</b>${result.total !== result.natural ? ` → ${view.total}` : ""} <span class="band">[${esc(view.band)}]</span></div>
        <p class="crit-text">${esc(view.text)}</p>
        ${view.effects ? `<div class="outcome is-crit">${esc(view.effects)}</div>` : ""}
        ${view.summary ? `<div class="crit-hint">${esc(view.summary)}${view.rolledHits ? ` — ${view.rolledHits} ${L("RMF.AttackTable.Hits")}` : ""}</div>` : ""}
        ${variantHtml}
        ${chainHtml}
      </div>`;

    const messageData = { speaker: ChatMessage.getSpeaker(), content, rolls: Array.isArray(result.rolls) ? result.rolls : [], flavor: this.document.name };
    ChatMessage.applyRollMode(messageData, game.settings.get("rmf", "defaultRollMode"));
    await ChatMessage.create(messageData);
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Per-type subclasses                                                     */
/* ────────────────────────────────────────────────────────────────────── */

/** Describe a parseCriticalEffects result (creature criticals). */
function describeCritical(p) {
  if (!p || p.empty) return "";
  const bits = [];
  if (p.hits) bits.push(F("RMF.TableMatrix.Hits", { n: p.hits }));
  if (p.stunNoParry) bits.push(F("RMF.TableMatrix.StunNoParry", { n: p.stunNoParry }));
  if (p.stun) bits.push(F("RMF.TableMatrix.Stunned", { n: p.stun }));
  if (p.noParry) bits.push(F("RMF.TableMatrix.NoParry", { n: p.noParry }));
  if (p.mustParry) bits.push(F("RMF.TableMatrix.MustParry", { n: p.mustParry }) + (p.parryPenalty ? ` (${p.parryPenalty.value})` : ""));
  if (p.bleed) bits.push(F("RMF.TableMatrix.Bleed", { n: p.bleed }));
  if (p.penalty) bits.push(`${p.penalty.value}${p.penalty.rounds > 1 ? ` (${p.penalty.rounds}r)` : ""}`);
  if (p.bonus) bits.push(`+${p.bonus.value}`);
  if (p.other?.length) bits.push(p.other.join(" · "));
  return bits.join(", ");
}

export class RMFCreatureCriticalTableSheet extends RMFMatrixTableSheet {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["rmf", "sheet", "item", "creatureCriticalTable"],
    window: { ...super.DEFAULT_OPTIONS.window, icon: "fas fa-dragon", title: "RMF.CreatureCritical.Title", contentClasses: ["rmf-critical-table-sheet"] }
  };
  static PARTS = { ...super.PARTS, form: { template: "systems/rmf/templates/item-matrix-table-sheet.hbs", scrollable: [".sheet-body"] } };
  _parseEffects(s) { return parseCriticalEffects(s); }
  _describeEffects(p) { return describeCritical(p); }
  // Creature criticals (large / super-large) roll high open-ended — PDF p.209.
  async _resolveEngine({ table, column, mod }) { return resolveCritical({ table, column, mod, openEnded: true }); }
  _columnLabel() { return L("RMF.CreatureCritical.ColumnLabel"); }
  get _chatTitleKey() { return "RMF.CreatureCritical.ChatTitle"; }
  get _namePlaceholderKey() { return "RMF.CreatureCritical.NamePlaceholder"; }
}

export class RMFWeaponFumbleTableSheet extends RMFMatrixTableSheet {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["rmf", "sheet", "item", "weaponFumbleTable"],
    window: { ...super.DEFAULT_OPTIONS.window, icon: "fas fa-hand-fist", title: "RMF.Fumble.Title", contentClasses: ["rmf-critical-table-sheet"] }
  };
  static PARTS = { ...super.PARTS, form: { template: "systems/rmf/templates/item-matrix-table-sheet.hbs", scrollable: [".sheet-body"] } };
  _parseEffects(s) { return parseFumbleEffects(s); }
  _describeEffects(p) {
    if (!p || p.empty) return "";
    const bits = [];
    commonBits(p, bits);
    if (p.loseAttack) bits.push(F("RMF.Fumble.LoseAttack", { n: p.loseAttack }));
    if (p.dropWeapon) bits.push(p.dropWeapon.recover ? F("RMF.Fumble.DropRecover", { n: p.dropWeapon.recover }) : L("RMF.Fumble.Drop"));
    if (p.mustReload) bits.push(L("RMF.Fumble.Reload"));
    if (p.breakageCheck) bits.push(L("RMF.Fumble.Breakage"));
    if (p.weaponBreaks) bits.push(L("RMF.Fumble.Break"));
    if (p.bowstringBreaks) bits.push(L("RMF.Fumble.BowBreak"));
    if (p.out) bits.push(F("RMF.Fumble.Out", { d: fmtDuration(p.out) }));
    if (p.maimed) bits.push(L("RMF.Fumble.Maim"));
    if (p.self) bits.push(L("RMF.Fumble.Self"));
    if (p.ally) bits.push(L("RMF.Fumble.Ally"));
    if (p.other?.length) bits.push(p.other.join(" · "));
    return bits.join(", ");
  }
  async _resolveEngine({ table, column, mod }) { return resolveFumble({ table, column, mod }); }
  _columnLabel() { return L("RMF.Fumble.ColumnLabel"); }
  _effectsKey() { return CONFIG.RMF?.weaponFumbleEffectsKey ?? {}; }
  get _chatTitleKey() { return "RMF.Fumble.ChatTitle"; }
  get _namePlaceholderKey() { return "RMF.Fumble.NamePlaceholder"; }
}

export class RMFSpellFailureTableSheet extends RMFMatrixTableSheet {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["rmf", "sheet", "item", "spellFailureTable"],
    window: { ...super.DEFAULT_OPTIONS.window, icon: "fas fa-wand-sparkles", title: "RMF.SpellFailure.Title", contentClasses: ["rmf-critical-table-sheet"] }
  };
  static PARTS = { ...super.PARTS, form: { template: "systems/rmf/templates/item-matrix-table-sheet.hbs", scrollable: [".sheet-body"] } };
  _parseEffects(s) { return parseSpellFailureEffects(s); }
  _describeEffects(p) {
    if (!p || p.empty) return "";
    const bits = [];
    commonBits(p, bits);
    if (p.recast) bits.push(L("RMF.SpellFailure.Recast"));
    if (p.loseSpell) bits.push(L("RMF.SpellFailure.LoseSpell"));
    if (p.noEffect) bits.push(L("RMF.SpellFailure.NoEffect"));
    if (p.castDelay) bits.push(F("RMF.SpellFailure.Delay", { n: p.castDelay }));
    if (p.ppLoss != null) bits.push(typeof p.ppLoss === "number" ? F("RMF.SpellFailure.PPLossN", { n: p.ppLoss }) : L(`RMF.SpellFailure.PPLoss_${p.ppLoss}`));
    if (p.loseCasting) bits.push(F("RMF.SpellFailure.NoCast", { d: fmtDuration(p.loseCasting) }));
    if (p.coma) bits.push(F("RMF.SpellFailure.Coma", { d: fmtDuration(p.coma) }));
    if (p.paralyze) bits.push(F("RMF.SpellFailure.Paralyze", { p: p.paralyze }));
    if (p.selfAttack) bits.push(L("RMF.SpellFailure.SelfAttack"));
    if (p.other?.length) bits.push(p.other.join(" · "));
    return bits.join(", ");
  }
  async _resolveEngine({ table, column, mod }) { return resolveSpellFailure({ table, column, mod }); }
  _columnLabel() { return L("RMF.SpellFailure.ColumnLabel"); }
  _effectsKey() { return CONFIG.RMF?.spellFailureEffectsKey ?? {}; }
  get _chatTitleKey() { return "RMF.SpellFailure.ChatTitle"; }
  get _namePlaceholderKey() { return "RMF.SpellFailure.NamePlaceholder"; }
}
