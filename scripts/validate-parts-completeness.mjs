// Unit validator for lib/partsCompleteness.mjs — deterministic, no network, no pipeline.
// Run:  node --test scripts/validate-parts-completeness.mjs
// Substitutes for the (blocked) live GY75CJU pipeline regression: proves the two fixes' logic and
// the authority invariant (parts_sum only moves when a fog is genuinely paired to a gone bumper).
// v2.0 rewrite (batch 61): the pure logic is ported verbatim; the drop-case tests run against main's
// real buildBuyerFlags (lib/parts.mjs), proving the survivors-lookup wiring holds on v2.0.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PANEL } from '../lib/panelEnum.mjs';
import { reconcileNamedComponents, applyFogBumperRule, completenessFlagsFor, VDS_COMPONENTS } from '../lib/partsCompleteness.mjs';
import { buildBuyerFlags } from '../lib/parts.mjs';

const sumUsed = (parts) => parts.reduce((a, p) => a + (p.used ?? p.oem ?? 0), 0);

test('VDS_COMPONENTS all map to a real panelId', () => {
  for (const c of VDS_COMPONENTS) assert.ok(typeof c.panelId === 'string' && c.panelId.length > 0, `bad panelId for ${c.label}`);
});

// ── Fix A ──────────────────────────────────────────────────────────────────
test('Fix A: mirror named in summary but not costed/flagged → one flag', () => {
  const vds = 'Impact path: bumper to wing to door to door mirror. Front end deformed.';
  const flags = reconcileNamedComponents(vds, new Set([PANEL.FRONT_WING, PANEL.FRONT_DOOR]), new Set());
  const mirror = flags.find(f => f.panelId === PANEL.DOOR_MIRROR);
  assert.ok(mirror, 'mirror flag should be added');
  assert.equal(mirror._completenessNet, true);
  assert.match(mirror.reason, /not costed/i);
});

test('Fix A: is FLAG-ONLY — never returns a costed part', () => {
  const flags = reconcileNamedComponents('door mirror, fog lamp, headlamp, front wing', new Set(), new Set());
  for (const f of flags) {
    assert.equal(f.oem ?? null, null);
    assert.equal(f.used ?? null, null);
    assert.ok(f.weight && f.reason, 'is a flag');
  }
});

test('Fix A: already costed (by panelId) → no flag', () => {
  const flags = reconcileNamedComponents('door mirror damaged', new Set([PANEL.DOOR_MIRROR]), new Set());
  assert.equal(flags.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined);
});

test('Fix A: already flagged (by panelId) → no flag', () => {
  const flags = reconcileNamedComponents('door mirror damaged', new Set(), new Set([PANEL.DOOR_MIRROR]));
  assert.equal(flags.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined);
});

test('Fix A: already present in free-text (costed/flag text) → no flag', () => {
  const a = reconcileNamedComponents('door mirror damaged', new Set(), new Set(), 'Door mirror | replace | 120', '');
  assert.equal(a.length, 0);
  const b = reconcileNamedComponents('door mirror damaged', new Set(), new Set(), '', 'Door mirror — per-view disagreement');
  assert.equal(b.length, 0);
});

test('Fix A: empty / absent summary → no flags', () => {
  assert.deepEqual(reconcileNamedComponents('', new Set(), new Set()), []);
  assert.deepEqual(reconcileNamedComponents(null, new Set(), new Set()), []);
});

test('Fix A: component not named → not flagged', () => {
  const flags = reconcileNamedComponents('rear quarter panel creased', new Set(), new Set());
  assert.equal(flags.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined);
  assert.ok(flags.find(f => f.panelId === PANEL.REAR_QUARTER));
});

// ── batch 75 §1 — namedAsIntact polarity (the completeness net stops crying wolf) ─────────────
const VDS_INTACT = 'The front bumper, grille, bonnet and both headlamps read undamaged and undisturbed.';

test('§1: a component named as INTACT and uncosted → NO flag', () => {
  const flags = reconcileNamedComponents(VDS_INTACT, new Set(), new Set(), '', '', ['BONNET', 'GRILLE', 'HEADLAMP']);
  for (const pid of [PANEL.BONNET, PANEL.GRILLE, PANEL.HEADLAMP]) {
    assert.equal(flags.find(f => f.panelId === pid), undefined, `${pid} named intact → must not flag`);
  }
});

test('§1: a component named as DAMAGED and uncosted → flag STILL fires (safety function survives)', () => {
  // Bonnet is CREASED (damaged) and NOT in namedAsIntact; grille IS named intact. Only the grille is excluded.
  const flags = reconcileNamedComponents('The bonnet is creased; the grille reads undamaged.', new Set(), new Set(), '', '', ['GRILLE']);
  assert.ok(flags.find(f => f.panelId === PANEL.BONNET), 'damaged uncosted bonnet must still flag');
  assert.equal(flags.find(f => f.panelId === PANEL.GRILLE), undefined, 'intact grille must not flag');
});

test('§1: a component NOT mentioned at all → behaviour unchanged (no flag)', () => {
  const flags = reconcileNamedComponents('Front bumper damage only.', new Set(), new Set(), '', '', ['BONNET']);
  assert.equal(flags.find(f => f.panelId === PANEL.BONNET), undefined, 'unmentioned bonnet is not named → no flag regardless of namedAsIntact');
});

test('§1: namedAsIntact absent/empty → IDENTICAL to pre-batch-75 (fail toward flagging)', () => {
  const withoutArg = reconcileNamedComponents(VDS_INTACT, new Set(), new Set());          // old 5-arg call
  const withEmpty  = reconcileNamedComponents(VDS_INTACT, new Set(), new Set(), '', '', []);
  // Both must still flag the named-but-uncosted parts (silence/empty is NOT intactness).
  assert.ok(withoutArg.find(f => f.panelId === PANEL.BONNET), 'no namedAsIntact arg → bonnet still flags (old behaviour)');
  assert.deepEqual(withEmpty.map(f => f.panelId).sort(), withoutArg.map(f => f.panelId).sort(), 'empty array == absent arg');
});

// ── Fix B ──────────────────────────────────────────────────────────────────
const fog = (zone) => ({ panelId: PANEL.FOG_LAMP, name: 'Fog lamp', action: 'replace', oem: null, used: 80, zone });

// batch 107 (Vincent, 9 Sep): every "bumper gone ⇒ cost the pair" case below asserts the 30–31 Jul
// trade rule, which batch 81 §3 gates on a CONFIRMED parent — so each must pass *BumperConfirmed:true.
// Without it the call lands on §3's unconfirmed-parent FLAG branch and cost-pairing never runs, which
// is what made these five red: the tests predate §3 and were never given its parameter. §3's own
// branch is pinned separately at the end of this block — it was previously pinned by nothing.
test('Fix B: bumper GONE + one front fog → clone the second fog (cost pairs)', () => {
  const costed = [fog('front'), { panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  const { costedToAdd, flagsToAdd } = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, frontBumperConfirmed: true });
  assert.equal(costedToAdd.length, 1);
  assert.equal(costedToAdd[0].used, 80);
  assert.equal(costedToAdd[0]._fogPaired, true);
  assert.equal(flagsToAdd.length, 0);
  assert.equal(sumUsed([...costed, ...costedToAdd]), before + 80); // parts_sum moves by exactly one fog
});

test('Fix B: bumper INTACT + one front fog → no cost, one "check second" flag', () => {
  const costed = [fog('front'), { panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'repair', used: 150 }];
  const before = sumUsed(costed);
  const { costedToAdd, flagsToAdd } = applyFogBumperRule({ costedParts: costed, frontBumperGone: false });
  assert.equal(costedToAdd.length, 0);
  assert.equal(sumUsed([...costed, ...costedToAdd]), before);      // parts_sum UNCHANGED
  assert.equal(flagsToAdd.length, 1);
  assert.match(flagsToAdd[0].partName, /second front fog/i);
  assert.equal(flagsToAdd[0]._fogCheck, true);
  assert.equal(flagsToAdd[0].used ?? null, null);                 // a flag, not a cost
});

// batch 167 (Vincent, 21 Sep): the rear end carries ONE fog lamp. This test used to assert a clone of the
// second rear fog (costedToAdd 1). One costed rear fog is now the full count: nothing added, no flag.
test('Fix B: rear bumper gone + one rear fog → nothing added (the rear carries one, batch 167)', () => {
  const costed = [fog('rear')];
  const { costedToAdd, flagsToAdd } = applyFogBumperRule({ costedParts: costed, rearBumperGone: true, rearBumperConfirmed: true });
  assert.equal(costedToAdd.length, 0);
  assert.equal(flagsToAdd.length, 0);
});

test('Fix B: CONTROL — bumper INTACT + no fogs → strict no-op (parts_sum untouched)', () => {
  const costed = [{ panelId: PANEL.FRONT_WING, name: 'Front wing', action: 'replace', used: 400 }];
  const before = sumUsed(costed);
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: false, rearBumperGone: false, fogSeed: { oem: 95, used: 80 } });
  assert.equal(r.costedToAdd.length, 0);
  assert.equal(r.flagsToAdd.length, 0);
  assert.equal(sumUsed(costed), before);
});

// "Bumper gone, foglights gone" (Vincent 31 Jul) — seed BOTH fogs from zero. This is the run-1 case.
test('Fix B: bumper GONE + ZERO fogs + band seed → costs BOTH fogs (run-1 under-cost fixed)', () => {
  const costed = [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, frontBumperConfirmed: true, fogSeed: { oem: 95, used: 80 } });
  assert.equal(r.costedToAdd.length, 2);                       // both fogs seeded from zero
  assert.ok(r.costedToAdd.every(f => f.panelId === PANEL.FOG_LAMP && f.used === 80 && f._fogPaired));
  assert.ok(r.costedToAdd.every(f => (f.oem ?? null) === null), 'seeded fog carries NO invented OEM price (batch 66 green bar)');
  assert.equal(r.flagsToAdd.length, 0);                       // no "check second" on the gone branch
  assert.equal(sumUsed([...costed, ...r.costedToAdd]), before + 160);  // parts_sum += 2×£80
});

test('Fix B (batch 71 FIX 4): a SEEDED fog is named for its end, not bare "Fog lamp"', () => {
  // A rear-seeded fog must be distinguishable from a front one in the report — the zone was always
  // carried; only the display name dropped it. Seed from zero on each end and check the name + zone.
  const front = applyFogBumperRule({ costedParts: [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: { oem: 95, used: 80 } });
  const rear  = applyFogBumperRule({ costedParts: [{ panelId: PANEL.REAR_BUMPER,  name: 'Rear bumper',  action: 'replace', used: 300 }], rearBumperGone:  true, rearBumperConfirmed:  true, fogSeed: { oem: 95, used: 80 } });
  // batch 107: these two length assertions are the point of the repair. Without them the `.every()`
  // calls below pass VACUOUSLY on an empty array ([].every(...) === true) — which is exactly what this
  // test did while §3's gate was silently returning zero seeded rows. Assert the rows exist FIRST.
  assert.equal(front.costedToAdd.length, 2, 'front seeds both fogs (non-empty — guards against vacuous .every)');
  // batch 167: the rear seeds ONE (was 2 — "both fogs"). Still non-empty, so the .every below is not vacuous.
  assert.equal(rear.costedToAdd.length,  1, 'rear seeds its one fog (non-empty — guards against vacuous .every)');
  assert.ok(front.costedToAdd.every(f => f.name === 'Front fog lamp' && f.zone === 'front'), 'seeded front fogs are "Front fog lamp"');
  assert.ok(rear.costedToAdd.every(f => f.name === 'Rear fog lamp'  && f.zone === 'rear'),  'seeded rear fogs are "Rear fog lamp"');
  assert.ok(![...front.costedToAdd, ...rear.costedToAdd].some(f => f.name === 'Fog lamp'), 'no seeded fog keeps the bare end-less name');
});

test('Fix B: bumper GONE + ZERO fogs + NO band → flag (never silently absent, no cost)', () => {
  const costed = [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  // batch 107: the parent MUST be confirmed here, otherwise §3's unconfirmed-parent branch fires first
  // and returns its own flag — whose wording also matches /both.*fog lamps sit in it/i, so this test
  // passed while never once reaching the no-band limb it is named for. The _fogUnconfirmedParent
  // assertion below is what makes that impossible to regress into again.
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, frontBumperConfirmed: true, fogSeed: null });
  assert.equal(r.costedToAdd.length, 0);
  assert.equal(sumUsed(costed), before);                      // no price → no cost move
  assert.equal(r.flagsToAdd.length, 1);
  assert.match(r.flagsToAdd[0].reason, /both.*fog lamps sit in it/i);
  assert.ok(!r.flagsToAdd[0]._fogUnconfirmedParent, 'this is the NO-BAND branch, not §3 unconfirmed-parent');
  assert.equal(r.flagsToAdd[0].weight, 'medium');             // no-band flag is medium; §3's is low
});

test('Fix B: two front fogs already present → no-op (already paired)', () => {
  const costed = [fog('front'), fog('front')];
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true });
  assert.equal(r.costedToAdd.length, 0);
  assert.equal(r.flagsToAdd.length, 0);
});

test('Fix B: fog with no zone treated as FRONT', () => {
  const r = applyFogBumperRule({ costedParts: [fog(undefined)], frontBumperGone: true, frontBumperConfirmed: true });
  assert.equal(r.costedToAdd.length, 1);
});

// v2.0 ADDITION: gatedParts has no `zone` — front/rear must be read from the row `name`.
test('Fix B (v2.0): rear fog identified by NAME when zone is absent', () => {
  const rearByName = { panelId: PANEL.FOG_LAMP, name: 'Rear fog lamp', action: 'replace', used: 80 };
  // rear bumper gone, one rear fog (named, no zone field). batch 167: the rear carries one, so it is the full
  // count and nothing is added (was: clone a second, costedToAdd 1). A FRONT read of it would instead give
  // front bumper-intact "check the second" flag — the flag assertion below still proves it is read as rear.
  const r = applyFogBumperRule({ costedParts: [rearByName], rearBumperGone: true, rearBumperConfirmed: true, frontBumperGone: false });
  assert.equal(r.costedToAdd.length, 0);
  // and it must NOT be treated as a front fog (front bumper intact, so a front read would give a flag)
  assert.equal(r.flagsToAdd.length, 0);
});

// ── Fix B §3 — the UNCONFIRMED-PARENT money guard (batch 81 §3; pinned batch 107) ────────────
// Vincent, batch 81 §3: "a part seeded from another part's state may be COSTED only when the parent
// is CONFIRMED." An unconfirmed bumper (a §1 disagree survivor, or _rearBumperOff fired from an
// aperture read) yields a FLAG, never a cost — this is what stopped DL72FVX seeding £130 of fogs from
// a bumper that was itself gate-stripped. Until batch 107 this branch was pinned by NOTHING: the five
// cost-pairing tests all landed on it by accident, so it read as "the pairing limb is broken" rather
// than "the guard is working". These cases assert the guard directly so a future rebase cannot delete
// it silently. Production supplies the parameter at route.js:5070-5071 via _bumperConfirmed (:5065).
test('Fix B §3: bumper gone but parent UNCONFIRMED + one fog → FLAG, never a cost', () => {
  const costed = [fog('front')];
  const before = sumUsed(costed);
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true /* frontBumperConfirmed omitted → false */ });
  assert.equal(r.costedToAdd.length, 0, 'an unconfirmed parent seeds NO cost');
  assert.equal(sumUsed([...costed, ...r.costedToAdd]), before, 'parts_sum is untouched by an unconfirmed parent');
  assert.equal(r.flagsToAdd.length, 1);
  assert.equal(r.flagsToAdd[0]._fogUnconfirmedParent, true);
  assert.equal(r.flagsToAdd[0].weight, 'low');                    // low weight: uncertain, not asserted
  assert.equal(r.flagsToAdd[0].used ?? null, null, 'a flag carries no price');
});

test('Fix B §3: unconfirmed parent + ZERO fogs + a band → still FLAG (the DL72FVX phantom guard)', () => {
  // The exact DL72FVX shape: a price band IS available, so without §3 the rule would seed two fogs
  // from a bumper nobody confirmed. £0 must move.
  const costed = [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, fogSeed: { oem: 95, used: 80 } });
  assert.equal(r.costedToAdd.length, 0, 'a band does NOT license seeding from an unconfirmed parent');
  assert.equal(sumUsed([...costed, ...r.costedToAdd]), before, 'the £130 DL72FVX phantom stays dead');
  assert.equal(r.flagsToAdd.length, 1);
  assert.equal(r.flagsToAdd[0]._fogUnconfirmedParent, true);
});

test('Fix B §3: confirming the parent is what UNLOCKS the cost (same call, one flag flipped)', () => {
  // The control for the two above: identical inputs, parent confirmed → the July trade rule applies.
  const mk = (confirmed) => applyFogBumperRule({
    costedParts: [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }],
    frontBumperGone: true, frontBumperConfirmed: confirmed, fogSeed: { oem: 95, used: 80 },
  });
  const unconfirmed = mk(false), confirmed = mk(true);
  assert.equal(unconfirmed.costedToAdd.length, 0);
  assert.equal(confirmed.costedToAdd.length, 2);
  assert.equal(sumUsed(confirmed.costedToAdd), 160);              // 2 × £80, the band S/H rate
  assert.ok(confirmed.costedToAdd.every(f => (f.oem ?? null) === null), 'seeded fog invents no OEM price');
});

test('Fix B §3: the guard is PER END — a confirmed front does not license an unconfirmed rear', () => {
  // batch 167: the rear carries ONE fog, so a ledger that already holds a rear fog is complete and raises
  // nothing — this used to seed the rear with fog('rear') and expect a flag for the "missing" second. The
  // point of the test is the per-end guard, so the rear end now starts with NO fog (0 < 1 → the §3 flag).
  const costed = [fog('front')];
  const r = applyFogBumperRule({
    costedParts: costed,
    frontBumperGone: true, frontBumperConfirmed: true,
    rearBumperGone:  true, rearBumperConfirmed:  false,
  });
  assert.equal(r.costedToAdd.length, 1, 'only the confirmed front end pairs');
  assert.equal(r.costedToAdd[0].zone, 'front');
  assert.equal(r.flagsToAdd.length, 1, 'the unconfirmed rear end flags instead');
  assert.equal(r.flagsToAdd[0].zone, 'rear');
  assert.equal(r.flagsToAdd[0]._fogUnconfirmedParent, true);
});

// ── Fix A — the door-mirror DROP case (GY75CJU kick-back) ────────────────────
// Synthetic assessment: mirror named in the VDS prose, present ONLY as an _amalgDisagree flag on a
// panel NOT in _preGateParts (so buildBuyerFlags strips it), and not costed.
function dropAssessment() {
  return {
    'Visible Damage Summary': 'Front-corner impact — bumper, grille and wing — carrying rearward as a sideswipe down the flank through the door mirror and doors.',
    _flaggedParts: [
      { panelId: PANEL.DOOR_MIRROR, partName: 'Door mirror', weight: 'medium', _amalgDisagree: true, reason: 'per-view disagreement — seen undamaged in one photo, damaged in another' },
      { panelId: PANEL.FRONT_WING,  partName: 'Front wing',  weight: 'high', reason: 'front wing folded' },
    ],
    _preGateParts: [{ panelId: PANEL.FRONT_WING }],   // DOOR_MIRROR absent → buildBuyerFlags strips its disagree flag
  };
}
const dropGated = [{ panelId: PANEL.FRONT_WING, name: 'Front wing', used: 400 }];

test('Fix A precondition: buildBuyerFlags STRIPS the amalgDisagree mirror (drop mechanism)', () => {
  const survivors = buildBuyerFlags(dropAssessment());
  assert.equal(survivors.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined, 'mirror must be stripped by buildBuyerFlags');
  assert.ok(survivors.find(f => f.panelId === PANEL.FRONT_WING), 'wing (no disagree) survives');
});

test('Fix A BUG (pre-filter _flaggedParts lookup): mirror slips the net → dropped', () => {
  const a = dropAssessment();
  // The OLD wiring: dedup against the raw pre-filter _flaggedParts (which still holds the disagree mirror).
  const flaggedPanelIds = new Set(a._flaggedParts.map(f => f.panelId));
  const extra = reconcileNamedComponents(a['Visible Damage Summary'], new Set([PANEL.FRONT_WING]), flaggedPanelIds);
  // Bug reproduced: net adds NO mirror flag, yet buildBuyerFlags will have stripped the disagree one →
  // mirror ends up in NEITHER costed nor surviving flags.
  assert.equal(extra.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined, 'pre-filter lookup wrongly suppresses the net');
  const survivors = buildBuyerFlags(a);
  assert.equal(survivors.find(f => f.panelId === PANEL.DOOR_MIRROR), undefined);  // dropped, unrescued
});

test('Fix A FIX (survivors lookup): completenessFlagsFor catches the stripped mirror', () => {
  const a = dropAssessment();
  const extra = completenessFlagsFor(a, dropGated, buildBuyerFlags);
  const mirror = extra.find(f => f.panelId === PANEL.DOOR_MIRROR);
  assert.ok(mirror, 'net must fire for the mirror the buyer would otherwise never see');
  assert.equal(mirror._completenessNet, true);
  // Flag-only: nothing costed, no used/oem
  assert.equal(mirror.used ?? null, null);
  assert.equal(mirror.oem ?? null, null);
  // …and the added flag itself SURVIVES buildBuyerFlags (no disagree/not-visible marker).
  a._flaggedParts.push(...extra);
  assert.ok(buildBuyerFlags(a).find(f => f.panelId === PANEL.DOOR_MIRROR), 'the net flag reaches the buyer');
});
