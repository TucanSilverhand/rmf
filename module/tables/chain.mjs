/**
 * RMF Tables — table→table chaining.
 *
 * Fumble and spell-failure cells can point at a critical table
 * (`crit:krush:E`, `crit:impact:A`). This module turns such a reference into
 * an actual critical roll by locating the `criticalTable` Item whose
 * `critType` matches and resolving it. Best-effort: a generic reference
 * (`crit::D`, no type) or a type with no imported table (e.g. "Impact", not
 * shipped) resolves to `{found:false}` and the caller shows the reference as
 * text — never an error.
 *
 * `game`/`Roll` are touched only inside the async functions, so the module
 * still imports cleanly in node (the pure resolver it calls is node-safe too).
 *
 * @module tables/chain
 */

import { resolveCritical } from "./critical.mjs";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * Find the `criticalTable` Item whose `critType` matches `type`. Checks the
 * sidebar first, then the world compendium (default `world.basic-core`).
 *
 * @param {string} type            Critical type, e.g. "Krush".
 * @param {Object} [opts]
 * @param {string} [opts.packId="world.basic-core"]
 * @returns {Promise<Item|null>}
 */
export async function findCriticalTableByType(type, { packId = "world.basic-core" } = {}) {
  const wanted = norm(type);
  if (!wanted) return null;

  const matches = (it) => it?.type === "criticalTable" && norm(it.system?.critType) === wanted;

  const sidebar = game.items?.find?.(matches) ?? null;
  if (sidebar) return sidebar;

  const pack = game.packs?.get?.(packId);
  if (!pack) return null;
  try {
    const docs = await pack.getDocuments({ type: "criticalTable" });
    return docs.find(matches) ?? null;
  } catch (err) {
    console.warn(`RMF | findCriticalTableByType("${type}") failed`, err);
    return null;
  }
}

/**
 * Resolve a chained critical reference produced by a fumble/spell-failure
 * cell (`{table, severity}` from `parseChain`).
 *
 * @param {Object} p
 * @param {string} p.type      Critical type ("" = generic / GM picks).
 * @param {string} p.severity  Severity column (A–E).
 * @param {number} [p.mod=0]
 * @param {string} [p.packId]
 * @returns {Promise<{found:boolean, type:string, severity:string, table?:Item, result?:object}>}
 */
export async function resolveChainedCritical({ type, severity, mod = 0, packId } = {}) {
  const table = await findCriticalTableByType(type, packId ? { packId } : {});
  if (!table) return { found: false, type: String(type ?? ""), severity: String(severity ?? "") };
  const result = await resolveCritical({ table: table.system, column: severity, mod });
  return { found: true, type: String(type ?? ""), severity: String(severity ?? ""), table, result };
}
