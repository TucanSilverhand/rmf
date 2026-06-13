/**
 * Single import surface for all RMF DataModels. rmf.mjs registers
 * these on `CONFIG.Actor.dataModels` and `CONFIG.Item.dataModels`.
 */

export { CharacterData }       from "./character.mjs";
export { EquipmentData }       from "./equipment.mjs";
export { RaceData }            from "./race.mjs";
export { SkillData }           from "./skill.mjs";
export { CategoryData }        from "./category.mjs";
export { RealmData }           from "./realm.mjs";
export { ProfessionData }      from "./profession.mjs";
export { TrainingPackageData } from "./training-package.mjs";
export { SpellListData }       from "./spell-list.mjs";
export { AttackTableData }     from "./attack-table.mjs";
export { CriticalTableData }   from "./critical-table.mjs";
export { CreatureCriticalTableData } from "./creature-critical-table.mjs";
export { WeaponFumbleTableData }     from "./weapon-fumble-table.mjs";
export { SpellFailureTableData }     from "./spell-failure-table.mjs";
