// validate-batch188.mjs — batch 188: the floored neutraliser (word deletion) is removed; the Key Cost Drivers whole-bullet
// drop stays. £0, pure, no model calls. The four lots' inputs are the stored replay inputs at 8d42085 (KCD as the scrub
// received it; the charged panels and damage cards from the final ledger).
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch188.mjs
import * as scrub from '@/lib/flooredProseScrub.mjs';
import { PANEL_DISPLAY } from '@/lib/panelEnum.mjs';

const { scrubFlooredProse, scrubKCD } = scrub;
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const row = (id) => ({ panelId: id, name: PANEL_DISPLAY[id], action: 'replace', used: 100, oem: 200 });
const card = ([part, action, cost]) => ({ part, action, cost });
const lot = (charged, cards, kcd, vds) => ({ _reconciledParts: charged.map(row), _damageCards: cards.map(card), 'Key Cost Drivers': kcd, 'Visible Damage Summary': vds });

console.log('\n-- the neutraliser is gone --');
ok('neutraliseVDS is no longer exported', !('neutraliseVDS' in scrub));
ok('scrubFlooredProse returns only { kcdDropped }', (() => { const r = scrubFlooredProse(lot(['FRONT_DOOR'], [], '- Sill: crushed.', 'x')); return Object.keys(r).join(',') === 'kcdDropped'; })());

console.log('\n-- VDS unchanged with floored panels present --');
{
  const EN_VDS = 'The damage is a single-event flank swipe running along one side — a low-to-mid-height impact scuffing and creasing the sill, rear quarter and rear wheel-arch moulding, with the trailing sweep dishing the rear bumper corner; the front and opposite flank are undamaged and the engine bay is intact.';
  const a = lot(['REAR_QUARTER', 'WHEEL_ARCH_MOULDING'], [['Sill', 'inspect', 0], ['Rear bumper', 'inspect', 0]], '', EN_VDS);
  scrubFlooredProse(a);
  ok('(EN23NJX) "scuffing and creasing the sill" stays as written (floored sill)', a['Visible Damage Summary'] === EN_VDS);
  const DMZ_VDS = 'The primary unseeable risk is the inner structure behind the crushed flank — the sill reinforcement, B-pillar base and floor edge cannot be confirmed from the photos.';
  const d = lot(['FRONT_DOOR', 'REAR_DOOR'], [['Side structure', 'inspect', 0], ['Sill', 'inspect', 0]], '', DMZ_VDS);
  scrubFlooredProse(d);
  ok('(DMZ4614) "behind the crushed flank" stays as written (floored side structure)', d['Visible Damage Summary'] === DMZ_VDS);
  const ws = 'Double  spaces , and a space before a comma stay too.';
  const w = lot(['FRONT_DOOR'], [['Sill', 'inspect', 0]], '', ws);
  scrubFlooredProse(w);
  ok('whitespace the old tidy line changed is left alone', w['Visible Damage Summary'] === ws);
}

console.log('\n-- a kept KCD bullet is unchanged --');
{
  const k = '- Front and rear doors: both door shells are creased and folded, next to the crushed  sill line , as written.';
  const r = scrubKCD(k, ['Sill'], ['Front door', 'Rear door']);
  ok('kept bullet naming a floored panel mid-reason is byte-identical (no word deleted, no tidy)', r.text === k && r.dropped.length === 0);
}

console.log('\n-- the whole-bullet drop still works: the five corpus bullets, verbatim --');
const cases = [
  ['DL72FVX', ['WHEEL_ARCH_MOULDING'], [['Wheel arch moulding', 'replace', 60], ['Rear bumper', 'inspect', 0], ['Radiator pack', 'inspect', 0], ['Front bumper', 'inspect', 0], ['HV battery / EV system', 'inspect', 0]],
    '- Front bumper: displaced and split lower section requiring replacement and refinish — the main visible repair item.\n- Wheel arch moulding: trim cracked/marked at the arch — replace and blend.',
    ['- Front bumper: displaced and split lower section requiring replacement and refinish — the main visible repair item.']],
  ['DMZ4614', ['FRONT_WING', 'FRONT_DOOR', 'REAR_DOOR', 'REAR_QUARTER'], [['Front wing', 'replace', 165], ['Front door', 'replace', 330], ['Rear door', 'replace', 310], ['Rear quarter panel', 'replace', 400], ['Front bumper', 'inspect', 0], ['Sill', 'inspect', 0], ['Side skirt', 'inspect', 0], ['Side structure', 'inspect', 0], ['Front structure', 'inspect', 0], ['Radiator pack', 'inspect', 0]],
    '- Front and rear doors: both door shells are creased and folded along the full impact line and read as replacement panels, driving both parts and paint labour.\n- Structural sill/skirt zone: the impact runs low through the sill line — repair vs replace here swings materially on what inspection finds behind the trim.',
    ['- Structural sill/skirt zone: the impact runs low through the sill line — repair vs replace here swings materially on what inspection finds behind the trim.']],
  ['EN23NJX', ['REAR_QUARTER', 'WHEEL_ARCH_MOULDING'], [['Rear quarter panel', 'repair', 0], ['Wheel arch moulding', 'replace', 50], ['Front door', 'inspect', 0], ['Boot lid', 'inspect', 0], ['Slam panel', 'inspect', 0], ['Sill', 'inspect', 0], ['Rear bumper', 'inspect', 0], ['HV battery', 'inspect', 0]],
    '- Rear quarter panel: creased and scuffed body panel requiring repair and blend into adjacent panels — main paint-labour driver.\n- Rear bumper: dished trailing corner, replace and refinish.\n- Structural sill: outer sill scuffing sits over the rocker line, so proper repair may require more than cosmetic refinish.',
    ['- Rear bumper: dished trailing corner, replace and refinish.', '- Structural sill: outer sill scuffing sits over the rocker line, so proper repair may require more than cosmetic refinish.']],
  ['FE68AOP', ['REAR_BUMPER', 'REAR_QUARTER', 'REAR_DOOR', 'REAR_STRUCTURE', 'FOG_LAMP'], [['Rear bumper', 'replace', 185], ['Rear quarter panel', 'replace', 320], ['Rear door', 'repair', 0], ['Rear structure', 'jig/geometry', 500], ['Rear fog lamp', 'replace', 50], ['Front bumper', 'inspect', 0], ['Sill', 'inspect', 0], ['Radiator pack', 'inspect', 0], ['Front door', 'inspect', 0], ['Rear lamp', 'inspect', 0]],
    '- Rear bumper: torn off and absent — full replacement plus refinish and refit.\n- Rear quarter: creased/scuffed at the rear corner — repair and blend into surrounding panels.\n- Rear lamp: displaced/damaged in the impact zone — replacement of the cluster.',
    ['- Rear lamp: displaced/damaged in the impact zone — replacement of the cluster.']],
];
for (const [name, charged, cards, kcd, want] of cases) {
  const a = lot(charged, cards, kcd, '');
  const r = scrubFlooredProse(a);
  const kept = kcd.split('\n').filter((l) => !want.includes(l)).join('\n');
  ok(`(${name}) dropped exactly ${JSON.stringify(want.map((w) => w.slice(2, 30)))}`, JSON.stringify(r.kcdDropped) === JSON.stringify(want));
  ok(`(${name}) the kept bullets are byte-identical`, a['Key Cost Drivers'] === kept);
}

console.log(`\nbatch188: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
