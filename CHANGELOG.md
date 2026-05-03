# Changelog

Todos los cambios notables del sistema **RMF — RoleMaster de Fantasía** se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y la numeración respeta [SemVer](https://semver.org/lang/es/).

## [Unreleased]

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
