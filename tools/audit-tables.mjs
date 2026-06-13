/**
 * Dev/CI audit for the whole "table" subsystem (attack / critical / creature
 * critical / weapon fumble / spell failure). Three layers:
 *
 *   A. REGISTRATION  — every table item type is wired identically across all
 *      touchpoints (template.json, rmf.mjs dataModels/sheet/itemTypes,
 *      data-models/index.mjs, migration SLUG_CONTENT_TYPES, hooks game.rmf,
 *      compendium-admin file lists).
 *   B. DATA          — every registered data file exists, has a unique slug,
 *      columnDefs match the keys used in every row, bands are contiguous, and
 *      every effects string parses with the correct engine (no stray tokens).
 *   C. RELATIONSHIPS — the cross-table graph resolves: every `crit:<type>:<sev>`
 *      chain (fumble/spell-failure) points at a real critical table, the
 *      referenced severity exists as a column there, and attack tables carry
 *      NO crit routing (critType/attackTypes — that is per-weapon data).
 *
 * Pure node (imports only the pure engine). Run: node tools/audit-tables.mjs
 * Exits non-zero if any ERROR is found (warnings/notes do not fail).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCriticalEffects } from "../module/tables/critical.mjs";
import { parseFumbleEffects } from "../module/tables/fumble.mjs";
import { parseSpellFailureEffects } from "../module/tables/spell-failure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJSON = (rel) => JSON.parse(read(rel));
const glob = (rel) => fs.existsSync(path.join(ROOT, rel))
  ? fs.readdirSync(path.join(ROOT, rel)).filter(f => f.endsWith(".json")).map(f => `${rel}/${f}`) : [];

const errors = [], warnings = [], notes = [];
const E = (m) => errors.push(m);
const W = (m) => warnings.push(m);
const N = (m) => notes.push(m);

/* The five table item types and their data dir + effects parser. */
const TYPES = {
  attackTable:           { dir: "data/system_tables/attack_tables",           parser: null,                  allowOther: [] },
  criticalTable:         { dir: "data/system_tables/critical_tables",          parser: parseCriticalEffects,  allowOther: ["all allies get +10 for 1 round"] },
  creatureCriticalTable: { dir: "data/system_tables/creature_critical_tables", parser: parseCriticalEffects,  allowOther: ["all allies get (+10)"] },
  weaponFumbleTable:     { dir: "data/system_tables/fumble_tables",            parser: parseFumbleEffects,    allowOther: [] },
  spellFailureTable:     { dir: "data/system_tables/spell_failure_tables",     parser: parseSpellFailureEffects, allowOther: [] }
};
const TABLE_TYPE_IDS = Object.keys(TYPES);

/* ───────────────────────── A. REGISTRATION ───────────────────────── */

const rmf = read("rmf.mjs");
const dmIndex = read("module/data-models/index.mjs");
const migration = read("module/migration.mjs");
const hooks = read("module/hooks.mjs");
const compendium = read("module/compendium-admin.mjs");
const templateJson = readJSON("template.json");

const dmClass = {
  attackTable: "AttackTableData", criticalTable: "CriticalTableData",
  creatureCriticalTable: "CreatureCriticalTableData", weaponFumbleTable: "WeaponFumbleTableData",
  spellFailureTable: "SpellFailureTableData"
};

for (const t of TABLE_TYPE_IDS) {
  if (!templateJson.Item.types.includes(t)) E(`[reg] template.json Item.types missing "${t}"`);
  if (!new RegExp(`\\b${t}:\\s*${dmClass[t]}\\b`).test(rmf)) E(`[reg] rmf.mjs CONFIG.Item.dataModels missing "${t}: ${dmClass[t]}"`);
  if (!new RegExp(`registerSheet\\(Item,\\s*"rmf-${t}"`).test(rmf)) E(`[reg] rmf.mjs registerSheet missing "rmf-${t}"`);
  if (!new RegExp(`"${t}"`).test(rmf.split("itemTypes:")[1]?.split("]")[0] ?? "")) E(`[reg] rmf.mjs CONFIG.RMF.itemTypes missing "${t}"`);
  if (!dmIndex.includes(dmClass[t])) E(`[reg] data-models/index.mjs missing export ${dmClass[t]}`);
  if (!new RegExp(`"${t}"`).test(migration.split("SLUG_CONTENT_TYPES")[1]?.split("]")[0] ?? "")) E(`[reg] migration.mjs SLUG_CONTENT_TYPES missing "${t}"`);
}

/* compendium-admin: each data file on disk must be registered in a *_FILES list. */
const registeredFiles = new Set([...compendium.matchAll(/"(system_tables\/[^"]+\.json)"/g)].map(m => m[1]));
for (const t of TABLE_TYPE_IDS) {
  for (const f of glob(TYPES[t].dir)) {
    const rel = f.replace("data/", "");
    if (!registeredFiles.has(rel)) E(`[reg] ${f} exists on disk but is NOT in any compendium-admin *_FILES list`);
  }
}
for (const rel of registeredFiles) {
  if (!fs.existsSync(path.join(ROOT, "data", rel))) E(`[reg] compendium-admin references data/${rel} which does NOT exist on disk`);
}

/* hooks: import + sync exposed on game.rmf for the importable table types. */
for (const t of ["attackTable", "criticalTable", "creatureCriticalTable", "weaponFumbleTable", "spellFailureTable"]) {
  const verbName = { attackTable: "AttackTables", criticalTable: "CriticalTables", creatureCriticalTable: "CreatureCriticalTables", weaponFumbleTable: "WeaponFumbleTables", spellFailureTable: "SpellFailureTables" }[t];
  if (!hooks.includes(`game.rmf.import${verbName}`)) E(`[reg] hooks.mjs missing game.rmf.import${verbName}`);
  if (!hooks.includes(`game.rmf.sync${verbName}ToCompendium`)) E(`[reg] hooks.mjs missing game.rmf.sync${verbName}ToCompendium`);
}

/* ───────────────────────── B. DATA + C. build registry ───────────────────────── */

const critRegistry = new Map(); // critType(lower) -> {type, file, slug, columns:Set}
const allSlugs = new Map();     // `${type}::${slug}` -> file (uniqueness per type)
let totalCells = 0;

// Order-agnostic: critical tables store bands ascending (catch-all first),
// attack tables descending (catch-all last). Sort by effective min and walk.
function checkBands(tbl, file) {
  const rows = (tbl.rows ?? []).filter(r => r && typeof r === "object");
  const isCatch = (r) => r.rollMin === null || r.rollMin === undefined;
  const catchAll = rows.filter(isCatch);
  if (catchAll.length > 1) E(`[data] ${file} has ${catchAll.length} catch-all bands (rollMin null); expected at most 1`);
  const sorted = rows.slice().sort((a, b) => (a.rollMin ?? -Infinity) - (b.rollMin ?? -Infinity));
  let prevMax = null;
  for (const row of sorted) {
    const min = isCatch(row) ? null : row.rollMin;
    if (prevMax === null) {
      if (min !== null && min > 1) W(`[data] ${file} lowest band "${row.label}" starts at ${min} (nothing covers 1..${min - 1})`);
    } else if (min === null) {
      E(`[data] ${file} catch-all band "${row.label}" is not the lowest band`);
    } else if (min !== prevMax + 1) {
      E(`[data] ${file} band "${row.label}" rollMin=${min} not contiguous (prev rollMax=${prevMax})`);
    }
    if (typeof row.rollMax !== "number") { E(`[data] ${file} band "${row.label}" bad rollMax=${row.rollMax}`); continue; }
    if (min !== null && row.rollMax < min) E(`[data] ${file} band "${row.label}" rollMax=${row.rollMax} < rollMin=${min}`);
    prevMax = row.rollMax;
  }
}

for (const t of TABLE_TYPE_IDS) {
  const cfg = TYPES[t];
  for (const file of glob(cfg.dir)) {
    let tbl;
    try { tbl = readJSON(file); } catch (err) { E(`[data] ${file} invalid JSON: ${err.message}`); continue; }

    // slug
    const slug = tbl.slug ?? "";
    if (!slug) E(`[data] ${file} missing slug`);
    const sk = `${t}::${slug}`;
    if (slug && allSlugs.has(sk)) E(`[data] duplicate slug "${slug}" (${t}): ${allSlugs.get(sk)} & ${file}`);
    if (slug) allSlugs.set(sk, file);

    // columnDefs ↔ row.results keys
    const cols = (tbl.columnDefs ?? []).map(c => c.key);
    if (!cols.length && t !== "attackTable") E(`[data] ${file} has no columnDefs`);
    const colSet = new Set(cols);
    if (Array.isArray(tbl.rows)) {
      for (const row of tbl.rows) {
        const rk = Object.keys(row.results ?? {});
        if (cols.length) {
          const missing = cols.filter(k => !rk.includes(k));
          const extra = rk.filter(k => !colSet.has(k));
          if (missing.length) E(`[data] ${file} band "${row.label}" missing cols ${JSON.stringify(missing)}`);
          if (extra.length) E(`[data] ${file} band "${row.label}" extra cols ${JSON.stringify(extra)}`);
        }
        // effects parse (critical/fumble/spell types)
        if (cfg.parser) {
          for (const [col, cell] of Object.entries(row.results ?? {})) {
            const cells = cell?.variants?.length ? cell.variants.map(v => v.effects) : [cell?.effects];
            for (const eff of cells) {
              totalCells++;
              const p = cfg.parser(eff);
              const stray = (p.other ?? []).filter(o => !cfg.allowOther.includes(o));
              if (stray.length) E(`[data] ${file} ${row.label}/${col} unrecognized token(s): ${JSON.stringify(stray)} in "${eff}"`);
            }
          }
        }
      }
      checkBands(tbl, file);
    }

    // registry for relationship graph
    if (t === "criticalTable" || t === "creatureCriticalTable") {
      const ct = String(tbl.critType ?? "").toLowerCase();
      if (ct) {
        if (critRegistry.has(ct)) W(`[rel] critType "${tbl.critType}" defined by two tables: ${critRegistry.get(ct).file} & ${file}`);
        critRegistry.set(ct, { type: t, file, slug, columns: colSet });
      }
    }
  }
}

/* ───────────────────────── C. RELATIONSHIP GRAPH ───────────────────────── */

const SEV_RE = /\bcrit:([a-z-]*):([A-E])\b/gi;
function scanChains(t) {
  for (const file of glob(TYPES[t].dir)) {
    const tbl = readJSON(file);
    for (const row of tbl.rows ?? []) {
      for (const [col, cell] of Object.entries(row.results ?? {})) {
        const effs = cell?.variants?.length ? cell.variants.map(v => v.effects) : [cell?.effects];
        for (const eff of effs) {
          for (const m of String(eff ?? "").matchAll(SEV_RE)) {
            const type = m[1].toLowerCase(), sev = m[2].toUpperCase();
            const where = `${file.split("/").pop()} ${row.label}/${col}`;
            if (!type) { N(`[rel] ${where}: generic chain crit::${sev} (GM picks the critical type) — OK`); continue; }
            const target = critRegistry.get(type);
            if (!target) W(`[rel] ${where}: chain crit:${type}:${sev} → no critical table with critType "${type}" (not imported)`);
            else if (!target.columns.has(sev)) E(`[rel] ${where}: chain crit:${type}:${sev} → table ${target.file.split("/").pop()} has no column "${sev}" (cols: ${[...target.columns].join("/")})`);
          }
        }
      }
    }
  }
}
scanChains("weaponFumbleTable");
scanChains("spellFailureTable");

/* Attack tables are a pure resolution matrix: they no longer carry crit
 * routing (critType / attackTypes) — that is per-weapon data on the weapon
 * item. Flag any stale routing left in attack-table data. */
for (const file of glob(TYPES.attackTable.dir)) {
  const tbl = readJSON(file);
  for (const k of ["critType", "attackTypes", "attackTypeNotes"]) {
    if (tbl[k] !== undefined) E(`[attack] ${file.split("/").pop()} still carries removed field "${k}" (crit routing belongs on the weapon item)`);
  }
}

/* ───────────────────────── Report ───────────────────────── */

console.log(`Audited ${TABLE_TYPE_IDS.length} table types, ${critRegistry.size} critical types in registry, ${totalCells} parsed cells.`);
console.log(`critType registry: ${[...critRegistry.keys()].sort().join(", ")}`);
if (notes.length)    console.log(`\nNOTES (${notes.length}):\n  ` + notes.join("\n  "));
if (warnings.length) console.log(`\n⚠ WARNINGS (${warnings.length}):\n  ` + warnings.join("\n  "));
if (errors.length)   console.log(`\n✗ ERRORS (${errors.length}):\n  ` + errors.join("\n  "));
else console.log(`\n✓ No errors. Registration aligned, data integrity OK, relationship graph resolves.`);
process.exit(errors.length ? 1 : 0);
