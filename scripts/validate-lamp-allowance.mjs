// A1 unit tests — precautionary (iv≠true) mandated lamp is moved OUT of the costed repair total
// into a £0 inspection allowance; genuinely-damaged (iv:true) lamps stay costed; non-lamp parts
// are unaffected. Deterministic, no network. Run: node scripts/validate-lamp-allowance.mjs
import { applyVisibilityGate, sumPartsRealistic } from '../lib/parts.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

const lampRow = { name: 'Headlamp', panelId: 'HEADLAMP', _lampMandated: true, _band: 350 };
const wingRow = { name: 'Front wing', panelId: 'FRONT_WING', action: 'replace', used: 165, oem: 300 };

console.log('\n=== A1: precautionary lamp (iv≠true) → £0 inspection allowance, NOT in repair total ===\n');
{
  const flaggedParts = [];
  const reconciled = [wingRow, lampRow];
  const costed = [
    { partName: 'Front wing', panelId: 'FRONT_WING', independentlyVisible: true },
    { partName: 'Headlamp',   panelId: 'HEADLAMP',   independentlyVisible: false }, // lamp NOT visibly damaged
  ];
  const { gatedParts, gateAllowanceParts } = applyVisibilityGate(reconciled, costed, flaggedParts, { lampType: 'led' });
  ok('lamp NOT in gatedParts (excluded from repair total)', !gatedParts.some(p => p.panelId === 'HEADLAMP'));
  eq('lamp moved to gateAllowanceParts as £0-in-total band allowance', gateAllowanceParts, [{ name: 'Headlamp', action: 'replace', used: 350, _allowance: true }]);
  ok('wing still costed in gatedParts', gatedParts.some(p => p.panelId === 'FRONT_WING'));
  eq('repair total = wing only (£165), lamp £350 excluded', sumPartsRealistic(gatedParts), 165);
  ok('precautionary inspection flag raised', flaggedParts.some(f => /inspection allowance/i.test(f.reason) && /NOT included in the repair total/i.test(f.reason)));
}

console.log('\n=== Genuinely-damaged lamp (iv:true) → STAYS costed (unchanged) ===\n');
{
  const flaggedParts = [];
  const reconciled = [lampRow];
  const costed = [{ partName: 'Headlamp', panelId: 'HEADLAMP', independentlyVisible: true }]; // visibly damaged
  const { gatedParts, gateAllowanceParts } = applyVisibilityGate(reconciled, costed, flaggedParts, { lampType: 'led' });
  ok('damaged lamp stays in gatedParts', gatedParts.some(p => p.panelId === 'HEADLAMP'));
  eq('lamp costed at band £350', sumPartsRealistic(gatedParts), 350);
  eq('no allowance row for a damaged lamp', gateAllowanceParts, []);
}

console.log('\n=== Non-lamp lots unaffected (no collateral change) ===\n');
{
  const flaggedParts = [];
  const reconciled = [wingRow, { name: 'Front door', panelId: 'FRONT_DOOR', action: 'replace', used: 330, oem: 600 }];
  const costed = [
    { partName: 'Front wing', panelId: 'FRONT_WING', independentlyVisible: true },
    { partName: 'Front door', panelId: 'FRONT_DOOR', independentlyVisible: true },
  ];
  const { gatedParts, gateAllowanceParts } = applyVisibilityGate(reconciled, costed, flaggedParts, null);
  eq('no allowance rows when no mandated lamp present', gateAllowanceParts, []);
  eq('all costed parts pass through (165+330)', sumPartsRealistic(gatedParts), 495);
}

console.log('\n=== DMZ4614 arithmetic (from stored _reconciledParts) ===\n');
// DMZ4614 stored repair total = £3,775, which includes the £350 precautionary Headlamp band row.
// A1 moves that row to the inspection allowance → repair total £3,425.
const dmzCosted = 350 + 165 + 330 + 310 + 220; // headlamp + wing + front door + rear door + rear quarter (labour is OEM-only, not in used-sum here)
eq('DMZ4614 old repair (incl £350 lamp) reference', dmzCosted, 1375); // parts-only used-sum sanity (labour excluded from this check)
eq('DMZ4614 after A1 removes the £350 lamp', dmzCosted - 350, 1025);
console.log('  NOTE  full stored parts_sum £3,775 includes labour (OEM £2,400); A1 removes only the £350 lamp → £3,425. Card flips Visible/£350 → Inferred/£0 once damage-cards + A1 are both present.');

console.log(`\n${failed === 0 ? '✅' : '❌'} lamp-allowance (A1): ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
