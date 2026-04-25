/**
 * RMF System - Rank Bonus Calculations
 *
 * Single source of truth for category and skill rank-bonus formulas.
 * All progressions use a four-tier model:
 *   - 0 ranks  : flat value (often a penalty)
 *   - tier 1   : ranks 1..10
 *   - tier 2   : ranks 11..20
 *   - tier 3   : ranks 21..30
 *   - tier 4   : ranks 31..99
 * Each table stores the per-rank bonus contributed at each tier.
 *
 * Tables are exported as the absolute source of truth for the system —
 * sheets and data models import from here, never reimplement.
 *
 * @fileoverview Pure helpers; no Foundry runtime side-effects.
 */

const TIER_RANGES = Object.freeze({
  tier1: Object.freeze([1, 10]),
  tier2: Object.freeze([11, 20]),
  tier3: Object.freeze([21, 30]),
  tier4: Object.freeze([31, 99])
});

const RANK_BONUS_TABLES = Object.freeze({
  category: Object.freeze({
    standard:    Object.freeze({ zero: -15, tier1: 2, tier2: 1, tier3: 0.5, tier4: 0 }),
    nonstandard: Object.freeze({ zero: 0,   tier1: 0, tier2: 0, tier3: 0,   tier4: 0 })
  }),
  skill: Object.freeze({
    standard: Object.freeze({ zero: -15, tier1: 3, tier2: 2, tier3: 1,   tier4: 0.5 }),
    combined: Object.freeze({ zero: -30, tier1: 5, tier2: 3, tier3: 1.5, tier4: 0.5 }),
    limited:  Object.freeze({ zero: 0,   tier1: 1, tier2: 1, tier3: 0.5, tier4: 0 })
  })
});

export const CATEGORY_PROGRESSIONS = Object.freeze(Object.keys(RANK_BONUS_TABLES.category));
export const SKILL_PROGRESSIONS = Object.freeze(Object.keys(RANK_BONUS_TABLES.skill));

/**
 * Normalize a category progression to a valid key.
 * Legacy values (notApplicable, na, none, other) collapse to 'nonstandard'.
 * Unknown strings fall back to 'standard'.
 * @param {*} value
 * @returns {'standard'|'nonstandard'}
 */
export function normalizeCategoryProgression(value) {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (CATEGORY_PROGRESSIONS.includes(lowered)) return lowered;
  if (["notapplicable", "not-applicable", "none", "na", "other"].includes(lowered)) return "nonstandard";
  return "standard";
}

/**
 * Normalize a skill progression to a valid key.
 * Legacy 'slow' maps to 'limited'; legacy 'fast' maps to 'combined'.
 * Unknown strings fall back to 'standard'.
 * @param {*} value
 * @returns {'standard'|'combined'|'limited'}
 */
export function normalizeSkillProgression(value) {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (SKILL_PROGRESSIONS.includes(lowered)) return lowered;
  if (lowered === "slow") return "limited";
  if (lowered === "fast") return "combined";
  return "standard";
}

function _tierCounts(totalRanks) {
  const ranks = Math.max(0, Number(totalRanks ?? 0));
  return {
    ranks,
    t1: Math.min(ranks, 10),
    t2: Math.min(Math.max(ranks - 10, 0), 10),
    t3: Math.min(Math.max(ranks - 20, 0), 10),
    t4: Math.min(Math.max(ranks - 30, 0), 69) // 31..99 inclusive
  };
}

function _computeFromTable(totalRanks, table) {
  if (!table) return 0;
  const { ranks, t1, t2, t3, t4 } = _tierCounts(totalRanks);
  if (ranks === 0) return table.zero;
  return (t1 * table.tier1) + (t2 * table.tier2) + (t3 * table.tier3) + (t4 * table.tier4);
}

function _formatBreakdown(totalRanks, table) {
  if (!table) return "0";
  const { ranks, t1, t2, t3, t4 } = _tierCounts(totalRanks);
  if (ranks === 0) return String(table.zero);
  const parts = [];
  if (t1 > 0 && table.tier1) parts.push(`${t1}*${table.tier1}`);
  if (t2 > 0 && table.tier2) parts.push(`${t2}*${table.tier2}`);
  if (t3 > 0 && table.tier3) parts.push(`${t3}*${table.tier3}`);
  if (t4 > 0 && table.tier4) parts.push(`${t4}*${table.tier4}`);
  return parts.length ? parts.join(" + ") : "0";
}

export function computeCategoryRankBonus(totalRanks, progression) {
  const key = normalizeCategoryProgression(progression);
  return _computeFromTable(totalRanks, RANK_BONUS_TABLES.category[key]);
}

export function computeSkillRankBonus(totalRanks, progression) {
  const key = normalizeSkillProgression(progression);
  return _computeFromTable(totalRanks, RANK_BONUS_TABLES.skill[key]);
}

export function formatCategoryRankBonusBreakdown(totalRanks, progression) {
  const key = normalizeCategoryProgression(progression);
  return _formatBreakdown(totalRanks, RANK_BONUS_TABLES.category[key]);
}

export function formatSkillRankBonusBreakdown(totalRanks, progression) {
  const key = normalizeSkillProgression(progression);
  return _formatBreakdown(totalRanks, RANK_BONUS_TABLES.skill[key]);
}

export { RANK_BONUS_TABLES, TIER_RANGES };
