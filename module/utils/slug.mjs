/**
 * RMF System — Stable content identity (slugs).
 *
 * Every *content* item (skill, category, profession, race, realm,
 * spellList, trainingPackage, attackTable) carries a `system.slug`: a
 * stable, locale-independent identifier that survives renames and
 * translation. The human `name` is for display / i18n only.
 *
 * This module is the SINGLE source of truth for content identity:
 *   - {@link slugify}    printed name → canonical slug (TOTAL — never empty).
 *   - {@link contentUid} book id + slug → global id ("basic.armor-heavy").
 *   - {@link identityKey}/{@link matchesIdentity} compare a free-form
 *     reference (a name OR a slug) against a candidate, locale/format
 *     insensitively — the migration-safe replacement for the scattered
 *     `name.trim().toLowerCase()` joins that used to break on diacritics,
 *     the "·" middot, case, and translation.
 *   - {@link buildSlugIndex}/{@link resolveFromIndex} O(1) lookups.
 *
 * Pure module: no Foundry runtime dependencies, fully unit-testable.
 *
 * @fileoverview Content-identity helpers. See ./refactor.md (Fase 0).
 */

const DIACRITICS = /[\u0300-\u036f]/g;       // combining marks (post-NFD)
const SEPARATORS = /[\u00b7\u2022\u2219\u2027\u30fb]/g; // middot & friends (Armor . Heavy)
const NON_SLUG   = /[^a-z0-9]+/g;
const EDGE_DASH  = /^-+|-+$/g;

/**
 * Small deterministic string hash (djb2 → unsigned base36). Stable across
 * runs and platforms; only used as a last-resort fallback so that even an
 * all-punctuation name maps to *some* non-empty slug.
 *
 * @param {string} str
 * @returns {string}
 */
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Convert a printed name into a canonical slug. TOTAL function: always
 * returns a non-empty `[a-z0-9-]+` string, so it is safe to use as an
 * identity even for names that are all punctuation. Idempotent on values
 * that are already slugs.
 *
 *   slugify("Armor · Heavy")        // "armor-heavy"
 *   slugify("Caving (Spelunking)")  // "caving-spelunking"
 *   slugify("Body Development")     // "body-development"
 *
 * @param {unknown} name
 * @returns {string}
 */
export function slugify(name) {
  const raw = typeof name === "string" ? name : String(name ?? "");
  const slug = raw
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .replace(SEPARATORS, " ")
    .toLowerCase()
    .replace(NON_SLUG, "-")
    .replace(EDGE_DASH, "");
  return slug || `x-${djb2(raw)}`;
}

/**
 * Book-namespaced global id.
 *   contentUid("basic", "armor-heavy") // "basic.armor-heavy"
 * Both parts are slugified defensively so the uid is always well-formed.
 *
 * @param {string} book - book id (today: "basic")
 * @param {string} slug - bare content slug
 * @returns {string}
 */
export function contentUid(book, slug) {
  const b = slugify(book || "basic");
  const s = slug ? slugify(slug) : "";
  return s ? `${b}.${s}` : b;
}

/**
 * Normalize any reference (a stored slug OR a printed name) to a
 * comparable key, so legacy name-based data and new slug-based data join.
 *
 * @param {unknown} ref
 * @returns {string}
 */
export function identityKey(ref) {
  return slugify(ref);
}

/**
 * True when a free-form reference matches a candidate item, comparing by
 * the candidate's `system.slug` when present and by its slugified name
 * otherwise. Format/locale-safe — this is the drop-in replacement for
 * `String(a.name).trim().toLowerCase() === String(b).trim().toLowerCase()`.
 *
 * @param {{name?: string, system?: {slug?: string}}} candidate
 * @param {string} reference - a name or a slug
 * @returns {boolean}
 */
export function matchesIdentity(candidate, reference) {
  if (!candidate) return false;
  const ref = identityKey(reference);
  if (!ref) return false;
  const slug = candidate.system?.slug;
  if (slug && slugify(slug) === ref) return true;
  return slugify(candidate.name) === ref;
}

/**
 * Build a Map(key → item) for O(1) identity lookups over a collection.
 * Indexes each item under BOTH its slug and its slugified name, so a
 * reference written as either form resolves. First writer wins on key
 * collisions (callers pass book-ordered lists so "basic" precedes
 * expansions).
 *
 * @param {Iterable<{name?: string, system?: {slug?: string}}>} items
 * @returns {Map<string, object>}
 */
export function buildSlugIndex(items) {
  const index = new Map();
  for (const item of items ?? []) {
    const bySlug = item?.system?.slug ? slugify(item.system.slug) : "";
    const byName = slugify(item?.name);
    if (bySlug && !index.has(bySlug)) index.set(bySlug, item);
    if (byName && !index.has(byName)) index.set(byName, item);
  }
  return index;
}

/**
 * Resolve a reference against an index built by {@link buildSlugIndex}.
 *
 * @param {Map<string, object>} index
 * @param {string} reference
 * @returns {object|null}
 */
export function resolveFromIndex(index, reference) {
  if (!index) return null;
  return index.get(identityKey(reference)) ?? null;
}
