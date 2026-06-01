/**
 * RMF Tables — open-ended d100.
 *
 * RoleMaster's signature die: a d100 that "explodes". On a high result
 * the die is re-rolled and added (and may explode again); on a low
 * result it may be re-rolled and subtracted. Attack rolls are high
 * open-ended only, so both directions are configurable and low is off
 * by default.
 *
 * Uses Foundry's Roll so each sub-roll participates in Dice So Nice and
 * the dice log. The resolver can also be handed a precomputed result
 * (see {@link resolveAttack}) to keep it unit-testable without dice.
 *
 * @module tables/open-ended
 */

/**
 * @typedef {Object} OpenEndedResult
 * @property {number} natural   The very first die (drives fumble checks).
 * @property {number} total     The summed, possibly-exploded total.
 * @property {number[]} dice    Every die rolled, in order.
 * @property {boolean} openHigh Whether the roll exploded upward.
 * @property {boolean} openLow  Whether the roll exploded downward.
 * @property {Roll[]} rolls     The underlying Roll objects (for chat).
 */

/**
 * Roll an open-ended d100.
 *
 * @param {Object} [options]
 * @param {boolean} [options.high=true]   Re-roll & add on a high result.
 * @param {boolean} [options.low=false]   Re-roll & subtract on a low result.
 * @param {number}  [options.highAt=96]   Explode upward when die >= this.
 * @param {number}  [options.lowAt=5]     Explode downward when die <= this.
 * @param {number}  [options.cap=25]      Safety cap on explosion iterations.
 * @returns {Promise<OpenEndedResult>}
 */
export async function rollOpenEndedD100({
  high = true, low = false, highAt = 96, lowAt = 5, cap = 25
} = {}) {
  const rolls = [];
  const dice = [];

  const rollOne = async () => {
    const r = new Roll("1d100");
    await r.evaluate();
    rolls.push(r);
    const v = r.total;
    dice.push(v);
    return v;
  };

  const natural = await rollOne();
  let total = natural;
  let openHigh = false;
  let openLow = false;

  // High open-ended: keep adding while the latest die is high.
  if (high && natural >= highAt) {
    openHigh = true;
    let last = natural;
    let i = 0;
    while (last >= highAt && i < cap) {
      last = await rollOne();
      total += last;
      i++;
    }
  } else if (low && natural <= lowAt) {
    // Low open-ended: single re-roll subtracted (RMFR attack convention).
    openLow = true;
    const sub = await rollOne();
    total -= sub;
  }

  return { natural, total, dice, openHigh, openLow, rolls };
}
