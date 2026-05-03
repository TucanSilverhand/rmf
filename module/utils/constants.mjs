/**
 * RMF System - Centralized constants and stat mappings.
 *
 * Single source of truth for magic numbers and key mappings used across
 * data models, sheets, importers, and actions. Anything that previously
 * appeared as an inline literal (35, 50, -15, ...) lives here.
 *
 * Constants are exported as immutable objects (Object.freeze) so that
 * accidental mutation surfaces immediately.
 *
 * @fileoverview Pure data, no Foundry runtime dependencies.
 */

/**
 * Mapping from short stat key (`ag`, `co`, ...) to the canonical full key
 * used on the actor (`chAgility`, `chConstitution`, ...). Race items, race
 * sheets, and importers all need this conversion.
 */
export const STAT_SHORT_TO_FULL = Object.freeze({
  ag: "chAgility",
  co: "chConstitution",
  me: "chMemory",
  re: "chReasoning",
  sd: "chSelfDiscipline",
  em: "chEmpathy",
  in: "chIntuition",
  pr: "chPresence",
  qu: "chQuickness",
  st: "chStrength"
});

/**
 * Reverse map: `chAgility` → `ag`. Useful for serializing actor stat blocks
 * back to the compact short-key form (e.g. when exporting a race item).
 */
export const STAT_FULL_TO_SHORT = Object.freeze(
  Object.fromEntries(Object.entries(STAT_SHORT_TO_FULL).map(([s, f]) => [f, s]))
);

/**
 * Canonical list of full stat keys, in display order.
 */
export const STAT_KEYS_FULL = Object.freeze(Object.values(STAT_SHORT_TO_FULL));

/**
 * Gameplay constants. Each block is grouped so it is obvious where the
 * number is consumed; do not split or duplicate them in callers.
 */
export const RMF_CONSTANTS = Object.freeze({
  /** Default temp/pot value for a freshly-rolled stat (typical RM starting). */
  DEFAULT_STAT: 35,

  /** Base hit-point pool before constitution / SD modifiers are applied. */
  HP_BASE: 50,

  /**
   * Penalty applied when rolling against a category with 0 ranks of any
   * relevant skill (canonical Rolemaster -15).
   */
  NO_SKILL_PENALTY: -15,

  /** Multiplier used when converting a primary-stat bonus into a resistance. */
  RESISTANCE_MULTIPLIER: 3,

  /** Multiplier used when converting Quickness into the defensive bonus. */
  DEFENSIVE_MULTIPLIER: 3,

  /** Default sheet sizing (used by ApplicationV2 DEFAULT_OPTIONS). */
  SHEET_SIZE: Object.freeze({
    ACTOR_WIDTH: 700,
    ACTOR_HEIGHT: 522,
    ITEM_WIDTH: 500,
    ITEM_HEIGHT: 475
  })
});
