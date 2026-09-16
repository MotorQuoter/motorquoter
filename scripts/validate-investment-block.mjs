// Unit tests for lib/investmentBlock.mjs — deterministic, no network.
// Run: node scripts/validate-investment-block.mjs
import * as IB from '../lib/investmentBlock.mjs';
import { buildInvestmentBlock, DISMANTLING_ALLOWANCE, ceilingHammerForOutlay } from '../lib/investmentBlock.mjs';
import { feeStack as copartFeeStack } from '../lib/copartFees.js';
import { estimatePartOut } from '../lib/partOut.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

const feeStub = () => ({ totalIncVat: 100 }); // deterministic fees
const ladder = [400, 700, 1000, 1300, 1600, 2000];

// ── Case A: no SalvageGuide → break-even-band as-is-salvage ────────────────────
console.log('\n=== Case A: break-even-band (no SalvageGuide) ===\n');
const A = buildInvestmentBlock({
  retailLow: 6000, retailAverage: 7500, retailHigh: 9000,
  tradeAverage: 6000,          // → Mid-range band → part-out {825,1485}
  exitValue: 4000,
  breakEven: 1800,
  hammerLadder: ladder,
  salvageGuide: null,
  confidence: 'Medium',
  feeStackFn: feeStub,
});
eq('asIsClean range', A.asIsClean, { low: 6000, mid: 7500, high: 9000 });
eq('afterRepairValue = exitValue', A.afterRepairValue, 4000);
eq('partOut band-consistent', A.partOut, { low: estimatePartOut(6000).low, high: estimatePartOut(6000).high });
eq('asIsSalvage basis', A.asIsSalvage.basis, 'breakeven-band');
eq('asIsSalvage band around break-even', { low: A.asIsSalvage.low, mid: A.asIsSalvage.mid, high: A.asIsSalvage.high }, { low: 1600, mid: 1800, high: 2000 });
eq('rebuild = break-even hammer', A.bidCeilings.rebuild.value, 1800);
// batch 134 (Vincent, 15 Sep — INFORM, DO NOT DECIDE): flip is a ZERO-MARGIN break-even. resale=mid 1800 − £100 fees = 1700
eq('flip ceiling = resale − fees, zero margin', A.bidCeilings.flip.value, 1800 - 100);
// partsOut: recovery = part-out low (band-derived) − £200 dismantling − £100 fees
eq('partsOut ceiling', A.bidCeilings.partsOut.value, Math.round(estimatePartOut(6000).low - DISMANTLING_ALLOWANCE - 100));
ok('ordering asIsClean.mid > afterRepair > partOut.high', A.asIsClean.mid > A.afterRepairValue && A.afterRepairValue > A.partOut.high);
ok('rebuild ≈ break-even (spec check)', A.bidCeilings.rebuild.value === 1800);
eq('confidence passthrough', A.confidence, 'Medium');

// ── batch 134 — the flipper's margin is GONE, not set to zero somewhere it could come back ─────
console.log('\n=== batch 134: no baked-in flip margin ===\n');
ok('FLIP_MARGIN_PCT is no longer exported', !('FLIP_MARGIN_PCT' in IB));
ok('assumptions no longer carry a flip margin', !('flipMarginPct' in A.assumptions));
eq('flip wording states zero margin and leaves the profit to the buyer', A.bidCeilings.flip.assumption, 'Buy, no repair, resell as salvage ≈ £1800; less buyer fees — zero margin. Take off the profit you want.');
ok('no "%" margin wording survives on any ceiling', !Object.values(A.bidCeilings).some((c) => c && /%\s*margin/i.test(c.assumption)));
{
  const { readFileSync } = await import('node:fs');
  ok('lib source carries no 15% / FLIP_MARGIN constant', !/FLIP_MARGIN_PCT|0\.15/.test(readFileSync('lib/investmentBlock.mjs', 'utf8')));
}

// ── Case B: SalvageGuide present → its predicted-bid range wins ────────────────
console.log('\n=== Case B: SalvageGuide predicted-bid range ===\n');
const B = buildInvestmentBlock({
  retailLow: 6000, retailAverage: 7500, retailHigh: 9000,
  tradeAverage: 6000, exitValue: 4000,
  breakEven: 1800, hammerLadder: ladder,
  salvageGuide: {
    salvage_auction_predicted_bid_low_gbp: 1200,
    salvage_auction_predicted_bid_average_gbp: 1500,
    salvage_auction_predicted_bid_high_gbp: 1900,
  },
  confidence: 'High', feeStackFn: feeStub,
});
eq('asIsSalvage basis = salvageguide', B.asIsSalvage.basis, 'salvageguide');
eq('asIsSalvage from SG range', { low: B.asIsSalvage.low, mid: B.asIsSalvage.mid, high: B.asIsSalvage.high }, { low: 1200, mid: 1500, high: 1900 });
// flip resale = SG mid 1500 → 1500 − £100 fees = 1400 (zero margin, batch 134)
eq('flip uses SG mid, zero margin', B.bidCeilings.flip.value, 1500 - 100);

// ── Case C: no feeStackFn → flip/partsOut null, block still returned ───────────
console.log('\n=== Case C: no feeStackFn ===\n');
const C = buildInvestmentBlock({ retailAverage: 5000, exitValue: 3000, breakEven: 1500, hammerLadder: ladder, tradeAverage: 4000 });
eq('rebuild still present', C.bidCeilings.rebuild.value, 1500);
eq('flip null without fees', C.bidCeilings.flip, null);
eq('partsOut null without fees', C.bidCeilings.partsOut, null);
ok('block still returned', C !== null);

// ── Case D: empty input → null (nothing meaningful) ───────────────────────────
console.log('\n=== Case D: empty → null ===\n');
eq('empty input → null', buildInvestmentBlock({}), null);
eq('no-arg → null', buildInvestmentBlock(), null);

// ── Case E: break-even null and no SG → asIsSalvage null (never fabricated) ────
console.log('\n=== Case E: no salvage anchor → asIsSalvage null ===\n');
const E = buildInvestmentBlock({ retailAverage: 5000, exitValue: 3000, tradeAverage: 4000, feeStackFn: feeStub });
eq('asIsSalvage null when no SG and no break-even', E.asIsSalvage, null);
eq('rebuild null when no break-even', E.bidCeilings.rebuild, null);
eq('flip null when no asIsSalvage', E.bidCeilings.flip, null);
ok('partsOut still computes from part-out', E.bidCeilings.partsOut !== null);

console.log('\n=== Case F: rebuildHammer surfaces the ceiling above the ladder (B fix) ===\n');
// breakEven null (in-range crossing absent) but rebuildHammer supplied → rebuild renders from it.
const F = buildInvestmentBlock({ retailAverage: 5000, exitValue: 11200, tradeAverage: 6000, breakEven: null, rebuildHammer: 6547, feeStackFn: feeStub });
eq('rebuild uses rebuildHammer when breakEven null', F.bidCeilings.rebuild.value, 6547);
// rebuildHammer takes precedence over breakEven when both present.
const G = buildInvestmentBlock({ retailAverage: 5000, exitValue: 3000, tradeAverage: 4000, breakEven: 1500, rebuildHammer: 1800, feeStackFn: feeStub });
eq('rebuildHammer takes precedence over breakEven', G.bidCeilings.rebuild.value, 1800);
// still null when both absent.
const H = buildInvestmentBlock({ retailAverage: 5000, exitValue: 3000, tradeAverage: 4000, breakEven: null, rebuildHammer: null, feeStackFn: feeStub });
eq('rebuild null when both breakEven and rebuildHammer absent', H.bidCeilings.rebuild, null);

// -- Case I (batch 141 item 2): hammer VAT in the flip and part-out ceilings --------------------
// On a VAT-qualifying lot the buyer pays 20% VAT on the hammer as well as the fees. The margin
// ladder and the rebuild ceiling have always charged it; flip and partsOut did not, and over-stated
// the ceiling - the buyer was told he could bid MORE than he can.
console.log('\n=== Case I: hammer VAT on the flip / part-out ceilings ===\n');

// The real Copart schedule, so the HV25ODX figures in the batch 141 report are locked here.
const realFees = copartFeeStack;
const sgHV = {
  salvage_auction_predicted_bid_low_gbp: 2800,
  salvage_auction_predicted_bid_average_gbp: 3266,
  salvage_auction_predicted_bid_high_gbp: 3700,
};
const IB_NOVAT = buildInvestmentBlock({
  retailAverage: 13294, tradeAverage: 11565, exitValue: 8000,
  salvageGuide: sgHV, feeStackFn: realFees, vatQualifying: false,
});
const IB_VAT = buildInvestmentBlock({
  retailAverage: 13294, tradeAverage: 11565, exitValue: 8000,
  salvageGuide: sgHV, feeStackFn: realFees, vatQualifying: true,
});

// Non-VAT lot: UNCHANGED - resale less fees at the resale figure (£3,266 - £676.80 = £2,589.20).
eq('HV25ODX shape, non-VAT: flip unchanged at £2,589', IB_NOVAT.bidCeilings.flip.value, 2589);
// VAT lot: the hammer at which hammer + 20% + fees = £3,266.
//   £2,242 x 1.20 = £2,690.40, fees(£2,242) = £574.80  ->  £3,265.20 <= £3,266
//   £2,243 x 1.20 = £2,691.60, fees(£2,243) = £574.80  ->  £3,266.40 >  £3,266
eq('HV25ODX shape, VAT: flip drops to the hammer £2,242', IB_VAT.bidCeilings.flip.value, 2242);
ok('VAT flip is BELOW the non-VAT flip (never bids higher)', IB_VAT.bidCeilings.flip.value < IB_NOVAT.bidCeilings.flip.value);

// The ceiling is a true solution: outlay at the ceiling fits, outlay one pound up does not.
const outlay = (h) => h * 1.20 + realFees(h).totalIncVat;
ok('flip ceiling: hammer + VAT + fees <= resale', outlay(IB_VAT.bidCeilings.flip.value) <= 3266 + 1e-9);
ok('flip ceiling: one pound more does NOT fit', outlay(IB_VAT.bidCeilings.flip.value + 1) > 3266);

// partsOut: the same solve, against recovery less the dismantling allowance.
const poLow = estimatePartOut(11565).low;
// NOTE (reported to Vincent, batch 141 item 2): partsOut moves UP on this shape, £563 -> £584.
// Not a VAT error - the OLD formula charged fees at the RECOVERY figure (fees(£1,200) = £436.80) against
// a bid that could never be £1,200. Charging fees at the real hammer (fees(£584) = £298.80) frees more
// than the 20% hammer VAT (£116.80) costs. The solve is exact either way; the direction is a consequence
// of the fees-at-hammer basis the brief specifies, matching the rebuild ceiling.
eq('partsOut, non-VAT: unchanged at £563', IB_NOVAT.bidCeilings.partsOut.value, 563);
eq('partsOut, VAT: exact hammer solve £584', IB_VAT.bidCeilings.partsOut.value, 584);
ok('partsOut ceiling: hammer + VAT + fees <= recovery - dismantling',
   outlay(IB_VAT.bidCeilings.partsOut.value) <= (poLow - DISMANTLING_ALLOWANCE) + 1e-9);
ok('partsOut ceiling: one pound more does NOT fit',
   outlay(IB_VAT.bidCeilings.partsOut.value + 1) > (poLow - DISMANTLING_ALLOWANCE));

// Default (no vatQualifying passed) must behave as a non-VAT lot - every pre-141 caller and every
// stored replay keeps its figures.
const IB_DEFAULT = buildInvestmentBlock({
  retailAverage: 13294, tradeAverage: 11565, exitValue: 8000,
  salvageGuide: sgHV, feeStackFn: realFees,
});
eq('omitted vatQualifying = non-VAT (flip)', IB_DEFAULT.bidCeilings.flip.value, IB_NOVAT.bidCeilings.flip.value);
eq('omitted vatQualifying = non-VAT (partsOut)', IB_DEFAULT.bidCeilings.partsOut.value, IB_NOVAT.bidCeilings.partsOut.value);

// The rebuild ceiling is NOT touched by this change - it already carried hammer VAT through the ladder.
eq('rebuild ceiling untouched by vatQualifying', IB_VAT.bidCeilings.rebuild, IB_NOVAT.bidCeilings.rebuild);

// The solver itself.
console.log('\n=== Case J: ceilingHammerForOutlay ===\n');
eq('null target -> null', ceilingHammerForOutlay(null, realFees, { vatQualifying: true }), null);
eq('no fee fn -> null', ceilingHammerForOutlay(1000, null, { vatQualifying: true }), null);
eq('target below the fixed fee floor -> 0', ceilingHammerForOutlay(10, realFees, { vatQualifying: true }), 0);
ok('non-VAT solve fits and is maximal', (() => {
  const h = ceilingHammerForOutlay(3266, realFees, { vatQualifying: false });
  const o = (x) => x + realFees(x).totalIncVat;
  return o(h) <= 3266 + 1e-9 && o(h + 1) > 3266;
})());
ok('VAT solve is strictly below the non-VAT solve',
   ceilingHammerForOutlay(3266, realFees, { vatQualifying: true }) < ceilingHammerForOutlay(3266, realFees, { vatQualifying: false }));

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
