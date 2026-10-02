// Validator — batch 209 (Vincent, 2 Oct 2026), the addendum to batch 208: 1 a report keeps its own labour basis ·
// 2 the sentence names the figure · 3 ruling A where the model wrote no row · 4 no second-fog line. £0: no network.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch209.mjs   (expect "N passed, 0 failed")
import { readFileSync } from 'node:fs';
import {
  applyGradeOwnsAction, promoteFlaggedQuarter, labourDisplayLines, labourBasisOf, LABOUR_BASIS, LABOUR_BASIS_CURRENT,
  computeLabour, panelWorkRange,
} from '../lib/labour.mjs';
import { applyEdits } from '../lib/ledgerEdits.mjs';
import { applyFogBumperRule } from '../lib/partsCompleteness.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const fig = (r) => r?.used ?? r?.oem ?? 0;
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const route = src('app/api/salvage/assess/route.js');

console.log('── 1. a report keeps its own labour basis ──');
ok('basis table: top ×1.25, middle ×1.00; new reports = middle', LABOUR_BASIS.top === 1.25 && LABOUR_BASIS.middle === 1 && LABOUR_BASIS_CURRENT === 'middle');
ok('no stamp = legacy top', labourBasisOf({}) === 'top' && labourBasisOf(null) === 'top' && labourBasisOf({ _labourBasis: 'bogus' }) === 'top');
ok('a stamp is honoured', labourBasisOf({ _labourBasis: 'middle' }) === 'middle' && labourBasisOf({ _labourBasis: 'top' }) === 'top');
ok('route stamps every new assessment with the current basis', route.includes('assessment._labourBasis      = LABOUR_BASIS_CURRENT;'));
ok('the edit layer re-prices with the report\'s basis', src('lib/ledgerEdits.mjs').includes('basis: labourBasisOf(assessment),'));
// Puma-shaped body panels: front bumper + wing, flank doors/quarter/sill, rear bumper — strike the rear bumper.
const BODY = [
  { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'replace' },
  { panelId: 'FRONT_DOOR', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
  { panelId: 'REAR_DOOR', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
  { panelId: 'REAR_QUARTER', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
  { panelId: 'SILL', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
  { panelId: 'REAR_BUMPER', zone: 'rear', severity: 'SEVERE', action: 'replace' },
  { panelId: 'FRONT_WING', zone: 'front', severity: 'SEVERE', action: 'replace' },
];
function report(basis) {
  const L = computeLabour({ bodyPanels: BODY, basis: basis ?? 'top' });
  const rows = [
    ...BODY.map((b) => ({ panelId: b.panelId, name: b.panelId, action: 'replace', oem: 400, used: 200 })),
    { name: 'Labour & paint (new & painted)', action: '—', oem: L.panelWorkMoney, used: null, _codeLabour: true },
  ];
  return { _reconciledParts: rows, _partsReconciliation: { parts_sum: 7 * 200 + L.panelWorkMoney }, _labourBodyPanels: BODY,
    _labourTellCount: 0, _labourColumns: L.columns, ...(basis ? { _labourBasis: basis } : {}) };
}
{
  const legacy = report(null);                       // written at the top, no stamp
  const e0 = applyEdits(legacy, null);
  const key = e0.rows.find((r) => r.panelId === 'REAR_BUMPER')._rowKey;
  const e1 = applyEdits(legacy, { stamp: e0.stamp, strikes: [key], adds: [] });
  ok('legacy row (no stamp): labour written at the top £4,125', fig(e0.rows.find((r) => r._codeLabour)) === 4125);
  ok('legacy row: strike the rear bumper → labour −£750 (×1.25, the OLD code\'s figure), not −£1,425', e1.labourDelta === -750);
  ok('legacy row: range line names its in-total figure £4,125', e0.labourDisplay.range === 'Estimate £2,805 - £4,125 · the total uses £4,125');
  ok('legacy row after the strike: range line names the new in-total figure £3,375', e1.labourDisplay.range === 'Estimate £2,295 - £3,375 · the total uses £3,375');
  const stamped = report('middle');
  const s0 = applyEdits(stamped, null);
  const sk = s0.rows.find((r) => r.panelId === 'REAR_BUMPER')._rowKey;
  const s1 = applyEdits(stamped, { stamp: s0.stamp, strikes: [sk], adds: [] });
  ok('stamped row: labour written at the middle £3,300', fig(s0.rows.find((r) => r._codeLabour)) === 3300);
  ok('stamped row: strike the rear bumper → labour −£600 (×1.00)', s1.labourDelta === -600);
  ok('stamped row: range line names £3,300', s0.labourDisplay.range === 'Estimate £2,805 - £4,125 · the total uses £3,300');
  ok('stamped row: addendum names £3,300', /all use £3,300 from that range\./.test(s0.labourDisplay.addendum));
  ok('legacy row: addendum names £4,125', /all use £4,125 from that range\./.test(e0.labourDisplay.addendum));
}

console.log('── 2. the sentence names the figure ──');
{
  const d = labourDisplayLines({ newPainted: panelWorkRange(1000), secondHand: panelWorkRange(800) });
  ok('range line: "· the total uses £1,000"', d.range === 'Estimate £850 - £1,250 · the total uses £1,000');
  ok('no "top" / "middle" word left in the buyer sentences', !/the top|the middle/.test(d.range + d.addendum));
  const lab = src('lib/labour.mjs');
  ok('the sentences have one owner (lib/labour.mjs)', lab.includes('· the total uses ${_gbp(inTotal)}') && lab.includes('all use ${_gbp(x)} from that range.'));
}

console.log('── 3. ruling A where the model wrote no row ──');
ok('G inject: a BODY panel enters as repair; the grade rule decides', route.includes("const action = isBodyPanel(e.panelId) ? 'repair' : (e._gSeverity === 'SEVERE' ? 'replace' : 'repair');"));
{
  const one = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'repair', oem: 300, used: 165, _gOwned: true, _tableMandated: true }];
  applyGradeOwnsAction(one, new Map([['FRONT_WING', 'SEVERE']]), new Map([['FRONT_WING', 1]]));
  ok('injected bolt-on, 1 SEVERE photo → repair, no part', one[0].action === 'repair' && fig(one[0]) === 0 && one[0]._repairNoPart === true);
  const two = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'repair', oem: 300, used: 165, _gOwned: true, _tableMandated: true }];
  applyGradeOwnsAction(two, new Map([['FRONT_WING', 'SEVERE']]), new Map([['FRONT_WING', 2]]));
  ok('injected bolt-on, 2 SEVERE photos → replace, part kept', two[0].action === 'replace' && fig(two[0]) === 165);
  ok('…and it is marked as the code repair, not a model repair (_codeAction, no _modelAction)', two[0]._codeAction === 'repair' && two[0]._modelAction === undefined);
  const wq = [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', oem: 320, used: 175, _gOwned: true, _tableMandated: true }];
  applyGradeOwnsAction(wq, new Map([['REAR_QUARTER', 'SEVERE']]), new Map([['REAR_QUARTER', 4]]));
  ok('injected WELDED quarter, 4 SEVERE photos → repair, no part, no new price', wq[0].action === 'repair' && fig(wq[0]) === 0 && !wq[0]._weldedAtNew);
}
{
  const rows = [], sev = new Map(), zones = new Map();
  const p = promoteFlaggedQuarter({ gatedParts: rows, flaggedParts: [{ panelId: 'REAR_QUARTER', zone: 'rear', reason: 'x' }],
    costedIds: new Set(), sevByPanel: sev, zoneByPanel: zones, entry: { oem: 320, used: 175 }, name: 'Rear quarter panel' });
  ok('promoted quarter enters as a repair', !!p && rows[0].action === 'repair' && rows[0]._q4Promoted === true);
  applyGradeOwnsAction(rows, sev, new Map([['REAR_QUARTER', 3]]));
  ok('promoted quarter → repair, no part, no new price', rows[0].action === 'repair' && fig(rows[0]) === 0 && rows[0]._repairNoPart === true && !rows[0]._weldedAtNew);
}
ok('one threshold owner — route.js defines no SEVERE_OVERRIDE_THRESHOLD of its own', !/const SEVERE_OVERRIDE_THRESHOLD\s*=/.test(route));

console.log('── 4. no second-fog line ──');
{
  const seed = { used: 50, oem: null };
  const one = applyFogBumperRule({ costedParts: [], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
  ok('bumper gone + one corner → one fog costed, NO second-fog line', one.costedToAdd.length === 1 && one.flagsToAdd.length === 0);
  const have = applyFogBumperRule({ costedParts: [{ panelId: 'FOG_LAMP', name: 'Fog lamp', used: 40 }], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
  ok('…with the one fog already costed → nothing, no line', have.costedToAdd.length === 0 && have.flagsToAdd.length === 0);
  ok('the line and its marker are gone from the source', !src('lib/partsCompleteness.mjs').includes('confirm it is present and undamaged') && !src('lib/parts.mjs').includes('_fogSecondOneCorner'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
