// validate-batch183.mjs — batch 183: probe-floor wording (P1), the single-MINOR line (P2) and cost claims about uncharged
// panels in prose (P3). £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch183.mjs
import { attribFlagWording, ATTRIB_MINOR_COSMETIC_WORDING } from '@/app/api/salvage/assess/route.js';
import { discloseSplitVoteUncosted, SPLIT_VOTE_REASON, SINGLE_MINOR_REASON, seedChecklistFromFlags } from '@/lib/parts.mjs';

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

console.log(`\nbatch183: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
