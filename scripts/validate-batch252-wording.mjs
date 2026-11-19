// Validator — batch 252 D1/D3: one sentence for an uncosted disputed panel; "Other" never reaches the buyer as a name.
// £0: pure functions + source pins. Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch252-wording.mjs
import { readFileSync } from 'node:fs';
import { disputedUncostedLine, isUnnamedPart, UNNAMED_PART_NAME } from '../lib/disputedWording.mjs';
import {
  SPLIT_VOTE_REASON, discloseSplitVoteUncosted, seedChecklistFromFlags, rewordDisputedFlags, reconcileFlagMoneyWording,
  PROSE_DAMAGE_UNCOSTED_REASON, addProseDamageInspection, OTHER_FALLBACK_NAME, SINGLE_MINOR_REASON,
} from '../lib/parts.mjs';
import { promoteFlaggedQuarter, Q4_DECLINED_REASON, Q4_DECLINED_CHECKLIST_ITEM } from '../lib/labour.mjs';

let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const quiet = () => {}; const _log = console.log;
const silently = (fn) => { console.log = quiet; try { return fn(); } finally { console.log = _log; } };

const NAMED = 'Photos disagree on the front wing: some show damage, some do not. It is not in the repair total. Check it on inspection before bidding.';
const UNNAMED = 'Photos disagree on a part we could not name. It is not in the repair total. Check the damaged area on inspection before bidding.';

console.log('\nD1. The one owner');
assert('named form, verbatim (name lower-cased mid-sentence)', disputedUncostedLine('Front wing', 'FRONT_WING'), NAMED);
assert('unnamed form, verbatim (OTHER with no word)', disputedUncostedLine(UNNAMED_PART_NAME, 'OTHER'), UNNAMED);
assert('the bare word "Other" is unnamed', disputedUncostedLine('Other', 'OTHER'), UNNAMED);
assert('an OTHER the model named ("Underside") keeps its name', disputedUncostedLine('Underside', 'OTHER'), NAMED.replace('front wing', 'underside'));
assert('an acronym lead is kept ("SRS airbag")', disputedUncostedLine('SRS airbag', 'AIRBAG').startsWith('Photos disagree on the SRS airbag:'), true);
ok('capital first letter, no dash, Latin-1 (the PDF flag path prints without dash mapping)', [NAMED, UNNAMED].every(s => /^[A-Z]/.test(s) && !/[—–-]/.test(s) && !/[^\x00-\xFF]/.test(s)));
ok('OTHER_FALLBACK_NAME has one owner', OTHER_FALLBACK_NAME === UNNAMED_PART_NAME && isUnnamedPart(OTHER_FALLBACK_NAME, 'OTHER'));

console.log('\nF1 (split vote, A1)');
assert('SPLIT_VOTE_REASON is the owner', SPLIT_VOTE_REASON('Front wing', 'FRONT_WING'), NAMED);
{
  const flags = [{ panelId: 'FRONT_WING', partName: 'Front wing', reason: 'x', _amalgDisagree: true }];
  silently(() => discloseSplitVoteUncosted({ pvVotes: { FRONT_WING: { damaged: 1, clean: 1 } }, gatedParts: [], flags, display: { FRONT_WING: 'Front wing' } }));
  assert('A1 writes it on the flag', flags[0].reason, NAMED);
  const cl = silently(() => seedChecklistFromFlags('1. x', flags, {}));
  ok('and the checklist line is the same sentence', cl.includes(`2. ${NAMED}`));
  const minor = [{ panelId: 'FRONT_WING', partName: 'Front wing', reason: 'x', _amalgSingleMinor: true }];
  silently(() => discloseSplitVoteUncosted({ pvVotes: { FRONT_WING: { damaged: 1, clean: 1 } }, gatedParts: [], flags: minor, display: { FRONT_WING: 'Front wing' } }));
  assert('single-MINOR keeps its own line (a different state)', minor[0].reason, SINGLE_MINOR_REASON('Front wing'));
}

console.log('\nF2/F2c (Q4-declined quarter)');
{
  const q = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', reason: 'x', _amalgDisagree: true };
  silently(() => promoteFlaggedQuarter({ gatedParts: [], flaggedParts: [q], costedIds: new Set(), sevByPanel: new Map(), zoneByPanel: new Map(), entry: { oem: 500, used: 275 }, name: 'Rear quarter panel', pvVotes: { REAR_QUARTER: { damaged: 1, clean: 2 } } }));
  assert('Q4 declines → the flag reads the one sentence', [q._q4Declined, q.reason], [true, NAMED.replace('front wing', 'rear quarter panel')]);
  const cl = silently(() => seedChecklistFromFlags('1. x', [q], {}));
  ok('the checklist line is the flag sentence, once', cl.split(q.reason).length - 1 === 1 && !cl.includes('Show rear quarter close-up'));
  ok('the exported Q4 constants are that sentence', Q4_DECLINED_REASON === q.reason && Q4_DECLINED_CHECKLIST_ITEM === q.reason);
}

console.log('\nF3/F3c (the raw amalgamation flag) — one late pass');
{
  const RAW = 'the listing photographs disagree on this part — it looks undamaged in at least one photo and damaged in another; condition unconfirmed; ask for it on the WhatsApp inspection before bidding';
  const f1 = { panelId: 'DISPLACED_WHEEL', partName: 'Displaced wheel', reason: RAW, _amalgDisagree: true };
  const f2 = { panelId: 'OTHER', partName: UNNAMED_PART_NAME, reason: RAW, _amalgDisagree: true };
  const ap = { panelId: 'FRONT_WING', partName: 'Front wing', reason: 'aperture words', _amalgDisagree: true, _amalgAperture: true };
  const done = rewordDisputedFlags([[f1, f2, ap], [f1]]);
  assert('named → named form; unnamed OTHER → unnamed form; each flag once', [f1.reason, f2.reason, done.length], [NAMED.replace('front wing', 'displaced wheel'), UNNAMED, 2]);
  assert('an aperture flag keeps its own words (a different state)', ap.reason, 'aperture words');
  const cl = silently(() => seedChecklistFromFlags('1. x', [{ panelId: 'SILL', partName: 'Sill', reason: RAW, _amalgDisagree: true }], {}));
  ok('F3c: the checklist seed for a surviving disagree flag is the sentence too', cl.includes(NAMED.replace('front wing', 'sill')) && !/listing photographs disagree/.test(cl));
}

console.log('\nNO_COST_CLAIM: a COSTED disputed panel (SA26KVT windscreen shape)');
{
  const RAW = 'the listing photographs disagree on this part — it looks undamaged in at least one photo and damaged in another; condition unconfirmed; ask for it on the WhatsApp inspection before bidding';
  const w = { panelId: 'WINDSCREEN', partName: 'Windscreen', reason: RAW, _amalgDisagree: true };
  rewordDisputedFlags([[w]]);
  const r = reconcileFlagMoneyWording([w], [{ panelId: 'WINDSCREEN', action: 'replace', used: 300, oem: 450 }]);
  assert('the false "not in the repair total" clause is caught and replaced by the strike tail',
    [r.length, w.reason], [1, 'Photos disagree on the windscreen: some show damage, some do not. It has been included in the repair total on the visible evidence — strike the line on the ledger if the inspection shows it sound.']);
  const u = { panelId: 'BONNET', partName: 'Bonnet', reason: NAMED.replace('front wing', 'bonnet') };
  assert('an UNCOSTED panel keeps its line (no money, no rewrite)', reconcileFlagMoneyWording([u], []).length, 0);
}

console.log('\nD3. "Other" never reaches the buyer as a name');
assert('prose flag on OTHER → unnamed wording', PROSE_DAMAGE_UNCOSTED_REASON('Other', 'OTHER'), 'The report describes damage to a part we could not name that is not in the repair total — check it on inspection and add it to the ledger if confirmed.');
assert('a named panel keeps the batch 175 line', PROSE_DAMAGE_UNCOSTED_REASON('Windscreen'), 'The report describes damage to the Windscreen that is not in the repair total — check it on inspection and add it to the ledger if confirmed.');
{
  const a = { _flaggedParts: [], _preGateParts: [], 'WhatsApp Inspection Checklist': '1. x' };
  silently(() => addProseDamageInspection(a, [{ panelId: 'OTHER', panel: 'Other', sentence: 's' }]));
  const f = a._flaggedParts[0];
  ok('the flag is named with the unnamed-part name, never "Other"', f.partName === UNNAMED_PART_NAME && !/\bOther\b/.test(f.reason) && !/the Other\b/.test(a['WhatsApp Inspection Checklist']));
}

console.log('\nSource pins');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
ok('route: the late pass runs before reconcileFlagMoneyWording',
  route.indexOf('rewordDisputedFlags([assessment._flaggedParts, coreObs.flaggedParts])') > 0 &&
  route.indexOf('rewordDisputedFlags([assessment._flaggedParts, coreObs.flaggedParts])') < route.indexOf('const _z2 = reconcileFlagMoneyWording(') &&
  route.indexOf('const _q4 = promoteFlaggedQuarter(') < route.indexOf('rewordDisputedFlags([assessment._flaggedParts'));
const parts = readFileSync('lib/parts.mjs', 'utf8'), labour = readFileSync('lib/labour.mjs', 'utf8');
ok('no old disputed sentence left as a buyer string in lib', !/`Photographs disagree on the/.test(parts) && !/'The photos disagree on this panel/.test(labour) && !/the listing photographs disagree on this part; condition unconfirmed/.test(parts));
ok('NO_COST_CLAIM knows the new clause', /not in the repair total/.test(parts.match(/const NO_COST_CLAIM = (.*);/)?.[1] || ''));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
