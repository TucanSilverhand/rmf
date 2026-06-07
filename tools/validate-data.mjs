#!/usr/bin/env node
/**
 * Schema-shape sanity check for data/*.json (offline, sin Foundry).
 *
 * For each canonical Item type the project ships pre-baked in /data/,
 * verify that every entry matches the loose shape the DataModel
 * expects. We don't reproduce the full schema validator (that runs
 * inside Foundry); we only enforce the shape contracts that have
 * historically broken (string vs object arrays, missing / mistyped
 * fields, classification values outside the canonical set).
 *
 * Exit code: 0 on success, 1 if any error is detected.
 *
 * Used by .github/workflows/validate.yml. Run locally:
 *   node tools/validate-data.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ───────────────────── Shape definitions ───────────────────── */

// Each entry: { fieldName: expectedTypeOrPredicate }
// Predicates receive the value and must return true.
const isStr  = v => typeof v === "string";
const isNum  = v => typeof v === "number" && Number.isFinite(v);
const isBool = v => typeof v === "boolean";
const isObj  = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr  = v => Array.isArray(v);
// dpCost is the RMF slash-notation string ("2/5", "7/8/9", "3/*"); "" means
// "no cost / overwritten by the active profession". Legacy { price1, price2,
// price3 } triples are still tolerated — the data model normalizes them to the
// string form on load (see module/utils/dp-cost.mjs).
const isDPCost = v => isStr(v) || isObj(v);

const SKILL_CLASSIFICATIONS = new Set([
  "movingManeuver", "staticManeuver", "offensiveBonus", "specialPurpose"
]);
const CATEGORY_PROGRESSIONS = new Set(["standard", "nonstandard"]);
const SKILL_PROGRESSIONS    = new Set(["standard", "combined", "limited", "special"]);

/** Map type → required-when-present field shape. */
const SHAPES = {
  category: {
    description: isStr, group: isStr, dpCost: isDPCost, boughtByLevel: isObj,
    freeRanks: isNum, categoryRankBonusProgression: isStr, ranks: isNum,
    statBonus: isObj, profBonus: isNum, spec1Bonus: isNum, spec2Bonus: isNum,
    fromBook: isStr
  },
  skill: {
    description: isStr, rank: isNum, category: isStr, group: isStr,
    classification: isStr, dpCost: isDPCost, boughtByLevel: isObj,
    skillRankBonusProgression: isStr, commonlyUsed: isBool,
    profBonus: isNum, spec1Bonus: isNum, spec2Bonus: isNum,
    specialStatus: isStr, fromBook: isStr
  },
  race: {
    description: isStr, racialAbilities: isStr, stats: isObj,
    resistances: isObj, backgroundOptions: isNum,
    bodyDevelopment: isStr, ppChanneling: isStr, ppEssence: isStr,
    ppMentalism: isStr, hobbyRanks: isNum, racialRanks: isObj,
    specialSkills: isObj, standardHobbySkills: isStr, fromBook: isStr
  },
  realm: {
    description: isStr, powerPointsType: isStr, statBonus: isObj, fromBook: isStr
  },
  profession: {
    description: isStr, primeStats: isArr, professionalBonuses: isArr,
    everymanSkills: isArr, occupationalSkills: isArr,
    restrictedSkills: isArr, categoryPrice: isArr, spellPrice: isArr,
    trainingPackages: isArr, fromBook: isStr
  },
  trainingPackage: {
    type: isStr, description: isStr, timeToAcquire: isStr,
    startingMoney: isStr, statGains: isStr,
    special: isArr, categoryRanks: isArr, fromBook: isStr
  }
};

const FILES = [
  ["data/categories.json",        "category"],
  ["data/skills.json",            "skill"],
  ["data/races.json",             "race"],
  ["data/realms.json",            "realm"],
  ["data/professions.json",       "profession"],
  ["data/training_packages.json", "trainingPackage"]
];

/* ───────────────────── Validation logic ───────────────────── */

const errors = [];
const warnings = [];

/**
 * Coerce JSON files that arrive as `[ … ]` or as `{ <wrap>: [ … ] }`
 * (some sources of canonical data wrap arrays under their type key).
 */
function entries(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const v of Object.values(raw)) if (Array.isArray(v)) return v;
  }
  return [];
}

function checkEntry(file, idx, entry, type) {
  const name = entry?.name ?? `<unnamed#${idx}>`;
  const sysd = entry.system ?? entry;
  const expected = SHAPES[type];
  if (!expected) return;

  for (const [field, pred] of Object.entries(expected)) {
    if (!(field in sysd)) continue; // missing → schema fills with `initial`
    if (!pred(sysd[field])) {
      errors.push(`${file}[${idx}] "${name}" (${type}): ${field} has wrong type — got ${JSON.stringify(sysd[field])?.slice(0, 60)}`);
    }
  }

  // Type-specific checks
  if (type === "skill") {
    const cls = sysd.classification;
    if (cls && !SKILL_CLASSIFICATIONS.has(cls)) {
      errors.push(`${file}[${idx}] "${name}": classification "${cls}" is outside the canonical set`);
    }
    const prog = sysd.skillRankBonusProgression;
    if (prog && !SKILL_PROGRESSIONS.has(prog)) {
      warnings.push(`${file}[${idx}] "${name}": progression "${prog}" outside set; will be normalized at runtime`);
    }
  }

  if (type === "category") {
    const prog = sysd.categoryRankBonusProgression;
    if (prog && !CATEGORY_PROGRESSIONS.has(prog)) {
      warnings.push(`${file}[${idx}] "${name}": progression "${prog}" outside set; will be normalized at runtime`);
    }
  }

  if (type === "profession") {
    // Arrays whose entries must be objects with a string `name` field.
    for (const k of ["everymanSkills", "occupationalSkills", "restrictedSkills"]) {
      const list = sysd[k];
      if (!Array.isArray(list)) continue;
      list.forEach((e, i) => {
        if (!isObj(e) || !isStr(e.name)) {
          errors.push(`${file} "${name}".${k}[${i}] should be { name: string }, got ${JSON.stringify(e)?.slice(0, 60)}`);
        }
      });
    }
  }

  if (type === "trainingPackage") {
    // special[]: array of {name, dpCost: number}
    for (const [i, e] of (sysd.special ?? []).entries()) {
      if (!isObj(e) || !isStr(e.name) || !isNum(e.dpCost)) {
        errors.push(`${file} "${name}".special[${i}] should be { name: string, dpCost: number }, got ${JSON.stringify(e)?.slice(0, 80)}`);
      }
    }
    // categoryRanks[]: array of {category, ranks, isChoice?, skills: [{name, ranks, isChoice?}]}
    for (const [i, c] of (sysd.categoryRanks ?? []).entries()) {
      if (!isObj(c) || !isStr(c.category) || !isNum(c.ranks)) {
        errors.push(`${file} "${name}".categoryRanks[${i}] should be { category: string, ranks: number, ... }, got ${JSON.stringify(c)?.slice(0, 80)}`);
        continue;
      }
      for (const [j, s] of (c.skills ?? []).entries()) {
        if (!isObj(s) || !isStr(s.name) || !isNum(s.ranks)) {
          errors.push(`${file} "${name}".categoryRanks[${i}].skills[${j}] should be { name: string, ranks: number, ... }, got ${JSON.stringify(s)?.slice(0, 80)}`);
        }
      }
    }
  }
}

/* ───────────────────── Run ───────────────────── */

let totalEntries = 0;
for (const [relPath, type] of FILES) {
  const fullPath = resolve(ROOT, relPath);
  const raw = JSON.parse(readFileSync(fullPath, "utf8"));
  const items = entries(raw);
  totalEntries += items.length;
  items.forEach((e, i) => checkEntry(relPath, i, e, type));
}

console.log(`Validated ${totalEntries} entries across ${FILES.length} data files.`);
if (warnings.length) {
  console.log(`\n⚠  ${warnings.length} warnings:`);
  for (const w of warnings.slice(0, 10)) console.log("  - " + w);
  if (warnings.length > 10) console.log(`  …and ${warnings.length - 10} more.`);
}
if (errors.length) {
  console.error(`\n✖  ${errors.length} errors:`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("\n✓ Schema-shape OK.");
