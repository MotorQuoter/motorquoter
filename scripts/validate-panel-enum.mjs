// Unit validation for lib/panelEnum.mjs — Step 1 enum build.
// Run: node scripts/validate-panel-enum.mjs
// No pipeline, no API calls, no Supabase. Pure module shape checks.
import {
  PANEL, PANEL_CLASS, PANEL_BEHAVIOUR, EV_PANEL_RESOLVED_CLASS,
  isElectricFuelType,
  BASE_PANEL_IDS, EV_PANEL_IDS, COST_PANEL_IDS,
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

// Class tally (confirmed 19 Jun 2026):
// 24 COST + 3 STRUCTURAL_FLAG + 1 VISIBLE_FLAG + 2 PRESENCE_CHECK + 1 OTHER = 31 base
// + 2 EV_CONDITIONAL = 33 total.
// The original brief said "30 base" — that was a miscount (OTHER was dropped from the tally).
// Every entry earns its place; the module is authoritative.

assert('total panel IDs = 33 (31 base + 2 EV-conditional)', allIds.length, 33);
assert('base panel IDs (non-EV) = 31',                      baseIds.length, 31);
assert('EV-conditional IDs = 2',                            evIds.length, 2);
assert('COST panel IDs = 24',                               costIds.length, 24);

// ── 2. Behaviour-class lookup — one sampled entry per class ──────────────────────────────
console.log('\n── 2. Behaviour-class lookup ──');
assert('FRONT_BUMPER → COST',           PANEL_BEHAVIOUR[PANEL.FRONT_BUMPER],      PANEL_CLASS.COST);
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

// ── 4. EV gate — exact DVLA string mapping ───────────────────────────────────────────────
console.log('\n── 4. isElectricFuelType ──');
assert('"ELECTRIC" → true',                                          isElectricFuelType('ELECTRIC'),                                    true);
assert('"PLUG-IN HYBRID ELECTRIC VEHICLE (PHEV)" → true',           isElectricFuelType('PLUG-IN HYBRID ELECTRIC VEHICLE (PHEV)'),      true);
assert('"HYBRID ELECTRIC" → false (self-charging — must be false)', isElectricFuelType('HYBRID ELECTRIC'),                             false);
assert('"DIESEL" → false',                                           isElectricFuelType('DIESEL'),                                      false);
assert('"PETROL" → false',                                           isElectricFuelType('PETROL'),                                      false);
assert('null → false',                                               isElectricFuelType(null),                                          false);
assert('undefined → false',                                          isElectricFuelType(undefined),                                     false);
// Case-insensitivity checks (DVLA always returns uppercase, but be defensive)
assert('"electric" (lowercase) → true',                              isElectricFuelType('electric'),                                    true);
assert('"plug-in hybrid electric vehicle (phev)" (lowercase) → true', isElectricFuelType('plug-in hybrid electric vehicle (phev)'),    true);
assert('"hybrid electric" (lowercase) → false',                      isElectricFuelType('hybrid electric'),                            false);

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

// ── Summary ───────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
