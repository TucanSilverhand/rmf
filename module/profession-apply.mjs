/**
 * RMF System - Profession application logic.
 *
 * When a `profession` item is added to a character (typically via the
 * actor-sheet drop handler), iterate `system.professionalBonuses[]` and
 * apply each entry to the appropriate target on the actor:
 *
 *   - Suffix " Category" → bump the matching category item's `profBonus`
 *     by the bonus amount. Categories missing on the actor are reported
 *     in the chat (no auto-creation, per spec).
 *   - Suffix " Group" → resolve the prefix as a schema group (with
 *     normalisation, so "Spell" → "Spells") or, as a fallback, as a
 *     category name. Apply the bonus to every skill in `world.basic-core`
 *     that matches; auto-create skills that the actor doesn't have yet.
 *   - Anything else → reported in chat as "unrecognised". Lets the GM
 *     spot data-entry mistakes (e.g. the legacy " Skill" suffix).
 *
 * The applied deltas are persisted on
 * `actor.flags.rmf.appliedProfessionBonuses[<profItemId>]` so that
 * removing the profession item later (`unapplyProfessionFromActor`)
 * subtracts back exactly what was added.
 *
 * Both flows run on the client that owns the original create/delete
 * event (filter `game.userId === userId` lives in `hooks.mjs`).
 *
 * @module
 */

import { normalizeCategoryGroup } from "./data-models/category.mjs";

/**
 * Compendium pack that holds the canonical Categories and Skills.
 * Same constant the Training Package sheet uses.
 * @type {string}
 */
const BASIC_CORE_PACK = "world.basic-core";

/**
 * Cached basic-core index keyed by intent. Skill rows include
 * `system.group` and `system.category` so we can filter by either
 * without `pack.getDocuments()`.
 * @type {{ skills: Array<{name: string, group: string, category: string, _id: string}>, byName: Map<string, object> } | null}
 */
let _basicCoreCache = null;

async function _loadBasicCoreSkills() {
  if (_basicCoreCache) return _basicCoreCache;
  const pack = game.packs?.get(BASIC_CORE_PACK);
  if (!pack || pack.documentName !== "Item") {
    _basicCoreCache = { skills: [], byName: new Map() };
    return _basicCoreCache;
  }
  try {
    await pack.getIndex({ fields: ["name", "type", "system.group", "system.category"] });
  } catch (err) {
    console.warn("RMF | Failed to read basic-core index for profession apply", err);
    _basicCoreCache = { skills: [], byName: new Map() };
    return _basicCoreCache;
  }
  const skills = [];
  const byName = new Map();
  for (const entry of pack.index) {
    if (entry.type !== "skill") continue;
    const row = {
      _id: entry._id,
      name: entry.name,
      group: typeof entry.system?.group === "string" ? entry.system.group : "none",
      category: typeof entry.system?.category === "string" ? entry.system.category : ""
    };
    skills.push(row);
    byName.set(row.name, row);
  }
  _basicCoreCache = { skills, byName };
  return _basicCoreCache;
}

/** Drop the cached basic-core skill index. */
export function invalidateProfessionApplyCache() {
  _basicCoreCache = null;
}

/**
 * Apply a profession's professionalBonuses to its embedding character.
 * Persists per-profession deltas on `actor.flags.rmf.appliedProfessionBonuses`
 * for later reversal.
 *
 * @param {Item} profItem - The `profession` item embedded in an actor
 * @returns {Promise<boolean>} true when at least one bonus was processed
 */
export async function applyProfessionToActor(profItem) {
  if (profItem?.type !== "profession") return false;
  const actor = profItem.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  if (actor.type !== "character") return false;

  const bonuses = profItem.system?.professionalBonuses ?? [];
  if (!Array.isArray(bonuses) || !bonuses.length) return false;

  const { skills: canonSkills } = await _loadBasicCoreSkills();
  const canonSkillByGroup = new Map();
  const canonSkillByCategory = new Map();
  for (const sk of canonSkills) {
    const g = sk.group;
    const c = sk.category;
    if (g) (canonSkillByGroup.get(g) ?? canonSkillByGroup.set(g, []).get(g)).push(sk);
    if (c) (canonSkillByCategory.get(c) ?? canonSkillByCategory.set(c, []).get(c)).push(sk);
  }

  const log = {
    appliedCategories: [],   // [{name, delta}]
    appliedSkills:     [],   // [{name, delta}]
    createdSkills:     [],   // names auto-created from basic-core
    missingCategories: [],   // names not present on actor
    unrecognised:      []    // {name, bonus, reason}
  };
  const flagEntry = {
    professionName: profItem.name,
    categories: [],          // [{itemId, delta}]
    skills:     []           // [{itemId, delta}]
  };

  // First pass: determine which skills we need to auto-create.
  const skillsToCreate = new Map(); // canonSkillName -> canonSkill row
  const queuedSkillBumps = [];      // {skillName, delta}
  const queuedCategoryBumps = [];   // {categoryName, delta}
  const unrecognised = log.unrecognised;

  for (const entry of bonuses) {
    const rawName = typeof entry?.name === "string" ? entry.name : "";
    const bonus = Number(entry?.bonus) || 0;
    if (!rawName || !bonus) continue;

    if (rawName.endsWith(" Category")) {
      const target = rawName.slice(0, -" Category".length).trim();
      queuedCategoryBumps.push({ categoryName: target, delta: bonus });
      continue;
    }

    if (rawName.endsWith(" Group")) {
      const rawPrefix = rawName.slice(0, -" Group".length).trim();
      const normalisedGroup = normalizeCategoryGroup(rawPrefix);
      // Prefer schema-group match; fall back to category name match.
      let matches = (normalisedGroup !== "none")
        ? (canonSkillByGroup.get(normalisedGroup) ?? [])
        : [];
      if (!matches.length) matches = canonSkillByCategory.get(rawPrefix) ?? [];
      if (!matches.length) {
        unrecognised.push({ name: rawName, bonus, reason: "group not found" });
        continue;
      }
      for (const sk of matches) {
        queuedSkillBumps.push({ skillName: sk.name, delta: bonus });
        if (!actor.itemTypes?.skill?.some(s => s.name === sk.name)) {
          if (!skillsToCreate.has(sk.name)) skillsToCreate.set(sk.name, sk);
        }
      }
      continue;
    }

    // Unknown suffix (e.g. legacy " Skill", or no suffix at all).
    unrecognised.push({ name: rawName, bonus, reason: "unrecognised suffix" });
  }

  // Auto-create missing skills for Group bumps from basic-core.
  if (skillsToCreate.size) {
    const created = await _createSkillsFromBasicCore(actor, [...skillsToCreate.values()]);
    for (const c of created) log.createdSkills.push(c.name);
  }

  // Build the final update list, summing on top of the existing profBonus.
  const skillsByName = new Map(actor.itemTypes?.skill?.map(s => [s.name, s]) ?? []);
  const categoriesByName = new Map(actor.itemTypes?.category?.map(c => [c.name, c]) ?? []);
  const updates = [];

  for (const { categoryName, delta } of queuedCategoryBumps) {
    const cat = categoriesByName.get(categoryName);
    if (!cat) {
      log.missingCategories.push(categoryName);
      continue;
    }
    const current = Number(cat.system?.profBonus) || 0;
    updates.push({ _id: cat.id, "system.profBonus": current + delta });
    flagEntry.categories.push({ itemId: cat.id, delta });
    log.appliedCategories.push({ name: cat.name, delta });
  }

  // Re-fetch skills map after potential creation.
  for (const { skillName, delta } of queuedSkillBumps) {
    const sk = skillsByName.get(skillName) ?? actor.itemTypes?.skill?.find(s => s.name === skillName);
    if (!sk) continue; // creation failed; already noted
    const current = Number(sk.system?.profBonus) || 0;
    updates.push({ _id: sk.id, "system.profBonus": current + delta });
    flagEntry.skills.push({ itemId: sk.id, delta });
    log.appliedSkills.push({ name: sk.name, delta });
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }

  // Persist the per-profession delta log on the actor for unassign.
  await actor.update({
    [`flags.rmf.appliedProfessionBonuses.${profItem.id}`]: flagEntry
  });

  await _postProfessionApplyMessage(actor, profItem, log);
  return true;
}

/**
 * Subtract the bonuses persisted under
 * `actor.flags.rmf.appliedProfessionBonuses[<itemId>]` and clear the flag.
 *
 * No-op when no flag exists for this profession (e.g. profession imported
 * before this feature, or already unassigned).
 *
 * @param {Item} profItem - The profession item being deleted
 * @returns {Promise<boolean>}
 */
export async function unapplyProfessionFromActor(profItem) {
  if (profItem?.type !== "profession") return false;
  const actor = profItem.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  if (actor.type !== "character") return false;

  const flag = actor.flags?.rmf?.appliedProfessionBonuses?.[profItem.id];
  if (!flag) return false;

  const updates = [];
  for (const { itemId, delta } of (flag.categories ?? [])) {
    const cat = actor.items.get(itemId);
    if (!cat || cat.type !== "category") continue;
    const current = Number(cat.system?.profBonus) || 0;
    updates.push({ _id: cat.id, "system.profBonus": current - delta });
  }
  for (const { itemId, delta } of (flag.skills ?? [])) {
    const sk = actor.items.get(itemId);
    if (!sk || sk.type !== "skill") continue;
    const current = Number(sk.system?.profBonus) || 0;
    updates.push({ _id: sk.id, "system.profBonus": current - delta });
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }

  // Drop the flag entry. Use `-=` notation to delete the key cleanly.
  await actor.update({
    [`flags.rmf.appliedProfessionBonuses.-=${profItem.id}`]: null
  });

  if (CONFIG.RMF?.debug) {
    console.log(`RMF DEBUG | Unapplied profession '${flag.professionName}' from ${actor.name}: reverted ${updates.length} item(s)`);
  }
  return true;
}

/**
 * Create skill documents on the actor by cloning entries from
 * `world.basic-core`. Returns the created Item documents.
 *
 * @private
 * @param {Actor} actor
 * @param {Array<{_id: string}>} canonRows
 * @returns {Promise<Item[]>}
 */
async function _createSkillsFromBasicCore(actor, canonRows) {
  const pack = game.packs?.get(BASIC_CORE_PACK);
  if (!pack) return [];
  const docs = [];
  for (const row of canonRows) {
    try {
      const src = await pack.getDocument(row._id);
      if (!src) continue;
      const obj = src.toObject();
      delete obj._id;
      docs.push(obj);
    } catch (err) {
      console.warn(`RMF | Failed to fetch basic-core skill ${row.name}`, err);
    }
  }
  if (!docs.length) return [];
  return actor.createEmbeddedDocuments("Item", docs);
}

/**
 * Post a chat-message recap of the apply pass.
 * @private
 */
async function _postProfessionApplyMessage(actor, profItem, log) {
  const t = (key, data) => game.i18n.format(key, data ?? {});
  const lines = [
    `<h3>${t("RMF.Profession.AppliedHeader", { name: profItem.name, actor: actor.name })}</h3>`
  ];

  if (log.appliedCategories.length || log.appliedSkills.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.Profession.AppliedSection")}</strong></p><ul>`);
    for (const c of log.appliedCategories) lines.push(`<li>${t("RMF.Profession.AppliedCategory", { name: c.name, bonus: c.delta })}</li>`);
    for (const s of log.appliedSkills)     lines.push(`<li>${t("RMF.Profession.AppliedSkill",    { name: s.name, bonus: s.delta })}</li>`);
    lines.push("</ul>");
  }

  if (log.createdSkills.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.Profession.CreatedSection")}</strong></p><ul>`);
    for (const n of log.createdSkills) lines.push(`<li>${n}</li>`);
    lines.push("</ul>");
  }

  if (log.missingCategories.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.Profession.MissingSection")}</strong></p><ul>`);
    for (const n of log.missingCategories) lines.push(`<li>${n}</li>`);
    lines.push("</ul>");
  }

  if (log.unrecognised.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.Profession.UnrecognisedSection")}</strong></p><ul>`);
    for (const u of log.unrecognised) lines.push(`<li>${u.name} (+${u.bonus}) — ${u.reason}</li>`);
    lines.push("</ul>");
  }

  ChatMessage.implementation.create({
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    content: lines.join("\n")
  });
}
