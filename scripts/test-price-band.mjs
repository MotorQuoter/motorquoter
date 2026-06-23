// Unit tests for derivePriceBand. Run with: node scripts/test-price-band.mjs
// Covers: seven band midpoints, both edges of each boundary, null/fallback path.
// Expected values read from BAND_KEYS — same source as the deriver and the table.

import { derivePriceBand, BAND_KEYS, PANEL_PRICE_TABLE, PRICE_BAND_KEYS } from '../lib/priceBand.mjs';

const { ECONOMY, MID_RANGE, EXECUTIVE, UPPER_EXEC, PRESTIGE, LUXURY, SUPER_LUX } = BAND_KEYS;

const cases = [
  // ── Seven band midpoints ──────────────────────────────────────────────────
  { input: 2500,  expected: ECONOMY,    label: 'economy midpoint' },
  { input: 7500,  expected: MID_RANGE,  label: 'mid-range midpoint' },
  { input: 12500, expected: EXECUTIVE,  label: 'executive midpoint' },
  { input: 17500, expected: UPPER_EXEC, label: 'upper-exec midpoint' },
  { input: 22500, expected: PRESTIGE,   label: 'prestige midpoint' },
  { input: 32500, expected: LUXURY,     label: 'luxury midpoint' },
  { input: 50000, expected: SUPER_LUX,  label: 'super-lux midpoint' },

  // ── Both edges of each boundary ──────────────────────────────────────────
  { input: 5000,  expected: ECONOMY,    label: 'boundary £5,000 = Economy (lower band)' },
  { input: 5001,  expected: MID_RANGE,  label: 'boundary £5,001 = Mid-range' },
  { input: 10000, expected: MID_RANGE,  label: 'boundary £10,000 = Mid-range (lower band)' },
  { input: 10001, expected: EXECUTIVE,  label: 'boundary £10,001 = Executive' },
  { input: 15000, expected: EXECUTIVE,  label: 'boundary £15,000 = Executive (lower band)' },
  { input: 15001, expected: UPPER_EXEC, label: 'boundary £15,001 = Upper-exec' },
  { input: 20000, expected: UPPER_EXEC, label: 'boundary £20,000 = Upper-exec (lower band)' },
  { input: 20001, expected: PRESTIGE,   label: 'boundary £20,001 = Prestige' },
  { input: 25000, expected: PRESTIGE,   label: 'boundary £25,000 = Prestige (lower band)' },
  { input: 25001, expected: LUXURY,     label: 'boundary £25,001 = Luxury' },
  { input: 40000, expected: LUXURY,     label: 'boundary £40,000 = Luxury (lower band)' },
  { input: 40001, expected: SUPER_LUX,  label: 'boundary £40,001 = Super-lux' },

  // ── Null / non-numeric fallback path ─────────────────────────────────────
  { input: null,      expected: null, label: 'null input → null (Q2 fallback)' },
  { input: undefined, expected: null, label: 'undefined input → null' },
  { input: '',        expected: null, label: 'empty string → null' },
  { input: 'abc',     expected: null, label: 'non-numeric string → null' },
  { input: NaN,       expected: null, label: 'NaN → null' },
  { input: -1,        expected: null, label: 'negative value → null' },
  { input: -0,        expected: ECONOMY, label: '-0 coerces to 0 → Economy' },

  // ── Floor ─────────────────────────────────────────────────────────────────
  { input: 0,   expected: ECONOMY,  label: 'zero → Economy' },

  // ── String-numeric (API may return quoted numbers) ────────────────────────
  { input: '8000',  expected: MID_RANGE, label: 'numeric string "8000" → Mid-range' },
  { input: '5000',  expected: ECONOMY,   label: 'numeric string "5000" → Economy (boundary)' },
  { input: '40001', expected: SUPER_LUX, label: 'numeric string "40001" → Super-lux' },
];

let pass = 0;
let fail = 0;
for (const { input, expected, label } of cases) {
  const got = derivePriceBand(input);
  if (got === expected) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
}

// ── PANEL_PRICE_TABLE integrity checks ───────────────────────────────────────
console.log('\n── PANEL_PRICE_TABLE integrity ──');
const EXPECTED_PANELS = 22;
const panelIds = Object.keys(PANEL_PRICE_TABLE);
let integrityFail = 0;

if (panelIds.length !== EXPECTED_PANELS) {
  console.error(`  FAIL  panel count: expected ${EXPECTED_PANELS}, got ${panelIds.length}`);
  integrityFail++;
} else {
  console.log(`  PASS  panel count: ${EXPECTED_PANELS}`);
}

for (const panelId of panelIds) {
  const bandMap = PANEL_PRICE_TABLE[panelId];
  const bandKeys = Object.keys(bandMap);
  if (bandKeys.length !== PRICE_BAND_KEYS.length) {
    console.error(`  FAIL  ${panelId}: expected ${PRICE_BAND_KEYS.length} bands, got ${bandKeys.length}`);
    integrityFail++;
    continue;
  }
  for (const bk of PRICE_BAND_KEYS) {
    const entry = bandMap[bk];
    if (!entry) { console.error(`  FAIL  ${panelId}[${bk}]: missing`); integrityFail++; continue; }
    if (typeof entry.oem !== 'number' || typeof entry.used !== 'number') {
      console.error(`  FAIL  ${panelId}[${bk}]: non-numeric oem/used`); integrityFail++; continue;
    }
    if (entry.used > entry.oem) {
      console.error(`  FAIL  ${panelId}[${bk}]: used ${entry.used} > oem ${entry.oem}`); integrityFail++;
    }
    if (entry.oem % 5 !== 0 || entry.used % 5 !== 0) {
      console.error(`  FAIL  ${panelId}[${bk}]: not £5-rounded (oem=${entry.oem} used=${entry.used})`); integrityFail++;
    }
  }
}
if (integrityFail === 0) console.log(`  PASS  all 22 × 7 cells present, £5-rounded, used ≤ oem`);

// ── Summary ───────────────────────────────────────────────────────────────────
const totalFail = fail + integrityFail;
console.log(`\n${pass}/${pass + fail} deriver cases passed${fail > 0 ? ' — FAILURES ABOVE' : ' — all correct'}`);
if (integrityFail === 0) console.log(`table integrity: PASS (154 cells)`);
else console.log(`table integrity: ${integrityFail} FAILURE(S)`);
if (totalFail > 0) process.exit(1);
