/**
 * RMF System - Training Package application logic.
 *
 * When a training-package item is dropped onto a character, this
 * module asks the user for confirmation, then:
 *   1. Applies non-choice category-rank entries to existing categories
 *      on the actor (sums ranks into `boughtByLevel.<currentLevel>`).
 *   2. Applies non-choice skill entries to existing skills similarly.
 *   3. Reports `isChoice` entries and missing categories/skills via a
 *      chat message; the GM resolves choices manually for now.
 *   4. Posts a summary chat message with the `special[]` list.
 *   5. Deletes the embedded TP item (it has been "consumed").
 *
 * The flow runs only on the client that created the item (matching
 * `game.userId === userId`) so a multiplayer session doesn't apply
 * the package twice.
 *
 * @module
 */

/**
 * Apply a Training Package item to its embedding character actor.
 * Returns true when the TP was applied (and consumed); false when the
 * user cancelled or the inputs were invalid.
 *
 * @param {Item} tpItem - The trainingPackage item embedded in an actor
 * @returns {Promise<boolean>}
 */
export async function applyTrainingPackageToActor(tpItem) {
  if (tpItem?.type !== "trainingPackage") return false;
  const actor = tpItem.parent;
  if (!actor || actor.documentName !== "Actor") return false;
  if (actor.type !== "character") return false;

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("RMF.TrainingPackage.ApplyTitle") },
    content: `<p>${game.i18n.format("RMF.TrainingPackage.ApplyConfirm", { name: tpItem.name, actor: actor.name })}</p>`,
    yes: { default: true }
  });
  if (!confirmed) return false;

  const currentLevel = String(Number(actor.system?.chLevel) || 0);
  const categoriesByName = new Map((actor.itemTypes?.category ?? []).map(c => [c.name, c]));
  const skillsByName     = new Map((actor.itemTypes?.skill    ?? []).map(s => [s.name, s]));

  const log = {
    catsApplied: [],
    skillsApplied: [],
    catsMissing: [],
    skillsMissing: [],
    choices: []
  };
  const updates = [];

  for (const cr of (tpItem.system?.categoryRanks ?? [])) {
    const ranks = Number(cr.ranks) || 0;

    if (cr.isChoice) {
      log.choices.push({ kind: "category", name: cr.category, ranks });
    } else {
      const cat = categoriesByName.get(cr.category);
      if (!cat) {
        log.catsMissing.push(cr.category);
      } else if (ranks > 0) {
        const cur = Number(cat.system?.boughtByLevel?.[currentLevel]) || 0;
        updates.push({ _id: cat.id, [`system.boughtByLevel.${currentLevel}`]: cur + ranks });
        log.catsApplied.push({ name: cat.name, ranks });
      }
    }

    for (const sk of (cr.skills ?? [])) {
      const skRanks = Number(sk.ranks) || 0;
      if (sk.isChoice) {
        log.choices.push({ kind: "skill", name: sk.name, ranks: skRanks });
        continue;
      }
      const skill = skillsByName.get(sk.name);
      if (!skill) {
        log.skillsMissing.push(sk.name);
      } else if (skRanks > 0) {
        const cur = Number(skill.system?.boughtByLevel?.[currentLevel]) || 0;
        updates.push({ _id: skill.id, [`system.boughtByLevel.${currentLevel}`]: cur + skRanks });
        log.skillsApplied.push({ name: skill.name, ranks: skRanks });
      }
    }
  }

  if (updates.length) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }

  await postApplyMessage(actor, tpItem, log);

  // Consumed: remove the TP item so it isn't accidentally applied twice.
  await tpItem.delete();
  return true;
}

/**
 * Build a chat-message recap of what the application changed.
 * Lives next to the apply logic so future tweaks land in one place.
 *
 * @private
 */
async function postApplyMessage(actor, tpItem, log) {
  const t = (key, data) => game.i18n.format(key, data ?? {});

  const lines = [`<h3>${t("RMF.TrainingPackage.AppliedHeader", { name: tpItem.name, actor: actor.name })}</h3>`];

  if (log.catsApplied.length || log.skillsApplied.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.TrainingPackage.AppliedSection")}</strong></p><ul>`);
    for (const c of log.catsApplied)   lines.push(`<li>${t("RMF.TrainingPackage.AppliedCategory", { name: c.name, ranks: c.ranks })}</li>`);
    for (const s of log.skillsApplied) lines.push(`<li>${t("RMF.TrainingPackage.AppliedSkill", { name: s.name, ranks: s.ranks })}</li>`);
    lines.push("</ul>");
  }

  if (log.choices.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.TrainingPackage.ChoicesSection")}</strong></p><ul>`);
    for (const c of log.choices) lines.push(`<li>${c.name} (+${c.ranks})</li>`);
    lines.push("</ul>");
  }

  if (log.catsMissing.length || log.skillsMissing.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.TrainingPackage.MissingSection")}</strong></p><ul>`);
    for (const c of log.catsMissing)   lines.push(`<li>${game.i18n.localize("RMF.Skills.Category")}: ${c}</li>`);
    for (const s of log.skillsMissing) lines.push(`<li>${game.i18n.localize("RMF.Skills.Skill")}: ${s}</li>`);
    lines.push("</ul>");
  }

  const specials = tpItem.system?.special ?? [];
  if (specials.length) {
    lines.push(`<p><strong>${game.i18n.localize("RMF.TrainingPackage.Special")}</strong></p><ul>`);
    for (const s of specials) lines.push(`<li>${s.name} — ${s.dpCost} DP</li>`);
    lines.push("</ul>");
  }

  ChatMessage.implementation.create({
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    content: lines.join("\n")
  });
}
