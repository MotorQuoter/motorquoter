// validate-batch182.mjs — batch 182: probe-floor wording (P2) and the single-MINOR line (P3). £0, pure, no model calls.
// P1 (the unanimous-damaged probe guard) is HELD — it made 3 clean-labelled panels phantoms — so nothing here asserts it,
// except that r2SevereKeep is unchanged.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch182.mjs
import { readFileSync, existsSync } from 'fs';
import { attribFlagWording, ATTRIB_MINOR_COSMETIC_WORDING, r2SevereKeep } from '@/app/api/salvage/assess/route.js';
import { discloseSplitVoteUncosted, SPLIT_VOTE_REASON, SINGLE_MINOR_REASON, seedChecklistFromFlags } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const RUN2_PATH = new URL('../_cc/scratch/b181/row-c870efcb.json', import.meta.url);
const RUN2 = existsSync(RUN2_PATH) ? JSON.parse(readFileSync(RUN2_PATH, 'utf8')).assessment : null;

console.log('\n-- P1 (HELD): the probe guard is unchanged --');
{
  ok('two MODERATE, none clean → NOT kept (the widened limb is not built)', r2SevereKeep([{ view: 0, iv: 'true', sev: 'MODERATE' }, { view: 14, iv: 'true', sev: 'MODERATE' }]) === false);
  ok('the batch 163 limb still holds: two SEVERE, none clean → kept', r2SevereKeep([{ iv: 'true', sev: 'SEVERE' }, { iv: 'true', sev: 'SEVERE' }]) === true);
}

console.log('\n-- P2: probe-floor wording for minor-cosmetic --');
{
  const W = 'The photos show minor damage to the Front door — not included in the repair total; check it on inspection.';
  ok('the wording, verbatim', ATTRIB_MINOR_COSMETIC_WORDING('Front door') === W);
  ok('attribFlagWording routes minor-cosmetic to it', attribFlagWording('Front door', 'MODERATE', false, 'minor-cosmetic') === W);
  ok('never "at most light marking"', !/at most light marking/.test(W));
  ok('other verdicts keep their wording', attribFlagWording('Front wing', 'SEVERE', false, 'no-damage-visible').startsWith('Serious damage to the Front wing was recorded'));
  if (RUN2) {
    const f = RUN2._flaggedParts.find((x) => x.panelId === 'FRONT_DOOR');
    ok('(SV24YCN run 2) the stored door flag carried the old wording (the case)', /at most light marking on the Front door/.test(f?.reason || ''));
    ok('(SV24YCN run 2) the probe verdict was minor-cosmetic → now "minor damage to the Front door"', RUN2._attributionProbe.panels.find((p) => p.panelId === 'FRONT_DOOR')?.verdict === 'minor-cosmetic' && attribFlagWording('Front door', 'MODERATE', false, 'minor-cosmetic') === W);
  }
}

console.log('\n-- P3: a single unsupported MINOR vote is not "Photographs disagree" --');
{
  const L = 'One photo shows possible minor marking on the Rear bumper — not costed; check it on inspection.';
  ok('the wording, verbatim', SINGLE_MINOR_REASON('Rear bumper') === L);
  const single = [{ panelId: 'REAR_BUMPER', partName: 'Rear bumper', weight: 'low', reason: 'x', _amalgSingleMinor: true }];
  discloseSplitVoteUncosted({ pvVotes: { REAR_BUMPER: { damaged: 1, clean: 1 } }, gatedParts: [], flags: single, display: { REAR_BUMPER: 'Rear bumper' } });
  ok('a single-MINOR flag gets its own line, not "Photographs disagree"', single[0].reason === L && single[0]._splitVoteUncosted === true);
  const other = [{ panelId: 'BONNET', partName: 'Bonnet', weight: 'medium', reason: 'x', _amalgDisagree: true }];
  discloseSplitVoteUncosted({ pvVotes: { BONNET: { damaged: 2, clean: 1 } }, gatedParts: [], flags: other, display: { BONNET: 'Bonnet' } });
  ok('any other split vote keeps "Photographs disagree"', other[0].reason === SPLIT_VOTE_REASON('Bonnet'));
  ok('the checklist says the single-MINOR line, verbatim', seedChecklistFromFlags('1. x', single).includes(`2. ${L}`) && !seedChecklistFromFlags('1. x', single).includes('Photographs disagree'));
  ok('the checklist still says "Photographs disagree" for a real split', seedChecklistFromFlags('1. x', [{ ...other[0], _splitVoteUncosted: true }]).includes(SPLIT_VOTE_REASON('Bonnet')));
  if (RUN2) {
    const f = RUN2._flaggedParts.find((x) => x.panelId === 'REAR_BUMPER');
    ok('(SV24YCN run 2) the stored rear-bumper flag is _amalgSingleMinor and said "Photographs disagree" (the case)', f?._amalgSingleMinor === true && /^Photographs disagree on the Rear bumper/.test(f.reason));
    const g = [{ ...f }];
    discloseSplitVoteUncosted({ pvVotes: { REAR_BUMPER: RUN2._pvVotes.REAR_BUMPER }, gatedParts: RUN2._reconciledParts, flags: g, display: { REAR_BUMPER: 'Rear bumper' } });
    ok('(SV24YCN run 2) now reads the single-MINOR line', g[0].reason === L);
  }
}

console.log(`\nbatch182: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
