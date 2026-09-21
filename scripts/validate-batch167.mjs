// validate-batch167.mjs — batch 167 Part 1 (the rear end gets ONE fog lamp) and Part 2 (the prompt line
// that keeps costing talk out of the model's prose). £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch167.mjs
import { readFileSync } from 'fs';
import { PANEL } from '../lib/panelEnum.mjs';
import { applyFogBumperRule, FOG_LAMPS_PER_END } from '../lib/partsCompleteness.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const route = read('../app/api/salvage/assess/route.js');
const engine = read('../config/assessmentEngine.js');

const SEED = { oem: 190, used: 105 };   // CK75ONW's Luxury fog band (batch 166)
const rearFog = () => ({ panelId: PANEL.FOG_LAMP, name: 'Rear fog lamp', zone: 'rear', action: 'replace', used: 105 });
const frontFog = () => ({ panelId: PANEL.FOG_LAMP, name: 'Front fog lamp', zone: 'front', action: 'replace', used: 105 });
const bumper = (pid) => ({ panelId: pid, name: pid, action: 'replace', used: 360 });
const allText = (r) => [...r.costedToAdd, ...r.flagsToAdd].map((x) => `${x.partName || x.name || ''} ${x.reason || ''}`).join(' | ');

console.log('\n-- Part 1: the rear carries one fog lamp; the front still carries two --');
ok('one owner: FOG_LAMPS_PER_END = { front: 2, rear: 1 }', FOG_LAMPS_PER_END.front === 2 && FOG_LAMPS_PER_END.rear === 1 && Object.isFrozen(FOG_LAMPS_PER_END));
ok('route.js carries no fog count of its own (no special case there)',
  !/FOG_LAMPS_PER_END\s*[[.]/.test(route) && !/rear[^\n]{0,40}fog[^\n]{0,40}\b(?:=|===)\s*1\b/i.test(route));

{ // CK75ONW's case: rear bumper confirmed gone, no fog in the ledger.
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.REAR_BUMPER)], rearBumperGone: true, rearBumperConfirmed: true, fogSeed: SEED });
  ok('CK75ONW shape: rear gone + 0 rear fogs → ONE Rear fog lamp at £105', r.costedToAdd.length === 1
    && r.costedToAdd[0].name === 'Rear fog lamp' && r.costedToAdd[0].zone === 'rear' && r.costedToAdd[0].used === 105 && r.costedToAdd[0]._fogPaired === true);
  ok('…and no flag', r.flagsToAdd.length === 0);
}
{
  const r = applyFogBumperRule({ costedParts: [rearFog()], rearBumperGone: true, rearBumperConfirmed: true, fogSeed: SEED });
  ok('rear gone + 1 rear fog already in the ledger → add none', r.costedToAdd.length === 0 && r.flagsToAdd.length === 0);
}
{
  const r = applyFogBumperRule({ costedParts: [rearFog(), rearFog()], rearBumperGone: true, rearBumperConfirmed: true, fogSeed: SEED });
  ok('rear gone + 2 rear fogs the model wrote → add none (never strips the model\'s rows either)', r.costedToAdd.length === 0 && r.flagsToAdd.length === 0);
}
{
  const r = applyFogBumperRule({ costedParts: [rearFog()], rearBumperGone: false, fogSeed: SEED });
  ok('rear INTACT + 1 rear fog → no "Second rear fog lamp" flag (one is the full count)', r.flagsToAdd.length === 0 && !/second rear/i.test(allText(r)));
}
{
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.REAR_BUMPER)], rearBumperGone: true, rearBumperConfirmed: false, fogSeed: SEED });
  ok('rear gone but UNCONFIRMED → one low flag, no cost', r.costedToAdd.length === 0 && r.flagsToAdd.length === 1 && r.flagsToAdd[0]._fogUnconfirmedParent === true);
  ok('…its wording says "the rear fog lamp sits in it", never "both rear fog lamps"',
    /the rear fog lamp sits in it/.test(r.flagsToAdd[0].reason) && !/both rear/i.test(allText(r)) && r.flagsToAdd[0].partName === 'rear fog lamp');
}
{
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.REAR_BUMPER)], rearBumperGone: true, rearBumperConfirmed: true, fogSeed: null });
  ok('rear gone, no band → one medium flag, singular wording', r.costedToAdd.length === 0 && r.flagsToAdd.length === 1
    && /the rear fog lamp sits in it/.test(r.flagsToAdd[0].reason) && !/both rear/i.test(allText(r)) && r.flagsToAdd[0].partName === 'rear fog lamp');
}
// FRONT — unchanged.
{
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.FRONT_BUMPER)], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: SEED });
  ok('front gone + 0 fogs → TWO Front fog lamps (unchanged)', r.costedToAdd.length === 2 && r.costedToAdd.every((f) => f.name === 'Front fog lamp'));
}
{
  const r = applyFogBumperRule({ costedParts: [frontFog()], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: SEED });
  ok('front gone + 1 fog → one clone (unchanged)', r.costedToAdd.length === 1);
}
{
  const r = applyFogBumperRule({ costedParts: [frontFog()], frontBumperGone: false, fogSeed: SEED });
  ok('front intact + 1 fog → "Second front fog lamp" flag (unchanged)', r.flagsToAdd.length === 1 && /second front fog/i.test(r.flagsToAdd[0].partName));
}
{
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.FRONT_BUMPER)], frontBumperGone: true, frontBumperConfirmed: false, fogSeed: SEED });
  ok('front unconfirmed flag still says "both front fog lamps" (unchanged)', /both front fog lamps sit in it/.test(r.flagsToAdd[0]?.reason || ''));
}
{
  const r = applyFogBumperRule({ costedParts: [bumper(PANEL.FRONT_BUMPER), bumper(PANEL.REAR_BUMPER)], frontBumperGone: true, frontBumperConfirmed: true, rearBumperGone: true, rearBumperConfirmed: true, fogSeed: SEED });
  ok('both ends gone → 2 front + 1 rear = 3 rows', r.costedToAdd.length === 3
    && r.costedToAdd.filter((f) => f.zone === 'front').length === 2 && r.costedToAdd.filter((f) => f.zone === 'rear').length === 1);
}

console.log('\n-- Part 2: the model does not describe how a line is costed --');
ok('the prompt carries the batch 167 prose rule', engine.includes('batch 167') && /allowance/i.test(engine));

console.log(`\nbatch167: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
