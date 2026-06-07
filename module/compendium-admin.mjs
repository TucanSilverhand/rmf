/**
 * RMF Compendium Admin - GM tools to (re)build or empty the world.basic-core
 * compendium straight from the canonical JSON data files shipped with the
 * system (systems/rmf/data/*).
 *
 * Two GM-only actions are exposed:
 *   - regenerateBasicCore(): ensure the pack exists, ensure its folders exist,
 *     then run every `sync*ToCompendium` importer in dependency order. Upserts
 *     by name, so it is safe to run repeatedly to "reload the JSONs".
 *   - wipeBasicCore(): delete every Item and Folder inside the pack, leaving an
 *     empty (but still present) compendium.
 *
 * Both are wired to buttons in the system settings via two tiny ApplicationV2
 * "menu" classes (see the bottom of this file) and to `game.rmf.*` for macros.
 *
 * FoundryVTT v13.341 compatible — no deprecated V1 APIs.
 */

import {
  syncCategoriesToCompendium,
  syncSkillsToCompendium,
  syncRealmsToCompendium,
  syncRacesToCompendium,
  syncProfessionsToCompendium,
  syncTrainingPackagesToCompendium,
  syncSpellListsToCompendium,
  syncAttackTablesToCompendium
} from "./importers.mjs";

/** Preferred world compendium collection id. */
const PREFERRED_PACK = "world.basic-core";

/**
 * Item folders the find-only syncs (categories/skills/realms/races/professions/
 * training) expect to already exist inside the pack. The spell-list and
 * attack-table syncs create their own folders, so they are not listed here.
 */
const PRECREATE_FOLDERS = [
  "Categories",
  "Skills",
  "Realms",
  "Races",
  "Professions",
  "Training Packages"
];

/** The nine spell-list data files (3 realms × open/closed/base). */
const SPELL_LIST_FILES = [
  "base-channeling-lists.json",
  "base-essence-lists.json",
  "base-mentalism-lists.json",
  "closed-channeling-lists.json",
  "closed-essence-lists.json",
  "closed-mentalism-lists.json",
  "open-channeling-lists.json",
  "open-essence-lists.json",
  "open-mentalism-lists.json"
];

/** Attack-table data files (currently a single transcribed table). */
const ATTACK_TABLE_FILES = [
  "attack-tables/one-handed-concussion.json"
];

/** Absolute (Foundry-served) path to the system data directory. */
function _dataDir() {
  return `systems/${game.system.id}/data`;
}

/**
 * Locate the basic-core pack, mirroring the resolution order used elsewhere in
 * the system: prefer `world.basic-core`, then `<system>.basic-core`, then any
 * Item compendium whose collection id ends in `.basic-core`.
 *
 * @returns {CompendiumCollection|null}
 */
function resolveBasicCorePack() {
  const candidates = [PREFERRED_PACK, `${game.system.id}.basic-core`];
  for (const id of candidates) {
    const pack = game.packs?.get(id);
    if (pack) return pack;
  }
  const fallback = game.packs?.find(
    p => p.documentName === "Item" && String(p.collection ?? "").endsWith(".basic-core")
  );
  return fallback ?? null;
}

/**
 * Resolve the basic-core pack, creating an empty world Item compendium named
 * "basic-core" when none exists yet.
 *
 * @returns {Promise<CompendiumCollection|null>}
 */
async function ensureBasicCorePack() {
  const existing = resolveBasicCorePack();
  if (existing) return existing;

  try {
    const { CompendiumCollection } = foundry.documents.collections;
    const created = await CompendiumCollection.createCompendium({
      type: "Item",
      name: "basic-core",
      label: "basic-core"
    });
    return created ?? resolveBasicCorePack();
  } catch (err) {
    console.error("RMF | Failed to create the basic-core compendium", err);
    return null;
  }
}

/**
 * Create any of the named Item folders that are missing inside the pack.
 *
 * @param {CompendiumCollection} pack
 * @param {string[]} names
 */
async function ensurePackFolders(pack, names) {
  const present = new Set(
    (pack.folders ? Array.from(pack.folders.values()) : [])
      .map(f => String(f.name ?? "").trim().toLowerCase())
  );
  for (const name of names) {
    if (present.has(name.toLowerCase())) continue;
    try {
      await Folder.create({ name, type: pack.documentName }, { pack: pack.collection });
    } catch (err) {
      console.warn(`RMF | Failed creating pack folder "${name}" in ${pack.collection}`, err);
    }
  }
}

/**
 * Run `fn` with the pack temporarily unlocked, restoring the original lock
 * state afterwards. World compendia are usually unlocked, but this keeps the
 * tools robust if the GM locked the pack.
 *
 * @template T
 * @param {CompendiumCollection} pack
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withUnlocked(pack, fn) {
  const wasLocked = !!pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  try {
    return await fn();
  } finally {
    if (wasLocked) {
      try { await pack.configure({ locked: true }); }
      catch (err) { console.warn("RMF | Failed to re-lock basic-core", err); }
    }
  }
}

/**
 * Empty the basic-core compendium: delete every Item and every Folder inside
 * it, leaving the (empty) pack in place.
 *
 * @param {Object} [options]
 * @param {boolean} [options.confirm=true] - Show a confirmation dialog first.
 * @returns {Promise<{docs:number, folders:number}|null>}
 */
export async function wipeBasicCore({ confirm = true } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.error(game.i18n.localize("RMF.Notifications.InsufficientPermissions"));
    return null;
  }

  const pack = resolveBasicCorePack();
  if (!pack) {
    ui.notifications?.warn(game.i18n.localize("RMF.Settings.WipeBasicCore.Missing"));
    return null;
  }

  if (confirm) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("RMF.Settings.WipeBasicCore.Confirm.Title") },
      content: `<p>${game.i18n.localize("RMF.Settings.WipeBasicCore.Confirm.Content")}</p>`,
      yes: { label: game.i18n.localize("RMF.Settings.WipeBasicCore.Confirm.Yes") },
      no: { label: game.i18n.localize("RMF.Common.Cancel") },
      modal: true
    });
    if (!ok) return null;
  }

  const result = await withUnlocked(pack, async () => {
    await pack.getIndex();
    const docIds = pack.index.map(e => e._id);
    if (docIds.length) await Item.deleteDocuments(docIds, { pack: pack.collection });

    const folderIds = (pack.folders ? Array.from(pack.folders.values()) : []).map(f => f.id);
    if (folderIds.length) await Folder.deleteDocuments(folderIds, { pack: pack.collection });

    return { docs: docIds.length, folders: folderIds.length };
  });

  // The profession/training apply layers cache the basic-core index.
  game.rmf?.invalidateProfessionApplyCache?.();
  game.rmf?.invalidateTrainingPackageChoiceCache?.();

  ui.notifications?.info(
    game.i18n.format("RMF.Settings.WipeBasicCore.Done", result)
  );
  console.log(`RMF | basic-core wiped: ${result.docs} items, ${result.folders} folders.`);
  return result;
}

/**
 * (Re)build the basic-core compendium from the canonical JSON data files.
 * Ensures the pack and its folders exist, then runs every importer in
 * dependency order. Existing entries are updated in place (upsert by name).
 *
 * Order: categories → skills → realms → races → professions → training
 * packages → spell lists (9 files) → attack tables. Categories precede skills
 * (skills belong to a category); realms precede professions/races/spell lists
 * (which reference a realm); attack tables are independent and run last.
 *
 * @param {Object} [options]
 * @param {boolean} [options.confirm=true] - Show a confirmation dialog first.
 * @returns {Promise<{created:number, updated:number, skipped:number, errors:any[], steps:object[]}|null>}
 */
export async function regenerateBasicCore({ confirm = true } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.error(game.i18n.localize("RMF.Notifications.InsufficientPermissions"));
    return null;
  }

  if (confirm) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("RMF.Settings.RegenerateBasicCore.Confirm.Title") },
      content: `<p>${game.i18n.localize("RMF.Settings.RegenerateBasicCore.Confirm.Content")}</p>`,
      yes: { label: game.i18n.localize("RMF.Settings.RegenerateBasicCore.Confirm.Yes") },
      no: { label: game.i18n.localize("RMF.Common.Cancel") },
      modal: true
    });
    if (!ok) return null;
  }

  const pack = await ensureBasicCorePack();
  if (!pack) {
    ui.notifications?.error(game.i18n.localize("RMF.Settings.RegenerateBasicCore.CreateFailed"));
    return null;
  }

  const dir = _dataDir();
  const packId = pack.collection;
  const summary = { created: 0, updated: 0, skipped: 0, errors: [], steps: [] };

  // Build the ordered step list. Each step is [label, () => Promise<result>].
  const steps = [
    ["Categories",        () => syncCategoriesToCompendium(`${dir}/categories.json`, { pack: packId })],
    ["Skills",            () => syncSkillsToCompendium(`${dir}/skills.json`, { pack: packId })],
    ["Realms",            () => syncRealmsToCompendium(`${dir}/realms.json`, { pack: packId })],
    ["Races",             () => syncRacesToCompendium(`${dir}/races.json`, { pack: packId })],
    ["Professions",       () => syncProfessionsToCompendium(`${dir}/professions.json`, { pack: packId })],
    ["Training Packages", () => syncTrainingPackagesToCompendium(`${dir}/training_packages.json`, { pack: packId })],
    ...SPELL_LIST_FILES.map(file => [
      `Spell Lists: ${file}`,
      () => syncSpellListsToCompendium(`${dir}/${file}`, { pack: packId })
    ]),
    ...ATTACK_TABLE_FILES.map(file => [
      `Attack Tables: ${file}`,
      () => syncAttackTablesToCompendium(`${dir}/${file}`, { pack: packId })
    ])
  ];

  await withUnlocked(pack, async () => {
    // Pre-create the folders the find-only syncs rely on, so freshly created
    // documents land in the right folder instead of the pack root.
    await ensurePackFolders(pack, PRECREATE_FOLDERS);

    for (const [label, run] of steps) {
      try {
        const r = await run();
        summary.created += Number(r?.created ?? 0);
        summary.updated += Number(r?.updated ?? 0);
        summary.skipped += Number(r?.skipped ?? 0);
        if (Array.isArray(r?.errors) && r.errors.length) summary.errors.push(...r.errors);
        summary.steps.push({ label, ...r });
      } catch (err) {
        console.error(`RMF | regenerateBasicCore step "${label}" failed`, err);
        summary.errors.push(err);
        summary.steps.push({ label, error: String(err) });
      }
    }
  });

  // Refresh the caches that snapshot the basic-core index.
  game.rmf?.invalidateProfessionApplyCache?.();
  game.rmf?.invalidateTrainingPackageChoiceCache?.();

  if (summary.errors.length) {
    ui.notifications?.warn(
      game.i18n.format("RMF.Settings.RegenerateBasicCore.DoneWithErrors", {
        created: summary.created,
        updated: summary.updated,
        errors: summary.errors.length
      })
    );
  } else {
    ui.notifications?.info(
      game.i18n.format("RMF.Settings.RegenerateBasicCore.Done", {
        created: summary.created,
        updated: summary.updated
      })
    );
  }
  console.log(
    `RMF | basic-core regenerated: ${summary.created} created, ${summary.updated} updated, ` +
    `${summary.skipped} skipped, ${summary.errors.length} error(s).`
  );
  return summary;
}

/* -------------------------------------------------------------------------- */
/*  Settings-menu wrappers                                                    */
/* -------------------------------------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

/**
 * Base class for one-shot settings-menu actions. FoundryVTT opens a settings
 * submenu by constructing its `type` and calling `render(true)`. We override
 * render() to run a single async action (which pops its own confirmation
 * dialog) instead of mounting a window — there is no form to display.
 *
 * @abstract
 * @extends {foundry.applications.api.ApplicationV2}
 */
class RMFActionMenu extends ApplicationV2 {
  /** The action to execute when the menu button is clicked. Override in subclasses. */
  static async _action() {}

  /** @override */
  async render(_options, _renderOptions) {
    try {
      await this.constructor._action();
    } catch (err) {
      console.error("RMF | compendium admin action failed", err);
      ui.notifications?.error(game.i18n.localize("RMF.Notifications.ActionFailed"));
    }
    return this;
  }
}

/** Settings button: (re)generate the basic-core compendium from the JSONs. */
export class RegenerateBasicCoreMenu extends RMFActionMenu {
  static async _action() {
    await regenerateBasicCore({ confirm: true });
  }
}

/** Settings button: delete everything inside the basic-core compendium. */
export class WipeBasicCoreMenu extends RMFActionMenu {
  static async _action() {
    await wipeBasicCore({ confirm: true });
  }
}
