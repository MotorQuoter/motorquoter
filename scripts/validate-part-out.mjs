// Unit tests for lib/partOut.mjs — deterministic, no network.
// Run: node scripts/validate-part-out.mjs
import { estimatePartOut, grossBasketValue, PART_OUT_RECOVERY_LOW, PART_OUT_RECOVERY_HIGH, PART_OUT_BASKET, HEADLAMP_USED_BY_BAND, HEADLAMP_QTY } from '../lib/partOut.mjs';
import { BAND_KEYS, PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

// Independent recompute of the basket gross for a band (mirrors grossBasketValue),
// including the front-headlamp adjunct sourced outside PANEL_PRICE_TABLE.
function expectGross(band) {
  const panels = PART_OUT_BASKET.reduce((s, { panelId, qty }) => s + PANEL_PRICE_TABLE[panelId][band].used * qty, 0);
  return panels + HEADLAMP_USED_BY_BAND[band] * HEADLAMP_QTY;
}
const round5 = v => Math.round(v / 5) * 5;

console.log('\n=== Basket gross per band ===\n');
for (const band of Object.values(BAND_KEYS)) {
  eq(`grossBasketValue(${band})`, grossBasketValue(band), expectGross(band));
}

console.log('\n=== Headlamps included (qty 2, outside PANEL_PRICE_TABLE) ===\n');
for (const band of [BAND_KEYS.ECONOMY, BAND_KEYS.MID_RANGE, BAND_KEYS.LUXURY]) {
  const panelsOnly = PART_OUT_BASKET.reduce((s, { panelId, qty }) => s + PANEL_PRICE_TABLE[panelId][band].used * qty, 0);
  eq(`${band}: gross − panels == 2× headlamp`, grossBasketValue(band) - panelsOnly, HEADLAMP_USED_BY_BAND[band] * HEADLAMP_QTY);
}

console.log('\n=== estimatePartOut by band key ===\n');
for (const band of Object.values(BAND_KEYS)) {
  const g = expectGross(band);
  eq(`${band} → low/high`, estimatePartOut(band), {
    low: round5(g * PART_OUT_RECOVERY_LOW),
    high: round5(g * PART_OUT_RECOVERY_HIGH),
    gross: g, band,
    recoveryLow: PART_OUT_RECOVERY_LOW, recoveryHigh: PART_OUT_RECOVERY_HIGH,
  });
}

console.log('\n=== Numeric trade-value → band mapping ===\n');
// £8,000 → Mid-range band (5001–10000)
const midByNum = estimatePartOut(8000);
eq('£8,000 maps to Mid-range', midByNum.band, BAND_KEYS.MID_RANGE);
eq('£8,000 gross == Mid-range gross', midByNum.gross, expectGross(BAND_KEYS.MID_RANGE));
// £3,000 → Economy band (<=5000)
eq('£3,000 maps to Economy', estimatePartOut(3000).band, BAND_KEYS.ECONOMY);

console.log('\n=== Sanity invariants ===\n');
const eco = estimatePartOut(BAND_KEYS.ECONOMY);
const lux = estimatePartOut(BAND_KEYS.LUXURY);
ok('low < high', eco.low < eco.high);
ok('recovery low < high', PART_OUT_RECOVERY_LOW < PART_OUT_RECOVERY_HIGH);
ok('higher band → higher gross (Economy < Luxury)', eco.gross < lux.gross);
ok('part-out well below gross (haircut applied)', eco.high < eco.gross);

console.log('\n=== Null-safety ===\n');
eq('null input → null', estimatePartOut(null), null);
eq('empty string → null', estimatePartOut(''), null);
eq('negative → null', estimatePartOut(-100), null);

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
console.log(`(Mid-range part-out for reference: ${JSON.stringify(estimatePartOut(BAND_KEYS.MID_RANGE))})\n`);
if (failed > 0) process.exit(1);
