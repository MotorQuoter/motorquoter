// validate-batch183.mjs — batch 183: probe-floor wording (P1), the single-MINOR line (P2) and cost claims about uncharged
// panels in prose (P3). £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch183.mjs
import { attribFlagWording, ATTRIB_MINOR_COSMETIC_WORDING } from '@/app/api/salvage/assess/route.js';
import { readFileSync } from 'fs';
import {
  discloseSplitVoteUncosted, SPLIT_VOTE_REASON, SINGLE_MINOR_REASON, seedChecklistFromFlags,
  unbindUnchargedCostClaims, COST_CLAIM_UNCHARGED_SENTENCE, addProseDamageInspection, PROSE_DAMAGE_UNCOSTED_REASON,
} from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

console.log('\n-- P1: probe-floor wording for minor-cosmetic says "may show slight damage" --');
{
  const W = 'The photos may show slight damage to the Front wing — not included in the repair total; check it on inspection.';
  ok('the wording, verbatim', ATTRIB_MINOR_COSMETIC_WORDING('Front wing') === W);
  ok('attribFlagWording routes minor-cosmetic to it', attribFlagWording('Front wing', 'MODERATE', false, 'minor-cosmetic') === W);
  ok('it no longer asserts damage ("show minor damage")', !/show minor damage/.test(W));
  ok('other verdicts keep their wording', attribFlagWording('Front wing', 'SEVERE', false, 'no-damage-visible').startsWith('Serious damage to the Front wing was recorded'));
}

console.log('\n-- P2: the single-MINOR line ends "before bidding" again --');
{
  const L = 'One photo shows possible minor marking on the Rear door — not costed; check it on inspection before bidding.';
  ok('the wording, verbatim', SINGLE_MINOR_REASON('Rear door') === L);
  const single = [{ panelId: 'REAR_DOOR', partName: 'Rear door', weight: 'low', reason: 'x', _amalgSingleMinor: true }];
  discloseSplitVoteUncosted({ pvVotes: { REAR_DOOR: { damaged: 1, clean: 1 } }, gatedParts: [], flags: single, display: { REAR_DOOR: 'Rear door' } });
  ok('(SF69YBB rear door, one MINOR vote) the flag carries the line', single[0].reason === L);
  ok('the checklist carries the same line', seedChecklistFromFlags('1. x', single).includes(`2. ${L}`));
  ok('other split votes keep "Photographs disagree"', SPLIT_VOTE_REASON('Bonnet').startsWith('Photographs disagree on the Bonnet'));
}

console.log('\n-- P3: a prose sentence may not claim a ledger line that does not exist --');
{
  const EN_IN = 'I chose mid-high. The repair is driven by the rear quarter blend, the rear bumper replacement and the sill work per the Parts Breakdown. The margin picture depends on the sill.';
  const EN = unbindUnchargedCostClaims(EN_IN, new Set(['REAR_QUARTER', 'WHEEL_ARCH_MOULDING']));
  ok('(EN23NJX) phrase removed, sentence kept, one code-owned sentence appended — verbatim',
    EN.text === 'I chose mid-high. The repair is driven by the rear quarter blend, the rear bumper replacement and the sill work. Not in the repair total: the rear bumper and the sill — check them on inspection. The margin picture depends on the sill.');
  ok('(EN23NJX) records the rear bumper and sill as uncharged, in sentence order', JSON.stringify(EN.hits[0].panels.map((p) => [p.panelId, p.charged])) === '[["REAR_BUMPER",false],["SILL",false]]');

  const DL_IN = 'The itemised repair is light — front bumper replacement and refinish plus an arch trim item, per the Parts Breakdown. The margin table below is computed from the Parts Breakdown and the band position.';
  const DL = unbindUnchargedCostClaims(DL_IN, new Set(['WHEEL_ARCH_MOULDING']));
  ok('(DL72FVX) phrase and its comma removed; the front bumper named — verbatim',
    DL.text === 'The itemised repair is light — front bumper replacement and refinish plus an arch trim item. Not in the repair total: the front bumper — check it on inspection. The margin table below is computed from the Parts Breakdown and the band position.');
  ok('(DL72FVX) "arch trim item" names no panel (the Wheel arch moulding row is charged anyway) → only the bumper', DL.hits.length === 1 && DL.hits[0].panels.length === 1);
  ok('"computed from the Parts Breakdown" (the margin table) is not a cost reference', DL.text.endsWith('computed from the Parts Breakdown and the band position.'));

  const SA = 'The repair is a front-end rebuild — radiator pack, bonnet, slam panel, wing, lamp and bumper assembly, per the Parts Breakdown — with the swing being whether the front structure is straight.';
  ok('every named panel charged → untouched, phrase kept (SA26KVT)', unbindUnchargedCostClaims(SA, new Set(['RADIATOR_PACK', 'BONNET', 'SLAM_PANEL'])).text === SA);
  const UR = 'A contained repair — bolt-on panels, cooling pack, both headlamps and airbag work per the Parts Breakdown, with the front structure and non-run cause as the open swing items.';
  ok('a panel named AFTER the phrase is not claimed by it (URZ7545 shape, front structure uncharged)', unbindUnchargedCostClaims(UR, new Set()).hits.length === 0);
  const NEG = 'The repair excludes the bonnet, per the Parts Breakdown.';
  ok('a negated span claims nothing', unbindUnchargedCostClaims(NEG, new Set()).text === NEG);
  ok('no phrase → untouched', unbindUnchargedCostClaims('The rear bumper is replaced.', new Set()).hits.length === 0);
  ok('three panels → "the X, the Y and the Z — check them"', COST_CLAIM_UNCHARGED_SENTENCE(['Bonnet', 'Front wing', 'Headlamp']) === 'Not in the repair total: the bonnet, the front wing and the headlamp — check them on inspection.');
  ok('a leading acronym keeps its capitals', COST_CLAIM_UNCHARGED_SENTENCE(['SRS airbag (deployed)']) === 'Not in the repair total: the SRS airbag (deployed) — check it on inspection.');
  ok('a bulleted line is rewritten in place', unbindUnchargedCostClaims('- Rear bumper replacement per the Parts Breakdown.\n- Other.', new Set()).text === '- Rear bumper replacement. Not in the repair total: the rear bumper — check it on inspection.\n- Other.');

  // inspection list: an existing flag stands, no duplicate; otherwise the batch 175 line, once.
  const withFlag = { _flaggedParts: [{ panelId: 'REAR_BUMPER', partName: 'Rear bumper', weight: 'medium', reason: 'x' }], 'WhatsApp Inspection Checklist': '1. a' };
  addProseDamageInspection(withFlag, [{ panel: 'Rear bumper', panelId: 'REAR_BUMPER', sentence: 's', _costClaim: true }]);
  ok('existing flag stands, no new flag or checklist line', withFlag._flaggedParts.length === 1 && withFlag['WhatsApp Inspection Checklist'] === '1. a');
  const bare = { _flaggedParts: [], 'WhatsApp Inspection Checklist': '1. a' };
  addProseDamageInspection(bare, [{ panel: 'Sill', panelId: 'SILL', sentence: 's', _costClaim: true }, { panel: 'Sill', panelId: 'SILL', sentence: 't' }]);
  ok('no flag → the batch 175 line, once (flag + checklist)', bare._flaggedParts.length === 1 && bare._flaggedParts[0].reason === PROSE_DAMAGE_UNCOSTED_REASON('Sill') && bare['WhatsApp Inspection Checklist'] === `1. a\n2. ${PROSE_DAMAGE_UNCOSTED_REASON('Sill')}`);

  const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
  ok('route: runs on every bound surface against the one charged-row set', route.includes('const _cc = unbindUnchargedCostClaims(text, _chargedIds);') && route.includes('const _chargedIds = new Set(gatedParts.filter(isChargedRow)'));
  ok('route: uncharged panels go to the inspection list; stamp always', route.includes("_proseDamage.push({ panel: pn.name, panelId: pn.panelId, surface: field, sentence: h.after, _costClaim: true })") && route.includes('assessment._costClaimUncharged = [];'));
}

console.log(`\nbatch183: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
