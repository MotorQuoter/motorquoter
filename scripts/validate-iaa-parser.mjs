// Validates the IAA/SYNETIQ parse path end-to-end through normaliseLot (source='iaa'),
// asserting the CANONICAL output forms match what the Copart-path consumers expect.
// Run: node scripts/validate-iaa-parser.mjs
import { normaliseLot } from '../lib/normaliseLot.js';
import { categoryDirective, CAT_S_DIRECTIVE, CAT_NU_DIRECTIVE } from '../config/booking.mjs';

// Mirrors route.js catLetter — the exit-band / SalvageGuide category consumer.
function catLetter(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let m = t.match(/^cat(?:egory)?\s+([snabcd])\b/); if (m) return m[1];
  m = t.match(/^([snabcd])\s+repairable/); if (m) return m[1];
  m = t.match(/^([snabcd])$/); if (m) return m[1];
  return null;
}
// Mirrors route.js EV-presence gate.
const runsAndDrivesRe = /runs?\s+and\s+drives?/i;

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

// ── Sample lot from the handoff (2022 Ford Kuga Cat S) ────────────────────────
const SAMPLE = `2022 FORD KUGA ZETEC ECOBLUE 1996cc TURBO DIESEL AUTOMATIC 5 DOOR HATCHBACK
£2,510 + VAT   Closed   Reserve not met
Item details
Vehicle 2022 FORD KUGA ZETEC ECOBLUE 5 DOOR HATCHBACK
Engine 1996cc DIESEL TURBO CHARGED
Gearbox AUTOMATIC
Body Car / PLG
Odometer Unverified 62,955
Category Structurally damaged repairable S
Item type Car / PLG Proxy bid auction
VAT Item(s) subject to VAT at 20%
Location fee £50
Description Police disposal
Item ref no. 26 / 4011323
Registration
First registered 11/2022
V5 Document No
Engine starts Yes
Drivetrain drives Yes
Keys Yes
Service history No
Audio equipment No
VIN plate Yes`;

console.log('\n=== Sample IAA lot (Cat S, runs & drives) ===\n');
const vd = normaliseLot({ auctionSource: 'iaa', rawCopartPaste: SAMPLE });

eq('category → Copart canonical', vd.category, 'S REPAIRABLE STRUCTURAL');
ok('catLetter(category) === "s"', catLetter(vd.category) === 's');
eq('categoryDirective routes to CAT_S', categoryDirective(vd.category), CAT_S_DIRECTIVE);
eq('odometer bare comma form', vd.odometer, '62,955');
eq('odometerQualifier kept separately', vd.odometerQualifier, 'Unverified');
eq('keys', vd.keys, 'Yes');
eq('runCondition → Copart vocab', vd.runCondition, 'Runs and drives');
ok('runCondition matches EV-presence regex', runsAndDrivesRe.test(vd.runCondition));
eq('vatOnSale', vd.vatOnSale, 'Yes');
eq('fuel', vd.fuel, 'Diesel');
eq('transmission', vd.transmission, 'Automatic');
eq('engineSize', vd.engineSize, '1996cc');
eq('bodyStyle', vd.bodyStyle, '5 DOOR HATCHBACK');
eq('v5Status', vd.v5Status, 'No');
eq('lotNumber', vd.lotNumber, '26 / 4011323');
eq('vrm (redacted → null)', vd.vrm, null);
eq('primaryDamage null (IAA has no damage fields)', vd.primaryDamage, null);
eq('secondaryDamage null', vd.secondaryDamage, null);
eq('additionalDamage null', vd.additionalDamage, null);
eq('damageDescription = light-cleaned Description', vd.damageDescription, 'Police disposal');
ok('damageDescription never carries the category', !/repairable|category/i.test(vd.damageDescription));
eq('estimatedRetail null', vd.estimatedRetail, null);
eq('saleDate null (generic-48h fallback)', vd.saleDate, null);

// ── Cat N, non-runner, and "no space" spacing variant ─────────────────────────
console.log('\n=== Cat N, does-not-run, no-space spacing ===\n');
const CATN = `Category Non-structurally damaged repairable N
OdometerWarranted 104,220
CategoryNon-structurally damaged repairable N
Gearbox MANUAL
Engine 1499cc PETROL
Engine starts No
KeysNo
Registration LT65ABC`;
const vdn = normaliseLot({ auctionSource: 'iaa', rawCopartPaste: CATN });
eq('Cat N → canonical', vdn.category, 'N REPAIRABLE NON STRUCTURAL');
ok('catLetter === "n"', catLetter(vdn.category) === 'n');
eq('categoryDirective routes to CAT_NU', categoryDirective(vdn.category), CAT_NU_DIRECTIVE);
eq('runCondition non-runner → Does not run', vdn.runCondition, 'Does not run');
eq('odometer (no-space qualifier) parsed', vdn.odometer, '104,220');
eq('odometerQualifier Warranted', vdn.odometerQualifier, 'Warranted');
eq('no-space "KeysNo" → No', vdn.keys, 'No');
eq('transmission Manual', vdn.transmission, 'Manual');
eq('fuel Petrol', vdn.fuel, 'Petrol');
eq('vrm from Registration', vdn.vrm, 'LT65ABC');
eq('vatOnSale absent → No', vdn.vatOnSale, 'No');

// ── Starts-only (no drivetrain line) → "Engine starts" ────────────────────────
console.log('\n=== Starts but does not drive ===\n');
const STARTS = `Category Structurally damaged repairable S
Engine starts Yes
Keys Yes`;
const vds = normaliseLot({ auctionSource: 'iaa', rawCopartPaste: STARTS });
eq('starts-only → "Engine starts"', vds.runCondition, 'Engine starts');
ok('starts-only does NOT match runs-and-drives regex', !runsAndDrivesRe.test(vds.runCondition));

// ── Copart path must be untouched by the IAA additions ────────────────────────
console.log('\n=== Copart lot: no odometerQualifier key leaks ===\n');
const cop = normaliseLot({ auctionSource: 'copart', rawCopartPaste: 'Category: S REPAIRABLE STRUCTURAL\nOdometer:\n41,716' });
ok('Copart output has NO odometerQualifier key', !('odometerQualifier' in cop));

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
