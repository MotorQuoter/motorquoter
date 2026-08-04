// Part-out value estimator for the Investment Block.
//
// Estimates what a vehicle would realistically return if broken for parts, from the
// code-owned used-part price grid (PANEL_PRICE_TABLE in priceBand.mjs) for the vehicle's
// value-band, discounted by a recovery factor (dismantling effort + sell-through haircut).
//
// This is a deliberately ROUGH, conservative estimate — labelled as such in the report.
// Every judgement input below is a NAMED, documented constant so Vincent can tune it
// without touching the logic.
//
// Scope: standard car panels only. Excludes SRS airbags (a salvage car's bags may be
// deployed, and airbag resale is legally fraught) and the van/pickup-only panels. Note:
// HEADLAMP is not in PANEL_PRICE_TABLE (it keeps its own code path), so it is NOT counted
// here — the estimate is conservative by that omission.

import { PANEL_PRICE_TABLE, derivePriceBand, BAND_KEYS } from './priceBand.mjs';

// ── Recovery factors — the fraction of gross used-part value actually realised ───
// Accounts for: not every panel is undamaged/sellable, dismantling + storage labour,
// slow sell-through, and listing effort. Applied to the gross basket used-value to give
// a low/high range. TUNABLE (Vincent).
export const PART_OUT_RECOVERY_LOW  = 0.25;
export const PART_OUT_RECOVERY_HIGH = 0.45;

// ── Part-out basket — the commonly-resold panels of a typical car, with quantities ──
// used-value × qty, summed across the band column. TUNABLE (Vincent): add/remove panels
// or change quantities. panelIds must exist in PANEL_PRICE_TABLE.
export const PART_OUT_BASKET = Object.freeze([
  { panelId: 'FRONT_BUMPER',  qty: 1 },
  { panelId: 'REAR_BUMPER',   qty: 1 },
  { panelId: 'BONNET',        qty: 1 },
  { panelId: 'FRONT_WING',    qty: 2 },
  { panelId: 'FRONT_DOOR',    qty: 2 },
  { panelId: 'REAR_DOOR',     qty: 2 },
  { panelId: 'BOOT_LID',      qty: 1 },
  { panelId: 'REAR_LAMP',     qty: 2 },
  { panelId: 'FOG_LAMP',      qty: 2 },
  { panelId: 'DOOR_MIRROR',   qty: 2 },
  { panelId: 'RADIATOR_PACK', qty: 1 },
  { panelId: 'WINDSCREEN',    qty: 1 },
  { panelId: 'REAR_GLASS',    qty: 1 },
  { panelId: 'SIDE_GLASS',    qty: 2 },
  { panelId: 'WHEEL',         qty: 4 },
  { panelId: 'TYRE',          qty: 4 },
]);

// Gross basket used-value for a band = Σ (used[band] × qty). Panels missing the band
// entry are skipped (defensive; shouldn't happen for these panelIds).
export function grossBasketValue(band) {
  let gross = 0;
  for (const { panelId, qty } of PART_OUT_BASKET) {
    const row = PANEL_PRICE_TABLE[panelId];
    const cell = row && row[band];
    if (cell && Number.isFinite(cell.used)) gross += cell.used * qty;
  }
  return gross;
}

/**
 * estimatePartOut(tradeAvgOrBand) → { low, high, gross, band, recoveryLow, recoveryHigh } | null
 *
 * Accepts either a numeric trade/market value (mapped to a band via derivePriceBand) or a
 * band key string directly. Returns null when the band can't be derived (caller omits the
 * part-out figure rather than showing a fabricated one).
 * low/high are £-rounded (nearest £5, matching the grid's rounding convention).
 */
export function estimatePartOut(tradeAvgOrBand) {
  const band = typeof tradeAvgOrBand === 'string' && Object.values(BAND_KEYS).includes(tradeAvgOrBand)
    ? tradeAvgOrBand
    : derivePriceBand(tradeAvgOrBand);
  if (!band) return null;

  const gross = grossBasketValue(band);
  if (!(gross > 0)) return null;

  const round5 = v => Math.round(v / 5) * 5;
  return {
    low:  round5(gross * PART_OUT_RECOVERY_LOW),
    high: round5(gross * PART_OUT_RECOVERY_HIGH),
    gross,
    band,
    recoveryLow:  PART_OUT_RECOVERY_LOW,
    recoveryHigh: PART_OUT_RECOVERY_HIGH,
  };
}
