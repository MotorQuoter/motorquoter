// Validator — batch 253 A1: a disputed STRUCTURE panel is always shown (flags, checklist, card) with the one disputed
// sentence; every other flag the 4f disagree filter hides is not shown as a £0 card either. £0.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch253-a1.mjs
import { readFileSync } from 'node:fs';
import { keptByDisagreeFilter, isDisputedStructureFlag, buildBuyerFlags, seedChecklistFromFlags } from '../lib/parts.mjs';
import { buildDamageCards } from '../lib/damageCards.mjs';
import { disputedUncostedLine } from '../lib/disputedWording.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const _log = console.log; const silently = (fn) => { console.log = () => {}; try { return fn(); } finally { console.log = _log; } };

const FS = disputedUncostedLine('Front structure', 'FRONT_STRUCTURE');
const fsFlag = () => ({ panelId: 'FRONT_STRUCTURE', partName: 'Front structure', zone: 'front', weight: 'medium', reason: FS, _amalgDisagree: true, _disputedLine: true });
const wheel = () => ({ panelId: 'DISPLACED_WHEEL', partName: 'Displaced wheel', zone: 'front', weight: 'medium', reason: disputedUncostedLine('Displaced wheel', 'DISPLACED_WHEEL'), _amalgDisagree: true });
const other = () => ({ panelId: 'OTHER', partName: 'Unidentified part — see photos', zone: 'front', weight: 'high', reason: disputedUncostedLine('Unidentified part — see photos', 'OTHER'), _amalgDisagree: true });
const preGate = [{ panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', used: 200 }];
const ids = new Set(['FRONT_BUMPER']);

console.log('\nThe predicate');
ok('a disputed FRONT/REAR/SIDE structure is exempt', ['FRONT_STRUCTURE', 'REAR_STRUCTURE', 'SIDE_STRUCTURE'].every(p => keptByDisagreeFilter({ panelId: p, _amalgDisagree: true }, ids)));
ok('isDisputedStructureFlag needs the disagree mark', isDisputedStructureFlag(fsFlag()) && !isDisputedStructureFlag({ panelId: 'FRONT_STRUCTURE', _amalgNotVisible: true }));
ok('a disputed displaced wheel / unnamed OTHER not in _preGateParts is hidden', !keptByDisagreeFilter(wheel(), ids) && !keptByDisagreeFilter(other(), ids));
ok('the ruled exemptions still hold (Q4, split vote, M1, implicated panel)',
  keptByDisagreeFilter({ panelId: 'REAR_QUARTER', _amalgDisagree: true, _q4Declined: true }, ids)
  && keptByDisagreeFilter({ panelId: 'BONNET', _amalgDisagree: true, _splitVoteUncosted: true }, ids)
  && keptByDisagreeFilter({ panelId: 'BONNET', _amalgDisagree: true, _m1CostedDisputed: true }, ids)
  && keptByDisagreeFilter({ panelId: 'FRONT_BUMPER', _amalgDisagree: true }, ids));
ok('empty / absent _preGateParts → fail open (keep), as before', keptByDisagreeFilter(wheel(), new Set()) && keptByDisagreeFilter(wheel(), null));

console.log('\nKT73YAJ shape: the disputed front structure in all three surfaces');
{
  const a = { _flaggedParts: [fsFlag(), wheel()], _preGateParts: preGate };
  const flags = silently(() => buildBuyerFlags(a));
  ok('Inspection Flags: the front structure, with the one sentence', flags.some(f => f.panelId === 'FRONT_STRUCTURE' && f.reason === FS));
  ok('Inspection Flags: the displaced wheel stays hidden', !flags.some(f => f.panelId === 'DISPLACED_WHEEL'));
  // the model's own checklist already mentions the chassis (the concept-map de-dupe used to swallow the structure)
  const cl = silently(() => seedChecklistFromFlags('1. Show the underside from the front: the subframe, the chassis leg behind the damaged front corner.', flags, {}));
  ok('Checklist: the one sentence, even when the model\'s item names the chassis', cl.includes(`2. ${FS}`));
  ok('Checklist: never seeded twice', silently(() => seedChecklistFromFlags(cl, flags, {})).split(FS).length - 1 === 1);
  const cards = buildDamageCards({ gatedParts: [], flaggedParts: [fsFlag(), wheel(), other()], preGateParts: preGate });
  ok('Card: the front structure, with the one sentence', cards.some(c => c.part === 'Front structure' && c.note === FS));
  ok('Card: no £0 card for a flag the filter hides (displaced wheel, unnamed OTHER)', !cards.some(c => c.part === 'Displaced wheel' || /Unidentified/.test(c.part || '')));
  const legacy = buildDamageCards({ gatedParts: [], flaggedParts: [wheel()] });
  ok('Cards without preGateParts (older callers) are unchanged', legacy.some(c => c.part === 'Displaced wheel'));
}

console.log('\nRoute');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
ok('the route passes _preGateParts to the cards (set before them)', /preGateParts:\s+assessment\._preGateParts/.test(route)
  && route.indexOf('assessment._preGateParts    = reconciledParts;') < route.indexOf('const _cards = buildDamageCards('));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
