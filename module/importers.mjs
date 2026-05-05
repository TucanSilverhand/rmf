/**
 * RMF Importers - Utilities to import data into the RMF system
 * FoundryVTT v13.341 compatible (no deprecated V1 APIs)
 */

import {
  normalizeCategoryProgression,
  normalizeSkillProgression,
  normalizeSkillClassification
} from "./utils/rank-bonus.mjs";
import { STAT_SHORT_TO_FULL } from "./utils/constants.mjs";

/**
 * Throw a permission error unless the current user is GM.
 * Importers/sync functions write to the world compendium and to world-level
 * folders, so they must never run from a player macro or on a player client.
 *
 * @param {string} operation - human-readable name used in the error message
 * @throws {Error} when invoked by a non-GM user
 * @private
 */
function _assertGM(operation) {
  if (!game.user?.isGM) {
    const msg = `RMF | "${operation}" requires GM privileges.`;
    ui.notifications?.error(msg);
    throw new Error(msg);
  }
}

/**
 * Validate that a URL/path used as data source is safe to fetch.
 * Accepts only:
 *   - relative paths under systems/, worlds/, modules/ (Foundry-served)
 *   - absolute https:// URLs
 * Rejects: http://, file://, data:, javascript:, ftp://, anything else.
 *
 * @param {string} url - the trimmed source string
 * @throws {Error} when the URL falls outside the allowlist
 * @private
 */
function _assertSafeSourceUrl(url) {
  if (typeof url !== "string" || !url.length) {
    throw new Error("RMF | importer source URL is empty.");
  }

  // Strip a single leading "/" so "/systems/foo" and "systems/foo" both validate.
  const path = url.startsWith("/") ? url.slice(1) : url;

  // Allow Foundry-served relative paths.
  if (/^(systems|worlds|modules)\//.test(path)) return;

  // Allow absolute https only.
  if (/^https:\/\//i.test(url)) return;

  throw new Error(
    `RMF | Refusing to fetch importer source "${url}". ` +
    `Only paths under systems/, worlds/, modules/, or absolute https:// URLs are allowed.`
  );
}

/**
 * Import multiple Race items from a JSON source.
 * - Accepts: array of race entries, JSON string, or URL to a JSON file.
 * - Normalizes keys to match RMF template (stats/resistances short keys).
 * - Creates a folder named "Races" (type Item) if not present.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.folderName="Races"] - Target folder name
 * @param {boolean} [options.dedupeByName=false] - Skip creation if an item with same name exists
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importRaces(source, options = {}) {
  _assertGM("importRaces");
  const folderName = options.folderName ?? "Races";
  const dedupeByName = options.dedupeByName ?? false;

  const result = { created: [], skipped: [], errors: [] };

  try {
    const racesInput = await resolveSource(source);
    const races = Array.isArray(racesInput) ? racesInput : (racesInput?.races ?? [racesInput]).filter(Boolean);
    if (!races?.length) return result;

    // Ensure target folder exists
    let folder = game.folders.find(f => f.type === "Item" && f.name === folderName) || null;
    if (!folder) {
      try {
        folder = await Folder.create({ name: folderName, type: "Item" });
      } catch (e) {
        console.warn("RMF | Failed creating folder", e);
      }
    }

    const tmpl = await getRaceTemplate();

    // Optionally dedupe by name
    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "race") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < races.length; i++) {
      const r = races[i];
      const name = r.name ?? `Race ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }

      const sysSource = r.system ?? r; // allow both shapes
      const system = foundry.utils.mergeObject(
        foundry.utils.duplicate(tmpl),
        {
          description: sysSource.description ?? "",
          racialAbilities: sysSource.racialAbilities ?? "",
          stats: normalizeRaceStats(sysSource.stats),
          resistances: normalizeRaceResistances(sysSource.resistances),
          backgroundOptions: sysSource.backgroundOptions ?? 0,
          bodyDevelopment: normalizeRaceProgressionString(sysSource.bodyDevelopment),
          ppChanneling: normalizeRaceProgressionString(sysSource.ppChanneling),
          ppEssence: normalizeRaceProgressionString(sysSource.ppEssence),
          ppMentalism: normalizeRaceProgressionString(sysSource.ppMentalism),
          hobbyRanks: normalizeRaceHobbyRanks(sysSource.hobbyRanks),
          racialRanks: normalizeRacialRanks(sysSource.racialRanks),
          specialSkills: normalizeSpecialSkills(sysSource.specialSkills),
          standardHobbySkills: normalizeStandardHobbySkills(sysSource.standardHobbySkills)
        },
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );

      // Resolve image from multiple common keys (top-level or nested under system)
      const imgCandidates = [
        r.img, r.image, r.icon, r.imgPath, r.imagePath, r.thumbnail,
        sysSource.img, sysSource.image
      ];
      const img = (imgCandidates.find(v => typeof v === 'string' && v.length) || "icons/svg/mystery-man.svg");
      docs.push({ name, type: "race", img, system, folder: folder?.id ?? null });
    }

    if (!docs.length) return result;

    const created = await Item.createDocuments(docs);
    result.created = created;
    return result;
  } catch (err) {
    console.error("RMF | importRaces error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize race items into a compendium pack (upsert by type+name).
 * Reads races from source and creates/updates Item documents in the pack.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"] - Pack collection id
 * @param {string} [options.folderName="Races"] - Required folder name in pack
 * @param {boolean} [options.createMissing=true] - Create docs not found in pack
 * @param {boolean} [options.updateExisting=true] - Update docs found in pack
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncRacesToCompendium(source, options = {}) {
  _assertGM("syncRacesToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Races";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const racesInput = await resolveSource(source);
    const races = Array.isArray(racesInput) ? racesInput : (racesInput?.races ?? [racesInput]).filter(Boolean);
    if (!races?.length) return result;

    const template = await getRaceTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const raceFolderIds = getPackFolderIdsByName(pack, folderName);
    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < races.length; i++) {
      const race = races[i];
      const name = race.name ?? `Race ${i + 1}`;
      const key = `race::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);
      const sysSource = race.system ?? race;

      const system = foundry.utils.mergeObject(
        foundry.utils.duplicate(template),
        {
          description: sysSource.description ?? "",
          racialAbilities: sysSource.racialAbilities ?? "",
          stats: normalizeRaceStats(sysSource.stats),
          resistances: normalizeRaceResistances(sysSource.resistances),
          backgroundOptions: Number(sysSource.backgroundOptions ?? 0) || 0,
          bodyDevelopment: normalizeRaceProgressionString(sysSource.bodyDevelopment),
          ppChanneling: normalizeRaceProgressionString(sysSource.ppChanneling),
          ppEssence: normalizeRaceProgressionString(sysSource.ppEssence),
          ppMentalism: normalizeRaceProgressionString(sysSource.ppMentalism),
          hobbyRanks: normalizeRaceHobbyRanks(sysSource.hobbyRanks),
          racialRanks: normalizeRacialRanks(sysSource.racialRanks),
          specialSkills: normalizeSpecialSkills(sysSource.specialSkills),
          standardHobbySkills: normalizeStandardHobbySkills(sysSource.standardHobbySkills),
          fromBook: String(sysSource.fromBook ?? race.fromBook ?? "basic")
        },
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );

      const imgCandidates = [
        race.img, race.image, race.icon, race.imgPath, race.imagePath, race.thumbnail,
        sysSource.img, sysSource.image
      ];
      const img = (imgCandidates.find(v => typeof v === "string" && v.length) || "icons/svg/mystery-man.svg");

      const base = { name, type: "race", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = raceFolderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncRacesToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Resolve input source to a parsed JSON object/array.
 * @param {string|Array|Object} source
 * @returns {Promise<any>}
 */
async function resolveSource(source) {
  if (Array.isArray(source) || (source && typeof source === "object")) return source;
  if (typeof source !== "string") return [];

  const s = source.trim();
  // JSON string
  if (s.startsWith("[") || s.startsWith("{")) {
    try { return JSON.parse(s); } catch { /* fallthrough */ }
  }
  // Treat as URL — validate against allowlist before fetching.
  _assertSafeSourceUrl(s);
  const resp = await fetch(s);
  if (!resp.ok) throw new Error(`Failed to fetch ${s}: ${resp.status}`);
  return await resp.json();
}

/**
 * Obtain the default template for Item type "race" without using deprecated System#template.
 * Tries System#documentTypes first, then falls back to loading the system template file.
 * @returns {Promise<object>}
 */
async function getRaceTemplate() {
  // Try via documentTypes if available
  const fromDocTypes = foundry.utils.getProperty(game.system, 'documentTypes.Item.race.template');
  if (fromDocTypes && typeof fromDocTypes === 'object') return fromDocTypes;

  // Fallback: load from the system's template.json file
  try {
    const resp = await fetch('systems/rmf/template.json');
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.race) ?? {};
    }
  } catch (e) {
    console.warn('RMF | Failed to load template fallback', e);
  }
  return {};
}

/**
 * Import multiple Category items from a JSON source.
 * Mirrors the race importer but normalizes category-specific fields.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.folderName="Categories"] - Target folder name
 * @param {boolean} [options.dedupeByName=false] - Skip creation if an item with same name exists
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importCategories(source, options = {}) {
  _assertGM("importCategories");
  const folderName = options.folderName ?? "Categories";
  const dedupeByName = options.dedupeByName ?? false;

  const result = { created: [], skipped: [], errors: [] };

  try {
    const categoriesInput = await resolveSource(source);
    const categories = Array.isArray(categoriesInput)
      ? categoriesInput
      : (categoriesInput?.categories ?? [categoriesInput]).filter(Boolean);
    if (!categories?.length) return result;

    let folder = game.folders.find(f => f.type === "Item" && f.name === folderName) || null;
    if (!folder) {
      try {
        folder = await Folder.create({ name: folderName, type: "Item" });
      } catch (e) {
        console.warn("RMF | Failed creating folder for categories", e);
      }
    }

    const template = await getCategoryTemplate();
    const normalizeStatKey = (key) => canonicalizeStatKey(key);

    const normalizeNumber = (value, fallback = 0) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };

    const normalizeDPCost = (cost) => {
      const sourceCost = cost && typeof cost === "object" ? cost : {};
      return {
        price1: normalizeNumber(sourceCost.price1 ?? sourceCost[1]),
        price2: normalizeNumber(sourceCost.price2 ?? sourceCost[2]),
        price3: normalizeNumber(sourceCost.price3 ?? sourceCost[3])
      };
    };

    const normalizeBoughtByLevel = (bought) => {
      if (!bought || typeof bought !== "object") return {};
      return Object.entries(bought).reduce((acc, [lvl, amount]) => {
        const key = String(lvl).trim();
        if (!key) return acc;
        const value = normalizeNumber(amount, 0);
        if (Number.isFinite(value)) acc[key] = value;
        return acc;
      }, {});
    };

    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "category") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < categories.length; i++) {
      const entry = categories[i];
      const name = entry.name ?? `Category ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }

      const sysSource = entry.system ?? entry;
      const system = foundry.utils.mergeObject(
        foundry.utils.duplicate(template),
        {
          description: sysSource.description ?? entry.description ?? "",
          dpCost: normalizeDPCost(sysSource.dpCost ?? entry.dpCost),
          boughtByLevel: normalizeBoughtByLevel(sysSource.boughtByLevel ?? entry.boughtByLevel),
          freeRanks: normalizeNumber(sysSource.freeRanks ?? entry.freeRanks, 0),
          categoryRankBonusProgression: normalizeCategoryProgression(sysSource.categoryRankBonusProgression ?? entry.categoryRankBonusProgression),
          ranks: normalizeNumber(sysSource.ranks ?? entry.ranks, 0),
          statBonus: {
            stat1: normalizeStatKey(sysSource.statBonus?.stat1 ?? sysSource.stat1 ?? entry.stat1),
            stat2: normalizeStatKey(sysSource.statBonus?.stat2 ?? sysSource.stat2 ?? entry.stat2),
            stat3: normalizeStatKey(sysSource.statBonus?.stat3 ?? sysSource.stat3 ?? entry.stat3)
          },
          profBonus: normalizeNumber(sysSource.profBonus ?? entry.profBonus, 0),
          spec1Bonus: normalizeNumber(sysSource.spec1Bonus ?? entry.spec1Bonus, 0),
          spec2Bonus: normalizeNumber(sysSource.spec2Bonus ?? entry.spec2Bonus, 0),
          fromBook: sysSource.fromBook ?? entry.fromBook ?? "basic",
          group: sysSource.group ?? entry.group ?? "none"
        },
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );

      const imgCandidates = [
        entry.img, entry.image, entry.icon, entry.imgPath, entry.imagePath, entry.thumbnail,
        sysSource.img, sysSource.image
      ];
      const img = (imgCandidates.find(v => typeof v === "string" && v.length) || "icons/svg/book.svg");

      docs.push({ name, type: "category", img, system, folder: folder?.id ?? null });
    }

    if (!docs.length) return result;

    const created = await Item.createDocuments(docs);
    result.created = created;
    return result;
  } catch (err) {
    console.error("RMF | importCategories error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Import multiple Skill items from a JSON source into world Items.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.folderName="Skills"] - Target folder name
 * @param {boolean} [options.dedupeByName=false] - Skip creation if an item with same name exists
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importSkills(source, options = {}) {
  _assertGM("importSkills");
  const folderName = options.folderName ?? "Skills";
  const dedupeByName = options.dedupeByName ?? false;

  const result = { created: [], skipped: [], errors: [] };

  try {
    const skillsInput = await resolveSource(source);
    const skills = Array.isArray(skillsInput)
      ? skillsInput
      : (skillsInput?.skills ?? [skillsInput]).filter(Boolean);
    if (!skills?.length) return result;

    let folder = game.folders.find(f => f.type === "Item" && f.name === folderName) || null;
    if (!folder) {
      try {
        folder = await Folder.create({ name: folderName, type: "Item" });
      } catch (e) {
        console.warn("RMF | Failed creating folder for skills", e);
      }
    }

    const template = await getSkillTemplate();

    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "skill") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < skills.length; i++) {
      const entry = skills[i];
      const name = entry.name ?? `Skill ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }

      const sysSource = entry.system ?? entry;
      const system = buildSkillSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");

      docs.push({ name, type: "skill", img, system, folder: folder?.id ?? null });
    }

    if (!docs.length) return result;
    const created = await Item.createDocuments(docs);
    result.created = created;
    return result;
  } catch (err) {
    console.error("RMF | importSkills error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize category items into a compendium pack (upsert by type+name).
 * Reads categories from source and creates/updates Item documents in the pack.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"] - Pack collection id
 * @param {string} [options.folderName="Categories"] - Required folder name in pack
 * @param {boolean} [options.createMissing=true] - Create docs not found in pack
 * @param {boolean} [options.updateExisting=true] - Update docs found in pack
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncCategoriesToCompendium(source, options = {}) {
  _assertGM("syncCategoriesToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Categories";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const categoriesInput = await resolveSource(source);
    const categories = Array.isArray(categoriesInput)
      ? categoriesInput
      : (categoriesInput?.categories ?? [categoriesInput]).filter(Boolean);
    if (!categories?.length) return result;

    const template = await getCategoryTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const categoryFolderIds = getPackFolderIdsByName(pack, folderName);

    const normalizeNumber = (value, fallback = 0) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };

    const normalizeDPCost = (cost) => {
      const sourceCost = cost && typeof cost === "object" ? cost : {};
      return {
        price1: normalizeNumber(sourceCost.price1 ?? sourceCost[1]),
        price2: normalizeNumber(sourceCost.price2 ?? sourceCost[2]),
        price3: normalizeNumber(sourceCost.price3 ?? sourceCost[3])
      };
    };

    const normalizeBoughtByLevel = (bought) => {
      if (!bought || typeof bought !== "object") return {};
      return Object.entries(bought).reduce((acc, [lvl, amount]) => {
        const key = String(lvl).trim();
        if (!key) return acc;
        const value = normalizeNumber(amount, 0);
        if (Number.isFinite(value)) acc[key] = value;
        return acc;
      }, {});
    };

    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < categories.length; i++) {
      const entry = categories[i];
      const name = entry.name ?? `Category ${i + 1}`;
      const sysSource = entry.system ?? entry;
      const key = `category::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);

      const system = foundry.utils.mergeObject(
        foundry.utils.duplicate(template),
        {
          description: sysSource.description ?? entry.description ?? "",
          dpCost: normalizeDPCost(sysSource.dpCost ?? entry.dpCost),
          boughtByLevel: normalizeBoughtByLevel(sysSource.boughtByLevel ?? entry.boughtByLevel),
          freeRanks: normalizeNumber(sysSource.freeRanks ?? entry.freeRanks, 0),
          categoryRankBonusProgression: normalizeCategoryProgression(sysSource.categoryRankBonusProgression ?? entry.categoryRankBonusProgression),
          ranks: normalizeNumber(sysSource.ranks ?? entry.ranks, 0),
          statBonus: {
            stat1: canonicalizeStatKey(sysSource.statBonus?.stat1 ?? sysSource.stat1 ?? entry.stat1),
            stat2: canonicalizeStatKey(sysSource.statBonus?.stat2 ?? sysSource.stat2 ?? entry.stat2),
            stat3: canonicalizeStatKey(sysSource.statBonus?.stat3 ?? sysSource.stat3 ?? entry.stat3)
          },
          profBonus: normalizeNumber(sysSource.profBonus ?? entry.profBonus, 0),
          spec1Bonus: normalizeNumber(sysSource.spec1Bonus ?? entry.spec1Bonus, 0),
          spec2Bonus: normalizeNumber(sysSource.spec2Bonus ?? entry.spec2Bonus, 0),
          fromBook: sysSource.fromBook ?? entry.fromBook ?? "basic",
          group: sysSource.group ?? entry.group ?? "none"
        },
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );

      const imgCandidates = [
        entry.img, entry.image, entry.icon, entry.imgPath, entry.imagePath, entry.thumbnail,
        sysSource.img, sysSource.image
      ];
      const img = (imgCandidates.find(v => typeof v === "string" && v.length) || "icons/svg/book.svg");

      const base = { name, type: "category", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = categoryFolderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncCategoriesToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize skill items into a compendium pack (upsert by type+name).
 * Reads skills from source and creates/updates Item documents in the pack.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"] - Pack collection id
 * @param {string} [options.folderName="Skills"] - Required folder name in pack
 * @param {boolean} [options.createMissing=true] - Create docs not found in pack
 * @param {boolean} [options.updateExisting=true] - Update docs found in pack
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncSkillsToCompendium(source, options = {}) {
  _assertGM("syncSkillsToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Skills";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const skillsInput = await resolveSource(source);
    const skills = Array.isArray(skillsInput)
      ? skillsInput
      : (skillsInput?.skills ?? [skillsInput]).filter(Boolean);
    if (!skills?.length) return result;

    const template = await getSkillTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const folderIds = getPackFolderIdsByName(pack, folderName);
    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < skills.length; i++) {
      const entry = skills[i];
      const name = entry.name ?? `Skill ${i + 1}`;
      const key = `skill::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);
      const sysSource = entry.system ?? entry;

      const system = buildSkillSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");
      const base = { name, type: "skill", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = folderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncSkillsToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

function getPackFolderIdsByName(pack, folderName) {
  const target = String(folderName ?? "").trim().toLowerCase();
  if (!target) return [];
  const folders = pack.folders ? Array.from(pack.folders.values()) : [];
  return folders
    .filter(folder => String(folder.name ?? "").trim().toLowerCase() === target)
    .map(folder => folder.id);
}

function pickImageFromEntry(entry, sysSource, fallback) {
  const imgCandidates = [
    entry?.img, entry?.image, entry?.icon, entry?.imgPath, entry?.imagePath, entry?.thumbnail,
    sysSource?.img, sysSource?.image
  ];
  return (imgCandidates.find(v => typeof v === "string" && v.length) || fallback);
}

function buildSkillSystemData(sysSource, template) {
  const normalizeNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const normalizeBoughtByLevel = (bought) => {
    if (!bought || typeof bought !== "object") return {};
    return Object.entries(bought).reduce((acc, [lvl, amount]) => {
      const key = String(lvl).trim();
      if (!key) return acc;
      acc[key] = normalizeNumber(amount, 0);
      return acc;
    }, {});
  };

  const normalizeSkillDPCost = (value) => {
    const out = { price1: 0, price2: 0, price3: 0 };
    if (Array.isArray(value)) {
      out.price1 = normalizeNumber(value[0], 0);
      out.price2 = normalizeNumber(value[1], 0);
      out.price3 = normalizeNumber(value[2], 0);
      return out;
    }
    if (value && typeof value === "object") {
      out.price1 = normalizeNumber(value.price1 ?? value[0] ?? value[1], 0);
      out.price2 = normalizeNumber(value.price2 ?? value[1] ?? value[2], 0);
      out.price3 = normalizeNumber(value.price3 ?? value[2] ?? value[3], 0);
    }
    return out;
  };

  const normalizeProgression = (value) => normalizeSkillProgression(value);

  const normalizeBoolean = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      return ["true", "1", "yes", "on"].includes(lowered);
    }
    return Boolean(value);
  };

  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      description: String(sysSource?.description ?? ""),
      rank: normalizeNumber(sysSource?.rank ?? sysSource?.ranks, 0),
      category: String(sysSource?.category ?? ""),
      group: String(sysSource?.group ?? "none"),
      classification: normalizeSkillClassification(sysSource?.classification),
      dpCost: normalizeSkillDPCost(sysSource?.dpCost),
      boughtByLevel: normalizeBoughtByLevel(sysSource?.boughtByLevel),
      skillRankBonusProgression: normalizeProgression(sysSource?.skillRankBonusProgression),
      commonlyUsed: normalizeBoolean(sysSource?.commonlyUsed),
      profBonus: normalizeNumber(sysSource?.profBonus, 0),
      spec1Bonus: normalizeNumber(sysSource?.spec1Bonus, 0),
      spec2Bonus: normalizeNumber(sysSource?.spec2Bonus, 0),
      specialStatus: normalizeSkillSpecialStatus(sysSource?.specialStatus),
      fromBook: String(sysSource?.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Normalize a skill "specialStatus" value. Allowed: "none" | "everyman" | "restricted".
 * Anything else (or missing) collapses to "none".
 * @param {*} value
 * @returns {"none"|"everyman"|"restricted"}
 */
function normalizeSkillSpecialStatus(value) {
  const allowed = new Set(["none", "everyman", "restricted"]);
  if (typeof value !== "string") return "none";
  const lower = value.trim().toLowerCase();
  return allowed.has(lower) ? lower : "none";
}

function normalizeRaceStats(stats) {
  const source = stats && typeof stats === "object" ? stats : {};
  const out = {};

  const aliasMap = {
    ag: "ag", agility: "ag", chagility: "ag",
    co: "co", constitution: "co", chconstitution: "co",
    me: "me", memory: "me", chmemory: "me",
    re: "re", reasoning: "re", chreasoning: "re",
    sd: "sd", selfdiscipline: "sd", chselfdiscipline: "sd",
    em: "em", empathy: "em", chempathy: "em",
    in: "in", intuition: "in", chintuition: "in",
    pr: "pr", presence: "pr", chpresence: "pr",
    qu: "qu", quickness: "qu", chquickness: "qu",
    st: "st", strength: "st", chstrength: "st"
  };

  for (const [rawKey, value] of Object.entries(source)) {
    const key = String(rawKey).trim().toLowerCase();
    const short = aliasMap[key];
    if (!short) continue;
    const num = Number(value);
    out[short] = Number.isFinite(num) ? num : 0;
  }

  return out;
}

/**
 * Normalize a race progression string ("zero/tier1/tier2/tier3/tier4").
 * Strips whitespace and validates that every part is a finite number.
 * Returns "" when the input is empty/invalid so the data model treats it as absent.
 * @param {*} value
 * @returns {string}
 */
function normalizeRaceProgressionString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").map(s => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : null;
  });
  if (parts.some(p => p === null)) return "";
  return parts.join("/");
}

/**
 * Normalize the race "hobbyRanks" value into a non-negative integer.
 * Empty / non-numeric input collapses to 0.
 * @param {*} value
 * @returns {number}
 */
function normalizeRaceHobbyRanks(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.trunc(num));
}

/**
 * Normalize the race "racialRanks" structure to the canonical shape:
 *   { categories: [{name, ranks}], skills: [{name, ranks}] }
 * Drops entries without a usable name and coerces "ranks" to a finite number.
 * @param {*} value
 * @returns {{categories: Array<{name: string, ranks: number}>, skills: Array<{name: string, ranks: number}>}}
 */
function normalizeRacialRanks(value) {
  const out = { categories: [], skills: [] };
  if (!value || typeof value !== "object") return out;

  const normalizeList = (list) => {
    if (!Array.isArray(list)) return [];
    return list
      .filter(entry => entry && typeof entry === "object")
      .map(entry => {
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (!name) return null;
        const ranks = Number(entry.ranks);
        return { name, ranks: Number.isFinite(ranks) ? ranks : 0 };
      })
      .filter(Boolean);
  };

  out.categories = normalizeList(value.categories);
  out.skills = normalizeList(value.skills);
  return out;
}

/**
 * Normalize the race "specialSkills" structure to:
 *   { everyman: [{name}], restricted: [{name}] }
 * Drops blank/whitespace-only names and de-duplicates case-insensitively
 * within each list.
 * @param {*} value
 * @returns {{everyman: Array<{name: string}>, restricted: Array<{name: string}>}}
 */
function normalizeSpecialSkills(value) {
  const out = { everyman: [], restricted: [] };
  if (!value || typeof value !== "object") return out;

  const normalizeList = (list) => {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const acc = [];
    for (const entry of list) {
      const raw = entry && typeof entry === "object" ? entry.name : entry;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      acc.push({ name });
    }
    return acc;
  };

  out.everyman = normalizeList(value.everyman);
  out.restricted = normalizeList(value.restricted);
  return out;
}

/**
 * Normalize the race "standardHobbySkills" descriptive string. Coerces to a
 * trimmed string; non-strings collapse to "".
 * @param {*} value
 * @returns {string}
 */
function normalizeStandardHobbySkills(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeRaceResistances(resistances) {
  const source = resistances && typeof resistances === "object" ? resistances : {};
  const out = {};

  const aliasMap = {
    ess: "ess", essence: "ess",
    chan: "chan", channeling: "chan",
    ment: "ment", mentalism: "ment",
    pois: "pois", poison: "pois",
    dis: "dis", disease: "dis"
  };

  for (const [rawKey, value] of Object.entries(source)) {
    const key = String(rawKey).trim().toLowerCase();
    const short = aliasMap[key];
    if (!short) continue;
    const num = Number(value);
    out[short] = Number.isFinite(num) ? num : 0;
  }

  return out;
}

function canonicalizeStatKey(key) {
  if (!key || typeof key !== "string") return "";
  const trimmed = key.trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();

  for (const [shortKey, fullKey] of Object.entries(STAT_SHORT_TO_FULL)) {
    if (shortKey.toLowerCase() === lower) return fullKey;
  }

  const canonicalFull = Object.values(STAT_SHORT_TO_FULL).find(fullKey => fullKey.toLowerCase() === lower);
  if (canonicalFull) return canonicalFull;

  if (trimmed.startsWith("ch")) return trimmed;
  return trimmed;
}

/**
 * Obtain the default template for Item type "category".
 * Mirrors the race helper to avoid deprecated template access.
 * @returns {Promise<object>}
 */
async function getCategoryTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.category.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;

  try {
    const resp = await fetch("systems/rmf/template.json");
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.category) ?? {};
    }
  } catch (e) {
    console.warn("RMF | Failed to load category template fallback", e);
  }
  return {};
}

/**
 * Obtain the default template for Item type "realm".
 * @returns {Promise<object>}
 */
async function getRealmTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.realm.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;

  try {
    const resp = await fetch("systems/rmf/template.json");
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.realm) ?? {};
    }
  } catch (e) {
    console.warn("RMF | Failed to load realm template fallback", e);
  }
  return {};
}

/**
 * Synchronize realm items into a compendium pack (upsert by type+name).
 * Reads realms from source and creates/updates Item documents in the pack.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"] - Pack collection id
 * @param {string} [options.folderName="Realms"] - Required folder name in pack
 * @param {boolean} [options.createMissing=true] - Create docs not found in pack
 * @param {boolean} [options.updateExisting=true] - Update docs found in pack
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncRealmsToCompendium(source, options = {}) {
  _assertGM("syncRealmsToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Realms";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const realmsInput = await resolveSource(source);
    const realms = Array.isArray(realmsInput) ? realmsInput : (realmsInput?.realms ?? [realmsInput]).filter(Boolean);
    if (!realms?.length) return result;

    const template = await getRealmTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const folderIds = getPackFolderIdsByName(pack, folderName);
    const allowedTypes = ["Essence", "Channeling", "Mentalism"];
    const normalizePowerPointsType = (value) => {
      const raw = typeof value === "string" ? value.trim() : "";
      const match = allowedTypes.find(v => v.toLowerCase() === raw.toLowerCase());
      return match ?? "Essence";
    };
    const normalizeStatKey = (value) => {
      if (typeof value !== "string") return "";
      const trimmed = value.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("ch")) return trimmed;
      return STAT_SHORT_TO_FULL[trimmed.toLowerCase()] ?? trimmed;
    };
    const normalizeStatBonus = (raw, defaults) => {
      const src = raw && typeof raw === "object" ? raw : {};
      return {
        stat1: normalizeStatKey(src.stat1) || defaults.stat1,
        stat2: normalizeStatKey(src.stat2) || defaults.stat2,
        stat3: normalizeStatKey(src.stat3) || defaults.stat3
      };
    };

    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < realms.length; i++) {
      const realm = realms[i];
      const name = realm.name ?? `Realm ${i + 1}`;
      const key = `realm::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);
      const sysSource = realm.system ?? realm;

      const tmplStatBonus = template?.statBonus ?? { stat1: "chPresence", stat2: "chEmpathy", stat3: "chIntuition" };

      const system = foundry.utils.mergeObject(
        foundry.utils.duplicate(template),
        {
          description: String(sysSource.description ?? ""),
          powerPointsType: normalizePowerPointsType(sysSource.powerPointsType),
          statBonus: normalizeStatBonus(sysSource.statBonus, tmplStatBonus),
          fromBook: String(sysSource.fromBook ?? realm.fromBook ?? "basic")
        },
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );

      const imgCandidates = [
        realm.img, realm.image, realm.icon, realm.imgPath, realm.imagePath, realm.thumbnail,
        sysSource.img, sysSource.image
      ];
      const img = (imgCandidates.find(v => typeof v === "string" && v.length) || "icons/svg/mystery-man.svg");

      const base = { name, type: "realm", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = folderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncRealmsToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Obtain the default template for Item type "skill".
 * @returns {Promise<object>}
 */
async function getSkillTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.skill.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;

  try {
    const resp = await fetch("systems/rmf/template.json");
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.skill) ?? {};
    }
  } catch (e) {
    console.warn("RMF | Failed to load skill template fallback", e);
  }
  return {};
}

/**
 * Obtain the default template for Item type "profession".
 * @returns {Promise<object>}
 */
async function getProfessionTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.profession.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;

  try {
    const resp = await fetch("systems/rmf/template.json");
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.profession) ?? {};
    }
  } catch (e) {
    console.warn("RMF | Failed to load profession template fallback", e);
  }
  return {};
}

/**
 * Build the profession `system` payload from a raw entry, normalizing every
 * sub-structure (primeStats, professionalBonuses, skill lists, dpCost tables,
 * trainingPackages). Tolerant of legacy keys (e.g. uppercase "Bonus", typo
 * "trainningPackages").
 * @param {object} sysSource
 * @param {object} template
 * @returns {object}
 */
function buildProfessionSystemData(sysSource, template) {
  const src = sysSource && typeof sysSource === "object" ? sysSource : {};
  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      description: typeof src.description === "string" ? src.description : "",
      primeStats: normalizeProfessionPrimeStats(src.primeStats),
      professionalBonuses: normalizeProfessionalBonuses(src.professionalBonuses),
      everymanSkills: normalizeProfessionSkillList(src.everymanSkills),
      occupationalSkills: normalizeProfessionSkillList(src.occupationalSkills),
      restrictedSkills: normalizeProfessionSkillList(src.restrictedSkills),
      categoryPrice: normalizeDpCostList(src.categoryPrice),
      spellPrice: normalizeDpCostList(src.spellPrice),
      // Tolerate the historical typo "trainningPackages" as a fallback.
      trainingPackages: normalizeTrainingPackages(src.trainingPackages ?? src.trainningPackages),
      fromBook: typeof src.fromBook === "string" && src.fromBook.length ? src.fromBook : "basic"
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Normalize an array of stat names (full chXxx keys, short keys, or English
 * names like "Constitution") into canonical full keys. De-duplicates.
 * @param {*} value
 * @returns {string[]}
 */
function normalizeProfessionPrimeStats(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const canonical = canonicalizeStatKey(entry);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Normalize professional bonuses to `[{name: string, bonus: number}]`.
 * Accepts legacy uppercase "Bonus" and string values like "+10". Drops
 * entries with empty names.
 * @param {*} value
 * @returns {Array<{name: string, bonus: number}>}
 */
function normalizeProfessionalBonuses(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!rawName) continue;
    const rawBonus = entry.bonus ?? entry.Bonus;
    let bonus = 0;
    if (typeof rawBonus === "number") {
      bonus = Number.isFinite(rawBonus) ? rawBonus : 0;
    } else if (typeof rawBonus === "string") {
      const parsed = parseInt(rawBonus.trim(), 10);
      bonus = Number.isFinite(parsed) ? parsed : 0;
    }
    out.push({ name: rawName, bonus });
  }
  return out;
}

/**
 * Normalize a profession skill list to `[{name: string}]`. Accepts plain
 * strings or `{name}` objects. Trims, drops empty, de-duplicates case-insensitively.
 * @param {*} value
 * @returns {Array<{name: string}>}
 */
function normalizeProfessionSkillList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const raw = entry && typeof entry === "object" ? entry.name : entry;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name });
  }
  return out;
}

/**
 * Normalize a list of `{name, dpCost: {price1, price2, price3}}` entries
 * (used for both categoryPrice and spellPrice).
 * @param {*} value
 * @returns {Array<{name: string, dpCost: {price1: number, price2: number, price3: number}}>}
 */
function normalizeDpCostList(value) {
  if (!Array.isArray(value)) return [];
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const dpRaw = entry.dpCost && typeof entry.dpCost === "object" ? entry.dpCost : {};
    out.push({
      name,
      dpCost: {
        price1: num(dpRaw.price1 ?? dpRaw[0] ?? dpRaw[1]),
        price2: num(dpRaw.price2 ?? dpRaw[1] ?? dpRaw[2]),
        price3: num(dpRaw.price3 ?? dpRaw[2] ?? dpRaw[3])
      }
    });
  }
  return out;
}

/**
 * Normalize training packages to `[{name: string, dpCost: number}]`.
 * @param {*} value
 * @returns {Array<{name: string, dpCost: number}>}
 */
function normalizeTrainingPackages(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const cost = Number(entry.dpCost);
    out.push({ name, dpCost: Number.isFinite(cost) ? cost : 0 });
  }
  return out;
}

/**
 * Import multiple Profession items from a JSON source.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.folderName="Professions"] - Target folder name
 * @param {boolean} [options.dedupeByName=false] - Skip creation if an item with same name exists
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importProfessions(source, options = {}) {
  _assertGM("importProfessions");
  const folderName = options.folderName ?? "Professions";
  const dedupeByName = options.dedupeByName ?? false;

  const result = { created: [], skipped: [], errors: [] };

  try {
    const input = await resolveSource(source);
    const professions = Array.isArray(input)
      ? input
      : (input?.professions ?? [input]).filter(Boolean);
    if (!professions?.length) return result;

    let folder = game.folders.find(f => f.type === "Item" && f.name === folderName) || null;
    if (!folder) {
      try {
        folder = await Folder.create({ name: folderName, type: "Item" });
      } catch (e) {
        console.warn("RMF | Failed creating folder for professions", e);
      }
    }

    const template = await getProfessionTemplate();

    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "profession") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < professions.length; i++) {
      const entry = professions[i];
      const name = entry.name ?? `Profession ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }

      const sysSource = entry.system ?? entry;
      const system = buildProfessionSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/mystery-man.svg");

      docs.push({ name, type: "profession", img, system, folder: folder?.id ?? null });
    }

    if (!docs.length) return result;
    const created = await Item.createDocuments(docs);
    result.created = created;
    return result;
  } catch (err) {
    console.error("RMF | importProfessions error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize profession items into a compendium pack (upsert by type+name).
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"] - Pack collection id
 * @param {string} [options.folderName="Professions"] - Required folder name in pack
 * @param {boolean} [options.createMissing=true]
 * @param {boolean} [options.updateExisting=true]
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncProfessionsToCompendium(source, options = {}) {
  _assertGM("syncProfessionsToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Professions";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const input = await resolveSource(source);
    const professions = Array.isArray(input)
      ? input
      : (input?.professions ?? [input]).filter(Boolean);
    if (!professions?.length) return result;

    const template = await getProfessionTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const folderIds = getPackFolderIdsByName(pack, folderName);
    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < professions.length; i++) {
      const entry = professions[i];
      const name = entry.name ?? `Profession ${i + 1}`;
      const key = `profession::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);
      const sysSource = entry.system ?? entry;

      const system = buildProfessionSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/mystery-man.svg");
      const base = { name, type: "profession", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = folderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncProfessionsToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/* ──────────────────────────── Training Packages ─────────────────────────── */

async function getTrainingPackageTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, 'documentTypes.Item.trainingPackage.template');
  if (fromDocTypes && typeof fromDocTypes === 'object') return fromDocTypes;
  try {
    const resp = await fetch('systems/rmf/template.json');
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.trainingPackage) ?? {};
    }
  } catch (e) {
    console.warn('RMF | Failed to load training package template fallback', e);
  }
  return {};
}

/**
 * Coerce a single `categoryRanks` entry to the canonical shape:
 *   { category, ranks, isChoice, skills: [{name, ranks, isChoice}] }
 *
 * @private
 */
function normalizeTrainingPackageCategoryRanks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => ({
    category: typeof c?.category === "string" ? c.category : "",
    ranks:    Number(c?.ranks) || 0,
    isChoice: !!c?.isChoice,
    skills:   Array.isArray(c?.skills)
      ? c.skills.map(s => ({
          name:     typeof s?.name === "string" ? s.name : "",
          ranks:    Number(s?.ranks) || 0,
          isChoice: !!s?.isChoice
        }))
      : []
  }));
}

function buildTrainingPackageSystemData(sysSource, template) {
  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      type:           String(sysSource?.type ?? ""),
      description:    String(sysSource?.description ?? ""),
      timeToAcquire:  String(sysSource?.timeToAcquire ?? ""),
      startingMoney:  String(sysSource?.startingMoney ?? ""),
      statGains:      String(sysSource?.statGains ?? ""),
      special:        Array.isArray(sysSource?.special)
        ? sysSource.special.map(e => ({
            name:   typeof e?.name === "string" ? e.name : "",
            dpCost: Number(e?.dpCost) || 0
          }))
        : [],
      categoryRanks:  normalizeTrainingPackageCategoryRanks(sysSource?.categoryRanks),
      fromBook:       String(sysSource?.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Import multiple Training Package items from a JSON source.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed array/object
 * @param {Object} [options]
 * @param {string} [options.folderName="Training Packages"] - Target folder name
 * @param {boolean} [options.dedupeByName=false]
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importTrainingPackages(source, options = {}) {
  _assertGM("importTrainingPackages");
  const folderName = options.folderName ?? "Training Packages";
  const dedupeByName = options.dedupeByName ?? false;

  const result = { created: [], skipped: [], errors: [] };

  try {
    const input = await resolveSource(source);
    const packages = Array.isArray(input)
      ? input
      : (input?.trainingPackages ?? [input]).filter(Boolean);
    if (!packages?.length) return result;

    let folder = game.folders.find(f => f.type === "Item" && f.name === folderName) || null;
    if (!folder) {
      try {
        folder = await Folder.create({ name: folderName, type: "Item" });
      } catch (e) {
        console.warn("RMF | Failed creating folder for training packages", e);
      }
    }

    const template = await getTrainingPackageTemplate();
    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "trainingPackage") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < packages.length; i++) {
      const entry = packages[i];
      const name = entry.name ?? `Training Package ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }
      const sysSource = entry.system ?? entry;
      const system = buildTrainingPackageSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");
      docs.push({ name, type: "trainingPackage", img, system, folder: folder?.id ?? null });
    }

    if (!docs.length) return result;
    const created = await Item.createDocuments(docs);
    result.created = created;
    return result;
  } catch (err) {
    console.error("RMF | importTrainingPackages error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize training-package items into a compendium pack
 * (upsert by type+name).
 *
 * @param {string|Array|Object} source
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"]
 * @param {string} [options.folderName="Training Packages"]
 * @param {boolean} [options.createMissing=true]
 * @param {boolean} [options.updateExisting=true]
 * @returns {Promise<{created: number, updated: number, skipped: number, errors: any[]}>}
 */
export async function syncTrainingPackagesToCompendium(source, options = {}) {
  _assertGM("syncTrainingPackagesToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Training Packages";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const input = await resolveSource(source);
    const packages = Array.isArray(input)
      ? input
      : (input?.trainingPackages ?? [input]).filter(Boolean);
    if (!packages?.length) return result;

    const template = await getTrainingPackageTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder"] });
    const existingByKey = new Map(
      pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
    );

    const folderIds = getPackFolderIdsByName(pack, folderName);
    const createPayload = [];
    const updatePayload = [];

    for (let i = 0; i < packages.length; i++) {
      const entry = packages[i];
      const name = entry.name ?? `Training Package ${i + 1}`;
      const key = `trainingPackage::${String(name).toLowerCase()}`;
      const existing = existingByKey.get(key);
      const sysSource = entry.system ?? entry;

      const system = buildTrainingPackageSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");
      const base = { name, type: "trainingPackage", img, system };

      if (existing) {
        if (!updateExisting) {
          result.skipped += 1;
          continue;
        }
        updatePayload.push({ _id: existing._id, ...base });
      } else {
        if (!createMissing) {
          result.skipped += 1;
          continue;
        }
        const folderId = folderIds[0] ?? null;
        createPayload.push({ ...base, folder: folderId });
      }
    }

    if (createPayload.length) {
      const created = await Item.createDocuments(createPayload, { pack: packCollection });
      result.created = created.length;
    }
    if (updatePayload.length) {
      const updated = await Item.updateDocuments(updatePayload, { pack: packCollection, diff: false });
      result.updated = updated.length;
    }

    return result;
  } catch (err) {
    console.error("RMF | syncTrainingPackagesToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}
