/**
 * RMF System — resolve a skill/category DP cost from the actor's profession.
 *
 * In RMFRP the development-point cost — which doubles as the per-level rank
 * cadence ("3", "2/4", "2/2/2", …) — lives in the PROFESSION, not in the skill
 * or category item (their own `dpCost` is blank in the canonical data). The
 * profession's `categoryPrice` table maps each skill category to its cost; a
 * skill inherits the cost of its category (there is no per-skill price).
 *
 * NOTE: the Spells categories (Spells · Own Realm Closed/Open/Own Base) are not
 * covered here — their cost is tiered by spell-list number/level via the
 * profession's `spellPrice` table and must be resolved separately.
 *
 * @module profession-cost
 */

import { slugify } from "./utils/slug.mjs";

/**
 * Build a `{ categorySlug: dpCostString }` index from a profession's
 * `categoryPrice` list.
 *
 * @param {object} professionSystem  profession item `system` data
 * @returns {Record<string,string>}
 */
export function buildCategoryPriceIndex(professionSystem) {
  const index = {};
  for (const entry of professionSystem?.categoryPrice ?? []) {
    if (entry?.name) index[slugify(entry.name)] = String(entry.dpCost ?? "");
  }
  return index;
}

/**
 * Resolve the DP cost string for a skill/category item from a price index.
 *   - category → matched by its own slug (or slugified name).
 *   - skill    → matched by its category's slug (skills inherit category cost).
 *
 * @param {Item} item                 a skill or category item
 * @param {Record<string,string>} index
 * @returns {string|undefined}        cost string, or undefined when no match
 */
export function resolveDpCostFromIndex(item, index) {
  if (!item || !index) return undefined;
  if (item.type === "category") {
    return index[item.system?.slug || slugify(item.name)];
  }
  if (item.type === "skill") {
    const category = item.system?.category;
    if (!category) return undefined;
    return index[slugify(category)];
  }
  return undefined;
}

/**
 * Resolve the DP cost for a single skill/category against the actor's
 * profession. Returns undefined when there's no profession or no match.
 *
 * @param {Item} item
 * @param {Actor} actor
 * @returns {string|undefined}
 */
export function resolveDpCostForActorItem(item, actor) {
  const profession = actor?.itemTypes?.profession?.[0];
  if (!profession) return undefined;
  return resolveDpCostFromIndex(item, buildCategoryPriceIndex(profession.system));
}

/**
 * Sync the `dpCost` of every skill & category on the actor to its profession's
 * `categoryPrice`. Items with no matching price (e.g. Spells categories) are
 * left untouched. No-op when the actor has no profession.
 *
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function syncDpCostsFromProfession(actor) {
  const profession = actor?.itemTypes?.profession?.[0];
  if (!profession) return;
  const index = buildCategoryPriceIndex(profession.system);
  const updates = [];
  const items = [...(actor.itemTypes.category ?? []), ...(actor.itemTypes.skill ?? [])];
  for (const item of items) {
    const cost = resolveDpCostFromIndex(item, index);
    if (cost !== undefined && cost !== item.system?.dpCost) {
      updates.push({ _id: item.id, "system.dpCost": cost });
    }
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/**
 * Build a `{ trainingPackageSlug: dpCost }` index from a profession's
 * `trainingPackages` list. A training package's DP cost depends on the
 * character's profession.
 *
 * @param {object} professionSystem
 * @returns {Record<string,number>}
 */
export function buildTrainingPackagePriceIndex(professionSystem) {
  const index = {};
  for (const entry of professionSystem?.trainingPackages ?? []) {
    if (entry?.name) index[slugify(entry.name)] = Number(entry.dpCost) || 0;
  }
  return index;
}

/**
 * Resolve the DP cost of a training-package item from the actor's profession
 * (`profession.trainingPackages`, matched by slug). Returns undefined when
 * there's no profession or no matching package.
 *
 * @param {Item} tpItem   a trainingPackage item
 * @param {Actor} actor
 * @returns {number|undefined}
 */
export function resolveTrainingPackageCost(tpItem, actor) {
  const profession = actor?.itemTypes?.profession?.[0];
  if (!profession) return undefined;
  const slug = tpItem?.system?.slug || slugify(tpItem?.name ?? "");
  return buildTrainingPackagePriceIndex(profession.system)[slug];
}
