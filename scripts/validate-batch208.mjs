// Validator — batch 208 (Vincent, 2 Oct 2026): A repair stays repair · B labour at the middle · C no fog-pair flag ·
// D one structure floor per report. £0: no network, no DB, no Stripe, no model.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch208.mjs   (expect "N passed, 0 failed")
import { readFileSync } from 'node:fs';
import {
  applyGradeOwnsAction, SEVERE_OVERRIDE_THRESHOLD, panelWorkRange, computeLabour, labourDisplayLines,
  labourRangeAddendum, RANGE_MONEY_PCT,
} from '../lib/labour.mjs';
import { applyFogBumperRule } from '../lib/partsCompleteness.mjs';
import { structureFloorDecision, STRUCT_FLOORS_PER_REPORT } from '../lib/structureFloor.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const sev = (pid, g) => new Map([[pid, g]]);
const votes = (pid, n) => new Map([[pid, n]]);
const fig = (r) => r.used ?? r.oem ?? 0;
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');

console.log('── A. the model\'s "repair" stands ──');
ok('threshold owner: lib/labour.mjs SEVERE_OVERRIDE_THRESHOLD = 2', SEVERE_OVERRIDE_THRESHOLD === 2);
ok('route.js imports it and does not define its own', /SEVERE_OVERRIDE_THRESHOLD[^}]*\} from '@\/lib\/labour\.mjs'/.test(route) && !/const SEVERE_OVERRIDE_THRESHOLD\s*=/.test(route));
{
  const r = [{ panelId: 'REAR_BUMPER', name: 'Rear bumper', action: 'repair', oem: 410, used: 225 }];
  applyGradeOwnsAction(r, sev('REAR_BUMPER', 'SEVERE'), votes('REAR_BUMPER', 1));
  ok('bolt-on, model repair, 1 SEVERE photo → repair, no part', r[0].action === 'repair' && fig(r[0]) === 0 && r[0]._repairNoPart === true);
}
{
  const r = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'repair', oem: 300, used: 165 }];
  applyGradeOwnsAction(r, sev('FRONT_WING', 'SEVERE'), votes('FRONT_WING', 2));
  ok('bolt-on, model repair, 2 SEVERE photos → replace, part kept', r[0].action === 'replace' && fig(r[0]) === 165 && r[0]._modelAction === 'repair');
}
{
  const r = [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', oem: 400, used: 220 }];
  applyGradeOwnsAction(r, sev('REAR_QUARTER', 'SEVERE'), votes('REAR_QUARTER', 3));
  ok('welded, model repair, 3 SEVERE photos → repair, no part, no new price', r[0].action === 'repair' && fig(r[0]) === 0 && r[0]._repairNoPart === true && r[0]._weldedAtNew == null);
}
{
  const r = [{ panelId: 'SILL', name: 'Sill', action: 'replace', oem: 190, used: 105 }];
  applyGradeOwnsAction(r, sev('SILL', 'SEVERE'), votes('SILL', 1));
  ok('welded, model replace → replace at new (£190, not £105)', r[0].action === 'replace' && fig(r[0]) === 190 && r[0]._weldedAtNew?.used === 105);
}
{
  const r = [{ panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', oem: 600, used: 330 }];
  applyGradeOwnsAction(r, sev('FRONT_DOOR', 'SEVERE'), votes('FRONT_DOOR', 0));
  ok('bolt-on, model replace, SEVERE → replace unchanged', r[0].action === 'replace' && fig(r[0]) === 330);
}
{
  const r = [{ panelId: 'REAR_DOOR', name: 'Rear door', action: 'replace', oem: 565, used: 310 }];
  applyGradeOwnsAction(r, sev('REAR_DOOR', 'MODERATE'), votes('REAR_DOOR', 0));
  ok('MODERATE still → repair, no part (unchanged)', r[0].action === 'repair' && fig(r[0]) === 0);
}
{
  const lab = computeLabour({ bodyPanels: [{ panelId: 'REAR_QUARTER', zone: 'flank', severity: 'SEVERE', action: 'repair' }] });
  ok('a repaired SEVERE welded quarter still earns its welded labour (£800)', lab.columns.panelWorkNewPainted === 800);
}
ok('route passes the per-panel SEVERE counts to the owner', route.includes('applyGradeOwnsAction(gatedParts, sevByPanel, severeVotesByPanel)'));
ok('route counts them from the per-view grades', /_perViewGrades\.filter\(g => g\.sev === 'SEVERE'\)\.length/.test(route));

console.log('── B. labour & paint: the total uses the middle ──');
ok('RANGE_MONEY_PCT = 1.00', RANGE_MONEY_PCT === 1);
{
  const r = panelWorkRange(3300);
  ok('Puma panel work £3,300 → range £2,805–£4,125, money £3,300', r.low === 2805 && r.high === 4125 && r.money === 3300);
  const L = computeLabour({ bodyPanels: [{ panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'replace' }] });
  ok('computeLabour money = the middle (£600, not £750)', L.panelWorkMoney === 600 && L.labourMoney === 600);
  const d = labourDisplayLines({ newPainted: panelWorkRange(3300), secondHand: panelWorkRange(2050) });
  ok('range line names the figure in the total (batch 209 2: "the total uses £3,300")', d.range === 'Estimate £2,805 - £4,125 · the total uses £3,300');
  ok('addendum names the same figure', d.addendum === labourRangeAddendum(3300) && /all use £3,300 from that range\./.test(d.addendum));
}
{
  const files = ['lib/labour.mjs', 'lib/ledgerEdits.mjs', 'lib/damageCards.mjs', 'app/api/salvage/pdf/route.js', 'app/salvage/success/page.js', 'app/api/salvage/assess/route.js'];
  const hits = files.filter((f) => /uses the top|use the top of that range|top of the range/i.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')));
  ok('no buyer-facing "uses the top" sentence left in any surface file', hits.length === 0);
}

console.log('── C. no fog-pairing flag ──');
{
  const fog = { panelId: 'FOG_LAMP', name: 'Fog lamp', action: 'replace', oem: 120, used: 65 };
  const r = applyFogBumperRule({ costedParts: [fog, { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', used: 240 }], frontBumperGone: false, fogSeed: { oem: 120, used: 65 } });
  ok('one costed fog + fitted (costed) front bumper → no flag, no cost', r.flagsToAdd.length === 0 && r.costedToAdd.length === 0);
  const rr = applyFogBumperRule({ costedParts: [{ ...fog, name: 'Rear fog lamp', zone: 'rear' }], rearBumperGone: false, fogSeed: { oem: 120, used: 65 } });
  ok('rear: no flag either', rr.flagsToAdd.length === 0);
  ok('the sentence is gone from the source', !readFileSync(new URL('../lib/partsCompleteness.mjs', import.meta.url), 'utf8').includes('pairing not assumed;'));
  const gone = applyFogBumperRule({ costedParts: [], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: { oem: 120, used: 65 } });
  ok('bumper-GONE seeding untouched (2 front fogs costed)', gone.costedToAdd.length === 2);
}

console.log('── D. one structure floor per report ──');
ok('STRUCT_FLOORS_PER_REPORT = 1', STRUCT_FLOORS_PER_REPORT === 1);
{
  const damaged = new Set(['FRONT_BUMPER', 'FRONT_WING', 'FOG_LAMP', 'FRONT_DOOR', 'REAR_DOOR']);
  const taken = [];
  const a = structureFloorDecision('FRONT_STRUCTURE', damaged, taken);
  if (a.apply) taken.push('FRONT_STRUCTURE');
  const b = structureFloorDecision('SIDE_STRUCTURE', damaged, taken);
  ok('two qualifying panels: the first (FRONT_STRUCTURE) takes the £500 floor', a.apply === true && a.why === null);
  ok('the second (SIDE_STRUCTURE) gets no floor — one-per-report, taken by FRONT_STRUCTURE', b.apply === false && b.why === 'one-per-report' && b.takenBy === 'FRONT_STRUCTURE');
  const c = structureFloorDecision('REAR_STRUCTURE', new Set(['REAR_BUMPER']), []);
  ok('zone rule unchanged: bumper-only rear → no floor (zone-bumper-only)', c.apply === false && c.why === 'zone-bumper-only');
}
ok('route asks the owner and records the floor taken', route.includes('structureFloorDecision(pid, damagedPanels, _structFloorsTaken)') && route.includes('_structFloorsTaken.push(pid)'));
ok('route: the second floor stays a flag (continue before any injection)', /_sf\.why === 'one-per-report'\) \{[\s\S]{0,260}continue;/.test(route));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
