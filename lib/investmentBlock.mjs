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
//   • bidCeilings.flip     (MFB) = buy/no-repair/resell-as-salvage: resale − fees (zero margin, batch 134).
//   • bidCeilings.partsOut (MSB) = part-out recovery − dismantling − fees.
//
// Fee note: on a NON-VAT lot a bid ceiling's fees are computed at the RESALE/RECOVERY figure (an
// upper bound on the bid), so fees are slightly over-stated → the ceiling is conservative. Deliberate.
//
// batch 141 item 2 — HAMMER VAT. On a VAT-qualifying lot (Copart "VAT on Sale: Yes") the buyer pays
// 20% VAT ON THE HAMMER on top of the hammer and the fees. The margin ladder (route.js) and the
// rebuild ceiling derived from it have always charged it; `flip` and `partsOut` did not, so both
// over-stated the ceiling — the buyer was told he could bid MORE than he can, which is the worse
// error. On a VAT lot both are now solved the same way the rebuild ceiling is: the ceiling is the
// HAMMER at which hammer + hammer VAT + fees equals the resale (or recovery less dismantling)
// figure, with fees evaluated AT THE HAMMER — the same basis as the ladder, which charges
// feeStackFn(hammer) at each rung. A non-VAT lot keeps the old arithmetic exactly, unchanged.
//
// TUNABLE constants (Vincent): the one below plus the part-out factors in lib/partOut.mjs.
// batch 134 (Vincent, 15 Sep): the flipper's target margin (was 15%) is REMOVED, not zeroed — no ceiling bakes in a
// required margin (INFORM, DO NOT DECIDE, 14 Sep).

import { estimatePartOut, PART_OUT_RECOVERY_LOW, PART_OUT_RECOVERY_HIGH } from './partOut.mjs';

// Flat labour/handling allowance (£) to break a vehicle for parts.
export const DISMANTLING_ALLOWANCE = 200;

// VAT charged on the hammer of a VAT-qualifying lot. Same rate the margin ladder uses
// (route.js: `hammer * 0.20`) and the same rate lib/predictedBidFees.mjs charges.
export const HAMMER_VAT_RATE = 0.20;

// NB: Number(null)===0 and Number('')===0 are both finite, so guard those explicitly —
// otherwise a null figure would masquerade as £0 and produce a bogus £0 ceiling.
const isNum = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const num = v => (isNum(v) ? Number(v) : null);
const r0 = v => Math.round(Number(v));

// The largest WHOLE-POUND hammer whose total outlay — hammer + hammer VAT + buyer fees at that
// hammer — does not exceed `target`. Both Copart fee schedules (buyer fee, bid fee) are
// non-decreasing in the hammer, so total outlay is monotone and a binary search is exact.
// Returns 0 when even a £0 hammer's fixed fees already exceed the target (the caller's floor).
export function ceilingHammerForOutlay(target, feeStackFn, { vatQualifying = false } = {}) {
  if (!isNum(target) || typeof feeStackFn !== 'function') return null;
  const t = Number(target);
  const rate = vatQualifying ? HAMMER_VAT_RATE : 0;
  const outlay = (h) => h * (1 + rate) + Number(feeStackFn(h).totalIncVat);
  if (!(outlay(0) <= t)) return 0;
  let lo = 0, hi = Math.max(0, Math.ceil(t));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (outlay(mid) <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function buildInvestmentBlock(input = {}) {
  const {
    retailLow, retailAverage, retailHigh,
    tradeAverage,          // drives the part-out value-band (same input as the repair estimate)
    exitValue,             // after-repair value (ARV)
    breakEven,             // breakEvenHammer(marginScenarios) | null — in-range only (divergence fail-safe)
    rebuildHammer,         // rebuildCeilingHammer(marginScenarios) | null — extrapolates above the ladder
    hammerLadder,          // buildHammerLadder(exitValue) | null
    salvageGuide,          // { salvage_auction_predicted_bid_{low,average,high}_gbp } | null
    confidence,            // assessment['Confidence Level'] | null
    feeStackFn,            // FEE_STACKS[auctionSource] | undefined
    vatQualifying = false, // enrichedVd.vatOnSale === 'Yes' — 20% VAT is charged ON THE HAMMER (batch 141 item 2)
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
  // batch 143 T1 (Vincent, 16 Sep — "same method"): ONE fee basis for every lot. Both ceilings are
  // solved with ceilingHammerForOutlay, on a VAT lot at 20% and on a non-VAT lot at 0%. The old
  // fees-at-resale arithmetic is GONE. It evaluated the fee stack at the resale/recovery figure — a
  // bid the buyer could never make — which over-stated the fees and under-stated the ceiling by
  // whatever the fee bands happened to do between the two figures. Fees are now charged at the
  // hammer actually being paid: the same basis as the margin ladder and the rebuild ceiling.

  // Rebuild ceiling prefers the extrapolating rebuildHammer (surfaces the ceiling when break-even
  // sits above the ladder top); falls back to the in-range breakEven when rebuildHammer is absent.
  const rebuildBasis = isNum(rebuildHammer) ? Number(rebuildHammer) : (isNum(breakEven) ? Number(breakEven) : null);
  const rebuild = isNum(rebuildBasis)
    ? { value: r0(rebuildBasis), assumption: 'Break-even hammer — the most you can bid, rebuild, and exit at the after-repair value with zero margin.' }
    : null;

  // batch 134 (Vincent, 15 Sep — "INFORM, DO NOT DECIDE: the engine never bakes in a required margin"): the flip
  // ceiling is a ZERO-MARGIN break-even, like the rebuild ceiling. The 15% flipper's margin is removed; the buyer
  // takes off the profit he wants.
  let flip = null;
  const resale = asIsSalvage ? (asIsSalvage.mid ?? asIsSalvage.high) : null;
  if (isNum(resale) && feeStackFn) {
    // The hammer at which hammer + hammer VAT (VAT lots only) + fees at that hammer = the resale figure.
    const value = ceilingHammerForOutlay(resale, feeStackFn, { vatQualifying });
    const less  = vatQualifying ? 'less VAT on the hammer and buyer fees' : 'less buyer fees';
    flip = { value, assumption: `Buy, no repair, resell as salvage ≈ £${r0(resale)}; ${less} — zero margin. Take off the profit you want.` };
  }

  let partsOut = null;
  if (partOut && isNum(partOut.low) && feeStackFn) {
    const recovery = partOut.low; // conservative expected parts revenue
    // Same solve, against the recovery figure LESS the dismantling allowance.
    const value = ceilingHammerForOutlay(recovery - DISMANTLING_ALLOWANCE, feeStackFn, { vatQualifying });
    const less  = vatQualifying ? `less £${DISMANTLING_ALLOWANCE} dismantling, VAT on the hammer and buyer fees` : `less £${DISMANTLING_ALLOWANCE} dismantling and buyer fees`;
    partsOut = { value, assumption: `Conservative parts recovery £${r0(recovery)}; ${less}.` };
  }

  const block = {
    asIsClean,
    asIsSalvage,
    afterRepairValue,
    partOut,
    confidence: confidence ?? null,
    bidCeilings: { rebuild, flip, partsOut },
    assumptions: {
      dismantlingAllowance: DISMANTLING_ALLOWANCE,
      partOutRecoveryLow: PART_OUT_RECOVERY_LOW,
      partOutRecoveryHigh: PART_OUT_RECOVERY_HIGH,
    },
  };

  const hasContent = asIsClean || afterRepairValue != null || asIsSalvage || partOut || rebuild || flip || partsOut;
  return hasContent ? block : null;
}
