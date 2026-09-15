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

console.log('\nB. batch 136 task B — "cannot determine" never deletes money (permanent ruling, 1 Sep)');
{
  const { probeVerdictAction, attribUnconfirmedWording, PROBE_CONTRADICTS } = await import('../app/api/salvage/assess/route.js');
  // Every verdict the probe can return, both branches: [verdict, missing, BEFORE (batch 135 behaviour), AFTER].
  const table = [
    ['consistent-with-claim', false, 'kept', 'kept'],
    ['no-damage-visible', false, 'floored', 'floored'],
    ['minor-cosmetic', false, 'floored', 'floored'],
    ['cannot-determine', false, 'floored', 'unconfirmed-kept'],
    ['something-off-enum', false, 'floored', 'unconfirmed-kept'],   // coerced to cannot-determine by runAttributionProbe
    ['absent', true, 'kept', 'kept'],
    ['area-destroyed', true, 'kept', 'kept'],
    ['present-and-intact', true, 'floored', 'floored'],
    ['minor-cosmetic-only', true, 'floored', 'floored'],
    ['cannot-determine', true, 'floored', 'unconfirmed-kept'],
  ];
  for (const [v, missing, before, after] of table) {
    eq(`verdict ${v} (${missing ? 'missing' : 'damaged'} branch): was ${before} → now`, probeVerdictAction(v, missing), after);
  }
  ok('only POSITIVE contradictions may floor', JSON.stringify(PROBE_CONTRADICTS) === JSON.stringify({ damaged: ['no-damage-visible', 'minor-cosmetic'], missing: ['present-and-intact', 'minor-cosmetic-only'] }));

  const storedWing = A._attributionProbe.panels.find((p) => p.panelId === 'FRONT_WING');
  eq('HV25ODX: the stored wing verdict (cannot-determine) now KEEPS the wing costed', probeVerdictAction(storedWing.verdict, false), 'unconfirmed-kept');
  const modelRow = A._preGateParts.find((p) => p.panelId === 'FRONT_WING');
  ok('HV25ODX: the wing the probe would have deleted is the model\'s £110 replace row', modelRow?.action === 'replace' && modelRow.used === 110);
  const note = attribUnconfirmedWording('Front wing', false);
  eq('buyer note, verbatim', note, 'A second photo check could not confirm the damage to the Front wing - it is included in the repair total. Inspect it, and strike the line if it proves sound.');
  ok('the note says it is IN the total and that the buyer can strike it', /included in the repair total/.test(note) && /strike the line/.test(note));
  ok('the note is Latin-1 with no dash (PDF flag reasons skip the dash mapping)', !/[^\x00-\xFF]/.test(note) && !/[—–]/.test(note) && !/[^\x00-\xFF]/.test(attribUnconfirmedWording('Grille', true)));
  ok('route: the probe loop decides through the one owner', route.includes('probeVerdictAction(r.verdict, missing)'));
  ok('route: an unconfirmed-kept panel stays independently visible and gets the note flag', route.includes('_attribUnconfirmed: true') && route.includes('reason:   attribUnconfirmedWording(PANEL_DISPLAY[cp.panelId], missing)'));
  ok('route: the old "a reached verdict floors" rule is gone from the comment', !route.includes('cannot-determine is shared with the damaged enum and floors in both'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} hv25odx: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
