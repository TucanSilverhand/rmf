# RMF — Refactor arquitectónico (rama `refactor`)

> Documento vivo. Registra **decisiones**, **cambios por fase** y **cómo migrar**.
> Rama: `refactor` (clonada de `production`). Todo el trabajo del refactor vive aquí.
> Última actualización: Fase 0 (identidad por slug) — 2026-06.

## 0. Contexto y objetivo

RMF es un sistema FoundryVTT v13.341 (Rolemaster Fantasy, RMFT v4.0). La superficie
(sheets ApplicationV2, DataModels `TypeDataModel`, helpers modernos) es idiomática y sin
APIs deprecadas. El problema de fondo, detectado en la revisión arquitectónica, es que
**todo el contenido se enlazaba por NOMBRE de texto libre**, lo que no escala al objetivo
de crecer de un libro "basic" a muchos libros. Este refactor corrige los cimientos
mientras es barato (54 entradas, todas "basic").

### Decisiones validadas por el usuario

| Tema | Decisión |
|---|---|
| **Identidad** | `slug` estable por contenido (prioridad #0). El nombre es solo display/i18n. |
| **Coste DP** | `dpCost` → string compacto (`"2/5"`, `"2/2/2"`, `"3/*"`); `""` = sin coste/no aplica. `dpCost` se mantiene en skill (es el coste **efectivo** del personaje, lo rellena la profesión). |
| **`*` en coste** | `N/*` = rangos **ilimitados** al coste anterior (`"3/*"` = todos a 3). NO es "restringido". |
| **Multi-libro** | Arquitectura completa: packs del sistema (LevelDB) + módulos por libro + registro + `bookId`/upsert por slug. |
| **Items vs estado** | Split completo: definiciones en compendio, estado del personaje en `actor.system` por slug. Índice síncrono en memoria. Bonos de profesión/raza derivados (no mutados). |

### Hoja de ruta por fases (dependencias)

- **Fase 0 — Identidad** (✅ este commit): `slug` + `specialRole`, reenrutado de joins, migración 0.3.0. *Cimiento: todo lo demás se une por slug.*
- **Fase 1 — Notación de coste + limpieza**: `dpCost` string + `module/utils/dp-cost.mjs`; eliminar el campo `rank`/`ranks` duplicado (drift).
- **Fase 2 — Multi-libro**: `bookId`, upsert por slug, `professionalBonuses` estructurados, packs LevelDB + registro `CONFIG.RMF.contentPacks`, módulos por libro.
- **Fase 3 — Split definición/estado + ActiveEffects**: estado en `actor.system`, índice síncrono, bonos derivados.

---

## Fase 0 — Identidad por slug (✅ completada)

### Qué resuelve

- **Joins frágiles por nombre**: `String(a.name).trim().toLowerCase()` se rompía con
  acentos, el middot `·` de "Armor · Heavy", mayúsculas, traducción y typos.
- **HP/PP por literal inglés**: traducir o tener un typo en "Body Development" /
  "Power Point Development" ponía a 0 el HP/PP máximo (fallo silencioso crítico).
- **Bug real "Caving"**: razas pedían la skill `"Caving"` pero la canónica es
  `"Caving (Spelunking)"` → no casaban (auto-stub vacío). Corregido.

### Piezas nuevas

| Archivo | Rol |
|---|---|
| [module/utils/slug.mjs](module/utils/slug.mjs) | **Fuente única** de identidad: `slugify()` (total, nunca vacía — fallback a hash), `contentUid()`, `identityKey()`, `matchesIdentity()`, `buildSlugIndex()`, `resolveFromIndex()`. Puro, sin dependencias de Foundry. |
| [module/data-models/_identity.mjs](module/data-models/_identity.mjs) | Fragmento de esquema compartido: `slugField()`, `specialRoleField()`, `SPECIAL_ROLES`, `specialRoleFromName()`, `resolveSpecialRole()`. |
| [tools/backfill-slugs.mjs](tools/backfill-slugs.mjs) | Dev-tool one-off: estampa `slug`/`specialRole` en `data/*.json` con el `slugify` real + errata Caving. |

### Modelo de identidad

- **`system.slug`**: kebab estable (`armor-heavy`, `body-development`, `caving-spelunking`).
  Vive en los **8 tipos de contenido** (skill, category, profession, race, realm,
  spellList, trainingPackage, attackTable). **No** en `equipment` (estado instancia) ni en el actor.
- **`fromBook`**: identificador de libro (hoy `"basic"`). El uid global es `${fromBook}.${slug}` (`basic.armor-heavy`), expuesto por `contentUid()`. Se formaliza como `bookId` en Fase 2.
- **`system.specialRole`** (solo skill/category): `"none" | "bodyDevelopment" | "powerPointDevelopment"`.
  Sustituye el match por nombre inglés en el cálculo de HP/PP y la herencia de stats del realm.
- **Regla de oro**: `slug` es **siempre `blank:true`** (jamás un validador non-blank). La
  resolución cae a `slugify(name)` si el slug está vacío → un documento sin migrar sigue resolviendo.

### Reglas de resolución

Todo join de contenido pasa ahora por `slug.mjs`:

```js
// Comparar una referencia (nombre O slug) con un candidato:
matchesIdentity(categoryItem, skill.system.category)   // slug → slugify(name) fallback
// Índice O(1) para agrupar (sheet, racial ranks):
const idx = buildSlugIndex(categories);
resolveFromIndex(idx, skill.system.category);
// Rol especial con fallback al nombre:
resolveSpecialRole(skill.system.specialRole, skill.name) === "bodyDevelopment"
```

### Sitios reenrutados (off display-name)

- `data-models/skill.mjs` — skill→category (`matchesIdentity`) y tabla especial Body/PP-Dev (`resolveSpecialRole`).
- `data-models/character.mjs` — HP/PP máx por `resolveSpecialRole`.
- `data-models/category.mjs` — herencia statBonus del realm para PP-Dev por `resolveSpecialRole`.
- `hooks.mjs` — sync PP-Dev (×2) y recolección de skills críticas por `resolveSpecialRole`.
- `actor-sheet.js` — agrupación skill→category (`buildSlugIndex`), rangos raciales y special skills (`matchesIdentity`), `_resolveSkillSourceData` (incluye `system.slug` en el índice del pack).

### Estampado del slug (3 caminos, convergentes)

1. **Datos**: `data/*.json` llevan `slug` explícito (backfill). 243 filas, 4 `specialRole`.
2. **Creación**: hook `preCreateItem` ([hooks.mjs](module/hooks.mjs)) estampa `slug`/`specialRole`
   en cualquier item de contenido nuevo (a mano, drag-drop, importer vía `Item.createDocuments`).
   No hace falta tocar las 8 rutas del importer.
3. **Mundos existentes**: migración **0.3.0** ([migration.mjs](module/migration.mjs)) recorre items
   de barra lateral, items embebidos en actores y **packs de mundo** (`world.basic-core`),
   estampando `slug`/`specialRole` y un sello `flags.rmf.schemaVersion`.

Como `slug = slugify(name)` en los tres caminos, el resultado es idéntico y consistente.

### Migración / consistencia

- `system.json` → versión **0.3.0**. `runWorldMigration` corre el paso al cargar (GM).
- **Nuevo**: `migrateWorldItemPacks()` recorre los packs **de mundo** (writable) además de
  actores e items. Los packs de sistema/módulo son read-only y se sanan vía `migrateData` al cargar.
- `sanitizeItemData()` (antes no-op) ahora rellena identidad para items arrastrados de compendios antiguos.
- `buildIdentityBackfill(item, version?)` es el helper único de backfill (lo usan la migración, `sanitizeItemData` y el hook `preCreateItem`).

### Errata aplicada (regla del proyecto: avisar)

- ✅ **"Caving" → "Caving (Spelunking)"**: 2 referencias (Enanos, Halflings, lista everyman). Corregido en `races.json`.
- ⚠️ **"Horticulture"** (Halflings, everyman): **NO existe** skill con ese nombre ni similar en
  `skills.json`. **Dejado intacto y marcado** — requiere tu decisión: ¿añadir la skill "Horticulture"
  al `data/skills.json` o corregir el nombre de la referencia? (Hasta entonces, al soltar la raza se
  auto-genera un stub vacío para esa skill.)

### Cómo aplicar/probar

```bash
# Re-generar slugs en data/*.json (idempotente):
node tools/backfill-slugs.mjs
# En Foundry (GM), si hace falta forzar la migración de un mundo ya cargado:
game.rmf.runWorldMigration()
# o forzada:  game.rmf.runWorldMigration({ force: true })
```

### Revisión adversaria (10 agentes) — hallazgos corregidos

Tras implementar la Fase 0 se pasó una revisión multi-agente (correctitud, idiomática v13,
seguridad de migración, completitud). Veredicto: **sin APIs deprecadas; lógica de identidad
correcta e idempotente**. Correcciones aplicadas:

- ✅ **profession-apply.mjs** (era el único MEDIUM): unía contenido por nombre crudo mientras el
  resto iba por slug. Reenrutado a `buildSlugIndex`/`resolveFromIndex`/`matchesIdentity`; el índice
  de basic-core ahora pide `system.slug`.
- ✅ **training-package-apply.mjs**: reenrutado igual, por consistencia.
- ✅ **importers.mjs**: ahora **propaga** `slug`/`specialRole` autorizados (skill + category) en
  create y update, así un re-sync no los pierde. (El docstring de `_identity.mjs` ya es veraz.)
- ✅ **migrateWorldItemPacks**: el unlock se movió dentro de `try`/`finally` (un fallo de
  `configure()` ya no aborta el paso); relock con `.catch()`.
- ✅ **migración paso 1** (items de barra): añadido try/catch (aislamiento como las otras pasadas).
- ✅ **sanitizeItemData**: revertido a no-op honesto (el camino vivo es `preCreateItem`, que cubre
  drag-drop). Se elimina código muerto que parecía activo.
- ✅ **actor-sheet**: guard de categoría duplicada y mapa de estado everyman/restricted por `slugify`.
- **Refutado**: el supuesto "high" de que el re-sync borra el slug — la resolución es tolerante a
  vacío y ningún slug diverge del nombre hoy, así que el impacto real era nulo.

### Notas / pendientes que dejó la Fase 0

- **Spell lists (9 JSON) y attack-tables**: NO backfilleados en datos (su estructura difiere);
  obtienen `slug` vía el hook `preCreateItem` al importar. Backfill de datos pendiente si se quiere
  fuente explícita.
- **Perf O(n²) en `skill.mjs`** (un `actor.items.find` por skill): se mantiene; el quick-win
  (`Map slug→bonus` en `RMFActor.prepareDerivedData`) se hará en Fase 3 con el split, o antes si interesa.
- **`profession-apply.mjs`** conserva matches por nombre canónico-a-canónico (consistentes); se
  reestructura en Fase 2 (R7, `professionalBonuses` estructurados).
- En Fase 2, las **referencias** (skill.category, race.specialSkills, etc.) pasarán de guardar
  *nombre* a guardar *slug*; hoy se resuelven por `slugify(nombre)` (compatible hacia adelante).
