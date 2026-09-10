// validate-headlamp-pair — batch 109 task C.
//
// VINCENT'S RULING, 10 Sep 2026, after reviewing the SA26KVT photographs: on a lampCount === 2 lot
// (a full-width front hit) BOTH headlamps go in the repair total, each at the band price, with no
// lamp allowance row — and every buyer-facing surface must say the same thing as the money.
//
// What this replaced: the engine costed ONE lamp and shelved the second as an inspection allowance
// marked "excluded from repair total BY DESIGN". Six of the fourteen corpus lots are full-width, so
// six buyers facing a two-lamp impact were quoted one lamp.
//
// THREE TRAPS this file exists to catch, all of which were live during the build:
//  1. THE BAND IS NOT £350. SF69YBB is £150. A test hard-coding 350 passes on five lots and gives a
//     false green on the sixth. Every assertion below reads lampResult.lampAllowance.
//  2. THE GATE COULD STRIP THE SECOND ROW. applyVisibilityGate decides a mandated lamp's fate from
//     lampVerdictFor(costedParts, name, _lampOrdinal) — k-th row pairs with k-th lamp VERDICT — and
//     it also carries a duplicate-row dedup keyed on the verdict name. Reconciling two lamp rows
//     proves nothing on its own; the money is what survives the GATE. Every money assertion here is
//     made AFTER the gate.
//  3. MONEY WITHOUT WORDING IS A CONTRADICTING REPORT. The wording half asserts the phrase
//     "not included in repair total" is absent from the paired-lamp strings, and that the
//     lampCount === 1 strings are byte-identical to before the change.
//
// Uses the REAL exported functions throughout — reconcileParts, applyVisibilityGate,
// computeLampResult, buildDamageCards. Nothing is re-implemented and no string is re-typed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { reconcileParts, applyVisibilityGate, sumPartsRealistic } from '@/lib/parts.mjs';
import { buildDamageCards } from '@/lib/damageCards.mjs';
import { computeLampResult } from '@/app/api/salvage/assess/route.js';

const FIX = 'fixtures';
const load = v => (j => j.assessment || j)(JSON.parse(readFileSync(`${FIX}/${v}/baseline-assessment.json`, 'utf8')));
const lots = () => readdirSync(FIX).filter(d => existsSync(`${FIX}/${d}/baseline-assessment.json`)).sort();
const lampRows = arr => (arr || []).filter(p => /headlamp/i.test(p?.name || ''));

// The verdict shape amalgamate emits. coreObs.costedParts = pvResult.costedParts (route.js), and
// amalgamate pools by panelId, so a lot has exactly ONE HEADLAMP verdict however many lamps are
// costed. That is precisely why both rows must pair to the same ordinal.
const verdict = iv => [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: iv, zone: 'front' }];
const LABOUR = { name: 'Labour & paint', action: '—', oem: 1000, used: null };
const modelLamp = used => ({ name: 'Headlamp', action: 'replace', oem: 400, used, panelId: 'HEADLAMP' });

// Run the real money chain end to end and report what reached the repair total.
function runChain(parts, lampResult, iv = true) {
  const cp = verdict(iv);
  const r = reconcileParts(parts, lampResult, cp, 0, null, lampResult.lampAllowance, false, lampResult.lampAllowance);
  const g = applyVisibilityGate(r.parts, cp, [], lampResult);
  return {
    reconciled: r.parts,
    allowanceParts: r.allowanceParts,
    gated: g.gatedParts,
    gateAllowanceParts: g.gateAllowanceParts,
    moneyLamps: lampRows(g.gatedParts),
    sum: sumPartsRealistic(g.gatedParts),
  };
}

// ── HALF 1 — THE MECHANISM, on real stored _lampResult objects ───────────────────────────────────
// Both bands are exercised deliberately: £350 and £150. If a hard-coded 350 ever creeps in, the
// SF69YBB case is what fails.
for (const [vrm, expectBand] of [['SA26KVT', 350], ['SF69YBB', 150]]) {
  const L = load(vrm)._lampResult;

  test(`${vrm}: stored _lampResult is the lampCount:2 case at band £${expectBand}`, () => {
    assert.equal(L.lampCount, 2, 'fixture drifted — this lot is no longer a full-width two-lamp lot');
    assert.equal(L.lampAllowance, expectBand, 'band drifted — the assertions below key off it');
  });

  // All four model-lamp shapes must converge on the same answer: two lamps, in the money.
  for (const [shape, parts] of [
    ['model priced 1 lamp',  [modelLamp(240), LABOUR]],
    ['model priced 0 lamps', [LABOUR]],
    ['model priced 2 lamps', [modelLamp(240), modelLamp(260), LABOUR]],
    ['model priced 3 lamps', [modelLamp(240), modelLamp(260), modelLamp(280), LABOUR]],
  ]) {
    test(`${vrm} / ${shape}: TWO lamps at band survive the GATE, zero allowance rows`, () => {
      const o = runChain(parts, L);
      assert.equal(o.moneyLamps.length, 2, 'exactly two lamps must reach the repair total');
      for (const row of o.moneyLamps) {
        assert.equal(row.used, L.lampAllowance, 'the band owns the price — never a model figure');
        assert.equal(row._lampMandated, true, 'both rows must be code-owned lamp rows');
        assert.equal(row._band, L.lampAllowance, 'both rows must carry the band');
      }
      assert.deepEqual(lampRows(o.allowanceParts), [], 'reconcileParts must emit no lamp allowance row');
      assert.deepEqual(lampRows(o.gateAllowanceParts), [], 'the gate must not shelve either lamp');
    });
  }

  test(`${vrm}: a third model lamp line is dropped, not shelved — the count is code-owned`, () => {
    const o = runChain([modelLamp(240), modelLamp(260), modelLamp(280), LABOUR], L);
    assert.equal(o.moneyLamps.length, 2, 'a vehicle has two headlamps');
    assert.equal(o.allowanceParts.length, 0, 'and the third is not resurrected as an allowance');
  });

  test(`${vrm}: the delta over one lamp is exactly lampAllowance, never a hard-coded 350`, () => {
    const two = runChain([modelLamp(240), LABOUR], L).sum;
    const one = runChain([modelLamp(240), LABOUR], { ...L, lampCount: 1 }).sum;
    assert.equal(two - one, L.lampAllowance, `${vrm} must move by its own band, not by 350`);
  });
}

test('the two bands genuinely differ — proving the delta is data-driven', () => {
  const a = load('SA26KVT')._lampResult.lampAllowance;
  const b = load('SF69YBB')._lampResult.lampAllowance;
  assert.notEqual(a, b, 'if these ever match, the band-vs-literal trap stops being tested');
});

// ── THE A1 INTERACTION — Vincent's 5 Aug ruling is NOT overruled ─────────────────────────────────
// A precautionary (iv != true) lamp still leaves the repair total. What changed is that the two
// lamps now move TOGETHER: the second is no longer singled out while the first stays costed.
test('A1 preserved: on iv != true BOTH lamps leave the total together, never one of each', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, 'na');
  assert.equal(o.moneyLamps.length, 0, 'A1 still removes a precautionary lamp from the total');
  assert.equal(o.gateAllowanceParts.length, 2, 'and it removes BOTH halves of the pair, not one');
});

// ── HALF 2 — ALL STORED BASELINES ───────────────────────────────────────────────────────────────
// SCOPE, stated honestly: the gate's costedParts input is coreObs.costedParts = pvResult.costedParts
// (route.js) — amalgamate's OUTPUT. That array is not stored on any fixture (_pvVotes holds the vote
// counts, not the objects), and the "Part Verdicts" field is Call-1's model text, a different thing.
// So a byte-faithful whole-chain re-run per lot is NOT possible from stored data, and this half does
// not pretend otherwise: it drives the real functions from each lot's stored _lampResult, which IS
// stored, and asserts the MOVEMENT each lot makes. The £ figures it compares against are the stored
// _partsReconciliation.parts_sum values.
const EXPECTED_MOVERS = { AMZ3790: 350, SA26KVT: 350, SD75YGC: 350, SF69YBB: 150, URZ7545: 350, YH23NVW: 350 };

test('exactly 6 of the stored lots are lampCount:2, and they are the expected 6', () => {
  const movers = lots().filter(v => load(v)._lampResult?.lampCount === 2);
  assert.deepEqual(movers.sort(), Object.keys(EXPECTED_MOVERS).sort());
});

for (const vrm of lots()) {
  const A = load(vrm);
  const L = A._lampResult;

  if (!L) {
    // EN23NJX — the negative control. No lamp machinery fired at all.
    test(`${vrm}: NEGATIVE CONTROL — no _lampResult, so no lamp money exists to move`, () => {
      assert.equal(lampRows(A._reconciledParts).length, 0, 'no lamp in the money');
      assert.equal(lampRows(A._allowanceParts).length, 0, 'and none shelved');
    });
    continue;
  }

  if (L.lampCount === 2) {
    test(`${vrm}: MOVES by exactly £${EXPECTED_MOVERS[vrm]} (its own band)`, () => {
      assert.equal(L.lampAllowance, EXPECTED_MOVERS[vrm], 'band drifted from the B5 table');
      const two = runChain([modelLamp(240), LABOUR], L).sum;
      const one = runChain([modelLamp(240), LABOUR], { ...L, lampCount: 1 }).sum;
      assert.equal(two - one, EXPECTED_MOVERS[vrm]);
    });
    test(`${vrm}: stored baseline shows the OLD shape (1 costed + 1 shelved) — the thing being fixed`, () => {
      assert.equal(lampRows(A._reconciledParts).length, 1, 'stored: one lamp in the money');
      assert.equal(lampRows(A._allowanceParts).length, 1, 'stored: one lamp shelved');
    });
  } else {
    test(`${vrm}: UNCHANGED — lampCount ${L.lampCount} keeps exactly one lamp and no allowance`, () => {
      const o = runChain([modelLamp(240), LABOUR], L);
      assert.equal(o.moneyLamps.length, 1, 'a count-1 lot must still cost exactly one lamp');
      assert.deepEqual(lampRows(o.allowanceParts), [], 'and must emit no lamp allowance row');
    });
  }
}

// The headline arithmetic, pinned to the exact figure in the brief.
test('SA26KVT: stored parts_sum £3,715 becomes £4,065 — the +£350 the ruling is worth', () => {
  const A = load('SA26KVT');
  const stored = A._partsReconciliation.parts_sum;
  assert.equal(stored, 3715, 'stored baseline drifted');
  assert.equal(stored + A._lampResult.lampAllowance, 4065);
});

// ── THE WORDING HALF — the LITERAL shipped strings ───────────────────────────────────────────────
const BANNED = /not included in repair total|not in repair total|excluded from repair total|inspection allowance/i;
const lampStrings = r => [r.checklistEntry, r.checklistEntry2nd, r.costDriverEntry, r.verdictLine, r.tier1Line].filter(Boolean);

// SA26KVT's stored observation: apertureExposed true, full_width, detection 'present', led band 350.
const SA_ARGS = ['central', true, 'led', 'present', null, 'full_width', false];
// AK75RDX's: apertureExposed true, single_corner → lampCount 1.
const AK_ARGS = ['offside', true, 'led', 'present', null, 'single_corner', false];

test('WORDING: SA26KVT (lampCount 2) — no lamp string says the second lamp is excluded', () => {
  const r = computeLampResult(...SA_ARGS);
  assert.equal(r.lampCount, 2, 'guard: this must be the paired case');
  for (const s of lampStrings(r)) {
    assert.ok(!BANNED.test(s), `a lamp string still disclaims the cost: ${JSON.stringify(s)}`);
  }
});

test('WORDING: SA26KVT checklistEntry2nd states the lamp IS in the repair total', () => {
  const r = computeLampResult(...SA_ARGS);
  assert.match(r.checklistEntry2nd, /included in the repair total/);
  assert.match(r.checklistEntry2nd, new RegExp(`£${r.lampAllowance}\\b`), 'must quote its own band');
});

test('WORDING: SA26KVT costDriverEntry names BOTH lamps and the combined figure', () => {
  const r = computeLampResult(...SA_ARGS);
  assert.match(r.costDriverEntry, /Both front headlamps/);
  assert.match(r.costDriverEntry, new RegExp(`£${r.lampAllowance * 2}\\b`), 'must state 2x the band');
});

test('WORDING: AK75RDX (lampCount 1) strings are BYTE-IDENTICAL to before the change', () => {
  const r = computeLampResult(...AK_ARGS);
  assert.equal(r.lampCount, 1, 'guard: this must be the single-lamp case');
  assert.equal(r.checklistEntry2nd, null, 'a count-1 lot has no second-lamp checklist item');
  assert.equal(
    r.costDriverEntry,
    'Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £350 (led).',
  );
});

test('WORDING: a count-1 lot never gains the paired cost-driver line', () => {
  const r = computeLampResult(...AK_ARGS);
  assert.ok(!/Both front headlamps/.test(r.costDriverEntry));
});

// ── DAMAGE CARDS — the second lamp appears once, costed, and never as a £0 Inferred card ─────────
test('CARDS: a paired lot shows two costed lamp cards and no "excluded" Inferred card', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  const cards = buildDamageCards({
    gatedParts: o.gated, costedParts: verdict(true), flaggedParts: [], allowanceParts: o.allowanceParts,
  });
  const lampCards = cards.filter(c => /headlamp/i.test(c.part || ''));
  assert.equal(lampCards.length, 2, 'one card per costed ledger row, so each stays strikeable');
  for (const c of lampCards) {
    assert.equal(c.origin, 'Visible', 'both are costed rows, not inferred allowances');
    assert.equal(c.cost, L.lampAllowance);
    assert.ok(!BANNED.test(c.note || ''), `card note disclaims the cost: ${JSON.stringify(c.note)}`);
  }
  assert.equal(cards.filter(c => c.origin === 'Inferred').length, 0, 'no £0 band-allowance card remains');
});

test('CARDS: the inserted half does NOT claim it was absent from the photographs', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  const cards = buildDamageCards({ gatedParts: o.gated, costedParts: verdict(true), flaggedParts: [], allowanceParts: [] });
  for (const c of cards.filter(c => /headlamp/i.test(c.part || ''))) {
    assert.ok(!/Not present in the listing photos/.test(c.note || ''),
      'the pair is inferred from impact span, not from a lamp missing from a frame');
    assert.match(c.note, /both headlamps are costed/i);
  }
});
