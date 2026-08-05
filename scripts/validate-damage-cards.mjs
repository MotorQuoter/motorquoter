// Unit tests for lib/damageCards.mjs — deterministic, no network.
// Run: node scripts/validate-damage-cards.mjs
import { buildDamageCards } from '../lib/damageCards.mjs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

// Representative finalised pipeline arrays.
const gatedParts = [
  { name: 'Front bumper', action: 'replace', used: 160, panelId: 'FRONT_BUMPER' },
  { name: 'Bonnet', action: 'repair', used: 120, panelId: 'BONNET' },
  { name: 'Front headlamp (corner 1)', action: 'replace', used: 150, panelId: 'HEADLAMP', _lampMandated: true, _band: 150 },
  { name: 'Slam panel', action: 'replace', used: 40, panelId: 'SLAM_PANEL', _amalgMissing: true },
  { name: 'Labour & paint', action: 'repair', used: 800 }, // must be skipped
];
const costedParts = [
  { panelId: 'FRONT_BUMPER', partName: 'Front bumper', independentlyVisible: true, _ledgerSeverity: 'SEVERE' },
  { panelId: 'BONNET', partName: 'Bonnet', independentlyVisible: true, _ledgerSeverity: 'MODERATE' },
  { panelId: 'HEADLAMP', partName: 'Front headlamp', independentlyVisible: false },       // precautionary
  { panelId: 'SLAM_PANEL', partName: 'Slam panel', independentlyVisible: true, _amalgMissing: true, _ledgerSeverity: 'SEVERE' },
];
const flaggedParts = [
  { partName: 'Front wing', zone: 'front', weight: 'medium', reason: 'adjacent to impact — not independently confirmed', _gateGenerated: true },
];
const allowanceParts = [
  { name: 'Headlamp', action: 'replace', used: 150, _allowance: true }, // second corner
];

const cards = buildDamageCards({ gatedParts, costedParts, flaggedParts, allowanceParts });

console.log('\n=== Structure ===\n');
eq('labour row skipped → 4 visible + 1 related + 1 inferred = 6 cards', cards.length, 6);
eq('origins in order', cards.map(c => c.origin), ['Visible', 'Visible', 'Visible', 'Visible', 'Related', 'Inferred']);

console.log('\n=== Visible cards ===\n');
const bumper = cards.find(c => c.part === 'Front bumper');
eq('bumper visible/severe/replace/cost', [bumper.origin, bumper.severity, bumper.action, bumper.cost], ['Visible', 'Severe', 'replace', 160]);
const bonnet = cards.find(c => c.part === 'Bonnet');
eq('bonnet moderate/repair', [bonnet.severity, bonnet.action, bonnet.cost], ['Moderate', 'repair', 120]);
eq('no labourHrs field (omitted, not fabricated)', 'labourHrs' in bumper, false);
eq('no damageType value (omitted)', bumper.damageType, null);

console.log('\n=== Lamp-mandated, iv≠true → Visible w/ precaution note, real cost ===\n');
const lamp = cards.find(c => c.part === 'Front headlamp (corner 1)');
eq('lamp visible + real cost', [lamp.origin, lamp.cost], ['Visible', 150]);
ok('lamp precaution note present', /precautionary/i.test(lamp.note));

console.log('\n=== _amalgMissing → Visible w/ not-present note ===\n');
const slam = cards.find(c => c.part === 'Slam panel');
eq('missing part visible + cost + severe', [slam.origin, slam.cost, slam.severity], ['Visible', 40, 'Severe']);
ok('missing note present', /not present/i.test(slam.note));

console.log('\n=== Related (completeness-net flag) → £0, inspect ===\n');
const wing = cards.find(c => c.part === 'Front wing');
eq('related £0 / inspect', [wing.origin, wing.cost, wing.action], ['Related', 0, 'inspect']);
eq('related carries the flag reason', wing.note, 'adjacent to impact — not independently confirmed');

console.log('\n=== Inferred (allowance) → £0, band value in note ===\n');
const allow = cards.find(c => c.origin === 'Inferred');
eq('inferred £0', allow.cost, 0);
ok('inferred notes the band allowance', /Band allowance £150/.test(allow.note));

console.log('\n=== Dedup: a flag matching a visible part is not double-listed ===\n');
const cards2 = buildDamageCards({
  gatedParts: [{ name: 'Front bumper', action: 'replace', used: 160, panelId: 'FRONT_BUMPER' }],
  costedParts: [{ panelId: 'FRONT_BUMPER', independentlyVisible: true, _ledgerSeverity: 'MINOR' }],
  flaggedParts: [{ partName: 'Front bumper', reason: 'dup', _gateGenerated: true }],
  allowanceParts: [],
});
eq('bumper appears once (visible), flag deduped', cards2.length, 1);
eq('surviving card is Visible', cards2[0].origin, 'Visible');

console.log('\n=== Null-safety ===\n');
eq('empty input → []', buildDamageCards({}), []);
eq('no-arg → []', buildDamageCards(), []);

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
