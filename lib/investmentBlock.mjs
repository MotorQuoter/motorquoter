// Investment Block assembler (AEP-style) for the salvage report.
//
// PURE function — takes figures the assess route has already computed and packages them,
// plus two derived pieces (part-out value, as-is-salvage value) and three named bid
// ceilings. It never recomputes exit/margin; it READS them. Returns null when there is
// nothing meaningful to show (caller omits the block).
//
// Semantics (verified against the existing code, per the IAA lesson):
//   • asIsClean       = UNDAMAGED market retail (bregoData.retail_low/average/high) — a
//                       condition range, NOT cat-discounted.
//   • afterRepairValue= the cat-adjusted ARV = assessment._exitValue (trade-low × band %).
//   • asIsSalvage     = current unrepaired salvage value. Prefer the SalvageGuide predicted
//                       bid range (a direct market prediction); else a band around the
//                       engine's break-even hammer taken from the hammer ladder; else null.
//   • bidCeilings.rebuild  (MRB) = break-even hammer (max rebuild bid, zero margin).
//   • bidCeilings.flip     (MFB) = buy/no-repair/resell-as-salvage: resale − margin − fees.
//   • bidCeilings.partsOut (MSB) = part-out recovery − dismantling − fees.
//
// Fee note: a bid ceiling's fees are computed at the RESALE/RECOVERY figure (an upper bound
// on the bid), so fees are slightly over-stated → the ceiling is conservative. Deliberate.
//
// TUNABLE constants (Vincent): the two below plus the part-out factors in lib/partOut.mjs.

import { estimatePartOut, PART_OUT_RECOVERY_LOW, PART_OUT_RECOVERY_HIGH } from './partOut.mjs';

// Flipper's target margin as a fraction of the salvage resale value.
export const FLIP_MARGIN_PCT = 0.15;
// Flat labour/handling allowance (£) to break a vehicle for parts.
export const DISMANTLING_ALLOWANCE = 200;

// NB: Number(null)===0 and Number('')===0 are both finite, so guard those explicitly —
// otherwise a null figure would masquerade as £0 and produce a bogus £0 ceiling.
const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num = v => (isNum(v) ? Number(v) : null);
const r0 = v => Math.round(Number(v));

export function buildInvestmentBlock(input = {}) {
  const {
    retailLow, retailAverage, retailHigh,
    tradeAverage,          // drives the part-out value-band (same input as the repair estimate)
    exitValue,             // after-repair value (ARV)
    breakEven,             // breakEvenHammer(marginScenarios) | null
    hammerLadder,          // buildHammerLadder(exitValue) | null
    salvageGuide,          // { salvage_auction_predicted_bid_{low,average,high}_gbp } | null
    confidence,            // assessment['Confidence Level'] | null
    feeStackFn,            // FEE_STACKS[auctionSource] | undefined
  } = input;

  // As-is clean (undamaged market range)
  const asIsClean = (isNum(retailLow) || isNum(retailAverage) || isNum(retailHigh))
    ? { low: num(retailLow), mid: num(retailAverage), high: num(retailHigh) }
    : null;

  const afterRepairValue = num(exitValue);

  // Part-out value (band-consistent with the repair estimate: derivePriceBand(tradeAverage))
  const po = estimatePartOut(isNum(tradeAverage) ? Number(tradeAverage) : null);
  const partOut = po ? { low: po.low, high: po.high } : null;

  // As-is salvage value
  let asIsSalvage = null;
  const sgLow  = salvageGuide?.salvage_auction_predicted_bid_low_gbp;
  const sgAvg  = salvageGuide?.salvage_auction_predicted_bid_average_gbp;
  const sgHigh = salvageGuide?.salvage_auction_predicted_bid_high_gbp;
  if (isNum(sgLow) && isNum(sgHigh)) {
    asIsSalvage = { low: r0(sgLow), mid: isNum(sgAvg) ? r0(sgAvg) : null, high: r0(sgHigh), basis: 'salvageguide' };
  } else if (isNum(breakEven) && Array.isArray(hammerLadder) && hammerLadder.length) {
    const be = Number(breakEven);
    const below = [...hammerLadder].filter(h => h <= be).pop();
    const above = hammerLadder.find(h => h >= be);
    const lo = below ?? hammerLadder[0];
    const hi = above ?? hammerLadder[hammerLadder.length - 1];
    asIsSalvage = { low: Math.min(lo, hi), mid: r0(be), high: Math.max(lo, hi), basis: 'breakeven-band' };
  }

  // ── Bid ceilings ──────────────────────────────────────────────────────────
  const fees = (h) => (feeStackFn && isNum(h) ? feeStackFn(Number(h)).totalIncVat : null);

  const rebuild = isNum(breakEven)
    ? { value: r0(breakEven), assumption: 'Break-even hammer — the most you can bid, rebuild, and exit at the after-repair value with zero margin.' }
    : null;

  let flip = null;
  const resale = asIsSalvage ? (asIsSalvage.mid ?? asIsSalvage.high) : null;
  if (isNum(resale) && feeStackFn) {
    const f = fees(resale);
    const value = Math.max(0, r0(resale - resale * FLIP_MARGIN_PCT - f));
    flip = { value, assumption: `Buy, no repair, resell as salvage ≈ £${r0(resale)}; less ${Math.round(FLIP_MARGIN_PCT * 100)}% margin and buyer fees.` };
  }

  let partsOut = null;
  if (partOut && isNum(partOut.low) && feeStackFn) {
    const recovery = partOut.low; // conservative expected parts revenue
    const f = fees(recovery);
    const value = Math.max(0, r0(recovery - DISMANTLING_ALLOWANCE - f));
    partsOut = { value, assumption: `Conservative parts recovery £${r0(recovery)}; less £${DISMANTLING_ALLOWANCE} dismantling and buyer fees.` };
  }

  const block = {
    asIsClean,
    asIsSalvage,
    afterRepairValue,
    partOut,
    confidence: confidence ?? null,
    bidCeilings: { rebuild, flip, partsOut },
    assumptions: {
      flipMarginPct: FLIP_MARGIN_PCT,
      dismantlingAllowance: DISMANTLING_ALLOWANCE,
      partOutRecoveryLow: PART_OUT_RECOVERY_LOW,
      partOutRecoveryHigh: PART_OUT_RECOVERY_HIGH,
    },
  };

  const hasContent = asIsClean || afterRepairValue != null || asIsSalvage || partOut || rebuild || flip || partsOut;
  return hasContent ? block : null;
}
