// validate-srs-tier — batch 107 task 3.
//
// The SRS tier decides £300 (T1) / £600 (T2) / £1000 (T3) on LABOUR_SPEC_v1. Before this batch the
// upgrades keyed ONLY on the words "driver"/"passenger"/"curtain" in Copart's paste — and Copart
// writes only "AIRBAGS DEPLOYED", naming no position on ANY lot in the 14-lot corpus. Result: all
// five airbag lots billed the T1 floor while Vincent's read of the interior frames put four of them
// at T2/T3. Under-costing is the DANGEROUS direction: a cheaper-looking repair makes a bidder bid MORE.
//
// The tier is now driven by PERCEIVED, DISTINCT POSITIONS. The single most important property in
// this file is the OVER-COUNT GUARD: a read that turns one bag into two is WORSE than the old floor,
// because it spends money on a bag nobody saw. Vincent, 9 Sep, rejecting a blanket move to T2:
// occupant detection suppresses the passenger bag on an empty seat, and salvage lots are
// disproportionately single-occupant — so "both front always fire" cannot be assumed.
//
// ⛔ NEVER `damaged > 1 → T2`. pvVotesMap.AIRBAG.damaged counts VIEWS, not BAGS.
import assert from 'node:assert/strict';
import test from 'node:test';
import { srsTierFromSignals, srsPositionsFromPerView } from '@/app/api/salvage/assess/route.js';
import { PANEL } from '@/lib/panelEnum.mjs';
import { readFileSync } from 'node:fs';

const NO_PASTE = { deployed: false, intact: false, curtainSide: false, bothFront: false };
const PASTE_DEPLOYED = { ...NO_PASTE, deployed: true };
const bag = (pos, iv = true) => ({ panelId: PANEL.AIRBAG, independentlyVisible: iv, srsPosition: pos });
const tierOf = (parts, paste = PASTE_DEPLOYED) =>
  srsTierFromSignals(true, paste, srsPositionsFromPerView(parts));

// ── THE OVER-COUNT GUARD — the half that decides whether this ships ──────────────────────────
test('OVER-COUNT: three views of the SAME driver bag are ONE position → T1, never T2', () => {
  // The exact trap: pvVotes would report damaged:3. Three photos, one bag.
  const r = tierOf([bag('driver'), bag('driver'), bag('driver')]);
  assert.equal(r.tier, 1);
  assert.deepEqual(r.positions, ['driver']);
  assert.equal(r.countResolved, false, 'one placed bag does not resolve the count');
});

test('OVER-COUNT: many views, all unplaced, never upgrade — unknown is not a position', () => {
  const r = tierOf([bag('unknown'), bag('unknown'), bag('unknown'), bag('unknown')]);
  assert.equal(r.tier, 1);
  assert.deepEqual(r.positions, []);
});

test('OVER-COUNT: a driver bag plus unplaced sightings stays T1', () => {
  const r = tierOf([bag('driver'), bag('unknown'), bag('unknown')]);
  assert.equal(r.tier, 1);
  assert.deepEqual(r.positions, ['driver']);
});

test('OVER-COUNT: a bag the model did NOT independently see contributes nothing', () => {
  // iv:false / iv:null are not sightings. A passenger bag asserted without seeing it must not pay.
  const r = tierOf([bag('driver'), bag('passenger', false), bag('curtain-left', null)]);
  assert.equal(r.tier, 1, 'unseen bags cannot raise the tier');
  assert.deepEqual(r.positions, ['driver']);
});

test('🎯 AMZ3790 SHAPE — driver + passenger, NO curtain → T2 and NOT T3', () => {
  // Vincent's ground truth, 9 Sep: both front out, no curtain. If this returns T3 the read invented
  // a curtain and the feature must not ship.
  const r = tierOf([bag('driver'), bag('passenger'), bag('driver')]);
  assert.equal(r.tier, 2);
  assert.equal(r.countResolved, true);
  assert.ok(!r.positions.some(p => p.startsWith('curtain')), 'no curtain may be invented');
});

test('🎯 AK75RDX SHAPE — a curtain is seen → T3', () => {
  const r = tierOf([bag('driver'), bag('curtain-left')]);
  assert.equal(r.tier, 3);
  assert.equal(r.branch, 'perview-curtain→T3');
});

test('a curtain ALONE is T3 — it does not need a front bag to corroborate it', () => {
  assert.equal(tierOf([bag('curtain-right')]).tier, 3);
});

// ── The floor, and the paste fallback ────────────────────────────────────────────────────────
test('deployment confirmed but nothing placed → T1 floor, countResolved false', () => {
  const r = tierOf([]);
  assert.equal(r.tier, 1);
  assert.equal(r.countResolved, false);
  assert.equal(r.branch, 'deployment-confirmed-count-unresolved→T1-floor');
});

test('no deployment signal at all → no tier, no cost', () => {
  const r = srsTierFromSignals(false, NO_PASTE, new Set());
  assert.equal(r.deploymentConfirmed, false);
  assert.equal(r.tier, null);
});

test('the corpus reality: "AIRBAGS DEPLOYED" with no position → T1 (this is the defect being fixed)', () => {
  // analyseAirbagPaste over all 14 fixture pastes yields bothFront=0, curtainSide=0. Perception is
  // the only thing that can lift this, which is the whole point of the task.
  const r = srsTierFromSignals(true, PASTE_DEPLOYED, new Set());
  assert.equal(r.tier, 1);
});

test('paste STILL heard when perception placed nothing (vendor who does name a position)', () => {
  const curtainPaste = { ...PASTE_DEPLOYED, curtainSide: true };
  assert.equal(srsTierFromSignals(true, curtainPaste, new Set()).tier, 3);
  const bothFrontPaste = { ...PASTE_DEPLOYED, bothFront: true };
  assert.equal(srsTierFromSignals(true, bothFrontPaste, new Set()).tier, 2);
});

test('PERCEPTION OUTRANKS the paste — a seen curtain beats a paste that says only both-front', () => {
  const bothFrontPaste = { ...PASTE_DEPLOYED, bothFront: true };
  const r = srsTierFromSignals(true, bothFrontPaste, srsPositionsFromPerView([bag('curtain-left')]));
  assert.equal(r.tier, 3, 'the photograph of the car outranks the vendor descriptor');
});

// ── The rule that must never be reintroduced ─────────────────────────────────────────────────
test('⛔ VOTE COUNT IS NOT A BAG COUNT — non-AIRBAG panels never contribute a position', () => {
  const parts = [
    { panelId: PANEL.FRONT_DOOR, independentlyVisible: true, srsPosition: 'driver' },
    { panelId: PANEL.WHEEL,      independentlyVisible: true, srsPosition: 'passenger' },
  ];
  const r = tierOf(parts);
  assert.deepEqual(r.positions, [], 'srsPosition on a non-airbag row is ignored entirely');
  assert.equal(r.tier, 1);
});

test('malformed / missing position fields degrade to the floor, never upward', () => {
  const parts = [
    { panelId: PANEL.AIRBAG, independentlyVisible: true },                 // no srsPosition at all
    { panelId: PANEL.AIRBAG, independentlyVisible: true, srsPosition: '' },
    null,
  ];
  const r = tierOf(parts);
  assert.equal(r.tier, 1);
  assert.deepEqual(r.positions, []);
});

test('srsPositionsFromPerView tolerates null/undefined input', () => {
  assert.equal(srsPositionsFromPerView(null).size, 0);
  assert.equal(srsPositionsFromPerView(undefined).size, 0);
});

test('duplicate curtain sightings across views collapse to the distinct set', () => {
  const r = tierOf([bag('curtain-left'), bag('curtain-left'), bag('curtain-right')]);
  assert.equal(r.tier, 3);
  assert.deepEqual([...r.positions].sort(), ['curtain-left', 'curtain-right']);
});

// -- batch 142 R3 (Vincent, 16 Sep): EXACTLY ONE HIGH AIRBAG FLAG ------------------------------
// When the costed "SRS airbag kit (deployed) - from £500" row is injected, the buyer must see
// exactly ONE high inspection flag carrying the airbag sentence. The route achieves that by
// COLLAPSING every pre-existing AIRBAG flag and then pushing one canonical flag. Pinned against the
// shipped source, because the ORDERING (suppress, THEN push) is the whole guarantee -- reversed, the
// push would be swallowed and the airbag would vanish from Inspection Flags entirely.
const R3_ROUTE_SRC = readFileSync('app/api/salvage/assess/route.js', 'utf8');

test('R3: suppressAirbagFlags removes every pre-existing AIRBAG flag', () => {
  const i = R3_ROUTE_SRC.indexOf('const suppressAirbagFlags = ()');
  assert.ok(i > 0, 'suppressAirbagFlags not found in route.js');
  const body = R3_ROUTE_SRC.slice(i, i + 400);
  assert.ok(body.includes('panelId === PANEL.AIRBAG'), 'it no longer selects AIRBAG flags');
  assert.ok(body.includes('splice(i, 1)'), 'it no longer removes them');
});

test('R3: on confirmed deployment the route suppresses FIRST, then pushes exactly one flag', () => {
  const i = R3_ROUTE_SRC.indexOf('const srsFlagDropped = suppressAirbagFlags();');
  assert.ok(i > 0, 'the confirmed-deployment suppress call is gone');
  const after = R3_ROUTE_SRC.slice(i, i + 1200);
  const pushes = after.split('coreObs.flaggedParts.push(').length - 1;
  assert.equal(pushes, 1, 'expected exactly one flag pushed after the suppress');
  assert.ok(after.includes('_srsExtentFloor: true'), 'the pushed flag is not the canonical SRS extent flag');
  assert.ok(after.includes("weight: 'high'"), 'the pushed flag is not HIGH weight');
});

test('R3: the costed row and the flag carry the marker pair the card suppressor keys on', () => {
  assert.ok(R3_ROUTE_SRC.includes('_srsFloor: true'), 'the costed SRS row lost its _srsFloor marker');
  assert.ok(R3_ROUTE_SRC.includes('_srsExtentFloor: true'), 'the SRS flag lost its _srsExtentFloor marker');
});
