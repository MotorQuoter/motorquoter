// Unit validation for lib/panelEnum.mjs — Step 1 enum build.
// Run: node scripts/validate-panel-enum.mjs
// No pipeline, no API calls, no Supabase. Pure module shape checks.
import {
  PANEL, PANEL_CLASS, PANEL_BEHAVIOUR, EV_PANEL_RESOLVED_CLASS,
  isBevLot,
  BASE_PANEL_IDS, EV_PANEL_IDS, COST_PANEL_IDS,
  PANEL_DISPLAY,
} from '../lib/panelEnum.mjs';

let pass = 0;
let fail = 0;

function assert(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) console.log(`         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

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

// ── Summary ───────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
