// validate-prompt-batch118 — the prompt batch (batch 118), tasks 2, 3 and 4. £0, no model calls.
//
// These pins prove the WORDS reached the prompts and the code that reads the answers behaves. They do
// NOT prove the model now answers differently — that is only proven by the authorised recapture
// (batch 118 step 5). Task 1 (the instance concept) is pinned in validate-perview-parse.
//
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-prompt-batch118.mjs
import { readFileSync } from 'node:fs';
import { selectProbeFramesForPanel } from '../app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');

console.log('\n1. TASK 3 — no month in the prompt (a cassette must not expire on the 1st)');
ok('the valuation header carries no date', src.includes("'Live market valuation data:',") && !src.includes('Live market valuation data (${monthYear}):'));
ok('no new Date() is left anywhere in the assessment route', !/new Date\(\)/.test(src));
ok('no month-name formatting survives in the route', !/month:\s*'long'/.test(src));

console.log('\n2. TASK 4 — judge the headlamp, not the daytime-running light');
ok('the lamp prompt says to judge the MAIN-BEAM / DIPPED-BEAM unit', src.includes('The type is the type of the MAIN-BEAM / DIPPED-BEAM unit'));
ok('…and says an LED running strip tells nothing about the headlamp', src.includes('an LED running strip tells you nothing about the headlamp'));
ok('…and makes "indeterminate" the right answer when only the DRL is legible', src.includes('the type is "indeterminate" — that is the correct answer, not a failure'));
ok('the lamp_type enum is unchanged — no fourth type (halogen | hid | led | indeterminate)', src.includes('"lamp_type": "halogen" | "hid" | "led" | "indeterminate",'));

console.log('\n3. TASK 2 — a close-up says what it is a close-up of');
ok('frame-zone prompt: a detail close-up must ALSO carry its aspect', src.includes('A "detail" close-up must ALSO say which part of the car it is a close-up of'));
ok('frame-zone enum admits "flank" (a side close-up whose side cannot be told)', src.includes("const FRAME_ZONE_ENUM = ['front', 'rear', 'nearside', 'offside', 'flank', 'roof', 'interior', 'detail'];"));
ok('probe map: flank panels take "flank" close-ups', src.includes("'flank-damaged-side': ['nearside', 'offside', 'flank']"));

const fz = {
  ok: true,
  frames: [
    { i: 0, zones: ['front', 'offside'] },
    { i: 7, zones: ['detail', 'front'] },      // a front close-up
    { i: 20, zones: ['detail', 'offside'] },   // AMZ3790 frame 20, tagged as it should be
    { i: 21, zones: ['detail', 'flank'] },     // a side close-up, side unknown
    { i: 22, zones: ['detail'] },              // a VIN plate — says nothing
  ],
};
const flankPanel = { panelId: 'SILL', zone: 'flank-damaged-side' };
const frontPanel = { panelId: 'BONNET', zone: 'front' };
const sel = (cp, side, front) => selectProbeFramesForPanel(cp, fz, side, front);
ok('a flank panel\'s probe now receives side close-ups (20 with a side, 21 without)', JSON.stringify(sel(flankPanel).indices) === JSON.stringify([0, 20, 21]));
ok('a front panel\'s probe receives the front close-up (7)', JSON.stringify(sel(frontPanel).indices) === JSON.stringify([0, 7]));
ok('a bare ["detail"] frame reaches NO probe (the read could not say what it shows)', ![sel(flankPanel), sel(frontPanel)].some((r) => r.indices.includes(22)));
const p2 = sel({ panelId: 'FRONT_WING', zone: 'flank-damaged-side' }, 'offside', true);
ok('struck-side probe (P2) takes the offside close-up but NOT the side-unknown "flank" one', p2.source.startsWith('struck-side:offside') && p2.indices.includes(20) && !p2.indices.includes(21));
const corr = selectProbeFramesForPanel({ panelId: 'FRONT_WING', zone: 'flank-damaged-side', _gOwned: true, _probeViews: [0, 1, 6] }, fz, 'offside', true);
ok('a correspondence-owned instance still takes its OWN frames (the zone tag does not override it)', corr.source === 'corr-instance:[0,1,6]');

console.log(`\n${fail === 0 ? '✅' : '❌'} prompt-batch118: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
