// Unit validation for lib/panelEnum.mjs — Step 1 enum build.
// Run: node scripts/validate-panel-enum.mjs
// No pipeline, no API calls, no Supabase. Pure module shape checks.
import {
  PANEL, PANEL_CLASS, PANEL_BEHAVIOUR, EV_PANEL_RESOLVED_CLASS,
  isBevLot,
  BASE_PANEL_IDS, EV_PANEL_IDS, COST_PANEL_IDS,
  PANEL_DISPLAY,
} from '../lib/panelEnum.mjs';
// batch 76 — PANEL_PRICE_TABLE integrity + derivePriceBand boundaries were folded in here from the
// retired scripts/test-price-band.mjs, so they run on every merge (test-price-band sat OUTSIDE the
// gate and went stale through two authorised changes). These live with the enum because "every COST
// panel has a price row" is a cross-module invariant between panelEnum and priceBand.
import { derivePriceBand, BAND_KEYS, PANEL_PRICE_TABLE, PRICE_BAND_KEYS } from '../lib/priceBand.mjs';

let pass = 0;
let fail = 0;

function assert(label, actual, expected) {
  const isOk = actual === expected;
  console.log(`  ${isOk ? 'PASS' : 'FAIL'} — ${label}`);
  if (!isOk) console.log(`         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  isOk ? pass++ : fail++;
}
function ok(label, cond) { assert(label, !!cond, true); }

// ── 1. Count checks ───────────────────────────────────────────────────────────────────────
console.log('\n── 1. Count checks ──');
const allIds     = Object.values(PANEL);
const baseIds    = BASE_PANEL_IDS;
const evIds      = EV_PANEL_IDS;
const costIds    = COST_PANEL_IDS;

// Class tally (batch 75 §3: +WHEEL_ARCH_MOULDING, a car/universal COST panel):
// 39 COST + 3 STRUCTURAL_FLAG + 2 VISIBLE_FLAG + 2 PRESENCE_CHECK + 1 OTHER = 47 base
// + 2 EV_CONDITIONAL = 49 total. (COST = 25 car/universal + 8 van/passenger + 6 pickup;
// VISIBLE_FLAG = DISPLACED_WHEEL + AIRBAG deployment marker.) Re-baselined: the prior
// 33/31/24 asserts were stale — van/pickup COST panels had been added without updating them.
// The original brief said "30 base" — that was a miscount (OTHER was dropped from the tally).
// Every entry earns its place; the module is authoritative.

assert('total panel IDs = 49 (47 base + 2 EV-conditional)', allIds.length, 49);
assert('base panel IDs (non-EV) = 47',                      baseIds.length, 47);
assert('EV-conditional IDs = 2',                            evIds.length, 2);
assert('COST panel IDs = 39',                               costIds.length, 39);

// ── 2. Behaviour-class lookup — one sampled entry per class ──────────────────────────────
console.log('\n── 2. Behaviour-class lookup ──');
assert('FRONT_BUMPER → COST',           PANEL_BEHAVIOUR[PANEL.FRONT_BUMPER],      PANEL_CLASS.COST);
assert('WHEEL_ARCH_MOULDING → COST (batch 75 §3)', PANEL_BEHAVIOUR[PANEL.WHEEL_ARCH_MOULDING], PANEL_CLASS.COST);
assert('WHEEL_ARCH_MOULDING display name',         PANEL_DISPLAY[PANEL.WHEEL_ARCH_MOULDING],   'Wheel arch moulding');
assert('FRONT_STRUCTURE → STRUCTURAL_FLAG', PANEL_BEHAVIOUR[PANEL.FRONT_STRUCTURE], PANEL_CLASS.STRUCTURAL_FLAG);
assert('DISPLACED_WHEEL → VISIBLE_FLAG', PANEL_BEHAVIOUR[PANEL.DISPLACED_WHEEL],  PANEL_CLASS.VISIBLE_FLAG);
assert('SPARE_WHEEL → PRESENCE_CHECK',  PANEL_BEHAVIOUR[PANEL.SPARE_WHEEL],       PANEL_CLASS.PRESENCE_CHECK);
assert('OTHER → OTHER',                 PANEL_BEHAVIOUR[PANEL.OTHER],             PANEL_CLASS.OTHER);
assert('EV_BATTERY_ZONE → EV_CONDITIONAL',     PANEL_BEHAVIOUR[PANEL.EV_BATTERY_ZONE],     PANEL_CLASS.EV_CONDITIONAL);
assert('EV_BATTERY_PRESENCE → EV_CONDITIONAL', PANEL_BEHAVIOUR[PANEL.EV_BATTERY_PRESENCE], PANEL_CLASS.EV_CONDITIONAL);

// ── 3. EV-panel resolved classes ─────────────────────────────────────────────────────────
console.log('\n── 3. EV resolved-class lookup ──');
assert('EV_BATTERY_ZONE resolved → STRUCTURAL_FLAG',  EV_PANEL_RESOLVED_CLASS[PANEL.EV_BATTERY_ZONE],     PANEL_CLASS.STRUCTURAL_FLAG);
assert('EV_BATTERY_PRESENCE resolved → PRESENCE_CHECK', EV_PANEL_RESOLVED_CLASS[PANEL.EV_BATTERY_PRESENCE], PANEL_CLASS.PRESENCE_CHECK);

// ── 4. BEV gate (isBevLot) — DVLA precedence, against the LIVE 226-lot feed set ──────────
// Fixtures are the strings the feed ACTUALLY returns (live enumeration, 226 lots, 19 Jun 2026):
//   DVLA fuelType ∈ { PETROL, ELECTRICITY, DIESEL, HYBRID ELECTRIC, absent }
//   listing fuel  ∈ { Petrol, Electric, Diesel, absent }
// The former fabricated strings ("ELECTRIC", "PLUG-IN HYBRID ELECTRIC VEHICLE (PHEV)") never
// occur in the feed and are removed — they gave a green test over a broken gate.
console.log('\n── 4. isBevLot (live-feed BEV gate) ──');
assert('DVLA "ELECTRICITY" → true (the live BEV string)',              isBevLot({ fuelType: 'ELECTRICITY' }),                  true);
assert('DVLA "PETROL" → false',                                        isBevLot({ fuelType: 'PETROL' }),                       false);
assert('DVLA "DIESEL" → false',                                        isBevLot({ fuelType: 'DIESEL' }),                       false);
assert('DVLA "HYBRID ELECTRIC" → false (self-charging, ICE path)',     isBevLot({ fuelType: 'HYBRID ELECTRIC' }),              false);
assert('DVLA absent + listing "Electric" → true (fallback)',           isBevLot({ fuelType: null, fuel: 'Electric' }),         true);
assert('DVLA undefined + listing "Electric" → true (fallback)',        isBevLot({ fuel: 'Electric' }),                         true);
assert('DVLA absent + listing absent → false',                         isBevLot({ fuelType: null, fuel: null }),               false);
assert('DVLA "PETROL" + listing "Electric" → false (DVLA precedence)', isBevLot({ fuelType: 'PETROL', fuel: 'Electric' }),     false);
// Case-insensitivity (DVLA returns uppercase, listing title-case — be defensive)
assert('DVLA "electricity" (lowercase) → true',                        isBevLot({ fuelType: 'electricity' }),                  true);
assert('listing "electric" (lowercase) fallback → true',               isBevLot({ fuel: 'electric' }),                         true);
assert('DVLA "hybrid electric" (lowercase) → false',                   isBevLot({ fuelType: 'hybrid electric' }),              false);

// ── 5. PANEL_BEHAVIOUR covers every PANEL key ────────────────────────────────────────────
console.log('\n── 5. Coverage — every PANEL key has a PANEL_BEHAVIOUR entry ──');
let missingBehaviour = false;
for (const id of allIds) {
  if (!PANEL_BEHAVIOUR[id]) {
    console.log(`  FAIL — PANEL.${id} has no PANEL_BEHAVIOUR entry`);
    fail++;
    missingBehaviour = true;
  }
}
if (!missingBehaviour) {
  console.log(`  PASS — all ${allIds.length} PANEL keys have a PANEL_BEHAVIOUR entry`);
  pass++;
}

// ── 6. No duplicate IDs in PANEL ─────────────────────────────────────────────────────────
console.log('\n── 6. No duplicate values in PANEL ──');
const valueSet = new Set(allIds);
assert(`all ${allIds.length} PANEL values are unique`, valueSet.size, allIds.length);

// ── 7. PANEL_DISPLAY covers every PANEL key — no ID missing a label ─────────────────────
console.log('\n── 7. PANEL_DISPLAY coverage — every PANEL key has a display label ──');
let missingDisplay = false;
for (const id of allIds) {
  if (!PANEL_DISPLAY[id]) {
    console.log(`  FAIL — PANEL.${id} has no PANEL_DISPLAY entry`);
    fail++;
    missingDisplay = true;
  }
}
if (!missingDisplay) {
  console.log(`  PASS — all ${allIds.length} PANEL keys have a PANEL_DISPLAY entry`);
  pass++;
}
// Spot-check a selection of display strings to confirm values are non-empty strings.
assert('PANEL_DISPLAY[FRONT_BUMPER] = "Front bumper"',  PANEL_DISPLAY[PANEL.FRONT_BUMPER],       'Front bumper');
assert('PANEL_DISPLAY[REAR_QUARTER] = "Rear quarter panel"', PANEL_DISPLAY[PANEL.REAR_QUARTER],  'Rear quarter panel');
assert('PANEL_DISPLAY[HEADLAMP] = "Headlamp"',          PANEL_DISPLAY[PANEL.HEADLAMP],           'Headlamp');
assert('PANEL_DISPLAY[OTHER] = "Other"',                PANEL_DISPLAY[PANEL.OTHER],              'Other');
assert('PANEL_DISPLAY[EV_BATTERY_ZONE] = "EV battery zone"', PANEL_DISPLAY[PANEL.EV_BATTERY_ZONE], 'EV battery zone');

// ── 8. PANEL_PRICE_TABLE integrity (folded in from test-price-band.mjs, batch 76) ─────────────
// The documented COST panels intentionally WITHOUT a price row — both keep their own code-owned
// logic (per the priceBand header). Any OTHER unpriced COST panel is a real gap and fails.
console.log('\n── 6. PANEL_PRICE_TABLE integrity ──');
const PRICE_EXCLUDED_COST = new Set([PANEL.GRILLE, PANEL.HEADLAMP]);
// The priced entries that are deliberately NOT PANEL_CLASS.COST panels (SRS airbag kit tiers).
const PRICED_NON_COST = new Set(['SRS_AIRBAG_T1', 'SRS_AIRBAG_T2', 'SRS_AIRBAG_T3']);
const pricedIds = Object.keys(PANEL_PRICE_TABLE);

// (a) every COST panel has a price row, except the two documented exclusions — this is the check
//     that "may find something": a new COST panel added without a price row fails here.
{
  const unpriced = COST_PANEL_IDS.filter(id => !(id in PANEL_PRICE_TABLE) && !PRICE_EXCLUDED_COST.has(id));
  ok(`every COST panel has a price row (except documented GRILLE/HEADLAMP)${unpriced.length ? ' — MISSING: ' + unpriced.join(', ') : ''}`, unpriced.length === 0);
}
// (b) the only priced-but-not-COST entries are the known SRS airbag tiers — an unexpected non-COST
//     priced key (e.g. a typo'd panel id) fails here.
{
  const unexpectedNonCost = pricedIds.filter(id => !COST_PANEL_IDS.includes(id) && !PRICED_NON_COST.has(id));
  ok(`only the known SRS airbag tiers are priced-but-not-COST${unexpectedNonCost.length ? ' — UNEXPECTED: ' + unexpectedNonCost.join(', ') : ''}`, unexpectedNonCost.length === 0);
}
// (c) DERIVED count — never hardcoded. table size === (COST panels − exclusions) + SRS tiers.
{
  const derived = (COST_PANEL_IDS.length - PRICE_EXCLUDED_COST.size) + PRICED_NON_COST.size;
  assert('price-table size equals the DERIVED count (COST − exclusions + SRS tiers)', pricedIds.length, derived);
}
// (d) every panel has all seven bands; (e) no S/H exceeds its OEM; (f) all figures £5-rounded.
{
  let bad7 = 0, badOem = 0, badRound = 0;
  for (const id of pricedIds) {
    const bandMap = PANEL_PRICE_TABLE[id];
    if (Object.keys(bandMap).length !== PRICE_BAND_KEYS.length) bad7++;
    for (const bk of PRICE_BAND_KEYS) {
      const e = bandMap[bk];
      if (!e || typeof e.oem !== 'number' || typeof e.used !== 'number') { bad7++; continue; }
      if (e.used > e.oem) badOem++;
      if (e.oem % 5 !== 0 || e.used % 5 !== 0) badRound++;
    }
  }
  ok('every price panel has all seven bands (numeric oem/used)', bad7 === 0);
  ok('no S/H (used) figure exceeds its OEM', badOem === 0);
  ok('all price figures are £5-rounded', badRound === 0);
}

// ── 9. derivePriceBand boundaries (folded in from test-price-band.mjs, batch 76) ──────────────
console.log('\n── 7. derivePriceBand boundaries ──');
{
  const { ECONOMY, MID_RANGE, EXECUTIVE, UPPER_EXEC, PRESTIGE, LUXURY, SUPER_LUX } = BAND_KEYS;
  const cases = [
    [2500, ECONOMY], [7500, MID_RANGE], [12500, EXECUTIVE], [17500, UPPER_EXEC], [22500, PRESTIGE], [32500, LUXURY], [50000, SUPER_LUX],
    [5000, ECONOMY], [5001, MID_RANGE], [10000, MID_RANGE], [10001, EXECUTIVE], [15000, EXECUTIVE], [15001, UPPER_EXEC],
    [20000, UPPER_EXEC], [20001, PRESTIGE], [25000, PRESTIGE], [25001, LUXURY], [40000, LUXURY], [40001, SUPER_LUX],
    [null, null], [undefined, null], ['', null], ['abc', null], [NaN, null], [-1, null], [-0, ECONOMY], [0, ECONOMY],
    ['8000', MID_RANGE], ['5000', ECONOMY], ['40001', SUPER_LUX],
  ];
  let bandBad = 0;
  for (const [input, expected] of cases) if (derivePriceBand(input) !== expected) { bandBad++; console.log(`  FAIL — derivePriceBand(${JSON.stringify(input)}) expected ${JSON.stringify(expected)}, got ${JSON.stringify(derivePriceBand(input))}`); }
  ok(`derivePriceBand: all ${cases.length} boundary/midpoint/fallback cases correct`, bandBad === 0);
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
