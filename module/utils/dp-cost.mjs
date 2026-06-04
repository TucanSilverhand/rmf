/**
 * RMF System — Development-Point cost notation.
 *
 * Rolemaster writes the DP cost of a category/skill as a slash list, e.g.
 * "2/5", "2/2/2", "20". Each number is the DP cost of the Nth rank bought
 * IN A SINGLE LEVEL; the number of tokens = how many ranks may be bought
 * per level.
 *
 *   "2/5"    → 1st rank costs 2, 2nd costs 5, max 2 ranks/level.
 *   "2/2/2"  → 3 ranks/level, each 2.
 *   "20"     → 1 rank/level at 20 (e.g. Power Point Development).
 *   "3/*"    → UNLIMITED ranks/level, all at 3 (the "*" repeats the last
 *              explicit cost without limit). "2/5/*" → 2, then 5, then 5…
 *   ""       → no cost / not applicable / included (e.g. spellPrice base
 *              lists). Distinct from "0", which is an explicit 0-DP cost.
 *
 * This is the single source of truth for parsing, formatting and
 * validating that notation. PURE module (no Foundry deps) so it is unit
 * testable; the schema field + derived `dpCostParsed` live in the
 * DataModels (mirroring how race.mjs handles its "0/6/4/2/1" strings).
 *
 * Replaces the legacy `dpCost: { price1, price2, price3 }` triple, which
 * could not express variable rank counts or the "*" (unlimited) marker.
 *
 * @fileoverview DP-cost helpers. See ./refactor.md (Fase 1).
 */

const TOKEN = /^(?:\d+(?:\.\d+)?|\*)$/;

/**
 * @typedef {Object} ParsedDPCost
 * @property {string}   raw           Canonical string form.
 * @property {number[]} costPerRank   Explicit per-rank DP costs (before any "*").
 * @property {boolean}  unlimited     True when a trailing "*" allows unlimited ranks.
 * @property {number}   ranksPerLevel costPerRank.length, or Infinity if unlimited, or 0 if empty.
 * @property {boolean}  empty         True for "" (no cost / not applicable).
 * @property {boolean}  valid         False when the input was malformed.
 */

/**
 * Validate a DP-cost string. Empty is allowed (means "no cost"). Tokens are
 * non-negative numbers or "*", and "*" may only appear as the LAST token.
 * Single source of validity: delegates to {@link parseDPCost} so the
 * validator and the parser can never disagree.
 *
 * @param {unknown} str
 * @returns {boolean}
 */
export function isValidDPCost(str) {
  if (typeof str !== "string") return false;
  return parseDPCost(str).valid;
}

/**
 * Parse a DP-cost string into a structured form. Tolerant: malformed input
 * yields `{ valid: false }` but never throws, so a bad hand-edit can't break
 * derivation.
 *
 * @param {unknown} input
 * @returns {ParsedDPCost}
 */
export function parseDPCost(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    return { raw: "", costPerRank: [], unlimited: false, ranksPerLevel: 0, empty: true, valid: true };
  }

  const tokens = raw.split("/").map(t => t.trim());
  let valid = tokens.length > 0;
  let unlimited = false;
  const costPerRank = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!TOKEN.test(tok)) { valid = false; continue; }
    if (tok === "*") {
      unlimited = true;
      // "*" is only meaningful as the final token; anything after it is invalid.
      if (i !== tokens.length - 1) valid = false;
      continue;
    }
    costPerRank.push(Number(tok));
  }

  const ranksPerLevel = unlimited ? Infinity : costPerRank.length;
  // Build `raw` straight from the tokens so it stays consistent with
  // costPerRank/ranksPerLevel. Do NOT drop trailing zeros here: in an
  // explicit string "2/0/0" the zeros are real per-rank costs, unlike the
  // padding zeros in a legacy {price1,price2,price3} triple (which
  // dpCostFromTriple/formatDPCost drop on the array path).
  const rawTokens = costPerRank.map(String).concat(unlimited ? ["*"] : []);
  return {
    raw: rawTokens.join("/"),
    costPerRank,
    unlimited,
    ranksPerLevel,
    empty: false,
    valid
  };
}

/**
 * DP cost of the n-th rank (1-indexed) bought within a level, or null when
 * that rank cannot be bought. Beyond the explicit list an unlimited ("*")
 * cost repeats the last explicit value.
 *
 * @param {ParsedDPCost} parsed
 * @param {number} n - 1-indexed rank within the level
 * @returns {number|null}
 */
export function costOfRank(parsed, n) {
  if (!parsed || n < 1) return null;
  const { costPerRank, unlimited } = parsed;
  if (n <= costPerRank.length) return costPerRank[n - 1];
  if (unlimited) return costPerRank.length ? costPerRank[costPerRank.length - 1] : 0;
  return null;
}

/**
 * Canonicalise any cost representation into the slash-string form.
 * Accepts: a string (trim + collapse whitespace), the legacy triple
 * `{ price1, price2, price3 }`, or a number[] / mixed array. For triples and
 * arrays, TRAILING zeros are dropped (they are padding, not real 0-cost
 * ranks — verified: the canonical data has no front/middle zero gaps), so
 * `{2,2,2}`→"2/2/2", `{6,0,0}`→"6", `{0,0,0}`→"".
 *
 * @param {unknown} input
 * @returns {string}
 */
export function formatDPCost(input) {
  if (input == null) return "";

  // String: normalise spacing, drop empty tokens, keep numbers/"*" verbatim.
  if (typeof input === "string") {
    const tokens = input.split("/").map(t => t.trim()).filter(t => t.length);
    return tokens.join("/");
  }

  // Legacy triple → ordered array.
  let arr;
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === "object") {
    if ("price1" in input || "price2" in input || "price3" in input) {
      arr = [input.price1, input.price2, input.price3];
    } else {
      return "";
    }
  } else {
    return "";
  }

  // Map to canonical tokens, then drop trailing "0"/empty padding.
  const tokens = arr.map(v => (v === "*" ? "*" : Number(v)))
    .map(v => (v === "*" ? "*" : (Number.isFinite(v) ? v : 0)));
  while (tokens.length && (tokens[tokens.length - 1] === 0)) tokens.pop();
  return tokens.map(String).join("/");
}

/**
 * Convert the legacy `{ price1, price2, price3 }` triple to the canonical
 * string. Thin alias over {@link formatDPCost} used by the importer and the
 * world migration; lossless for the canonical data (no zero gaps).
 *
 * @param {*} triple
 * @returns {string}
 */
export function dpCostFromTriple(triple) {
  return formatDPCost(triple);
}
