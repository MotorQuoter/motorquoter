// Unit tests for derivePriceBand. Run with: node scripts/test-price-band.mjs
// Covers: seven band midpoints, both edges of each boundary, null/fallback path.

import { derivePriceBand } from '../lib/priceBand.mjs';

const cases = [
  // ── Seven band midpoints ──────────────────────────────────────────────────
  { input: 2500,  expected: 'economy',    label: 'economy midpoint' },
  { input: 7500,  expected: 'mid-range',  label: 'mid-range midpoint' },
  { input: 12500, expected: 'executive',  label: 'executive midpoint' },
  { input: 17500, expected: 'upper-exec', label: 'upper-exec midpoint' },
  { input: 22500, expected: 'prestige',   label: 'prestige midpoint' },
  { input: 32500, expected: 'luxury',     label: 'luxury midpoint' },
  { input: 50000, expected: 'super-lux',  label: 'super-lux midpoint' },

  // ── Both edges of each boundary ──────────────────────────────────────────
  { input: 5000,  expected: 'economy',    label: 'boundary £5,000 = economy (lower band)' },
  { input: 5001,  expected: 'mid-range',  label: 'boundary £5,001 = mid-range' },
  { input: 10000, expected: 'mid-range',  label: 'boundary £10,000 = mid-range (lower band)' },
  { input: 10001, expected: 'executive',  label: 'boundary £10,001 = executive' },
  { input: 15000, expected: 'executive',  label: 'boundary £15,000 = executive (lower band)' },
  { input: 15001, expected: 'upper-exec', label: 'boundary £15,001 = upper-exec' },
  { input: 20000, expected: 'upper-exec', label: 'boundary £20,000 = upper-exec (lower band)' },
  { input: 20001, expected: 'prestige',   label: 'boundary £20,001 = prestige' },
  { input: 25000, expected: 'prestige',   label: 'boundary £25,000 = prestige (lower band)' },
  { input: 25001, expected: 'luxury',     label: 'boundary £25,001 = luxury' },
  { input: 40000, expected: 'luxury',     label: 'boundary £40,000 = luxury (lower band)' },
  { input: 40001, expected: 'super-lux',  label: 'boundary £40,001 = super-lux' },

  // ── Null / non-numeric fallback path ─────────────────────────────────────
  { input: null,      expected: null, label: 'null input → null (Q2 fallback)' },
  { input: undefined, expected: null, label: 'undefined input → null' },
  { input: '',        expected: null, label: 'empty string → null' },
  { input: 'abc',     expected: null, label: 'non-numeric string → null' },
  { input: NaN,       expected: null, label: 'NaN → null' },
  { input: -1,        expected: null, label: 'negative value → null' },
  { input: -0,        expected: 'economy', label: '-0 coerces to 0 → economy' },

  // ── Floor ─────────────────────────────────────────────────────────────────
  { input: 0,   expected: 'economy',   label: 'zero → economy' },

  // ── String-numeric (API may return quoted numbers) ────────────────────────
  { input: '8000',  expected: 'mid-range', label: 'numeric string "8000" → mid-range' },
  { input: '5000',  expected: 'economy',   label: 'numeric string "5000" → economy (boundary)' },
  { input: '40001', expected: 'super-lux', label: 'numeric string "40001" → super-lux' },
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

console.log(`\n${pass}/${pass + fail} passed${fail > 0 ? ' — FAILURES ABOVE' : ' — all correct'}`);
if (fail > 0) process.exit(1);
