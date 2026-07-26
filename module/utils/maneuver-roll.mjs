/**
 * RMF — maneuver rolls and their chat card.
 *
 * Shared by the sheet actions (module/actions.mjs) and the Actor document
 * method (RMFActor#rollStat) so both obey the same book rules instead of
 * drifting apart — the duplication is what let one of them stay closed.
 *
 * Attacks are NOT rolled here: module/tables/attack-resolver.mjs owns them,
 * which is where Basic Spell attacks stay deliberately closed (PDF p.44).
 *
 * @module utils/maneuver-roll
 */

import { RMF_CONSTANTS } from "./constants.mjs";
import { rollOpenEndedD100 } from "../tables/open-ended.mjs";

const CHAT_TEMPLATE = "systems/rmf/templates/chat/stat-roll.hbs";

/**
 * Coerce a possibly-corrupted bonus into a finite integer, falling back to 0
 * when the input is undefined / NaN / non-numeric. Guards against
 * partially-initialized stat blocks.
 *
 * @param {*} rawBonus
 * @returns {number}
 */
export function safeBonus(rawBonus) {
  const n = Number(rawBonus);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * @typedef {Object} ManeuverResult
 * @property {number|null} um     Unmodified value that fired, else null.
 * @property {number} appliedBonus The bonus that actually counted (0 on a UM).
 * @property {number} diceTotal    The open-ended dice total, bonus excluded.
 * @property {number} total        The maneuver result: diceTotal + appliedBonus.
 */

/**
 * Resolve an open-ended roll plus its bonus into the final maneuver number.
 * Single source of truth so the chat card and the value handed back to macros
 * can never disagree.
 *
 * @param {import("../tables/open-ended.mjs").OpenEndedResult} openEnded
 * @param {*} bonus
 * @returns {ManeuverResult}
 */
export function computeManeuverResult(openEnded, bonus) {
  const bonusValue = safeBonus(bonus);
  // Careful: `um` is null on an ordinary roll and Number(null) is a finite 0,
  // so the nullish check must come first or every roll would read as UM.
  const rawUm = openEnded?.um ?? null;
  const um = rawUm !== null && Number.isFinite(Number(rawUm)) ? Number(rawUm) : null;

  // A UM result is applied verbatim — no explosion, no modifications.
  const appliedBonus = um === null ? bonusValue : 0;
  const diceTotal = Number(openEnded?.total ?? 0);

  return { um, appliedBonus, diceTotal, total: diceTotal + appliedBonus };
}

/**
 * Post a roll using the RMF chat card.
 *
 * @param {object} params
 * @param {Actor} params.actor
 * @param {import("../tables/open-ended.mjs").OpenEndedResult} params.openEnded
 * @param {number} [params.bonus=0]
 * @param {string} params.flavor
 * @param {string} [params.label]
 */
export async function postRollMessage({ actor, openEnded, bonus = 0, flavor, label = "" }) {
  const bonusValue = Number(bonus) || 0;
  const { um, appliedBonus, diceTotal: baseRoll, total: totalResult } =
    computeManeuverResult(openEnded, bonusValue);

  const exploded = !!(openEnded?.openHigh || openEnded?.openLow);
  const dice = Array.isArray(openEnded?.dice) ? openEnded.dice : [];

  // Only the two canonical maneuver bands have a printed name; any other
  // unmodified value a caller declares is shown as a bare "UM <n>".
  const UM = RMF_CONSTANTS.MANEUVER_UM;
  const umLabel = um === null ? ""
    : um === UM.UNUSUAL_SUCCESS ? game.i18n.localize("RMF.Chat.UnusualSuccess")
    : um === UM.UNUSUAL_EVENT ? game.i18n.localize("RMF.Chat.UnusualEvent")
    : game.i18n.format("RMF.Chat.UnmodifiedRoll", { value: um });

  const formula = um !== null
    ? `1d100 (${game.i18n.format("RMF.Chat.UnmodifiedRoll", { value: um })})`
    : `1d100${bonusValue >= 0 ? "+" : ""}${bonusValue} (${game.i18n.localize("RMF.Chat.OpenEnded")})`;

  const bonusAbs = Math.abs(appliedBonus);

  const content = await foundry.applications.handlebars.renderTemplate(CHAT_TEMPLATE, {
    actor,
    statName: label || flavor,
    roll: { total: totalResult },
    bonus: appliedBonus,
    formula,
    baseRoll,
    bonusOperator: appliedBonus < 0 ? "-" : "+",
    bonusAbs,
    hasBonus: bonusAbs !== 0,
    exploded,
    diceChain: exploded ? dice.join(" · ") : "",
    umLabel
  });

  const messageData = {
    speaker: ChatMessage.implementation.getSpeaker({ actor }),
    // Every caller builds `flavor` from a document name, and Foundry renders
    // the flavor as raw HTML — so it is escaped here, at the single sink,
    // rather than trusted from six call sites.
    flavor: Handlebars.escapeExpression(String(flavor ?? "")),
    content,
    rolls: Array.isArray(openEnded?.rolls) ? openEnded.rolls : []
  };

  // rollMode must be applied to the message data — passing it as a creation
  // field is silently dropped (it is not part of the ChatMessage schema).
  ChatMessage.implementation.applyRollMode(messageData, game.settings.get("core", "rollMode"));
  await ChatMessage.implementation.create(messageData);
}

/**
 * Roll a maneuver (skill / category / stat check) and post it to chat.
 *
 * Maneuvers are open-ended in BOTH directions — a natural 96-00 re-rolls and
 * adds, a natural 01-05 re-rolls and subtracts (PDF p.9).
 *
 * The unmodified 66 / 100 exception belongs to the STATIC maneuver table T-4.3
 * only (PDF p.44): a natural 66 is an Unusual Event and a natural 100 an
 * Unusual Success — neither is re-rolled and neither takes any modification.
 * The moving maneuver table T-4.1 prints no UM band at all, so a moving
 * maneuver keeps exploding on a 100 and keeps its bonus on a 66.
 *
 * @param {object} params
 * @param {Actor} params.actor
 * @param {*} params.bonus                 Raw bonus (coerced NaN-safe).
 * @param {string} params.flavor
 * @param {string} [params.label]
 * @param {boolean} [params.staticManeuver=true] Apply the T-4.3 UM 66/100 band.
 * @param {boolean} [params.chatMessage=true] Post the chat card.
 * @returns {Promise<import("../tables/open-ended.mjs").OpenEndedResult & ManeuverResult>}
 *   The dice result widened with the maneuver numbers: `total` is the final
 *   result (dice + bonus), `diceTotal` the bare dice sum.
 */
export async function rollManeuver({
  actor, bonus, flavor, label = "", staticManeuver = true, chatMessage = true
}) {
  const { UNUSUAL_EVENT, UNUSUAL_SUCCESS } = RMF_CONSTANTS.MANEUVER_UM;
  const openEnded = await rollOpenEndedD100({
    high: true,
    low: true,
    unmodified: staticManeuver ? [UNUSUAL_EVENT, UNUSUAL_SUCCESS] : []
  });

  if (chatMessage) {
    await postRollMessage({ actor, openEnded, bonus: safeBonus(bonus), flavor, label });
  }

  // `total` is overridden with the modified result on purpose: that is what a
  // caller (macro, debug log) means by "the roll", and it keeps the pre-refactor
  // contract of RMFActor#rollStat, whose Roll#total included the bonus.
  return { ...openEnded, ...computeManeuverResult(openEnded, bonus) };
}
