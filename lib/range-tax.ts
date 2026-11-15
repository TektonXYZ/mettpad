/**
 * Range tax: the tax follows the market cap, not the clock. It opens at `openingBps` at the
 * launch price, falls in a straight line as the market cap climbs, sits at `floorBps` from the
 * target market cap up, and climbs back the same way whenever the market cap drops below it.
 *
 * This is Meteora DAMM v2's own market-cap fee scheduler (FeeMarketCapSchedulerLinear), not a
 * MetPad contract: the pool counts how far its sqrt price sits above the launch sqrt price, in
 * steps of `sqrtPriceStepBps` basis points, and knocks `reductionFactor` off the tax per step,
 * for at most `numberOfPeriod` steps. Plain numbers only, so the launch form can use it too.
 */

/** Meteora stores the step count as a u16. */
const MAX_STEPS = 65_535;

/**
 * Meteora insists on an expiry, after which the tax is pinned to the floor whatever the price.
 * u32 max seconds ≈ 136 years, so in practice the range never expires.
 */
export const RANGE_EXPIRY_SECONDS = 4_294_967_295;

/** The target has to sit at least this far above the launch market cap. */
export const MIN_RANGE_MULTIPLE = 1.1;
export const MAX_RANGE_MULTIPLE = 10_000;

/** Fee numerators are over 1e9, so 1 bps = 1e5. */
const BPS = 100_000;

export type RangeSchedule = {
  cliffFeeNumerator: number;
  reductionFactor: number;
  numberOfPeriod: number;
  sqrtPriceStepBps: number;
};

/** The schedule that goes from openingBps at the launch price to floorBps at `multiple` × it. */
export function rangeSchedule(openingBps: number, floorBps: number, multiple: number): RangeSchedule {
  const totalStepBps = (Math.sqrt(multiple) - 1) * 10_000;
  // The finest steps the u16 count allows: one basis point of sqrt price per step when it fits.
  const sqrtPriceStepBps = Math.max(1, Math.ceil(totalStepBps / MAX_STEPS));
  const numberOfPeriod = Math.max(1, Math.round(totalStepBps / sqrtPriceStepBps));
  const cliffFeeNumerator = openingBps * BPS;
  return {
    cliffFeeNumerator,
    // Rounded down, so the floor lands a hair above floorBps (under 1 bps), never under it.
    reductionFactor: Math.floor((cliffFeeNumerator - floorBps * BPS) / numberOfPeriod),
    numberOfPeriod,
    sqrtPriceStepBps,
  };
}

/** The tax at the bottom of the range. */
export function floorBpsOf(s: RangeSchedule): number {
  return (s.cliffFeeNumerator - s.numberOfPeriod * s.reductionFactor) / BPS;
}

/** Market-cap multiple (over the launch market cap) where the floor starts, after whole-step rounding. */
export function targetMultipleOf(s: RangeSchedule): number {
  const sqrt = 1 + (s.numberOfPeriod * s.sqrtPriceStepBps) / 10_000;
  return sqrt * sqrt;
}

/** The tax, in bps, a trade pays when it starts at market cap `mc`. Mirrors the on-chain math. */
export function rangeTaxBps(s: RangeSchedule, startMc: number, mc: number): number {
  if (!(mc > startMc)) return s.cliffFeeNumerator / BPS;
  const passed = Math.floor(((Math.sqrt(mc / startMc) - 1) * 10_000) / s.sqrtPriceStepBps);
  return (s.cliffFeeNumerator - Math.min(s.numberOfPeriod, passed) * s.reductionFactor) / BPS;
}
