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

const SETTING_LAST_VERSION = "lastMigrationVersion";
const SETTING_IN_PROGRESS = "migrationInProgress";

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
 * NOTE: at the time of writing, the v0.1.0 schema is the baseline; no
 * migrations are needed yet. The framework is in place so future schema
 * changes can ship with their migration in the same PR.
 *
 * @type {Array<{ to: string, description: string, run: (ctx: object) => Promise<void> }>}
 */
export const MIGRATIONS = [];

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
  // No-op for v0.1.0; reserved for future use.
  return null;
}
