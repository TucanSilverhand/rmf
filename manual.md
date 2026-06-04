# RMF — Manual técnico del sistema

> Sistema **RoleMaster de Fantasía (RMF)** para FoundryVTT v13.341 — implementación de Rolemaster Fantasy (RMFT v4.0).
> Versión del sistema: **0.3.0** (rama `refactor`).
>
> Este manual explica **todo lo implementado**: qué hace cada subsistema, **cómo** está construido, **por qué**
> se eligió así, cómo se une cada elemento al Actor (personaje), y cada fórmula y tratamiento de datos con su razón.
> Las rutas entre corchetes son enlaces clicables al código fuente. Los nombres de campos, funciones y archivos van
> en inglés (como en el código); la prosa, en español.
>
> Documentos hermanos: [refactor.md](refactor.md) (refactor arquitectónico por fases) y
> [CLAUDE.md](CLAUDE.md) (instrucciones e invariantes del proyecto).

## Cómo leer este manual

El sistema es *data-driven*: las reglas de Rolemaster se modelan como **datos** (items de Foundry y JSON canónicos),
y el código de derivación es genérico. Por eso el manual se organiza de fuera hacia dentro: primero la **arquitectura**
y el **Actor**, luego los subsistemas que se le acoplan (categorías/habilidades, razas/reinos, profesiones, hechizos,
combate), después la **mecánica de tiradas**, y al final el **tratamiento de datos** (identidad por slug, importación,
migración) que mantiene todo consistente en el tiempo.

## Índice

1. [Visión general y arquitectura](#visión-general-y-arquitectura)
2. [El personaje: estadísticas y atributos derivados](#el-personaje-estadísticas-y-atributos-derivados)
3. [Categorías y habilidades: rangos, progresiones y bonos](#categorías-y-habilidades-rangos-progresiones-y-bonos)
4. [Razas y reinos de poder (realm)](#razas-y-reinos-de-poder-realm)
5. [Profesiones y paquetes de entrenamiento (training packages)](#profesiones-y-paquetes-de-entrenamiento-training-packages)
6. [Listas de hechizos (spell lists)](#listas-de-hechizos-spell-lists)
7. [Combate: tablas de ataque y el motor multidimensional](#combate-tablas-de-ataque-y-el-motor-multidimensional)
8. [Tiradas y mecánica d100 (actions)](#tiradas-y-mecánica-d100-actions)
9. [Datos, identidad (slug), importación y migración](#datos-identidad-slug-importación-y-migración)

---

## Visión general y arquitectura

RMF (RoleMaster de Fantasía) es un **system** no oficial para FoundryVTT v13.341 que implementa las mecánicas básicas de Rolemaster Fantasy (RMFT v4.0). Su manifiesto [system.json](system.json) lo declara con `id: "rmf"`, `version: "0.3.0"`, compatibilidad `minimum: "13.330"` / `verified: "13.341"` / `maximum: "13"`, un único módulo ES (`esmodules: ["rmf.mjs"]`) y una hoja de estilos (`styles: ["styles/system-styles.css"]`). No se distribuyen compendios empaquetados (`"packs": []`): el contenido del juego vive en un compendio de **mundo** (`world.basic-core`) que el GM puebla en tiempo de ejecución a partir de los JSON canónicos de [data/](data/) (ver más abajo "Flujo de contenido").

El manifiesto también fija tres decisiones de integración con el motor de Foundry que conviene tener presentes desde el principio:

- `"initiative": "1d100 + @stats.quickness"` — fórmula de iniciativa por defecto. El `@stats.quickness` se resuelve contra el `getRollData()` del actor (ver [data-models.mjs:78](module/data-models.mjs#L78)), que expone los totales de característica tanto por clave completa (`chQuickness`) como por forma corta (`quickness`/`qu`, derivada quitando el prefijo `ch` y pasando a minúsculas en [data-models.mjs:90](module/data-models.mjs#L90)). Esta fórmula es además **configurable** vía settings (ver "Settings").
- `"primaryTokenAttribute": "system.derivedStats.hitPoints"` y `"secondaryTokenAttribute": "system.derivedStats.powerPoints"` — conectan las barras del token con los Puntos de Vida (HP) y Puntos de Poder (PP) derivados. Esto es lo que hace que el token muestre HP/PP automáticamente; son rutas a datos **derivados**, no persistidos.
- `"grid"` en pies (`units: "ft"`, `distance: 5` ft por casilla, `diagonals: 0`), coherente con las unidades de Rolemaster.

### Alcance: contenido-definición frente a estado

El modelo de dominio se reparte entre **1 tipo de Actor** y **9 tipos de Item**. La clave para entender la arquitectura es distinguir dos roles:

- **Definición de contenido** (reglas del libro): items que describen *qué es* algo en Rolemaster (una raza, una habilidad, una categoría, una profesión, una lista de hechizos, una tabla de ataque…). Son reutilizables y viven en el compendio.
- **Estado del personaje**: el Actor `character` y los datos que solo tienen sentido sobre un personaje concreto (sus características, sus rangos comprados, su HP/PP actual).

El único Actor es:

| Tipo | DataModel | Rol | Representa |
|---|---|---|---|
| `character` | `CharacterData` ([character.mjs](module/data-models/character.mjs)) | Estado | El personaje jugador/PNJ: características (`chStats`), nivel (`chLevel`), trasfondo (`chBackground`) y todas las estadísticas derivadas (`derivedStats`: HP, PP, bono defensivo, resistencias). Es el contenedor de los items embebidos que definen su build. |

Los 9 tipos de Item (registrados en [rmf.mjs:80-90](rmf.mjs#L80)):

| Tipo | DataModel | Rol | Representa |
|---|---|---|---|
| `equipment` | `EquipmentData` ([equipment.mjs](module/data-models/equipment.mjs)) | Estado/objeto | Objeto físico: cantidad, peso, coste, carga (`encumbrance` derivada = `weight × quantity` en [equipment.mjs:40](module/data-models/equipment.mjs#L40)), rareza y flag `equipped`. |
| `race` | `RaceData` ([race.mjs](module/data-models/race.mjs)) | Definición | Una raza: bonos por característica, modificadores de resistencia, cadenas de progresión de Body/PP (`"0/6/4/2/1"`), rangos raciales otorgados, habilidades everyman/restricted y opciones de trasfondo. |
| `skill` | `SkillData` ([skill.mjs](module/data-models/skill.mjs)) | Definición + estado | Una habilidad. La *definición* (progresión, clasificación) viene del libro; el *estado* son los rangos comprados por nivel (`boughtByLevel`) cuando está embebida en un personaje. Deriva `totalBonus`. |
| `category` | `CategoryData` ([category.mjs](module/data-models/category.mjs)) | Definición + estado | Categoría de habilidad (agrupa skills). Igual dualidad que skill; su `totalBonus` lo consume cada skill embebida. |
| `realm` | `RealmData` ([realm.mjs](module/data-models/realm.mjs)) | Definición/elección | El reino mágico del personaje (Essence/Channeling/Mentalism) y las características que alimentan su Power Point Development. |
| `profession` | `ProfessionData` ([profession.mjs](module/data-models/profession.mjs)) | Definición | Una profesión: costes DP por categoría/hechizo, bonos profesionales y listas de habilidades everyman/occupational/restricted. |
| `trainingPackage` | `TrainingPackageData` ([training-package.mjs](module/data-models/training-package.mjs)) | Definición consumible | Paquete de adiestramiento: un lote de rangos de categoría/skill más entradas "Special" que se "compran" de golpe. Al soltarlo en un actor se aplica y se consume. |
| `spellList` | `SpellListData` ([spell-list.mjs](module/data-models/spell-list.mjs)) | Definición | Una lista de hechizos (p. ej. "Fire Law"): hasta 10 hechizos (uno por nivel 1-10) más metadatos de reino/tipo. |
| `attackTable` | `AttackTableData` ([attack-table.mjs](module/data-models/attack-table.mjs)) | Definición/tabla | Una tabla de ataque multidimensional: filas = bandas del total de tirada, columnas = Armor Type (AT 1-20), celdas = golpes + crítico ("12E"). |

**Por qué tantos items son "definición":** modelar las reglas de Rolemaster como items de Foundry (en vez de constantes en código) permite editarlas en sheets, versionarlas, traducirlas y, sobre todo, **arrastrarlas** sobre el personaje para componer su build. Es una arquitectura *data-driven*: el código de derivación es genérico y los números viven en datos.

### El patrón: ApplicationV2 + TypeDataModel (y por qué)

El sistema usa exclusivamente las APIs modernas de v13, evitando las V1 deprecadas.

**Documentos y esquemas — `TypeDataModel`.** Cada tipo de Item/Actor tiene una clase que extiende `foundry.abstract.TypeDataModel` (ver cabeceras de [character.mjs](module/data-models/character.mjs) y los demás). El esquema se declara con `foundry.data.fields` en `static defineSchema()`, y la lógica de derivación vive en `prepareDerivedData()` de cada modelo. Estos modelos se registran en el `init` hook mediante `CONFIG.Actor.dataModels` / `CONFIG.Item.dataModels` ([rmf.mjs:77-90](rmf.mjs#L77)):

```js
CONFIG.Actor.dataModels = { character: CharacterData };
CONFIG.Item.dataModels = {
  equipment: EquipmentData, race: RaceData, skill: SkillData,
  category: CategoryData, realm: RealmData, profession: ProfessionData,
  trainingPackage: TrainingPackageData, spellList: SpellListData,
  attackTable: AttackTableData
};
```

Desde v13 esto es el **reemplazo idiomático de [template.json](template.json)**. De hecho, el [template.json](template.json) de RMF es **vestigial**: su propio `_comment` lo dice, y solo conserva el mínimo que Foundry todavía consulta — la lista de `types` por documento y los `htmlFields` (campos que deben tratarse como HTML enriquecido: `chBackground.chDescription` en el actor; `description` y `racialAbilities` en items). Toda la forma real del dato vive en los `*.mjs`. La ventaja: validación tipada, valores por defecto, migración por campo y derivación encapsulada, en lugar de un JSON plano sin comportamiento.

**Clases de documento — extensiones delgadas.** `CONFIG.Actor.documentClass = RMFActor` y `CONFIG.Item.documentClass = RMFItem` ([rmf.mjs:70-71](rmf.mjs#L70)). Estas clases ([data-models.mjs](module/data-models.mjs)) son deliberadamente finas: `RMFItem` está vacío (`export class RMFItem extends Item {}` en [data-models.mjs:204](module/data-models.mjs#L204), solo existe como punto de enganche estable) y `RMFActor` solo añade lo que *no* pertenece a un `TypeDataModel`: orquestación del orden de derivación y métodos de comportamiento (`rollStat`, `applyDamage`, `getRollData`). El motivo de separar esquema (DataModel) de comportamiento (Document) es de diseño: mantiene los modelos puros y testeables y concentra los efectos secundarios (chat, rolls) en el documento.

**Sheets — ApplicationV2.** Las hojas usan `HandlebarsApplicationMixin(ActorSheetV2|ItemSheetV2)` y se registran con `foundry.applications.apps.DocumentSheetConfig.registerSheet` ([rmf.mjs:98-156](rmf.mjs#L98)). Cada tipo de item tiene su sheet especializada (`RMFRaceSheet`, `RMFSkillSheet`, …) registrada con su propio namespace (`"rmf-race"`, `"rmf-skill"`, …) y `makeDefault: true`. **Por qué no APIs V1:** las clases `ActorSheet`/`ItemSheet` y globales sin namespace (`mergeObject`) están deprecadas en v13; el proyecto las prohíbe explícitamente (ver CLAUDE.md) y usa los namespaces completos (`foundry.applications.*`, `foundry.utils.*`).

### Orquestación de la derivación en el Actor

El punto donde "todo se une" es `RMFActor.prepareDerivedData()` ([data-models.mjs:37](module/data-models.mjs#L37)). Foundry ya llama a `CharacterData.prepareDerivedData()` automáticamente; el override del documento añade la **orquestación de orden**, que importa porque hay dependencias entre items:

1. `CharacterData` deriva los bonos de característica y los atributos derivados base.
2. Cada `category` embebida re-deriva su `totalBonus` (ya ve los totales de `chStats` actualizados).
3. Cada `skill` embebida deriva su `totalBonus` (consume los totales de categoría → por eso categorías **antes** que skills).
4. `CharacterData.applySkillBasedDerivedStats()` sobreescribe HP/PP máximos a partir de las skills Body/Power Point Development.

```js
const categories = this.itemTypes?.category ?? [];
const skills     = this.itemTypes?.skill    ?? [];
for (const item of categories) item.prepareDerivedData?.();
for (const item of skills)     item.prepareDerivedData?.();
this.system?.applySkillBasedDerivedStats?.();
```

Nótese que en el paso 4 HP/PP se resuelven por la skill correspondiente, no por su nombre inglés: identificadas por `system.specialRole` (refactor Fase 0). Eso evita el fallo silencioso de poner HP/PP a 0 si se traduce o se teclea mal "Body Development".

### Identidad estable por slug (no por nombre)

Una decisión arquitectónica transversal (refactor Fase 0, ya en código — ver [refactor.md](refactor.md)) es que **los joins no se hacen por nombre de texto libre** sino por `system.slug`, un identificador estable e independiente del idioma. La fuente única es [module/utils/slug.mjs](module/utils/slug.mjs) (`slugify`, `matchesIdentity`, `buildSlugIndex`, `resolveFromIndex`, más `contentUid`, `identityKey`), un módulo puro sin dependencias de Foundry. El motivo: `name.trim().toLowerCase()` se rompía con acentos, el middot `·` de "Armor · Heavy", mayúsculas, traducción y typos (el bug real "Caving" vs "Caving (Spelunking)"). El slug se estampa sobre cualquier item creado a mano, arrastrado o copiado en el hook `preCreateItem` ([hooks.mjs:282](module/hooks.mjs#L282)) vía `buildIdentityBackfill`, **antes** de persistir el documento (`item.updateSource(...)`).

### Flujo de contenido

El contenido recorre cuatro etapas, de los JSON canónicos al personaje:

```
data/*.json  →  importers  →  compendio world.basic-core  →  arrastrar al actor  →  items embebidos
```

1. **`data/*.json`** ([data/](data/)): fuente de verdad de las reglas del libro — `categories.json`, `races.json`, `skills.json`, `realms.json`, `professions.json`, `training_packages.json`, las 9 listas de hechizos `*-lists.json` y las tablas de ataque en [data/attack-tables/](data/attack-tables). Cada entrada lleva su `slug` autorizado.
2. **Importers** ([module/importers.mjs](module/importers.mjs)): funciones `importX` y `syncXToCompendium` que el `ready` hook expone bajo `game.rmf.*` ([hooks.mjs:101-116](module/hooks.mjs#L101)). Crean los items en el compendio (o actualizan por slug en re-syncs). El `slug`/`specialRole` autorizado en el JSON se pasa tal cual (`authoredSlug`/`authoredSpecialRole`) para mantenerlo autoritativo entre re-syncs (que toman la ruta UPDATE y no disparan `preCreateItem`).
3. **Compendio `world.basic-core`**: compendio de mundo con carpetas (Categories, Races, Skills, Realms, Professions…). Es la biblioteca reutilizable de definiciones.
4. **Arrastrar al actor → items embebidos**: al soltar una definición sobre un personaje, **se clona** dentro del actor como Embedded Document. Algunos drops disparan lógica adicional vía hooks: un `realm` sincroniza el `statBonus` de la categoría Power Point Development ([hooks.mjs:296](module/hooks.mjs#L296)); un `trainingPackage` se aplica y consume ([hooks.mjs:310](module/hooks.mjs#L310)); una `profession` aplica sus bonos profesionales y registra los deltas en flags del actor para poder revertirlos al borrarla ([hooks.mjs:323](module/hooks.mjs#L323), [hooks.mjs:371](module/hooks.mjs#L371)).

Además, al **crear** un personaje, `#onCreateActor` ([hooks.mjs:165](module/hooks.mjs#L165)) le adjunta automáticamente desde `world.basic-core` todas las categorías de la carpeta "Categories" y las skills críticas (Body/Power Point Development, identificadas por `specialRole`), clonándolas como items embebidos. Esto garantiza que todo personaje nuevo pueda derivar HP/PP y tenga su matriz de categorías.

**Estado actual (importante):** hoy **todo se clona** en el actor — cada personaje arrastra copias completas de cada definición. Es la arquitectura que existe en `production`. El [refactor.md](refactor.md) (Fase 3) prevé separar definición/estado: las definiciones quedarían en compendios y el actor guardaría solo su estado por slug en `actor.system`, con bonos de profesión/raza **derivados** en vez de mutados. Este manual documenta lo que HAY hoy (clonado), no la meta futura.

### CONFIG.RMF y settings

En el `init` hook, tras registrar documentos y sheets, se inicializa el namespace de configuración `CONFIG.RMF` ([rmf.mjs:160](rmf.mjs#L160)). Es el espejo runtime de las constantes del sistema, para que helpers de Handlebars y otros consumidores no tengan que importar módulos:

- `version` — getter que lee `game.system?.version` (no se duplica la fuente de verdad de [system.json](system.json)).
- `debug` — espejo de la setting `debugMode`.
- `resistanceTypes`, `statShortToFull`, `skillClassifications` — mapeos compartidos por sheets y helpers (la fuente real está en [module/utils/constants.mjs](module/utils/constants.mjs) y [rank-bonus.mjs](module/utils/rank-bonus.mjs)).
- `itemTypes` / `actorTypes` — listas canónicas de tipos.
- `constants` — `RMF_CONSTANTS` (DEFAULT_STAT=35, HP_BASE=50, NO_SKILL_PENALTY=-15, etc.).
- `spellDescriptionKey` — la leyenda estática de reglas de hechizos (códigos especiales, tipos, áreas, duraciones). Es idéntica para todas las listas, así que **intencionadamente no se persiste** en cada `spellList`: se comparte vía `CONFIG.RMF`.

Las **settings** se registran en `_registerSystemSettings()` ([rmf.mjs:248](rmf.mjs#L248)):

| Setting | Scope | Tipo | Por defecto | Efecto |
|---|---|---|---|---|
| `debugMode` | world | Boolean | `false` | Su `onChange` actualiza `CONFIG.RMF.debug` y **carga/descarga dinámicamente** [module/debug.mjs](module/debug.mjs) (expone `globalThis.RMF_D` solo cuando está activo). |
| `initiativeFormula` | world | String | `"1d100 + @stats.quickness"` | Su `onChange` escribe `CONFIG.Combat.initiative.formula`. |
| `autoCalculateStats` | world | Boolean | `true` | Cálculo automático de derivadas. |
| `defaultRollMode` | client | String | `"publicroll"` | Modo de privacidad de tiradas por cliente (choices: public/gm/blind/self). |
| `ruleBooks` | world | Array | `["none"]` | Libros de reglas disponibles; el hook `renderSettingsConfig` ([hooks.mjs:463](module/hooks.mjs#L463)) sustituye el input de texto por checkboxes. |

Además se registran settings ocultas del framework de migración (`registerMigrationSettings`). En el `ready` hook, `_initializeReadyTimeConfigs` ([rmf.mjs:476](rmf.mjs#L476)) aplica `initiativeFormula` y `debugMode` desde las settings ya cargadas y ejecuta `runWorldMigration()` (no-op cuando las versiones coinciden; solo el GM ejecuta de facto, los players abortan en silencio).

### El árbol de [module/](module/)

```
module/
├── data-models.mjs          RMFActor / RMFItem (Documents delgados, orquestación + rolls)
├── data-models/             TypeDataModels (esquema + derivación) por tipo
│   ├── index.mjs            superficie única de importación
│   ├── _identity.mjs        slug/specialRole helpers de identidad
│   ├── _shared.mjs          utilidades compartidas entre modelos (totalBoughtRanks, …)
│   ├── character.mjs        Actor
│   └── {equipment,race,skill,category,realm,profession,
│         training-package,spell-list,attack-table}.mjs
├── hooks.mjs                RMFHooks: ciclo de vida (init/ready, create/update/delete, UI)
├── importers.mjs            importX / syncXToCompendium (data/*.json → world.basic-core)
├── migration.mjs            framework de migración + buildIdentityBackfill
├── debug.mjs                herramientas de consola (carga perezosa)
├── actions.mjs              RMFActions: acciones declarativas de las sheets (rolls, toggles)
├── profession-apply.mjs     aplicar/revertir profesión sobre el actor
├── training-package-apply.mjs  aplicar paquete de adiestramiento
├── *-sheet.js               sheets ApplicationV2 (actor + 9 items)
├── tables/                  motor desacoplado de tablas multidimensionales
│   ├── index.mjs           TablesAPI (game.rmf.tables)
│   ├── lookup.mjs          motor de búsqueda 2-D (ataque)
│   ├── attack-resolver.mjs resolución de ataque
│   ├── open-ended.mjs      d100 abierto por arriba/abajo
│   └── cell-parser.mjs     parseo de celda ("12E" → golpes + crítico)
└── utils/
    ├── constants.mjs        RMF_CONSTANTS, mapeos de stats, claves de hechizos
    ├── rank-bonus.mjs       bono de rango por niveles (tramos de progresión)
    ├── slug.mjs             identidad estable (slugify, matchesIdentity, índices)
    └── sheet-helpers.mjs    utilidades compartidas por sheets
```

**Por qué esta organización:** separa con claridad (a) *esquema y derivación* ([data-models/](module/data-models/)), (b) *comportamiento de documento* ([data-models.mjs](module/data-models.mjs)), (c) *ciclo de vida y reacciones a eventos* ([hooks.mjs](module/hooks.mjs)), (d) *ingesta de contenido* ([importers.mjs](module/importers.mjs)), (e) *presentación* (`*-sheet.js`) y (f) *motores puros reutilizables* ([tables/](module/tables/), [utils/](module/utils/)). El motor de tablas vive aislado en [module/tables/](module/tables/) y se expone como `game.rmf.tables` precisamente porque Foundry no tiene un documento de tabla 2-D nativo (no se usa `RollTable`): las tablas de ataque/crítico se modelan como `system` data del item y se resuelven con un motor desacoplado, decisión de diseño que mantiene la lógica de combate testeable y separada de la capa de documentos.

---

## El personaje: estadísticas y atributos derivados

El único tipo de `Actor` del sistema es `character`, y todo su estado vive en `actor.system`, gobernado por la clase `CharacterData` de [character.mjs](module/data-models/character.mjs). Esta clase extiende `foundry.abstract.TypeDataModel` (la API correcta de v13.341 para un modelo de datos ligado a un tipo de documento, no la deprecada `DataModel` suelta) y se registra en [rmf.mjs](rmf.mjs) mediante `CONFIG.Actor.dataModels.character = CharacterData`. El antiguo bloque `Actor.character` de `template.json` quedó vestigial: la forma del dato la define ahora `defineSchema()`, deliberadamente espejada de la disposición JSON heredada para que mundos existentes carguen sin migración ([character.mjs:8-9](module/data-models/character.mjs#L8)).

La derivación de un personaje es un proceso en tres fases orquestado por la subclase `RMFActor` de [data-models.mjs](module/data-models.mjs); el orden importa y se explica al final. Antes, hay que entender la forma de cada dato.

### Las 10 estadísticas (`chStats`): persistido vs derivado

Las diez características primarias de Rolemaster se construyen en el orden canónico recorriendo `STAT_KEYS_FULL` ([character.mjs:61-63](module/data-models/character.mjs#L61)). Esa lista sale de `STAT_SHORT_TO_FULL` en [constants.mjs:19-30](module/utils/constants.mjs#L19), que es la única fuente de verdad del mapeo clave-corta→clave-completa; `STAT_KEYS_FULL` no es más que `Object.values(STAT_SHORT_TO_FULL)` ([constants.mjs:43](module/utils/constants.mjs#L43)):

| Corta | Completa | Característica RM |
|------|----------|------------------|
| `ag` | `chAgility` | Agility |
| `co` | `chConstitution` | Constitution |
| `me` | `chMemory` | Memory |
| `re` | `chReasoning` | Reasoning |
| `sd` | `chSelfDiscipline` | Self Discipline |
| `em` | `chEmpathy` | Empathy |
| `in` | `chIntuition` | Intuition |
| `pr` | `chPresence` | Presence |
| `qu` | `chQuickness` | Quickness |
| `st` | `chStrength` | Strength |

Cada estadística es un `SchemaField` idéntico, fabricado por el helper `statBlockField()` ([character.mjs:25-36](module/data-models/character.mjs#L25)). Tiene seis campos numéricos enteros, pero solo algunos son datos reales; el resto son cachés:

| Campo | Inicial | Naturaleza | Qué significa |
|-------|---------|-----------|----------------|
| `temp` | `35` (`DEFAULT_STAT`) | **Persistido (input)** | Valor temporal actual de la estadística (1..101+). Es lo que el jugador edita. |
| `pot` | `35` (`DEFAULT_STAT`) | **Persistido (input)** | Valor potencial (máximo al que puede subir por entrenamiento). No interviene en ningún cálculo derivado aquí; existe como dato de hoja. |
| `basic` | `0` | **Derivado (cache)** | Bono básico que la tabla RM asigna a `temp`. Se recalcula en cada `prepareDerivedData`. |
| `race` | `0` | **Persistido (input)** | Modificador racial a esa estadística (lo aporta la raza del personaje). |
| `spec` | `0` | **Persistido (input)** | Modificador especial/circunstancial (bonos varios, objetos, etc.). |
| `total` | `0` | **Derivado (cache)** | `basic + race + spec`. Recalculado siempre. |

El comentario del helper lo dice explícitamente: `temp/pot/basic/race/spec/total` se persisten para que los mundos viejos carguen sin tocar, pero `basic`, `total` y `bonus` "survive in the DB only as snapshots" — se recalculan en `prepareDerivedData()` ([character.mjs:21-23](module/data-models/character.mjs#L21)). Esto es una decisión de diseño deliberada: el esquema persiste campos derivados (lo que normalmente se evita) **únicamente** por compatibilidad binaria con el JSON heredado; su valor real lo fija siempre la derivación, no el disco.

Hay un séptimo "campo", `bonus`, que **no está en el esquema**: se inyecta en tiempo de ejecución dentro de `#calculateStatBonuses` ([character.mjs:134](module/data-models/character.mjs#L134)) como alias de `total`. Al no declararse en `defineSchema`, no se persiste ni se valida; es un campo puramente de runtime para que hojas y fórmulas tengan un nombre semántico ("el bono que sumas a la tirada"). Lo mismo ocurre con dos flags solo-UI, `hasModifiers` y `totalModifier` ([character.mjs:135-136](module/data-models/character.mjs#L135)), que evitan recalcular en Handlebars si una estadística lleva modificadores raciales/especiales.

#### Fase 1 — `#calculateStatBonuses()`: de `temp` a bono

```js
stat.basic = CharacterData.#bonusFromStatValue(Number(stat.temp) || 0);
stat.total = stat.basic + (stat.race || 0) + (stat.spec || 0);
stat.bonus = stat.total;
```

La fórmula de `total` modela la regla de Rolemaster: el bono efectivo de una estadística es **bono por valor + modificador racial + modificadores especiales**. Cada término tiene origen distinto: `basic` se deriva del `temp` editable del jugador, `race` lo estampa la raza, `spec` lo aporta cualquier otra fuente. El `Number(...) || 0` y los `|| 0` son defensivos frente a datos importados sucios.

#### La tabla valor→bono básico (`#bonusFromStatValue`)

Es la conversión canónica de Rolemaster de valor de estadística (1..101+) a su "stat bonus". Es una función pura y estática ([character.mjs:256-280](module/data-models/character.mjs#L256)), lo que la hace testeable y reutilizable sin instanciar un actor (sustituyó a un método privado `_calculateBonus` que vivía en `RMFActor`). El rango de salida es −10..+14:

| Valor (`temp`) | Bono |
|----------------|------|
| ≥ 102 | +14 |
| 101 | +12 |
| 100 | +10 |
| 98–99 | +9 |
| 96–97 | +8 |
| 94–95 | +7 |
| 92–93 | +6 |
| 90–91 | +5 |
| 85–89 | +4 |
| 80–84 | +3 |
| 75–79 | +2 |
| 70–74 | +1 |
| 31–69 | 0 |
| 26–30 | −1 |
| 21–25 | −2 |
| 16–20 | −3 |
| 11–15 | −4 |
| 10 | −5 |
| 8–9 | −6 |
| 6–7 | −7 |
| 4–5 | −8 |
| 2–3 | −9 |
| 1 (resto) | −10 |

Nótese que 100, 101 y "≥102" son tres tramos discretos (regla del libro: pasar de 100 a 101 y a 102+ da saltos no lineales de bono, +10/+12/+14). El `if (v >= 31) return 0` cubre la franja media plana (31–69) donde Rolemaster no da bono.

### Los atributos secundarios derivados (`derivedStats`)

`defineSchema` declara un sub-esquema `derivedStats` con tres bloques ([character.mjs:65-87](module/data-models/character.mjs#L65)): `hitPoints`, `powerPoints` y `resistances`. Igual que en `chStats`, varios de sus campos son cachés recalculados en cada derivación; se persisten para compatibilidad y para conservar el estado de daño (ver `value`). La fase 2, `#calculateSecondaryAttributes()` ([character.mjs:148-206](module/data-models/character.mjs#L148)), los rellena.

#### Hit Points

```
max = HP_BASE(50) + CO.total + floor(SD.total / 2)
```

- `HP_BASE = 50` viene de `RMF_CONSTANTS.HP_BASE` ([constants.mjs:87](module/utils/constants.mjs#L87)); es el pool base antes de modificadores. Se guarda desglosado en `hitPoints.base`.
- `CO.total` es el `total` (bono) de `chConstitution` — la Constitución es la fuente principal de PV en RM. Se guarda en `hitPoints.constitution`.
- `floor(SD.total/2)` es la mitad (truncada) del bono de Self Discipline; en RM la autodisciplina contribuye a la resistencia física a media tasa. Se guarda en `hitPoints.selfDiscipline` ([character.mjs:156-167](module/data-models/character.mjs#L156)).

El `Math.floor` modela el redondeo hacia abajo del libro al partir el bono de SD.

#### Power Points

```
max = EM.total + IN.total + PR.total
```

La suma de los bonos de Empathy, Intuition y Presence ([character.mjs:170-180](module/data-models/character.mjs#L170)). Las tres son las estadísticas de los tres reinos de poder (Esencia/Canalización/Mentalismo), y su suma es el pool de puntos de poder base. Cada sumando se cachea por separado en `powerPoints.{empathy,intuition,presence}`.

#### El reclamp de `value` y por qué preserva el daño

Tanto HP como PP tienen un par `max`/`value`: `max` es el tope derivado, `value` es lo que queda tras gastar/encajar daño. Cuando cambia una estadística, `max` cambia, pero el daño previo debe sobrevivir:

```js
const previousHPValue = Number(ds.hitPoints?.value);
ds.hitPoints.value = Number.isFinite(previousHPValue)
  ? Math.max(0, Math.min(previousHPValue, maxHP))
  : maxHP;
```

Se lee el `value` anterior **antes** de tocar nada ([character.mjs:152-153](module/data-models/character.mjs#L152)) y se reproyecta a `[0, max]`. Si había 30/50 PV y la Constitución sube el `max` a 55, el `value` sigue siendo 30 (no se "cura" al subir el techo); si el `max` baja por debajo del `value` actual, se recorta al nuevo techo. El `Number.isFinite` actúa como red de seguridad: si por cualquier razón el `value` previo no fuese un número finito (dato corrupto), arranca a tope; en la práctica el esquema inicializa `value` con un valor finito (`HP_BASE` para HP, `0` para PP), así que la rama habitual es siempre el reclamp. Esta es una decisión de diseño explícita comentada en [character.mjs:140-147](module/data-models/character.mjs#L140): la derivación nunca debe regenerar al personaje como efecto colateral de recalcular su máximo.

#### Resistencias

```
essence    = floor(EM.total * 3) + raza.ess
channeling = floor(IN.total * 3) + raza.chan
mentalism  = floor(PR.total * 3) + raza.ment
poison     = floor(CO.total * 3) + raza.pois
disease    = floor(CO.total * 3) + raza.dis
```

El multiplicador `3` es `RMF_CONSTANTS.RESISTANCE_MULTIPLIER` ([constants.mjs:96](module/utils/constants.mjs#L96)). Cada Resistance Roll en RM parte del triple del bono de la estadística que rige ese reino: Empathy→Esencia, Intuition→Canalización, Presence→Mentalismo; y Constitución rige tanto Veneno como Enfermedad (de ahí que `poison` y `disease` compartan `CO.total*3`) ([character.mjs:183-188](module/data-models/character.mjs#L183)).

Encima de ese valor base se suman los **modificadores raciales** ([character.mjs:190-200](module/data-models/character.mjs#L190)). Se leen del único item de tipo `race` del actor (`this.parent?.itemTypes?.race?.[0]`) bajo `system.resistances`, que usa las claves cortas `ess/chan/ment/pois/dis` definidas como `RESIST_SHORT_KEYS` en [race.mjs:18](module/data-models/race.mjs#L18). El acceso va envuelto en `try/catch` con `console.warn`: si la raza está mal formada, las resistencias base ya están calculadas y el personaje no se rompe. Este es el punto donde la estadística del personaje "se une" a su item de raza durante la derivación.

`this.parent` es el documento `Actor` propietario del `CharacterData`; por eso el modelo puede alcanzar los items embebidos del actor.

#### Bono defensivo

```
defensiveBonus = QU.total * 3 − armorPenalty
```

El `3` es `RMF_CONSTANTS.DEFENSIVE_MULTIPLIER` ([constants.mjs:99](module/utils/constants.mjs#L99)). El Defensive Bonus de Rolemaster es el triple del bono de Quickness ([character.mjs:202-205](module/data-models/character.mjs#L202)). El `armorPenalty` se fija a `0` aquí y se resta; es un campo de runtime (no está en el esquema, igual que `defensiveBonus`) reservado como gancho para una penalización por armadura que aún no está implementada — hoy siempre es 0, dejando `defensiveBonus = QU.total*3`.

### Los campos de identidad de cabecera

`defineSchema` declara, además de `chStats`/`derivedStats`, los campos escalares de la ficha ([character.mjs:89-98](module/data-models/character.mjs#L89)):

| Campo | Tipo | Notas |
|-------|------|-------|
| `chLevel` | entero `[0, 99]`, inicial 1 | Nivel del personaje. Lo consume el cálculo de bono de rango y `getRollData` lo expone como `@level`. |
| `chProfession` | string | Nombre de la profesión (dato de cabecera; el item `profession` es la fuente mecánica real). |
| `chRace` | string | Nombre de la raza de cabecera. |
| `chRealm` | string | Reino de poder del personaje. |
| `chExperience` | entero `≥ 0` | Puntos de experiencia. |
| `chBackground` | `SchemaField` | 8 strings cortos (nacionalidad, hogar, deidad, patrón, padres, cónyuge, hijos, otros) + `chDescription` como `HTMLField` para texto enriquecido ([character.mjs:47-57](module/data-models/character.mjs#L47)). |

Los strings `chRace`/`chProfession`/`chRealm` son etiquetas de cabecera; tras el refactor de identidad (Fase 0) las uniones mecánicas reales con los items de contenido no se hacen por estos nombres sino vía `slug`/`specialRole` (ver el override de HP/PP más abajo y `_identity.mjs`).

### El override por skills y por qué corre DESPUÉS de los items

`#calculateSecondaryAttributes` calcula HP/PP máximos **a partir de estadísticas**, pero en Rolemaster los máximos reales los fijan dos habilidades de desarrollo: **Body Development** (PV) y **Power Point Development** (PP). Su `totalBonus` (rangos acumulados según la progresión racial) sustituye al cálculo basado en estadística. Eso lo hace `applySkillBasedDerivedStats()` ([character.mjs:218-247](module/data-models/character.mjs#L218)):

```js
const max = bonusOfRole("bodyDevelopment");   // o "powerPointDevelopment"
ds.hitPoints.max = max;
ds.hitPoints.value = Number.isFinite(prev) ? Math.max(0, Math.min(prev, max)) : Math.max(0, max);
```

Dos detalles clave:

1. **Identificación por `specialRole`, no por nombre.** El skill correcto se localiza con `resolveSpecialRole(s.system?.specialRole, s.name) === role` ([character.mjs:227](module/data-models/character.mjs#L227)). `resolveSpecialRole` ([_identity.mjs:83-85](module/data-models/_identity.mjs#L83)) prefiere la etiqueta interna `specialRole` (`bodyDevelopment`/`powerPointDevelopment`) y solo cae al nombre inglés (vía `specialRoleFromName`) si la etiqueta no está migrada (`none`). Esto es deliberado: enganchar por el nombre "Body Development" se rompería con una traducción o una errata; la etiqueta es estable e independiente del idioma. Los roles válidos son `["none","bodyDevelopment","powerPointDevelopment"]` (`SPECIAL_ROLES`, [_identity.mjs:43](module/data-models/_identity.mjs#L43)).

2. **El reclamp de `value` se repite** con la misma lógica `[0, max]`, de nuevo para no curar/vaciar al personaje al recalcular el techo. El método es **idempotente** (seguro de llamar varias veces).

#### El orden de derivación: actor → items → override

La razón de que este override corra al final la fija la orquestación de `RMFActor.prepareDerivedData()` ([data-models.mjs:37-53](module/data-models.mjs#L37)). Foundry llama automáticamente a `system.prepareDerivedData()` (fases 1 y 2 del `CharacterData`), pero `RMFActor` añade una capa por encima en este orden estricto:

1. `super.prepareDerivedData()` dispara `CharacterData.prepareDerivedData()` → `#calculateStatBonuses` + `#calculateSecondaryAttributes`. Los `chStats.total` y los HP/PP **basados en estadística** quedan listos.
2. Se re-derivan los items `category` y luego los `skill` ([data-models.mjs:48-49](module/data-models.mjs#L48)). El orden categorías→skills es obligatorio porque el `totalBonus` de un skill depende del total de su categoría. Y se re-derivan **aquí** (aunque Foundry ya los preparó una vez) para que vean los `chStats.total` recién calculados en el paso 1.
3. `this.system?.applySkillBasedDerivedStats()` ([data-models.mjs:52](module/data-models.mjs#L52)) machaca `hitPoints.max`/`powerPoints.max` con el `totalBonus` de los skills de desarrollo.

El override **debe** ir tras el paso 2 porque lee `skill.system.totalBonus`, que no existe hasta que los skills se han derivado. Esta es la dependencia que justifica todo el orden: estadísticas primero (las necesitan los items), items después (necesitan las estadísticas), y override de HP/PP al final (necesita los items ya calculados). El comentario en [character.mjs:215-217](module/data-models/character.mjs#L215) y [character.mjs:116-117](module/data-models/character.mjs#L116) documenta exactamente esta razón.

### Salida hacia fórmulas y tiradas

Una vez derivado, `RMFActor.getRollData()` ([data-models.mjs:78-118](module/data-models.mjs#L78)) expone el estado para fórmulas de usuario: cada estadística bajo su clave completa `@stats.chXxx` y, además, una clave de conveniencia obtenida con `key.replace("ch", "").toLowerCase()` ([data-models.mjs:90](module/data-models.mjs#L90)) — para `chQuickness` el alias es `@stats.quickness` (la palabra completa en minúsculas, **no** la clave corta `qu`). También expone `@hp`, `@pp`, `@db`, `@armorPenalty`, `@res.<reino>` (alias `@resistances.<reino>`) y `@level`. Así un macro puede escribir `1d100 + @db`, `1d100 + @res.poison` o `1d100 + @stats.quickness` y leer los valores ya derivados por todo lo anterior.

---

## Categorías y habilidades: rangos, progresiones y bonos

Las categorías (`category`) y las habilidades (`skill`) son el motor de bonificaciones del personaje. En Rolemaster Fantasy un personaje no tira "una habilidad" en abstracto: tira un d100 abierto y le suma un **bono total** que se compone de cuántos rangos ha comprado, el bono de su categoría padre, el bono de característica, y modificadores varios. Estos dos `Item types` modelan exactamente esa cadena, y comparten casi toda su maquinaria: una tabla de cuatro tramos en [rank-bonus.mjs](module/utils/rank-bonus.mjs), un almacén de rangos por nivel (`boughtByLevel`), y una derivación que se ejecuta en cada `prepareDerivedData`.

La diferencia conceptual es jerárquica: la **categoría** agrupa habilidades afines (p. ej. "Weapon", "Lore", "Body Development") y aporta un bono base compartido; la **habilidad** es la destreza concreta que se tira y hereda ese bono de categoría. En RMF esto es la distinción "skill category" vs. "skill" del propio libro.

### El almacén de rangos: `boughtByLevel` como `ObjectField`

Ambos modelos persisten los rangos comprados en un único campo, declarado idénticamente en [category.mjs:101](module/data-models/category.mjs#L101) y [skill.mjs:55](module/data-models/skill.mjs#L55):

```js
boughtByLevel: new fields.ObjectField({ required: true, nullable: false, initial: () => ({}) })
```

#### Forma del dato y por qué un `ObjectField`

`boughtByLevel` es un objeto cuyas **claves son números de nivel en forma de string** y cuyos **valores son la cantidad de rangos comprados en ese nivel**. Por ejemplo:

```json
{ "0": 6, "1": 2, "2": 2, "3": 1 }
```

significa: 6 rangos raciales (clave `"0"`), 2 rangos comprados al nivel 1, 2 al nivel 2, 1 al nivel 3.

La clave `"0"` está **reservada** para los rangos raciales otorgados en la creación del personaje. Esto es una decisión de diseño deliberada y está documentada en [category.mjs:98-100](module/data-models/category.mjs#L98) ("`0` is reserved for racial ranks granted at character creation"). En RMF el personaje recibe rangos gratuitos de su raza/cultura antes de gastar puntos de desarrollo (DP); modelarlos como "comprados al nivel 0" permite sumarlos exactamente igual que cualquier otro rango sin un campo aparte para skills.

La elección de un `ObjectField` (en lugar de, por ejemplo, un `ArrayField` o un `SchemaField` con campos fijos `level1`, `level2`…) responde a que **las claves son dinámicas**: el número de niveles no se conoce de antemano (un personaje puede llegar al nivel 30 o más). Un `SchemaField` exigiría declarar de antemano cada nivel posible; un `ArrayField` indexado por posición rompería al insertar/saltar niveles. El `ObjectField` persiste un mapa nivel→rangos arbitrario y deja la validación de los valores al sumador. El comentario en [category.mjs:99-100](module/data-models/category.mjs#L99) lo dice explícitamente: "We persist as a plain ObjectField because the keys are dynamic (level numbers)".

#### Suma de rangos: `totalBoughtRanks`

La suma es un helper puro compartido en [_shared.mjs:15-21](module/data-models/_shared.mjs#L15):

```js
export function totalBoughtRanks(boughtByLevel) {
  if (!boughtByLevel || typeof boughtByLevel !== "object") return 0;
  return Object.values(boughtByLevel).reduce(
    (sum, val) => sum + (Number(val) || 0),
    0
  );
}
```

Observa que **suma todos los valores indiscriminadamente**, incluido el de la clave `"0"`. Por eso los rangos raciales no necesitan tratamiento especial: ya están dentro de `boughtByLevel`. La coerción `Number(val) || 0` es defensiva: cualquier entrada no numérica o `NaN` cuenta como 0, lo que protege contra datos importados malformados (un `ObjectField` no valida los tipos de sus valores). Es una función pura sin dependencias de Foundry, lo que la hace trivialmente testeable.

#### `totalRanks`: categoría suma `freeRanks`, habilidad no

Aquí los dos modelos divergen en una línea. La **categoría** tiene además un campo escalar `freeRanks` ([category.mjs:103](module/data-models/category.mjs#L103)) y su total es:

```js
// category.mjs:179
const totalRanks = totalBoughtRanks(this.boughtByLevel) + (this.freeRanks || 0);
```

La **habilidad** no tiene `freeRanks`; su total es directamente la suma del almacén ([skill.mjs:109-112](module/data-models/skill.mjs#L109)):

```js
const totalBought = totalBoughtRanks(this.boughtByLevel);
// Skills don't have freeRanks today; racial ranks are stored under
// boughtByLevel.0, so they're already accounted for.
const totalRanks = totalBought;
```

El comentario explica por qué la habilidad no necesita `freeRanks`: sus rangos raciales viven en `boughtByLevel.0`. La categoría mantiene `freeRanks` como un canal separado para rangos "gratis" que no proceden de una compra por nivel concreto (decisión de diseño, no una regla del libro: la fórmula `(this.freeRanks || 0)` simplemente añade un sumando extra al total de rangos de categoría).

### El modelo de cuatro tramos y las tablas de bono por rango

El cálculo del **bono por rango** es el corazón compartido, y vive aislado en [rank-bonus.mjs](module/utils/rank-bonus.mjs) como "single source of truth" — las sheets y los data models lo importan, nunca lo reimplementan ([rank-bonus.mjs:12-15](module/utils/rank-bonus.mjs#L12)).

#### Por qué cuatro tramos

Rolemaster aplica **rendimiento decreciente** a los rangos: los primeros rangos de una habilidad valen mucho, y a partir de cierto número cada rango adicional aporta menos. El sistema modela esto con cuatro tramos de 10 rangos cada uno, definidos en `TIER_RANGES` ([rank-bonus.mjs:19-24](module/utils/rank-bonus.mjs#L19)):

| Tramo | Rangos | Constante |
|-------|--------|-----------|
| `tier1` | 1–10 | bono alto por rango |
| `tier2` | 11–20 | bono medio |
| `tier3` | 21–30 | bono bajo |
| `tier4` | 31–99 | bono mínimo |

Además existe un valor especial `zero` para **cero rangos**, que es una penalización (ver más abajo). Cada tabla guarda el bono *por rango* que aporta cada tramo.

#### Las tablas exactas

[rank-bonus.mjs:26-39](module/utils/rank-bonus.mjs#L26) define las tablas con sus números reales:

```js
const RANK_BONUS_TABLES = Object.freeze({
  category: Object.freeze({
    standard:    Object.freeze({ zero: -15, tier1: 2, tier2: 1, tier3: 0.5, tier4: 0 }),
    nonstandard: Object.freeze({ zero: 0,   tier1: 0, tier2: 0, tier3: 0,   tier4: 0 })
  }),
  skill: Object.freeze({
    standard: Object.freeze({ zero: -15, tier1: 3, tier2: 2, tier3: 1,   tier4: 0.5 }),
    combined: Object.freeze({ zero: -30, tier1: 5, tier2: 3, tier3: 1.5, tier4: 0.5 }),
    limited:  Object.freeze({ zero: 0,   tier1: 1, tier2: 1, tier3: 0.5, tier4: 0 }),
    special:  Object.freeze({ zero: 0,   tier1: 0, tier2: 0, tier3: 0,   tier4: 0 })
  })
});
```

Interpretación de cada progresión (todas son las progresiones estándar de la Tabla de Desarrollo de Habilidades de RMF):

**Categorías:**
- **`standard`**: `-15` sin rangos; `+2/rango` en los primeros 10, `+1/rango` en los siguientes 10, `+0.5/rango` en los terceros 10, `0` a partir de 31. Es la progresión por defecto de una categoría que aporta bono.
- **`nonstandard`**: todo a 0. Modela categorías que **no aportan bono base** (el bono lo da entero la habilidad); también es donde caen, por normalización, las categorías marcadas como "no aplicable".

**Habilidades:**
- **`standard`**: `-15` sin rangos; `+3/+2/+1/+0.5` por tramo. La progresión más común.
- **`combined`**: `-30` sin rangos; `+5/+3/+1.5/+0.5`. Habilidades que combinan en sí varias destrezas; suben más rápido pero penalizan más fuerte si no se entrenan. El `-30` es el doble del `-15` habitual.
- **`limited`**: `0` sin rangos; `+1/+1/+0.5/0`. Habilidades "lentas" o de techo bajo: no penalizan por no entrenarse y suben poco.
- **`special`**: tabla de respaldo a 0. **No se usa tal cual**: es la progresión de Body Development y Power Point Development, cuya tabla real se inyecta como *override* desde la raza (ver más adelante).

Las tablas están profundamente congeladas con `Object.freeze` para que cualquier mutación accidental falle de inmediato — son la fuente de verdad absoluta del sistema. Las listas de claves se exportan además como `CATEGORY_PROGRESSIONS` y `SKILL_PROGRESSIONS` ([rank-bonus.mjs:41-42](module/utils/rank-bonus.mjs#L41)), derivadas de las propias claves de las tablas para que el conjunto válido de progresiones nunca se desincronice de las tablas.

#### El conteo por tramos: `_tierCounts`

Dado un total de rangos, [rank-bonus.mjs:111-120](module/utils/rank-bonus.mjs#L111) reparte cuántos caen en cada tramo:

```js
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
```

Cada tramo cuenta como máximo 10 rangos, salvo `t4` que admite hasta 69 (de 31 a 99 inclusive, el techo del sistema). El `Math.max(ranks - N, 0)` evita contar tramos que aún no se han alcanzado. Ejemplo: con 25 rangos → `t1=10, t2=10, t3=5, t4=0`.

#### El cálculo final: `_computeFromTable`

[rank-bonus.mjs:122-127](module/utils/rank-bonus.mjs#L122):

```js
function _computeFromTable(totalRanks, table) {
  if (!table) return 0;
  const { ranks, t1, t2, t3, t4 } = _tierCounts(totalRanks);
  if (ranks === 0) return table.zero;
  return (t1 * table.tier1) + (t2 * table.tier2) + (t3 * table.tier3) + (t4 * table.tier4);
}
```

La fórmula completa del bono por rango es:

```
si rangos == 0:  bono = table.zero
en otro caso:    bono = t1·tier1 + t2·tier2 + t3·tier3 + t4·tier4
```

**Ejemplo trabajado** — una habilidad `standard` con 25 rangos:

```
t1=10, t2=10, t3=5, t4=0
bono = 10·3 + 10·2 + 5·1 + 0·0.5 = 30 + 20 + 5 + 0 = 55
```

Los wrappers públicos son `computeCategoryRankBonus` ([rank-bonus.mjs:141-144](module/utils/rank-bonus.mjs#L141)) y `computeSkillRankBonus` ([rank-bonus.mjs:146-150](module/utils/rank-bonus.mjs#L146)). El primero selecciona la tabla de categoría por la progresión normalizada; el segundo acepta además un `overrideTable` opcional:

```js
export function computeSkillRankBonus(totalRanks, progression, overrideTable) {
  const key = normalizeSkillProgression(progression);
  const table = _isValidTable(overrideTable) ? overrideTable : RANK_BONUS_TABLES.skill[key];
  return _computeFromTable(totalRanks, table);
}
```

`_isValidTable` ([rank-bonus.mjs:106-109](module/utils/rank-bonus.mjs#L106)) acepta el override solo si sus cinco claves (`zero`, `tier1..tier4`) son numéricas (vía `Number.isFinite(Number(...))`); en caso contrario cae a la tabla estándar por nombre. Esto hace que el override sea seguro frente a datos de raza incompletos.

#### El valor en 0 rangos: la penalización por no entrenar

El `zero` de las tablas modela una regla central de RMF: **usar una habilidad sin entrenamiento penaliza**. Un personaje sin rangos en una habilidad `standard` o en una categoría `standard` arrastra `-15`; en una `combined`, `-30`. No es que "no haya bono": es un castigo activo, lo que refleja que improvisar una destreza que nunca has practicado es peor que no tener bono.

Las progresiones `limited`, `special` y `nonstandard` tienen `zero: 0` porque conceptualmente no penalizan la falta de entrenamiento (son habilidades de uso casual o mecánicas que no se "fallan por inexperiencia").

### Normalización de progresiones

Los strings de progresión se sanean antes de indexar las tablas, lo que permite cargar mundos viejos con valores heredados. [rank-bonus.mjs:78-83](module/utils/rank-bonus.mjs#L78) y [rank-bonus.mjs:92-98](module/utils/rank-bonus.mjs#L92):

- **Categoría** (`normalizeCategoryProgression`): los valores `notApplicable`/`not-applicable`/`na`/`none`/`other` colapsan a `nonstandard`; cualquier string desconocido cae a `standard`.
- **Habilidad** (`normalizeSkillProgression`): el legado `slow` mapea a `limited`, `fast` a `combined`; lo desconocido cae a `standard`.

Ambas funciones normalizan a minúsculas con `String(value ?? "").trim().toLowerCase()` antes de comparar, de modo que la indexación de tablas es insensible a mayúsculas. Esto centraliza las migraciones de vocabulario en un solo sitio y evita que un valor inesperado seleccione una tabla `undefined`.

### Composición del bono total de la categoría

La categoría deriva todos sus totales en `prepareDerivedData` ([category.mjs:157-198](module/data-models/category.mjs#L157)). La fórmula del bono total es ([category.mjs:193-194](module/data-models/category.mjs#L193)):

```
category.totalBonus = totalRankBonus + totalStatsBonus + profBonus + spec1Bonus + spec2Bonus
```

Donde:
- **`totalRankBonus`** = `computeCategoryRankBonus(totalRanks, progression)` — el bono por rango calculado arriba.
- **`totalStatsBonus`** = suma de los `.total` de hasta tres características del actor (`stat1`, `stat2`, `stat3`), vía `sumActorStatTotals` ([_shared.mjs:45-58](module/data-models/_shared.mjs#L45)).
- **`profBonus`**, **`spec1Bonus`**, **`spec2Bonus`** = modificadores persistidos manualmente (bono profesional, dos slots de especialización/varios), sumados con guardas `|| 0`.

#### El bono de característica: `statBonus` y `sumActorStatTotals`

Cada categoría declara tres slots de característica en su esquema, con defaults razonables ([category.mjs:111-115](module/data-models/category.mjs#L111)):

```js
statBonus: new fields.SchemaField({
  stat1: str("chAgility"),
  stat2: str("chConstitution"),
  stat3: str("chSelfDiscipline")
})
```

En RMF el bono de característica de una habilidad es la **suma** de los bonos de varias características (típicamente tres). `sumActorStatTotals` recorre esos tres keys, normaliza cada uno con `normalizeStatKey` (acepta tanto `ag` como `chAgility`, [_shared.mjs:30-34](module/data-models/_shared.mjs#L30)), lee `actor.system.chStats[norm]` y suma su `.total`:

```js
const stat = stats[norm];
if (stat && Number.isFinite(stat.total)) sum += stat.total;
```

Si el item **no está asignado a un actor** (una categoría que vive en el compendio del mundo), `actor.documentName !== "Actor"` y la función devuelve 0 ([_shared.mjs:46-47](module/data-models/_shared.mjs#L46)). Lo mismo ocurre si el actor no tiene `system.chStats` ([_shared.mjs:48-49](module/data-models/_shared.mjs#L48)). Esto es deliberado: el bono de característica solo tiene sentido cuando hay un personaje detrás.

#### Caso especial: herencia de características desde el Realm (Power Point Development)

Antes de calcular nada, la categoría comprueba si es la categoría de **desarrollo de puntos de poder** ([category.mjs:165-177](module/data-models/category.mjs#L165)):

```js
const role = resolveSpecialRole(this.specialRole, item?.name);
if (role === "powerPointDevelopment") {
  const actor = item.parent;
  const realmItem = actor?.documentName === "Actor"
    ? actor.itemTypes?.realm?.[0]
    : null;
  const rb = realmItem?.system?.statBonus;
  if (rb && typeof rb === "object") {
    this.statBonus.stat1 = ...; this.statBonus.stat2 = ...; this.statBonus.stat3 = ...;
  }
}
```

Los PP de un lanzador dependen de la característica de su **reino**. En vez de codificar esa relación en la categoría, se **heredan los tres slots de `statBonus` del item `realm`** asignado al actor. Cada asignación es defensiva: `this.statBonus.statN = typeof rb.statN === "string" ? rb.statN : ""` ([category.mjs:173-175](module/data-models/category.mjs#L173)), de modo que un slot no-string del reino se neutraliza a cadena vacía. La detección **no es por nombre inglés** ("Power Point Development") sino por el tag interno `specialRole` (ver siguiente apartado), con `resolveSpecialRole` cayendo al nombre solo como respaldo. Esto sobrevive a la traducción de la ficha.

### Composición del bono total de la habilidad

La habilidad deriva en [skill.mjs:103-143](module/data-models/skill.mjs#L103). Su fórmula es ([skill.mjs:132-133](module/data-models/skill.mjs#L132)):

```
skill.totalBonus = rankBonus + categoryBonus + profBonus + spec1Bonus + spec2Bonus
```

La diferencia clave frente a la categoría: la habilidad **no calcula su propio bono de característica**; en su lugar **hereda el `totalBonus` completo de su categoría padre** (que ya incluye el bono de característica de la categoría). Esto evita doble contabilidad y refleja la estructura RMF: el bono de característica se aplica a nivel de categoría y todas sus habilidades lo comparten.

#### Cómo la habilidad resuelve su categoría: identidad por slug

La habilidad guarda una referencia a su categoría como **string libre** ([skill.mjs:43-44](module/data-models/skill.mjs#L43)), porque el usuario puede teclear una categoría que aún no exista en el mundo. La resolución del padre se hace **por identidad estable, no por nombre literal** ([skill.mjs:118-127](module/data-models/skill.mjs#L118)):

```js
if (actor?.documentName === "Actor" && this.category) {
  const parentCategory = actor.items.find(i =>
    i.type === "category" && matchesIdentity(i, this.category)
  );
  if (parentCategory) categoryBonus = Number(parentCategory.system?.totalBonus ?? 0) || 0;
}
```

`matchesIdentity` ([slug.mjs:104-111](module/utils/slug.mjs#L104)) compara la referencia contra el `system.slug` de la categoría candidata, cayendo a su nombre slugificado si no hay slug. Como `slugify` ([slug.mjs:56-66](module/utils/slug.mjs#L56)) normaliza diacríticos (NFD + eliminación de marcas combinantes), mayúsculas y el separador "·" (middot, p. ej. en "Armor · Heavy"), el *join* sobrevive a renombrados, traducción, mayúsculas/minúsculas y al middot. Este es el reemplazo, introducido en el refactor de identidad (Fase 0), de los antiguos *joins* por `name.trim().toLowerCase()` que se rompían con esos casos.

El **orden de derivación importa**: la habilidad lee `parentCategory.system.totalBonus`, que debe estar ya derivado. Foundry deriva los items embebidos en su propio `prepareDerivedData`; el sistema confía en que la categoría se prepara antes que la habilidad lo lea. Como cada item se deriva de forma independiente y la categoría no depende de ninguna habilidad, no hay ciclo.

### La progresión `special` y la tabla *override* de la raza

Body Development (que fija los HP) y Power Point Development (que fija los PP) **no usan una progresión fija**: cada raza tiene su propia tabla de desarrollo. Por eso su progresión es `special` (tabla de respaldo a 0) y la tabla real se inyecta como *override* desde el item `race` del actor. La resolución está en `#resolveSpecialSkillTable` ([skill.mjs:154-174](module/data-models/skill.mjs#L154)):

```js
#resolveSpecialSkillTable(progression, item, actor) {
  if (progression !== "special") return null;
  if (actor?.documentName !== "Actor") return null;
  const raceItem = actor.itemTypes?.race?.[0];
  if (!raceItem) return null;

  const role = resolveSpecialRole(this.specialRole, item.name);

  if (role === "bodyDevelopment") {
    return raceItem.system?.bodyDevelopmentTable ?? null;
  }
  if (role === "powerPointDevelopment") {
    const realmItem = actor.itemTypes?.realm?.[0];
    const field = realmItem?.system?.powerPointsField;
    if (typeof field !== "string" || !field) return null;
    return raceItem.system?.[`${field}Table`] ?? null;
  }
  return null;
}
```

Los dos mapeos:
- **Body Development** → `race.system.bodyDevelopmentTable`.
- **Power Point Development** → `race.system[\`${realm.powerPointsField}Table\`]`. El reino expone `powerPointsField` (derivado en [realm.mjs:54](module/data-models/realm.mjs#L54) como `\`pp${this.powerPointsType}\``, p. ej. `ppChanneling`), de modo que se selecciona la tabla de PP del reino correcto: `ppChannelingTable`, `ppEssenceTable` o `ppMentalismTable`.

#### De dónde sale la tabla: `parseRaceProgression`

La raza guarda cada progresión como **string `"zero/T1/T2/T3/T4"`** (ej. `"0/6/4/2/1"`), en los campos `bodyDevelopment`, `ppChanneling`, `ppEssence` y `ppMentalism` ([race.mjs:67-70](module/data-models/race.mjs#L67)), y los parsea en su `prepareDerivedData` ([race.mjs:104-107](module/data-models/race.mjs#L104)) con `parseRaceProgression` ([race.mjs:139-148](module/data-models/race.mjs#L139)):

```js
function parseRaceProgression(value) {
  const empty = { zero: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  if (typeof value !== "string" || !value.trim()) return empty;
  const parts = value.split("/").map(s => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : 0;
  });
  while (parts.length < 5) parts.push(0);
  return { zero: parts[0], tier1: parts[1], tier2: parts[2], tier3: parts[3], tier4: parts[4] };
}
```

El resultado tiene exactamente la forma `{ zero, tier1, tier2, tier3, tier4 }` que `_computeFromTable` espera, por lo que se puede pasar directamente como `overrideTable` y el mismo motor de cuatro tramos calcula los HP/PP del personaje. La progresión `special` se almacena como string (formato compacto y editable en la ficha de raza) y se deriva a tabla estructurada solo en memoria — el comentario lo marca como "ephemeral; not persisted" ([race.mjs:103](module/data-models/race.mjs#L103)): nunca se persiste la tabla parseada.

Así, la habilidad Body Development de un personaje con 5 rangos y una raza con `bodyDevelopment = "0/6/4/2/1"` calcula su bono (que el actor convierte en HP) con `t1·6 + ...` exactamente igual que cualquier otra habilidad.

### El tag de identidad `specialRole` y por qué no se usa el nombre

Tanto categoría como habilidad llevan un campo `specialRole` ([_identity.mjs:49-54](module/data-models/_identity.mjs#L49)) con valores `none | bodyDevelopment | powerPointDevelopment` (constante `SPECIAL_ROLES`, [_identity.mjs:43](module/data-models/_identity.mjs#L43)). Es el mecanismo, introducido en el refactor de identidad, para reconocer las dos mecánicas que mueven HP/PP **sin depender del nombre inglés**, que se rompería bajo traducción o ante una errata. La resolución la centraliza `resolveSpecialRole` ([_identity.mjs:83-85](module/data-models/_identity.mjs#L83)):

```js
export function resolveSpecialRole(role, name) {
  return (role && role !== "none") ? role : specialRoleFromName(name);
}
```

Prefiere el tag explícito; si está vacío, cae a `specialRoleFromName(name)` ([_identity.mjs:65-71](module/data-models/_identity.mjs#L65)), que slugifica el nombre y compara contra `body-development` / `power-point-development`. Esto es "belt-and-suspenders": el tag es la vía principal, pero el nombre actúa de red de seguridad para documentos aún no migrados.

### `classification`: cómo se resuelve la tirada

La habilidad declara una `classification` ([skill.mjs:47](module/data-models/skill.mjs#L47)) con cuatro valores canónicos (`SKILL_CLASSIFICATIONS`, [rank-bonus.mjs:50-55](module/utils/rank-bonus.mjs#L50)):

| Valor | Significado RMF |
|-------|-----------------|
| `movingManeuver` | Maniobra en movimiento (se resuelve en la tabla de maniobras móviles) |
| `staticManeuver` | Maniobra estática |
| `offensiveBonus` | Bono ofensivo (se suma directo al ataque, no se tira en tabla de maniobras) |
| `specialPurpose` | Propósito especial |

`normalizeSkillClassification` ([rank-bonus.mjs:63-69](module/utils/rank-bonus.mjs#L63)) acepta variantes case-insensitive y cae a `movingManeuver` si el valor es desconocido. La derivación renormaliza el valor sobre `this` ([skill.mjs:142](module/data-models/skill.mjs#L142)) para que las plantillas siempre encuentren un valor válido aunque el persistido sea una variante antigua. La clasificación determina **cómo** se resuelve la tirada (qué tabla de resultados usar), mientras que `totalBonus` determina **cuánto** se suma.

### Valores derivados vs. persistidos

Una distinción de implementación importante: los esquemas **no declaran** `totalRanks`, `totalRankBonus`, `totalBonus`, `categoryBonus`, etc. Se asignan sobre la instancia del modelo en `prepareDerivedData` ([category.mjs:190-197](module/data-models/category.mjs#L190), [skill.mjs:129-142](module/data-models/skill.mjs#L129)) y, como dice el comentario en [category.mjs:186-189](module/data-models/category.mjs#L186), "stay in memory and never round-trip to the DB". Esto significa que se recalculan en **cada** pase de derivación y nunca se guardan obsoletos: cambiar un rango, una característica del actor, el reino o la raza recomputa el bono al vuelo. La plantilla los lee como `item.system.totalBonus`, `item.system.totalRankBonus`, etc.

La habilidad expone además dos campos derivados de conveniencia ([skill.mjs:137-139](module/data-models/skill.mjs#L137)):
- **`rankBonusSummary`**: el desglose legible del bono por rango (p. ej. `"10*3 + 5*2 = 40"`, vía `formatSkillRankBonusBreakdown`, [rank-bonus.mjs:157-161](module/utils/rank-bonus.mjs#L157)), para la cabecera de la ficha; así la sheet no necesita saber resolver el `overrideTable`.
- **`bonus`**: alias de `totalBonus` que consume `RMFActions.#rollSkill` — mantiene `actions.mjs` sin tocar.

### El alias legado `rank`/`ranks`

Ambos modelos conservan un campo escalar legado: `ranks` en la categoría ([category.mjs:107-109](module/data-models/category.mjs#L107)) y `rank` en la habilidad ([skill.mjs:38-40](module/data-models/skill.mjs#L38)). Se persisten para que mundos antiguos carguen, pero la derivación de la categoría lo **sobrescribe** en cada pase con el total recalculado ([category.mjs:197](module/data-models/category.mjs#L197), `this.ranks = totalRanks;`); la habilidad **no resincroniza `rank` activamente**, ya que `boughtByLevel` lo reemplaza. Son redundantes con `boughtByLevel`/`totalRanks`; los comentarios los marcan como "Legacy … kept persisted to avoid breaking older worlds". El refactor los eliminará: la fuente de verdad ya es `boughtByLevel`.

### El penalizador `-15` por "no skill" en la ficha del actor

Cuando un personaje tira una **categoría sin tener ninguna habilidad relevante** (la acción "No skill"), RMF aplica el penalizador canónico `-15`, definido como `RMF_CONSTANTS.NO_SKILL_PENALTY` ([constants.mjs:93](module/utils/constants.mjs#L93)). Hay dos consumidores:

1. **La ficha del actor** precalcula el total mostrado ([actor-sheet.js:174-185](module/actor-sheet.js#L174)):

```js
const categoryTotal = Number(category.system?.totalBonus ?? 0) || 0;
const progression = String(category.system?.categoryRankBonusProgression ?? "").trim().toLowerCase();
return {
  category,
  noSkillTotal: categoryTotal + RMF_CONSTANTS.NO_SKILL_PENALTY,
  showNoSkill: progression === "standard",
  skills: skillsByCategoryId.get(category.id).sort(sortByName)
};
```

   La acción "No skill" **solo se ofrece para categorías `standard`** (`showNoSkill`, [actor-sheet.js:182](module/actor-sheet.js#L182)): el `-15` por improvisar solo tiene sentido para una categoría que de hecho penaliza la falta de entrenamiento; las `nonstandard` no exponen la acción. Nótese que el agrupamiento de habilidades bajo su categoría también usa identidad por slug: la ficha construye un índice con `buildSlugIndex(categories)` y resuelve cada habilidad con `resolveFromIndex` ([actor-sheet.js:163-171](module/actor-sheet.js#L163)).

2. **La acción de tirada** `#rollCategoryNoSkill` ([actions.mjs:474-476](module/actions.mjs#L474)) construye la fórmula con el mismo penalizador:

```js
const rawBase = Number(category.system.totalBonus);
const baseBonus = Number.isFinite(rawBase) ? Math.trunc(rawBase) : 0;
const { formula, bonus } = RMFActions.#buildD100Formula(baseBonus + RMF_CONSTANTS.NO_SKILL_PENALTY);
```

La fórmula resultante es:

```
noSkillTotal = category.totalBonus + (-15)
```

Es decir: el personaje aprovecha el bono de su **categoría** (que incluye su bono de característica y de rangos de categoría) pero arrastra `-15` por no tener la habilidad concreta. Esto modela exactamente la regla RMF de "tirar una categoría sin rangos de skill": no estás totalmente perdido (tienes el contexto de la categoría) pero improvisar penaliza.

---

## Razas y reinos de poder (realm)

Una **raza** (`race`) y un **reino mágico** (`realm`) son dos tipos de Item de contenido que, al soltarse sobre un personaje, dejan de ser "fichas de referencia" y se convierten en las dos piezas que configuran la base biológica y mágica del actor: la raza fija los modificadores raciales de característica, las resistencias, los rangos raciales de partida y las progresiones de Desarrollo Corporal / Puntos de Poder; el reino elige el realm de magia (Essence/Channeling/Mentalism) y, con él, qué stats alimentan el desarrollo de Puntos de Poder. Ambos son **singletons**: un personaje solo puede tener una raza y un reino.

Esta sección documenta los dos esquemas, la decisión de diseño de guardar las progresiones como string compacto, y —lo más importante— la mecánica de *enlace actor↔item*: qué se escribe en el actor al soltar el item, en qué orden, qué hooks lo disparan y cómo las skills "especiales" (Body Development y Power Point Development) leen las tablas de la raza y del reino para derivar HP y PP.

### Esquema de la raza (`RaceData`)

El modelo vive en [race.mjs](module/data-models/race.mjs) y extiende `foundry.abstract.TypeDataModel`. Su esquema ([race.mjs:44](module/data-models/race.mjs#L44)) se compone de varios bloques:

#### Stats y resistencias en *short-keys*

Las características y resistencias raciales se guardan con claves cortas, no con las claves largas del actor:

```js
const STAT_SHORT_KEYS  = ["ag","co","me","re","sd","em","in","pr","qu","st"];
const RESIST_SHORT_KEYS = ["ess","chan","ment","pois","dis"];
```

Cada una se materializa como un `SchemaField` de 10 (stats) y 5 (resistances) `NumberField` enteros con `initial: 0` ([race.mjs:52-62](module/data-models/race.mjs#L52)). La forma del dato es deliberadamente **compacta y desacoplada del actor**: un item raza es un documento de catálogo (vive en el mundo o en el compendio `world.basic-core`), y guardarlo con `ag/co/...` en vez de `chAgility/chConstitution/...` mantiene el JSON canónico breve y legible. La traducción `ag → chAgility` ocurre en el *momento del enlace*, no en el almacenamiento, mediante el mapa `CONFIG.RMF.statShortToFull` (definido en [constants.mjs:19](module/utils/constants.mjs#L19) como `STAT_SHORT_TO_FULL` y registrado en [rmf.mjs:177](rmf.mjs#L177)).

| Bloque | Claves | Destino en el actor |
|---|---|---|
| `stats` | `ag,co,me,re,sd,em,in,pr,qu,st` | `system.chStats.<chXxx>.race` |
| `resistances` | `ess,chan,ment,pois,dis` | sumadas a `derivedStats.resistances.*` |

Las resistencias **no** se copian a un campo del actor: el actor las lee *en vivo* durante su derivación (ver más abajo, [character.mjs:191](module/data-models/character.mjs#L191)). Esto es una decisión de diseño: las stats raciales sí se "estampan" (persisten) en `chStats.*.race` porque el usuario puede querer verlas y editarlas como un modificador, mientras que las resistencias son puramente derivadas y se recalculan en cada `prepareDerivedData`.

#### Progresiones como string "zero/T1/T2/T3/T4"

Los cuatro campos de progresión son `StringField`, no estructuras numéricas:

```js
bodyDevelopment: progStr(""),   // p.ej. "0/6/4/2/1"
ppChanneling:    progStr(""),
ppEssence:       progStr(""),
ppMentalism:     progStr(""),
```

El formato `"zero/T1/T2/T3/T4"` codifica, en una sola cadena, los puntos que la raza concede por rango en cada **tramo de niveles**:

- **zero**: valor base con 0 rangos (normalmente `0`).
- **T1**: puntos por rango en niveles 1–10.
- **T2**: niveles 11–20.
- **T3**: niveles 21–30.
- **T4**: niveles 31–99.

`parseRaceProgression` ([race.mjs:139](module/data-models/race.mjs#L139)) hace `value.split("/")`, convierte cada trozo a número (no-finitos → 0), rellena con ceros hasta 5 posiciones y devuelve `{zero, tier1, tier2, tier3, tier4}`. Una cadena vacía, en blanco o no-string devuelve el objeto todo-ceros ([race.mjs:140-141](module/data-models/race.mjs#L140)).

**POR QUÉ string compacto** (decisión de diseño explícita, es el patrón modelo del refactor): la documentación de campos de raza comenta *"Kept as plain strings to preserve the existing data shape"* ([race.mjs:65-66](module/data-models/race.mjs#L65)). El JSON canónico de razas (en `data/races.json`) ya traía las progresiones como `"0/6/4/2/1"`; modelarlas como string evita una migración del dato fuente y mantiene el documento legible por humanos. La estructura `{zero,tier1..tier4}` solo existe **en memoria** (ephemeral): se calcula en `prepareDerivedData` ([race.mjs:104-107](module/data-models/race.mjs#L104)) y nunca se persiste. Es el mismo principio "persist string compacto / deriva estructura" que el refactor aplica en otros sitios (Body/PP Development resuelven su tabla en runtime, no la duplican).

Estas tablas parseadas se exponen como `bodyDevelopmentTable`, `ppChannelingTable`, `ppEssenceTable`, `ppMentalismTable` sobre la instancia ([race.mjs:104-107](module/data-models/race.mjs#L104)). **El nombre del campo importa**: la skill especial las localiza por convención `${field}Table` (ver enlace con la skill PP-Dev más abajo).

#### Rangos raciales, skills especiales y opciones de trasfondo

```js
backgroundOptions: num(0, { min: 0 }),   // nº de opciones de trasfondo (RMF)
hobbyRanks:        num(0, { min: 0 }),    // rangos de afición que concede la raza
standardHobbySkills: str(""),            // texto libre con las skills de afición sugeridas

racialRanks: {                            // rangos que la raza regala al crear el PJ
  categories: [ { name, ranks } ],
  skills:     [ { name, ranks } ]
},

specialSkills: {                          // marcado de status especial por skill
  everyman:   [ "<skill name>", ... ],
  restricted: [ "<skill name>", ... ]
}
```

`racialRanks.categories` y `racialRanks.skills` son `ArrayField` de un `SchemaField` `{name: StringField, ranks: NumberField}` ([race.mjs:25-30](module/data-models/race.mjs#L25)). Modela los **rangos raciales** de Rolemaster: bonos a categorías/skills que un personaje recibe "gratis" por su raza al nivel 0.

`specialSkills.everyman` / `.restricted` son `ArrayField` de `StringField` no-blank ([race.mjs:36-41](module/data-models/race.mjs#L36)): listas de **nombres** de skills que la raza convierte en *Everyman* (más baratas de desarrollar) o *Restricted* (vetadas/penalizadas), siguiendo las categorías de coste de RMF.

`prepareDerivedData` además construye dos **mapas O(1)** `racialRanksByCategory` y `racialRanksBySkill` (nombre → rangos, congelados con `Object.freeze`) para que el actor resuelva un nombre sin escanear los arrays, y varios flags/sumas solo-UI (`hasStatBonuses`, `hasResistances`, `totalStatBonus`, `totalRacialCategoryRanks`, `totalRacialSkillRanks`) que consume la sheet de raza ([race.mjs:111-127](module/data-models/race.mjs#L111)).

Finalmente, la raza lleva la identidad estable del refactor Fase 0: `slug: slugField()` ([race.mjs:87](module/data-models/race.mjs#L87)) y `fromBook` (`"basic"` por defecto). El `slug` permite que los joins por nombre sean tolerantes a traducción/renombrado vía [slug.mjs](module/utils/slug.mjs).

### Esquema del reino (`RealmData`)

El modelo está en [realm.mjs](module/data-models/realm.mjs). Es deliberadamente pequeño:

```js
powerPointsType: StringField({ initial: "Mentalism", choices: ["Essence","Channeling","Mentalism"] }),
statBonus: {
  stat1: statKey("chPresence"),   // clave canónica chXxx o ""
  stat2: statKey(""),
  stat3: statKey("")
}
```

`powerPointsType` es el **realm de magia** que el personaje practica; es un `StringField` con `blank: false` y `choices: ["Essence","Channeling","Mentalism"]` ([realm.mjs:29-33](module/data-models/realm.mjs#L29)). `statBonus.statN` contiene las stats primarias que determinan el desarrollo de Puntos de Poder de ese realm. La decisión de tipar `statBonus.statN` como `StringField` libre (no `choices: STAT_KEYS_FULL`) está documentada en [realm.mjs:18-25](module/data-models/realm.mjs#L18): la cadena vacía es un valor legítimo (slot sin stat asignada), y `choices` lo prohibiría sin manejo manual de `nullable`. El valor inicial de `stat1` es `"chPresence"` porque el realm por defecto es Mentalism, cuya stat primaria en RMF es Presence.

#### Derivación: `powerPointsField`

`prepareDerivedData` ([realm.mjs:52-55](module/data-models/realm.mjs#L52)) calcula un único campo:

```js
this.powerPointsField = `pp${this.powerPointsType}`;   // "ppEssence" | "ppChanneling" | "ppMentalism"
```

Este nombre **es exactamente** una de las claves de progresión de la raza. Es el puente entre reino y raza: el reino dice "yo soy Channeling" → `ppChanneling` → la skill PP-Dev sabe que debe leer `race.system.ppChannelingTable`. Es un acoplamiento por convención de nombres, intencional y minimalista.

### Cómo la raza se une al personaje (drop handler)

El enlace ocurre en `_onDropItem` ([actor-sheet.js:333](module/actor-sheet.js#L333)) de [actor-sheet.js:343-377](module/actor-sheet.js#L343). Al soltar un item `race`:

1. **Enforce singleton**: si el actor ya tiene una raza, avisa y aborta ([actor-sheet.js:343-348](module/actor-sheet.js#L343)). Es regla de diseño: una criatura tiene una sola raza.
2. **Crea el item embebido** (`createEmbeddedDocuments`).
3. **Estampa el nombre y las stats raciales** en el actor ([actor-sheet.js:352-359](module/actor-sheet.js#L352)):
   ```js
   const updateData = { 'system.chRace': raceName };
   for (const [shortKey, longKey] of Object.entries(CONFIG.RMF.statShortToFull)) {
     const val = Number(stats?.[shortKey] ?? 0) || 0;
     updateData[`system.chStats.${longKey}.race`] = val;
   }
   await this.document.update(updateData);
   ```
   Aquí ocurre la traducción `ag → chAgility`. Se escribe `system.chRace` (un string informativo en la ficha) y `system.chStats.<chXxx>.race` por cada una de las 10 stats. Ese campo `.race` es el modificador racial que `#calculateStatBonuses` ([character.mjs:128](module/data-models/character.mjs#L128)) suma en `stat.total = stat.basic + stat.race + stat.spec` ([character.mjs:133](module/data-models/character.mjs#L133)). Es decir: el modificador racial **se persiste** como dato del actor, no se recalcula cada render.
4. **Aplica rangos raciales** vía `_applyRacialRanksFromRace` (siguiente apartado).
5. **Aplica skills especiales** vía `_applySpecialSkillsFromRace`.

#### `_applyRacialRanksFromRace` — escribir `boughtByLevel.0`

[actor-sheet.js:446-521](module/actor-sheet.js#L446) recorre `racialRanks.categories` y `racialRanks.skills`:

- Para cada **categoría**, busca el item categoría del actor por identidad estable (`matchesIdentity`, [actor-sheet.js:454](module/actor-sheet.js#L454)) y escribe `system.boughtByLevel.0 = ranks`. Las categorías **no se auto-crean**: se asume que el actor ya las tiene (las recibe en `createActor`, ver hooks).
- Para cada **skill**, si no existe en el actor y `ranks > 0`, la **auto-crea** resolviendo su documento fuente con `_resolveSkillSourceData` (primero `game.items` del mundo, luego el compendio `world.basic-core`, [actor-sheet.js:608-645](module/actor-sheet.js#L608)); si no la encuentra en ningún sitio, fabrica un stub mínimo con `_buildStubSkillData`. En la creación ya siembra `boughtByLevel.0 = ranks` ([actor-sheet.js:491-494](module/actor-sheet.js#L491)).
- Luego, en una segunda pasada, actualiza `boughtByLevel.0` en las skills ya existentes (o recién creadas) cuyo valor difiera del concedido ([actor-sheet.js:503-520](module/actor-sheet.js#L503)).

**POR QUÉ `boughtByLevel.0`**: en RMF los rangos se compran por nivel; el "nivel 0" es la columna reservada a los rangos *de partida* que no se compraron con DP, y los rangos raciales encajan ahí. Como el comentario del esquema de skill indica, *"racial ranks are stored under boughtByLevel.0, so they're already accounted for"* en `totalRanks` ([skill.mjs:110-112](module/data-models/skill.mjs#L110)). Así el rango racial fluye automáticamente al bono total de la skill sin un campo dedicado.

Skills con `ranks === 0` se omiten en la auto-creación ([actor-sheet.js:482-484](module/actor-sheet.js#L482)): no tiene sentido crear una skill vacía que la raza no concede realmente.

#### `_applySpecialSkillsFromRace` — marcar `specialStatus`

[actor-sheet.js:537-595](module/actor-sheet.js#L537) construye un `Map(identityKey → {name, status})`, procesando primero `everyman` y luego `restricted`, de modo que **restricted gana** si un nombre aparece en ambas listas (es la restricción más fuerte, comentado en [actor-sheet.js:551-552](module/actor-sheet.js#L551)). Auto-crea las skills faltantes (mismo resolutor que rangos raciales) y escribe `system.specialStatus = "everyman" | "restricted"` en cada skill encontrada. Este campo `specialStatus` (cuyos `choices` son `["none","everyman","occupational","restricted"]`, [skill.mjs:24](module/data-models/skill.mjs#L24)) modula después el coste de desarrollo de la skill.

#### Reversión al borrar la raza

El enlace es **simétrico**: el hook `deleteItem` ([hooks.mjs:365-413](module/hooks.mjs#L365)) detecta la eliminación de una raza y, por cada categoría/skill embebida, resetea `boughtByLevel.0 → 0` y `specialStatus → "none"`, agrupando ambos cambios en un solo update por item. Así la contribución racial de nivel 0 y las etiquetas everyman/restricted **desaparecen con la raza**. (Nota: el modificador `chStats.*.race` no se limpia aquí; permanece en el actor hasta que se sobrescriba con otra raza o se edite manualmente.)

### Cómo el reino se une al personaje

El drop de `realm` ([actor-sheet.js:380-392](module/actor-sheet.js#L380)) es más simple: enforce singleton, crea el item embebido y escribe `system.chRealm = realmName`. No copia el `statBonus` directamente en el update del drop; eso lo hace un **hook**, porque el destino del `statBonus` no es el actor sino una *categoría concreta* del actor.

#### Sincronización del `statBonus` hacia la categoría Power Point Development

La categoría "Power Point Development" (PP-Dev) del actor necesita saber qué stats la alimentan, y esa información vive en el reino. El puente es `#syncPowerPointDevelopmentStatBonus` ([hooks.mjs:426-446](module/hooks.mjs#L426)):

```js
static async #syncPowerPointDevelopmentStatBonus(actor, realmItem) {
  const ppDev = actor.items.find(i =>
    i.type === "category" &&
    resolveSpecialRole(i.system?.specialRole, i.name) === "powerPointDevelopment");
  if (!ppDev) return;
  const rb = realmItem.system?.statBonus ?? {};
  const next = { stat1: ..., stat2: ..., stat3: ... };
  // ... salta el write si cur === next (evita bucles de update)
  await ppDev.update({ "system.statBonus": next });
}
```

Localiza la categoría PP-Dev **por su `specialRole`** (no por el nombre inglés), usando `resolveSpecialRole` ([_identity.mjs:83](module/data-models/_identity.mjs#L83)) que prefiere la etiqueta interna y cae al nombre solo como respaldo. Esto es parte de la identidad del refactor: HP/PP se identifican por `specialRole`, no por "Body Development"/"Power Point Development" en inglés, para sobrevivir a traducción y erratas. Copia `stat1/stat2/stat3` del reino a `category.system.statBonus`, **saltando el write si ya coinciden** ([hooks.mjs:438-439](module/hooks.mjs#L438)) para no generar bucles de actualización.

Este hook se dispara desde tres lugares ([hooks.mjs:290-348](module/hooks.mjs#L290)):

| Evento | Condición | Acción |
|---|---|---|
| `createItem` | item es `realm` | sincroniza la PP-Dev existente desde el nuevo reino ([hooks.mjs:296-299](module/hooks.mjs#L296)) |
| `createItem` | item es `category` con `specialRole === powerPointDevelopment` | sincroniza desde el reino existente ([hooks.mjs:302-306](module/hooks.mjs#L302)) |
| `updateItem` | item es `realm` y cambió `system.statBonus` | re-sincroniza ([hooks.mjs:340-347](module/hooks.mjs#L340)) |

Los tres casos cubren el orden de inserción arbitrario: da igual si llega antes el reino o la categoría PP-Dev (esta última suele llegar en `createActor` desde basic-core), y un cambio posterior en las stats del reino propaga al instante. Todos los handlers respetan `game.userId !== userId` para que **solo el cliente que origina el cambio** ejecute la escritura.

### El bucle completo: cómo HP y PP se derivan de raza + reino

La pieza que cierra el círculo está en `SkillData.#resolveSpecialSkillTable` ([skill.mjs:154-174](module/data-models/skill.mjs#L154)). Las skills "Body Development" y "Power Point Development" tienen `skillRankBonusProgression === "special"`: su tabla de bono-por-rango **no es fija**, se resuelve en runtime contra la raza (y el reino, para PP):

```js
#resolveSpecialSkillTable(progression, item, actor) {
  if (progression !== "special") return null;
  if (actor?.documentName !== "Actor") return null;
  const raceItem = actor.itemTypes?.race?.[0];
  if (!raceItem) return null;
  const role = resolveSpecialRole(this.specialRole, item.name);

  if (role === "bodyDevelopment")
    return raceItem.system?.bodyDevelopmentTable ?? null;

  if (role === "powerPointDevelopment") {
    const realmItem = actor.itemTypes?.realm?.[0];
    const field = realmItem?.system?.powerPointsField;          // "ppChanneling"
    if (typeof field !== "string" || !field) return null;
    return raceItem.system?.[`${field}Table`] ?? null;          // raceItem.system.ppChannelingTable
  }
  return null;
}
```

El flujo de datos para **Puntos de Poder** es:

```
realm.powerPointsType ("Channeling")
   → realm.powerPointsField ("ppChanneling")          [realm.mjs:54]
      → race.system["ppChannelingTable"]              [skill.mjs:171]
         = parseRaceProgression(race.ppChanneling)    [race.mjs:105]
            → {zero, tier1..tier4}
               → computeSkillRankBonus(totalRanks, "special", overrideTable)   [skill.mjs:116]
                  → skill.totalBonus → HP/PP max del actor
```

Para **Body Development** es directo: `bodyDevelopmentTable` de la raza, sin necesidad del reino (todas las razas desarrollan cuerpo independientemente de su magia).

Esto explica por qué los tres campos de progresión de la raza se llaman exactamente `ppEssence/ppChanneling/ppMentalism` y por qué el reino deriva `powerPointsField = "pp" + powerPointsType`: el sufijo `Table` sobre el campo concatenado (`${field}Table`) tiene que coincidir byte a byte con el nombre que `prepareDerivedData` de la raza expone. Es un contrato implícito entre tres modelos (realm → race → skill) sostenido por convención de nombres, no por referencias explícitas.

#### Resistencias raciales en la derivación del actor

Como complemento, las resistencias de la raza se aplican directamente en la derivación del actor, no vía skill: `#calculateSecondaryAttributes` lee `this.parent?.itemTypes?.race?.[0]` y suma `ess/chan/ment/pois/dis` sobre las resistencias ya calculadas a partir de las stats ([character.mjs:190-200](module/data-models/character.mjs#L190)). Es un acceso *en vivo* al item raza durante el `prepareDerivedData` del actor — por eso no necesita persistirse en ningún campo del actor.

### Resumen de la unión actor↔item

| Item | Singleton | Persiste en el actor | Deriva en vivo |
|---|---|---|---|
| **race** | sí | `chRace`, `chStats.*.race` (mods); `boughtByLevel.0` y `specialStatus` en categorías/skills | resistencias, tablas Body/PP-Dev |
| **realm** | sí | `chRealm`; `statBonus` copiado a la categoría PP-Dev (vía hook) | `powerPointsField` |

El principio transversal: **lo que el usuario edita o ve como modificador se persiste** (mods de stat, rangos de nivel 0, statBonus de la categoría); **lo que es puramente función de los datos fuente se deriva en cada render** (tablas de progresión, resistencias, `powerPointsField`). Y todos los joins —raza↔categoría, reino↔categoría PP-Dev, skill↔raza— se resuelven por **identidad estable** (`slug`/`specialRole` vía [slug.mjs](module/utils/slug.mjs) y [_identity.mjs](module/data-models/_identity.mjs)), nunca por nombre inglés crudo, para sobrevivir a traducción, erratas y el middot "·" de nombres como "Armor · Heavy".

---

## Profesiones y paquetes de entrenamiento (training packages)

La profesión y los paquetes de entrenamiento son los dos contenidos que **inyectan valores de juego en otros items del actor** en lugar de vivir como datos aislados. Una profesión sube `profBonus` de categorías y habilidades; un paquete de entrenamiento suma rangos comprados (`boughtByLevel`). Ambos se disparan automáticamente al soltar el item sobre el actor, y ambos modelan reglas concretas de Rolemaster Fantasy (RMFT v4.0): la profesión define los *Professional Skill Bonuses* y los costes de DP del personaje; el training package es un "paquete" de rangos que se compra de golpe con DP del nivel actual.

Esta sección cubre, en orden: el esquema de cada item, cómo `applyProfessionToActor` parsea los sufijos y persiste un *ledger* de deltas para poder revertir, por qué ese ledger es frágil (y migrará a ActiveEffects), cómo `applyTrainingPackageToActor` suma rangos al nivel actual y se autoconsume, el enforcement de "una profesión/raza/realm por actor" en el actor-sheet, y la resolución por identidad/slug introducida en la Fase 0 del refactor.

### Profesión: esquema de datos

El modelo está en [profession.mjs](module/data-models/profession.mjs), `ProfessionData extends foundry.abstract.TypeDataModel`. Es un esquema declarativo con `foundry.data.fields` y un `slug` estable proporcionado por `slugField()` de [_identity.mjs](module/data-models/_identity.mjs). Los campos relevantes:

| Campo | Forma | Significado RMF |
|---|---|---|
| `primeStats` | `ArrayField(StringField)` de claves `chXxx` ([profession.mjs:74](module/data-models/profession.mjs#L74)) | Las *Prime Stats* de la profesión (cada string es la clave interna del stat, o cadena vacía para hueco libre). |
| `professionalBonuses` | `ArrayField` de `{ name, bonus, isChoice }` (`bonusRow()`, [profession.mjs:49](module/data-models/profession.mjs#L49)) | Los *Professional Skill Bonuses*: bonificaciones fijas que la profesión otorga a categorías o grupos de habilidades. |
| `everymanSkills` / `occupationalSkills` / `restrictedSkills` | `ArrayField` de `{ name, isChoice }` (`namedRow()`, [profession.mjs:38](module/data-models/profession.mjs#L38)) | Las tres clases de skill que define la profesión (Everyman, Occupational, Restricted). |
| `categoryPrice` / `spellPrice` | `ArrayField` de `{ name, dpCost:{price1,price2,price3} }` (`pricedNameEntry()`, [profession.mjs:23](module/data-models/profession.mjs#L23)) | El **coste efectivo de DP** del personaje por categoría y por lista de hechizos. |
| `trainingPackages` | `ArrayField` de `{ name, dpCost }` (un único número, `trainingPackageRow()`, [profession.mjs:58](module/data-models/profession.mjs#L58)) | Los packages que la profesión abarata, con su coste de DP específico. |

#### El campo `isChoice`: nombre canónico vs. placeholder

`isChoice` (en `bonusRow()` y `namedRow()`, [profession.mjs:38](module/data-models/profession.mjs#L38)) distingue una entrada cuyo `name` es un **nombre canónico** (existe en [skills.json](data/skills.json)/[categories.json](data/categories.json)) de una entrada cuyo `name` es un **placeholder de libre elección** — texto como `"any one non-Restricted Combat Maneuver"` o `"Situational Awareness: Combat"`. La documentación del propio campo lo describe así ([profession.mjs:31-36](module/data-models/profession.mjs#L31)), con la misma semántica que en el training package. Estas entradas no se pueden resolver automáticamente contra el contenido canónico: el sistema las reporta en el chat para que el GM las resuelva a mano. En los datos reales de Fighter ([professions.json](data/professions.json)) los `everymanSkills` mezclan ambos casos: `"Leadership"` (canónico, sin `isChoice`) y `"any one non-Restricted Combat Maneuver"` con `isChoice:true`.

#### `dpCost` como coste EFECTIVO del personaje

Cada fila de `categoryPrice`/`spellPrice` lleva un bloque `dpCost = {price1, price2, price3}` (`dpCostBlock()`, [profession.mjs:14](module/data-models/profession.mjs#L14)). Estos tres números son el coste en *Development Points* de comprar el 1.º, 2.º y 3.er rango de esa categoría/lista **para esta profesión**. En RMF el coste de DP no es propiedad de la habilidad sino de la combinación profesión×habilidad: la misma categoría cuesta distinto a un Fighter que a un Magician. Por eso `dpCost` es un dato **de la profesión**, y el modelo de la skill/category también tiene su propio `dpCost` (ver [category.mjs:91](module/data-models/category.mjs#L91)): cuando se aplica la profesión, ese coste pasa a ser el coste efectivo del personaje en su categoría correspondiente. En Fighter, por ejemplo, `Armor · Heavy` cuesta `{2,2,2}` y `Awareness · Perceptions` cuesta `{2,9,0}` — el `0` en `price3` indica que no se puede comprar un tercer rango.

> **Decisión de diseño (refactor Fase 1, ver [refactor.md](refactor.md)).** Hoy `dpCost` es un `SchemaField` de tres números. La Fase 1 lo convierte en un **string compacto**: `"2/5"`, `"2/2/2"`, y crucialmente `"3/*"`, donde `N/*` significa "todos los rangos a ese coste, ilimitado" (no "restringido"). El `0` actual de `price3` se volverá `""` (sin coste / no aplicable). El motivo: el modelo `{price1,price2,price3}` no puede expresar el coste ilimitado del libro y obliga a tres campos rígidos. Mientras tanto, el código vigente trata estos números literalmente.

`fromBook` (inicial `"basic"`, [profession.mjs:89](module/data-models/profession.mjs#L89)) es el identificador de libro de origen, base de la arquitectura multi-libro de la Fase 2. `template.json` es vestigial: solo lista los tipos y los `htmlFields`; la verdad del esquema es este DataModel registrado en [rmf.mjs](rmf.mjs) vía `CONFIG.Item.dataModels`.

### Aplicación de la profesión al actor: `applyProfessionToActor`

Toda la lógica está en [profession-apply.mjs](module/profession-apply.mjs). La función `applyProfessionToActor(profItem)` ([profession-apply.mjs:92](module/profession-apply.mjs#L92)) recorre `system.professionalBonuses[]` y traduce cada entrada en una mutación sobre los items embebidos del actor. Solo procesa `professionalBonuses`; los demás arrays (everyman/occupational/restricted, prices) son datos de referencia que hoy no muta automáticamente.

#### Parseo de sufijos: " Category" vs " Group"

El corazón es cómo se interpreta `entry.name` según su sufijo ([profession-apply.mjs:130-164](module/profession-apply.mjs#L130)). Esta es la convención de datos que el importer escribe en [professions.json](data/professions.json):

- **Sufijo `" Category"`** ([profession-apply.mjs:135](module/profession-apply.mjs#L135)) → el prefijo es el nombre de una **categoría concreta** del actor. Se encola un *bump* del `profBonus` de esa única categoría en `queuedCategoryBumps`. Ej.: `"Body Development Category" (+10)` sube `profBonus` de la categoría `Body Development` en 10. Si la categoría **no existe** en el actor, se reporta en `missingCategories` y **no** se auto-crea (decisión de diseño: las categorías las asigna el usuario, y el `createActor` ya siembra las básicas desde basic-core).

- **Sufijo `" Group"`** ([profession-apply.mjs:141](module/profession-apply.mjs#L141)) → el prefijo designa un **grupo de habilidades**, no una sola. Se resuelve primero como `system.group` de esquema (vía `normalizeCategoryGroup`, [category.mjs:61](module/data-models/category.mjs#L61)), que normaliza variantes legacy: `"Spell"`/`"Spell List"` → `"Spells"`, `"Power"` → `"Power Awareness"`, `"Technical/Trade"` → `"Technical"`, etc. ([category.mjs:67-71](module/data-models/category.mjs#L67)). Si esa normalización falla (`"none"`), se intenta como **nombre de categoría** (`canonSkillByCategory`, [profession-apply.mjs:148](module/profession-apply.mjs#L148)). El bonus se aplica a **todas** las skills de `world.basic-core` que pertenecen a ese grupo/categoría, y las que el actor aún no tiene se **auto-crean** clonándolas desde basic-core. Ej. en Fighter: `"Weapon Group" (+20)` sube +20 el `profBonus` de toda skill del grupo `Weapon`, creando las que falten.

- **Cualquier otro nombre** (sin sufijo reconocido, o el legacy `" Skill"`) → se acumula en `unrecognised` con `reason` ([profession-apply.mjs:163](module/profession-apply.mjs#L163)). No es un error fatal: permite al GM detectar fallos de transcripción en los JSON.

```js
if (rawName.endsWith(" Category")) {
  const target = rawName.slice(0, -" Category".length).trim();
  queuedCategoryBumps.push({ categoryName: target, delta: bonus });
}
// ...
if (rawName.endsWith(" Group")) {
  const rawPrefix = rawName.slice(0, -" Group".length).trim();
  const normalisedGroup = normalizeCategoryGroup(rawPrefix);
  let matches = (normalisedGroup !== "none")
    ? (canonSkillByGroup.get(normalisedGroup) ?? [])
    : [];
  if (!matches.length) matches = canonSkillByCategory.get(rawPrefix) ?? [];
  // ...una entrada por cada skill del grupo
}
```

> **Por qué dos sufijos.** En RMF un *Professional Bonus* puede aplicarse a una categoría entera (afecta al cálculo de la categoría) o a todas las habilidades de un grupo (afecta a cada skill individual). Como en el sistema una "categoría" y un "grupo de skills" son entidades distintas (la categoría es un item; el grupo es el campo `group` de las skills), el sufijo discrimina la semántica. Es una **decisión de diseño de la forma de datos**, no una regla literal del libro: el libro lista los bonos como texto, y el importer les añade el sufijo para hacerlos máquina-interpretables.

#### Dos pasadas y auto-creación de skills

El algoritmo trabaja en dos fases para no resolver índices obsoletos:

1. **Primera pasada (encolado).** Recorre los bonuses y llena `queuedCategoryBumps`, `queuedSkillBumps` y el `Map` `skillsToCreate` (skills de grupo que el actor no tiene aún). La detección de "no tiene" usa `matchesIdentity(s, sk.slug || sk.name)` ([profession-apply.mjs:155](module/profession-apply.mjs#L155)) — por slug, no por nombre.
2. **Auto-creación.** `_createSkillsFromBasicCore(actor, ...)` ([profession-apply.mjs:273](module/profession-apply.mjs#L273)) trae el documento de basic-core con `pack.getDocument`, hace `toObject()`, borra `_id` y crea las skills embebidas.
3. **Construcción de updates.** Se reconstruye el índice de skills **después** de crear (`skillIndexAfterCreate`, [profession-apply.mjs:193](module/profession-apply.mjs#L193)) para que las recién creadas entren en la resolución. Para cada bump se lee el `profBonus` actual y se suma el delta: `nuevo = current + delta`. Esto es **acumulativo**, no idempotente: aplicar dos profesiones suma ambos bonos.

```js
const current = Number(cat.system?.profBonus) || 0;
updates.push({ _id: cat.id, "system.profBonus": current + delta });
flagEntry.categories.push({ itemId: cat.id, delta });
```

Todos los updates se aplican en un solo `actor.updateEmbeddedDocuments("Item", updates)` ([profession-apply.mjs:204](module/profession-apply.mjs#L204), un único round-trip), y finalmente se emite un mensaje de chat (`_postProfessionApplyMessage`, [profession-apply.mjs:296](module/profession-apply.mjs#L296)) que recapitula categorías/skills aplicadas, skills creadas, categorías ausentes y entradas no reconocidas.

#### El ledger de deltas: `actor.flags.rmf.appliedProfessionBonuses`

La clave de la reversibilidad es el `flagEntry`, persistido en:

```
actor.flags.rmf.appliedProfessionBonuses.<profItemId> = {
  professionName,
  categories: [{ itemId, delta }],
  skills:     [{ itemId, delta }]
}
```

Es un **libro mayor (ledger) de deltas**: registra exactamente qué item recibió cuánto. Se escribe vía `actor.update({ ["flags.rmf.appliedProfessionBonuses." + profItem.id]: flagEntry })` ([profession-apply.mjs:208](module/profession-apply.mjs#L208)). `unapplyProfessionFromActor` ([profession-apply.mjs:226](module/profession-apply.mjs#L226)) lo lee al borrar la profesión y resta `current - delta` en cada item, luego elimina la entrada con la notación `-=` de Foundry:

```js
await actor.update({
  [`flags.rmf.appliedProfessionBonuses.-=${profItem.id}`]: null
});
```

> **Por qué un ledger y por qué es frágil.** Como la profesión muta el `profBonus` *real* de otros items (no un valor derivado), revertir exige recordar el delta exacto que se sumó. El ledger lo consigue. Pero es frágil por diseño: si entre aplicar y revertir el usuario edita `profBonus` a mano, o borra/recrea la skill (cambia su `itemId`), o aplica dos profesiones sobre el mismo target, la resta puede dejar valores incorrectos o huérfanos. El sistema lo asume conscientemente. **La Fase 3 del refactor ([refactor.md](refactor.md)) sustituirá este ledger por ActiveEffects**: los bonos de profesión pasarán a ser **derivados** (calculados al preparar datos) en vez de **mutados**, eliminando el problema de reversión por completo. El ledger es la solución puente hasta entonces.

#### Resolución por identidad/slug (Fase 0)

Todos los joins de esta aplicación pasan por [slug.mjs](module/utils/slug.mjs), no por nombre:

- `buildSlugIndex(actor.itemTypes.category)` y `buildSlugIndex(actor.itemTypes.skill)` ([profession-apply.mjs:175-176](module/profession-apply.mjs#L175)) construyen un `Map(slug → item)` O(1), indexando cada item bajo **su slug y su nombre slugificado** ([slug.mjs:123](module/utils/slug.mjs#L123)).
- `resolveFromIndex(index, name)` ([slug.mjs:141](module/utils/slug.mjs#L141)) resuelve la referencia (`slugify` de por medio) contra ese índice.
- Para skills de grupo se encola `sk.slug || sk.name` ([profession-apply.mjs:154](module/profession-apply.mjs#L154)), priorizando el slug.

Esto es lo que hace que un personaje traducido (skill llamada "Desarrollo Corporal") siga uniéndose correctamente con un dato canónico en inglés ("Body Development"): `slugify` normaliza NFD, elimina diacríticos y el middot `·` ([slug.mjs:24-25](module/utils/slug.mjs#L24)). Antes de la Fase 0 estos joins se hacían con `name.trim().toLowerCase()` y se rompían con diacríticos, el middot `·` y la traducción.

### Enforcement de una profesión / raza / realm por actor

El límite "una sola" se aplica en el **drop handler** del actor-sheet, [actor-sheet.js](module/actor-sheet.js), método `_onDropItem` ([actor-sheet.js:333](module/actor-sheet.js#L333)). Para `race`, `realm` y `profession` el patrón es idéntico: comprobar si ya existe un item de ese tipo y, si lo hay, abortar con un warning. Para la profesión ([actor-sheet.js:395](module/actor-sheet.js#L395)):

```js
if (item.type === 'profession') {
  const hasProfession = this.document.items.some(i => i.type === 'profession');
  if (hasProfession) {
    ui.notifications?.warn(game.i18n.localize('RMF.Messages.AlreadyHasProfession') || '...');
    return false;
  }
  delete itemData._id;
  const created = await this.document.createEmbeddedDocuments('Item', [itemData]);
  const professionName = itemData.name || created?.[0]?.name || '';
  await this.document.update({ 'system.chProfession': professionName });
  return created;
}
```

Tras crear el item, sincroniza el campo "espejo" del actor: `system.chRace` ([actor-sheet.js:354](module/actor-sheet.js#L354)), `system.chRealm` ([actor-sheet.js:390](module/actor-sheet.js#L390)) o `system.chProfession` ([actor-sheet.js:405](module/actor-sheet.js#L405)), que guarda el **nombre** para mostrarlo en la hoja sin tener que buscar el item. (Nota: el caso de la raza hace además más trabajo — sincroniza los modificadores raciales de stats, aplica `racialRanks` y `specialSkills` — pero el patrón de unicidad es el mismo.) La regla de RMF que esto modela es directa: un personaje tiene exactamente una raza, una profesión y (si es spell-user) un realm.

> **Importante: separación de responsabilidades.** El enforcement vive en el **sheet** (`_onDropItem`), pero la **aplicación de bonos** vive en los **hooks** (`createItem`). Son dos capas independientes. Si una profesión se crea por API/macro saltándose el sheet, el límite "una sola" **no** se comprueba, pero los bonos **sí** se aplican (porque el hook `createItem` siempre dispara). Es una decisión de diseño con un coste conocido: el guardrail de unicidad es de UI, no de modelo de datos.

### Cómo se disparan: los hooks

La cadena de eventos está en [hooks.mjs](module/hooks.mjs), clase `RMFHooks`:

| Hook | Condición | Acción |
|---|---|---|
| `createItem` ([hooks.mjs:310](module/hooks.mjs#L310)) | `item.type === "trainingPackage"` | `applyTrainingPackageToActor(item)` |
| `createItem` ([hooks.mjs:323](module/hooks.mjs#L323)) | `item.type === "profession"` | `applyProfessionToActor(item)` |
| `deleteItem` ([hooks.mjs:371](module/hooks.mjs#L371)) | `item.type === "profession"` | `unapplyProfessionFromActor(item)` |

Tres detalles cruciales:

1. **Guard de cliente.** Tanto `#onCreateItem` ([hooks.mjs:290](module/hooks.mjs#L290)) como `#onDeleteItem` ([hooks.mjs:365](module/hooks.mjs#L365)) empiezan con `if (game.userId !== userId) return;`. En multijugador esto evita que la profesión se aplique varias veces (una por cliente conectado): solo el cliente que originó el evento ejecuta la mutación.
2. **`return` temprano por tipo.** En `#onDeleteItem`, el bloque de profesión hace `return` tras `unapplyProfessionFromActor` ([hooks.mjs:377](module/hooks.mjs#L377)), de modo que el código de "race removed" (que resetea `boughtByLevel.0` y `specialStatus`) no corra para una profesión.
3. **No hay hook de `deleteItem` para trainingPackage** — y es intencional, porque el TP se autodestruye al aplicarse (ver abajo).

### Training package: esquema de datos

El modelo está en [training-package.mjs](module/data-models/training-package.mjs), `TrainingPackageData extends foundry.abstract.TypeDataModel`. Un TP es un **paquete de rangos** que se compra de golpe:

| Campo | Forma | Significado |
|---|---|---|
| `type` | `StringField` libre ([training-package.mjs:68](module/data-models/training-package.mjs#L68)) | Nivel de complejidad (Low/Medium/High…). Libre para soportar TPs de fans. En datos, `"L"` para Adventurer. |
| `timeToAcquire` / `startingMoney` / `statGains` | `StringField` ([training-package.mjs:71-73](module/data-models/training-package.mjs#L71)) | Texto informativo del libro (p. ej. `"24 months"`, "choice of two different stats"). |
| `special` | `ArrayField` de `{ name, dpCost }` (`specialEntry()`, [training-package.mjs:22](module/data-models/training-package.mjs#L22)) | Beneficios extra (equipo, spell adders, ítems) con coste de DP fijo. |
| `categoryRanks` | `ArrayField` de `categoryRankEntry` ([training-package.mjs:50](module/data-models/training-package.mjs#L50)) | El grueso: rangos a categorías y a las skills que tocan. |

`categoryRankEntry()` ([training-package.mjs:50](module/data-models/training-package.mjs#L50)) es una estructura **anidada**: `{ category, ranks, isChoice, placeholderName, skills:[ {name, ranks, isChoice, placeholderName} ] }`. Es decir, cada entrada de categoría lleva sus propios `ranks` y un array de skills hijas (`skillEntry()`, [training-package.mjs:36](module/data-models/training-package.mjs#L36)), cada una con sus `ranks`. En Adventurer, por ejemplo, `Athletic · Gymnastics` da `ranks:2` a la categoría y `ranks:1` a la skill hija `Climbing`.

#### `placeholderName` y `isChoice`

`isChoice` marca una entrada de libre elección. `placeholderName` ([training-package.mjs:36-42](module/data-models/training-package.mjs#L36)) **preserva el texto original de la elección** después de que el GM resuelva el choice en la hoja: así el placeholder sigue disponible como opción "revertir" en el desplegable aunque ya se haya elegido un nombre canónico. Es un campo de UX para que las elecciones no sean irreversibles en el editor del item.

#### Derivación: agregados para la hoja

`prepareDerivedData()` ([training-package.mjs:94](module/data-models/training-package.mjs#L94)) calcula cuatro agregados **no persistidos** (se recalculan cada render):

- `totalCategoryRanks` — suma de `ranks` de todas las categorías.
- `totalSkillRanks` — suma de `ranks` de todas las skills anidadas.
- `totalSpecialDPCost` — suma de `dpCost` del array `special`.
- `hasChoices` — `true` si alguna entrada (categoría o skill) es `isChoice`.

Son derivados puros: la fuente son los arrays, y estos valores solo sirven para mostrar totales en la hoja sin recalcular en Handlebars. Son la única lógica de derivación del modelo; el resto es esquema.

### Aplicación del training package: `applyTrainingPackageToActor`

En [training-package-apply.mjs](module/training-package-apply.mjs). El flujo ([training-package-apply.mjs:31](module/training-package-apply.mjs#L31)):

1. **Confirmación.** Un `foundry.applications.api.DialogV2.confirm` ([training-package-apply.mjs:37](module/training-package-apply.mjs#L37)) pregunta antes de aplicar (es destructivo: el item se consume).
2. **Nivel actual.** `const currentLevel = String(Number(actor.system?.chLevel) || 0);` ([training-package-apply.mjs:44](module/training-package-apply.mjs#L44)). Este es el dato clave.
3. **Índices por slug.** `buildSlugIndex` para categorías y skills del actor ([training-package-apply.mjs:47-48](module/training-package-apply.mjs#L47)), igual que en la profesión.
4. **Recorrido.** Por cada `categoryRanks[]` y sus `skills[]`:
   - Si `isChoice` → se acumula en `log.choices` (el GM lo resuelve a mano; no se aplica).
   - Si no, se resuelve por slug y, si `ranks > 0`, se **suma** al rango comprado del nivel actual:
     ```js
     const cur = Number(cat.system?.boughtByLevel?.[currentLevel]) || 0;
     updates.push({ _id: cat.id, [`system.boughtByLevel.${currentLevel}`]: cur + ranks });
     ```
   - Si el target no existe en el actor → se reporta en `catsMissing`/`skillsMissing` (no se auto-crea, a diferencia de la profesión).
5. **Update único** ([training-package-apply.mjs:93](module/training-package-apply.mjs#L93)), mensaje de chat (incluye también el listado `special[]` con su coste de DP, [training-package-apply.mjs:134-139](module/training-package-apply.mjs#L134)), y **autoconsumo**: `await tpItem.delete()` ([training-package-apply.mjs:99](module/training-package-apply.mjs#L99)).

#### Por qué suma a `boughtByLevel.<nivel actual>` y por qué se consume

```
system.boughtByLevel = { "0": <racial>, "1": ..., "2": ..., "<chLevel>": <aquí suma el TP> }
```

`boughtByLevel` es un `ObjectField` con claves-string por nivel ([skill.mjs:55](module/data-models/skill.mjs#L55), idéntico en [category.mjs:101](module/data-models/category.mjs#L101)); la clave `"0"` está reservada para rangos raciales, y `chLevel` indexa el nivel actual del personaje. **La regla de RM**: los rangos de un training package son rangos comprados con *Development Points* del nivel en que se adquiere el paquete. Modelarlos como `boughtByLevel.<chLevel> += ranks` los integra exactamente igual que cualquier rango comprado normalmente — el motor de cálculo de la skill/category no necesita saber que vinieron de un TP. Esa es la razón de sumar al nivel actual y no a un campo separado.

El **autoconsumo** (`tpItem.delete()`) es deliberado y tiene dos motivos: (a) un TP es un evento de una sola vez —se "compra" y desaparece—, no un modificador permanente; (b) impide aplicarlo dos veces por accidente. La consecuencia directa es que **el training package NO es reversible**: no hay ledger de deltas como en la profesión, y al borrarse el item no queda rastro de qué rangos añadió.

> **Por qué TP no es reversible y profesión sí.** Es una asimetría de diseño consciente. La profesión es un estado **persistente** del personaje (puede cambiar, y al quitarla debe revertir sus bonos) → necesita ledger + `unapply`. El TP es una **transacción** puntual (rangos comprados que se funden con el resto) → no tiene sentido "revertirlo" porque, una vez comprados, esos rangos son indistinguibles de los demás del mismo nivel. Cuando la Fase 3 mueva los bonos de profesión a ActiveEffects, esta asimetría desaparecerá conceptualmente: la profesión será derivada (cero coste de reversión) y el TP seguirá siendo una mutación directa de `boughtByLevel`, que es lo correcto para rangos comprados.

### Resumen del acoplamiento con el actor

| | Lee del actor | Escribe en el actor | Reversible | Dispara |
|---|---|---|---|---|
| **Profesión** | `itemTypes.category/skill`, `profBonus`, `flags.rmf.appliedProfessionBonuses` | `category/skill.profBonus`, auto-crea skills, `flags...` (ledger), `system.chProfession` (este último desde el sheet) | Sí (ledger + `unapply` en `deleteItem`) | `createItem`/`deleteItem` |
| **Training package** | `itemTypes.category/skill`, `system.chLevel`, `boughtByLevel` | `category/skill.boughtByLevel.<chLevel>`, se autoborra el item | No (autoconsumo) | `createItem` |

Ambos resuelven sus targets por **slug** ([slug.mjs](module/utils/slug.mjs)), aplican todos los cambios en un único `updateEmbeddedDocuments`, corren solo en el cliente propietario del evento (`game.userId === userId`), y emiten un mensaje de chat con el recap. La profesión es el único contenido del sistema que mantiene un ledger de deltas mutables —su punto frágil y la principal motivación de la migración a ActiveEffects de la Fase 3 del [refactor](refactor.md).

---

## Listas de hechizos (spell lists)

Las listas de hechizos son el primer bloque de **contenido mágico** del sistema. Hoy son **material de referencia puro**: no existe motor de lanzamiento, gasto de puntos de poder ni resolución de ataques mágicos en código. Una lista de hechizos es un `Item` del subtipo `spellList` que reproduce, fielmente y en estructura navegable, una de las 96 listas del *Rolemaster Fantasy* (Barrier Law, Fire Law, Delving Ways, Channels, etc.), con sus 10 niveles de hechizos. Su esquema vive en [spell-list.mjs](module/data-models/spell-list.mjs) y se registra en [rmf.mjs:88](rmf.mjs#L88) como `spellList: SpellListData` dentro de `CONFIG.Item.dataModels`.

El diseño parte de una restricción concreta: el libro publica cada lista como una tabla de 10 filas (nivel 1 a 10) más una **leyenda de reglas** (la *Spell Description Key*, Apéndice A-9.3) que es idéntica para las 96 listas. La decisión arquitectónica central de toda esta sección es **separar el dato variable (la lista concreta) del dato invariante (la leyenda)**: el primero se persiste por documento, el segundo vive una sola vez en constantes y se expone vía `CONFIG`. Esto se explica en detalle más abajo.

### El modelo de datos `SpellListData`

`SpellListData` extiende `foundry.abstract.TypeDataModel` (el modelo de v13 para subtipos de documento) y declara su esquema en `defineSchema()`. Los campos de cabecera de la lista son:

| Campo | Tipo | Valores / inicial | Significado RM |
|---|---|---|---|
| `realm` | `StringField` con `choices` | `Channeling` / `Essence` / `Mentalism`, inicial `Channeling` | El **reino** de poder al que pertenece la lista. Los tres reinos de Rolemaster determinan la estadística regente y qué profesiones pueden aprenderla. |
| `listType` | `StringField` con `choices` | `Open` / `Closed` / `Base`, inicial `Open` | La **clase** de lista: abierta, cerrada o de base. Abiertas y cerradas las puede aprender cualquier usuario del reino; las de Base son exclusivas de una profesión. |
| `profession` | `StringField` (texto libre, puede estar vacío) | "" | La **profesión propietaria** de una lista de Base (`Cleric`, `Ranger`, `Magician`, `Dabbler`, `Mentalist`, `Bard`...). Vacío para Open/Closed. |
| `reference` | `StringField` | "" | Id de sección del libro, p. ej. `A-9.9.1` (Delving Ways). Permite localizar la lista en el manual impreso. |
| `specialNotes` | `ArrayField(StringField)` | `[]` | Notas al pie específicas de esa lista (p. ej. "See Section 24.1 (p. 75) for more information on healing."). |
| `spells` | `ArrayField(spellEntry())` | `[]` | El cuerpo de la lista: los 10 niveles. |
| `slug` | `slugField()` | — | Identidad estable e independiente del idioma (refactor Fase 0). |
| `fromBook` | `StringField` | `"basic"` | Libro de origen, para distinguir contenido por fuente. |

#### La colisión de `type` y por qué se renombra a `listType`

Hay una trampa de nomenclatura que el código documenta explícitamente en la cabecera de [spell-list.mjs:14](module/data-models/spell-list.mjs#L14). El JSON de origen llama `type` al eje Open/Closed/Base:

```json
{ "name": "Delving Ways", "realm": "Essence", "type": "Open", "reference": "A-9.9.1", ... }
```

Pero en Foundry, `type` es una propiedad reservada del documento (el subtipo `spellList` mismo). Si el modelo de datos declarara un campo `system.type`, chocaría con `document.type`. Por eso el importador **mapea** ese `type` del JSON a `listType` en el esquema. Es importante notar que existe un **segundo** `type` que NO colisiona: el `type` por hechizo (E/F/P/...), que está anidado dentro de cada entrada de `spells[]` y por tanto vive como `system.spells[i].type`, sin conflicto. Es una decisión de diseño obligada por el espacio de nombres de Foundry, no una regla del libro.

### El sub-esquema de un hechizo: `spellEntry()`

Cada fila de `spells[]` se construye con la función `spellEntry()` ([spell-list.mjs:37](module/data-models/spell-list.mjs#L37)), que devuelve un `SchemaField` con esta forma:

```js
{
  level:        NumberField  { integer, min:1, max:10, initial:1 },
  name:         StringField  { blank:true, initial:"" },     // "" = nivel sin hechizo
  codes:        ArrayField(StringField{ choices: SPELL_SPECIAL_CODES }),
  rrMod:        NumberField  { integer, nullable:true, initial:null }, // null = sin modificador de RR
  areaOfEffect: StringField  { blank:true },
  duration:     StringField  { blank:true },
  range:        StringField  { blank:true },
  type:         StringField  { blank:true },                 // tipo compuesto E/F/Fm/Us...
  description:  HTMLField     { initial:"" }
}
```

#### El nivel vacío (`name === ""`) y la escalera de 10 peldaños

La decisión más característica de este modelo es que **siempre hay 10 entradas**, una por nivel del 1 al 10, incluso cuando el libro no asigna hechizo a un nivel. En la tabla impresa hay niveles en blanco; en el dato, esos niveles se conservan con `name` vacío. En los JSON de origen aparecen como `{"level": 4, "name": null}` (el importador normaliza `null` → `""`).

El **porqué** es de presentación y de integridad: la sheet recorre las 10 filas para dibujar la escalera de niveles completa, de modo que el usuario siempre vea "Nivel 1 — (vacío)", "Nivel 2 — Text Analysis I", etc. La numeración 1-10 se mantiene íntegra sin huecos en el array ni desfases de índice. El `min:1, max:10` del `NumberField` de `level` codifica el rango fijo de niveles de cualquier lista RMF: una lista nunca tiene hechizos por encima del nivel 10.

#### `codes`: los símbolos especiales por hechizo

El campo `codes` es un array de claves restringidas por `choices: SPELL_SPECIAL_CODES`. En el libro, junto al nombre del hechizo aparecen símbolos:

| Símbolo en el libro | Clave persistida | Significado RM |
|---|---|---|
| `*` | `instantaneous` | Instantáneo; el hechizo no requiere rondas de preparación. |
| `•` | `noPowerPoints` | El hechizo no consume puntos de poder. |
| `‡` | `spellSet` | Forma parte de un **conjunto** de hechizos que deben lanzarse en conjunción con otros para ser (plenamente) efectivos. |

La decisión de diseño aquí es doble. Primero, el dato persiste la **clave semántica** (`"instantaneous"`), no el símbolo crudo (`"*"`): el símbolo es presentación y se recupera desde la leyenda; la clave es estable y localizable. Segundo, los símbolos válidos no se escriben a mano en el esquema, sino que se **derivan** de la leyenda en `SPELL_SPECIAL_CODES` (ver más abajo), garantizando que esquema y leyenda nunca diverjan. Un hechizo real puede acumular varios códigos, p. ej. `Limb Preservation` (lista Blood Law) lleva `["spellSet", "instantaneous"]`.

#### `rrMod`: el modificador de tirada de resistencia, separado de los códigos

Hay un cuarto "código" en el libro, `[RR Mod #]` (cualquier tirada de resistencia contra el hechizo se modifica en `#`). A diferencia de `*`, `•` y `‡`, este lleva un **número**. Por eso se modela aparte como un `NumberField` entero y nullable independiente (`rrMod`), no como una entrada del array `codes`. `null` significa "el hechizo no tiene modificador de RR"; un entero (p. ej. `-20` en `Neutralize Curse I`, de la lista Repulsions) es el modificador. Esta separación es deliberada y está anotada tanto en el esquema como en la leyenda ([constants.mjs:135](module/utils/constants.mjs#L135)): un código booleano (lo lleva o no) no es lo mismo que un dato numérico, y mezclarlos en el mismo array obligaría a codificar/parsear strings como `"rrMod:-20"`. Coherentemente, `SPELL_SPECIAL_CODES` **excluye** `rrMod` precisamente porque no es un flag de código.

#### El tipo compuesto del hechizo (`type`)

`type` es el clasificador del hechizo en la mecánica RM, y se guarda como **string libre** porque es **compuesto**: un código base obligatorio más, opcionalmente, una o dos letras de sub-tipo. Los valores reales presentes en los datos son `E, BE, DE, F, P, U, I` (base) y combinaciones `Fm, Pm, Us` (base + sub-tipo).

- **Códigos base** (`SPELL_TYPE_CODES`): `E` (Elemental), `BE` (Ball Elemental), `DE` (Directed Elemental), `F` (Force), `P` (Passive), `U` (Utility), `I` (Informational). Cada uno define cómo se resuelve el hechizo: por ejemplo `BE`/`DE` van a las tablas de ataque de bola/dardo, `F` exige tirada de ataque en la tabla básica y luego RR del objetivo, `U` solo afecta al lanzador o a un objetivo voluntario (RR rara vez necesaria).
- **Sub-tipos** (`SPELL_SUBTYPE_CODES`): `s` (Subconscious, puede dispararse desde el subconsciente) y `m` (Mental Attack, sujeto a defensas contra ataques mentales e inútil contra entidades sin "mente").

No se usa `choices` para `type` porque el conjunto válido es el **producto cartesiano** base×sub-tipo (más combinaciones de dos sub-tipos), que sería farragoso de enumerar. En su lugar, la validez se **reporta** (no se impone) en derivación mediante `isValidSpellType()`. Es una decisión de diseño: se prefiere un campo permisivo más una validación informativa, a un `choices` exhaustivo que rompería la importación ante cualquier combinación no prevista.

#### `areaOfEffect`, `duration`, `range`, `description`

Estos cuatro son texto libre porque en el libro son **expresiones**, no enumeraciones cerradas: `areaOfEffect` puede ser `"caster"`, `"1 limb"`, `"1 curse"`, `"4 oz. water"`; `duration` puede ser `"1 min/lvl (C)"`, `"—"`, `"P"`; `range` puede ser `"self"`, `"touch"`, `"100'"`. Sus formas canónicas y su significado se documentan en la leyenda (secciones `areasOfEffect`, `durations`, `ranges`), pero el dato concreto del hechizo es una instancia literal de esas plantillas, con números reales sustituidos. `description` es un `HTMLField` (texto enriquecido) porque la descripción del hechizo puede contener formato.

### La clave estática: por qué la leyenda NO se persiste

Aquí está la decisión más importante de la sección. La *Spell Description Key* (Apéndice A-9.3) — la leyenda completa con los significados de cada código especial, cada tipo, sub-tipo, área de efecto, duración, rango y el glosario de definiciones — **es idéntica para las 96 listas**. Vive una sola vez en [constants.mjs:131](module/utils/constants.mjs#L131) como `SPELL_DESCRIPTION_KEY`, un objeto profundamente congelado (`_deepFreeze`), y se expone en [rmf.mjs:196](rmf.mjs#L196) como `CONFIG.RMF.spellDescriptionKey`.

El razonamiento, anotado literalmente en [constants.mjs:117](module/utils/constants.mjs#L117), es:

> It is NOT persisted on each `spellList` item (that would duplicate ~5 KB per document and force a migration to fix any wording).

Es decir:

1. **Coste de almacenamiento.** Si cada item `spellList` guardara la leyenda, serían ~5 KB × 96 listas ≈ medio megabyte de texto **idéntico** repetido en la base de datos del mundo, más en cada actor que arrastrara copias.
2. **Coste de mantenimiento (erratas).** Si el texto de la leyenda tuviera una errata, corregirla exigiría una **migración** que reescribiera los 96 documentos. Al vivir en código, una errata se arregla cambiando una constante y publicando una versión del sistema, sin tocar dato persistido.
3. **Única fuente de verdad.** Al ser una constante en código, esquema y leyenda no pueden divergir: de hecho los conjuntos de validación se **derivan** de ella ([constants.mjs:204-220](module/utils/constants.mjs#L204)):

```js
export const SPELL_TYPE_CODES    = Object.freeze(Object.keys(SPELL_DESCRIPTION_KEY.spellTypes));    // E, BE, DE, F, P, U, I
export const SPELL_SUBTYPE_CODES = Object.freeze(Object.keys(SPELL_DESCRIPTION_KEY.spellSubTypes)); // s, m
export const SPELL_SPECIAL_CODES = Object.freeze(
  Object.keys(SPELL_DESCRIPTION_KEY.specialCodes).filter(k => k !== "rrMod"));                       // instantaneous, noPowerPoints, spellSet
```

El esquema de `spellEntry()` importa esas tres constantes y las usa como `choices` de `codes` y como universo de validación de `type`. Así, **añadir un tipo nuevo a la leyenda lo habilita automáticamente** en validación, sin tocar el modelo de datos.

El texto canónico de la leyenda es la redacción inglesa del libro; la UI puede localizar las **etiquetas cortas** vía claves `RMF.SpellKey.*`, pero el cuerpo doctrinal se mantiene como referencia. La sheet ([spell-list-sheet.js:91](module/spell-list-sheet.js#L91), clase `RMFSpellListSheet`) lee la leyenda con `context.key = CONFIG.RMF?.spellDescriptionKey ?? {}` para renderizar tooltips y la pestaña de ayuda ("key"), confirmando que el consumo es **por lectura desde `CONFIG`**, nunca desde el documento.

### Validación: `isValidSpellType(type)`

El método estático `isValidSpellType()` ([spell-list.mjs:144](module/data-models/spell-list.mjs#L144)) decide si un `type` compuesto es válido contra la leyenda:

```js
static isValidSpellType(type) {
  if (typeof type !== "string" || !type) return false;
  // Código base más largo primero, para que "DE"/"BE" ganen a "D"/"B".
  const base = [...SPELL_TYPE_CODES]
    .sort((a, b) => b.length - a.length)
    .find(code => type.startsWith(code));
  if (!base) return false;
  const rest = type.slice(base.length);
  return [...rest].every(ch => SPELL_SUBTYPE_CODES.includes(ch));
}
```

El algoritmo es: localizar un **prefijo base** válido y comprobar que **todo lo que queda** detrás son sub-tipos válidos. El detalle fino es el `sort` por longitud descendente: como `BE` y `DE` comienzan por letras que también podrían confundirse con bases de una sola letra si las hubiera, ordenar de más largo a más corto garantiza que un `"DE"` se reconozca como base `DE` (resto vacío → válido) y no se interprete mal. Para `"Fm"`: base `F`, resto `"m"`, que es sub-tipo válido → válido. Para `"Us"`: base `U`, resto `"s"` → válido. Un tipo vacío se considera inválido, pero esa invalidez **solo se reporta para hechizos con nombre** (los niveles vacíos no se evalúan), como se ve en la derivación.

### Datos derivados: `prepareDerivedData()`

`prepareDerivedData()` ([spell-list.mjs:112](module/data-models/spell-list.mjs#L112)) recorre `spells[]` una sola vez y calcula agregados de conveniencia para la sheet, **sin persistirlos** (son propiedades derivadas, recalculadas en cada preparación del documento):

```js
prepareDerivedData() {
  super.prepareDerivedData();
  const spells = this.spells ?? [];
  const filled = [], emptyLevels = [], invalidTypes = [];
  let hasSpellSet = false;
  for (const s of spells) {
    if (!s?.name) { emptyLevels.push(s?.level); continue; }   // nivel vacío
    filled.push(s);
    if ((s.codes ?? []).includes("spellSet")) hasSpellSet = true;
    if (!SpellListData.isValidSpellType(s.type)) invalidTypes.push(s.type);
  }
  this.filledSpells = filled;
  this.totalSpells  = filled.length;
  this.emptyLevels  = emptyLevels;
  this.hasSpellSet  = hasSpellSet;
  this.invalidTypes = invalidTypes;
  this.isBaseList   = this.listType === "Base";
}
```

| Derivado | Qué es | Para qué |
|---|---|---|
| `filledSpells` | hechizos con `name` no vacío | La sheet lista solo los hechizos reales. |
| `totalSpells` | `filledSpells.length` | Recuento mostrado en cabecera. |
| `emptyLevels` | números de nivel sin hechizo | Permite a la sheet marcar/saltar los huecos. |
| `hasSpellSet` | hay algún hechizo con `‡` | Activa un aviso de "esta lista contiene conjuntos de hechizos". |
| `invalidTypes` | tipos no resolubles contra la leyenda | Diagnóstico de calidad de datos: vacío cuando todos los tipos son válidos. |
| `isBaseList` | `listType === "Base"` | Conmuta la presentación de la profesión propietaria. |

El bucle hace coincidir exactamente "nivel vacío" con "validación de tipo no aplicable": el `continue` sobre `!s?.name` asegura que un nivel en blanco no contamine `invalidTypes` con un `type` vacío. `invalidTypes` no es un error de carga sino una **señal de auditoría**: si tras importar el libro alguna lista deja entradas aquí, indica una errata de transcripción del tipo, no un fallo del sistema.

### Cómo se une todo al actor

A diferencia de skills, categorías o profesiones, una `spellList` **no participa en ninguna cadena de derivación del actor** en el código actual. No aporta bonos, no consume PP, no se resuelve contra tablas. Es contenido embebido o referenciado: un personaje "tiene" listas de hechizos como items en su inventario, y la sheet de la lista las muestra en modo lectura/edición, pero no hay un `prepareDerivedData()` del actor que las consulte ni un hook que las dispare. La identidad estable (`slug`, vía [slug.mjs](module/utils/slug.mjs)) está presente en el esquema para que, **cuando** exista un motor de magia, los joins lista↔profesión↔personaje se hagan por identidad y no por nombre traducible — pero ese consumo todavía no se ha implementado.

### Forma de los datos de origen (`data/*-lists.json`)

Hay **9 archivos** en [data/](data), uno por combinación reino×clase: `{open,closed,base}-{channeling,essence,mentalism}-lists.json`. Cada archivo tiene la forma `{ "lists": [ ... ] }`. Los seis archivos `open-*` y `closed-*` traen **10 listas** cada uno y los tres `base-*` traen **12 listas** cada uno, sumando exactamente las **96 listas** del set básico de RMF. Cada lista trae `name, realm, type, reference, specialNotes, spells[]`, y `profession` (que vale `"None"` en Open/Closed y la profesión propietaria en las de Base). En cada hechizo del JSON las claves presentes son `level, name, areaOfEffect, duration, range, type, description`, y opcionalmente `codes` y `rrMod` solo cuando el libro los marca (109 hechizos llevan `codes`, 5 llevan `rrMod`). Un nivel sin hechizo se escribe `{"level": N, "name": null}`, que el importador normaliza al `name: ""` del esquema. Ejemplo real (Base, Channeling):

```json
{ "name": "Channels", "realm": "Channeling", "type": "Base", "profession": "Cleric", "reference": "A-9.7.1", ... }
```

La cabecera del modelo declara explícitamente que su esquema "espeja" (`Mirrors the shape`) la estructura de estos JSON ([spell-list.mjs:4](module/data-models/spell-list.mjs#L4)): el modelo de datos se diseñó para que la importación sea una correspondencia casi directa, con las únicas transformaciones ya descritas (renombrar `type`→`listType`, normalizar símbolos→claves y `null`→`""`).

### Por qué Item con 10 niveles fijos (y no, p. ej., una RollTable)

Cierra la sección la justificación del modelado. Una lista de hechizos **no** es una tabla de tiradas (no se "tira" sobre ella), así que una `RollTable` sería un abuso semántico. Tampoco es un sub-documento embebido en el actor, porque debe poder vivir como **contenido de compendio reutilizable** y compartirse entre personajes. Un `Item` de subtipo propio (`spellList`) aporta exactamente lo que se necesita: persistencia, identidad, una sheet dedicada y la capacidad de residir en compendios. La estructura de **10 niveles fijos** refleja literalmente la mecánica RMF (toda lista se desarrolla por niveles 1-10), y mantenerlos siempre presentes —incluso vacíos— hace que la presentación sea predecible y que un futuro motor de "qué hechizos conoce el personaje según su rango en la lista" pueda indexar por nivel sin tratar huecos como casos especiales.

---

## Combate: tablas de ataque y el motor multidimensional

Rolemaster resuelve el combate consultando *tablas de ataque*: una matriz impresa donde las **filas** son bandas del total de ataque modificado, las **columnas** son el *Armor Type* (AT) del defensor —del 1 (sin armadura) al 20 (placas completas)— y cada **celda** codifica en una cadena minúscula el resultado completo del golpe, p. ej. `"12E"` = 12 *concussion hits* más un crítico de severidad `E`. Esta sección documenta cómo ese objeto bidimensional de papel se modela como dato de Item ([attack-table.mjs](module/data-models/attack-table.mjs)) y cómo un motor puro y desacoplado en [module/tables/](module/tables/) lo consulta, expuesto al runtime como `game.rmf.tables`.

### Por qué un Item DataModel y no un RollTable

FoundryVTT **no tiene un documento de tabla 2-D nativo**. El documento `RollTable` del core es estrictamente unidimensional: una tirada (típicamente sobre un rango) selecciona *un* resultado de una lista plana. Una tabla de ataque de Rolemaster tiene dos ejes (banda de total × AT) y, además, cada celda no es texto libre sino un dato estructurado (daño + severidad crítica). Forzar eso en `RollTable` exigiría 20 tablas por arma (una por AT) o codificar la matriz en `flags`, perdiendo el modelo de datos validado.

La decisión de diseño —documentada en la cabecera de [attack-table.mjs:6-10](module/data-models/attack-table.mjs#L6)— es modelar la matriz como `system` data de un Item del tipo `attackTable`, **exactamente el mismo enfoque que las listas de hechizos** (`spellList`). Las ventajas:

- **Validación de esquema**: `foundry.data.fields` valida la forma al cargar y al editar en la hoja.
- **El JSON es idéntico a la página impresa** ([attack-table.mjs:19-21](module/data-models/attack-table.mjs#L19)): `data/attack-tables/*.json` se puede transcribir directamente del libro y se importa sin transformación.
- **Es un Item normal**: vive en el compendio mundial, se exporta/importa, se traduce y se versiona como cualquier otro contenido del sistema.

Crucialmente, **el dato (Item) y la lógica (motor) están separados**. El DataModel no consulta nada por sí mismo: delega en el motor puro de [module/tables/](module/tables/). Esto se discute en la subsección final.

### El esquema (`AttackTableData`)

`AttackTableData extends foundry.abstract.TypeDataModel` ([attack-table.mjs:43](module/data-models/attack-table.mjs#L43)). Sus campos se agrupan en tres categorías: identidad/metadatos, los dos "campos puente" hacia el resto del combate, y la matriz.

#### Metadatos e identidad

| Campo | Tipo | Significado |
|---|---|---|
| `tableId` | `StringField` blank | Id de sección del libro, p. ej. `"A-10.9.1"`. |
| `slug` | `slugField()` | Identidad estable e independiente del idioma (refactor Fase 0). Ver [_identity.mjs](module/data-models/_identity.mjs) y [slug.mjs](module/utils/slug.mjs). |
| `fromBook` | `StringField` (`"basic"`) | Origen del contenido. |
| `armorTypes` | `ArrayField` de `{name, ats[]}` | **Solo presentación.** Agrupa las 20 columnas AT bajo nombres de armadura (Plate→AT 17-20, Chain→13-16, etc.). |
| `legend` | `ObjectField` nullable | Clave de notación de celda, copiada verbatim para la hoja. |
| `rollMatchPolicy` | `StringField` blank | Nota informativa sobre cómo casan `rollMin`/`rollMax`. |

El comentario en [attack-table.mjs:58-59](module/data-models/attack-table.mjs#L58) es explícito y es una **decisión de diseño** importante: `armorTypes` **no afecta a la búsqueda**. La consulta es siempre por AT individual; `armorTypes` existe únicamente para que la hoja renderice cabeceras agrupadas como en el libro. Mantener esa separación evita que un agrupamiento cosmético corrompa la resolución mecánica. (En la tabla real `Plate` agrupa los AT 20-19-18-17 y `Chain` los 16-15-14-13, en orden descendente: [one-handed-concussion.json:9-26](data/attack-tables/one-handed-concussion.json#L9).)

#### Los dos campos puente

Estos conectan la tabla con el flujo de combate ([attack-table.mjs:12-18](module/data-models/attack-table.mjs#L12)):

- **`critType`** (`StringField`, p. ej. `"Krush"`): cuando una celda devuelve una severidad crítica, indica **en qué tabla de críticos** se encadena. Las armas de concusión a una mano usan la tabla *Krush* ([one-handed-concussion.json:4](data/attack-tables/one-handed-concussion.json#L4)). Este campo es lo que permitirá (en una fase posterior) saltar de "golpe con severidad E" a la tabla de críticos correcta sin acoplar la tabla de ataque a un identificador de crítico hardcodeado.

- **`fumbleRange`** (`SchemaField {min, max}`, por defecto `{1, 2}`): la banda del **dado natural sin modificar** que fuerza una pifia ([attack-table.mjs:54-57](module/data-models/attack-table.mjs#L54)). Es per‑arma; la tabla lleva un valor por defecto sensato. En la concusión a una mano es `UM 01-02`. El motor compara el dado natural (no el total) contra esta banda.

#### La matriz: `rows`

`rows` es un `ArrayField` de `rowEntry()` ([attack-table.mjs:32-41](module/data-models/attack-table.mjs#L32)), declarado con `initial: []` en [attack-table.mjs:75](module/data-models/attack-table.mjs#L75). Cada fila es:

```js
{
  label:   StringField,                 // "148-150", "XX-33"… etiqueta humana
  rollMin: NumberField nullable (null), // null = banda catch-all inferior
  rollMax: NumberField (0),             // tope de la banda (inclusivo)
  results: ObjectField ({})             // AT (clave string) → texto de celda
}
```

Tres decisiones de forma de dato importan aquí:

1. **`results` es un `ObjectField` keyed por AT**, no un array. La cabecera lo justifica ([attack-table.mjs:19-21](module/data-models/attack-table.mjs#L19)): da búsquedas `results[String(at)]` en **O(1)** y mantiene el JSON idéntico a la página (`{"20": "12E", …, "1": "23E"}`). Las claves son *strings* porque las claves de objeto JSON siempre lo son; por eso toda la cadena de búsqueda usa `String(at)`.

2. **`rollMin: null` es la banda catch-all inferior** ([attack-table.mjs:36](module/data-models/attack-table.mjs#L36)). En lugar de meter un número arbitrario muy negativo, `null` significa "cualquier total ≤ `rollMax`". En la tabla real es la fila `"XX-33"` ([one-handed-concussion.json:1119-1121](data/attack-tables/one-handed-concussion.json#L1119)): cualquier total de 33 o menos cae aquí (todo `-`, sin efecto). Esta regla vive en el **motor**, no en el dato, para mantener el JSON limpio.

3. **Las bandas son inclusivas y contiguas** (p. ej. `148-150`, `145-147`, `142-144`…), reflejando los incrementos de 3 puntos del libro.

#### La fila de pifia: `fumble`

Aparte de `rows`, el esquema tiene un `SchemaField` `fumble` ([attack-table.mjs:77-81](module/data-models/attack-table.mjs#L77)) con `label`, `description` y un `results` keyed por AT donde **cada AT mapea a `"F"`**. En el JSON es la fila `UM 01-XX` ([one-handed-concussion.json:1146-1148](data/attack-tables/one-handed-concussion.json#L1146)): cuando el dado natural cae en `fumbleRange`, todas las columnas devuelven pifia. Conceptualmente es una fila más, pero se separa porque se dispara por el dado *natural* (no por el total modificado), así que no participa en la búsqueda por banda.

### Derivación y unión con la hoja

`prepareDerivedData()` ([attack-table.mjs:96-103](module/data-models/attack-table.mjs#L96)) calcula tres agregados **derivados, no persistidos** (se recomputan en cada carga porque son función pura de `rows`):

- `this.columns = tableColumns(this)` — las claves AT en orden descendente (20→1), como la página impresa.
- `this.rowCount` — número de bandas (`rows.length`).
- `this.maxRow` — el `rollMax` más alto de toda la tabla; es el **techo de clamp** para tiradas abiertas (ver más abajo). Se calcula con un `reduce` que ignora valores no finitos y cae a `0` si no hay filas ([attack-table.mjs:101-102](module/data-models/attack-table.mjs#L101)).

La hoja ([attack-table-sheet.js](module/attack-table-sheet.js)) consume estos derivados para renderizar la matriz. Que sean derivados y no persistidos es deliberado: la única fuente de verdad es `rows`; cualquier edición de filas reconstruye automáticamente columnas/conteos sin riesgo de desincronización.

El DataModel también ofrece un atajo de instancia, `lookup(total, at)` ([attack-table.mjs:116-118](module/data-models/attack-table.mjs#L116)), que **delega directamente** en `lookupAttack(this, total, at)` del motor. El comentario es explícito sobre el porqué ([attack-table.mjs:110-111](module/data-models/attack-table.mjs#L110)): así "el DataModel y el resolver de ataque nunca divergen" — hay una sola implementación de la lógica de búsqueda.

### El motor: `module/tables/` y `game.rmf.tables`

Toda la lógica vive en [module/tables/](module/tables/), un conjunto de **módulos puros sin dependencias de Foundry** (salvo `open-ended.mjs`, que usa `Roll` para integrarse con Dice So Nice). [index.mjs](module/tables/index.mjs) es la única superficie pública: reexporta las funciones y las empaqueta en `TablesAPI` ([index.mjs:37-45](module/tables/index.mjs#L37)). En `ready`, [hooks.mjs:121](module/hooks.mjs#L121) hace `game.rmf.tables = TablesAPI`, espejando cómo se exponen los importers en `game.rmf.*`.

La cabecera de [index.mjs:4-7](module/tables/index.mjs#L4) declara la intención arquitectónica: este es un **límite limpio** para que toda la carpeta pueda extraerse algún día a un módulo independiente con solo moverla y declarar la dependencia (la "opción C"). Por eso ningún código fuera de `module/tables/` toca la lógica interna; todo pasa por `game.rmf.tables` o por el `lookup()` del DataModel.

```
game.rmf.tables (TablesAPI)
├─ parseCell / describeCell     ← cell-parser.mjs   (texto de celda → estructura)
├─ findAttackRow / lookupAttack / tableColumns ← lookup.mjs (motor multidimensional)
├─ rollOpenEndedD100            ← open-ended.mjs    (d100 abierto de RM)
└─ resolveAttack                ← attack-resolver.mjs (orquestador)
```

#### El "truco" multidimensional: por qué una tabla N-D colapsa a 1-D

La idea central está en la cabecera de [lookup.mjs:4-11](module/tables/lookup.mjs#L4). Una tabla de Rolemaster *parece* bidimensional, pero **solo un eje es aleatorio**: la tirada. La columna (el AT del objetivo) **se conoce antes** de mirar la tabla. Por tanto, en tiempo de consulta una tabla N-dimensional colapsa a una búsqueda 1-D:

1. quien llama ya conoce la columna (el AT) → se selecciona esa clave;
2. se busca la fila cuya banda `[rollMin, rollMax]` contiene el total;
3. se lee `row.results[columna]` y se parsea.

Esto generaliza: cualquier tabla de Rolemaster cuyos ejes adicionales sean conocidos a priori (no aleatorios) usa el mismo motor. Por eso `lookup.mjs` opera sobre objetos "table-shaped" planos y funciona igual con una instancia de DataModel que con un JSON crudo ([lookup.mjs:19-21](module/tables/lookup.mjs#L19)).

#### `findAttackRow(table, total)` — buscar la fila

[lookup.mjs:44-70](module/tables/lookup.mjs#L44). Recorre `rows` una vez y aplica **dos reglas de borde** que viven en el motor, no en el dato:

- **Catch-all inferior**: si `rollMin` es `null`/`undefined`, el límite inferior se trata como `-Infinity` ([lookup.mjs:59-61](module/tables/lookup.mjs#L59)), así que esa fila (la `XX-33`) casa con cualquier total `≤ rollMax`.
- **Clamp superior (tiradas abiertas)**: mientras recorre, va guardando la fila de mayor `rollMax` (`highest`). Si el total **supera todas las bandas impresas** —lo que puede ocurrir porque la d100 abierta no tiene techo— devuelve la banda más alta ([lookup.mjs:66-67](module/tables/lookup.mjs#L66)). Sin esto, un golpe excepcional (total 160 en una tabla que llega a 150) no encontraría fila.

La coincidencia normal es `n >= min && n <= max` (ambos inclusivos, [lookup.mjs:63](module/tables/lookup.mjs#L63)). Si nada casa y no aplica el clamp, devuelve `null`.

#### `lookupAttack(table, total, column)` — la búsqueda completa

[lookup.mjs:80-85](module/tables/lookup.mjs#L80). Encadena `findAttackRow` con la lectura de columna:

```js
const row = findAttackRow(table, total);
const key = String(column);                 // las claves de results son strings
const raw = row?.results?.[key];
return { ...parseCell(raw), row, column: key };
```

Devuelve el `ParsedCell` enriquecido con la `row` y la `column` resueltas. Nótese el `?.` encadenado: si no hay fila, `raw` es `undefined` y `parseCell(undefined)` devuelve un *miss* limpio en lugar de fallar.

`tableColumns(table)` ([lookup.mjs:95-103](module/tables/lookup.mjs#L95)) extrae las claves de columna de la primera fila no vacía (representativa), las filtra a números finitos y las ordena **descendente** (20→1) para que la hoja se vea como el libro.

#### `parseCell` — de `"12E"` a estructura

[cell-parser.mjs](module/tables/cell-parser.mjs). Función **pura** que convierte la cadena de celda en un `ParsedCell { kind, hits, critSeverity, raw }` para que el resto del motor nunca tenga que re-parsear. Las reglas, en orden:

| Entrada | `kind` | `hits` | `critSeverity` |
|---|---|---|---|
| `""`, `"-"`, `"—"`, `"–"`, `null`, `undefined` | `"miss"` | 0 | `null` |
| `"F"` (insensible a mayúsculas) | `"fumble"` | 0 | `null` |
| `"12E"`, `"7"`, `"9B"` (regex `^(\d+)\s*([A-Ea-e])?$`) | `"hit"` | el número | la letra en mayúscula o `null` |
| `"E"` sola (regex `^([A-Ea-e])$`) | `"hit"` | 0 | la letra |
| cualquier otra cosa | `"unknown"` | 0 | `null` |

El conjunto `MISS_TOKENS` ([cell-parser.mjs:28](module/tables/cell-parser.mjs#L28)) incluye tres variantes de guion (ASCII `-`, em-dash `—`, en-dash `–`) porque las transcripciones del PDF pueden usar cualquiera. La severidad se normaliza siempre a mayúscula ([cell-parser.mjs:52](module/tables/cell-parser.mjs#L52)). `describeCell(cell)` ([cell-parser.mjs:72-83](module/tables/cell-parser.mjs#L72)) produce una etiqueta humana corta (`"12 hits + E crit"`) para tarjetas de chat y tooltips.

#### `rollOpenEndedD100` — la d100 abierta de Rolemaster

[open-ended.mjs](module/tables/open-ended.mjs). El dado característico de Rolemaster: una d100 que "explota". Parámetros por defecto ([open-ended.mjs:38-40](module/tables/open-ended.mjs#L38)):

```js
{ high = true, low = false, highAt = 96, lowAt = 5, cap = 25 }
```

El algoritmo:

1. Tira `1d100` → `natural`. `total = natural` ([open-ended.mjs:53-54](module/tables/open-ended.mjs#L53)).
2. **Abierta alta** (por defecto activa): si `natural >= highAt` (96), marca `openHigh` y sigue **sumando** re-tiradas mientras la última siga siendo `>= highAt`, hasta un máximo de `cap = 25` iteraciones (cota de seguridad) ([open-ended.mjs:59-67](module/tables/open-ended.mjs#L59)).
3. **Abierta baja** (desactivada por defecto): si `natural <= lowAt` (5), marca `openLow` y **resta** una única re-tirada ([open-ended.mjs:68-73](module/tables/open-ended.mjs#L68)).

La rama alta y la baja son **mutuamente excluyentes** (`if … else if` en [open-ended.mjs:59](module/tables/open-ended.mjs#L59) y [open-ended.mjs:68](module/tables/open-ended.mjs#L68)). La asimetría es por diseño y modela la regla del libro: **los ataques son abiertos solo hacia arriba**. La abierta alta es recursiva (puede explotar varias veces); la baja es una sola re-tirada restada (convención de ataque RMFR). Por eso `low = false` por defecto en ataques, pero el parámetro existe para reutilizar la función en tiradas donde sí aplica la abierta baja.

Cada sub-tirada usa `new Roll("1d100")` real ([open-ended.mjs:45-46](module/tables/open-ended.mjs#L45)) para que cada dado participe en Dice So Nice y en el log de dados. El resultado incluye `natural` (el primer dado, que gobierna las pifias), `total` (la suma explotada), `dice[]`, los flags `openHigh`/`openLow` y los objetos `Roll` (`rolls`) para el chat ([open-ended.mjs:75](module/tables/open-ended.mjs#L75)). El resolver puede recibir una tirada precomputada para tests sin dados.

#### `resolveAttack` — el orquestador

[attack-resolver.mjs](module/tables/attack-resolver.mjs). Ata todas las piezas para un único ataque de un arma. La secuencia ([attack-resolver.mjs:55-101](module/tables/attack-resolver.mjs#L55)):

1. **Tirada**: `roll ?? await rollOpenEndedD100({ high: true, low: false })`. Acepta una tirada precomputada para tests ([attack-resolver.mjs:63](module/tables/attack-resolver.mjs#L63)).

2. **Chequeo de pifia sobre el dado NATURAL** (no el total): toma `fumbleRange` del parámetro, de `table.fumbleRange`, o el por defecto `{1,2}`, y comprueba `natural >= fr.min && natural <= fr.max` ([attack-resolver.mjs:67-69](module/tables/attack-resolver.mjs#L67)). Usar el dado sin modificar es la regla de RM: una pifia depende de lo que mostró el dado, no del total tras sumar bonos.

3. **Total de ataque** — la fórmula central ([attack-resolver.mjs:71](module/tables/attack-resolver.mjs#L71)):

   ```
   attackTotal = rollTotal + OB + mods − targetDB
   ```

   - `rollTotal`: la d100 abierta (posiblemente explotada).
   - `OB` (*Offensive Bonus*): el bono ofensivo del atacante con esa arma.
   - `mods`: modificadores situacionales netos (cobertura, posición, etc.).
   - `targetDB` (*Defensive Bonus*): el bono defensivo del objetivo, **restado** porque representa cuánto se defiende el blanco. Esta es la ecuación de ataque canónica de Rolemaster.

4. **Cortocircuito de pifia**: si `isFumble`, devuelve inmediatamente con `cell = { kind: "fumble", … raw: "F" }` y `needsCritical: false`, **sin** consultar la matriz ([attack-resolver.mjs:87-93](module/tables/attack-resolver.mjs#L87)). Una pifia no busca daño; abre la tabla de pifias del arma.

5. **Búsqueda**: en caso normal, `lookupAttack(table, attackTotal, targetAT)` resuelve `[attackTotal][targetAT]` → celda parseada ([attack-resolver.mjs:95](module/tables/attack-resolver.mjs#L95)).

6. **Resultado**: el `AttackResult` lleva `fumble`, `natural`, `rollTotal`, `openHigh`, `ob`, `mods`, `targetAT`, `targetDB`, `attackTotal`, `critType` (copiado de la tabla en [attack-resolver.mjs:83](module/tables/attack-resolver.mjs#L83)), la `cell` parseada y **`needsCritical = !!cell.critSeverity`** ([attack-resolver.mjs:99](module/tables/attack-resolver.mjs#L99)). (El campo `critType` se fija ya en el objeto `base`, antes del cortocircuito de pifia, por lo que viaja en ambos caminos de retorno.)

El campo `needsCritical` junto con `critType` es la **bisagra hacia los críticos**: cuando la celda devuelve una severidad (p. ej. `E`), `needsCritical` es `true` y `critType` (p. ej. `"Krush"`) dice qué tabla de críticos consultar a continuación. La resolución del crítico en sí **no se hace aquí todavía** ([attack-resolver.mjs:14-16](module/tables/attack-resolver.mjs#L14)): las tablas de críticos son un conjunto de datos separado y un trabajo pendiente. El resolver deja el resultado inequívoco para ese siguiente paso, sin acoplarse a él.

### Cómo encaja con el combate y el actor

El flujo completo de un ataque, vinculando el actor atacante, el objetivo y la tabla del arma:

```
Atacante (Actor)        Arma (Item attackTable + OB del atacante)      Objetivo (Actor)
      │                              │                                       │
      │  OB, mods ───────────────────┤                                       │
      │                              │◀──── targetAT, targetDB ──────────────┤
      ▼                              ▼                                       ▼
            game.rmf.tables.resolveAttack({ table, ob, mods, targetAT, targetDB })
                                     │
        rollOpenEndedD100 ──► rollTotal,natural ──► fumble? ──► attackTotal = rollTotal+OB+mods−targetDB
                                     │
                       lookupAttack(table, attackTotal, targetAT)  ──►  ParsedCell
                                     │
                  hits  ──► daño al objetivo      critSeverity + critType ──► (tabla de críticos, pendiente)
```

El motor **no lee ni escribe el actor directamente**: recibe `ob`, `mods`, `targetAT`, `targetDB` como números planos y devuelve un `AttackResult`. Esta es la razón del desacoplo:

- **Testabilidad**: al ser funciones puras (con `roll` inyectable), el motor se prueba sin Foundry ni dados.
- **Reusabilidad**: la misma `lookupAttack` sirve para la hoja del Item (vista previa de celdas) y para el resolver de combate; una sola implementación, cero divergencia.
- **Portabilidad**: la carpeta entera puede convertirse en módulo independiente sin tocar el resto del sistema ([index.mjs:4-7](module/tables/index.mjs#L4)).

Quien orquesta el combate (la hoja del actor o un diálogo de ataque) es responsable de **leer del actor** el `OB` con el arma seleccionada y de **leer del objetivo** su `AT` y `DB`, pasarlos al motor, y luego **aplicar los `hits` como daño** al actor objetivo y —cuando llegue la fase de críticos— encadenar a la tabla `critType`. Esa frontera mantiene el motor de tablas agnóstico del modelo de personaje, igual que las tablas de hechizos y el resto de subsistemas derivados.

---

## Tiradas y mecánica d100 (actions)

El núcleo de interacción del personaje vive en [actions.mjs](module/actions.mjs): un único módulo `RMFActions` que centraliza **todas** las tiradas y manipulaciones que un jugador dispara desde la ficha (tirar una característica, una habilidad, una categoría, defensa, resistencia; crear/editar/borrar items; cambiar imagen; subir/bajar rangos). Cada interacción es una *acción declarativa* registrada en una tabla estática, no un listener atado a mano. A continuación se explica el patrón, la construcción de la fórmula d100, cada tipo de tirada con su fórmula exacta y su raíz en las reglas de Rolemaster, y cómo todo esto se conecta al actor y al combate.

### El patrón de acciones declarativas de ApplicationV2

En ApplicationV2 (FoundryVTT v13.341) una sheet no engancha eventos imperativamente en `activateListeners(html)` (el patrón V1). En su lugar declara un diccionario `actions` dentro de `DEFAULT_OPTIONS`, donde cada clave es un nombre de acción y su valor es la función manejadora. El framework hace la delegación de eventos automáticamente: cualquier elemento del DOM con `data-action="<nombre>"` que reciba un `click` invoca el handler correspondiente con la firma `(event, target)` y con `this` ligado a la instancia de la sheet.

La ficha de actor lo cablea así ([actor-sheet.js:56-67](module/actor-sheet.js#L56)):

```js
actions: {
  rollStat: RMFActions.handlers.rollStat,
  rollSkill: RMFActions.handlers.rollSkill,
  rollDefensive: RMFActions.handlers.rollDefensive,
  rollResistance: RMFActions.handlers.rollResistance,
  rollCategory: RMFActions.handlers.rollCategory,
  rollCategoryNoSkill: RMFActions.handlers.rollCategoryNoSkill,
  editItem: RMFActions.handlers.editItem,
  deleteItem: RMFActions.handlers.deleteItem,
  createItem: RMFActions.handlers.createItem,
  pickImage: RMFActions.handlers.pickImage,
}
```

Y en la plantilla, el `<a>` de una característica lleva el atributo declarativo dentro de una fila que también porta `data-stat` ([actor-stats.hbs:27-35](templates/parts/actor-stats.hbs#L27)):

```hbs
<tr data-stat="{{key}}">
  ...
  <a class="stat-name rollable" data-action="rollStat" data-stat="{{key}}">
```

**Por qué este patrón (decisión de diseño, no regla del libro).** El objeto `RMFActions.handlers` se deriva automáticamente del registro `RMFActions.actions` con `Object.fromEntries` ([actions.mjs:138-140](module/actions.mjs#L138)), de modo que basta declarar la acción una vez (con sus metadatos: `handler`, `requiresTarget`, `permission`, `description`) y queda disponible como handler para cualquier sheet. Esto centraliza la lógica de tirada fuera de las sheets: la misma `rollStat` la consumen actor-sheet y, potencialmente, otras vistas, sin duplicar código ni reenganchar listeners en cada `_onRender`. El framework de ApplicationV2 ya hace la delegación, así que no hay riesgo de listeners duplicados al re-renderizar (un problema clásico del patrón V1 que el código sí tiene que mitigar a mano en los listeners de inputs, ver `_setupStatListeners` [actor-sheet.js:728-747](module/actor-sheet.js#L728)).

Las distintas sheets registran solo el subconjunto de acciones que usan: la skill-sheet y la category-sheet, por ejemplo, solo registran `pickImage` ([skill-sheet.js:42-44](module/skill-sheet.js#L42), [category-sheet.js:33](module/category-sheet.js#L33)).

#### Validación y permisos: `RMFActions.perform`

Aunque las sheets enchufan los handlers privados directamente, existe un envoltorio `RMFActions.perform(actionName, context, event, target)` ([actions.mjs:154-188](module/actions.mjs#L154)) que aporta validación uniforme:

1. Resuelve la acción del registro; si no existe, registra el error en consola y lanza una excepción.
2. Si `requiresTarget` es `true` y no hay `target`, aborta (las tiradas necesitan el elemento clicado para leer `data-stat`, `data-item-id`, etc.).
3. Si la acción declara `permission` y hay `context.document`, comprueba `document.testUserPermission(game.user, action.permission)`; si falla, avisa con `ui.notifications.warn` y devuelve `null`. Todas las acciones declaran `"OWNER"`: solo el dueño del actor puede tirar o modificar.
4. Ejecuta `action.handler.call(context, event, target)` envuelto en try/catch, notificando errores vía `ui.notifications.error` y relanzando la excepción.

Es la guardia de permisos y errores; los handlers en sí no la repiten.

### Construcción de la fórmula: `#buildD100Formula`

Todas las tiradas de característica/habilidad/categoría/defensa/resistencia comparten un helper que blinda la coerción del bono ([actions.mjs:218-222](module/actions.mjs#L218)):

```js
static #buildD100Formula(rawBonus) {
  const n = Number(rawBonus);
  const bonus = Number.isFinite(n) ? Math.trunc(n) : 0;
  return { formula: `1d100${bonus >= 0 ? '+' : ''}${bonus}`, bonus };
}
```

**Forma del dato y por qué.** El bono entra como un valor arbitrario (`stat.total`, `skill.system.bonus`, `category.system.totalBonus`, etc.) que puede llegar `undefined`, `NaN`, string o número. El helper:

- Convierte con `Number(...)`.
- Si no es finito (bloque de stats a medio inicializar, item recién creado, dato heredado corrupto), cae a `0` en lugar de propagar `NaN` al parser de `Roll` —que lanzaría excepción y dejaría sin feedback al usuario—. Esto es una decisión de robustez ("NaN-safe"), no una regla de Rolemaster.
- Trunca a entero con `Math.trunc` (los bonos de RM son enteros).
- Emite la fórmula textual `1d100+N` o `1d100-N` con el signo correcto, y devuelve también el `bonus` ya saneado para mostrarlo en el chat.

**Por qué `1d100` plano y no la tirada abierta.** Rolemaster usa una d100 *abierta* ("open-ended": al sacar alto se vuelve a tirar y suma; al sacar bajo puede restar). Esa mecánica existe y está implementada en [open-ended.mjs](module/tables/open-ended.mjs), pero **solo la consume el motor de tablas de ataque** ([attack-resolver.mjs:63](module/tables/attack-resolver.mjs#L63), reexportada por [index.mjs:17](module/tables/index.mjs#L17) como `game.rmf.tables`), donde se invoca con `rollOpenEndedD100({ high: true, low: false })` porque el ataque RMFR es *high open-ended* únicamente. Las tiradas de maniobra/habilidad de la ficha usan deliberadamente `1d100` simple: es una **decisión de diseño** del sistema (de momento) mantener la tirada de habilidad como d100 cerrada y dejar la apertura para combate, donde el resolutor de tablas la aplica con `highAt=96` por defecto (explota al sacar ≥96, [open-ended.mjs:33](module/tables/open-ended.mjs#L33), [open-ended.mjs:59](module/tables/open-ended.mjs#L59)). En `rollOpenEndedD100` el parámetro `cap=25` limita las iteraciones de explosión como salvaguarda anti-bucle ([open-ended.mjs:39](module/tables/open-ended.mjs#L39), [open-ended.mjs:63](module/tables/open-ended.mjs#L63)).

### Las tiradas, una por una

Todas siguen el mismo esqueleto: leer el bono de la fuente correcta, construir la fórmula NaN-safe, `await new Roll(formula).evaluate()`, y publicar un mensaje de chat estilizado vía `#postStyledRollMessage`. La diferencia entre ellas es **de dónde sale el bono**.

| Acción | Atributo DOM que lee | Fuente del bono | Penalización extra |
|---|---|---|---|
| `rollStat` | `data-stat` (clave completa de característica, p. ej. `chAgility`) | `system.chStats[statKey].total` | — |
| `rollSkill` | `data-item-id` del ancestro más próximo | `skill.system.bonus` | — |
| `rollCategory` | `data-item-id` (en el propio `<a>`) | `category.system.totalBonus` | — |
| `rollCategoryNoSkill` | `data-item-id` (en el propio `<a>`) | `category.system.totalBonus` | `+ NO_SKILL_PENALTY` (−15) |
| `rollDefensive` | (ninguno) | `actor.system.derivedStats.defensiveBonus` | — |
| `rollResistance` | `data-resistance` | `actor.system.derivedStats.resistances[tipo]` | — |

#### `#rollStat` — tirada de característica

[actions.mjs:263-294](module/actions.mjs#L263). Lee `target.dataset.stat` (la clave canónica completa, p. ej. `chAgility`), recupera `this.document.system.chStats[statKey]` y usa **`stat.total`** como bono. La fórmula resultante es `1d100 + stat.total`.

`stat.total` es el valor derivado de la característica que ya incluye `basic + race + spec + ...` según el modelo de datos del personaje. Tirar `1d100 + total` modela la **maniobra estática basada en característica** de Rolemaster, donde el bono de característica se suma a la d100. El label se localiza con `RMF.Stats.<statKey>` ([actions.mjs:281](module/actions.mjs#L281)).

#### `#rollSkill` — tirada de habilidad

[actions.mjs:305-337](module/actions.mjs#L305). Sube por el DOM con `target.closest('[data-item-id]')` para obtener el id del item habilidad, lo recupera de `this.document.items` y tira `1d100 + skill.system.bonus`.

**Por qué `system.bonus`.** Ese campo es el **total derivado** de la habilidad: la suma de bono por rangos + bono de categoría + bonos de característica + especializaciones, precalculado por el data-model de skill en `prepareDerivedData`. La acción no recompone nada: confía en el dato ya derivado (separación clara entre *derivar* —en el modelo— y *tirar* —en la acción—). En la plantilla, cada habilidad muestra ese total tanto en el `title` del `<li>` (que lo desglosa como "Ranks ... + Category ... → Total") como en el `span.skill-total` ([actor-skills.hbs:39](templates/parts/actor-skills.hbs#L39), [actor-skills.hbs:46](templates/parts/actor-skills.hbs#L46)).

#### `#rollCategory` y `#rollCategoryNoSkill`

[actions.mjs:415-447](module/actions.mjs#L415) y [actions.mjs:459-495](module/actions.mjs#L459). Ambas leen el id de la categoría con `target.dataset.itemId` directamente (no con `closest`), porque el `<a data-action="rollCategory">` porta su propio `data-item-id` en la plantilla ([actor-skills.hbs:18-20](templates/parts/actor-skills.hbs#L18)). `rollCategory` tira `1d100 + category.system.totalBonus` (bono total de la categoría: rangos de categoría + características + bonos de profesión/especialización, derivado por el modelo de categoría).

`rollCategoryNoSkill` modela una regla canónica de Rolemaster: **tirar en una categoría sin tener rangos de la habilidad concreta** conlleva una penalización fija. La fórmula es:

```
baseBonus = trunc(category.system.totalBonus)   // NaN-safe
1d100 + (baseBonus + RMF_CONSTANTS.NO_SKILL_PENALTY)   // -15
```

El −15 sale de `RMF_CONSTANTS.NO_SKILL_PENALTY` ([constants.mjs:93](module/utils/constants.mjs#L93)), descrito en el propio código como "canonical Rolemaster -15" para tiradas contra una categoría con 0 rangos de la habilidad relevante. El label se compone como `"<categoría> (No skill)"` (la etiqueta "No skill" se localiza con `RMF.NoSkill` si existe, con fallback al literal inglés, [actions.mjs:479-482](module/actions.mjs#L479)).

Detalle de la sheet: el botón "No skill" **solo se muestra para categorías de progresión estándar**. El contexto lo calcula en [actor-sheet.js:174-185](module/actor-sheet.js#L174): lee `category.system.categoryRankBonusProgression`, lo normaliza (`trim().toLowerCase()`) y fija `showNoSkill = (progression === "standard")`, además de precalcular `noSkillTotal = categoryTotal + NO_SKILL_PENALTY` para previsualizar el total en el `title`. La razón es que la penalización de no-habilidad solo tiene sentido sobre la progresión estándar; las categorías no-estándar no exponen esa acción.

#### `#rollDefensive` — bono defensivo

[actions.mjs:348-369](module/actions.mjs#L348). No necesita `data-*`: lee directamente `actor.system.derivedStats?.defensiveBonus` y tira `1d100 + defensiveBonus`. Ese valor lo deriva el modelo de personaje multiplicando el bono de Quickness por `RMF_CONSTANTS.DEFENSIVE_MULTIPLIER` (=3) — la regla RM de que el DB base es 3× el bono de rapidez. La acción solo lee el dato ya derivado y de solo lectura en la ficha ([actor-stats.hbs:146-163](templates/parts/actor-stats.hbs#L146), input `readonly`). El label se localiza con `RMF.DerivedStats.DefensiveBonus`.

#### `#rollResistance` — tirada de resistencia (RR)

[actions.mjs:380-404](module/actions.mjs#L380). Lee `target.dataset.resistance` (uno de `essence`/`channeling`/`mentalism`/`poison`/`disease`) y tira `1d100 + derivedStats.resistances[tipo]`. Cada resistencia la deriva el modelo como `RESISTANCE_MULTIPLIER` (=3) × el bono de la característica primaria correspondiente (regla RM: RR = 3× bono de stat). El `{{#each}}` de la plantilla genera una fila por resistencia y emite `data-resistance="{{key}}"` ([actor-stats.hbs:185-194](templates/parts/actor-stats.hbs#L185)).

### El mensaje de chat estilizado: `#postStyledRollMessage`

[actions.mjs:224-252](module/actions.mjs#L224). Todas las tiradas terminan aquí. Recibe `{ actor, roll, bonus, flavor, label }` y:

1. Extrae el **dado base** de forma defensiva: `Number(roll.dice?.[0]?.total ?? roll.total ?? 0)` — la cara cruda de la d100 antes del bono.
2. Descompone el bono en operador y valor absoluto (`bonusOperator`, `bonusAbs`, `hasBonus`) para que la plantilla muestre `baseRoll ± bonusAbs` legible.
3. Renderiza [chat/stat-roll.hbs](templates/chat/stat-roll.hbs) con `foundry.applications.handlebars.renderTemplate`, que pinta una tarjeta con: el dado base, la fórmula textual (`roll.formula`) y el desglose "aplicado" (`baseRoll {operador} {bonusAbs}`).
4. Publica con `roll.toMessage({ speaker, flavor, content, rollMode })`, usando `ChatMessage.implementation.getSpeaker({ actor })` y respetando el `rollMode` global de Foundry (`game.settings.get("core", "rollMode")`) para honrar tiradas públicas/GM/privadas.

El uso de `ChatMessage.implementation` y `Item.implementation`/`FilePicker.implementation` por todo el módulo sigue el idioma v13.341 de clases reemplazables vía `.implementation` (con fallback a la clase base donde el accesor no exista, ver `#pickImage` [actions.mjs:519-520](module/actions.mjs#L519)).

### Iniciativa de combate y `getRollData`

La iniciativa **no** pasa por `RMFActions`; es una fórmula de Roll de Foundry que el motor de combate evalúa con los datos del actor. Está declarada en dos sitios:

- En [system.json:41](system.json#L41): `"initiative": "1d100 + @stats.quickness"`.
- Como setting de mundo configurable en [rmf.mjs:268-278](rmf.mjs#L268) (clave `"initiativeFormula"`), con `default: "1d100 + @stats.quickness"` y un `onChange` que asigna `CONFIG.Combat.initiative.formula = value`. En el arranque "ready", `_initializeReadyTimeConfigs` vuelve a aplicar el valor guardado a `CONFIG.Combat.initiative.formula` ([rmf.mjs:478-479](rmf.mjs#L478)).

El `@stats.quickness` se resuelve porque el documento Actor sobreescribe `getRollData()` ([data-models.mjs:78-118](module/data-models.mjs#L78)) para exponer, por cada característica, **dos** alias bajo `data.stats`: la clave completa (`chQuickness`) y la corta en minúsculas (`quickness`), ambas igual a `stat.total` ([data-models.mjs:89-90](module/data-models.mjs#L89)):

```js
rollStats[key] = total;                                  // chQuickness
rollStats[key.replace("ch", "").toLowerCase()] = total;  // quickness
```

Por eso la fórmula de iniciativa funciona con `@stats.quickness`: es el `total` de Quickness. `getRollData` también publica `@hp`, `@pp`, `@db`, `@armorPenalty`, `@res.<tipo>`/`@resistances.<tipo>` y `@level`, pensados para macros y fórmulas de usuario libres (los ejemplos están documentados en el propio JSDoc del método). Modelar la iniciativa como `1d100 + bono de Quickness` es la convención RM de que la rapidez gobierna el orden de actuación.

> Nota: el documento Actor también tiene un método propio `rollStat(statKey, options)` ([data-models.mjs:130-164](module/data-models.mjs#L130)) con fórmula por defecto `"1d100 + @bonus"`, pensado para invocación programática/macros (publica directamente con `ChatMessage.implementation.create`, no con `roll.toMessage`). Las acciones de la ficha (`RMFActions.#rollStat`) **no** lo usan: construyen la fórmula con `#buildD100Formula`. Son dos caminos paralelos (uno orientado a UI, otro a API), una redundancia conviene tener presente.

### Botones +1 / −1 de rango y la deuda del alias `system.rank`

[actions.mjs:684-743](module/actions.mjs#L684) definen `#incrementSkillRank` y `#decrementSkillRank`. Su lógica:

```js
const currentRank = Number(this.document.system.rank || 0);
const parsedLevel = parseInt(target.dataset.level);
const level = Number.isFinite(parsedLevel) ? parsedLevel : 1;
const bought = this.document.system.boughtByLevel || {};
const currentBought = Number(bought[level] || 0);
// Tope de 3 rangos comprados por nivel:
if (currentBought >= 3) { ui.notifications.warn(game.i18n.localize("RMF.Skill.MaxRanksPerLevel")); return; }
await this.document.update({
  "system.rank": currentRank + 1,
  [`system.boughtByLevel.${level}`]: currentBought + 1
});
```

**Forma del dato y persistencia.** El dato canónico de progresión es **`system.boughtByLevel.<nivel>`**: un mapa de "rangos comprados en cada nivel". Los handlers leen `target.dataset.level` para saber a qué nivel imputar la compra (con fallback a `1` si `parseInt` no devuelve un valor finito), y escriben de forma granular esa entrada del mapa. El **tope de 3 rangos por nivel** (`currentBought >= 3`) es una regla canónica de Rolemaster (máximo 3 rangos de desarrollo por nivel); al alcanzarlo, avisa con `RMF.Skill.MaxRanksPerLevel` y no incrementa. El decremento es simétrico y nunca baja de 0 (`if (currentRank <= 0) return;`, `if (currentBought <= 0) return;`).

**La deuda técnica del alias.** Cada `update` escribe **además** `system.rank` (`currentRank + 1` / `currentRank - 1`). Ese `system.rank` es un alias de "rango total" que **el refactor eliminará**: el rango total verdadero debe *derivarse* sumando `boughtByLevel` (ranks comprados) más los rangos raciales/de paquete, no persistirse como número independiente. Mantener `system.rank` persistido en paralelo a `boughtByLevel` provoca **drift**: si por cualquier vía `boughtByLevel` cambia sin pasar por estos botones (importadores, drop de raza que escribe `boughtByLevel.0`, edición directa), `system.rank` queda desincronizado. La dirección correcta —y la que adopta el refactor— es que `system.rank`/`totalRanks` sean **derivados** desde `boughtByLevel`, dejando `boughtByLevel` como única fuente de verdad. Por eso el resto del sistema (p. ej. el drop racial en `_applyRacialRanksFromRace`, [actor-sheet.js:466-469](module/actor-sheet.js#L466)) escribe siempre `boughtByLevel.<n>` y nunca `system.rank`.

**Estado de enganche.** Conviene señalar que, aunque los handlers `incrementSkillRank`/`decrementSkillRank` están definidos y registrados en `RMFActions.actions` ([actions.mjs:118-129](module/actions.mjs#L118)), **ninguna sheet los declara en su `actions` ni ninguna plantilla emite `data-action="incrementSkillRank"`** actualmente (la skill-sheet solo registra `pickImage`, [skill-sheet.js:42-44](module/skill-sheet.js#L42)). Es decir: la lógica de compra de rango por nivel existe y está lista, pero su botonera +/-1 todavía no está cableada en la UI vigente. (Por contraste, sí está cableado todo lo demás: `rollStat`, `rollSkill`, `rollCategory`, `rollCategoryNoSkill`, `rollDefensive`, `rollResistance`, `createItem`, `editItem`, `deleteItem`, `pickImage`.)

### Acciones de gestión (no-tirada)

Por completitud, el mismo módulo cubre la manipulación de items embebidos, todas con `this` = sheet del actor:

- **`#createItem`** ([actions.mjs:625-649](module/actions.mjs#L625)): lee `target.dataset.type` (por defecto `"equipment"`), arma `{ name, type, system: {} }` con nombre localizado (`RMF.NewItem.<type>` con fallback a `RMF.Actions.Create` + tipo) y crea el item con `createEmbeddedDocuments("Item", ...)`, abriendo su sheet. Lo usa el botón `+` de equipo ([actor-equipment.hbs:13-20](templates/parts/actor-equipment.hbs#L13)).
- **`#editItem`** ([actions.mjs:551-572](module/actions.mjs#L551)): resuelve el id por `closest('[data-item-id]')` y hace `item.sheet.render(true)`.
- **`#deleteItem`** ([actions.mjs:583-614](module/actions.mjs#L583)): confirma con `DialogV2.confirm` (modal v13) antes de `item.delete()`.
- **`#toggleEquipped`** ([actions.mjs:660-669](module/actions.mjs#L660)): invierte `system.equipped` (pensado para la item-sheet). Está registrado en `RMFActions.actions` pero, igual que los botones de rango, ninguna sheet de actor lo declara actualmente.
- **`#pickImage`** ([actions.mjs:510-536](module/actions.mjs#L510)): abre el `FilePicker` v13 (resuelto vía `foundry.applications.apps.FilePicker.implementation` con fallback a la clase base) posicionado junto a la sheet, y en el callback hace `document.update({ img: path })`. Junto con `createItem`, es de las pocas acciones con `requiresTarget: false`.

Todas leen/escriben sobre `this.document` (el actor o el item de la sheet), lo que cierra el bucle: la plantilla declara `data-action` → ApplicationV2 delega a `RMFActions.handlers.<x>` con `this` = sheet → el handler lee el dato derivado del `document.system` → tira o muta → publica chat o re-renderiza la ficha.

---

## Datos, identidad (slug), importación y migración

Esta sección documenta cómo el sistema RMF **trata sus datos**: dónde vive la "verdad", cómo se identifica cada pieza de contenido de forma estable en el tiempo, cómo entra al mundo (importadores) y cómo se mantiene consistente cuando el esquema evoluciona (migraciones). Es la capa de cimentación del refactor de Fase 0 descrito en [refactor.md](refactor.md).

### 1. Los archivos canónicos en `data/` como fuente de verdad

El directorio [data/](data/) contiene los JSON canónicos del libro "basic" de Rolemaster Fantasy. Son la **fuente de verdad** del contenido: el código nunca codifica skills, categorías ni razas en línea; las consume desde estos archivos vía los importadores. El contenido se reparte así:

| Archivo | Tipo de Item destino | Forma del JSON |
|---|---|---|
| [data/skills.json](data/skills.json) | `skill` | array plano de entradas (cada una con `name`, `slug`, `category`, `group`, `classification`, `dpCost`, `skillRankBonusProgression`, …) |
| [data/categories.json](data/categories.json) | `category` | array plano (`name`, `slug`, `specialRole`, `dpCost`, `statBonus`, `group`, …) |
| [data/races.json](data/races.json) | `race` | array (`name`, `slug`, `stats`, `resistances`, progresiones BD/PP como string, `racialRanks`, `specialSkills`, `standardHobbySkills`) |
| [data/realms.json](data/realms.json) | `realm` | array (`name`, `powerPointsType`, `statBonus`) |
| [data/professions.json](data/professions.json) | `profession` | array (`name`, `primeStats`, `professionalBonuses`, listas de skills, `categoryPrice`, `spellPrice`, `trainingPackages`) |
| [data/training_packages.json](data/training_packages.json) | `trainingPackage` | array (`name`, `categoryRanks`, `special`, …) |
| [data/open-*.json](data/), [data/closed-*.json](data/), [data/base-*.json](data/) (9 archivos) | `spellList` | objeto `{ "lists": [ … ] }`, un archivo por columna realm × tipo (Open/Closed/Base) |
| [data/attack-tables/*.json](data/attack-tables/) (p. ej. [one-handed-concussion.json](data/attack-tables/one-handed-concussion.json)) | `attackTable` | un objeto-tabla por archivo (`name`, `tableId`, `critType`, `fumbleRange`, `rows`, `fumble`, …) |

> El array [skills.json](data/skills.json) es plano (un `[ {…}, … ]`, 165 entradas), verificado al cargarlo: tipo `list`. Los importadores son tolerantes a ambas formas envueltas (`{ "skills": [...] }`, `{ "categories": [...] }`, etc.) y a entradas con o sin envoltura `system` — ver `resolveSource` ([importers.mjs:295](module/importers.mjs#L295)) y los patrones `entry.system ?? entry` en [importers.mjs](module/importers.mjs).

**Por qué un fichero por columna y no un único JSON**: las spell lists se parten en 9 ficheros porque la fuente (spells.pdf) está organizada por columnas realm×tipo, y cada archivo lleva `{ "lists": [...] }` para que un importador procese una columna entera de una vez ([importers.mjs:1752](module/importers.mjs#L1752)). Las attack tables van una por archivo porque cada tabla es voluminosa (matriz de bandas de tirada × tipos de armadura) y se versiona/edita por separado.

**Decisión de diseño (no es regla del libro)**: estos JSON son la fuente; los **packs** (el compendio de mundo `world.basic-core`) y los **items de barra lateral** son artefactos derivados que se (re)generan vía los importadores/sync. Esto permite editar el contenido como texto plano versionable en git y resincronizarlo sin reconstruir a mano.

### 2. El problema que resuelve la identidad por slug

Antes de la Fase 0, **todo el contenido se unía por nombre de texto libre**: el join típico era `String(a.name).trim().toLowerCase() === String(b).trim().toLowerCase()`. Esto se rompía en tres frentes reales, documentados en [refactor.md](refactor.md):

1. **Acentos, mayúsculas, el middot `·` de "Armor · Heavy", traducción y typos** desalineaban referencias que conceptualmente eran la misma. La categoría real es `"Armor · Heavy"` (con `·`, U+00B7; verificado: la skill `Plate` en [skills.json](data/skills.json) declara `category: "Armor · Heavy"`); cualquier comparación naïve por nombre con "Armor Heavy" o "armor-heavy" fallaba.
2. **HP/PP por literal inglés**: el cálculo de HP máximo y PP máximo del personaje buscaba las skills "Body Development" / "Power Point Development" **por su nombre inglés**. Traducir esos nombres o un typo ponía el HP/PP máximo **a 0** — un fallo silencioso crítico que deja al personaje sin puntos de golpe.
3. **Bug real "Caving"**: las razas (Enanos, Halflings) pedían la skill `"Caving"`, pero la canónica en [skills.json](data/skills.json) es `"Caving (Spelunking)"`. Como `"Caving" ≠ "Caving (Spelunking)"`, no casaban y al soltar la raza se auto-generaba un *stub* vacío.

La solución es desacoplar **identidad** (estable, interna) de **display** (el `name`, traducible). La identidad es un **slug** kebab-case independiente de idioma.

### 3. `slug.mjs` — la fuente única de identidad

[module/utils/slug.mjs](module/utils/slug.mjs) es un módulo **puro** (sin dependencias del runtime de Foundry, unit-testable) y la **única** fuente de verdad de identidad. Sus piezas:

#### `slugify(name)` — función TOTAL

```js
export function slugify(name) {
  const raw = typeof name === "string" ? name : String(name ?? "");
  const slug = raw
    .normalize("NFD")
    .replace(DIACRITICS, "")        // /[\u0300-\u036f]/g  marcas combinantes post-NFD
    .replace(SEPARATORS, " ")       // middot · • ∙ ‧ ・  → espacio
    .toLowerCase()
    .replace(NON_SLUG, "-")         // /[^a-z0-9]+/g
    .replace(EDGE_DASH, "");        // /^-+|-+$/g  guiones de borde
  return slug || `x-${djb2(raw)}`;
}
```

- **Normaliza diacríticos**: `normalize("NFD")` descompone `é → e` + marca combinante, y la marca se borra. Así "Pociones" o nombres acentuados producen el mismo slug que su variante sin acento.
- **Trata el middot y familia** (`SEPARATORS` = `/[\u00b7\u2022\u2219\u2027\u30fb]/g`) como separador, de modo que `"Armor · Heavy" → "armor-heavy"`. Este es exactamente el caso que rompía el join por nombre.
- **Ejemplos canónicos** (del docstring y verificados en datos): `slugify("Armor · Heavy") → "armor-heavy"`, `slugify("Caving (Spelunking)") → "caving-spelunking"`, `slugify("Body Development") → "body-development"`.
- **Es TOTAL**: nunca devuelve cadena vacía. Si el nombre es todo puntuación, cae al **fallback hash** `x-${djb2(raw)}`. `djb2` es un hash determinista (djb2 → base36 sin signo) **estable entre ejecuciones y plataformas**; existe solo para garantizar que *cualquier* nombre mapee a *algún* identificador no vacío. **Por qué importa**: si `slugify` pudiera devolver `""`, un nombre degenerado colisionaría con todos los demás vacíos y la resolución por fallback se rompería; la totalidad elimina esa clase de bug.
- **Es idempotente** sobre valores que ya son slugs: `slugify("armor-heavy") === "armor-heavy"`. Esto es lo que permite que las funciones de comparación reciban indistintamente un nombre o un slug.

#### Comparación y resolución

- `identityKey(ref)` = `slugify(ref)` ([slug.mjs:90](module/utils/slug.mjs#L90)): normaliza cualquier referencia (un slug almacenado **o** un nombre impreso) a una clave comparable. Es el puente que hace que datos legacy basados en nombre y datos nuevos basados en slug **se unan**.
- `matchesIdentity(candidate, reference)` ([slug.mjs:104](module/utils/slug.mjs#L104)): true cuando una referencia libre casa con un candidato. Compara contra `candidate.system.slug` **si existe** (`slug && slugify(slug) === ref`) y, si no, contra `slugify(candidate.name)`. Es el reemplazo directo (drop-in) del antiguo `name.trim().toLowerCase() === …`.
- `buildSlugIndex(items)` ([slug.mjs:123](module/utils/slug.mjs#L123)) / `resolveFromIndex(index, reference)` ([slug.mjs:141](module/utils/slug.mjs#L141)): construyen un `Map(clave → item)` para lookups O(1). Cada item se indexa bajo **ambas** claves (su slug y su nombre slugificado), de modo que una referencia escrita en cualquiera de las dos formas resuelve. En colisión, **gana el primer escritor** (`if (bySlug && !index.has(bySlug))` …; los call-sites pasan listas ordenadas por libro, así "basic" precede a expansiones futuras).

**Por qué dos claves por item en el índice**: durante la transición, las *referencias* almacenadas (p. ej. `skill.system.category`) todavía guardan el **nombre**, mientras que el *candidato* ya lleva `slug`. Indexar por ambas garantiza que ninguna de las dos direcciones falle. En Fase 2 las referencias pasarán a guardar slug; hoy se resuelven por `slugify(nombre)`, compatible hacia adelante.

### 4. El fragmento de esquema compartido `_identity.mjs`

[module/data-models/_identity.mjs](module/data-models/_identity.mjs) centraliza la **definición de campos** de identidad para que los 8 tipos de contenido se comporten byte a byte igual y las migraciones tengan un único lugar donde evolucionar.

#### `system.slug` — blank-tolerant para siempre

```js
export function slugField() {
  return new fields.StringField({ required: true, nullable: false, blank: true, initial: "" });
}
```

La **regla de oro** es que `slug` es **`blank: true` para siempre** y **nunca** puede ganar un validador non-blank. La resolución cae siempre a `slugify(name)` cuando el slug está vacío ([slug.mjs:108-110](module/utils/slug.mjs#L108)), así que un documento **aún sin migrar** sigue cargando y resolviendo correctamente. Si el campo fuera obligatorio-no-vacío, cualquier mundo viejo o item arrastrado de un compendio antiguo **fallaría la validación al cargar** — exactamente lo que la tolerancia a blanco evita. El slug está en los **8 tipos de contenido** (skill, category, profession, race, realm, spellList, trainingPackage, attackTable), **no** en `equipment` (que es estado de instancia por personaje) ni en el actor.

#### `system.specialRole` — HP/PP por rol, no por nombre

Solo `skill` y `category` llevan `specialRole`, con `choices` = `SPECIAL_ROLES` = `["none", "bodyDevelopment", "powerPointDevelopment"]` (congelado con `Object.freeze`), `initial: "none"`, `blank: false`. Estos dos roles son las dos mecánicas RMF que fijan los máximos de HP / PP del personaje y usan tablas de progresión específicas de raza.

- `specialRoleFromName(name)` mapea por slug del nombre: `"body-development" → "bodyDevelopment"`, `"power-point-development" → "powerPointDevelopment"`, resto `"none"`.
- `resolveSpecialRole(role, name)` ([_identity.mjs:83](module/data-models/_identity.mjs#L83)) es el **único** helper que usan todos los call-sites: `(role && role !== "none") ? role : specialRoleFromName(name)` — prefiere el tag explícito y **cae al nombre** si el tag es ausente o `"none"`. Esto hace el tag *belt-and-suspenders* (cinturón y tirantes): es la vía rápida, pero nunca es el único soporte — un documento sin tag aún resuelve por nombre.

**Por qué esta indirección y no comparar el nombre directamente**: el nombre es traducible. En cuanto alguien localice "Body Development" al español, el match por literal inglés colapsaría y el HP iría a 0. El `specialRole` es un **dato interno** inmune a la traducción. Verificado en datos: tanto en [skills.json](data/skills.json) como en [categories.json](data/categories.json), las entradas "Body Development" y "Power Point Development" llevan `specialRole: "bodyDevelopment"` / `"powerPointDevelopment"` y `slug: "body-development"` / `"power-point-development"` estampados.

#### Sitios reenrutados (fuera del display-name)

Todo join de contenido pasa ahora por `slug.mjs`. Los puntos clave reenrutados: `data-models/skill.mjs` (skill→category y tabla Body/PP-Dev), `data-models/character.mjs` (HP/PP máx por `resolveSpecialRole`), `data-models/category.mjs` (herencia de `statBonus` del realm para PP-Dev), `hooks.mjs` (sync PP-Dev y recolección de skills críticas) y `actor-sheet.js` (agrupación skill→category con `buildSlugIndex`, rangos raciales y special skills con `matchesIdentity`).

### 5. Los tres caminos de estampado convergentes

Un slug puede entrar al sistema por tres rutas distintas. La clave de diseño es que **las tres usan el mismo `slugify`**, así que `slug = slugify(name)` produce un resultado **idéntico y consistente** sin importar la ruta:

```
                       slugify(name)  ← misma función en los 3
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                          │
1) data/*.json            2) preCreateItem            3) migración 0.3.0
   (backfill explícito)      (creación en vivo)          (mundos existentes)
```

1. **Datos** — los `data/*.json` llevan el `slug` (y `specialRole`) explícito, escrito por el dev-tool [tools/backfill-slugs.mjs](tools/backfill-slugs.mjs). Este tool usa el **mismo** `slugify` que el runtime y aplica una estrategia de **diff mínimo**: inserta una línea `"slug"` justo después de cada línea `"name"` de **nivel superior** (regex `TOP_NAME = /^ {4}"name":.../`, exactamente 4 espacios de indentación) sin re-serializar el JSON, para no reflejar todo el formato compacto hecho a mano. Los `"name"` más anidados (p. ej. filas de `racialRanks` o entradas de `specialSkills`) quedan intactos. Es idempotente (salta entradas que ya tienen una línea `"slug"` debajo).

2. **Creación** — el hook `preCreateItem` (`#onPreCreateItem`, [hooks.mjs:282](module/hooks.mjs#L282)) estampa identidad en **cualquier** item de contenido nuevo, venga de creación a mano, drag-drop, copia o importador (vía `Item.createDocuments`). Llama a `buildIdentityBackfill(item)` y, como ese helper devuelve claves dot-notation, las expande con `foundry.utils.expandObject` antes de `item.updateSource(...)`, de modo que escribe en `system.slug` / `system.specialRole` y no en claves con puntos literales. Corre **antes** de persistir, en **cada** cliente (sin guard de `userId`: cada cliente sella su propio source pendiente). **Por qué este hook**: cubre las rutas del importer (y el drag-drop) sin tener que tocar cada ruta a mano.

3. **Mundos existentes** — la migración **0.3.0** ([migration.mjs:147](module/migration.mjs#L147)) recorre items de barra lateral, items embebidos en actores y packs de mundo (`world.basic-core`), estampando `slug`/`specialRole` y un sello `flags.rmf.schemaVersion`.

**Por qué tres caminos y no uno**: cada uno cubre un origen temporal distinto del dato. (1) sella el contenido *en reposo* en disco para que el sello sea autoritativo y errata-estable. (2) sella todo dato *nuevo* en runtime, incluido el que llega por re-sync de un compendio. (3) sella el dato *ya persistido* en mundos que se actualizaron desde una versión previa. Como convergen en `slugify`, no hay divergencia posible entre ellos.

### 6. El framework de migración

[module/migration.mjs](module/migration.mjs) es un runner **world-scoped, idempotente y GM-gated**.

#### `MIGRATIONS` — lista ordenada de pasos

Cada paso es `{ to, description, run(ctx) }`. `to` es la versión que produce (semver, alineada con `system.json`). Hay dos pasos:

- **0.2.0** — "DataModel introduction": reemite cada actor/item con un `update({}, { diff: false })`. El esquema 0.2.0 refleja la forma del antiguo `template.json`, así que no hay renombrados; el round-trip por el `TypeDataModel` registrado rellena campos faltantes con su `initial`, *clampa* números fuera de rango y **descarta** claves legacy desconocidas (p. ej. cálculos cacheados en disco).
- **0.3.0** — "Stamp stable content slugs + specialRole tags (Fase 0)": en tres pasadas independientes (sidebar, embebidos en actores, packs de mundo writable), cada una con su `try/catch` para aislamiento. Usa `buildIdentityBackfill(item, "0.3.0")`.

**Regla obligatoria**: cada paso **debe** ser seguro de re-ejecutar, porque el próximo release puede ser un hotfix que re-aplique el mismo paso a mundos que cayeron a mitad.

#### `buildIdentityBackfill(item, stampVersion)` — el helper único

```js
export function buildIdentityBackfill(item, stampVersion) {
  if (!item || !SLUG_CONTENT_TYPES.has(item.type)) return null;
  const sys = item.system ?? {};
  const update = {};
  if (!sys.slug) update["system.slug"] = slugify(item.name);
  if (item.type === "skill" || item.type === "category") {
    const role = resolveSpecialRole(sys.specialRole, item.name);
    if (role !== "none" && sys.specialRole !== role) update["system.specialRole"] = role;
  }
  if (!Object.keys(update).length) return null;       // evita writes no-op
  if (stampVersion) update["flags.rmf.schemaVersion"] = stampVersion;
  return update;
}
```

Es el helper **único** de backfill que comparten la migración 0.3.0 y el hook `preCreateItem` (`sanitizeItemData` queda reservado, ver abajo). Solo escribe lo que falta (no toca un slug ya presente → preserva un slug de errata autorizado), devuelve `null` cuando no hay nada que cambiar (los callers saltan el write no-op) y solo sella `flags.rmf.schemaVersion` cuando se le pasa una versión. `SLUG_CONTENT_TYPES` ([migration.mjs:40](module/migration.mjs#L40)) es el `Set` de los 8 tipos de contenido, mantenido en sincronía con `_identity.mjs`.

#### `runWorldMigration(opts)` — punto de entrada

Disparado por el hook `ready` una vez por mundo. Garantías:

- **GM-gated**: si `!game.user?.isGM`, aborta en silencio (`reason: "non-GM"`). Solo el GM posee las escrituras de nivel mundo.
- **Versión persistida**: el world setting `lastMigrationVersion` (registrado en `registerMigrationSettings`, `config: false`, gestionado por el runner) recuerda la última versión aplicada. Si `compareVersions(fromVersion, targetVersion) >= 0`, salta (`reason: "up-to-date"`) — los reloads no re-ejecutan pasos completados.
- **Recuperación de cuelgues**: el flag `migrationInProgress` se pone a `true` antes de empezar y a `false` en el `finally`. Si un run previo murió a mitad, el flag sigue activo: el runner **avisa** (`ui.notifications?.warn`) pero permite reintentar (los pasos son idempotentes, re-ejecutar es seguro). Se persiste `lastMigrationVersion` **después de cada paso**, así un fallo a mitad deja el mundo en una versión intermedia conocida.
- **`opts.force`**: re-ejecuta todos los pasos desde cero (herramienta de debug). Se puede invocar a mano desde una macro de GM: `game.rmf.runWorldMigration({ force: true })`.
- **Comparación de versiones**: `compareVersions` envuelve `foundry.utils.isNewerVersion` (API actual v13, no deprecada).

#### `migrateWorldItemPacks(transform, log)` — packs writable

Recorre solo los compendia de Item con `metadata?.packageType === "world"` (p. ej. `world.basic-core`). Los packs de **sistema y módulo son read-only** y vienen pre-sellados (se construyen desde `data/*.json` que ya llevan slug, y los huecos los rellena `preCreateItem` al construir), por eso se **saltan** aquí. Los packs de mundo bloqueados se **desbloquean temporalmente y se re-bloquean**: el `configure({ locked: false })` vive **dentro del `try`** para que un fallo de `configure()` no aborte el paso entero, y el re-lock va en `finally` con `.catch(() => {})`.

#### `sanitizeItemData` — no-op honesto

Es deliberadamente un **no-op** ([migration.mjs:348](module/migration.mjs#L348)). El estampado de identidad para drag-drop / imports lo maneja **en vivo** el hook `preCreateItem`, que dispara en cada creación de Item. Mantenerlo como no-op honesto (en vez de duplicar la lógica) evita código muerto que parecería activo; queda reservado para futuras limpiezas que deban correr sobre documentos **ya persistidos**. (Su análogo `sanitizeActorData` es también no-op.)

### 7. Los importadores

[module/importers.mjs](module/importers.mjs) expone, por cada tipo de contenido, dos funciones: `import*(source)` (crea items de **barra lateral** en carpetas) y `sync*ToCompendium(source)` (upsert en un pack, por defecto `world.basic-core`).

#### Estructura común

- **`resolveSource(source)`** ([importers.mjs:295](module/importers.mjs#L295)) admite array/objeto ya parseado, string JSON, o **URL/path** a un fichero. Las URLs pasan antes por **`_assertSafeSourceUrl`** ([importers.mjs:69](module/importers.mjs#L69)), que solo permite paths relativos bajo `systems/`, `worlds/`, `modules/` o URLs `https://` absolutas — rechaza `http://`, `file://`, `data:`, `javascript:`, etc. (defensa contra fetch de orígenes no servidos por Foundry).
- **`_assertGM(operation)`** ([importers.mjs:50](module/importers.mjs#L50)) corona cada importador/sync: escriben en el compendio de mundo y carpetas de nivel mundo, así que **nunca** deben correr desde una macro de jugador.
- **`build*SystemData` / `normalize*`**: cada tipo construye su `system` haciendo `mergeObject(duplicate(template), { …campos normalizados… }, { inplace:false, insertKeys:true, insertValues:true, overwrite:true })`. La normalización es **defensiva**: coerciona números (`normalizeNumber`), tolera claves legacy (mayúsculas `"Bonus"`, el typo histórico `"trainningPackages"`), acepta alias de stats (`ag`/`agility` → forma canónica vía `normalizeStatKey`/`canonicalizeStatKey`), de-duplica listas y descarta entradas sin nombre usable. La progresión racial se guarda como **string** `"zero/T1/T2/T3/T4"` validada por `normalizeRaceProgressionString` (devuelve `""` si algún tramo no es finito, para que el data model lo trate como ausente).
- **`createDocuments`**: ambos caminos crean vía `Item.createDocuments(...)`, **lo cual dispara `preCreateItem`** y por tanto el estampado de slug. Por eso los importadores no necesitan estampar slug manualmente *en la ruta de creación*.

#### La clave de upsert

Cada `sync*ToCompendium` indexa el pack y construye un mapa de existencia:

```js
const existingByKey = new Map(
  pack.index.map(entry => [`${entry.type}::${String(entry.name).toLowerCase()}`, entry])
);
```

La **clave de upsert** es `` `${type}::${name.toLowerCase()}` `` — es decir, `type` + **nombre en minúsculas**. Si la entrada existe → va al `updatePayload` (`Item.updateDocuments(..., { diff: false })`); si no → `createPayload` (`Item.createDocuments`). Los flags `updateExisting`/`createMissing` permiten políticas de solo-crear o solo-actualizar.

> **Decisión de diseño y deuda explícita**: el upsert aún se hace **por nombre**, no por slug (refactor.md anota que el upsert por slug/`bookId` es trabajo de Fase 2). Esto importa porque la ruta UPDATE **no dispara `preCreateItem`**. De ahí la pieza siguiente.

#### Propagación de slug/specialRole autorizados en skill y category

Como un re-sync de skill/category toma la ruta UPDATE (sin `preCreateItem`), `buildSkillSystemData` ([importers.mjs:768](module/importers.mjs#L768)) y los builders de category **propagan explícitamente** el slug y el specialRole **autorizados desde la fuente**:

```js
slug:        authoredSlug(sysSource),                 // string del JSON, "" si ausente
specialRole: authoredSpecialRole(sysSource),          // valor canónico o "none"
```

(las líneas reales en skill son [importers.mjs:827-828](module/importers.mjs#L827).) `authoredSlug(src)` ([importers.mjs:26](module/importers.mjs#L26)) pasa el `slug` del JSON tal cual (`""` si no es string); `authoredSpecialRole(src)` ([importers.mjs:37](module/importers.mjs#L37)) lo deja pasar solo si es uno de `SPECIAL_ROLES`. **Por qué**: así un slug autorizado/errata (escrito en `data/*.json` por el backfill) permanece **autoritativo y estable** a través de re-syncs. En `category`, la propagación combina ambas formas: `authoredSlug(sysSource) || authoredSlug(entry)` ([importers.mjs:427](module/importers.mjs#L427)). En `race`, `realm`, `profession`, `trainingPackage`, `spellList`, `attackTable` los builders **no** propagan slug en datos: esos tipos obtienen el slug en la ruta CREATE vía `preCreateItem`, y en UPDATE el slug ya presente en el pack se conserva (porque `buildIdentityBackfill` no lo sobrescribe).

#### Carpetas organizativas

Los importadores crean/buscan carpetas por nombre (`Races`, `Categories`, `Skills`, …). Las spell lists son un caso especial: se agrupan en exactamente **9 carpetas** `"<Realm> <ListType>"` (Channeling/Essence/Mentalism × Open/Closed/Base) vía `_spellListFolderName` ([importers.mjs:1788](module/importers.mjs#L1788)), agrupando por realm y **no** por profesión. Dentro de un pack, `_ensurePackFolder` crea la carpeta si falta (a diferencia de `getPackFolderIdsByName`, que solo busca), de modo que el sync produce sus 9 carpetas sin que el usuario las precree.

#### Nota de mapeo de campos (spell lists)

El JSON de spell lists llama `type` al eje Open/Closed/Base, lo que **colisiona** con el `type` del documento de Foundry. `buildSpellListSystemData` ([importers.mjs:1857](module/importers.mjs#L1857)) lo mapea a `listType` (`sysSource?.listType ?? sysSource?.type ?? "Open"`). El antiguo `spellDescriptionKey` de nivel superior **no** se importa: vive en `constants.mjs` / `CONFIG.RMF` ([utils/constants.mjs:117](module/utils/constants.mjs#L117)).

### 8. La errata "Caving" y la decisión pendiente de "Horticulture"

Siguiendo la regla del proyecto (corregir erratas del libro **avisando**):

- ✅ **"Caving" → "Caving (Spelunking)"**: aplicada en [races.json](data/races.json). El nombre canónico en [skills.json](data/skills.json) es `"Caving (Spelunking)"`; las **referencias estructuradas** (las entradas `specialSkills` de Enanos y Halflings, líneas [races.json:288](data/races.json#L288) y [races.json:366](data/races.json#L366)) están corregidas para que el join por slug case. El tool [backfill-slugs.mjs](tools/backfill-slugs.mjs) aplica esta errata de forma idempotente con un `text.replace(/"name":\s*"Caving"/g, …)` ejecutado **solo sobre el archivo de razas** (`if (file.endsWith("races.json"))`); el regex de coincidencia exacta nunca vuelve a casar el valor ya corregido. **Importante**: los strings descriptivos de texto libre `standardHobbySkills` (p. ej. [races.json:72](data/races.json#L72), que lista "Caving" como prosa) **conservan "Caving"** a propósito: son prosa de display, no se usan para joins, y reescribirlos alteraría el texto del libro sin beneficio mecánico.

- ⚠️ **"Horticulture"** (Halflings, [races.json:367](data/races.json#L367)): **no existe** skill con ese nombre ni similar en [skills.json](data/skills.json). Se ha dejado **intacto y marcado**, pendiente de tu decisión: ¿añadir la skill "Horticulture" a [data/skills.json](data/skills.json), o corregir el nombre de la referencia? Hasta entonces, al soltar la raza Halfling se auto-genera un *stub* vacío para esa skill (el comportamiento tolerante: no rompe, pero la referencia queda colgando).

### 9. Cómo encaja con el actor y consistencia en el tiempo

El contenido entra al **personaje** como items embebidos (clones de las definiciones del compendio, soltados o aplicados por profesión/training package). En ese punto:

- El `slug` del item embebido permite que el actor lo una a su categoría, a la tabla de progresión racial y a los roles HP/PP **sin depender del nombre traducible**. El cálculo de HP/PP máximo del personaje ([character.mjs](module/data-models/character.mjs)) busca skills por `resolveSpecialRole(...) === "bodyDevelopment"` / `"powerPointDevelopment"`, no por literal inglés — lo que blinda el HP/PP frente a traducción/typos.
- Los joins skill→category en la sheet ([actor-sheet.js](module/sheets/actor-sheet.js)) usan `buildSlugIndex`/`matchesIdentity`, tolerantes al middot y a la forma (nombre o slug) de la referencia.

La consistencia **en el tiempo** queda garantizada por la convergencia de las tres rutas de estampado sobre el mismo `slugify`, la tolerancia a blanco del campo `slug` (un documento sin migrar siempre resuelve por `slugify(name)`), la idempotencia GM-gated del runner de migración con su versión persistida, y la propagación explícita de slug/specialRole autorizados en el re-sync de skill/category. El resultado es que un mundo nuevo, un mundo actualizado y un item arrastrado de un compendio antiguo **convergen al mismo identificador** para el mismo contenido conceptual.
