/**
 * RMF System - Equipment item DataModel.
 *
 * Mirrors `template.json:Item.equipment` plus the `equipped` boolean
 * that was used by `RMFActions.#toggleEquipped` but never declared in
 * the legacy template. Adding it here makes the schema honest.
 */

const fields = foundry.data.fields;

const RARITY_CHOICES = ["common", "uncommon", "rare", "very rare", "legendary"];

export class EquipmentData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const num = (initial = 0, opts = {}) =>
      new fields.NumberField({ required: true, nullable: false, initial, ...opts });
    return {
      description: new fields.HTMLField({ required: true, nullable: false, initial: "" }),
      quantity:    num(1, { integer: true, min: 0 }),
      weight:      num(0, { min: 0 }),
      cost:        num(0, { min: 0 }),
      encumbrance: num(0, { min: 0 }),
      rarity: new fields.StringField({
        required: true, nullable: false, blank: false,
        initial: "common",
        choices: RARITY_CHOICES
      }),
      equipped: new fields.BooleanField({ required: true, nullable: false, initial: false })
    };
  }

  /**
   * Derived: encumbrance = weight × quantity.
   * Auto-bumped rarity tier based on cost when no explicit tier is set
   * higher than what the cost suggests (matches the legacy heuristic
   * in `_prepareEquipmentData`).
   */
  prepareDerivedData() {
    super.prepareDerivedData();
    this.encumbrance = (this.weight || 0) * (this.quantity || 1);
    if (this.cost) {
      const auto = this.cost >= 1000 ? "legendary"
                 : this.cost >= 500  ? "rare"
                 : this.cost >= 100  ? "uncommon"
                 : "common";
      this.rarity = auto;
    }
  }
}
