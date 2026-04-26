/**
 * RMF Importers - Utilities to import data into the RMF system
 * FoundryVTT v13.341 compatible (no deprecated V1 APIs)
 */

import { normalizeCategoryProgression, normalizeSkillProgression } from "./utils/rank-bonus.mjs";

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
          ppMentalism: normalizeRaceProgressionString(sysSource.ppMentalism)
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
  // Treat as URL
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
      classification: String(sysSource?.classification ?? "movingManeuver"),
      dpCost: normalizeSkillDPCost(sysSource?.dpCost),
      boughtByLevel: normalizeBoughtByLevel(sysSource?.boughtByLevel),
      skillRankBonusProgression: normalizeProgression(sysSource?.skillRankBonusProgression),
      commonlyUsed: normalizeBoolean(sysSource?.commonlyUsed),
      profBonus: normalizeNumber(sysSource?.profBonus, 0),
      spec1Bonus: normalizeNumber(sysSource?.spec1Bonus, 0),
      spec2Bonus: normalizeNumber(sysSource?.spec2Bonus, 0),
      fromBook: String(sysSource?.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
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

  const shortToFull = CONFIG?.RMF?.statShortToFull ?? {};
  const lower = trimmed.toLowerCase();

  for (const [shortKey, fullKey] of Object.entries(shortToFull)) {
    if (shortKey.toLowerCase() === lower) return fullKey;
  }

  const canonicalFull = Object.values(shortToFull).find(fullKey => fullKey.toLowerCase() === lower);
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
    const statShortToFull = {
      ag: "chAgility", co: "chConstitution", me: "chMemory", re: "chReasoning",
      sd: "chSelfDiscipline", em: "chEmpathy", in: "chIntuition", pr: "chPresence",
      qu: "chQuickness", st: "chStrength"
    };
    const normalizeStatKey = (value) => {
      if (typeof value !== "string") return "";
      const trimmed = value.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("ch")) return trimmed;
      return statShortToFull[trimmed.toLowerCase()] ?? trimmed;
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
