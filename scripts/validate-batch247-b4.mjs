// batch 247 B4 (Vincent, 16 Nov: option (b)) — a disputed BODY panel next to a CHARGED panel is costed as a repair the
// buyer can strike, and stays flagged. £0: unit shapes + RV26YLN's stored inputs + SF69YBB's replayed assessment
// (--vision-fixture, Fable cassette, f4d8325 + B3 + B4).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch247-b4.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { costDisputedNeighbours, disputedNeighbourReason, PANEL_NEIGHBOURS } from '@/lib/disputedNeighbour.mjs';
import { buildBuyerFlags, seedChecklistFromFlags } from '@/lib/parts.mjs';
import { buildDamageCards } from '@/lib/damageCards.mjs';
import { applyGradeOwnsAction, isBodyPanel } from '@/lib/labour.mjs';
import { applyEdits, ledgerHash, rowKeyFor, isChargedRow } from '@/lib/ledgerEdits.mjs';
import { PANEL_DISPLAY } from '@/lib/panelEnum.mjs';
import { PANEL_PRICE_TABLE } from '@/lib/priceBand.mjs';

const price = (band) => (pid) => PANEL_PRICE_TABLE[pid]?.[band] ?? null;
const dis = (d, c, sv = 0) => ({ views: d + c, resolving: d + c, damaged: d, clean: c, notVisible: 0, branch: 'disagree', severeVotes: sv });
const flag = (pid) => ({ panelId: pid, partName: PANEL_DISPLAY[pid], zone: 'front', weight: 'medium', reason: 'x', _amalgDisagree: true, _splitVoteUncosted: true });
const row = (pid, extra = {}) => ({ panelId: pid, name: PANEL_DISPLAY[pid], action: 'replace', oem: 300, used: 200, ...extra });

test('wording — one owner, the ruled sentence', () => {
  assert.equal(disputedNeighbourReason('Front wing', 'Front door'),
    'Photos disagree on the front wing — costed as a repair because it sits next to the damaged front door. Strike it if it is sound on inspection.');
});

test('map: every entry is a body panel except the three reported-only ones (mirror, wheel, grille)', () => {
  const nonBody = Object.keys(PANEL_NEIGHBOURS).filter((k) => !isBodyPanel(k)).sort();
  assert.deepEqual(nonBody, ['DOOR_MIRROR', 'GRILLE', 'WHEEL']);
});

test('promotes: zone path when the zones agree, map path otherwise; flag kept and reworded; repair row at the grid figure', () => {
  const g = [row('FRONT_BUMPER'), row('REAR_DOOR')];
  const flags = [flag('BONNET'), flag('FRONT_DOOR')];
  const zones = new Map([['BONNET', 'front'], ['FRONT_BUMPER', 'front'], ['FRONT_DOOR', 'front'], ['REAR_DOOR', 'rear']]);
  const out = costDisputedNeighbours({ gatedParts: g, pvVotes: { BONNET: dis(2, 1), FRONT_DOOR: dis(1, 3) }, flagLists: [flags],
    zoneByPanel: zones, sevByPanel: new Map(), display: PANEL_DISPLAY, priceEntry: price('Mid-range') });
  assert.deepEqual(out.promoted.map((p) => [p.panelId, p.neighbour, p.path]), [['BONNET', 'FRONT_BUMPER', 'zone'], ['FRONT_DOOR', 'REAR_DOOR', 'map']]);
  const bon = g.find((r) => r.panelId === 'BONNET');
  assert.equal(bon.action, 'repair');
  assert.equal(bon.oem, PANEL_PRICE_TABLE.BONNET['Mid-range'].oem);
  assert.equal(flags[0].reason, disputedNeighbourReason('Bonnet', 'Front bumper'));
  assert.equal(flags[0]._disputedNeighbourCosted, true);
  assert.equal(flags[0]._splitVoteUncosted, false);
});

test('not promoted: no charged neighbour · non-body panel · instance key · no surviving flag · already charged', () => {
  const g = [row('HEADLAMP'), row('FRONT_WING'), row('ROOF', { action: 'repair', oem: null, used: null, _repairNoPart: true })];
  const out = costDisputedNeighbours({ gatedParts: g,
    pvVotes: { REAR_BUMPER: dis(1, 1), GRILLE: dis(1, 2), 'FRONT_DOOR#1': dis(1, 1), BONNET: dis(1, 1), ROOF: dis(1, 1) },
    flagLists: [[flag('REAR_BUMPER'), flag('GRILLE'), flag('FRONT_DOOR')]],
    display: PANEL_DISPLAY, priceEntry: price('Mid-range') });
  assert.equal(out.promoted.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.panelId).sort(), ['BONNET', 'FRONT_DOOR#1', 'GRILLE']);
});

test('neighbours are read BEFORE promotion — one promoted panel never promotes the next one along', () => {
  const g = [row('FRONT_BUMPER')];
  const out = costDisputedNeighbours({ gatedParts: g, pvVotes: { BONNET: dis(1, 1), FRONT_WING: dis(1, 1) },
    flagLists: [[flag('BONNET'), flag('FRONT_WING')]], display: PANEL_DISPLAY, priceEntry: price('Mid-range') });
  // FRONT_WING neighbours FRONT_BUMPER (charged) → promoted; BONNET neighbours FRONT_BUMPER too. Neither via the other.
  assert.deepEqual(out.promoted.map((p) => p.neighbour), ['FRONT_BUMPER', 'FRONT_BUMPER']);
  const g2 = [row('FRONT_DOOR')];
  const out2 = costDisputedNeighbours({ gatedParts: g2, pvVotes: { FRONT_WING: dis(1, 1), BONNET: dis(1, 1) },
    flagLists: [[flag('FRONT_WING'), flag('BONNET')]], display: PANEL_DISPLAY, priceEntry: price('Mid-range') });
  assert.deepEqual(out2.promoted.map((p) => p.panelId), ['FRONT_WING']);   // BONNET's only neighbour would be the promoted wing
});

test('grade owns the action: a MINOR/MODERATE/SEVERE(1 photo) promoted repair becomes "repair, £0 part" — never a replace', () => {
  for (const [grade, sv] of [['MINOR', 0], ['MODERATE', 0], ['SEVERE', 1]]) {
    const g = [row('FRONT_BUMPER')];
    const sev = new Map([['BONNET', grade]]);
    costDisputedNeighbours({ gatedParts: g, pvVotes: { BONNET: dis(1, 1, sv) }, flagLists: [[flag('BONNET')]], sevByPanel: sev,
      display: PANEL_DISPLAY, priceEntry: price('Mid-range') });
    applyGradeOwnsAction(g, sev, new Map([['BONNET', sv]]));
    const b = g.find((r) => r.panelId === 'BONNET');
    assert.equal(b.action, 'repair', grade);
    assert.equal(b._repairNoPart, true, grade);
    assert.ok(isChargedRow(b), grade);
    assert.ok(b._disputedNeighbour, `${grade}: marker survives repairNoPart`);
  }
});

test('RV26YLN (stored inputs): front wing and rear quarter are costed as repairs with the ruled words', () => {
  const rv = JSON.parse(readFileSync('fixtures/b247/rv26yln-b4-inputs.json', 'utf8'));
  const g = structuredClone(rv.ledger), flags = structuredClone(rv.flags);
  const zones = new Map(flags.filter((f) => f.panelId && f.zone).map((f) => [f.panelId, f.zone]));
  for (const p of rv.labourBodyPanels) zones.set(p.panelId, p.zone);
  const out = costDisputedNeighbours({ gatedParts: g, pvVotes: rv.pvVotes, flagLists: [flags], zoneByPanel: zones, display: PANEL_DISPLAY, priceEntry: price(rv.band) });
  assert.deepEqual(out.promoted.map((p) => [p.panelId, p.neighbour]).sort(), [['FRONT_WING', 'FRONT_DOOR'], ['REAR_QUARTER', 'REAR_DOOR']]);
  assert.ok(flags.some((f) => f.reason === disputedNeighbourReason('Front wing', 'Front door')));
  assert.ok(flags.some((f) => f.reason === disputedNeighbourReason('Rear quarter panel', 'Rear door')));
});

const SF = JSON.parse(readFileSync('fixtures/b247/SF69YBB-b4-assessment.json', 'utf8'));
const BON = SF._reconciledParts.find((r) => r.panelId === 'BONNET');

test('SF69YBB replay: the four surfaces say the same words (flag, buyer flag, checklist, card)', () => {
  const words = disputedNeighbourReason('Bonnet', 'Front bumper');
  assert.ok(BON._disputedNeighbour && BON._repairNoPart);
  assert.ok(SF._flaggedParts.some((f) => f.panelId === 'BONNET' && f.reason === words));
  assert.ok(buildBuyerFlags(structuredClone(SF)).some((f) => f.panelId === 'BONNET' && f.reason === words), 'kept by buildBuyerFlags');
  assert.ok(SF['WhatsApp Inspection Checklist'].includes(words));
  assert.equal(SF['WhatsApp Inspection Checklist'].split(words).length - 1, 1, 'seeded once');
  assert.ok(SF._damageCards.some((c) => c.panelId === 'BONNET' && c.note === words));
  const cards = buildDamageCards({ gatedParts: [BON], costedParts: [] });
  assert.equal(cards[0].note, words);
});

test('SF69YBB replay: the buyer strikes it like any ledger row, and undo restores the total', () => {
  const keys = rowKeyFor(SF._reconciledParts);
  const k = keys[SF._reconciledParts.indexOf(BON)];
  assert.equal(k, 'BONNET#0');
  const stamp = ledgerHash(SF._reconciledParts);
  const base = applyEdits(SF, null).partsSum;
  const struck = applyEdits(SF, { stamp, strikes: [k], adds: [], amends: [] }).partsSum;
  const undone = applyEdits(SF, { stamp, strikes: [], adds: [], amends: [] }).partsSum;
  assert.equal(base, 3395);
  assert.ok(struck < base, `struck £${struck} < £${base}`);
  assert.equal(undone, base);
});

test('seed: a flag carrying the mark seeds its own reason, and not the uncosted split-vote line', () => {
  const f = { ...flag('BONNET'), _splitVoteUncosted: false, _disputedNeighbourCosted: true, reason: disputedNeighbourReason('Bonnet', 'Front wing') };
  const t = seedChecklistFromFlags('1. a', [f]);
  assert.ok(t.includes(`2. ${f.reason}`));
  assert.ok(!/Not included in the repair total/.test(t));
});
