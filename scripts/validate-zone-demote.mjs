// validate-zone-demote — batch 119: two reads that disagree are not both trusted (Vincent, 11 Sep: "E it is.").
//
// A per-view vote for an END-SPECIFIC panel, from a frame the independent frame-zone read places at the
// OTHER end only, is demoted to na. Pins the three constraints Cowork named, on the SHIPPED functions:
//   1. na, never clean  ·  2. exclusive tags only (read strictly — one end and NOTHING else)
//   3. end-specific panels only  ·  plus fail-open and the always-on log.
// £0, no model calls.   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-zone-demote.mjs
import { readFileSync } from 'node:fs';
import { demoteContradictedVotes, frameEndOnly, END_SPECIFIC_PANELS } from '../app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const vote = (panelId, iv, severity = null) => ({ panelId, independentlyVisible: iv, severity, zone: 'flank-damaged-side' });
const view = (idx, rows) => ({ idx, costedParts: rows, instanceParts: rows });
const fz = (frames) => ({ ok: true, frames: frames.map(([i, zones]) => ({ i, zones })) });

console.log('\n1. THE CASE THAT EARNED IT — AMZ3790 frame 20');
{
  const q = vote('REAR_QUARTER', true, 'SEVERE');
  const d = demoteContradictedVotes([view(20, [q, vote('FRONT_DOOR', true, 'MODERATE')])], fz([[20, ['detail', 'front']]]));
  ok('the REAR_QUARTER SEVERE vote from a ["detail","front"] frame is demoted', d.length === 1 && d[0].panelId === 'REAR_QUARTER');
  ok('CONSTRAINT 1: demoted to na (null) — NEVER to clean (false)', q.independentlyVisible === null && q.independentlyVisible !== false);
  ok('…and its severity goes with it', q.severity === null);
  ok('the demotion carries both reads: what the vote was, and the tag set', d[0].was.iv === true && d[0].was.sev === 'SEVERE' && JSON.stringify(d[0].tags) === '["detail","front"]');
  ok('CONSTRAINT 3: FRONT_DOOR in the same frame is untouched (a door is a flank panel)', d.every((x) => x.panelId !== 'FRONT_DOOR'));
}

console.log('\n2. CONSTRAINT 2 — exclusive tags only, read strictly');
{
  const cases = [
    [['front'], 'front'], [['detail', 'front'], 'front'], [['rear'], 'rear'], [['detail', 'rear'], 'rear'],
    [['front', 'rear'], null], [['front', 'nearside'], null], [['rear', 'offside'], null],
    [['detail', 'front', 'offside'], null], [['front', 'interior'], null], [['front', 'roof'], null],
    [['detail'], null], [['nearside'], null], [[], null], [undefined, null],
  ];
  for (const [tags, want] of cases) ok(`frameEndOnly(${JSON.stringify(tags)}) → ${want}`, frameEndOnly(tags) === want);
  const q = vote('REAR_QUARTER', false);
  demoteContradictedVotes([view(0, [q])], fz([[0, ['front', 'nearside']]]));
  ok('a front THREE-QUARTER shot never demotes the far rear quarter it shows along the flank', q.independentlyVisible === false);
  const b = vote('REAR_BUMPER', true, 'SEVERE');
  demoteContradictedVotes([view(3, [b])], fz([[3, ['front', 'rear']]]));
  ok('a frame tagged both ends never demotes anything', b.independentlyVisible === true);
}

console.log('\n3. CONSTRAINT 3 — end-specific panels only, exactly the ruled list');
{
  const want = {
    front: ['FRONT_BUMPER', 'GRILLE', 'BONNET', 'SLAM_PANEL', 'FRONT_WING', 'HEADLAMP', 'RADIATOR_PACK', 'FRONT_STRUCTURE'],
    rear: ['REAR_BUMPER', 'REAR_QUARTER', 'REAR_LAMP', 'BOOT_LID', 'REAR_PANEL', 'REAR_GLASS', 'REAR_STRUCTURE'],
  };
  ok('FRONT set is exactly the ruled eight', JSON.stringify([...END_SPECIFIC_PANELS.front].sort()) === JSON.stringify([...want.front].sort()));
  ok('REAR set is exactly the ruled seven', JSON.stringify([...END_SPECIFIC_PANELS.rear].sort()) === JSON.stringify([...want.rear].sort()));
  const flank = ['FRONT_DOOR', 'REAR_DOOR', 'SILL', 'SIDE_SKIRT', 'DOOR_MIRROR', 'SIDE_GLASS', 'WHEEL', 'TYRE', 'ROOF', 'FOG_LAMP', 'WINDSCREEN', 'CAB_REAR_PANEL', 'CAB_REAR_GLASS', 'AIRBAG', 'OTHER'];
  const rowsF = flank.map((p) => vote(p, true, 'SEVERE')), rowsR = flank.map((p) => vote(p, true, 'SEVERE'));
  const d = demoteContradictedVotes([view(1, rowsR), view(8, rowsF)], fz([[1, ['rear']], [8, ['front']]]));
  ok('no flank / either-end / other panel is ever demoted, from a front-only OR a rear-only frame', d.length === 0 && [...rowsF, ...rowsR].every((r) => r.independentlyVisible === true));
  const w = vote('FRONT_WING', true, 'MODERATE');
  demoteContradictedVotes([view(2, [w])], fz([[2, ['rear']]]));
  ok('mirror case: a FRONT panel from a rear-only frame IS demoted', w.independentlyVisible === null);
  const own = vote('REAR_QUARTER', true, 'SEVERE');
  demoteContradictedVotes([view(4, [own])], fz([[4, ['detail', 'rear']]]));
  ok('a panel at its OWN end is never demoted', own.independentlyVisible === true);
}

console.log('\n4. FAIL OPEN');
{
  const q = () => vote('REAR_QUARTER', true, 'SEVERE');
  const a = q(); ok('frame-zone pass failed (ok:false) → no demotion', demoteContradictedVotes([view(20, [a])], { ok: false, frames: [] }).length === 0 && a.independentlyVisible === true);
  const b = q(); ok('frame has no tag entry → no demotion', demoteContradictedVotes([view(20, [b])], fz([[7, ['front']]])).length === 0 && b.independentlyVisible === true);
  const c = q(); ok('bare ["detail"] → no demotion', demoteContradictedVotes([view(20, [c])], fz([[20, ['detail']]])).length === 0 && c.independentlyVisible === true);
  const n = vote('REAR_QUARTER', null); ok('an already-na vote is not re-counted as a demotion', demoteContradictedVotes([view(20, [n])], fz([[20, ['front']]])).length === 0);
  const m = vote('REAR_BUMPER', 'missing'); demoteContradictedVotes([view(20, [m])], fz([[20, ['front']]]));
  ok('a contradicted "missing" vote is demoted to na too (never to clean)', m.independentlyVisible === null);
  ok('null / undefined inputs are safe', demoteContradictedVotes(null, null).length === 0 && demoteContradictedVotes(undefined, fz([])).length === 0);
}

console.log('\n5. INSTANCE ROWS — the vote and its instance rows cannot disagree');
{
  const q1 = vote('REAR_LAMP', true, 'SEVERE'), q2 = vote('REAR_LAMP', false);
  const r = { idx: 5, costedParts: [q1], instanceParts: [q1, q2] };
  const d = demoteContradictedVotes([r], fz([[5, ['front']]]));
  ok('both instance rows are demoted, each logged once (shared vote object not double-counted)', d.length === 2 && q1.independentlyVisible === null && q2.independentlyVisible === null);
}

console.log('\n6. THE ROUTE — demote before any vote is counted; loud; stamped');
{
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const iDemote = src.indexOf('const _zoneDemotions = demoteContradictedVotes(perViewResults, _frameZones);');
  const iCorr = src.indexOf('await runCorrespondencePass(perViewResults');
  const iGroup = src.indexOf('groupByPanelId(perViewResults)');
  ok('the demote runs BEFORE the correspondence pass and grouping', iDemote > 0 && iDemote < iCorr && iDemote < iGroup);
  ok('the frame-zone join now happens before the demote (single await, moved up)', src.indexOf('const _frameZones = await frameZonePromise;') < iDemote && src.split('await frameZonePromise').length - 1 === 1);
  ok('every demotion is logged unconditionally (no env flag) with both reads and the tag set', /for \(const d of _zoneDemotions\) \{\s*\n[^\n]*\n\s*console\.log\(`\[ZONE DEMOTE\] view \$\{d\.view\} \$\{d\.panelId\} iv:/.test(src));
  ok('a summary line is always printed, including "0 vote(s)" (absence is visible)', src.includes('console.log(`[ZONE DEMOTE] ${_zoneDemotions.length} vote(s) demoted'));
  ok('the demotions are stamped on the assessment', src.includes('assessment._zoneDemotions = _zoneDemotions;'));
  ok('the demote touches no prompt (per-view freeze): PER_VIEW_PROMPT has no zone-demote wording', !/ZONE DEMOTE|frameEndOnly/.test(src.slice(src.indexOf('export const PER_VIEW_PROMPT'), src.indexOf('async function runPerViewAssess'))));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} zone-demote: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
