// validate-batch186.mjs — batch 186 P1: a hyphenated word in a panel name stays one keyword ("body-side"), so the floored
// scrub no longer matches BODY_SIDE_GLAZING on the bare word "body". £0, pure, no model calls. (P2 is report only.)
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch186.mjs
import { panelKeywords, neutraliseVDS, scrubKCD } from '@/lib/flooredProseScrub.mjs';
import { PANEL_DISPLAY } from '@/lib/panelEnum.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const J = JSON.stringify;
const GLAZING = PANEL_DISPLAY.BODY_SIDE_GLAZING;

console.log('\n-- keywords --');
ok('display name is "Body-side glazing"', GLAZING === 'Body-side glazing');
ok('panelKeywords("Body-side glazing") = ["body-side","glazing"]', J(panelKeywords(GLAZING)) === J(['body-side', 'glazing']));
ok('"body" alone is no longer a keyword of any panel', !Object.values(PANEL_DISPLAY).some((n) => panelKeywords(n).includes('body')));
ok('non-hyphen panel unchanged: Front bumper → ["bumper","fascia"]', J(panelKeywords('Front bumper')) === J(['bumper', 'fascia']));
ok('non-hyphen panel unchanged: Rear quarter panel → ["quarter"]', J(panelKeywords('Rear quarter panel')) === J(['quarter']));
ok('slash name unchanged: Rear light strip / tailgate garnish', J(panelKeywords('Rear light strip / tailgate garnish')) === J(['light', 'strip', 'tailgate', 'garnish']));
ok('parenthetical still dropped: SRS airbag (deployed) → ["airbag"]', J(panelKeywords('SRS airbag (deployed)')) === J(['airbag']));

console.log('\n-- the scrub, with BODY_SIDE_GLAZING floored --');
{
  const costed = ['Rear quarter panel', 'Wheel arch moulding'];
  const floored = [GLAZING, 'Rear bumper', 'Sill'];
  const t = 'creased and scuffed body panel';
  ok('"creased and scuffed body panel" is not touched', neutraliseVDS(t, floored, costed).text === t);
  for (const s of ['shattered body-side glass', 'shattered body side glass']) {
    const r = neutraliseVDS(s, floored, costed);
    ok(`"${s}" is still neutralised`, r.text === s.replace('shattered ', '') && r.changes.length === 1);
  }
  ok('plural tolerance kept (wordIn): a floored-only lead "Body sides" is dropped',
    scrubKCD('- Body sides: glass shattered.', floored, costed).dropped.length === 1);
  ok('…and a lead "Body panel" is not (no keyword "body")', scrubKCD('- Body panel: scuffed.', floored, costed).dropped.length === 0);
  // EN23NJX, the model's Key Cost Drivers (cassette) with EN23NJX's floored/costed sets (batch 185 P3 trace)
  const KCD = [
    '- Rear quarter panel: creased and scuffed body panel requiring repair and blend into adjacent panels — main paint-labour driver.',
    '- Rear bumper: dished trailing corner, replace and refinish.',
    '- Structural sill: outer sill scuffing sits over the rocker line, so proper repair may require more than cosmetic refinish.',
  ].join('\n');
  const r = scrubKCD(KCD, floored, costed);
  ok('(EN23NJX) the bullet comes back whole', r.text === '- Rear quarter panel: creased and scuffed body panel requiring repair and blend into adjacent panels — main paint-labour driver.');
  ok('(EN23NJX) no neutralise change; the two floored-lead bullets are still dropped', r.changes.length === 0 && r.dropped.length === 2);
}

console.log(`\nbatch186: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
