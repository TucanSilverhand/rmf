/**
 * RMF Importers - Utilities to import data into the RMF system
 * FoundryVTT v13.341 compatible (no deprecated V1 APIs)
 */

import {
  normalizeCategoryProgression,
  normalizeSkillProgression,
  normalizeSkillClassification
} from "./utils/rank-bonus.mjs";
import { STAT_SHORT_TO_FULL, SPELL_SPECIAL_CODES } from "./utils/constants.mjs";
import { normalizeCategoryGroup } from "./data-models/category.mjs";
import { SPECIAL_ROLES } from "./data-models/_identity.mjs";
import { formatDPCost } from "./utils/dp-cost.mjs";
import { slugify } from "./utils/slug.mjs";

/**
 * Pass an authored `slug` straight through from the JSON source (the
 * canonical data files carry it). Empty when absent — the `preCreateItem`
 * hook then derives one from the name on create, and the world migration
 * backfills existing docs. Carrying it here keeps an authored/errata slug
 * authoritative and stable across re-syncs (which take the UPDATE path and
 * do NOT fire preCreateItem).
 *
 * @param {*} src - the system source object (and/or raw entry)
 * @returns {string}
 */
function authoredSlug(src) {
  return typeof src?.slug === "string" ? src.slug : "";
}

/**
 * Build a slug-first upsert resolver over a compendium pack index.
 *
 * Identity rule (refactor Fase 0): the slug is authoritative, the name is
 * display-only. Re-syncs must therefore match existing docs by slug — a
 * renamed item would otherwise duplicate under a name key. Legacy docs whose
 * stored slug predates an authored one (hook-stamped `slugify(name)`) still
 * match through the name fallback, and the update then heals their slug.
 *
 * Call AFTER `pack.getIndex({fields: [..., "system.slug"]})`.
 *
 * @param {CompendiumCollection} pack
 * @returns {(type: string, slug: string, name: string) => object|undefined}
 */
function packUpsertResolver(pack) {
  const bySlug = new Map();
  const byName = new Map();
  for (const e of pack.index) {
    const slug = String(e.system?.slug ?? "");
    if (slug) bySlug.set(`${e.type}::${slug}`, e);
    byName.set(`${e.type}::${String(e.name).toLowerCase()}`, e);
  }
  return (type, slug, name) =>
    (slug ? bySlug.get(`${type}::${slug}`) : undefined)
      ?? byName.get(`${type}::${String(name).toLowerCase()}`);
}

/**
 * Pass an authored `specialRole` through when it is one of the canonical
 * values, else "none". Same rationale as {@link authoredSlug}.
 *
 * @param {*} src
 * @returns {"none"|"bodyDevelopment"|"powerPointDevelopment"}
 */
function authoredSpecialRole(src) {
  return SPECIAL_ROLES.includes(src?.specialRole) ? src.specialRole : "none";
}

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
          slug: authoredSlug(sysSource) || authoredSlug(race),
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

    // dpCost is now the RMF slash-notation string. formatDPCost accepts the
    // legacy { price1, price2, price3 } triple, an array, or a string and
    // always returns the canonical string. See module/utils/dp-cost.mjs.
    const normalizeDPCost = (cost) => formatDPCost(cost);

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
          statBonus: {
            stat1: normalizeStatKey(sysSource.statBonus?.stat1 ?? sysSource.stat1 ?? entry.stat1),
            stat2: normalizeStatKey(sysSource.statBonus?.stat2 ?? sysSource.stat2 ?? entry.stat2),
            stat3: normalizeStatKey(sysSource.statBonus?.stat3 ?? sysSource.stat3 ?? entry.stat3)
          },
          profBonus: normalizeNumber(sysSource.profBonus ?? entry.profBonus, 0),
          spec1Bonus: normalizeNumber(sysSource.spec1Bonus ?? entry.spec1Bonus, 0),
          spec2Bonus: normalizeNumber(sysSource.spec2Bonus ?? entry.spec2Bonus, 0),
          fromBook: sysSource.fromBook ?? entry.fromBook ?? "basic",
          slug: authoredSlug(sysSource) || authoredSlug(entry),
          specialRole: SPECIAL_ROLES.includes(sysSource.specialRole ?? entry.specialRole)
            ? (sysSource.specialRole ?? entry.specialRole)
            : "none",
          group: normalizeCategoryGroup(sysSource.group ?? entry.group)
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

    // dpCost is now the RMF slash-notation string. formatDPCost accepts the
    // legacy { price1, price2, price3 } triple, an array, or a string and
    // always returns the canonical string. See module/utils/dp-cost.mjs.
    const normalizeDPCost = (cost) => formatDPCost(cost);

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
          statBonus: {
            stat1: canonicalizeStatKey(sysSource.statBonus?.stat1 ?? sysSource.stat1 ?? entry.stat1),
            stat2: canonicalizeStatKey(sysSource.statBonus?.stat2 ?? sysSource.stat2 ?? entry.stat2),
            stat3: canonicalizeStatKey(sysSource.statBonus?.stat3 ?? sysSource.stat3 ?? entry.stat3)
          },
          profBonus: normalizeNumber(sysSource.profBonus ?? entry.profBonus, 0),
          spec1Bonus: normalizeNumber(sysSource.spec1Bonus ?? entry.spec1Bonus, 0),
          spec2Bonus: normalizeNumber(sysSource.spec2Bonus ?? entry.spec2Bonus, 0),
          fromBook: sysSource.fromBook ?? entry.fromBook ?? "basic",
          slug: authoredSlug(sysSource) || authoredSlug(entry),
          specialRole: SPECIAL_ROLES.includes(sysSource.specialRole ?? entry.specialRole)
            ? (sysSource.specialRole ?? entry.specialRole)
            : "none",
          group: normalizeCategoryGroup(sysSource.group ?? entry.group)
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

  // dpCost is now the RMF slash-notation string. formatDPCost accepts a
  // string, the legacy triple, or an array and returns the canonical form.
  const normalizeSkillDPCost = (value) => formatDPCost(value);

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
      category: String(sysSource?.category ?? ""),
      group: normalizeCategoryGroup(sysSource?.group),
      classification: normalizeSkillClassification(sysSource?.classification),
      dpCost: normalizeSkillDPCost(sysSource?.dpCost),
      boughtByLevel: normalizeBoughtByLevel(sysSource?.boughtByLevel),
      skillRankBonusProgression: normalizeProgression(sysSource?.skillRankBonusProgression),
      commonlyUsed: normalizeBoolean(sysSource?.commonlyUsed),
      profBonus: normalizeNumber(sysSource?.profBonus, 0),
      spec1Bonus: normalizeNumber(sysSource?.spec1Bonus, 0),
      spec2Bonus: normalizeNumber(sysSource?.spec2Bonus, 0),
      specialStatus: normalizeSkillSpecialStatus(sysSource?.specialStatus),
      slug: authoredSlug(sysSource),
      specialRole: authoredSpecialRole(sysSource),
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
          slug: authoredSlug(sysSource) || authoredSlug(realm),
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
      slug: authoredSlug(src),
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
    out.push({ name: rawName, bonus, isChoice: !!entry.isChoice });
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
    const isObj = entry && typeof entry === "object";
    const raw = isObj ? entry.name : entry;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, isChoice: isObj ? !!entry.isChoice : false });
  }
  return out;
}

/**
 * Normalize a list of `{name, dpCost}` entries (categoryPrice / spellPrice).
 * `dpCost` is emitted as the RMF slash-notation string; formatDPCost accepts
 * the legacy triple, an array, or a string. See module/utils/dp-cost.mjs.
 * @param {*} value
 * @returns {Array<{name: string, dpCost: string}>}
 */
function normalizeDpCostList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    out.push({ name, dpCost: formatDPCost(entry.dpCost) });
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
  return raw.map(c => {
    const catName = typeof c?.category === "string" ? c.category : "";
    const catIsChoice = !!c?.isChoice;
    // Preserve any explicit `placeholderName` in the source; otherwise
    // seed it from `name` for choice entries so the sheet's choice
    // dropdown can offer the original placeholder as a revert option.
    const catPlaceholder = typeof c?.placeholderName === "string" && c.placeholderName.length
      ? c.placeholderName
      : (catIsChoice ? catName : "");
    return {
      category:        catName,
      ranks:           Number(c?.ranks) || 0,
      isChoice:        catIsChoice,
      placeholderName: catPlaceholder,
      skills:   Array.isArray(c?.skills)
        ? c.skills.map(s => {
            const skName = typeof s?.name === "string" ? s.name : "";
            const skIsChoice = !!s?.isChoice;
            const skPlaceholder = typeof s?.placeholderName === "string" && s.placeholderName.length
              ? s.placeholderName
              : (skIsChoice ? skName : "");
            return {
              name:            skName,
              ranks:           Number(s?.ranks) || 0,
              isChoice:        skIsChoice,
              placeholderName: skPlaceholder
            };
          })
        : []
    };
  });
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
      slug:           authoredSlug(sysSource),
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

/* ════════════════════════════════════════════════════════════════════
 * Spell Lists
 *
 * One Item (type "spellList") per spell list. Sources are the
 * `data/spell_lists/*-lists.json` files, each shaped `{ "lists": [ ... ] }` (the
 * old top-level `spellDescriptionKey` was moved to constants.mjs /
 * CONFIG.RMF and is intentionally NOT imported).
 *
 * Field-name note: the JSON calls the Open/Closed/Base axis `type`,
 * which collides with the Foundry document `type`; it is mapped to
 * `listType` here (matches SpellListData).
 * ════════════════════════════════════════════════════════════════════ */

async function getSpellListTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.spellList.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;
  try {
    const resp = await fetch("systems/rmf/template.json");
    if (resp.ok) {
      const data = await resp.json();
      return (data?.Item?.spellList) ?? {};
    }
  } catch (e) {
    console.warn("RMF | Failed to load spell list template fallback", e);
  }
  return {};
}

/**
 * Organizational folder name for a list: always "<Realm> <ListType>"
 * (e.g. "Channeling Open", "Essence Base"). Base lists group by realm,
 * NOT by profession, so the whole set lands in exactly 9 folders
 * (3 realms × Open/Closed/Base).
 *
 * @private
 */
function _spellListFolderName(realm, listType) {
  const r = String(realm ?? "").trim();
  const lt = String(listType ?? "").trim();
  return `${r} ${lt}`.trim();
}

/**
 * Find-or-create an Item folder INSIDE a compendium pack and return its
 * id. Unlike `getPackFolderIdsByName` (find-only), this creates the
 * folder if missing so the spell-list sync produces its 9 folders
 * without the user pre-creating them. Cached per run.
 *
 * @private
 */
async function _ensurePackFolder(pack, name, cache) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  const target = String(name).trim().toLowerCase();
  let folder = (pack.folders ? Array.from(pack.folders.values()) : [])
    .find(f => String(f.name ?? "").trim().toLowerCase() === target) || null;
  if (!folder) {
    try {
      folder = await Folder.create(
        { name, type: pack.documentName },
        { pack: pack.collection }
      );
    } catch (e) {
      console.warn(`RMF | Failed creating pack folder "${name}" in ${pack.collection}`, e);
    }
  }
  const id = folder?.id ?? null;
  cache.set(name, id);
  return id;
}

/**
 * Find-or-create a NESTED chain of Item folders inside a compendium pack and
 * return the LEAF folder id. Each level is matched by name AND parent, so two
 * folders with the same name under different parents never collide. Caches by
 * full lowercased path within a run. Pass a single-element array for a plain
 * root folder (equivalent to the old _ensurePackFolder behaviour).
 *
 * @param {CompendiumCollection} pack
 * @param {string[]} names - folder names root→leaf, e.g. ["Build Character", "Categories"]
 * @param {Map<string,string|null>} [cache]
 * @returns {Promise<string|null>} leaf folder id (null if names empty / creation failed)
 */
export async function ensurePackFolderPath(pack, names, cache = new Map()) {
  let parentId = null;
  let key = "";
  for (const raw of (names ?? [])) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    key += `/${name.toLowerCase()}`;
    if (cache.has(key)) { parentId = cache.get(key); continue; }
    const here = parentId;
    let folder = (pack.folders ? Array.from(pack.folders.values()) : [])
      .find(f => String(f.name ?? "").trim().toLowerCase() === name.toLowerCase()
              && (f.folder?.id ?? null) === here) || null;
    if (!folder) {
      try {
        folder = await Folder.create(
          { name, type: pack.documentName, folder: here },
          { pack: pack.collection }
        );
      } catch (e) {
        console.warn(`RMF | Failed creating pack folder path "${(names ?? []).join("/")}" in ${pack.collection}`, e);
      }
    }
    parentId = folder?.id ?? null;
    cache.set(key, parentId);
  }
  return parentId;
}

/**
 * Coerce the raw `spells` array to the canonical shape. Always returns
 * the entries in level order; codes are filtered to the canonical set
 * and ordered (instantaneous, noPowerPoints, spellSet).
 *
 * @private
 */
function normalizeSpellEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const codeOrder = SPELL_SPECIAL_CODES;
  return raw.map((s, i) => {
    const codesIn = Array.isArray(s?.codes) ? s.codes : [];
    const codeSet = new Set(codesIn.filter(c => codeOrder.includes(c)));
    let rrMod = null;
    if (s?.rrMod !== null && s?.rrMod !== undefined && s?.rrMod !== "") {
      const n = Number.parseInt(s.rrMod, 10);
      rrMod = Number.isFinite(n) ? n : null;
    }
    let level = Number.parseInt(s?.level, 10);
    if (!Number.isFinite(level) || level < 1 || level > 10) level = i + 1;
    return {
      level,
      name:         typeof s?.name === "string" ? s.name : "",
      codes:        codeOrder.filter(c => codeSet.has(c)),
      rrMod,
      areaOfEffect: typeof s?.areaOfEffect === "string" ? s.areaOfEffect : "",
      duration:     typeof s?.duration === "string" ? s.duration : "",
      range:        typeof s?.range === "string" ? s.range : "",
      type:         typeof s?.type === "string" ? s.type : "",
      description:  typeof s?.description === "string" ? s.description : ""
    };
  });
}

function buildSpellListSystemData(sysSource, template) {
  const realm    = String(sysSource?.realm ?? "Channeling");
  // Accept either `listType` (canonical) or the source's `type`.
  const listType = String(sysSource?.listType ?? sysSource?.type ?? "Open");
  const profession = String(sysSource?.profession ?? "");
  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      realm,
      listType,
      profession,
      reference:    String(sysSource?.reference ?? ""),
      specialNotes: Array.isArray(sysSource?.specialNotes)
        ? sysSource.specialNotes.map(n => (typeof n === "string" ? n : String(n ?? "")))
        : [],
      spells:       normalizeSpellEntries(sysSource?.spells),
      slug:         authoredSlug(sysSource),
      fromBook:     String(sysSource?.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Find-or-create an Item Folder by name, caching within a run so the
 * same group folder is only resolved once per import.
 *
 * @private
 */
async function _ensureItemFolder(name, cache) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  let folder = game.folders.find(f => f.type === "Item" && f.name === name) || null;
  if (!folder) {
    try {
      folder = await Folder.create({ name, type: "Item" });
    } catch (e) {
      console.warn(`RMF | Failed creating folder "${name}" for spell lists`, e);
    }
  }
  const id = folder?.id ?? null;
  cache.set(name, id);
  return id;
}

/**
 * Import spell-list items from a JSON source (`{ lists: [...] }`, a
 * bare array, or a single list object).
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed data
 * @param {Object} [options]
 * @param {boolean} [options.dedupeByName=false]
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importSpellLists(source, options = {}) {
  _assertGM("importSpellLists");
  const dedupeByName = options.dedupeByName ?? false;
  const result = { created: [], skipped: [], errors: [] };

  try {
    const input = await resolveSource(source);
    const lists = Array.isArray(input)
      ? input
      : (input?.lists ?? [input]).filter(Boolean);
    if (!lists?.length) return result;

    const template = await getSpellListTemplate();
    const folderCache = new Map();
    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "spellList") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < lists.length; i++) {
      const entry = lists[i];
      const name = entry.name ?? `Spell List ${i + 1}`;
      if (dedupeByName && existingByName[name]) {
        result.skipped.push(name);
        continue;
      }
      const sysSource = entry.system ?? entry;
      const system = buildSpellListSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");
      const folderId = await _ensureItemFolder(
        _spellListFolderName(system.realm, system.listType),
        folderCache
      );
      docs.push({ name, type: "spellList", img, system, folder: folderId });
    }

    if (!docs.length) return result;
    result.created = await Item.createDocuments(docs);
    return result;
  } catch (err) {
    console.error("RMF | importSpellLists error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize spell-list items into a compendium pack (upsert by
 * type+name). Folders are resolved by group name within the pack;
 * lists land at the pack root when the matching folder is absent.
 *
 * @param {string|Array|Object} source
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"]
 * @param {boolean} [options.createMissing=true]
 * @param {boolean} [options.updateExisting=true]
 * @returns {Promise<{created:number, updated:number, skipped:number, errors:any[]}>}
 */
export async function syncSpellListsToCompendium(source, options = {}) {
  _assertGM("syncSpellListsToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const input = await resolveSource(source);
    const lists = Array.isArray(input)
      ? input
      : (input?.lists ?? [input]).filter(Boolean);
    if (!lists?.length) return result;

    const template = await getSpellListTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder", "system.slug"] });
    const resolveExisting = packUpsertResolver(pack);

    const folderCache = new Map();
    const createPayload = [];
    const updatePayload = [];
    for (let i = 0; i < lists.length; i++) {
      const entry = lists[i];
      const name = entry.name ?? `Spell List ${i + 1}`;
      const sysSource = entry.system ?? entry;
      const system = buildSpellListSystemData(sysSource, template);
      const existing = resolveExisting("spellList", system.slug || slugify(name), name);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/book.svg");
      const base = { name, type: "spellList", img, system };

      // Resolve (creating if needed) the "<Realm> <ListType>" folder so the
      // 9 folders appear automatically — nested under options.parentFolderName
      // (e.g. "Spell Lists") when given. Folder is set on BOTH create and
      // update so a re-run relocates lists already imported elsewhere.
      const folderId = await ensurePackFolderPath(
        pack,
        [options.parentFolderName, _spellListFolderName(system.realm, system.listType)].filter(Boolean),
        folderCache
      );

      if (existing) {
        if (!updateExisting) { result.skipped += 1; continue; }
        updatePayload.push({ _id: existing._id, folder: folderId, ...base });
      } else {
        if (!createMissing) { result.skipped += 1; continue; }
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
    console.error("RMF | syncSpellListsToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/* ════════════════════════════════════════════════════════════════════
 * Attack Tables
 *
 * One Item (type "attackTable") per weapon attack table. Sources are the
 * `data/system_tables/attack_tables/*.json` files, each a single table object shaped
 * { name, tableId, critType, fumbleRange, armorTypes, legend, rows, fumble }.
 * The matrix looks two-dimensional on paper but resolves to a 1-D lookup
 * at query time (see module/tables/). Stored as Item system data because
 * FoundryVTT has no native 2-D table document.
 * ════════════════════════════════════════════════════════════════════ */

async function getAttackTableTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.attackTable.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;
  return {};
}

/** Coerce to a finite number, else fallback. */
function _atNum(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/** Normalize the roll-band rows; keeps `rollMin: null` as the low catch-all. */
function normalizeAttackRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => {
    const src = (r?.results && typeof r.results === "object") ? r.results : {};
    const results = {};
    for (const [k, v] of Object.entries(src)) {
      results[String(k)] = (v === null || v === undefined) ? "" : String(v);
    }
    const hasMin = !(r?.rollMin === null || r?.rollMin === undefined);
    return {
      label:   typeof r?.label === "string" ? r.label : "",
      rollMin: hasMin ? _atNum(r.rollMin, 0) : null,
      rollMax: _atNum(r?.rollMax, 0),
      results
    };
  });
}

/** Normalize the armor-type groups (presentation only). */
function normalizeAttackArmorTypes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(g => ({
    name: typeof g?.name === "string" ? g.name : "",
    ats:  Array.isArray(g?.ats) ? g.ats.map(a => _atNum(a, 0)) : []
  }));
}

/** Normalize a column→cell results object (string keys, string cells). */
function normalizeAttackResults(raw) {
  const results = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      results[String(k)] = (v === null || v === undefined) ? "" : String(v);
    }
  }
  return results;
}

/** Normalize the per-attack-type critical map (ATTACK TYPE DATA / SPELL DATA box). */
function normalizeAttackTypes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(a => ({
    attackType:   String(a?.attackType ?? ""),
    abbreviation: String(a?.abbreviation ?? ""),
    criticalType: String(a?.criticalType ?? ""),
    ref:          String(a?.ref ?? ""),
    note:         String(a?.note ?? ""),
    obMod:        String(a?.obMod ?? ""),
    maxResult:    (a?.maxResult === null || a?.maxResult === undefined) ? null : _atNum(a.maxResult, 0),
    maxCritical:  String(a?.maxCritical ?? "")
  }));
}

/** Normalize the high unmodified-die rows (UM 96-100). */
function normalizeUmHigh(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(u => ({
    label:       String(u?.label ?? ""),
    naturalMin:  _atNum(u?.naturalMin, 100),
    naturalMax:  _atNum(u?.naturalMax, 100),
    description: String(u?.description ?? ""),
    results:     normalizeAttackResults(u?.results)
  }));
}

/** Build the attackTable `system` payload from a raw source entry. */
function buildAttackTableSystemData(sysSource, template) {
  const src = sysSource && typeof sysSource === "object" ? sysSource : {};
  const fr = src.fumbleRange && typeof src.fumbleRange === "object" ? src.fumbleRange : {};
  const fumbleSrc = src.fumble && typeof src.fumble === "object" ? src.fumble : {};
  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      tableId:    String(src.tableId ?? ""),
      tableKind:  src.tableKind === "resistanceMod" ? "resistanceMod" : "attack",
      critType:   String(src.critType ?? ""),
      attackTypes:     normalizeAttackTypes(src.attackTypes),
      attackTypeNotes: Array.isArray(src.attackTypeNotes)
        ? src.attackTypeNotes.map(n => String(n ?? ""))
        : [],
      columnDefs: Array.isArray(src.columnDefs)
        ? src.columnDefs.map(c => ({ key: String(c?.key ?? ""), label: String(c?.label ?? "") }))
        : [],
      fumbleRange: { min: _atNum(fr.min, 1), max: _atNum(fr.max, 2) },
      armorTypes: normalizeAttackArmorTypes(src.armorTypes),
      legend:     (src.legend && typeof src.legend === "object") ? src.legend : null,
      rollMatchPolicy: String(src.rollMatchPolicy ?? ""),
      rows:       normalizeAttackRows(src.rows),
      fumble: {
        label:       String(fumbleSrc.label ?? ""),
        description: String(fumbleSrc.description ?? ""),
        results:     normalizeAttackResults(fumbleSrc.results)
      },
      umHigh:     normalizeUmHigh(src.umHigh),
      slug:       authoredSlug(src),
      fromBook:   String(src.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Import attack-table items from a JSON source. Accepts a single table
 * object, an array of tables, or `{ tables: [...] }`.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed data
 * @param {Object} [options]
 * @param {string} [options.folderName="Attack Tables"]
 * @param {boolean} [options.dedupeByName=false]
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importAttackTables(source, options = {}) {
  _assertGM("importAttackTables");
  const folderName = options.folderName ?? "Attack Tables";
  const dedupeByName = options.dedupeByName ?? false;
  const result = { created: [], skipped: [], errors: [] };

  try {
    const input = await resolveSource(source);
    const tables = Array.isArray(input) ? input : (input?.tables ?? [input]).filter(Boolean);
    if (!tables?.length) return result;

    const template = await getAttackTableTemplate();
    const folderCache = new Map();
    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "attackTable") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < tables.length; i++) {
      const entry = tables[i];
      const name = entry.name ?? `Attack Table ${i + 1}`;
      if (dedupeByName && existingByName[name]) { result.skipped.push(name); continue; }
      const sysSource = entry.system ?? entry;
      const system = buildAttackTableSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/sword.svg");
      const folderId = await _ensureItemFolder(folderName, folderCache);
      docs.push({ name, type: "attackTable", img, system, folder: folderId });
    }

    if (!docs.length) return result;
    result.created = await Item.createDocuments(docs);
    return result;
  } catch (err) {
    console.error("RMF | importAttackTables error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize attack-table items into a compendium pack (upsert by
 * type+name). Lands them in an "Attack Tables" folder, created if absent.
 *
 * @param {string|Array|Object} source
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"]
 * @param {string} [options.folderName="Attack Tables"]
 * @param {boolean} [options.createMissing=true]
 * @param {boolean} [options.updateExisting=true]
 * @returns {Promise<{created:number, updated:number, skipped:number, errors:any[]}>}
 */
export async function syncAttackTablesToCompendium(source, options = {}) {
  _assertGM("syncAttackTablesToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Attack Tables";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const input = await resolveSource(source);
    const tables = Array.isArray(input) ? input : (input?.tables ?? [input]).filter(Boolean);
    if (!tables?.length) return result;

    const template = await getAttackTableTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder", "system.slug"] });
    const resolveExisting = packUpsertResolver(pack);

    const folderCache = new Map();
    const createPayload = [];
    const updatePayload = [];
    for (let i = 0; i < tables.length; i++) {
      const entry = tables[i];
      const name = entry.name ?? `Attack Table ${i + 1}`;
      const sysSource = entry.system ?? entry;
      const system = buildAttackTableSystemData(sysSource, template);
      const existing = resolveExisting("attackTable", system.slug || slugify(name), name);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/sword.svg");
      const base = { name, type: "attackTable", img, system };

      const folderId = await ensurePackFolderPath(
        pack, [options.parentFolderName, folderName].filter(Boolean), folderCache
      );
      if (existing) {
        if (!updateExisting) { result.skipped += 1; continue; }
        updatePayload.push({ _id: existing._id, folder: folderId, ...base });
      } else {
        if (!createMissing) { result.skipped += 1; continue; }
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
    console.error("RMF | syncAttackTablesToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/*  Critical Tables                                                           */
/* -------------------------------------------------------------------------- */

/** Pull the system template for `criticalTable` items (empty when absent). */
async function getCriticalTableTemplate() {
  const fromDocTypes = foundry.utils.getProperty(game.system, "documentTypes.Item.criticalTable.template");
  if (fromDocTypes && typeof fromDocTypes === "object") return fromDocTypes;
  return {};
}

/** Normalize one critical cell: { text, effects, variants? }. */
function normalizeCriticalCell(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const cell = {
    text:    typeof src.text === "string" ? src.text : "",
    effects: typeof src.effects === "string" ? src.effects : ""
  };
  if (Array.isArray(src.variants) && src.variants.length) {
    cell.variants = src.variants.map(v => ({
      condition: typeof v?.condition === "string" ? v.condition : "",
      effects:   typeof v?.effects === "string" ? v.effects : ""
    }));
  }
  return cell;
}

/** Normalize the critical roll-band rows (rollMin: null = low catch-all). */
function normalizeCriticalRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => {
    const src = (r?.results && typeof r.results === "object") ? r.results : {};
    const results = {};
    for (const [k, v] of Object.entries(src)) results[String(k)] = normalizeCriticalCell(v);
    const hasMin = !(r?.rollMin === null || r?.rollMin === undefined);
    return {
      label:   typeof r?.label === "string" ? r.label : "",
      rollMin: hasMin ? _atNum(r.rollMin, 0) : null,
      rollMax: _atNum(r?.rollMax, 0),
      results
    };
  });
}

/** Build the criticalTable `system` payload from a raw source entry. */
function buildCriticalTableSystemData(sysSource, template) {
  const src = sysSource && typeof sysSource === "object" ? sysSource : {};
  return foundry.utils.mergeObject(
    foundry.utils.duplicate(template),
    {
      tableId:  String(src.tableId ?? ""),
      critType: String(src.critType ?? ""),
      columnDefs: Array.isArray(src.columnDefs)
        ? src.columnDefs.map(c => ({ key: String(c?.key ?? ""), label: String(c?.label ?? "") }))
        : [],
      legend:   (src.legend && typeof src.legend === "object") ? src.legend : null,
      rollMatchPolicy: String(src.rollMatchPolicy ?? ""),
      rows:     normalizeCriticalRows(src.rows),
      slug:     authoredSlug(src),
      fromBook: String(src.fromBook ?? "basic")
    },
    { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
  );
}

/**
 * Import critical-table items from a JSON source. Accepts a single table
 * object, an array of tables, or `{ tables: [...] }`.
 *
 * @param {string|Array|Object} source - URL, JSON string, or parsed data
 * @param {Object} [options]
 * @param {string} [options.folderName="Critical Tables"]
 * @param {boolean} [options.dedupeByName=false]
 * @returns {Promise<{created: Item[], skipped: string[], errors: any[]}>}
 */
export async function importCriticalTables(source, options = {}) {
  _assertGM("importCriticalTables");
  const folderName = options.folderName ?? "Critical Tables";
  const dedupeByName = options.dedupeByName ?? false;
  const result = { created: [], skipped: [], errors: [] };

  try {
    const input = await resolveSource(source);
    const tables = Array.isArray(input) ? input : (input?.tables ?? [input]).filter(Boolean);
    if (!tables?.length) return result;

    const template = await getCriticalTableTemplate();
    const folderCache = new Map();
    const existingByName = dedupeByName
      ? game.items.reduce((acc, it) => { if (it.type === "criticalTable") acc[it.name] = true; return acc; }, {})
      : {};

    const docs = [];
    for (let i = 0; i < tables.length; i++) {
      const entry = tables[i];
      const name = entry.name ?? `Critical Table ${i + 1}`;
      if (dedupeByName && existingByName[name]) { result.skipped.push(name); continue; }
      const sysSource = entry.system ?? entry;
      const system = buildCriticalTableSystemData(sysSource, template);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/blood.svg");
      const folderId = await _ensureItemFolder(folderName, folderCache);
      docs.push({ name, type: "criticalTable", img, system, folder: folderId });
    }

    if (!docs.length) return result;
    result.created = await Item.createDocuments(docs);
    return result;
  } catch (err) {
    console.error("RMF | importCriticalTables error", err);
    result.errors.push(err);
    return result;
  }
}

/**
 * Synchronize critical-table items into a compendium pack. Slug-first
 * upsert (name fallback), same policy as the attack tables. Lands them in
 * a "Critical Tables" folder, nested under options.parentFolderName.
 *
 * @param {string|Array|Object} source
 * @param {Object} [options]
 * @param {string} [options.pack="world.basic-core"]
 * @param {string} [options.folderName="Critical Tables"]
 * @param {string} [options.parentFolderName]
 * @param {boolean} [options.createMissing=true]
 * @param {boolean} [options.updateExisting=true]
 * @returns {Promise<{created:number, updated:number, skipped:number, errors:any[]}>}
 */
export async function syncCriticalTablesToCompendium(source, options = {}) {
  _assertGM("syncCriticalTablesToCompendium");
  const packCollection = options.pack ?? "world.basic-core";
  const folderName = options.folderName ?? "Critical Tables";
  const createMissing = options.createMissing ?? true;
  const updateExisting = options.updateExisting ?? true;
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  try {
    const pack = game.packs.get(packCollection);
    if (!pack) throw new Error(`Compendium pack not found: ${packCollection}`);
    if (pack.documentName !== "Item") throw new Error(`Pack ${packCollection} is not an Item compendium`);

    const input = await resolveSource(source);
    const tables = Array.isArray(input) ? input : (input?.tables ?? [input]).filter(Boolean);
    if (!tables?.length) return result;

    const template = await getCriticalTableTemplate();
    await pack.getIndex({ fields: ["name", "type", "folder", "system.slug"] });
    const resolveExisting = packUpsertResolver(pack);

    const folderCache = new Map();
    const createPayload = [];
    const updatePayload = [];
    for (let i = 0; i < tables.length; i++) {
      const entry = tables[i];
      const name = entry.name ?? `Critical Table ${i + 1}`;
      const sysSource = entry.system ?? entry;
      const system = buildCriticalTableSystemData(sysSource, template);
      const existing = resolveExisting("criticalTable", system.slug || slugify(name), name);
      const img = pickImageFromEntry(entry, sysSource, "icons/svg/blood.svg");
      const base = { name, type: "criticalTable", img, system };

      const folderId = await ensurePackFolderPath(
        pack, [options.parentFolderName, folderName].filter(Boolean), folderCache
      );
      if (existing) {
        if (!updateExisting) { result.skipped += 1; continue; }
        updatePayload.push({ _id: existing._id, folder: folderId, ...base });
      } else {
        if (!createMissing) { result.skipped += 1; continue; }
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
    console.error("RMF | syncCriticalTablesToCompendium error", err);
    result.errors.push(err);
    return result;
  }
}
