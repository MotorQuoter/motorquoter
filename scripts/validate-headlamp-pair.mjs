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
import {
  reconcileParts, applyVisibilityGate, sumPartsRealistic, classifyLampMoneyRows,
  finalizeLampInstrumentation, LAMP_PAIR_LIMIT_REASON,
} from '@/lib/parts.mjs';
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
  const flags = [];
  const r = reconcileParts(parts, lampResult, cp, 0, null, lampResult.lampAllowance, false, lampResult.lampAllowance);
  const g = applyVisibilityGate(r.parts, cp, flags, lampResult);
  return {
    reconciled: r.parts,
    allowanceParts: r.allowanceParts,
    gated: g.gatedParts,
    gateAllowanceParts: g.gateAllowanceParts,
    flags,
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

// ── THE A1 INTERACTION — batch 111 task 3, Vincent 11 Sep, REVERSES what 109C pinned here ─────────
// 109C left A1 in force on the pair (iv != true → both lamps shelved together) and this test pinned
// that. Vincent then ruled: "Cost both lamps, and put in a line the buyer can strike out if the lamp
// turns out sound." So on the pair, iv != true now keeps BOTH lamps in the total at band, with one
// strike-the-line limit flag. A scoped exception — A1 still governs a lampCount 1 lamp (pinned below).
test('A1 EXCEPTION (batch 111): on iv != true BOTH pair lamps STAY in the total together, never one of each', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, 'na');
  assert.equal(o.moneyLamps.length, 2, 'the ruled exception keeps both lamps of a full-width pair in the total');
  assert.equal(o.gateAllowanceParts.length, 0, 'and shelves neither of them');
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

// ── BATCH 110 TASK 1 — THE [LAMP MONEY] DIAGNOSTIC MUST TELL THE TRUTH ABOUT THE PAIR ───────────────
// The first live lot after 109C (AMZ3790, 11 Sep) logged "tier2-anomaly (INVARIANT BROKEN: >1 mandated
// lamp row on a path where that is structurally impossible)" about the two lamps 109C costs by design.
// The fix is a TRUE line, not a quiet one: the pair still logs its row count, and every other >1 shape
// still warns. Driven by the real chain's gated output, not by hand-built rows, wherever the real chain
// can reach the case.
const OLD_STALE = 'INVARIANT BROKEN: >1 mandated lamp row on a path where that is structurally impossible';
const mRow = (extra = {}) => ({ name: 'Headlamp', action: 'replace', oem: null, used: 350, _lampMandated: true, _band: 350, ...extra });

for (const vrm of ['AMZ3790', 'SA26KVT', 'SF69YBB']) {
  const L = load(vrm)._lampResult;
  for (const [shape, parts] of [
    ['model priced 2', [modelLamp(240), modelLamp(240), LABOUR]],
    ['model priced 1', [modelLamp(240), LABOUR]],
    ['model priced 0', [LABOUR]],
  ]) {
    test(`LAMP MONEY LINE: ${vrm} / ${shape} — the pair logs as expected, with its count, never as a breach`, () => {
      const o = runChain(parts, L);
      const c = classifyLampMoneyRows(o.gated, L, L.spanSource);
      assert.ok(c, 'two rows in the money must still produce a line — not silenced');
      assert.equal(c.level, 'log', 'the designed pair is not a warning');
      assert.match(c.line, /^\[LAMP MONEY\]\[PAIR\] 2 lamp rows in parts_sum/, 'the line must report the count');
      assert.ok(!/INVARIANT BROKEN/.test(c.line), `the pair was called a breach: ${c.line}`);
    });
  }
}

test('LAMP MONEY LINE: an unconfirmed pair (iv != true, batch 111) is still the sanctioned pair — logs, never warns', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, 'na');
  const c = classifyLampMoneyRows(o.gated, L, L.spanSource);
  assert.equal(c.level, 'log');
  assert.match(c.line, /^\[LAMP MONEY\]\[PAIR\] 2 lamp rows in parts_sum/);
});

test('LAMP MONEY LINE: a lampCount 1 lot with one lamp says nothing extra, exactly as before', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  assert.equal(classifyLampMoneyRows(o.gated, L, L.spanSource), null);
});

// The breaches the real chain cannot currently produce — hand-built, because that is the point: they
// are the shapes the invariant exists to catch. Each must still WARN and still say INVARIANT BROKEN.
test('LAMP MONEY LINE: tier-2 lampCount 1 with 2 mandated rows is STILL a breach', () => {
  const c = classifyLampMoneyRows([mRow(), mRow()], { tier2Fired: true, lampCount: 1 }, 'single_corner');
  assert.equal(c.level, 'warn');
  assert.match(c.line, /INVARIANT BROKEN: 2 mandated lamp rows on a lampCount=1 path/);
});

test('LAMP MONEY LINE: tier-2 lampCount 2 with 3 mandated rows is STILL a breach', () => {
  const c = classifyLampMoneyRows([mRow({ _lampPair: true }), mRow({ _lampPair: true }), mRow({ _lampPair: true })],
    { tier2Fired: true, lampCount: 2 }, 'full_width');
  assert.equal(c.level, 'warn');
  assert.match(c.line, /INVARIANT BROKEN: 3 mandated lamp rows on a lampCount=2 path/);
});

test('LAMP MONEY LINE: tier-2 lampCount 2 with 2 rows NOT stamped as the 109C pair is STILL a breach', () => {
  const c = classifyLampMoneyRows([mRow({ _lampPair: true }), mRow()], { tier2Fired: true, lampCount: 2 }, 'full_width');
  assert.equal(c.level, 'warn');
  assert.match(c.line, /INVARIANT BROKEN/);
});

test('LAMP MONEY LINE: the non-tier-2 orphan-collapse text is byte-identical to S5-1', () => {
  const c = classifyLampMoneyRows([mRow(), mRow()], null, 'no-lamp-result');
  assert.equal(c.level, 'warn');
  assert.equal(c.line, '[LAMP MONEY][ORPHAN COLLAPSE] 2 lamp rows in parts_sum — orphan-collapse (non-tier2 path — S5-2 target); span_source=no-lamp-result.');
});

test('LAMP MONEY LINE: route.js is wired to the classifier and the stale sentence is gone', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.match(src, /classifyLampMoneyRows\(gatedParts, lampResult, lamp_span_source\)/);
  assert.ok(!src.includes(OLD_STALE), 'the pre-109C invariant sentence is still in route.js');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BATCH 111 — Vincent, 11 Sep 2026
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── TASK 1a — THE COUNTER SEES EVERY LAMP ROW IN THE MONEY, NOT JUST THE MANDATED ONES ────────────
// lamp_money_rows used to count _lampMandated rows only, so an unmandated model-priced lamp row in
// parts_sum was invisible to the very counter meant to police it. Hand-built gatedParts here so these
// cases stay true whatever Vincent rules on the surplus row (1b).
const unowned = (used = 260) => ({ name: 'Headlamp', action: 'replace', oem: 400, used, panelId: 'HEADLAMP' });
const T2C1 = { tier2Fired: true, lampCount: 1, lampAllowance: 350 };

test('1a COUNTER: a mandated + an unmandated lamp row → lamp_money_rows is 2, not 1', () => {
  const f = finalizeLampInstrumentation([mRow(), unowned(), LABOUR], T2C1);
  assert.equal(f.lamp_money_rows, 2, 'the count must see the row it exists to police');
});

test('1a COUNTER: the unmandated row is counted, NOT made mandated (mandated set unwidened)', () => {
  const g = [mRow(), unowned(), LABOUR];
  finalizeLampInstrumentation(g, T2C1);
  classifyLampMoneyRows(g, T2C1, 'single_corner');
  assert.equal(g[1]._lampMandated, undefined, 'counting must not stamp the row as band-owned');
  assert.equal(g[1].used, 260, 'and must not touch its money — that is 1b, awaiting a ruling');
});

test('1a COUNTER: a panelId-HEADLAMP row whose name escapes isLampLine is still counted', () => {
  const f = finalizeLampInstrumentation([mRow(), { name: 'Headlamps (pair)', action: 'replace', used: 480, panelId: 'HEADLAMP' }], T2C1);
  assert.equal(f.lamp_money_rows, 2);
});

test('1a COUNTER: a free-text PLURAL lamp row with NO panelId (escapes isLampLine) is still counted and warned', () => {
  for (const name of ['Headlamps (pair)', 'Headlights', 'Head light unit']) {
    const g = [mRow(), { name, action: 'replace', oem: 900, used: 480 }, LABOUR];
    assert.equal(finalizeLampInstrumentation(g, T2C1).lamp_money_rows, 2, name);
    assert.equal(classifyLampMoneyRows(g, T2C1, 'single_corner').level, 'warn', name);
  }
});

test('1a COUNTER: non-lamp rows are not counted (fog lamp, labour, bonnet)', () => {
  const g = [mRow(), { name: 'Fog lamp', used: 70, panelId: 'FOG_LAMP' }, { name: 'Bonnet', used: 280, panelId: 'BONNET' }, LABOUR];
  assert.equal(finalizeLampInstrumentation(g, T2C1).lamp_money_rows, 1);
  assert.equal(classifyLampMoneyRows(g, T2C1, 'single_corner'), null);
});

test('1a LINE: any unmandated lamp row in parts_sum WARNS as NOT BAND-OWNED, naming its figure', () => {
  const c = classifyLampMoneyRows([mRow(), unowned(), LABOUR], T2C1, 'single_corner');
  assert.equal(c.level, 'warn');
  assert.match(c.line, /^\[LAMP MONEY\]\[NOT BAND-OWNED\] 2 lamp row\(s\) in parts_sum, 1 NOT band-owned \("Headlamp" £260\)/);
  assert.match(c.line, /INVARIANT BROKEN: the band owns every headlamp pound/);
});

test('1a LINE: it warns even when the unowned row is the ONLY lamp row', () => {
  const c = classifyLampMoneyRows([unowned(), LABOUR], T2C1, 'single_corner');
  assert.equal(c.level, 'warn');
  assert.match(c.line, /1 lamp row\(s\) in parts_sum, 1 NOT band-owned/);
});

// The REAL chain, today. This case documents the open leak — it is the 1b shape, and its money is
// deliberately NOT asserted: whether the surplus row is dropped or band-priced is Vincent's ruling.
// What IS asserted is that the leak can no longer hide.
test('1a REAL CHAIN (AK75RDX, count 1, model priced 2): the leak is now COUNTED and WARNED — money pending 1b', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L);
  const f = finalizeLampInstrumentation(o.gated, L);
  assert.equal(o.moneyLamps.length, 2, 'guard: this is the leak shape');
  assert.equal(f.lamp_money_rows, 2, 'the counter now reports what is in the money');
  assert.equal(classifyLampMoneyRows(o.gated, L, L.spanSource).level, 'warn');
});

test('1a CORPUS: every stored lot has 0 unmandated lamp rows in the money (the leak has never fired)', () => {
  for (const v of lots()) {
    const bad = lampRows(load(v)._reconciledParts).filter(p => !p._lampMandated);
    assert.equal(bad.length, 0, `${v} carries an unmandated lamp row in its stored money`);
  }
});

// ── TASK 2 — verdictLine IN THE PLURAL ON lampCount 2; BYTE-IDENTICAL ON lampCount 1 ─────────────
const PAIR_ARGS = v => ['central', true, 'led', v, null, 'full_width', false];

for (const v of ['present', 'cannot_determine', 'missing']) {
  test(`TASK 2: lampCount 2 / ${v} — verdictLine names BOTH lamps, each and total, in the total`, () => {
    const r = computeLampResult(...PAIR_ARGS(v));
    assert.equal(r.lampCount, 2);
    assert.match(r.verdictLine, /^Both front headlamps — full-width frontal impact/);
    assert.match(r.verdictLine, new RegExp(`£${r.lampAllowance} each .*£${r.lampAllowance * 2} in total, both included in the repair total\\.`));
    assert.ok(!BANNED.test(r.verdictLine), `plural line disclaims the cost: ${r.verdictLine}`);
    assert.ok(!/Struck front corner headlamp/.test(r.verdictLine), 'must not keep the singular lead');
  });
}

test('TASK 2: lampCount 2 on an assumed lamp type still carries the assumed-LED disclosure', () => {
  const r = computeLampResult('central', true, null, 'cannot_determine', null, 'full_width', false);
  assert.equal(r.lampTypeAssumed, true);
  assert.match(r.verdictLine, /Lamp type could not be confirmed from the vehicle spec/);
});

// Captured from 0794382 BEFORE the change — the literal shipped count-1 strings.
const DISC = 'Lamp type could not be confirmed from the vehicle spec, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';
const PRESENT1 = 'Struck front corner headlamp — the headlamp on the struck corner appears present; however, on a displaced-bumper impact the aperture is unreliable and serviceability cannot be confirmed from photos. Replacement costed at £350 (led) as a precautionary allowance.';
const CANNOT1  = 'Struck front corner headlamp — on a displaced-bumper front-corner impact the headlamp is treated as a replacement; presence and serviceability cannot be confirmed from the photos. Replacement costed at £350 (led).';
for (const [v, spec, expected] of [
  ['present', 'led', `${PRESENT1} Confirm on inspection.`],
  ['present', null,  `${PRESENT1} ${DISC}`],
  ['missing', 'led', `${CANNOT1} Confirm on inspection.`],
  ['missing', null,  `${CANNOT1} ${DISC}`],
  ['cannot_determine', 'led', `${CANNOT1} Confirm on inspection.`],
  ['cannot_determine', null,  `${CANNOT1} ${DISC}`],
]) {
  test(`TASK 2: lampCount 1 / ${v} / spec=${spec} — verdictLine BYTE-IDENTICAL to before`, () => {
    const r = computeLampResult('offside', true, spec, v, null, 'single_corner', false);
    assert.equal(r.lampCount, 1);
    assert.equal(r.verdictLine, expected);
  });
}

// ── TASK 3 — THE STRIKEABLE PAIR: both lamps costed on iv != true, one strike-the-line flag ─────
for (const [vrm, iv] of [['SA26KVT', 'na'], ['SA26KVT', false], ['SF69YBB', 'na'], ['SF69YBB', false]]) {
  test(`TASK 3: ${vrm} / pair / iv=${iv} — BOTH lamps in the total at band, one strike-the-line flag`, () => {
    const L = load(vrm)._lampResult;
    const o = runChain([modelLamp(240), LABOUR], L, iv);
    assert.equal(o.moneyLamps.length, 2);
    for (const row of o.moneyLamps) {
      assert.equal(row.used, L.lampAllowance, 'band owns it — never a model figure');
      assert.equal(row._lampPairUnconfirmed, true);
    }
    assert.equal(o.gateAllowanceParts.length, 0, 'no lamp shelved');
    const lf = o.flags.filter(f => f._lampPairLimit);
    assert.equal(lf.length, 1, 'exactly ONE limit flag for the pair, not one per lamp');
    assert.equal(lf[0].reason, LAMP_PAIR_LIMIT_REASON);
    assert.match(lf[0].reason, /strike the line on the ledger if the inspection shows it sound\.$/, 'the batch-103 §4 voice');
    assert.ok(!o.flags.some(f => /NOT included in the repair total/i.test(f.reason || '')), 'no flag may contradict the money');
  });
}

test('TASK 3: an unconfirmed pair moves by exactly 2 × its own band (0 → 2 lamps in the total)', () => {
  for (const vrm of ['SA26KVT', 'SF69YBB']) {
    const L = load(vrm)._lampResult;
    const after = runChain([modelLamp(240), LABOUR], L, 'na').sum;
    assert.equal(after - sumPartsRealistic([LABOUR]), 2 * L.lampAllowance, vrm);
  }
});

test('TASK 3: a NULL lamp verdict on the pair is also "not iv:true" — both stay costed', () => {
  const L = load('SA26KVT')._lampResult;
  const cp = [{ panelId: 'BONNET', partName: 'Bonnet', independentlyVisible: true, zone: 'front' }];  // no HEADLAMP verdict
  const flags = [];
  const r = reconcileParts([modelLamp(240), LABOUR], L, cp, 0, null, L.lampAllowance, false, L.lampAllowance);
  const g = applyVisibilityGate(r.parts, cp, flags, L);
  assert.equal(lampRows(g.gatedParts).length, 2);
  assert.equal(g.gateAllowanceParts.length, 0);
});

test('TASK 3: A1 is NOT repealed — a lampCount 1 lamp on iv != true still leaves the total', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, 'na');
  assert.equal(o.moneyLamps.length, 0, 'A1 still governs a single-corner lamp');
  assert.equal(lampRows(o.gateAllowanceParts).length, 1);
  assert.ok(o.flags.some(f => /NOT included in the repair total/.test(f.reason)), 'with the A1 wording, which is TRUE there');
  assert.ok(!o.flags.some(f => f._lampPairLimit), 'and never the pair note');
});

test('TASK 3: the exception needs tier 2 AND lampCount 2 AND _lampPair — a pair-stamped row on lampCount 1 still falls to A1', () => {
  const flags = [];
  const g = applyVisibilityGate([mRow({ _lampPair: true, _lampOrdinal: 0 }), LABOUR], verdict('na'), flags, { tier2Fired: true, lampCount: 1, lampAllowance: 350 });
  assert.equal(lampRows(g.gatedParts).length, 0);
  assert.equal(g.gateAllowanceParts.length, 1);
});

test('TASK 3 CARDS: the unconfirmed pair shows two costed cards carrying the flag reason, no Inferred card', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, 'na');
  const cards = buildDamageCards({ gatedParts: o.gated, costedParts: verdict('na'), flaggedParts: o.flags, allowanceParts: o.allowanceParts });
  const lampCards = cards.filter(c => /headlamp/i.test(c.part || ''));
  assert.equal(lampCards.length, 2, 'one card per ledger row (each strikeable); the flag does not add a third');
  for (const c of lampCards) {
    assert.equal(c.origin, 'Visible');
    assert.equal(c.cost, L.lampAllowance);
    assert.equal(c.note, LAMP_PAIR_LIMIT_REASON, 'single source: the flag reason, never a second wording');
  }
  assert.equal(cards.filter(c => c.origin === 'Inferred').length, 0);
});

test('TASK 3 CARDS: a CONFIRMED pair (iv:true) keeps the 109C note and raises no limit flag', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L, true);
  const cards = buildDamageCards({ gatedParts: o.gated, costedParts: verdict(true), flaggedParts: o.flags, allowanceParts: [] });
  for (const c of cards.filter(c => /headlamp/i.test(c.part || ''))) assert.match(c.note, /both headlamps are costed/i);
  assert.equal(o.flags.filter(f => f._lampPairLimit).length, 0);
});

// "Theoretical on the corpus" — re-checked AFTER the change, from stored data. A mandated lamp reached
// the stored money only on iv:true (A1 shelved everything else when those baselines were written), so
// a stored pair with a mandated lamp in its money was iv:true, and the exception moves none of them.
test('TASK 3 CORPUS: all six stored pairs had a mandated lamp in the money (iv:true) — the exception moves none', () => {
  const pairs = lots().filter(v => load(v)._lampResult?.lampCount === 2);
  assert.equal(pairs.length, 6);
  for (const v of pairs) {
    const A = load(v);
    assert.ok(lampRows(A._reconciledParts).some(p => p._lampMandated), `${v}: no mandated lamp in stored money`);
    assert.ok(!(A._flaggedParts || []).some(f => /precautionary .* inspection allowance, NOT included/.test(f.reason || '')), `${v}: carries the A1 iv≠true flag`);
  }
});

// TASK 3 — NO FLAG MAY CONTRADICT THE COSTED PAIR. amalgamate can leave a HEADLAMP flag whose reason says
// the part carries no cost (2-vote cosmetic; single-MINOR, Ruling 2). Beside a pair now IN the total that
// is a contradicting report. The strings are read from the SHIPPED route.js source, never re-typed.
const ROUTE_SRC = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const AMALG = Object.fromEntries([...ROUTE_SRC.matchAll(/^const (AMALG_REASON_[A-Z_]+)\s*=\s*'([^']+)';/gm)].map(m => [m[1], m[2]]));
const CLAIMS_NO_COST = /not included in the repair (cost|total)|carries no cost|excluded from (the )?repair total/i;

test('TASK 3 FLAGS: the amalgamate reason constants were read from route.js (guard against a silent empty sweep)', () => {
  for (const k of ['AMALG_REASON_COSMETIC', 'AMALG_REASON_SINGLE_MINOR', 'AMALG_REASON_NOT_VISIBLE', 'AMALG_REASON_DISAGREE']) {
    assert.ok(AMALG[k], `${k} not found in route.js`);
  }
});

for (const [name, reason] of Object.entries(AMALG)) {
  test(`TASK 3 FLAGS: a HEADLAMP flag carrying ${name} never contradicts an unconfirmed costed pair`, () => {
    const L = load('SA26KVT')._lampResult;
    const flags = [{ panelId: 'HEADLAMP', partName: 'Headlamp', zone: 'front', weight: 'low', reason, _marker: name }];
    const cp = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: false, zone: 'front' }];
    const r = reconcileParts([modelLamp(240), LABOUR], L, cp, 0, null, L.lampAllowance, false, L.lampAllowance);
    const g = applyVisibilityGate(r.parts, cp, flags, L);
    assert.equal(lampRows(g.gatedParts).length, 2, 'guard: the pair is in the money');
    const lampFlags = flags.filter(f => f.panelId === 'HEADLAMP' || /headlamp/i.test(f.partName || ''));
    for (const f of lampFlags) assert.ok(!CLAIMS_NO_COST.test(f.reason), `${name}: a lamp flag still says no cost: ${f.reason}`);
    assert.equal(flags.filter(f => f._lampPairLimit).length >= 1, true, 'the limit is stated');
    if (CLAIMS_NO_COST.test(reason)) {
      assert.equal(flags.length, 1, `${name}: rewritten in place, not joined by a second flag`);
      assert.equal(flags[0]._marker, name, 'its markers are kept, so the §2 invariant still sees a flag for the panel');
      assert.equal(flags[0].reason, LAMP_PAIR_LIMIT_REASON);
    } else {
      assert.equal(flags.find(f => f._marker === name).reason, reason, `${name} makes no cost claim — left exactly as it was`);
    }
  });
}

test('TASK 3 FLAGS: a no-cost HEADLAMP flag is NOT rewritten on a lampCount 1 lot (A1 — the lamp really is out of the total)', () => {
  const L = load('AK75RDX')._lampResult;
  const flags = [{ panelId: 'HEADLAMP', partName: 'Headlamp', zone: 'front', weight: 'low', reason: AMALG.AMALG_REASON_SINGLE_MINOR }];
  const cp = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: false, zone: 'front' }];
  const r = reconcileParts([modelLamp(240), LABOUR], L, cp, 0, null, L.lampAllowance, false, L.lampAllowance);
  applyVisibilityGate(r.parts, cp, flags, L);
  assert.equal(flags[0].reason, AMALG.AMALG_REASON_SINGLE_MINOR);
});
