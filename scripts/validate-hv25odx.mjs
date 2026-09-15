// validate-hv25odx — batch 136. Locks the HV25ODX failure shapes (15 Sep preview run, 1e8a730) so none can regress.
// Every input is the REAL stored shape from fixtures/HV25ODX/stored-shapes.json (extracted read-only, batch 135/136).
// HV25ODX has no model cassette, so this is not a replay: each section runs the real code on the real stored shapes.
//
// £0 — no network, no provider, no model. Run:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-hv25odx.mjs
import { readFileSync } from 'node:fs';
import { selectProbeFramesForPanel } from '../app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
const H = JSON.parse(readFileSync('fixtures/HV25ODX/stored-shapes.json', 'utf8'));
const A = H.assessment;
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');

console.log('\nA. batch 136 task A — the probe never chooses photos by left/right (the side ban)');
{
  const fz = A._frameZones;
  const lampObs = A._lampObs;
  const storedWing = A._attributionProbe.panels.find((p) => p.panelId === 'FRONT_WING');
  ok('STORED SHAPE: the wing was probed on [2,10] (rear three-quarter + spare wheel) and floored on cannot-determine',
     JSON.stringify(storedWing.frames) === '[2,10]' && storedWing.action === 'floored' && storedWing.verdict === 'cannot-determine');
  ok('STORED SHAPE: the log names the side filter', H.logLines.some((l) => l.includes('FRONT_WING cannot-determine floored frames=struck-side:offside:[2,10]')));
  ok('STORED SHAPE: struckSide=offside, front impact (apertureExposed)', lampObs.struckSide === 'offside' && lampObs.apertureExposed === true);
  const frontNeighbour = A._attributionProbe.panels.find((p) => p.panelId === 'BONNET');
  eq('STORED SHAPE: the front neighbours were probed on the front-tagged frames', frontNeighbour.frames, [0, 1, 8, 12]);

  // The real selector on the real stored frame tags. The wing's pooled zone on this run was flank-damaged-side (that is
  // the only zone under which the old P2 fired, and the log proves it fired).
  const wing = { panelId: 'FRONT_WING', zone: 'flank-damaged-side' };
  const got = selectProbeFramesForPanel(wing, fz, lampObs.apertureExposed === true);
  eq('NOW: the wing is probed on the SAME frames as its front neighbours', got.indices, frontNeighbour.frames);
  ok('NOW: the source says front-flank, not struck-side', got.source.startsWith('front-flank:') && !got.source.includes('struck-side'));
  ok('NOW: never frame 2 (rear three-quarter) or frame 10 (spare wheel)', !got.indices.includes(2) && !got.indices.includes(10));
  const door = selectProbeFramesForPanel({ panelId: 'FRONT_DOOR', zone: 'flank-damaged-side' }, fz, true);
  eq('a front door on the same impact gets the same front set', door.indices, frontNeighbour.frames);
  ok('the selector cannot take a side: arity 3, and the route passes no struckSide', selectProbeFramesForPanel.length === 3
     && route.includes('selectProbeFramesForPanel(cp, _frameZones, lampObs?.apertureExposed === true)')
     && !/struck-side:\$\{struckSide\}/.test(route));
  const notFront = selectProbeFramesForPanel(wing, fz, false);
  ok('not a front impact → the unchanged zone map (both sides + flank, never one side)', notFront.source.startsWith('frame-zone:') && notFront.indices.includes(2) && notFront.indices.includes(3));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} hv25odx: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
