# Informe de auditoría del sistema RMF — 2026-07-26

> Auditoría multi-agente (31 agentes: 8 auditores por dimensión + verificación adversarial
> de cada hallazgo + crítico de completitud). Dimensiones: motor de datos, dados/tablas,
> sheets ApplicationV2, importadores/migraciones, seguridad, APIs deprecadas, convenciones
> del refactor y plantillas/i18n. De 65 hallazgos en bruto se confirmaron 54, se refutaron 3
> y 4 se verificaron a mano posteriormente.
>
> **Balance: 57 hallazgos confirmados** — 10 severidad alta, ~20 media, ~27 baja — más 4
> observaciones de infraestructura.

## 🔴 Severidad ALTA (10)

### Mecánica de juego rota

1. **Las tiradas de skill/categoría/stat nunca son open-ended** — `module/actions.mjs:340`.
   `#rollSkill`, `#rollStat`, `#rollCategory`, `#rollCategoryNoSkill` y `#rollDefensive`
   evalúan un `1d100+bono` plano: un 96-00 natural jamás explota hacia arriba ni un 01-05
   hacia abajo, cuando la regla central de RMF exige maniobras open-ended. ~10% de todas las
   tiradas publican un total incorrecto. El motor correcto ya existe (`rollOpenEndedD100`,
   que sí usa `#rollResistance`) — solo hay que conectarlo.
   **OJO**: no todas las tiradas son abiertas — hay tiradas cerradas (p. ej. los sortilegios
   base de ataque como bola de fuego).

2. **La re-derivación de items en `RMFActor.prepareDerivedData` es un no-op** —
   `module/data-models.mjs:48`. El bucle llama a `item.prepareDerivedData?.()`, que es el
   *stub vacío* del Documento, no el del `TypeDataModel` (`item.system.prepareDerivedData()`).
   Verificado contra el código fuente real de Foundry v13.351: la re-derivación anunciada en
   el comentario nunca ocurre, así que `totalStatsBonus` de categorías/skills se calcula con
   totales de stats obsoletos (0 en actores nuevos) y los máximos de HP/PP derivados quedan
   mal en el flujo principal.

3. **Doble clamp de HP/PP destruye el valor actual y se persiste** —
   `module/data-models/character.mjs:188`. `#calculateSecondaryAttributes` recorta `value`
   contra un máximo vestigial por stats (~50-60) *antes* de que `applySkillBasedDerivedStats`
   establezca el máximo real por Body Development (p. ej. 120). Un PJ con 100/120 HP se
   muestra como ~56/120, y como el input del sheet es editable, el siguiente submit o
   `applyDamage()` **persiste la pérdida**. Igual para powerPoints.

4. **El schema de `specialSkills` corrompe los datos de razas** —
   `module/data-models/race.mjs:38`. Declara `ArrayField(StringField)` pero todo el sistema
   (races.json, importers, race-sheet, actor-sheet) usa objetos `[{name}]`.
   `StringField#_cast` los convierte silenciosamente en `"[object Object]"`.

5. **Los 6 syncs de build_character hacen upsert por nombre, no por slug** —
   `module/importers.mjs:242` (razas, categorías, skills, reinos, profesiones y training
   packages). Viola la regla de identidad de la Fase 0 del refactor: una corrección de errata
   en el nombre + "Generar/Recargar" crea un item duplicado con el mismo slug. El propio
   fichero define `packUpsertResolver` (línea 46) documentando exactamente esta regla, y los
   syncs de spell lists / attack tables sí lo usan.

### Seguridad

6. **XSS almacenado en la chat card de aplicar profesión** — `module/profession-apply.mjs:304`.
   El HTML del mensaje se concatena con nombres de items/actor sin escapar
   (`game.i18n.format` no escapa, y ramas como `<li>${n}</li>` interpolan directo). Un
   jugador semi-fiable que renombre una skill embebida a un payload HTML lo ejecuta en el
   cliente de todos, incluido el GM. La convención correcta ya existe en
   `attack-table-sheet.js:456` (`Handlebars.escapeExpression`).

### Corrupción de estado / UI rota

7. **`categoryRanks` editable con el training package aplicado** —
   `module/training-package-sheet.js:343`. El sheet solo bloquea `takenAtLevel`; la pestaña
   Advanced deja editar los rangos sin comprobar `system.applied`, rompiendo la simetría
   apply/recover y corrompiendo los rangos del actor al retirar el paquete.

8. **Inputs de skills anidadas del TP con `name` roto** —
   `templates/parts/trainingpackage-cat-block.hbs:62`. `{{cat.catIndex}}` dentro del
   `{{#each}}` interno resuelve vacío (Handlebars no sube por la pila de contextos en
   partials). Verificado empíricamente con el Handlebars de Foundry 13.351. Los 5 controles
   por skill escriben en rutas malformadas.

9. **Checkboxes de códigos de conjuro con `name` roto** —
   `templates/parts/item-spelllist-advanced.hbs:71`. `{{../row.index}}` renderiza vacío (un
   path con `../` nunca resuelve block params); el update cae a `"system.spells..codes.X"` y
   falla. Fix de un carácter: `{{row.index}}`.

10. *(fusionado con el nº 5 — misma causa raíz reportada por dos dimensiones)*

## 🟠 Severidad MEDIA (agrupadas por tema)

**Ciclo de vida de raza/reino** (`module/hooks.mjs:450` y 460):
- Borrar la raza **no revierte** los modificadores raciales persistidos (`chStats.*.race`,
  `chRace`) — quedan aplicados para siempre.
- Y a la vez borra **todos** los rangos de nivel 0 de cada categoría/skill, incluidos los que
  nunca otorgó la raza (p. ej. los de un training package tomado a nivel 0).
- Borrar un reino deja el `statBonus` sincronizado en la categoría PP-Dev (low,
  `module/hooks.mjs:441`).

**Training packages**: el unapply recalcula el nivel contra el nivel *actual* del actor, no
el de aplicación (`module/training-package-apply.mjs:157`) — si el PJ subió de nivel entre
medias, quedan rangos fantasma.

**Motor de tablas**:
- Los críticos encadenados **nunca se resuelven**: `parseChain` devuelve `{table}` pero
  `resolveChainedCritical` espera `{type}` (`module/tables/chain.mjs:62`).
- Columna desconocida o fila ausente en un lookup se resuelve silenciosamente como "fallo
  limpio" en vez de error (`module/tables/lookup.mjs:83`).

**Chat/rolls**: `rollMode` se pasa como dato del mensaje en vez de como opción de creación,
así que se ignora — las tiradas de resistencia salen siempre públicas aunque el GM tire en
privado (`module/actions.mjs:263`).

**Derivados**: sin skill de Body Development / PP Development presente, el máximo de HP/PP
colapsa a 0 descartando el cálculo base (`module/data-models/character.mjs:257`).

**Sheets**:
- Soltar una skill/spellList/trainingPackage ya poseída crea un duplicado silencioso
  (`module/actor-sheet.js:489`).
- La profession-sheet reescribe arrays completos desde estado posiblemente stale — ediciones
  rápidas consecutivas se pierden (`module/profession-sheet.js:335`).
- La imagen del item de equipo no es clicable (`data-edit` sin `data-action`,
  `templates/item-sheet.hbs:12`).

**Migraciones**: los pasos "re-emit" 0.2.0 y 0.4.0 son no-ops silenciosos —
`update({}, {diff:false})` no envía datos (`module/migration.mjs:138`).

**XSS secundarios**: el recap de profesión (`module/profession-apply.mjs:323`) y la etiqueta
de banda UM alta en la chat card de ataque (`module/attack-table-sheet.js:454`) — este
último escapa *todos* los demás campos menos ese.

**Convenciones**:
- `#onCreateActor` deduplica las categorías baseline por nombre visible, no por slug
  (`module/hooks.mjs:231`).
- Los valores legacy `slow`/`fast` de `skillRankBonusProgression` se pierden: la validación
  de `choices` los resetea a `"standard"` al inicializar el documento, *antes* de que el
  normalizador de `rank-bonus.mjs:95` (slow→limited, fast→combined) pueda actuar. Solo
  afecta a mundos con datos anteriores al renombrado del commit `87cccab`; conviene un paso
  de migración.

## 🟡 Severidad BAJA (27)

- `module/compendium-admin.mjs:163` — la resolución del pack casa con *cualquier* compendio
  acabado en `.basic-core`: "Borrar contenido" podría vaciar el pack de un módulo ajeno.
- `module/migration.mjs:166` — fallos internos de un paso se tragan y luego se estampa la
  versión: migraciones parciales se vuelven permanentes.
- `module/actions.mjs:661` — TypeError si un hook veta la creación de item.
- `module/actions.mjs:618` — diálogo de borrado renderiza el nombre sin escapar.
- `module/actions.mjs:346` — flavor de tiradas sin escapar.
- `module/actions.mjs:139` — el gate de permisos de `perform()` es código muerto (los sheets
  cablean los handlers directamente).
- `module/actions.mjs:548` — FilePicker con opciones de posición estilo AppV1 ignoradas en v13.
- `module/tables/critical.mjs:89` — tokens de penalización/bono múltiples: solo sobrevive el
  último.
- `module/data-models.mjs:185` — `applyDamage` interpola el nombre del actor sin escapar.
- `module/data-models/equipment.mjs:46` — la rareza derivada machaca siempre la elección del
  usuario cuando `cost > 0`.
- `module/profession-apply.mjs` — cuatro robusteces: apply no atómico, caché de fallos para
  toda la sesión con `world.basic-core` hardcodeado, deltas duplicados no agregados, skills
  fallidas desaparecen del recap sin aviso.
- `module/profession-cost.mjs:46` — usa el slug crudo como clave de índice sin normalizar
  con `slugify`.
- `module/item-sheet.js:63` — el override de instancia `get parts` nunca lo consulta el
  mixin: el swap de plantilla de raza es código muerto.
- `module/item-sheet.js:44` — handlers `toggleEquipped` / `incrementSkillRank` /
  `decrementSkillRank` sin disparador en plantillas.
- `module/spell-list-sheet.js:250` — `rrMod` no puede vaciarse a null (rama inalcanzable).
- `module/profession-sheet.js:265` — observers apuntando a un header desconectado tras el
  primer re-render.
- `module/race-sheet.js:439` — atajos Ctrl+B/I del editor modifican `textarea.value` sin
  disparar `change`: el formato se pierde.
- `module/actor-sheet.js:409` — throw sin capturar si `fromDropData` no resuelve el drag.
- `templates/chat/race-applied.hbs` — plantilla registrada pero nunca renderizada.
- `rmf.mjs:328` — el setting `autoCalculateStats` se registra pero no se lee en ningún sitio;
  desactivarlo no hace nada.
- `module/utils/dp-cost.mjs:137` — los rangos por encima de la lista de costes cuentan como
  gratis en `dpConsumption`. Impacto limitado porque `hooks.mjs:346` estampa el coste
  efectivo de la profesión en la skill al crearla; el residuo: rangos comprados *antes* de
  aplicar profesión (cap fallback de 3/nivel) quedan gratis para siempre, y claves de nivel
  no numéricas (`NaN < 1` es false) entrarían en el cómputo.

## 🔵 Infraestructura y observaciones del crítico de completitud

1. **`tools/convert-dpcost (M5.enyanet.private's conflicted copy 2026-06-08).mjs` está
   trackeado en git** — se incluiría en el zip de release. Diffear contra el canónico y
   borrarlo.
2. **`tools/validate-data.mjs` solo valida los 6 JSON de build_character** (243 entradas).
   Las 9 listas de hechizos y las ~36 tablas de system_tables no pasan por ninguna
   validación automática.
3. **Limpio ✅**: paridad perfecta en/es (532 claves idénticas en ambos lang), el motor
   open-ended (`module/tables/open-ended.mjs`) implementa correctamente los umbrales
   96-00/01-05 con la resta encadenada del libro, y el registro en `rmf.mjs` es v13-nativo
   y correcto (manifest, token bar, iniciativa).
4. **Refutados**: el doble-clic en "Apply ranks" está protegido por el guard síncrono de
   `system.applied`; los inputs para observadores los deshabilita `DocumentSheetV2`
   automáticamente en v13; el sello de versión de migración no puede degradar con los datos
   actuales; y `@stats.qu` no es un bug (la documentación del código usa `@stats.quickness`
   y los alias son los nombres completos en minúscula).

**Cobertura**: quedaron con menor escrutinio `module/matrix-table-sheets.js`, la tubería
attack-resolver/fumble/spell-failure/cell-parser, las matemáticas de `rank-bonus.mjs`, los
sheets de category/skill/realm/critical-table, las plantillas del actor y `module/debug.mjs`
— los auditores las tuvieron en scope pero no reportaron nada allí (limitados a 12 hallazgos
priorizados por dimensión), así que "sin hallazgos" no equivale a "certificado limpio".

## Prioridades recomendadas

1. Primero los que **corrompen datos persistidos o partidas en curso**: doble clamp de HP
   (nº 3), no-op de derivación (nº 2), tiradas no open-ended (nº 1), schema de specialSkills
   (nº 4) y el borrado de raza que no revierte stats.
2. Después el **XSS de profession-apply** (el único explotable por jugadores; corrección
   mecánica con `escapeExpression`, extendiéndola a los XSS menores de paso).
3. Luego los **upserts por nombre** de importers (nº 5) — deuda declarada de la Fase 0.
4. Los dos bugs de plantilla Handlebars (nº 8 y 9) son fixes de una línea con impacto alto.

## Estado de correcciones

### ✅ Nº 1 — Tiradas open-ended en maniobras (2026-07-26)

Ficheros: `module/utils/maneuver-roll.mjs` (nuevo), `module/actions.mjs`,
`module/data-models.mjs`, `module/tables/open-ended.mjs`, `module/utils/constants.mjs`,
`templates/chat/stat-roll.hbs`, `lang/{en,es}.json`.

- Las maniobras (skill / categoría / categoría-sin-skill / stat) tiran **open-ended en ambas
  direcciones** (96-00 suma, 01-05 resta con continuación gobernada por 96-00).
- **UM 66 / UM 100** implementados (PDF p.44): resultado literal, sin explosión y **sin bono**.
- **Distinción estática/movimiento**: el UM 66/100 es exclusivo de la tabla de maniobra
  estática T-4.3. Las maniobras de movimiento (T-4.1) no tienen banda UM, así que se aplica
  según `skill.system.classification === "staticManeuver"` (los datos ya clasifican las 165
  habilidades: 132 estáticas, 20 de movimiento, 10 OB, 3 propósito especial).
- Segundo camino corregido: `RMFActor#rollStat` (método de documento para macros) era una
  tirada cerrada independiente; ahora delega en el mismo motor. `options.formula` sigue
  disponible como escape explícito a una `Roll` simple.
- **Tiradas CERRADAS intactas y verificadas**: Basic Spell attacks (A-10.9.11,
  `resolveResistanceSpell` con `{high:false, low:false}`), críticos normales, fumbles y
  spell failure. Ver la nota sobre Bola de Fuego más abajo.
- Incidental corregido de paso: el `rollMode` ahora se aplica con
  `ChatMessage.implementation.applyRollMode` (antes se pasaba como campo de creación y se
  descartaba en silencio) — era el hallazgo medio nº 11/17.

**Nota sobre "Bola de Fuego"**: en RMFRP, *Basic Spell Attack* (A-10.6 / tabla A-10.9.11) son
los hechizos de ataque que **no** son elementales, y su resultado es un modificador a la RR —
esos son los cerrados, y el código ya los trataba bien. **Fire Ball es un ataque de ÁREA**
(A-10.8, tabla A-10.9.10) y **Fire Bolt un ataque DIRIGIDO** (A-10.7, tabla A-10.9.9): por la
regla universal de ataque (p.42) ambos son open-ended. Lo que los acota es que sus tablas
imprimen filas **UM** (la de ball cubre 96-97 / 98-99 / 100, la de bolt solo UM 100), y una UM
se lee sin modificar ni relanzar; `findUmHighRow` en `attack-resolver.mjs` ya lo hace.

### ✅ Nº 6 — XSS almacenado en la chat card de profesión (2026-07-26)

Fichero: `module/profession-apply.mjs` (`_postProfessionApplyMessage`).
Todo valor de documento se escapa con `Handlebars.escapeExpression` **antes** de pasar por
`game.i18n.format` (que sustituye `{tokens}` sin escapar), y en las interpolaciones directas
`<li>${...}</li>`. Cubre también el hallazgo medio nº 15/20 (misma función). El
`ChatMessage.create` pasa a estar await-eado.

Una revisión adversarial posterior encontró un XSS de la **misma clase en el módulo nuevo**:
`postRollMessage` escribía el `flavor` (construido con nombres de skill/categoría) sin escapar,
y Foundry renderiza el flavor como HTML. Corregido en el único sink, no en los seis llamadores.

### ✅ Nº 5 — Upserts por nombre en los importers (2026-07-26)

Fichero: `module/importers.mjs`. Las seis funciones de `build_character`
(`syncRaces/Categories/Skills/Realms/Professions/TrainingPackages ToCompendium`) resolvían el
upsert con un mapa `type::name.toLowerCase()`. Ahora las **diez** usan el mismo
`packUpsertResolver(pack)` slug-first que ya usaban las de spell lists y tablas:

- `getIndex` pide `system.slug` en los 10 syncs.
- `const existing = resolveExisting("<tipo>", system.slug || slugify(name), name)` colocado
  después de construir `system` (que es donde vive el slug).
- Se elimina todo rastro de `existingByKey`.

Efecto: corregir una errata en el nombre dentro de `data/build_character/*.json` y pulsar
"Generar/Recargar" ya **actualiza** el item existente en vez de crear un duplicado con el mismo
slug. El fallback por nombre se conserva a propósito: es lo que permite que documentos
anteriores a la Fase 0 (sin slug) casen y se sanen al actualizarse.

*Salvedad documentada*: si dos entradas distintas comparten nombre pero no slug, el fallback
hace que la segunda actualice a la primera. No es alcanzable con los datos actuales (0 nombres
duplicados en los seis ficheros canónicos) y es comportamiento preexistente del resolver.

### ✅ Nº 8 y 9 — Los dos bugs de plantilla Handlebars (2026-07-26)

Reproducidos empíricamente con Handlebars 4.7.9 (el que usa Foundry) antes de tocar nada:

- **Nº 9** `templates/parts/item-spelllist-advanced.hbs`: `{{../row.index}}` → `{{row.index}}`.
  Un path con `../` nunca resuelve block params. Antes generaba
  `name="system.spells..codes.instantaneous"`; ahora `system.spells.3.codes.instantaneous`.
- **Nº 8** `templates/parts/trainingpackage-cat-block.hbs` + `module/training-package-sheet.js`:
  dentro del `{{#each cat.skills}}` el `cat` del partial queda fuera de alcance. Se estampa
  `catIndex` en cada fila de skill (junto al `skillIndex` que ya existía) y las 5 rutas usan
  `{{sk.catIndex}}`. Antes los 6 controles por skill generaban
  `system.categoryRanks..skills.0.*`; ahora `system.categoryRanks.2.skills.0.*`.

Verificado además que los nombres corregidos **casan** con los regex de los handlers
(`spell-list-sheet.js:222` y `training-package-sheet.js:349`) y que los rotos no casaban.

### Pendientes de la misma clase (no abordados aún)

- `module/attack-table-sheet.js:454` — `umLabel` sin escapar (medio).
- `module/data-models.mjs` `applyDamage` — nombre de actor sin escapar, y `create` sin await (bajo).
- `module/actions.mjs` — diálogo de borrado con nombre sin escapar (bajo).
- Los `flavor` de las tiradas son literales en inglés (`"${name} Roll"`) pese a existir
  `RMF.Chat.StatRoll` en ambos idiomas (bajo, preexistente).
- Las tiradas de maniobra leen `core.rollMode`, mientras las chat cards de tablas leen el
  setting propio `rmf.defaultRollMode`. Inconsistencia preexistente, decisión pendiente.
