# Changelog

Todos los cambios notables del sistema **RMF — RoleMaster de Fantasía** se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y la numeración respeta [SemVer](https://semver.org/lang/es/).

## [Unreleased]

## [0.2.0] - Migración a DataModel v13

### Added
- **`module/data-models/`** con 7 `TypeDataModel`: `CharacterData`,
  `EquipmentData`, `RaceData`, `SkillData`, `CategoryData`, `RealmData`,
  `ProfessionData`. Cada uno declara su schema con `foundry.data.fields`,
  validación tipada (`min`/`max`/`choices`/`integer`/`nullable`), y
  encapsula su propia `prepareDerivedData()`.
- `system.equipped` (boolean) declarado oficialmente en el schema de
  Equipment — antes lo usaba `actions.mjs#toggleEquipped` sin estar
  declarado en `template.json`.
- Migración `0.2.0` en `module/migration.mjs` que re-emite cada actor /
  ítem para que el shape pase por el schema validado y se descarten
  campos legacy huérfanos. Idempotente.

### Changed
- `rmf.mjs`: registra `CONFIG.Actor.dataModels` y `CONFIG.Item.dataModels`
  en el hook `init`.
- `template.json` reducido a `types` + `htmlFields`. El shape de los
  documentos vive ahora en los DataModels.
- `RMFActor` adelgazado: ya solo orquesta el orden de derivación
  (CharacterData → categorías → skills → applySkillBasedDerivedStats)
  y conserva `rollStat` / `applyDamage` / `getRollData`. ~700 líneas
  de cálculos derivados se movieron a CharacterData.
- `RMFItem`: ahora una clase vacía. Toda la lógica `_prepareXxxData`
  se trasladó a su DataModel correspondiente.
- `system.json` versión bump a `0.2.0`.

### Removed
- `_calculateStatBonuses`, `_calculateSecondaryAttributes`,
  `_calculateBonus`, `_applySkillBasedDerivedStats`,
  `_ensureCharacterDefaults`, `_preUpdate`, `prepareBaseData`,
  `_prepareRaceData`, `_prepareEquipmentData`, `_prepareCategoryData`,
  `_prepareSkillData`, `_prepareRealmData`,
  `_computeTotalBoughtRanks`, `_computeRankBonus`,
  `_computeSelectedStatSum`, `_normalizeStatKey`,
  `_resolveSpecialSkillTable` de `module/data-models.mjs`.
- Validación manual de `Number.isFinite` en `_preUpdate`: ahora la
  hace `NumberField` automáticamente.

### Migration notes
- El shape persistido se mirror-ea exactamente: cero pérdida de datos
  en mundos existentes. La migración 0.2.0 hace un round-trip por el
  schema para limpiar campos legacy.
- Si un mundo tiene un valor `null` en un campo numérico (no debería),
  la migración lo loguea y salta ese documento. Re-ejecutable a mano:
  `await game.rmf.runWorldMigration({ force: true })`.

## [0.1.x] - Pre-release

### Added
- `README.md`, `CHANGELOG.md` y `LICENSE.txt` (MIT) iniciales.
- `RMF.Chat.Race` en `lang/en.json` (reemplaza la clave huérfana `RMF.Race`).

### Changed
- `system.json`: URLs corregidas a `github.com/TucanSilverhand/rmf`; `download` ahora apunta al release-asset; eliminado `flags.rmf.version` redundante.
- `CONFIG.RMF.version` ahora lee `game.system.version` dinámicamente (single source of truth: `system.json`).
- `.gitignore`: dejó de excluir `*.md` global; añadidas reglas específicas para datos WIP en `data/`.
- `templates/chat/race-applied.hbs`: usa `RMF.Chat.Race` en lugar de `RMF.Race` (que se sombreaba con un objeto y se renderizaba como `[object Object]`).

### Fixed
- Bug i18n: `localize "RMF.Race"` devolvía un objeto en lugar de la cadena "Race".

## [0.1.0] - Inicial pre-release

Primera versión etiquetada del sistema con:
- Actor `character` con 10 stats Rolemaster, derivedStats (HP/PP/resistencias/defensiveBonus) y override por skills "Body Development" / "Power Point Development".
- Items `equipment`, `race`, `skill`, `category`, `realm`, `profession` con sheets ApplicationV2 dedicadas.
- Importers/sync hacia el compendio mundial `world.basic-core`.
- Datos canónicos en `data/`: 46 categorías, 165 skills, 5 razas, 3 reinos y 9 profesiones (estas últimas con campos parcialmente vacíos — pendiente).

[Unreleased]: https://github.com/TucanSilverhand/rmf/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TucanSilverhand/rmf/releases/tag/v0.1.0
