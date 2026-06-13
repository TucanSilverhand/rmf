/**
 * Dev/CI guard: make sure that regenerating the world compendium
 * (`regenerateBasicCore`, the GM "Generate/Reload" button) imports EVERY
 * item from EVERY JSON under data/. Two ways an item can silently fail to
 * import:
 *
 *   1. its file is not referenced by `regenerateBasicCore` (orphan on disk),
 *      or a referenced path no longer exists (broken reference);
 *   2. two items of the same type share an identity (slug, or slugify(name))
 *      or a name, so the slug-/name-first upsert collapses them.
 *
 * This tool checks both, deterministically, and prints the per-type item
 * counts. Exits non-zero on any problem. Run: node tools/audit-import-coverage.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugify } from "../module/utils/slug.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(path.join(ROOT, "data"), p).split(path.sep).join("/");
const errors = [];

/* All JSON files under data/ (data-relative paths). */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".json")) out.push(rel(p));
  }
  return out;
}
const diskFiles = walk(path.join(ROOT, "data")).sort();

/* Paths referenced by regenerateBasicCore: quoted *_FILES entries + `${dir}/...json`. */
const admin = fs.readFileSync(path.join(ROOT, "module/compendium-admin.mjs"), "utf8");
const referenced = new Set();
for (const m of admin.matchAll(/"([^"]+\.json)"/g)) referenced.add(m[1].replace(/^data\//, ""));
for (const m of admin.matchAll(/\$\{dir\}\/([^`"]+\.json)/g)) referenced.add(m[1]);

/* (1) Coverage — bidirectional. */
for (const f of diskFiles) if (!referenced.has(f)) errors.push(`[coverage] data/${f} exists but is NOT imported by regenerateBasicCore`);
for (const f of referenced) if (!fs.existsSync(path.join(ROOT, "data", f))) errors.push(`[coverage] regenerateBasicCore references data/${f} which does NOT exist`);

/* (2) Identity collisions — per content type. */
const ls = (sub) => fs.readdirSync(path.join(ROOT, "data", sub)).filter(f => f.endsWith(".json")).map(f => `${sub}/${f}`);
const GROUPS = {
  category: ["build_character/categories.json"], skill: ["build_character/skills.json"],
  realm: ["build_character/realms.json"], race: ["build_character/races.json"],
  profession: ["build_character/professions.json"], trainingPackage: ["build_character/training_packages.json"],
  spellList: ls("spell_lists"),
  attackTable: ls("system_tables/attack_tables"),
  criticalTable: ls("system_tables/critical_tables"),
  creatureCriticalTable: ls("system_tables/creature_critical_tables"),
  weaponFumbleTable: ls("system_tables/fumble_tables"),
  spellFailureTable: ls("system_tables/spell_failure_tables")
};
const itemsOf = (json) => Array.isArray(json) ? json
  : Array.isArray(json?.lists) ? json.lists
  : Array.isArray(json?.tables) ? json.tables : [json];

let grand = 0;
const counts = [];
for (const [type, files] of Object.entries(GROUPS)) {
  const items = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8")); }
    catch (e) { errors.push(`[json] data/${f}: ${e.message}`); continue; }
    for (const x of itemsOf(j)) items.push({ name: String(x?.name ?? x?.system?.name ?? ""), slug: String((x?.slug ?? x?.system?.slug) || "") });
  }
  const byId = {}, byName = {};
  for (const x of items) {
    const id = x.slug || slugify(x.name);
    (byId[id] ??= []).push(x.name);
    (byName[x.name.toLowerCase()] ??= []).push(x.name);
  }
  for (const [id, names] of Object.entries(byId)) if (names.length > 1) errors.push(`[identity] ${type}: ${names.length} items share identity "${id}" (${names.join(" / ")}) — upsert would collapse them`);
  for (const [n, names] of Object.entries(byName)) if (names.length > 1 && n) errors.push(`[identity] ${type}: ${names.length} items share name "${names[0]}" — name-fallback upsert would collapse them`);
  grand += items.length;
  counts.push([type, items.length, files.length]);
}

for (const [type, n, f] of counts) console.log(`${type.padEnd(22)} ${String(n).padStart(4)} items  (${f} file${f > 1 ? "s" : ""})`);
console.log(`\n${diskFiles.length} data files, ${grand} items total.`);
if (errors.length) { console.log(`\n✗ ${errors.length} problem(s):\n  ` + errors.join("\n  ")); process.exit(1); }
console.log(`\n✓ Every data JSON is imported by regenerateBasicCore; no identity collisions — all ${grand} items import as distinct entries.`);
