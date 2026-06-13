/**
 * RMF Tables — shared effect-notation primitives.
 *
 * The weapon-fumble (A-10.11.1) and spell-failure (A-10.11.2) tables share a
 * richer effect vocabulary than the critical tables: besides the combat
 * tokens (hits, stun, penalties) their cells roll DICE (`2d10H`), CHAIN to a
 * critical table (`crit:krush:E`), and apply timed states whose duration may
 * itself be a die (`ko:d10h`). This module is the single, pure source for the
 * pieces both parsers reuse:
 *
 *   - token splitting (comma separated, "-"/"" = none)
 *   - dice specs            `2d10` → {n:2, faces:10}   (`d10` → 1d10)
 *   - durations             `12h`, `1w`, `d10mo`, `5d10min`, `*` (ongoing)
 *   - critical chain refs   `crit:<type>:<sev>` (type may be empty = generic)
 *   - the COMMON token set   hits / dice-hits / stun family / penalty / bonus /
 *                            chain / down / ko  — consumed by `consumeCommon`
 *
 * Pure (no Foundry deps): `Roll` is only ever used by the async resolvers in
 * the family modules, never here, so this stays node-testable.
 *
 * Duration grammar — `<value><unit>`:
 *   value : integer (`12`) or dice (`d10`, `5d10`); absent = 1
 *   unit  : ""=rounds · h=hours · d=days · w=weeks · mo=months · min=minutes
 *   `*`   : ongoing / until removed (e.g. "now fight at -25")
 * Dice always carry faces (`d10`); a bare-`d` like `2d` is "2 days", never a die.
 *
 * @module tables/effects-common
 */

/** Tokens meaning "no mechanical effect" (the narrative text carries it). */
export const NONE_TOKENS = new Set(["", "-", "—", "–"]);

/** Split an effects string into trimmed tokens (comma or legacy en-dash). */
export function splitTokens(raw) {
  const text = (raw === null || raw === undefined) ? "" : String(raw).trim();
  if (NONE_TOKENS.has(text)) return [];
  return text.split(/\s*[,–]\s*/).map(t => t.trim()).filter(Boolean);
}

const UNIT = { "": "round", h: "hour", d: "day", w: "week", mo: "month", min: "minute" };

/**
 * Parse a dice spec. `"2d10"` → {n:2, faces:10}; `"d10"` → {n:1, faces:10}.
 * @returns {{n:number, faces:number}|null}
 */
export function parseDice(str) {
  const m = String(str ?? "").trim().match(/^(\d*)d(\d+)$/i);
  if (!m) return null;
  return { n: Number(m[1] || 1), faces: Number(m[2]) };
}

/**
 * Parse a duration value+unit. Accepts an int or a dice value, with an
 * optional unit suffix; bare value = rounds. `"*"` = ongoing.
 * @returns {{value:number|null, dice:{n:number,faces:number}|null, unit:string, ongoing:boolean, raw:string}}
 */
export function parseDuration(str) {
  const raw = String(str ?? "").trim();
  const out = { value: null, dice: null, unit: "round", ongoing: false, raw };
  if (raw === "*") { out.ongoing = true; return out; }
  // dice value then optional unit: d10 / 5d10 / d10mo / 5d10min
  let m = raw.match(/^(\d*)d(\d+)(h|d|w|mo|min)?$/i);
  if (m) { out.dice = { n: Number(m[1] || 1), faces: Number(m[2]) }; out.unit = UNIT[(m[3] || "").toLowerCase()]; return out; }
  // integer value then optional unit: 12 / 12h / 2d / 1w
  m = raw.match(/^(\d+)(h|d|w|mo|min)?$/i);
  if (m) { out.value = Number(m[1]); out.unit = UNIT[(m[2] || "").toLowerCase()]; return out; }
  // bare unit (value implicitly 1): e.g. "w"
  m = raw.match(/^(h|d|w|mo|min)$/i);
  if (m) { out.value = 1; out.unit = UNIT[m[1].toLowerCase()]; return out; }
  return out; // unparseable → value null, caller keeps verbatim
}

/** Build a plain N-rounds duration object (shape matches parseDuration). */
function roundsDuration(n) {
  return { value: Number(n), dice: null, unit: "round", ongoing: false, raw: String(n) };
}

/**
 * Parse a critical-chain reference. `"crit:krush:E"` → {table:"krush",
 * severity:"E"}; `"crit::D"` → {table:"", severity:"D"} (generic, type chosen
 * by the GM / attacker's weapon).
 * @returns {{table:string, severity:string}|null}
 */
export function parseChain(str) {
  const m = String(str ?? "").trim().match(/^crit:([a-z-]*):([A-E])$/i);
  if (!m) return null;
  return { table: m[1].toLowerCase(), severity: m[2].toUpperCase() };
}

/** A fresh accumulator shared by the fumble & spell-failure parsers. */
export function baseEffects(raw) {
  return {
    hits: 0,                 // fixed concussion hits (+NH)
    diceHits: [],            // [{n,faces}] rolled as hits (NdMH)
    stun: 0, stunNoParry: 0, mustParry: 0, noParry: 0, bleed: 0,
    penalties: [],           // [{value, duration:{value,dice,unit,ongoing}}]
    bonus: null,             // {value, rounds}
    chains: [],              // [{table, severity}]
    down: 0,                 // knocked down / prone (rounds)
    ko: null,                // {value, dice, unit, ongoing} unconscious
    other: [],               // unrecognised fragments, verbatim
    raw: (raw === null || raw === undefined) ? "" : String(raw).trim(),
    empty: false
  };
}

/**
 * Consume one COMMON token into `out`. Returns true when handled, false when
 * the caller should try its family-specific tokens (then `other[]`).
 *
 * Order matters: dice-hits before fixed-hits; stnp/stp before st/np/p.
 */
export function consumeCommon(tok, out) {
  let m;
  // Dice hits: 2d10H, d10H  (check before fixed +NH)
  if ((m = tok.match(/^\+?(\d*)d(\d+)\s*H$/i))) { out.diceHits.push({ n: Number(m[1] || 1), faces: Number(m[2]) }); return true; }
  // Fixed hits: +12H / 12H
  if ((m = tok.match(/^\+?(\d+)\s*H$/i)))        { out.hits += Number(m[1]); return true; }
  // Stun family (reuse the critical notation)
  if ((m = tok.match(/^(\d*)stnp$/i)))           { out.stunNoParry += Number(m[1] || 1); return true; }
  if ((m = tok.match(/^(\d*)stp$/i)))            { out.stun += Number(m[1] || 1); out.mustParry += Number(m[1] || 1); return true; }
  if ((m = tok.match(/^(\d*)st$/i)))             { out.stun += Number(m[1] || 1); return true; }
  if ((m = tok.match(/^(\d*)np$/i)))             { out.noParry += Number(m[1] || 1); return true; }
  if ((m = tok.match(/^(\d*)bl$/i)))             { out.bleed += Number(m[1] || 1); return true; }
  // Critical chain: crit:krush:E / crit::D
  const chain = parseChain(tok);
  if (chain) { out.chains.push(chain); return true; }
  // Knocked down / prone: down:N
  if ((m = tok.match(/^down:(\d+)$/i)))          { out.down += Number(m[1]); return true; }
  // Knocked out / unconscious: ko:<dur>
  if ((m = tok.match(/^ko:(.+)$/i)))             { out.ko = parseDuration(m[1]); return true; }
  // Penalty with optional duration: (-N) / M(-N) / (-N):<dur> / (-N):*
  if ((m = tok.match(/^(\d*)\(\s*-\s*(\d+)\s*\)(?::(.+))?$/))) {
    const duration = m[3] ? parseDuration(m[3]) : roundsDuration(Number(m[1] || 1));
    out.penalties.push({ value: -Number(m[2]), duration });
    return true;
  }
  // Attacker bonus next round: (+N) / M(+N)
  if ((m = tok.match(/^(\d*)\(\s*\+\s*(\d+)\s*\)$/))) { out.bonus = { value: Number(m[2]), rounds: Number(m[1] || 1) }; return true; }
  return false;
}
