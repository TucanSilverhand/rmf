/**
 * RMF Tables — cell parser.
 *
 * A printed RoleMaster attack-table cell encodes the whole result in a
 * tiny string. This turns that string into a structured object so the
 * rest of the engine never has to re-parse:
 *
 *   "12E" → 12 concussion hits + an "E" critical
 *   "7"   → 7 concussion hits, no critical
 *   "9B"  → 9 hits + a "B" critical
 *   "-"   → a miss / no effect (also null or "")
 *   "F"   → fumble (roll on the weapon's fumble table)
 *
 * The function is PURE (no Foundry deps) so it is trivially unit-testable
 * and shared by both the DataModel lookup helper and the attack resolver.
 *
 * @module tables/cell-parser
 */

/**
 * @typedef {Object} ParsedCell
 * @property {"hit"|"miss"|"fumble"|"unknown"} kind
 * @property {number} hits          Concussion hits (0 when none).
 * @property {string|null} critSeverity  Critical severity A-E, or null.
 * @property {string} raw           The original cell text (for display/debug).
 */

const MISS_TOKENS = new Set(["", "-", "—", "–"]);

/**
 * Parse a single attack-table cell.
 *
 * @param {string|number|null|undefined} raw
 * @returns {ParsedCell}
 */
export function parseCell(raw) {
  const text = (raw === null || raw === undefined) ? "" : String(raw).trim();

  if (MISS_TOKENS.has(text)) {
    return { kind: "miss", hits: 0, critSeverity: null, raw: text };
  }
  if (text.toUpperCase() === "F") {
    return { kind: "fumble", hits: 0, critSeverity: null, raw: text };
  }

  // "<hits><severity?>" e.g. "12E", "7", "9B".
  const m = text.match(/^(\d+)\s*([A-Ea-e])?$/);
  if (m) {
    return {
      kind: "hit",
      hits: Number.parseInt(m[1], 10) || 0,
      critSeverity: m[2] ? m[2].toUpperCase() : null,
      raw: text
    };
  }

  // "<severity>" only (rare in some tables) e.g. "E".
  const s = text.match(/^([A-Ea-e])$/);
  if (s) {
    return { kind: "hit", hits: 0, critSeverity: s[1].toUpperCase(), raw: text };
  }

  return { kind: "unknown", hits: 0, critSeverity: null, raw: text };
}

/**
 * Short human label for a parsed cell, used by chat cards / tooltips.
 *
 * @param {ParsedCell} cell
 * @returns {string}
 */
export function describeCell(cell) {
  if (!cell) return "—";
  switch (cell.kind) {
    case "miss":   return "—";
    case "fumble": return "Fumble";
    case "hit":
      return cell.critSeverity
        ? `${cell.hits} hits + ${cell.critSeverity} crit`
        : `${cell.hits} hits`;
    default:       return cell.raw || "?";
  }
}
