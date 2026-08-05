// Unit tests for scripts/lib/assessmentDiff.mjs — deterministic, no I/O.
// Run: node scripts/validate-assessment-diff.mjs
import { diffAssessments, renderDiffTable } from './lib/assessmentDiff.mjs';

let passed = 0, failed = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS  ${label}`); passed++; } else { console.error(`  FAIL  ${label}`); failed++; } }

// Baseline = DMZ4614-like BEFORE the A1/A3 changes; candidate = AFTER.
const before = {
  _partsReconciliation: { parts_sum: 3775 },
  _investmentBlock: { bidCeilings: { rebuild: null, flip: { value: 3670 }, partsOut: { value: 860 } } },
  _damageCards: [
    { part: 'Headlamp', origin: 'Visible', severity: '', action: 'replace', cost: 350 },
    { part: 'Rear quarter panel', origin: 'Visible', severity: 'Severe', action: 'replace', cost: 220 },
    { part: 'Front door', origin: 'Visible', severity: 'Severe', action: 'replace', cost: 330 },
  ],
  'Key Cost Drivers': 'Structural sill: outer sill folded at its full length — replacement and blend.',
  'Red Flags': 'Outer sill is deeply crushed and folded along its length.',
  'Visible Damage Summary': 'Full-flank side impact.',
};
const after = {
  _partsReconciliation: { parts_sum: 3425 },                                   // A1: −£350 lamp
  _investmentBlock: { bidCeilings: { rebuild: { value: 6547 }, flip: { value: 3670 }, partsOut: { value: 860 } } }, // ceiling surfaced
  _damageCards: [
    { part: 'Headlamp', origin: 'Inferred', severity: '', action: 'inspect', cost: 0 },   // A1: moved to allowance
    { part: 'Rear quarter panel', origin: 'Visible', severity: 'Minor', action: 'repair', cost: 220 }, // A3: Severe→Minor
    { part: 'Front door', origin: 'Visible', severity: 'Severe', action: 'replace', cost: 330 },        // unchanged (control)
  ],
  'Key Cost Drivers': 'Front and rear doors: twin replacement plus paint.',      // sill removed
  'Red Flags': 'Inner sill cannot be confirmed from the photos — inspect.',      // downgraded
  'Visible Damage Summary': 'Full-flank side impact.',                           // unchanged
};

const diff = diffAssessments(before, after);
console.log(renderDiffTable(diff, 'DMZ4614 baseline → A1+A3 replay'));

console.log('\n=== assertions ===\n');
ok('parts_sum change detected (£3775→£3425, Δ−350)', diff.partsSum.changed && diff.partsSum.delta === -350);
ok('anyDirectionChange = true', diff.anyDirectionChange === true);
const rq = diff.parts.find(p => p.part === 'Rear quarter panel');
ok('rear quarter flagged severity ↓ Severe→Minor', rq && rq.flags.some(f => /severity ↓/.test(f)));
ok('rear quarter flagged action replace→repair', rq && rq.flags.some(f => /action replace→repair/.test(f)));
const hl = diff.parts.find(p => p.part === 'Headlamp');
ok('headlamp flagged £ 350→0', hl && hl.flags.some(f => /£ 350→0/.test(f)));
ok('front door (control) NOT flagged', !diff.parts.some(p => p.part === 'Front door'));
const reb = diff.ceilings.find(c => c.k === 'rebuild');
ok('rebuild ceiling change detected (null→6547)', reb && reb.changed && reb.a === 6547);
ok('flip ceiling unchanged', diff.ceilings.find(c => c.k === 'flip').changed === false);
ok('KCD prose changed', diff.prose.find(p => p.field === 'Key Cost Drivers').changed === true);
ok('Red Flags prose changed', diff.prose.find(p => p.field === 'Red Flags').changed === true);
ok('VDS prose unchanged', diff.prose.find(p => p.field === 'Visible Damage Summary').changed === false);

console.log('\n=== identical assessments → no changes ===\n');
const same = diffAssessments(before, before);
ok('identical → no parts changes', same.parts.length === 0);
ok('identical → anyDirectionChange false', same.anyDirectionChange === false);

console.log(`\n${failed === 0 ? '✅' : '❌'} assessment-diff: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
