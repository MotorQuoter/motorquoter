// validate-batch169.mjs — batch 169: the zone demotion keeps a mis-tagged frame's votes (batch 168 Part 3,
// tightened: either-end panels ignored; at least 2 distinct end-specific panels, all of the other end).
// £0, pure, no model calls.   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch169.mjs
import { readFileSync } from 'fs';
import { demoteContradictedVotes, END_SPECIFIC_PANELS } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const vote = (panelId, iv, severity = null) => ({ panelId, independentlyVisible: iv, severity, zone: 'front' });
const fz = (frames) => ({ ok: true, frames: frames.map(([i, zones]) => ({ i, zones })) });
const run = (idx, rows, tags, inst = rows) => demoteContradictedVotes([{ idx, costedParts: rows, instanceParts: inst }], fz([[idx, tags]]));

console.log('\n-- kept: a mis-tagged frame --');
{ // CK75ONW live run view 9 — 7 records, 6 distinct front panels, tag ["rear"].
  const rows = [vote('BONNET', true, 'MODERATE'), vote('FRONT_BUMPER', true, 'MINOR'), vote('GRILLE', null), vote('SLAM_PANEL', true, 'MODERATE'),
    vote('HEADLAMP', null), vote('HEADLAMP', null), vote('FRONT_STRUCTURE', null)];
  ok('CK75ONW view 9 (6 front panels vs ["rear"]) → nothing demoted', run(9, rows, ['rear']).length === 0);
  ok('…BONNET stays iv:true MODERATE', rows[0].independentlyVisible === true && rows[0].severity === 'MODERATE');
}
{ // CK75ONW cassette view 8 — 7 rear panels + WHEEL + TYRE, tag ["front"] (batch 168's miss).
  const rows = [vote('REAR_BUMPER', 'missing'), vote('REAR_QUARTER', true, 'SEVERE'), vote('REAR_LAMP', true, 'MODERATE'), vote('REAR_PANEL', true, 'SEVERE'),
    vote('BOOT_LID', true, 'MODERATE'), vote('REAR_STRUCTURE', true, 'SEVERE'), vote('REAR_GLASS', null), vote('WHEEL', false), vote('TYRE', false)];
  ok('CK75ONW view 8 (7 rear panels + WHEEL + TYRE vs ["front"]) → nothing demoted — either-end panels ignored', run(8, rows, ['front']).length === 0);
  ok('…REAR_QUARTER stays iv:true SEVERE', rows[1].independentlyVisible === true && rows[1].severity === 'SEVERE');
}
console.log('\n-- demoted as before (batch 119 stands) --');
{
  const q = vote('REAR_QUARTER', true, 'SEVERE');
  ok('a LONE other-end panel is ambiguous → demoted', run(2, [q], ['front']).length === 1 && q.independentlyVisible === null);
  const w = vote('FRONT_WING', true, 'MODERATE');
  ok('a lone other-end panel beside either-end panels (WHEEL, TYRE, FRONT_DOOR) → still demoted',
    run(3, [w, vote('WHEEL', false), vote('TYRE', false), vote('FRONT_DOOR', true)], ['rear']).length === 1 && w.independentlyVisible === null);
  const l1 = vote('REAR_LAMP', true, 'SEVERE'), l2 = vote('REAR_LAMP', false);
  ok('one panel\'s two instance rows count as ONE panel → demoted (batch 119 test 5 shape)', run(5, [l1], ['front'], [l1, l2]).length === 2 && l1.independentlyVisible === null);
  const a = vote('REAR_QUARTER', true, 'SEVERE'), b = vote('REAR_LAMP', true, 'SEVERE');
  ok('two other-end panels beside ONE own-end panel → not all other-end → both demoted',
    run(6, [a, b, vote('FRONT_BUMPER', true)], ['front']).length === 2 && a.independentlyVisible === null && b.independentlyVisible === null);
  const c = vote('REAR_QUARTER', true, 'SEVERE');
  ok('AMZ3790 frame 20 (REAR_QUARTER + FRONT_DOOR, ["detail","front"]) → still demoted', run(20, [c, vote('FRONT_DOOR', true, 'MODERATE')], ['detail', 'front']).length === 1);
  const d = vote('REAR_QUARTER', true), e = vote('BOOT_LID', true);
  ok('two other-end panels in a frame NOT end-only ([front, nearside]) → rule not engaged, nothing demoted', run(7, [d, e], ['front', 'nearside']).length === 0 && d.independentlyVisible === true);
}
console.log('\n-- one named set, log text --');
ok('the rule reads END_SPECIFIC_PANELS (front 8 + rear 7) — no second list', END_SPECIFIC_PANELS.front.size === 8 && END_SPECIFIC_PANELS.rear.size === 7
  && route.includes('END_SPECIFIC_PANELS.front.has(pid) || END_SPECIFIC_PANELS.rear.has(pid)'));
ok('the kept case is logged', route.includes('the frame-zone tag ${JSON.stringify(tags)} is wrong for this photo, not the read (batch 169)'));
ok('the split no longer calls an excluded view "opposite-side"', !route.includes('(opposite-side — not part of damaged instance)')
  && route.includes('(not in the correspondence instance — no side checked)'));
ok('S2d is not built (ruling 1)', !route.includes('sameFrameCleanExcluded') && !route.includes('same-frame-clean-excluded'));

console.log(`\nbatch169: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
