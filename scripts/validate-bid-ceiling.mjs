// Unit tests for lib/bidCeiling.mjs — deterministic, no network.
// Run: node scripts/validate-bid-ceiling.mjs
import { rebuildCeilingHammer } from '../lib/bidCeiling.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

// In-range zero-crossing must match route.js breakEvenHammer (linear interpolation).
function breakEvenHammer(scenarios) {
  const pts = scenarios.filter(s => Number.isFinite(Number(s?.hammer)) && Number.isFinite(Number(s?.margin)));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.margin >= 0 && b.margin < 0) || (a.margin < 0 && b.margin >= 0)) {
      const t = a.margin / (a.margin - b.margin);
      return Math.round(a.hammer + t * (b.hammer - a.hammer));
    }
  }
  return null;
}

console.log('\n=== DMZ4614 real ladder — all margins positive, break-even ABOVE the ladder top ===\n');
// The exact _marginScenarios stored for DMZ4614 (Cat S Tucson) — breakEvenHammer returns null here.
const dmz = [
  { hammer: 1000, margin: 6012.2 },
  { hammer: 2000, margin: 4850.2 },
  { hammer: 3000, margin: 3748.2 },
  { hammer: 3750, margin: 2950.2 },
  { hammer: 4750, margin: 1854.2 },
  { hammer: 5500, margin: 1080.2 },
];
eq('breakEvenHammer(DMZ) is null (no in-range crossing)', breakEvenHammer(dmz), null);
const dmzCeil = rebuildCeilingHammer(dmz);
ok('rebuildCeilingHammer(DMZ) surfaces a ceiling (not null)', dmzCeil != null);
// slope from last two: (1080.2-1854.2)/(5500-4750) = -1.0320; be = 5500 - 1080.2/-1.0320 ≈ 6546.7
eq('rebuildCeilingHammer(DMZ) ≈ £6547 (extrapolated)', dmzCeil, 6547);
ok('ceiling sits ABOVE the ladder top (5500)', dmzCeil > 5500);

console.log('\n=== In-range crossing: identical to breakEvenHammer (no regression) ===\n');
const crossing = [
  { hammer: 2000, margin: 1500 },
  { hammer: 3000, margin: 500 },
  { hammer: 4000, margin: -500 },
  { hammer: 5000, margin: -1500 },
];
eq('breakEvenHammer(crossing) = 3500', breakEvenHammer(crossing), 3500);
eq('rebuildCeilingHammer(crossing) == breakEvenHammer (unchanged)', rebuildCeilingHammer(crossing), breakEvenHammer(crossing));

console.log('\n=== Crossing exactly at a sampled point ===\n');
const atZero = [ { hammer: 2000, margin: 1000 }, { hammer: 3000, margin: 0 }, { hammer: 4000, margin: -1000 } ];
eq('rebuildCeilingHammer matches breakEvenHammer at exact zero', rebuildCeilingHammer(atZero), breakEvenHammer(atZero));

console.log('\n=== All-negative margins → null (repair not viable at any shown hammer) ===\n');
const allNeg = [ { hammer: 1000, margin: -100 }, { hammer: 2000, margin: -800 }, { hammer: 3000, margin: -1600 } ];
eq('breakEvenHammer(allNeg) null', breakEvenHammer(allNeg), null);
eq('rebuildCeilingHammer(allNeg) null (no false ceiling)', rebuildCeilingHammer(allNeg), null);

console.log('\n=== Guards ===\n');
eq('empty → null', rebuildCeilingHammer([]), null);
eq('single point → null', rebuildCeilingHammer([{ hammer: 1000, margin: 500 }]), null);
eq('non-array → null', rebuildCeilingHammer(null), null);
eq('flat/ascending margin (degenerate) → null', rebuildCeilingHammer([{ hammer: 1000, margin: 100 }, { hammer: 2000, margin: 200 }]), null);
// last two positive but earlier crossing exists → in-range wins
const dip = [ { hammer: 1000, margin: 100 }, { hammer: 2000, margin: -50 }, { hammer: 3000, margin: 200 } ];
eq('in-range crossing takes precedence over tail extrapolation', rebuildCeilingHammer(dip), breakEvenHammer(dip));

console.log(`\n${failed === 0 ? '✅' : '❌'} bid-ceiling: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
