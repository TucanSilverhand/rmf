# RMF — RoleMaster de Fantasía

Sistema **no oficial** para [FoundryVTT](https://foundryvtt.com/) v13.341 que implementa las mecánicas básicas del juego de rol *Rolemaster Fantasy* (RMFRP) sobre la arquitectura moderna **ApplicationV2**.

> ⚠️ Estado: pre-1.0 (versión `0.1.0`). El esquema de datos puede cambiar entre versiones; consulta el [CHANGELOG](CHANGELOG.md) antes de actualizar mundos en producción.

---

## Características actuales

- **Actores tipo `character`** con las 10 estadísticas Rolemaster (Ag, Co, Me, Re, SD, Em, In, Pr, Qu, St) y sus campos `temp / pot / basic / race / spec / total`.
- **Cálculos derivados automáticos**: HP, PP, resistencias y bonus defensivo según las reglas Rolemaster, con override por las skills *Body Development* y *Power Point Development*.
- **Items tipo `equipment`, `race`, `skill`, `category`, `realm` y `profession`** con sheets dedicadas (todas en ApplicationV2 con `HandlebarsApplicationMixin`).
- **Importadores** desde JSONs canónicos (`data/*.json`) hacia un compendio mundial llamado `world.basic-core` con carpetas `Categories`, `Races`, `Skills`, `Realms`, `Professions`.
- **Iniciativa configurable** (`1d100 + @stats.quickness` por defecto).
- **Modo debug** opcional que carga dinámicamente helpers de diagnóstico (`globalThis.RMF_D`).

## Instalación

### Manual (alpha)

1. Descarga el último release como zip o clona el repositorio.
2. Copia el directorio del sistema en `Data/systems/rmf/` de tu instalación de Foundry.
3. Reinicia FoundryVTT y crea o abre un mundo seleccionando el sistema **RMF — RoleMaster de Fantasía**.

### Vía URL de manifiesto (cuando haya release público)

Pega esta URL en *Configuration > Game Systems > Install System*:

```
https://github.com/TucanSilverhand/rmf/releases/latest/download/system.json
```

## Inicialización del compendio

Tras instalar el sistema, crea un compendio mundial llamado **`world.basic-core`** (tipo *Item*) y abre la consola del navegador (F12). Ejecuta los snippets de [`zzEstrategia.carlos.txt`](zzEstrategia.carlos.txt) o, abreviadamente:

```js
await game.rmf.syncCategoriesToCompendium("/systems/rmf/data/categories.json", { pack: "world.basic-core", folderName: "Categories", updateExisting: true, createMissing: true });
await game.rmf.syncRacesToCompendium("/systems/rmf/data/races.json",          { pack: "world.basic-core", folderName: "Races",       updateExisting: true, createMissing: true });
await game.rmf.syncSkillsToCompendium("/systems/rmf/data/skills.json",        { pack: "world.basic-core", folderName: "Skills",      updateExisting: true, createMissing: true });
await game.rmf.syncRealmsToCompendium("/systems/rmf/data/realms.json",        { pack: "world.basic-core", folderName: "Realms",      updateExisting: true, createMissing: true });
await game.rmf.syncProfessionsToCompendium("/systems/rmf/data/professions.json", { pack: "world.basic-core", folderName: "Professions", updateExisting: true, createMissing: true });
```

Solo el GM puede ejecutar estos imports.

## Estructura del proyecto

```
rmf/
├── rmf.mjs                  # Entry point: hooks init/ready, settings, helpers Handlebars
├── system.json              # Manifiesto del sistema
├── template.json            # Esquema canónico de Actor / Item
├── module/                  # Código fuente
│   ├── data-models.mjs      # RMFActor, RMFItem (extienden Actor/Item)
│   ├── hooks.mjs            # Clase RMFHooks centralizada
│   ├── actions.mjs          # Handlers declarativos
│   ├── importers.mjs        # Importers / sync a compendios
│   ├── *-sheet.js           # Sheets ApplicationV2 (actor, item, race, skill, category, realm, profession)
│   ├── debug.mjs            # Helpers de diagnóstico (carga dinámica)
│   └── utils/               # Helpers compartidos (sheet-helpers, rank-bonus)
├── templates/               # Plantillas Handlebars (incluye parts/ y chat/)
├── styles/                  # CSS del sistema
├── lang/                    # Localización (en.json)
└── data/                    # JSONs canónicos: categories, races, skills, realms, professions
```

## Compatibilidad

| Componente   | Versión |
|--------------|---------|
| FoundryVTT   | 13.330+ (verificado en 13.341) |
| Arquitectura | ApplicationV2 nativa |
| Node (dev)   | No requerido en runtime |

## Licencia

Sistema no oficial. *Rolemaster* es marca registrada de Iron Crown Enterprises (ICE). Este proyecto no está afiliado ni patrocinado por ICE; reimplementa mecánicas con fines educativos y de uso personal.

Consulta [LICENSE.txt](LICENSE.txt) para los términos de licencia del código.

## Reportar bugs

Abre una issue en [github.com/TucanSilverhand/rmf/issues](https://github.com/TucanSilverhand/rmf/issues).

## Autor

**TucanSilverhand**
