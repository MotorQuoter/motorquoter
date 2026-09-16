// Unit tests for lib/damageCards.mjs — deterministic, no network.
// Run: node scripts/validate-damage-cards.mjs
import { buildDamageCards } from '../lib/damageCards.mjs';
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}
function ok(label, cond) { eq(label, !!cond, true); }

// Representative finalised pipeline arrays.
const gatedParts = [
  { name: 'Front bumper', action: 'replace', used: 160, panelId: 'FRONT_BUMPER' },
  { name: 'Bonnet', action: 'repair', used: 120, panelId: 'BONNET' },
  { name: 'Front headlamp (corner 1)', action: 'replace', used: 150, panelId: 'HEADLAMP', _lampMandated: true, _band: 150 },
  { name: 'Slam panel', action: 'replace', used: 40, panelId: 'SLAM_PANEL', _amalgMissing: true },
  { name: 'Labour & paint', action: 'repair', used: 800 }, // must be skipped
];
const costedParts = [
  { panelId: 'FRONT_BUMPER', partName: 'Front bumper', independentlyVisible: true, _ledgerSeverity: 'SEVERE' },
  { panelId: 'BONNET', partName: 'Bonnet', independentlyVisible: true, _ledgerSeverity: 'MODERATE' },
  { panelId: 'HEADLAMP', partName: 'Front headlamp', independentlyVisible: false },       // precautionary
  { panelId: 'SLAM_PANEL', partName: 'Slam panel', independentlyVisible: true, _amalgMissing: true, _ledgerSeverity: 'SEVERE' },
];
const flaggedParts = [
  { partName: 'Front wing', zone: 'front', weight: 'medium', reason: 'adjacent to impact — not independently confirmed', _gateGenerated: true },
];
const allowanceParts = [
  { name: 'Headlamp', action: 'replace', used: 150, _allowance: true }, // second corner
];

const cards = buildDamageCards({ gatedParts, costedParts, flaggedParts, allowanceParts });

console.log('\n=== Structure ===\n');
eq('labour row skipped → 4 visible + 1 related + 1 inferred = 6 cards', cards.length, 6);
eq('origins in order', cards.map(c => c.origin), ['Visible', 'Visible', 'Visible', 'Visible', 'Related', 'Inferred']);

console.log('\n=== Visible cards ===\n');
const bumper = cards.find(c => c.part === 'Front bumper');
eq('bumper visible/severe/replace/cost', [bumper.origin, bumper.severity, bumper.action, bumper.cost], ['Visible', 'Severe', 'replace', 160]);
const bonnet = cards.find(c => c.part === 'Bonnet');
eq('bonnet moderate/repair', [bonnet.severity, bonnet.action, bonnet.cost], ['Moderate', 'repair', 120]);
eq('no labourHrs field (omitted, not fabricated)', 'labourHrs' in bumper, false);
eq('no damageType value (omitted)', bumper.damageType, null);

console.log('\n=== Lamp-mandated, iv≠true → Visible w/ precaution note, real cost ===\n');
const lamp = cards.find(c => c.part === 'Front headlamp (corner 1)');
eq('lamp visible + real cost', [lamp.origin, lamp.cost], ['Visible', 150]);
ok('lamp precaution note present', /precautionary/i.test(lamp.note));

console.log('\n=== _amalgMissing → Visible w/ not-present note ===\n');
const slam = cards.find(c => c.part === 'Slam panel');
eq('missing part visible + cost + severe', [slam.origin, slam.cost, slam.severity], ['Visible', 40, 'Severe']);
ok('missing note present', /not present/i.test(slam.note));

console.log('\n=== Related (completeness-net flag) → £0, inspect ===\n');
const wing = cards.find(c => c.part === 'Front wing');
eq('related £0 / inspect', [wing.origin, wing.cost, wing.action], ['Related', 0, 'inspect']);
eq('related carries the flag reason', wing.note, 'adjacent to impact — not independently confirmed');

console.log('\n=== Inferred (allowance) → £0, band value in note ===\n');
const allow = cards.find(c => c.origin === 'Inferred');
eq('inferred £0', allow.cost, 0);
ok('inferred notes the band allowance', /Band allowance £150/.test(allow.note));

console.log('\n=== Dedup: a flag matching a visible part is not double-listed ===\n');
const cards2 = buildDamageCards({
  gatedParts: [{ name: 'Front bumper', action: 'replace', used: 160, panelId: 'FRONT_BUMPER' }],
  costedParts: [{ panelId: 'FRONT_BUMPER', independentlyVisible: true, _ledgerSeverity: 'MINOR' }],
  flaggedParts: [{ partName: 'Front bumper', reason: 'dup', _gateGenerated: true }],
  allowanceParts: [],
});
eq('bumper appears once (visible), flag deduped', cards2.length, 1);
eq('surviving card is Visible', cards2[0].origin, 'Visible');

console.log('\n=== Null-safety ===\n');
eq('empty input → []', buildDamageCards({}), []);
eq('no-arg → []', buildDamageCards(), []);

// -- batch 142 R3: ONE AIRBAG CARD ------------------------------------------------------------
// HV25ODX shipped the subject twice in the Damage Breakdown:
//   "SRS airbag kit (deployed) - Visible, replace: from £500"   (the costed row)
//   "SRS airbag (deployed) - Related, inspect: £0"              (the flag)
// The name dedup cannot catch it: norm() strips only the bracket, so "srs airbag kit" never equals
// "srs airbag". Keyed on the MARKERS instead, so the wording can change without breaking the rule.
console.log('\n=== batch 142 R3: one airbag card ===\n');

const SRS_COSTED = { name: 'SRS airbag kit (deployed)', action: 'replace', used: 500, panelId: 'SRS_AIRBAG', _srsFloor: true, _gOwned: true };
const SRS_FLAG   = { panelId: 'AIRBAG', partName: 'SRS airbag (deployed)', zone: 'interior', weight: 'high',
                     reason: 'Airbags deployed - replacement from £500 (kit and fitting)... This must be checked before bidding.',
                     _srsExtentFloor: true };

{
  const cards = buildDamageCards({ gatedParts: [...gatedParts, SRS_COSTED], costedParts, flaggedParts: [SRS_FLAG] });
  const srs = cards.filter((c) => /srs|airbag/i.test(c.part || ''));
  eq('costed SRS present -> exactly ONE airbag card', srs.length, 1);
  eq('the survivor is the COSTED card, not the flag card', srs[0].origin, 'Visible');
  eq('the survivor still renders as a from-figure', srs[0]._fromFigure, true);
  eq('the survivor carries the £500 floor', srs[0].cost, 500);
  ok('no Related airbag card survives', !cards.some((c) => c.origin === 'Related' && /airbag/i.test(c.part || '')));
}

{
  // Deployment DEFERRED (gate open, no confirmation): there is no costed row, so the flag card is the
  // only thing the buyer has. It MUST still show, or the airbag disappears from the Damage Breakdown.
  const cards = buildDamageCards({ gatedParts, costedParts, flaggedParts: [SRS_FLAG] });
  const srs = cards.filter((c) => /srs|airbag/i.test(c.part || ''));
  eq('no costed SRS row -> the flag card DOES show', srs.length, 1);
  eq('and it is the Related card', srs[0].origin, 'Related');
  eq('carrying the flag reason verbatim', srs[0].note, SRS_FLAG.reason);
}

{
  // The suppression is keyed on the marker pair only -- it must not swallow any other flag.
  const OTHER = { panelId: 'SIDE_STRUCTURE', partName: 'Side structure', zone: 'side', weight: 'medium', reason: 'not clear from the listing photographs' };
  const cards = buildDamageCards({ gatedParts: [...gatedParts, SRS_COSTED], costedParts, flaggedParts: [SRS_FLAG, OTHER] });
  ok('an unrelated flag still gets its Related card', cards.some((c) => c.origin === 'Related' && c.part === 'Side structure'));
  eq('exactly one airbag card still', cards.filter((c) => /airbag/i.test(c.part || '')).length, 1);
}

{
  // MONEY DOES NOT MOVE. Related cards are £0 and cards never feed parts_sum, but pin that the costed
  // rows and their figures are identical with and without the suppression.
  const withFlag = buildDamageCards({ gatedParts: [...gatedParts, SRS_COSTED], costedParts, flaggedParts: [SRS_FLAG] }).filter((c) => c.origin === 'Visible');
  const noFlag   = buildDamageCards({ gatedParts: [...gatedParts, SRS_COSTED], costedParts, flaggedParts: [] }).filter((c) => c.origin === 'Visible');
  eq('the Visible (costed) cards are byte-identical either way', JSON.stringify(withFlag), JSON.stringify(noFlag));
}

{
  // The two fog-lamp cards on HV25ODX are NOT this bug: both are COSTED rows -- a genuine pair, like
  // the headlamp pair Vincent re-affirmed in R2. Two costed rows must stay two cards.
  const FOG = (n) => ({ name: 'Front fog lamp', action: 'replace', used: 50, panelId: 'FOG_LAMP', _n: n });
  const cards = buildDamageCards({ gatedParts: [FOG(1), FOG(2)], costedParts: [], flaggedParts: [] });
  eq('a costed PAIR still renders two cards (fog lamps, headlamps)', cards.length, 2);
  ok('both are Visible', cards.every((c) => c.origin === 'Visible' && c.cost === 50));
}


// -- batch 143 T2: an uncostable £0 line is Inspection Flags + checklist ONLY -------------------
// Vincent, 16 Sep: "flags only". The resolving === 0 not-visible branch (route.js) produces
// "Side structure - Related, inspect: £0" in the Damage Breakdown. It is marked here and DROPPED by
// the two renderers. The card is deliberately still BUILT: lib/flooredProseScrub.mjs derives its
// FLOORED panel set from _damageCards, so removing it from the data would silently stop the scrub
// stripping model claims about that panel.
console.log('\n=== batch 143 T2: the uncostable £0 line is marked, not deleted ===\n');

const NV_FLAG = { panelId: 'SIDE_STRUCTURE', partName: 'Side structure', zone: 'side', weight: 'medium',
                  reason: 'not clear from the listing photographs - condition unconfirmed; ask for it on the WhatsApp inspection before bidding',
                  _amalgNotVisible: true };
const PLAIN_FLAG = { panelId: 'SILL', partName: 'Sill', zone: 'side', weight: 'medium', reason: 'possible related damage' };

{
  const cards = buildDamageCards({ gatedParts, costedParts, flaggedParts: [NV_FLAG, PLAIN_FLAG] });
  const nv = cards.find((c) => c.part === 'Side structure');
  const plain = cards.find((c) => c.part === 'Sill');
  ok('the not-visible card is still BUILT (flooredProseScrub reads it)', !!nv);
  eq('and marked for the renderers to drop', nv._notVisibleFloor, true);
  eq('it is still a £0 inspect card', nv.cost, 0);
  ok('a Related card from any OTHER branch is NOT marked', !!plain && plain._notVisibleFloor === undefined);

  // What each renderer shows.
  const shown = cards.filter((c) => !c._notVisibleFloor);
  ok('the Damage Breakdown drops it', !shown.some((c) => c.part === 'Side structure'));
  ok('and keeps every other Related card', shown.some((c) => c.part === 'Sill'));

  // MONEY: the filter touches no Visible card, so parts_sum cannot move.
  const sum = (list) => list.filter((c) => c.origin === 'Visible').reduce((t, c) => t + (Number(c.cost) || 0), 0);
  eq('money is identical before and after the filter', sum(cards), sum(shown));
  eq('the filter removes Related cards only', cards.length - shown.length, 1);
}

{
  // T2 x R3 must not collide. The two are keyed on DIFFERENT markers, so a costed SRS lot with a
  // separate not-visible panel loses exactly one card to each rule, and the airbag is still shown
  // once (from the costed row).
  const cards = buildDamageCards({
    gatedParts: [...gatedParts, SRS_COSTED], costedParts,
    flaggedParts: [SRS_FLAG, NV_FLAG],
  });
  const shown = cards.filter((c) => !c._notVisibleFloor);
  eq('R3: exactly one airbag card survives', shown.filter((c) => /airbag/i.test(c.part || '')).length, 1);
  eq('and it is the COSTED one', shown.find((c) => /airbag/i.test(c.part || '')).origin, 'Visible');
  ok('T2: the not-visible card is gone from the breakdown', !shown.some((c) => c.part === 'Side structure'));
  ok('the airbag flag is NOT marked _notVisibleFloor (different marker, no collision)',
     !cards.some((c) => /airbag/i.test(c.part || '') && c._notVisibleFloor));
}

{
  // The DEFERRED airbag path: no costed SRS row, so R3 does not fire. The airbag flag must still
  // reach the Damage Breakdown -- T2 must not swallow it, because it carries no _amalgNotVisible.
  const cards = buildDamageCards({ gatedParts, costedParts, flaggedParts: [SRS_FLAG] });
  const shown = cards.filter((c) => !c._notVisibleFloor);
  eq('deferred airbag still shows in the breakdown', shown.filter((c) => /airbag/i.test(c.part || '')).length, 1);
}

{
  // Both renderers must carry the filter -- pinned against the shipped source, since the rule lives
  // at the display surfaces by design (the card stays in the data for flooredProseScrub).
  const pdfSrc = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  const webSrc = readFileSync('app/salvage/success/page.js', 'utf8');
  ok('the PDF Damage Breakdown filters _notVisibleFloor', pdfSrc.includes('!c._notVisibleFloor'));
  ok('the screen Damage Breakdown filters _notVisibleFloor', webSrc.includes('!c._notVisibleFloor'));
  const scrub = readFileSync('lib/flooredProseScrub.mjs', 'utf8');
  ok('flooredProseScrub still derives its floored set from _damageCards (why the card is kept)',
     scrub.includes('_damageCards') && scrub.includes("String(c.action).toLowerCase() === 'inspect'"));
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
