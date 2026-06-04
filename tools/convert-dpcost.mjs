/**
 * One-off dev tool — convert the legacy `dpCost: { price1, price2, price3 }`
 * triple to the RMF slash-notation STRING in the canonical data files, using
 * the runtime formatDPCost() so the source matches what the importer emits.
 *
 * Minimal-diff: a regex collapses each multi-line dpCost object in place,
 * leaving the surrounding formatting untouched. Trailing zeros are dropped
 * (padding), so {2,2,2}→"2/2/2", {6,0,0}→"6", {0,0,0}→"" — lossless for the
 * canonical data (verified: no front/middle zero gaps).
 *
 * Applies to categories.json (top-level dpCost), skills.json (top-level), and
 * professions.json (categoryPrice/spellPrice rows). training_packages.json is
 * untouched: its `special[].dpCost` is a single number, not the slash notation.
 *
 * Run from the system root:  node tools/convert-dpcost.mjs
 * Idempotent: only matches the object form, so re-running is a no-op.
 *
 * @see module/utils/dp-cost.mjs
 * @see ./refactor.md (Fase 1)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatDPCost } from "../module/utils/dp-cost.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// Matches `"dpCost": { "price1": N, "price2": N, "price3": N }` across newlines.
const TRIPLE = /"dpCost":\s*\{\s*"price1":\s*(-?\d+(?:\.\d+)?),\s*"price2":\s*(-?\d+(?:\.\d+)?),\s*"price3":\s*(-?\d+(?:\.\d+)?)\s*\}/g;

const FILES = ["data/categories.json", "data/skills.json", "data/professions.json"];

let total = 0;
for (const file of FILES) {
  const path = ROOT + file;
  let n = 0;
  const text = readFileSync(path, "utf8").replace(TRIPLE, (_m, p1, p2, p3) => {
    n++;
    const s = formatDPCost({ price1: Number(p1), price2: Number(p2), price3: Number(p3) });
    return `"dpCost": ${JSON.stringify(s)}`;
  });
  writeFileSync(path, text, "utf8");
  total += n;
  console.log(`  ${file}: ${n} dpCost → string`);
}
console.log(`\nDone: ${total} dpCost triples converted to slash notation.`);
