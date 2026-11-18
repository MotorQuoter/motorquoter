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
// batch 250: the probe map is gone (probes read all photos); 'flank' is still a frame-zone word (demotion, R1 read it).

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
const sel = (cp, front) => selectProbeFramesForPanel(cp, fz, front);
// batch 250 (Vincent, 18 Nov — option 2b): the zone tags no longer choose probe photos. Every probe that is not a
// correspondence-owned instance reads ALL photos (indices null → runAttributionProbe takes the first 35 in upload order).
for (const [name, cp, front] of [['flank', flankPanel, false], ['front', frontPanel, false], ['front-flank on a front impact', { panelId: 'FRONT_WING', zone: 'flank-damaged-side' }, true]]) {
  const r = sel(cp, front);
  ok(`batch 250: a ${name} panel's probe reads all photos, not a zone-chosen set`, r.indices === null && r.source === 'all-photos');
}
ok('batch 250: the probe photo choice reads no zone tag (PROBE_ZONE_MAP and selectProbeFrames are gone)', !/PROBE_ZONE_MAP|selectProbeFrames\(/.test(src));
ok('the selector takes no side argument (cp, frameZones, frontImpact)', selectProbeFramesForPanel.length === 3 && !/selectProbeFramesForPanel\(cp, _frameZones, lampObs\?\.struckSide/.test(src));
const corr = selectProbeFramesForPanel({ panelId: 'FRONT_WING', zone: 'flank-damaged-side', _gOwned: true, _probeViews: [0, 1, 6] }, fz, true);
ok('a correspondence-owned instance still takes its OWN frames (the zone tag does not override it)', corr.source === 'corr-instance:[0,1,6]');

console.log('\n4. TASK 5 — option D (Vincent, 11 Sep): count the red brake lamp, state the parking-brake limit');
{
  const { buildDashLine, DASH_BRAKE_PARKING_NOTE } = await import('../app/api/salvage/assess/route.js');
  ok('dash prompt: a lit red brake symbol IS ABS_BRAKE on a parked car — emit it, do not skip it', src.includes('is ABS_BRAKE even on a parked car where it may only mean the parking brake is on: emit it, do not skip it'));
  ok('the telltale enum is unchanged — no PARKING_BRAKE token (that was option C)', !src.includes('PARKING_BRAKE'));
  const withBrake = buildDashLine({ cluster: 'warning', telltales: ['TPMS', 'ABS_BRAKE'] });
  ok('ABS_BRAKE in the read → the line names it AND carries the parking-brake note', withBrake === `Dashboard read: warning light(s) shown — tyre pressure, ABS/brake. ${DASH_BRAKE_PARKING_NOTE}`);
  ok('NEGATIVE: no ABS_BRAKE → the line is byte-identical to before (no note)', buildDashLine({ cluster: 'warning', telltales: ['ENGINE_MIL'] }) === 'Dashboard read: warning light(s) shown — engine (MIL)');
  ok('clean / unlit / no-photo lines unchanged', buildDashLine({ cluster: 'clean', telltales: [] }) === 'Dashboard read: cluster lit, no warning lights shown.'
    && buildDashLine({ cluster: 'unlit', telltales: [] }).startsWith('The instrument cluster is photographed but unlit')
    && buildDashLine({ cluster: 'no-photo', telltales: [] }) === 'No dashboard photograph in the listing.');
  ok('the note is Latin-1 and dash-free (the PDF strips dashes)', !/[^\x00-\xFF]/.test(DASH_BRAKE_PARKING_NOTE) && !/[—–]/.test(DASH_BRAKE_PARKING_NOTE));
  ok('ONE OWNER: the note\'s literal appears once in the route', src.split('lit by an applied parking brake, so check it goes out').length - 1 === 1);
  ok('the route builds the line through buildDashLine (not a second inline copy)', src.includes('const _dashLine = buildDashLine(dashRead);'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} prompt-batch118: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
