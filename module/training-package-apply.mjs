/**
 * RMF System - Training Package application logic.
 *
 * A Training Package is dropped onto a character and simply embeds as a
 * record (it shows in the Manage Player tab like race/profession). It is
 * NOT applied automatically — the player first resolves any selectable
 * (`isChoice`) category/skill on the package sheet, picks the level it was
 * taken at, and then applies the ranks explicitly:
 *
 *   - applyTrainingPackageToActor:   sums each resolved category/skill rank
 *     into the actor's matching category/skill items at
 *     `boughtByLevel.<takenAtLevel>`, then sets `system.applied = true`.
 *     Blocked when already applied.
 *   - unapplyTrainingPackageFromActor: the exact inverse — subtracts the
 *     same ranks and clears `system.applied`. Used by the "Recover ranks"
 *     button and, as a safety net, when an applied package is deleted.
 *
 * Both passes recompute from the package's own `categoryRanks` (with the
 * resolved choices) against the same level, so they are symmetric as long
 * as the package definition/level is not edited while applied (the sheet
 * locks those fields once applied).
 *
 * @module
 */

import { buildSlugIndex, resolveFromIndex } from "./utils/slug.mjs";

/**
 * Clamp the package's `takenAtLevel` to the valid range [0, actor level].
 *
 * @param {Item} tpItem
 * @param {Actor} actor
 * @returns {number}
 * @private
 */
function _clampLevel(tpItem, actor) {
  const max = Math.max(0, Number(actor.system?.chLevel) || 0);
  const lvl = Math.max(0, Math.floor(Number(tpItem.system?.takenAtLevel) || 0));
  return Math.min(lvl, max);
}

/**
 * Resolve the package's category/skill ranks against the actor and build the
 * embedded-item updates that add (`sign = +1`) or subtract (`sign = -1`) those
 * ranks at `boughtByLevel.<level>`. Deltas are aggregated per target item so a
 * package that touches the same item twice still nets a single, correct write.
 *
 * Selectable entries (`isChoice`) are treated like any other: if their stored
 * name resolves to one of the actor's items they are applied; if not (the
 * choice was left unresolved) they are reported under `unresolved` and skipped.
 *
 * @param {Item} tpItem
 * @param {Actor} actor
 * @param {number} level
 * @param {1|-1} sign
 * @returns {{updates: object[], log: {cats: object[], skills: object[], missing: object[], unresolved: object[]}}}
 * @private
 */
function _resolveRankUpdates(tpItem, actor, level, sign) {
  const lvl = String(level);
  const categoryIndex = buildSlugIndex(actor.itemTypes?.category ?? []);
  const skillIndex    = buildSlugIndex(actor.itemTypes?.skill    ?? []);

  const deltas = new Map(); // itemId -> signed rank delta
  const log = { cats: [], skills: [], missing: [], unresolved: [] };

  const record = (item, name, ranks, isChoice, kind) => {
    const r = Number(ranks) || 0;
    if (r <= 0) return;
    if (!item) {
      (isChoice ? log.unresolved : log.missing).push({ kind, name: String(name ?? "") });
      return;
    }
    deltas.set(item.id, (deltas.get(item.id) || 0) + sign * r);
    (kind === "category" ? log.cats : log.skills).push({ name: item.name, ranks: r });
  };

  for (const cr of (tpItem.system?.categoryRanks ?? [])) {
    record(resolveFromIndex(categoryIndex, cr.category), cr.category, cr.ranks, cr.isChoice, "category");
    for (const sk of (cr.skills ?? [])) {
      record(resolveFromIndex(skillIndex, sk.name), sk.name, sk.ranks, sk.isChoice, "skill");
    }
  }

  const updates = [];
  for (const [id, delta] of deltas) {
    if (!delta) continue;
    const item = actor.items.get(id);
    if (!item) continue;
    const cur = Number(item.system?.boughtByLevel?.[lvl]) || 0;
    updates.push({ _id: id, [`system.boughtByLevel.${lvl}`]: Math.max(0, cur + delta) });
  }
  return { updates, log };
}

/**
 * Apply a Training Package's ranks to its embedding character.
 * No-op (with a notice) when there is no actor or it is already applied.
 *
 * @param {Item} tpItem - The trainingPackage item embedded in an actor
 * @returns {Promise<boolean>} true when the package was applied
 */
export async function applyTrainingPackageToActor(tpItem) {
  if (tpItem?.type !== "trainingPackage") return false;
  const actor = tpItem.parent;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") {
    ui.notifications?.warn(game.i18n.localize("RMF.TrainingPackage.NeedsActor"));
    return false;
  }
  if (tpItem.system?.applied) {
    ui.notifications?.warn(game.i18n.format("RMF.TrainingPackage.AlreadyApplied", { name: tpItem.name }));
    return false;
  }

  const level = _clampLevel(tpItem, actor);
  const { updates, log } = _resolveRankUpdates(tpItem, actor, level, +1);

  // Flip the flag in the same batch as the rank writes (all embedded on the
  // same actor) so the operation is atomic.
  updates.push({ _id: tpItem.id, "system.applied": true });
  await actor.updateEmbeddedDocuments("Item", updates);

  const count = log.cats.length + log.skills.length;
  ui.notifications?.info(
    game.i18n.format("RMF.TrainingPackage.ApplyDone", { name: tpItem.name, count, level })
  );
  if (log.unresolved.length || log.missing.length) {
    const names = [...log.unresolved, ...log.missing].map(e => e.name).filter(Boolean).join(", ");
    ui.notifications?.warn(game.i18n.format("RMF.TrainingPackage.SomeNotApplied", { names }));
  }
  return true;
}

/**
 * Reverse a previously-applied Training Package: subtract the same ranks it
 * added (recomputed from its `categoryRanks` at the same level) and clear
 * `system.applied`. No-op when it is not currently applied.
 *
 * @param {Item} tpItem - The trainingPackage item being recovered
 * @param {object} [opts]
 * @param {boolean} [opts.updateFlag=true] - Also clear `system.applied` on the
 *   package. Set false from the delete hook, where the package is going away
 *   and must not be written to.
 * @returns {Promise<boolean>} true when ranks were reverted
 */
export async function unapplyTrainingPackageFromActor(tpItem, { updateFlag = true } = {}) {
  if (tpItem?.type !== "trainingPackage") return false;
  const actor = tpItem.parent;
  if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return false;
  if (!tpItem.system?.applied) {
    if (updateFlag) {
      ui.notifications?.warn(game.i18n.format("RMF.TrainingPackage.NotApplied", { name: tpItem.name }));
    }
    return false;
  }

  const level = _clampLevel(tpItem, actor);
  const { updates } = _resolveRankUpdates(tpItem, actor, level, -1);
  if (updateFlag) updates.push({ _id: tpItem.id, "system.applied": false });
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);

  if (updateFlag) {
    ui.notifications?.info(game.i18n.format("RMF.TrainingPackage.RecoverDone", { name: tpItem.name }));
  }
  return true;
}
