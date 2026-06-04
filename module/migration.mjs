/**
 * RMF System - Schema Migration Framework
 *
 * World-scoped, idempotent migration runner. Triggered by the `ready` hook
 * once per world; only the GM executes migrations. Persists the last
 * applied version in a world setting so reloads do not re-run completed
 * steps.
 *
 * Reference: Documentation/system-ars/09_Migration_Versioning.md
 *
 * Add migrations by appending an entry to MIGRATIONS:
 *
 *   {
 *     to: "0.2.0",                       // version this step produces
 *     description: "Move chFoo → chBar",
 *     async run({ actors, items, log }) { // idempotent
 *       for (const actor of actors) { ... }
 *     }
 *   }
 *
 * Steps run in array order. Each step MUST be safe to re-run (the next
 * release may be a hotfix that re-applies the same step against worlds
 * that crashed half-way through).
 *
 * @fileoverview Migration runner. Pure framework — no migrations defined yet.
 */

import { slugify } from "./utils/slug.mjs";
import { resolveSpecialRole } from "./data-models/_identity.mjs";

const SETTING_LAST_VERSION = "lastMigrationVersion";
const SETTING_IN_PROGRESS = "migrationInProgress";

/**
 * Item types that carry a stable `system.slug` (the *content* types — not
 * `equipment`, which is per-character instance state). Kept in sync with
 * module/data-models/_identity.mjs usage.
 * @type {ReadonlySet<string>}
 */
const SLUG_CONTENT_TYPES = new Set([
  "skill", "category", "profession", "race", "realm",
  "spellList", "trainingPackage", "attackTable"
]);

/**
 * Compute the identity-backfill update for a single Item: stamp `slug`
 * when empty and `specialRole` when derivable from the name. Returns null
 * when nothing needs changing (so callers can skip no-op writes).
 *
 * @param {Item} item
 * @param {string} [stampVersion] - schema version to record in flags
 * @returns {Record<string, unknown>|null}
 */
export function buildIdentityBackfill(item, stampVersion) {
  if (!item || !SLUG_CONTENT_TYPES.has(item.type)) return null;
  const sys = item.system ?? {};
  const update = {};
  if (!sys.slug) update["system.slug"] = slugify(item.name);
  if (item.type === "skill" || item.type === "category") {
    const role = resolveSpecialRole(sys.specialRole, item.name);
    if (role !== "none" && sys.specialRole !== role) update["system.specialRole"] = role;
  }
  if (!Object.keys(update).length) return null;
  if (stampVersion) update["flags.rmf.schemaVersion"] = stampVersion;
  return update;
}

/**
 * Apply a per-document transform to every Item in the world's WRITABLE
 * (packageType "world") Item compendia — e.g. `world.basic-core`. System
 * and module packs are read-only and ship pre-stamped (they are built from
 * data/*.json whose entries already carry `slug`/`specialRole`, and any
 * gaps are filled by the `preCreateItem` hook at build time), so they are
 * skipped here. Locked world packs are temporarily unlocked and relocked;
 * the unlock lives inside the try so a configure() failure can't abort the
 * whole migration step.
 *
 * @param {(item: Item) => (Record<string, unknown>|null)} transform
 * @param {(msg: string) => void} log
 * @returns {Promise<void>}
 */
async function migrateWorldItemPacks(transform, log) {
  const packs = game.packs.filter(
    p => p.documentName === "Item" && p.metadata?.packageType === "world"
  );
  for (const pack of packs) {
    const wasLocked = pack.locked;
    let unlocked = false;
    try {
      if (wasLocked) { await pack.configure({ locked: false }); unlocked = true; }
      const docs = await pack.getDocuments();
      const updates = [];
      for (const doc of docs) {
        const u = transform(doc);
        if (u) updates.push({ _id: doc.id, ...u });
      }
      if (updates.length) {
        await Item.implementation.updateDocuments(updates, { pack: pack.collection });
      }
      log(`Pack ${pack.collection}: updated ${updates.length}/${docs.length} item(s).`);
    } catch (err) {
      log(`Pack ${pack.collection}: skipped (${err.message}).`);
    } finally {
      if (unlocked) await pack.configure({ locked: true }).catch(() => {});
    }
  }
}

/**
 * Ordered list of migration steps. Each step has:
 *   - `to`: target schema version (string, semver-ish; matches system.json)
 *   - `description`: short human-readable summary (English; appears in UI)
 *   - `run(ctx)`: async function performing the migration, idempotent
 *
 * `run` receives a context object with:
 *   - `actors`: Array of world actors
 *   - `items`:  Array of world (sidebar) items
 *   - `scenes`: Array of scenes (for token-actor deltas)
 *   - `log(msg, payload?)`: convenience logger that prefixes RMF | MIGRATION
 *
 * @type {Array<{ to: string, description: string, run: (ctx: object) => Promise<void> }>}
 */
export const MIGRATIONS = [
  {
    to: "0.2.0",
    description: "DataModel introduction: re-emit each actor/item once so the schema-validated shape is persisted.",
    async run({ actors, items, log }) {
      // The 0.2.0 schema mirrors the legacy template.json shape, so no
      // field rename or restructure is needed. Walking through every
      // actor/item with a no-op update forces Foundry to round-trip the
      // data through the registered TypeDataModel: missing fields get
      // filled with their `initial`, out-of-range numbers get clamped,
      // and unknown legacy keys (e.g. former cached calculations on
      // disk) are silently dropped.
      let actorsUpdated = 0, itemsUpdated = 0;
      for (const actor of actors) {
        try { await actor.update({}, { diff: false }); actorsUpdated++; }
        catch (err) { log(`Skipping actor ${actor.name}: ${err.message}`); }
      }
      for (const item of items) {
        try { await item.update({}, { diff: false }); itemsUpdated++; }
        catch (err) { log(`Skipping item ${item.name}: ${err.message}`); }
      }
      log(`Re-emitted ${actorsUpdated} actor(s) and ${itemsUpdated} world item(s) through the new schema.`);
    }
  },
  {
    to: "0.3.0",
    description: "Stamp stable content slugs + specialRole tags (Fase 0: identity). Reroutes joins off display names.",
    async run({ actors, items, log }) {
      const STAMP = "0.3.0";

      // 1) Sidebar (world) items.
      let worldItems = 0;
      const worldUpdates = [];
      for (const item of items) {
        const u = buildIdentityBackfill(item, STAMP);
        if (u) worldUpdates.push({ _id: item.id, ...u });
      }
      if (worldUpdates.length) {
        try {
          await Item.implementation.updateDocuments(worldUpdates);
          worldItems = worldUpdates.length;
        } catch (err) {
          log(`Sidebar item backfill failed: ${err.message}`);
        }
      }

      // 2) Actor-embedded items (skills/categories/etc. cloned onto actors).
      let embedded = 0;
      for (const actor of actors) {
        const updates = [];
        for (const item of actor.items) {
          const u = buildIdentityBackfill(item, STAMP);
          if (u) updates.push({ _id: item.id, ...u });
        }
        if (updates.length) {
          try {
            await actor.updateEmbeddedDocuments("Item", updates);
            embedded += updates.length;
          } catch (err) {
            log(`Actor ${actor.name}: embedded backfill skipped (${err.message}).`);
          }
        }
      }

      // 3) Writable world compendia (e.g. world.basic-core).
      await migrateWorldItemPacks(item => buildIdentityBackfill(item, STAMP), log);

      log(`Identity backfill: ${worldItems} sidebar + ${embedded} embedded item(s) stamped.`);
    }
  },
  {
    to: "0.4.0",
    description: "Fase 1: convert dpCost triples to slash strings and drop the legacy persisted rank/ranks counters (R8).",
    async run({ actors, items, log }) {
      // Re-emitting through the schema does two things at once: the per-model
      // migrateData() rewrites the legacy dpCost triple to the string, and the
      // schema cleaning drops keys no longer in the schema (the removed
      // `rank`/`ranks` counters — R8). Scoped to the 3 types that changed.
      const TYPES = new Set(["category", "skill", "profession"]);
      const reemit = async (doc) => {
        try { await doc.update({}, { diff: false }); return 1; }
        catch (err) { log(`Skip ${doc.name}: ${err.message}`); return 0; }
      };

      let sidebar = 0;
      for (const item of items) if (TYPES.has(item.type)) sidebar += await reemit(item);

      let embedded = 0;
      for (const actor of actors) {
        for (const item of actor.items) if (TYPES.has(item.type)) embedded += await reemit(item);
      }

      let packed = 0;
      const packs = game.packs.filter(
        p => p.documentName === "Item" && p.metadata?.packageType === "world"
      );
      for (const pack of packs) {
        const wasLocked = pack.locked;
        let unlocked = false;
        try {
          if (wasLocked) { await pack.configure({ locked: false }); unlocked = true; }
          for (const doc of await pack.getDocuments()) {
            if (TYPES.has(doc.type)) packed += await reemit(doc);
          }
        } catch (err) {
          log(`Pack ${pack.collection}: ${err.message}`);
        } finally {
          if (unlocked) await pack.configure({ locked: true }).catch(() => {});
        }
      }

      log(`dpCost migration: re-emitted ${sidebar} sidebar + ${embedded} embedded + ${packed} pack item(s).`);
    }
  }
];

/**
 * Register the world settings used by the migration runner. Called from
 * `rmf.mjs._registerSystemSettings` during the `init` hook.
 */
export function registerMigrationSettings() {
  game.settings.register("rmf", SETTING_LAST_VERSION, {
    name: "RMF.Settings.MigrationVersion.Name",
    hint: "RMF.Settings.MigrationVersion.Hint",
    scope: "world",
    config: false,           // hidden — managed by the migration runner
    type: String,
    default: ""
  });
  game.settings.register("rmf", SETTING_IN_PROGRESS, {
    name: "RMF.Settings.MigrationInProgress.Name",
    hint: "RMF.Settings.MigrationInProgress.Hint",
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

/**
 * Compare two version strings using Foundry's helper.
 * `foundry.utils.isNewerVersion(a, b)` returns true when `a > b`.
 * Returns -1 when a<b, 0 when equal, 1 when a>b.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  if (a === b) return 0;
  return foundry.utils.isNewerVersion(a, b) ? 1 : -1;
}

/**
 * Public entry point. Compares the world's last applied version against
 * the current `system.version` and runs all pending steps.
 *
 * Called from the `ready` hook in rmf.mjs. Safe to call by hand from a
 * GM macro to retry after a crash (`game.rmf.runWorldMigration()`).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.force=false] - re-run all migrations from scratch
 *   regardless of stored version. Use only as a debug tool.
 * @returns {Promise<{applied: string[], skipped: boolean, reason?: string}>}
 */
export async function runWorldMigration(opts = {}) {
  const result = { applied: [], skipped: false };

  // Only the GM owns world-level writes; players abort silently.
  if (!game.user?.isGM) {
    result.skipped = true;
    result.reason = "non-GM";
    return result;
  }

  const targetVersion = game.system?.version ?? "0.0.0";
  const fromVersion = String(game.settings.get("rmf", SETTING_LAST_VERSION) || "0.0.0");

  // Up-to-date world: nothing to do.
  if (!opts.force && compareVersions(fromVersion, targetVersion) >= 0) {
    result.skipped = true;
    result.reason = "up-to-date";
    return result;
  }

  // Crash-recovery guard: if a previous run died mid-way, the in-progress
  // flag is still set. We let the user retry but warn them.
  if (game.settings.get("rmf", SETTING_IN_PROGRESS)) {
    ui.notifications?.warn(
      "RMF | Previous migration did not finish cleanly. Retrying — " +
      "all migration steps are idempotent, so re-running is safe."
    );
  }

  await game.settings.set("rmf", SETTING_IN_PROGRESS, true);

  const log = (msg, payload) => {
    if (payload !== undefined) console.log(`RMF | MIGRATION | ${msg}`, payload);
    else console.log(`RMF | MIGRATION | ${msg}`);
  };

  log(`Starting migration ${fromVersion} → ${targetVersion}` + (opts.force ? " (forced)" : ""));
  ui.notifications?.info(`RMF | Migrating world ${fromVersion} → ${targetVersion}…`);

  const ctx = Object.freeze({
    actors: game.actors?.contents ?? [],
    items:  game.items?.contents  ?? [],
    scenes: game.scenes?.contents ?? [],
    log
  });

  try {
    for (const step of MIGRATIONS) {
      const stepIsPending = opts.force || compareVersions(fromVersion, step.to) < 0;
      if (!stepIsPending) {
        log(`Skipping ${step.to} — already applied.`);
        continue;
      }
      log(`Applying ${step.to} — ${step.description}`);
      await step.run(ctx);
      result.applied.push(step.to);
      // Persist after each step so a failure half-way still leaves the
      // world at a known intermediate version.
      await game.settings.set("rmf", SETTING_LAST_VERSION, step.to);
    }

    // Final stamp: even if no steps ran, mark the world as up-to-date so
    // we don't compare against an empty string forever.
    await game.settings.set("rmf", SETTING_LAST_VERSION, targetVersion);
    log(`Migration finished. Applied steps: [${result.applied.join(", ") || "none"}]`);
    if (result.applied.length) {
      ui.notifications?.info(`RMF | Migration complete (${result.applied.length} step${result.applied.length === 1 ? "" : "s"}).`);
    }
  } catch (err) {
    console.error("RMF | MIGRATION failed:", err);
    ui.notifications?.error(
      "RMF | Migration failed. The world may be in an inconsistent state. " +
      "Check the console; re-running game.rmf.runWorldMigration() is safe."
    );
    throw err;
  } finally {
    await game.settings.set("rmf", SETTING_IN_PROGRESS, false);
  }

  return result;
}

/**
 * Per-document sanitization for documents created AFTER migrations have
 * run. Idempotent. Used as a safety net for imports / drag-and-drop from
 * compendia carrying older shapes. Returns the sanitized data without
 * persisting; callers decide whether to call `.update()`.
 *
 * Currently a no-op — schema is at baseline. Wire your per-version
 * cleanups here as you introduce them.
 *
 * @param {Actor} actor
 * @returns {object|null} update payload, or null if nothing to change
 */
export function sanitizeActorData(actor) {
  // No-op for v0.1.0; reserved for future use.
  return null;
}

/**
 * Per-item analogue of {@link sanitizeActorData}. See its docs.
 *
 * @param {Item} item
 * @returns {object|null}
 */
export function sanitizeItemData(item) {
  // No-op: identity stamping for drag-drop / imported items is handled live
  // by the `preCreateItem` hook (module/hooks.mjs → buildIdentityBackfill),
  // which fires for every Item creation. Reserved for future per-item
  // cleanups that must run on already-persisted documents.
  return null;
}
