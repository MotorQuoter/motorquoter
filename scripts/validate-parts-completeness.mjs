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

// ── Fix B ──────────────────────────────────────────────────────────────────
const fog = (zone) => ({ panelId: PANEL.FOG_LAMP, name: 'Fog lamp', action: 'replace', oem: null, used: 80, zone });

test('Fix B: bumper GONE + one front fog → clone the second fog (cost pairs)', () => {
  const costed = [fog('front'), { panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  const { costedToAdd, flagsToAdd } = applyFogBumperRule({ costedParts: costed, frontBumperGone: true });
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

test('Fix B: rear bumper gone + one rear fog → clone rear fog', () => {
  const costed = [fog('rear')];
  const { costedToAdd, flagsToAdd } = applyFogBumperRule({ costedParts: costed, rearBumperGone: true });
  assert.equal(costedToAdd.length, 1);
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
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, fogSeed: { oem: 95, used: 80 } });
  assert.equal(r.costedToAdd.length, 2);                       // both fogs seeded from zero
  assert.ok(r.costedToAdd.every(f => f.panelId === PANEL.FOG_LAMP && f.used === 80 && f._fogPaired));
  assert.ok(r.costedToAdd.every(f => (f.oem ?? null) === null), 'seeded fog carries NO invented OEM price (batch 66 green bar)');
  assert.equal(r.flagsToAdd.length, 0);                       // no "check second" on the gone branch
  assert.equal(sumUsed([...costed, ...r.costedToAdd]), before + 160);  // parts_sum += 2×£80
});

test('Fix B: bumper GONE + ZERO fogs + NO band → flag (never silently absent, no cost)', () => {
  const costed = [{ panelId: PANEL.FRONT_BUMPER, name: 'Front bumper', action: 'replace', used: 300 }];
  const before = sumUsed(costed);
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true, fogSeed: null });
  assert.equal(r.costedToAdd.length, 0);
  assert.equal(sumUsed(costed), before);                      // no price → no cost move
  assert.equal(r.flagsToAdd.length, 1);
  assert.match(r.flagsToAdd[0].reason, /both.*fog lamps sit in it/i);
});

test('Fix B: two front fogs already present → no-op (already paired)', () => {
  const costed = [fog('front'), fog('front')];
  const r = applyFogBumperRule({ costedParts: costed, frontBumperGone: true });
  assert.equal(r.costedToAdd.length, 0);
  assert.equal(r.flagsToAdd.length, 0);
});

test('Fix B: fog with no zone treated as FRONT', () => {
  const r = applyFogBumperRule({ costedParts: [fog(undefined)], frontBumperGone: true });
  assert.equal(r.costedToAdd.length, 1);
});

// v2.0 ADDITION: gatedParts has no `zone` — front/rear must be read from the row `name`.
test('Fix B (v2.0): rear fog identified by NAME when zone is absent', () => {
  const rearByName = { panelId: PANEL.FOG_LAMP, name: 'Rear fog lamp', action: 'replace', used: 80 };
  // rear bumper gone, one rear fog (named, no zone field) → clone the second rear fog
  const r = applyFogBumperRule({ costedParts: [rearByName], rearBumperGone: true, frontBumperGone: false });
  assert.equal(r.costedToAdd.length, 1);
  // and it must NOT be treated as a front fog (front bumper intact, so a front read would give a flag)
  assert.equal(r.flagsToAdd.length, 0);
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
