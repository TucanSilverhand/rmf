#!/usr/bin/env node
/**
 * Static check: every Handlebars partial referenced by a template
 * (`{{> parts/foo}}` or `{{> "parts/foo"}}`) must be loaded by
 * `_preloadHandlebarsTemplates` in rmf.mjs.
 *
 * Foundry's `loadTemplates(object)` registers each value path under
 * its key name as a partial alias. We extract those keys from
 * rmf.mjs and compare against every partial reference we find in
 * `templates/**\/*.hbs`.
 *
 * Replaces the in-Foundry console snippet `check-partials.js`, which
 * required the app to be running.
 *
 * Used by .github/workflows/validate.yml. Run locally:
 *   node tools/check-partials.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ────────── Extract declared partial aliases from rmf.mjs ────────── */

const rmfSrc = readFileSync(resolve(ROOT, "rmf.mjs"), "utf8");

// Match the keys inside the `partials = { ... }` block in
// `_preloadHandlebarsTemplates`. Keys are double-quoted strings.
const declared = new Set();
const blockMatch = rmfSrc.match(/_preloadHandlebarsTemplates[\s\S]*?const\s+partials\s*=\s*\{([\s\S]*?)\};/);
if (!blockMatch) {
  console.error("✖  Could not locate `const partials = { … }` inside rmf.mjs:_preloadHandlebarsTemplates");
  process.exit(1);
}
for (const m of blockMatch[1].matchAll(/"([^"]+)"\s*:/g)) {
  declared.add(m[1]);
}

if (!declared.size) {
  console.error("✖  Empty partials map. Aborting.");
  process.exit(1);
}

/* ────────── Walk templates/ and collect partial references ────────── */

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".hbs")) yield full;
  }
}

const referenced = new Map();   // partialName → Set(filePaths)
const PARTIAL_RE = /\{\{>\s*"?([A-Za-z0-9_\-/.]+)"?/g;

for (const file of walk(resolve(ROOT, "templates"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(PARTIAL_RE)) {
    const name = m[1];
    if (!referenced.has(name)) referenced.set(name, new Set());
    referenced.get(name).add(relative(ROOT, file));
  }
}

/* ────────── Compare ────────── */

const missing = [];     // referenced but not declared
const unused  = [];     // declared but never referenced
for (const [name, files] of referenced) {
  if (!declared.has(name)) missing.push({ name, files: [...files] });
}
for (const name of declared) {
  // Only consider top-level partial-style aliases (`parts/...`) as
  // candidates for "unused". Templates registered as the root form
  // for a sheet (e.g. "rmf/actor-sheet") may legitimately not be
  // referenced as partials — they are the entry templates.
  if (name.startsWith("parts/") && !referenced.has(name)) unused.push(name);
}

console.log(`Declared partials in rmf.mjs:        ${declared.size}`);
console.log(`Distinct references in templates/:    ${referenced.size}`);

if (missing.length) {
  console.error(`\n✖  ${missing.length} partial(s) referenced but NOT declared:`);
  for (const { name, files } of missing) {
    console.error(`  - "${name}"  (used in: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})`);
  }
}

if (unused.length) {
  console.warn(`\n⚠  ${unused.length} declared partial(s) never referenced (may be reserved for future use):`);
  for (const name of unused) console.warn("  - " + name);
}

if (missing.length) process.exit(1);
console.log("\n✓ Every referenced partial is declared.");
