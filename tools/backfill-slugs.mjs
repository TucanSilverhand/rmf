/**
 * One-off dev tool — backfill `slug` (and `specialRole`) into the canonical
 * data/*.json content files, using the SAME slugify() the runtime uses so
 * the source of truth matches what the importer/hook would stamp.
 *
 * MINIMAL-DIFF strategy: the canonical files use a hand-tuned compact
 * formatting (single-line objects for small blocks). We do NOT re-serialize
 * the JSON (that would reflow every line); instead we insert a `slug` line
 * immediately after each TOP-LEVEL entry's `"name"` line (4-space indent),
 * preserving the rest byte-for-byte. Nested `"name"` keys (deeper indent,
 * e.g. racialRanks rows) are untouched. Idempotent: skips entries that
 * already have a slug line.
 *
 * Also applies a known errata: the Dwarf/Halfling racial everyman skill
 * "Caving" -> "Caving (Spelunking)" (the canonical skill name in
 * skills.json). The dangling "Horticulture" reference is LEFT ALONE and
 * reported, pending the user's decision.
 *
 * Run from the system root:  node tools/backfill-slugs.mjs
 *
 * @see module/utils/slug.mjs
 * @see ./refactor.md (Fase 0)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { slugify } from "../module/utils/slug.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** specialRole derived from a name — mirrors module/data-models/_identity.mjs. */
function specialRoleFromName(name) {
  switch (slugify(name)) {
    case "body-development":        return "bodyDevelopment";
    case "power-point-development": return "powerPointDevelopment";
    default:                        return "none";
  }
}

// Top-level entry name line: exactly 4 leading spaces, with a trailing comma.
const TOP_NAME = /^ {4}"name":\s*"(.+?)"\s*,\s*$/;

/**
 * Insert `slug` (and specialRole) after each top-level `name` line.
 * @returns {{text: string, rows: number, roles: number}}
 */
function backfill(text, { withSpecialRole }) {
  const lines = text.split("\n");
  const out = [];
  let rows = 0, roles = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.match(TOP_NAME);
    if (!m) continue;
    // Idempotency: skip if a slug line already follows.
    if (/^ {4}"slug":/.test(lines[i + 1] ?? "")) continue;
    const name = m[1];
    out.push(`    "slug": ${JSON.stringify(slugify(name))},`);
    rows++;
    if (withSpecialRole) {
      const role = specialRoleFromName(name);
      if (role !== "none") { out.push(`    "specialRole": ${JSON.stringify(role)},`); roles++; }
    }
  }
  return { text: out.join("\n"), rows, roles };
}

const FILES = [
  { file: "data/categories.json",        withSpecialRole: true  },
  { file: "data/skills.json",            withSpecialRole: true  },
  { file: "data/professions.json",       withSpecialRole: false },
  { file: "data/races.json",             withSpecialRole: false },
  { file: "data/realms.json",            withSpecialRole: false },
  { file: "data/training_packages.json", withSpecialRole: false }
];

let totalRows = 0, totalRoles = 0;
for (const { file, withSpecialRole } of FILES) {
  const path = ROOT + file;
  let text = readFileSync(path, "utf8");

  // Errata (races only): "Caving" -> "Caving (Spelunking)". Idempotent (the
  // exact-match regex never re-matches the already-corrected value).
  let cavingFixes = 0;
  if (file.endsWith("races.json")) {
    text = text.replace(/"name":\s*"Caving"/g, () => { cavingFixes++; return '"name": "Caving (Spelunking)"'; });
  }

  const { text: next, rows, roles } = backfill(text, { withSpecialRole });
  writeFileSync(path, next, "utf8");
  totalRows += rows; totalRoles += roles;
  console.log(`  ${file}: +${rows} slug${roles ? `, +${roles} specialRole` : ""}${cavingFixes ? `, ${cavingFixes} Caving fix` : ""}`);
}

console.log(`\nDone: +${totalRows} slug, +${totalRoles} specialRole (minimal-diff insertion).`);
