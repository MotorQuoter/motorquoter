// validate-batch165.mjs — batch 165 items 1 and 2 (and item 3's log string). £0, pure, no model calls.
//
//   1  a panel the body-class gate removes (REAR_QUARTER on a pickup) never comes back: no ledger row, no
//      Inspection Flag, no checklist line, whatever later step would add it. ONE owner (stripBodyIneligible),
//      applied at ONE point in route.js that sits after every adder and before every reader.
//   2  an aperture panel (_amalgAperture) gets ONE wording on the checklist: the flag's own bumper-displaced
//      reason. A1's "Photographs disagree…" sentence is not re-derived for it. Q4 keeps its line.
//   3  the amalgamate disagree log no longer says COST.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch165.mjs
import { readFileSync } from 'fs';
import { PANEL_DISPLAY } from '../lib/panelEnum.mjs';
import {
  discloseSplitVoteUncosted, SPLIT_VOTE_REASON, buildBuyerFlags, seedChecklistFromFlags, stripBodyIneligible,
} from '../lib/parts.mjs';
import { promoteFlaggedQuarter, Q4_DECLINED_REASON, Q4_DECLINED_CHECKLIST_ITEM } from '../lib/labour.mjs';
import { ELIGIBLE_PANELS } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const PICKUP = ELIGIBLE_PANELS.pickup;
const APERTURE_WING = 'Front bumper displaced on this corner; the wing behind it cannot be reliably assessed from the listing photos.';

// ── item 1 ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- item 1: a panel removed for the body type never comes back --');
ok('the corpus premise holds: a pickup cannot carry a REAR_QUARTER, and can carry BED_SIDE_L/R', !!PICKUP
  && !PICKUP.has('REAR_QUARTER') && PICKUP.has('BED_SIDE_L') && PICKUP.has('BED_SIDE_R'));

// AK75RDX's shape (batch 164): the model wrote a £470 quarter row, amalgamate pushed a disagree flag and verdict,
// and the vote is a split. Here the vote WINS (2 damaged / 1 clean), so without the strip Q4 would COST it.
function ak75() {
  const gatedParts = [
    { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 480, used: 220 },
    { panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', oem: 850, used: 470, _disagreeCosted: true },
    { panelId: 'SRS_AIRBAG', name: 'SRS airbag kit', action: 'replace', oem: null, used: 500 },
    { name: 'Labour & paint', action: '—', oem: 1900, used: null },
  ];
  const coreFlags = [
    { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'flank-damaged-side', weight: 'medium', reason: 'x', _amalgDisagree: true },
    { panelId: 'BED_SIDE_R', partName: 'Bed side (right)', zone: 'flank-damaged-side', weight: 'medium', reason: 'bed side flag', _amalgNotVisible: true },
    { panelId: null, partName: 'Coachbuilt body — out of model', zone: 'rear', weight: 'high', reason: 'free text' },
  ];
  const costedParts = [
    { panelId: 'FRONT_BUMPER', independentlyVisible: true },
    { panelId: 'REAR_QUARTER', independentlyVisible: false, _amalgDisagree: true, _ledgerSeverity: 'SEVERE' },
  ];
  const pvVotes = { REAR_QUARTER: { views: 4, resolving: 3, damaged: 2, clean: 1, notVisible: 0, branch: 'disagree', severeVotes: 1 } };
  return { gatedParts, coreFlags, costedParts, pvVotes };
}
{
  const { gatedParts, coreFlags, costedParts, pvVotes } = ak75();
  // Route order: A1 runs first and may disclose the quarter …
  gatedParts.splice(1, 1);   // the worst case: the model row is already gone, so A1 ADDS a flag from the votes
  coreFlags.splice(0, 1);
  const a1 = discloseSplitVoteUncosted({ pvVotes, gatedParts, flags: coreFlags, display: PANEL_DISPLAY });
  ok('(premise) A1 by itself re-adds a flag for the stripped quarter from the votes', a1.some(x => x.panelId === 'REAR_QUARTER' && x.action === 'added'));
  // … the §2 invariant would re-add from the verdict, completeness pushes onto the snapshot …
  const snapshot = [...coreFlags, { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: 'completeness', _completeness: true }];
  // … then the ONE point.
  const s = stripBodyIneligible({ eligible: PICKUP, gatedParts, flagLists: [coreFlags, snapshot], costedParts });
  ok('the strip reports the quarter in flags and verdicts', s.flags.includes('REAR_QUARTER') && s.verdicts.includes('REAR_QUARTER'));
  ok('no quarter left in coreObs.flaggedParts', !coreFlags.some(f => f.panelId === 'REAR_QUARTER'));
  ok('no quarter left in assessment._flaggedParts (snapshot + completeness push)', !snapshot.some(f => f.panelId === 'REAR_QUARTER'));
  ok('no quarter verdict left for the §2 invariant or the damage cards', !costedParts.some(c => c.panelId === 'REAR_QUARTER'));
  ok('the bed-side flag is untouched', coreFlags.some(f => f.panelId === 'BED_SIDE_R') && snapshot.some(f => f.panelId === 'BED_SIDE_R'));
  ok('a null-panelId flag is untouched', coreFlags.some(f => f.panelId === null));
  ok('the SRS_AIRBAG sentinel row and the labour row survive', gatedParts.some(r => r.panelId === 'SRS_AIRBAG') && gatedParts.some(r => /Labour/.test(r.name)));
  // Q4 runs below the point, on a WINNING vote — it must find nothing to promote.
  const costedIds = new Set(gatedParts.filter(p => p.panelId).map(p => p.panelId));
  const q4 = promoteFlaggedQuarter({ gatedParts, flaggedParts: coreFlags, costedIds, sevByPanel: new Map(), zoneByPanel: new Map(),
    entry: { oem: 850, used: 470 }, name: 'Rear quarter panel', pvVotes });
  ok('Q4 promotes nothing and declines nothing — it never sees the quarter', q4 === null);
  ok('no quarter row in the ledger', !gatedParts.some(r => r.panelId === 'REAR_QUARTER'));
  const a = { _flaggedParts: snapshot, _preGateParts: [{ panelId: 'REAR_QUARTER' }, { panelId: 'FRONT_BUMPER' }] };
  const buyer = buildBuyerFlags(a);
  ok('buildBuyerFlags (screen + PDF) carries no quarter', !buyer.some(f => f.panelId === 'REAR_QUARTER'));
  const cl = seedChecklistFromFlags('1. Model line.', buyer);
  ok('the checklist seed writes no quarter line', !/quarter/i.test(cl));
}
{
  // The model row path: row present at A1 time (A1 skips it as costed), then the strip removes row + flag.
  const { gatedParts, coreFlags, costedParts, pvVotes } = ak75();
  discloseSplitVoteUncosted({ pvVotes, gatedParts, flags: coreFlags, display: PANEL_DISPLAY });
  const s = stripBodyIneligible({ eligible: PICKUP, gatedParts, flagLists: [coreFlags], costedParts });
  ok('the model-written quarter row is removed and logged as a row', s.rows.includes('REAR_QUARTER') && !gatedParts.some(r => r.panelId === 'REAR_QUARTER'));
  ok('its flag is removed too', !coreFlags.some(f => f.panelId === 'REAR_QUARTER'));
}
{
  const g = [{ panelId: 'REAR_QUARTER', used: 470 }];
  const s = stripBodyIneligible({ eligible: undefined, gatedParts: g, flagLists: [], costedParts: [] });
  ok('no allow-set (bodyClass null / coachbuilt) → nothing is touched', g.length === 1 && s.rows.length === 0);
}

// ONE point: the call sits after every adder and before every reader, and nowhere else.
{
  const at = (needle) => route.indexOf(needle);
  const strip = at('const _stripped = stripBodyIneligible(');
  const calls = route.split('stripBodyIneligible(').length - 1;
  ok('stripBodyIneligible is called exactly once in route.js', calls === 1);
  ok('the old strip loop at the A1 position is gone', !route.includes('const removed = [];\n      for (let i = gatedParts.length - 1; i >= 0; i--) {\n        const pid = gatedParts[i].panelId;'));
  const upstream = [
    ['158 A1 (discloseSplitVoteUncosted)', 'const _split = discloseSplitVoteUncosted('],
    ['§2 ledger/flag invariant', '// ── §2 LEDGER/FLAG INVARIANT (batch 81)'],
    ['_flaggedParts snapshot', 'assessment._flaggedParts = [...coreObs.flaggedParts]'],
    ['fog rule', 'const fogRule = applyFogBumperRule('],
    ['completeness net', 'const extraFlags = completenessFlagsFor('],
    ['bumper control', "[BUMPER CONTROL] ${end} bumper off but unconfirmed → flagged"],
  ];
  const downstream = [
    ['Q4 (promoteFlaggedQuarter)', 'const _q4 = promoteFlaggedQuarter('],
    ['§11 labour', '// ── §11 CODE-OWNED LABOUR'],
    ['§4 bumper-off limit note', '[BUMPER-OFF §4]'],
    ['the ledger (_reconciledParts)', 'assessment._reconciledParts = gatedParts;'],
    ['damage cards', 'const _cards = buildDamageCards('],
    ['checklist seed (buildBuyerFlags)', 'const buyerFlags = buildBuyerFlags(assessment);'],
  ];
  for (const [n, s] of upstream) ok(`upstream of the point: ${n}`, at(s) > 0 && at(s) < strip);
  for (const [n, s] of downstream) ok(`downstream of the point: ${n}`, at(s) > strip);
}

// ── item 2 ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- item 2: an aperture panel gets one wording --');
{
  // SF69YBB FRONT_WING's final flag shape (batch 164): A1 marked it, then the aperture step overwrote the reason.
  const wing = { panelId: 'FRONT_WING', partName: 'Front wing', zone: 'front', weight: 'medium', reason: APERTURE_WING,
    _amalgDisagree: true, _splitVoteUncosted: true, _amalgAperture: true };
  const door = { panelId: 'FRONT_DOOR', partName: 'Front door', zone: 'flank-damaged-side', weight: 'medium',
    reason: SPLIT_VOTE_REASON('Front door'), _amalgDisagree: true, _splitVoteUncosted: true };
  const quarter = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: Q4_DECLINED_REASON,
    _amalgDisagree: true, _splitVoteUncosted: true, _q4Declined: true };
  const cl = seedChecklistFromFlags('1. Model line about the front wing shut line.', [wing, door, quarter]);
  ok('the wing\'s checklist line is the flag\'s bumper-displaced wording, verbatim', cl.includes(`. ${APERTURE_WING}`));
  ok('no "Photographs disagree on the Front wing" line', !cl.includes('Photographs disagree on the Front wing'));
  ok('a non-aperture split-vote panel keeps A1\'s wording', cl.includes(SPLIT_VOTE_REASON('Front door')));
  ok('a Q4-declined quarter keeps Q4\'s line (batch 132)', cl.includes(Q4_DECLINED_CHECKLIST_ITEM));
  ok('the wing line is added once', cl.split(APERTURE_WING).length - 1 === 1);
  const again = seedChecklistFromFlags(cl, [wing]);
  ok('re-seeding does not double it', again === cl);
}
{
  // A COSTED aperture panel (no _splitVoteUncosted) that reaches the seed's own-line path: the flag's wording,
  // not "the listing photographs disagree on this part".
  const lamp = { panelId: 'HEADLAMP', partName: 'Headlamp unit', zone: 'front', weight: 'medium',
    reason: 'Front bumper displaced on this corner; the headlamp mounting area cannot be reliably assessed from the listing photos.',
    _amalgDisagree: true, _amalgAperture: true };
  const cl = seedChecklistFromFlags('1. Model line.', [lamp]);
  ok('a costed aperture flag seeds its own reason', cl.includes(`. ${lamp.reason}`) && !/listing photographs disagree/.test(cl));
}

// ── item 3 ──────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- item 3: the disagree log no longer says COST --');
ok('old log string gone', !route.includes('→ COST + flag (batch 81 §1; gate no longer strips)'));
ok('new log string present', route.includes('disagree (${damaged} damaged, ${clean} clean) → FLAG, not costed (batch 156; the gate keeps a row only if the model wrote one)'));
ok('the batch 81 comment no longer says the panel STAYS in the ledger costed', !route.includes('The panel STAYS in\n      // the ledger costed at its reconciled/table price'));

console.log(`\nbatch165: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
