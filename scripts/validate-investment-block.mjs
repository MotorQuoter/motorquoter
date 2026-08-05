// Unit tests for lib/investmentBlock.mjs — deterministic, no network.
// Run: node scripts/validate-investment-block.mjs
import { buildInvestmentBlock, FLIP_MARGIN_PCT, DISMANTLING_ALLOWANCE } from '../lib/investmentBlock.mjs';
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
// flip: resale=mid 1800; 1800 - 15% - £100 fees = 1800 - 270 - 100 = 1430
eq('flip ceiling', A.bidCeilings.flip.value, Math.round(1800 - 1800 * FLIP_MARGIN_PCT - 100));
// partsOut: recovery = part-out low (band-derived) − £200 dismantling − £100 fees
eq('partsOut ceiling', A.bidCeilings.partsOut.value, Math.round(estimatePartOut(6000).low - DISMANTLING_ALLOWANCE - 100));
ok('ordering asIsClean.mid > afterRepair > partOut.high', A.asIsClean.mid > A.afterRepairValue && A.afterRepairValue > A.partOut.high);
ok('rebuild ≈ break-even (spec check)', A.bidCeilings.rebuild.value === 1800);
eq('confidence passthrough', A.confidence, 'Medium');
eq('assumptions surfaced', A.assumptions.flipMarginPct, FLIP_MARGIN_PCT);

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
// flip resale = SG mid 1500 → 1500 - 225 - 100 = 1175
eq('flip uses SG mid', B.bidCeilings.flip.value, Math.round(1500 - 1500 * FLIP_MARGIN_PCT - 100));

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

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
