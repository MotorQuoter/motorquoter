// validate-headlamp-pair — batch 109 task C.
//
// RE-AFFIRMED by Vincent, 16 Sep 2026 (batch 142 R2, on the HV25ODX re-run): BOTH HEADLAMPS STAY
// COSTED on a full-width frontal hit. HV25ODX shipped two £350 lamp rows and that is correct —
// no change was made, and none is wanted. This file is the test that covers it.
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
  assembleVdsParts, tier2LampDisclosureFlag, LAMP_SURPLUS_LIMIT_REASON,
  lampChecklistItem, appendChecklistItem,
} from '@/lib/parts.mjs';
import { buildDamageCards } from '@/lib/damageCards.mjs';
import {
  computeLampResult, resolveLampBand, photoLampType, deriveLampType, selectStruckCornerVerdict,
} from '@/app/api/salvage/assess/route.js';
import { normaliseLot } from '@/lib/normaliseLot.js';
import { applyEdits, rowKeyFor, ledgerHash, editedVdsParts } from '@/lib/ledgerEdits.mjs';

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

// batch 157 — HALF 2 IS A BEFORE/AFTER HARNESS, AND THE CORPUS NOW HOLDS BOTH SIDES.
// Its six baselines were captured BEFORE the pair fix shipped, so each shows the OLD shape: one lamp in
// the money and one shelved. CK75ONW and HV25ODX were captured on 17 Sep, long AFTER it, so they show the
// NEW shape: the pair already in the money, nothing shelved. Judging a post-fix capture by a pre-fix
// expectation made a correct engine look broken (8 failing tests, batches 155–156). The side is now read
// off the stored SHAPE rather than a hard-coded list, so the next capture classifies itself.
const storedShape = (v) => { const A = load(v); return { costed: lampRows(A._reconciledParts).length, shelved: lampRows(A._allowanceParts).length }; };
const isPreFixPair = (v) => { const s = storedShape(v); return s.costed === 1 && s.shelved === 1; };
const storedPairs = () => lots().filter(v => load(v)._lampResult?.lampCount === 2);

test('every stored lampCount:2 lot is either a pre-fix baseline (the expected 6) or a post-fix capture', () => {
  const pairs = storedPairs();
  assert.deepEqual(pairs.filter(isPreFixPair).sort(), Object.keys(EXPECTED_MOVERS).sort(), 'the pre-fix six');
  for (const v of pairs.filter(v => !isPreFixPair(v))) {
    assert.deepEqual(storedShape(v), { costed: 2, shelved: 0 }, `${v}: a post-fix baseline must show the pair in the money`);
    assert.equal(EXPECTED_MOVERS[v], undefined, `${v}: a post-fix lot has no movement left to make`);
  }
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

  if (L.lampCount === 2 && !isPreFixPair(vrm)) {
    // batch 157: captured after the fix — there is no "before" to move, so what is asserted is the END STATE.
    test(`${vrm}: POST-FIX baseline — the pair is already in the money and nothing is shelved`, () => {
      assert.equal(lampRows(A._reconciledParts).length, 2, 'both lamps costed');
      assert.equal(lampRows(A._allowanceParts).length, 0, 'nothing shelved');
      assert.ok(lampRows(A._reconciledParts).every(p => (p.used ?? p.oem ?? 0) > 0), 'both lamps carry money');
    });
  } else if (L.lampCount === 2) {
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
// batch 112 task 1 (Vincent, 11 Sep: "Band"). This case pinned the OPEN leak in 111 — the surplus row at
// the model's £260, warned. The ruling closes it: the surplus HEADLAMP row is banded and mandated, and the
// line logs the sanctioned SURPLUS shape instead of warning.
test('1a REAL CHAIN (AK75RDX, count 1, model priced 2): CLOSED by the batch-112 ruling — both banded, SURPLUS logs', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L);
  const f = finalizeLampInstrumentation(o.gated, L);
  assert.equal(o.moneyLamps.length, 2, 'guard: this is the surplus shape');
  assert.equal(f.lamp_money_rows, 2, 'the counter reports what is in the money');
  for (const r of o.moneyLamps) assert.equal(r.used, L.lampAllowance, 'no model price survives — the band owns both');
  const c = classifyLampMoneyRows(o.gated, L, L.spanSource);
  assert.equal(c.level, 'log');
  assert.match(c.line, /^\[LAMP MONEY\]\[SURPLUS\] 2 lamp rows in parts_sum/);
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
// batch 113 changed ONE thing in these pins, deliberately: the disclosure now names both sources ("the vehicle spec
// or the listing photographs"), because "assumed" now means neither told us. The rest of each string is unchanged.
const DISC = 'Lamp type could not be confirmed from the vehicle spec or the listing photographs, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';
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
  const pairs = storedPairs();
  assert.equal(pairs.filter(isPreFixPair).length, 6, 'the six pre-fix pairs (batch 157: post-fix captures are counted apart)');
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BATCH 112 — Vincent, 11 Sep 2026: "Band and yes to the rest."
// ════════════════════════════════════════════════════════════════════════════════════════════════

const freeText = (name, used) => ({ name, action: 'replace', oem: used * 2, used });   // no panelId — as parseParts leaves a non-enum row

// ── TASK 1 — THE SURPLUS HEADLAMP ROW IS BANDED, WITH THE GUARD ───────────────────────────────────
for (const vrm of ['AK75RDX', 'KT73YAJ']) {
  test(`TASK 1: ${vrm} (lampCount 1) — a second HEADLAMP line is banded, mandated, and states its limit once`, () => {
    const L = load(vrm)._lampResult;
    assert.equal(L.lampCount, 1, 'guard: single-corner lot');
    const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L);
    assert.equal(o.moneyLamps.length, 2);
    const s = o.moneyLamps.filter(r => r._lampSurplus);
    assert.equal(s.length, 1, 'exactly one row is the surplus');
    assert.equal(s[0].used, L.lampAllowance);
    assert.equal(s[0]._lampMandated, true);
    assert.equal(s[0]._modelLampCost, 260, 'the model figure is kept only as instrumentation');
    const lf = o.flags.filter(f => f._lampSurplusLimit);
    assert.equal(lf.length, 1);
    assert.equal(lf[0].reason, LAMP_SURPLUS_LIMIT_REASON);
    assert.match(lf[0].reason, /strike the line on the ledger if the inspection shows it sound\.$/, 'the batch-103 §4 voice');
    assert.ok(!/^Neither/.test(lf[0].reason), '"neither" is false here — the kept lamp IS confirmed');
  });
}

test('TASK 1: the surplus moves the total by exactly (band − model) on that row', () => {
  const L = load('AK75RDX')._lampResult;
  const after = runChain([modelLamp(240), modelLamp(260), LABOUR], L).sum;
  const lampless = sumPartsRealistic([LABOUR]);
  assert.equal(after - lampless, 2 * L.lampAllowance, 'both lamps at band');
});

test('TASK 1: a THIRD HEADLAMP line on a lampCount 1 lot is dropped, not banded (a vehicle has two)', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(260), modelLamp(280), LABOUR], L);
  assert.equal(o.moneyLamps.length, 2);
  assert.equal(o.allowanceParts.length, 0, 'and not shelved');
});

test('TASK 1: no surplus row, no surplus flag — a lampCount 1 lot with one lamp is exactly as before', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  assert.equal(o.moneyLamps.length, 1);
  assert.ok(!o.moneyLamps[0]._lampSurplus);
  assert.equal(o.flags.length, 0);
});

test('TASK 1: the surplus on iv != true falls to A1 with the kept lamp — nothing banded into the total', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L, 'na');
  assert.equal(o.moneyLamps.length, 0);
  assert.ok(!o.flags.some(f => f._lampSurplusLimit), 'no "included in the repair total" note on a lamp that is not');
});

// THE GUARD. Only a genuinely HEADLAMP-panel row is band-priced.
for (const name of ['Headlamp bracket', 'Headlamp washer jet', 'Headlight bulb']) {
  test(`TASK 1 GUARD: "${name}" (lamp-named, no HEADLAMP panelId) is NEVER billed at the band`, () => {
    const L = load('AK75RDX')._lampResult;
    const o = runChain([modelLamp(240), freeText(name, 40), LABOUR], L);
    const row = o.gated.find(r => r.name === name);
    assert.ok(row, 'the row survives in the money');
    assert.equal(row.used, 40, 'at its own figure — a £40 part never bills at £350');
    assert.ok(!row._lampMandated && !row._lampSurplus);
    const c = classifyLampMoneyRows(o.gated, L, L.spanSource);
    assert.equal(c.level, 'warn');
    assert.match(c.line, /^\[LAMP MONEY\]\[UNIDENTIFIED\]/, 'reported as unidentified, not repriced');
    assert.ok(!/INVARIANT BROKEN/.test(c.line), 'and not called a breach — the band does not own it');
  });
}

test('TASK 1 GUARD: a lamp-named row first + ONE HEADLAMP row is not turned into a surplus (no second lamp billed)', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([freeText('Headlamp bracket', 40), modelLamp(240), LABOUR], L);
  assert.equal(o.gated.filter(r => r._lampSurplus).length, 0, 'one HEADLAMP row is the lamp, not a surplus');
  assert.equal(o.gated.filter(r => r._lampMandated).length, 1, 'exactly one lamp is band-owned');
});

// THE RESIDUAL, stated and pinned: a free-text PLURAL lamp row with no panelId is not band-priced. It
// stays at the model's figure and is reported UNIDENTIFIED. Call 1's grammar requires a PANEL_ID on
// every row (config/assessmentEngine.js:115-117) and all 14 recorded runs obey it — the only free-text
// row in the corpus is "Labour & paint" — so this shape needs a grammar break the corpus has never shown.
test('TASK 1 RESIDUAL: "Headlamps (pair)" with no panelId stays at the model price and is reported, not repriced', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), freeText('Headlamps (pair)', 480), LABOUR], L);
  assert.equal(o.gated.find(r => r.name === 'Headlamps (pair)').used, 480);
  assert.match(classifyLampMoneyRows(o.gated, L, L.spanSource).line, /^\[LAMP MONEY\]\[UNIDENTIFIED\]/);
});

test('TASK 1: a HEADLAMP-panel row at a non-band price is STILL a breach (NOT BAND-OWNED, INVARIANT BROKEN)', () => {
  const c = classifyLampMoneyRows([mRow(), unowned(260), LABOUR], T2C1, 'single_corner');
  assert.match(c.line, /^\[LAMP MONEY\]\[NOT BAND-OWNED\].*INVARIANT BROKEN: the band owns every headlamp pound/);
});

test('TASK 1 CARDS: the surplus card carries the flag reason; the kept lamp card does not', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L);
  const cards = buildDamageCards({ gatedParts: o.gated, costedParts: verdict(true), flaggedParts: o.flags, allowanceParts: [] });
  const lampCards = cards.filter(c => /headlamp/i.test(c.part || ''));
  assert.equal(lampCards.length, 2);
  assert.equal(lampCards.filter(c => c.note === LAMP_SURPLUS_LIMIT_REASON).length, 1);
  assert.equal(cards.filter(c => c.origin === 'Related').length, 0, 'the flag does not add a £0 third card');
});

// ── TASK 2 — THE ASSUMED-TYPE DISCLOSURE REACHES THE BUYER ON TIER 2 ─────────────────────────────
const DISCLOSURE = ROUTE_SRC.match(/^const LAMP_ASSUMED_DISCLOSURE = '([^']+)';/m)[1];   // the shipped single owner

test('TASK 2: tier 2 + assumed type + a lamp in the money → exactly one disclosure flag, the shipped sentence', () => {
  const r = computeLampResult('central', true, null, 'cannot_determine', null, 'full_width', false);
  assert.equal(r.lampTypeAssumed, true, 'guard');
  const o = runChain([modelLamp(240), LABOUR], r);
  const f = tier2LampDisclosureFlag(r, o.gated, o.flags, DISCLOSURE);
  assert.ok(f);
  assert.equal(f.reason, DISCLOSURE);
  assert.equal(f._tier2LampDisclosure, true);
  assert.equal(tier2LampDisclosureFlag(r, o.gated, [...o.flags, f], DISCLOSURE), null, 'one per lot');
});

test('TASK 2: no disclosure when the type is concrete, when no lamp is in the money, on tier 1, or beside the orphan flag', () => {
  const concrete = computeLampResult('central', true, 'led', 'cannot_determine', null, 'full_width', false);
  const assumed  = computeLampResult('central', true, null,  'cannot_determine', null, 'full_width', false);
  assert.equal(tier2LampDisclosureFlag(concrete, runChain([modelLamp(240), LABOUR], concrete).gated, [], DISCLOSURE), null);
  assert.equal(tier2LampDisclosureFlag(assumed, [LABOUR], [], DISCLOSURE), null, 'no lamp in the money — nothing to disclose');
  assert.equal(tier2LampDisclosureFlag({ ...assumed, tier2Fired: false }, [mRow()], [], DISCLOSURE), null);
  assert.equal(tier2LampDisclosureFlag(assumed, [mRow()], [{ _orphanLampDisclosure: true }], DISCLOSURE), null);
});

test('TASK 2: route.js pushes the helper\'s flag and holds the ONLY copy of the sentence (single owner)', () => {
  assert.match(ROUTE_SRC, /tier2LampDisclosureFlag\(lampResult, gatedParts, coreObs\.flaggedParts, LAMP_ASSUMED_DISCLOSURE\)/);
  const partsSrc = readFileSync('lib/parts.mjs', 'utf8');
  assert.ok(!partsSrc.includes(DISCLOSURE.slice(0, 40)), 'lib/parts.mjs must not carry a copy of the disclosure');
  assert.equal(ROUTE_SRC.split(DISCLOSURE.slice(0, 40)).length - 1, 1, 'exactly one copy in route.js');
});

// ── TASK 3 — THE VDS NEVER SAYS "NOT PRESENT" FOR A PAIR OR SURPLUS HALF ─────────────────────────
test('TASK 3: pair — inserted half (model priced 1) no longer claims "Not present in the listing photos"', () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  const vds = assembleVdsParts(verdict(true), o.gated).filter(b => /headlamp/i.test(b.partName));
  assert.equal(vds.length, 2);
  for (const b of vds) assert.equal(b.prose, `Replace — £${L.lampAllowance}.`);
});

test('TASK 3: pair — a pooled "missing" ledger (AMZ3790 shape) cannot be pinned to either lamp, so neither claims it', () => {
  const L = load('AMZ3790')._lampResult;
  const led = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: true, zone: 'front', _amalgMissing: true }];
  const o = runChain([modelLamp(240), modelLamp(240), LABOUR], L);
  for (const b of assembleVdsParts(led, o.gated).filter(b => /headlamp/i.test(b.partName))) {
    assert.ok(!/Not present in the listing photos/.test(b.prose), b.prose);
  }
});

test('TASK 3: the surplus half never claims it either', () => {
  const L = load('AK75RDX')._lampResult;
  const led = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: true, zone: 'front', _amalgMissing: true }];
  const o = runChain([modelLamp(240), modelLamp(260), LABOUR], L);
  const lamps = assembleVdsParts(led, o.gated).filter(b => /headlamp/i.test(b.partName));
  assert.equal(lamps.filter(b => /Not present/.test(b.prose)).length, 1, 'the kept lamp keeps the true ledger claim; the surplus does not borrow it');
});

test('TASK 3 KEPT: a non-pair lamp on a "missing" ledger still says "Not present in the listing photos" (true there)', () => {
  const L = load('AK75RDX')._lampResult;
  const led = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: true, zone: 'front', _amalgMissing: true }];
  const o = runChain([modelLamp(240), LABOUR], L);
  assert.equal(assembleVdsParts(led, o.gated).find(b => /headlamp/i.test(b.partName)).prose, `Not present in the listing photos — replace, £${L.lampAllowance}.`);
});

test('TASK 3 KEPT: a non-pair _inserted row is byte-identical to before (wording unchanged by this batch)', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([LABOUR], L);   // model priced 0 lamps on lampCount 1 → one inserted lamp
  assert.equal(assembleVdsParts(verdict(true), o.gated).find(b => /headlamp/i.test(b.partName)).prose, `Not present in the listing photos — replace, £${L.lampAllowance}.`);
});

test('TASK 3 KEPT: a missing non-lamp panel keeps its wording', () => {
  const led = [{ panelId: 'GRILLE', partName: 'Grille', independentlyVisible: true, zone: 'front', _amalgMissing: true }];
  const out = assembleVdsParts(led, [{ panelId: 'GRILLE', name: 'Grille', action: 'replace', used: 70 }]);
  assert.equal(out[0].prose, 'Not present in the listing photos — replace, £70.');
});

// ── TASK 4 — THE PAIR EXCEPTION IS FOR UNCERTAINTY, NOT CLEAN LAMPS ──────────────────────────────
test('TASK 4: a _perViewClear pair (every view saw the lamps undamaged) is NOT costed — it falls to A1', () => {
  const L = load('SA26KVT')._lampResult;
  const cp = [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: false, zone: 'front', _perViewClear: true }];
  const flags = [];
  const r = reconcileParts([modelLamp(240), LABOUR], L, cp, 0, null, L.lampAllowance, false, L.lampAllowance);
  const g = applyVisibilityGate(r.parts, cp, flags, L);
  assert.equal(lampRows(g.gatedParts).length, 0, 'no money for lamps the photos show as sound');
  assert.equal(g.gateAllowanceParts.length, 2);
  assert.ok(!flags.some(f => f._lampPairLimit), 'and no "included in the repair total" note');
  assert.ok(flags.some(f => /NOT included in the repair total/.test(f.reason)), 'the A1 wording, true there');
});

test('TASK 4: an UNCERTAIN pair (iv na / false without _perViewClear / no verdict) is still costed, as ruled in 111', () => {
  const L = load('SA26KVT')._lampResult;
  for (const iv of ['na', false]) assert.equal(runChain([modelLamp(240), LABOUR], L, iv).moneyLamps.length, 2, `iv=${iv}`);
});

test('TASK 4 CORPUS: still theoretical — no stored pair lot is _perViewClear or iv != true (all six had a lamp in the money)', () => {
  for (const v of lots().filter(v => load(v)._lampResult?.lampCount === 2)) {
    assert.ok(lampRows(load(v)._reconciledParts).some(p => p._lampMandated), v);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BATCH 113 — Vincent, 11 Sep 2026: "Let the photo set the band with the user having the option to
// correct it." The photograph's type sets the band; the spec is the fallback; LED only when neither.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── resolveLampBand — THE PRECEDENCE, INVERTED ───────────────────────────────────────────────────
const BAND = { halogen: 150, hid: 250, led: 350 };
for (const spec of ['halogen', 'hid', 'led', 'indeterminate', null]) {
  for (const photo of ['halogen', 'hid', 'led', 'indeterminate', null]) {
    test(`113 PRECEDENCE: spec=${spec} photo=${photo}`, () => {
      const r = resolveLampBand(spec, photo);
      const want = BAND[photo] ? photo : BAND[spec] ? spec : 'led';
      assert.equal(r.resolvedType, want, 'photo, then spec, then the LED default');
      assert.equal(r.bandValue, BAND[want]);
      assert.equal(r.lampTypeSource, BAND[photo] ? 'photo' : BAND[spec] ? 'spec' : 'default');
      assert.equal(r.lampTypeAssumed, !BAND[photo] && !BAND[spec], 'assumed ONLY when neither source resolves');
    });
  }
}

test('113 PRECEDENCE: the photograph can now move the band DOWN as well as up (the pre-113 code never could)', () => {
  assert.equal(resolveLampBand('led', 'halogen').bandValue, 150);
  assert.equal(resolveLampBand('halogen', 'led').bandValue, 350);
  assert.equal(resolveLampBand(null, 'hid').bandValue, 250);
});

test('113 NORMALISATION: detection type is trimmed + lower-cased; off-enum words count as "could not tell"', () => {
  assert.equal(resolveLampBand(null, ' LED ').lampTypeSource, 'photo');
  for (const w of ['xenon', 'matrix', 'laser', '', 'unknown']) {
    assert.equal(resolveLampBand('halogen', w).resolvedType, 'halogen', `"${w}" must fall back to the spec`);
  }
});

// ── photoLampType — the type comes from the corner that SHOWS it ─────────────────────────────────
test('113 PHOTO TYPE: the struck corner wins when it resolves a type', () => {
  const c = [{ verdict: 'missing', lamp_type: 'hid' }, { verdict: 'present', lamp_type: 'led' }];
  assert.equal(photoLampType(c, c[0]), 'hid');
});

test('113 PHOTO TYPE: a missing struck corner reads "indeterminate" — the other corner supplies the type', () => {
  const c = [{ verdict: 'missing', lamp_type: 'indeterminate' }, { verdict: 'present', lamp_type: 'led' }];
  assert.equal(photoLampType(c, c[0]), 'led');
});

test('113 PHOTO TYPE: nothing resolved → null; empty / absent → null', () => {
  assert.equal(photoLampType([{ lamp_type: 'indeterminate' }, { lamp_type: 'indeterminate' }], null), null);
  assert.equal(photoLampType([], null), null);
  assert.equal(photoLampType(null, null), null);
});

// ── THE CORPUS, from the recorded lamp-detect responses (they still replay on all 12 lots that have one)
const cassetteLampDetect = v => {
  for (const arr of Object.values(JSON.parse(readFileSync(`${FIX}/${v}/model-cassette.json`, 'utf8')))) for (const s of arr) {
    let j; try { j = JSON.parse(s); } catch { continue; }
    const t = (j.content || []).find(b => b.type === 'text')?.text || '';
    if (/corner_descriptor/.test(t)) return JSON.parse(t.match(/\[[\s\S]*\]/)[0]);
  }
  return null;
};
const fixtureVd = v => normaliseLot(JSON.parse(readFileSync(`${FIX}/${v}/fixture.json`, 'utf8')).vehicleDetails || {});
const struckOf = corners => selectStruckCornerVerdict(corners);   // the real engine function

const MOVERS_113 = { SF69YBB: { before: 150, after: 350 } };   // the ONLY lot whose band moves
for (const v of lots()) {
  const corners = cassetteLampDetect(v);
  if (!corners) {
    test(`113 CORPUS ${v}: no recorded lamp-detect response — the photograph cannot set this lot's band`, () => {
      assert.ok(['EN23NJX', 'FE68AOP'].includes(v), `${v} was expected to carry a lamp-detect response`);
    });
    continue;
  }
  test(`113 CORPUS ${v}: band before → after the inversion`, () => {
    const spec = deriveLampType(fixtureVd(v));
    const photo = photoLampType(corners, struckOf(corners));
    const beforeType = BAND[spec] ? spec : 'led';        // pre-113: concrete spec wins; else LED (detection could never exceed LED)
    const after = resolveLampBand(spec, photo);
    const expect = MOVERS_113[v] ?? { before: BAND[beforeType], after: BAND[beforeType] };
    assert.equal(BAND[beforeType], expect.before, 'pre-113 band');
    assert.equal(after.bandValue, expect.after, 'post-113 band');
    // batch 157: the source is 'photo' only where the photograph actually NAMED a type. CK75ONW is the
    // corpus's first lot where it did not: both corners read lamp_type "indeterminate" (the intact corner's
    // own evidence says "only the DRL strip is clearly legible so the main-beam type cannot be confirmed"),
    // so photoLampType returns null and the band falls back to the default — which is exactly what the unit
    // test "113 PHOTO TYPE: nothing resolved → null" already pins. The old flat assert was a statement of
    // fact about a 14-lot corpus, not a rule; the rule is derived from the data here.
    const named = corners.some((c) => BAND[String(c.lamp_type || '').trim().toLowerCase()]);
    assert.equal(after.lampTypeSource, named ? 'photo' : 'default',
      `${v}: the photograph ${named ? 'named a type, so it must set the source' : 'named no type on either corner, so the source must fall back'}`);
  });
}

test('113 CORPUS: every concrete type the photograph read on the corpus is LED — it has never been shown a halogen or HID lamp', () => {
  const seen = new Set();
  for (const v of lots()) for (const c of (cassetteLampDetect(v) || [])) if (BAND[c.lamp_type]) seen.add(c.lamp_type);
  assert.deepEqual([...seen], ['led']);
});

test('113 CORPUS: SF69YBB (Civic, spec halogen, photo LED on both corners) moves by +£200 per lamp; as a pair, +£400', () => {
  const L0 = load('SF69YBB')._lampResult;
  const r = computeLampResult('central', true, deriveLampType(fixtureVd('SF69YBB')), 'present', photoLampType(cassetteLampDetect('SF69YBB'), null), 'full_width', false);
  assert.equal(L0.lampAllowance, 150, 'guard: stored pre-113 band');
  assert.equal(r.lampAllowance, 350);
  assert.equal(r.lampTypeSource, 'photo');
  const before = runChain([modelLamp(180), modelLamp(180), LABOUR], L0).sum;
  const after = runChain([modelLamp(180), modelLamp(180), LABOUR], r).sum;
  assert.equal(after - before, 400);
});

test('113 CORPUS: AMZ3790 + YH23NVW — struck lamp missing, type read from the intact corner → photo-sourced LED, NOT assumed', () => {
  for (const v of ['AMZ3790', 'YH23NVW']) {
    const corners = cassetteLampDetect(v);
    const r = computeLampResult('central', true, deriveLampType(fixtureVd(v)), 'missing', photoLampType(corners, struckOf(corners)), 'full_width', false);
    assert.equal(r.lampTypeSource, 'photo', v);
    assert.equal(r.lampTypeAssumed, false, `${v}: the photograph showed LED — nothing is assumed`);
    assert.equal(r.lampAllowance, 350, `${v}: band unchanged`);
  }
});

test('113 DISCLOSURE: fires only when NEITHER source told us, and now names both sources', () => {
  const none = computeLampResult('central', true, null, 'cannot_determine', null, 'full_width', false);
  const photo = computeLampResult('central', true, null, 'cannot_determine', 'led', 'full_width', false);
  const o1 = runChain([modelLamp(240), LABOUR], none);
  const o2 = runChain([modelLamp(240), LABOUR], photo);
  assert.ok(tier2LampDisclosureFlag(none, o1.gated, [], DISCLOSURE));
  assert.equal(tier2LampDisclosureFlag(photo, o2.gated, [], DISCLOSURE), null, 'the photograph told us — no "assumed" note');
  assert.match(DISCLOSURE, /could not be confirmed from the vehicle spec or the listing photographs/);
});

test('113 ORPHAN: the tier-1 orphan band follows the same precedence (photograph first)', () => {
  const { bandValue, lampTypeAssumed } = resolveLampBand('indeterminate', 'halogen');
  const r = reconcileParts([modelLamp(240), LABOUR], null, [], 0, null, bandValue, lampTypeAssumed, 350);
  assert.equal(r.parts.find(p => p._lampMandated).used, 150, 'a halogen-read orphan lamp clamps to the halogen band');
  assert.ok(!r.parts.find(p => p._lampMandated)._orphanAssumedDisclosure, 'and is not "assumed"');
});

test('113 WIRING: route.js feeds the photograph\'s type to BOTH band resolutions', () => {
  assert.match(ROUTE_SRC, /const photoType\s+= photoLampType\(lampDetectionRaw, detectedCorner\);/);
  assert.match(ROUTE_SRC, /detectedCorner\?\.verdict\s+\|\| null,\s*\n\s*photoType,/);
  assert.match(ROUTE_SRC, /resolveLampBand\(_specLampType, photoType\)/);
  assert.ok(!/resolveLampBand\(_specLampType, null\)/.test(ROUTE_SRC), 'the orphan path must not pass detection as null any more');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BATCH 114 TASK 2 — the struck-side headlamp ask is back in the WhatsApp checklist (Vincent: "yes")
// ════════════════════════════════════════════════════════════════════════════════════════════════
const ASK = computeLampResult('offside', true, 'led', 'present', null, 'single_corner', false).checklistEntry;

test('114 CHECKLIST: tier 2 with a lamp in the money → the shipped checklistEntry, verbatim', () => {
  const L = load('AK75RDX')._lampResult;
  const o = runChain([modelLamp(240), LABOUR], L);
  assert.equal(lampChecklistItem(L), L.checklistEntry);
  assert.match(ASK, /^Show the struck-side headlamp aperture with the bumper pulled clear — confirm the actual headlamp type/);
});

// batch 115 (Vincent, 11 Sep: "close it") REVERSES the 114 pin that a shelved lamp gets no item: the ask is
// now on tier 2 ALONE — the shelved (A1) lamp is the one the engine could not confirm, where it matters most.
test('115 CHECKLIST: an A1-SHELVED lamp (nothing in the money) now gets the ask too; tier 1 still gets none', () => {
  const L = load('AK75RDX')._lampResult;
  const shelved = runChain([modelLamp(240), LABOUR], L, 'na');
  assert.equal(shelved.moneyLamps.length, 0, 'guard: the lamp really is shelved');
  assert.equal(lampChecklistItem(L), L.checklistEntry, 'tier 2 alone — costed or shelved');
  assert.equal(lampChecklistItem({ ...L, tier2Fired: false }), null);
  assert.equal(lampChecklistItem(null), null);
});

test('114 CHECKLIST: appended exactly like every code-owned item — numbered after the last numbered item', () => {
  assert.equal(appendChecklistItem('1. A\n2. B\n3. C', ASK), `1. A\n2. B\n3. C\n4. ${ASK}`);
  assert.equal(appendChecklistItem('- a bullet item', ASK), `- a bullet item\n1. ${ASK}`, 'same rule as the existing appenders');
  assert.equal(appendChecklistItem('', ASK), '', 'an empty section is left alone, as the existing appenders do');
  assert.equal(appendChecklistItem('1. A', null), '1. A');
});

test('114 CHECKLIST: route.js appends it post-gate through the helpers; only ONE of the four dark strings returns', () => {
  assert.match(ROUTE_SRC, /lampChecklistItem\(lampResult\)/);   // batch 115: tier 2 alone — no money argument
  assert.match(ROUTE_SRC, /appendChecklistItem\(_before, _lampAsk\)/);
  const code = ROUTE_SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');   // code, not comments
  for (const dark of ['verdictLine', 'costDriverEntry', 'tier1Line']) {
    assert.ok(!new RegExp(`lampResult\\??\\.${dark}\\b`).test(code), `${dark} must stay dark`);
  }
});

test('114 CORPUS: the stored lots that gain the item are exactly the tier-2 lots with a lamp in the money', () => {
  // batch 157: the expected set is DERIVED from the rule this test is named after, not pinned as a list.
  // The old list was the 14-lot corpus; batch 154 added CK75ONW and HV25ODX, both tier 2 with £700 of lamp
  // money, and both correctly gain the item. A hard-coded list made a correct engine look broken, and would
  // again on the next lot. Checked on all 16: gain ⇔ (tier 2 AND lamp money > 0), no exceptions.
  const lampMoney = (v) => lampRows(load(v)._reconciledParts).reduce((n, p) => n + (p.used ?? p.oem ?? 0), 0);
  const gain     = lots().filter(v => lampChecklistItem(load(v)._lampResult) != null);
  const expected = lots().filter(v => load(v)._lampResult?.tier === 2 && lampMoney(v) > 0);
  assert.deepEqual(gain, expected);
  assert.ok(gain.includes('CK75ONW') && gain.includes('HV25ODX'), 'the batch 154 lots are in the corpus');
  assert.ok(gain.length >= 12, `expected the tier-2 majority to gain the item, got ${gain.length}`);
});

test('114 SINGLE OWNER: HEADLAMP_BANDS lives only in lib/lampBands.mjs — route.js imports it and holds no copy', () => {
  assert.ok(!/const HEADLAMP_BANDS\s*=/.test(ROUTE_SRC), 'route.js must not define its own band table');
  assert.match(ROUTE_SRC, /import \{ HEADLAMP_BANDS, HEADLAMP_BAND_DEFAULT \} from '@\/lib\/lampBands\.mjs';/);
  const ledgerSrc = readFileSync('lib/ledgerEdits.mjs', 'utf8');
  assert.match(ledgerSrc, /from '\.\/lampBands\.mjs'/, 'the edit layer prices from the same owner');
  assert.ok(!/halogen:\s*150/.test(ledgerSrc) && !/halogen:\s*150/.test(ROUTE_SRC), 'no second literal copy of the band values');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BATCH 115 TASK 1 — THE VISIBLE DAMAGE SUMMARY THROUGH THE EDIT LAYER (Vincent: "fix it")
// The trap (Cowork): a filter whose keys match nothing looks exactly like one that works. So every case
// below asserts a MATCH actually happened — never only that the code ran.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// A ledger built to break a per-panel QUEUE key: a FRONT_STRUCTURE £500 jig floor (skipped by the VDS)
// sits BEFORE a second FRONT_STRUCTURE row that the VDS does print. A queue would hand that printed row
// FRONT_STRUCTURE#0 — the floor's key. Also: a costed pair (two HEADLAMP), two identical fog lamps, a
// panelless line, and labour (skipped).
const vdsLedger = () => {
  const L = load('SA26KVT')._lampResult;
  const o = runChain([modelLamp(240), modelLamp(240), LABOUR], L);          // two band-owned HEADLAMP rows + labour
  return [
    { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', used: 500, _structFloor: true },
    { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'repair', used: 420 },
    ...o.gated.filter(r => /headlamp/i.test(r.name)),
    { panelId: 'FOG_LAMP', name: 'Fog lamp', action: 'replace', used: 70 },
    { panelId: 'FOG_LAMP', name: 'Fog lamp', action: 'replace', used: 70 },
    { name: 'Wiring loom repair', action: 'repair', used: 90 },
    { name: 'Labour & paint', action: '—', oem: 800 },
  ];
};
const asmtOf = rows => ({ _reconciledParts: rows, _partsReconciliation: { parts_sum: sumPartsRealistic(rows) } });

test('115 KEYS: every VDS block carries EXACTLY the key applyEdits gives its source row (content-checked, non-vacuous)', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const edited = applyEdits(asmtOf(rows), null);
  const byKey = new Map(edited.rows.map(r => [r._rowKey, r]));
  assert.equal(vds.length, 6, 'guard: 8 ledger rows − floor − labour = 6 printed blocks');
  let matched = 0;
  for (const b of vds) {
    const row = byKey.get(b._rowKey);
    assert.ok(row, `block "${b.partName}" carries key ${b._rowKey}, which is not a ledger key`);
    assert.equal(row.name, b.partName, `key ${b._rowKey} points at "${row.name}", not "${b.partName}"`);
    assert.ok(b.prose.includes(`£${Number(row.used ?? row.oem).toLocaleString('en-GB')}`), `block figure ≠ its ledger row (${b._rowKey})`);
    matched++;
  }
  assert.equal(matched, vds.length, 'every block matched a ledger row');
});

test('115 KEYS: the printed FRONT_STRUCTURE block is FRONT_STRUCTURE#1 — a per-panel queue would have said #0 (the floor)', () => {
  const vds = assembleVdsParts(verdict(true), vdsLedger());
  const fs = vds.filter(b => b.panelId === 'FRONT_STRUCTURE');
  assert.equal(fs.length, 1);
  assert.equal(fs[0]._rowKey, 'FRONT_STRUCTURE#1');
});

test('115 STRIKE: a struck row genuinely DISAPPEARS from the PDF VDS — and ONLY that row', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const asmt = asmtOf(rows);
  const edited = applyEdits(asmt, { stamp: ledgerHash(rows), strikes: ['FOG_LAMP#1', 'FRONT_STRUCTURE#1'], adds: [] });
  const pdf = editedVdsParts(vds, edited, { dropStruck: true });
  assert.equal(pdf.length, vds.length - 2, 'exactly the two struck blocks are gone');
  assert.equal(pdf.filter(b => b.panelId === 'FOG_LAMP').length, 1, 'one of the two identical fogs remains');
  assert.ok(!pdf.some(b => b._rowKey === 'FOG_LAMP#1'), 'the struck fog is not printed');
  assert.ok(!pdf.some(b => b.panelId === 'FRONT_STRUCTURE'), 'the struck structure block is not printed');
});

test('115 STRIKE: striking the FLOOR (FRONT_STRUCTURE#0, not printed in the VDS) removes NOTHING from the VDS', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const edited = applyEdits(asmtOf(rows), { stamp: ledgerHash(rows), strikes: ['FRONT_STRUCTURE#0'], adds: [] });
  const pdf = editedVdsParts(vds, edited, { dropStruck: true });
  assert.equal(pdf.length, vds.length, 'the printed FRONT_STRUCTURE#1 block stays — a queue key would wrongly drop it');
});

test('115 NEGATIVE: blocks whose rows were NOT struck still print, byte-identical', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const edited = applyEdits(asmtOf(rows), { stamp: ledgerHash(rows), strikes: ['FOG_LAMP#1'], adds: [] });
  const pdf = editedVdsParts(vds, edited, { dropStruck: true });
  for (const b of vds.filter(b => b._rowKey !== 'FOG_LAMP#1')) {
    const p = pdf.find(x => x._rowKey === b._rowKey);
    assert.ok(p, `${b._rowKey} vanished though it was not struck`);
    assert.equal(p.prose, b.prose);
  }
});

test('115 SCREEN: the screen keeps a struck block but marks it _struck (struck through, as its KCD is)', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const edited = applyEdits(asmtOf(rows), { stamp: ledgerHash(rows), strikes: ['FOG_LAMP#1'], adds: [] });
  const screen = editedVdsParts(vds, edited);
  assert.equal(screen.length, vds.length);
  assert.deepEqual(screen.filter(b => b._struck).map(b => b._rowKey), ['FOG_LAMP#1']);
});

test('115 RE-PRICE: a halogen correction re-prices the lamp blocks\' prose, through repriceStoredEntry', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows);
  const edited = applyEdits(asmtOf(rows), { stamp: ledgerHash(rows), strikes: [], adds: [], lampType: 'halogen' });
  const lamps = editedVdsParts(vds, edited).filter(b => b.panelId === 'HEADLAMP');
  assert.equal(lamps.length, 2);
  for (const b of lamps) assert.equal(b.prose, 'Replace — £150.');
  assert.ok(editedVdsParts(vds, edited).filter(b => b.panelId !== 'HEADLAMP').every((b, i) => b.prose === vds.filter(v => v.panelId !== 'HEADLAMP')[i].prose), 'non-lamp prose untouched');
});

test('115 OLD REPORTS: a VDS assessed before batch 115 (no _rowKey) is never matched — it prints as it always did', () => {
  const rows = vdsLedger();
  const vds = assembleVdsParts(verdict(true), rows).map(({ _rowKey, ...b }) => b);   // strip keys = a stored pre-115 report
  const edited = applyEdits(asmtOf(rows), { stamp: ledgerHash(rows), strikes: ['FOG_LAMP#1'], adds: [] });
  assert.equal(editedVdsParts(vds, edited, { dropStruck: true }).length, vds.length);
});

test('115 KEYS: assembleVdsParts derives keys with rowKeyFor over the SAME array — pinned against the real function', () => {
  const rows = vdsLedger();
  const keys = rowKeyFor(rows);
  const vds = assembleVdsParts(verdict(true), rows);
  const printedIdx = rows.map((r, i) => i).filter(i => !/labour|paint|prep/i.test(rows[i].name) && !rows[i]._structFloor);
  assert.deepEqual(vds.map(b => b._rowKey), printedIdx.map(i => keys[i]));
});

test('115 ROUTE ORDER: no gatedParts mutation after the VDS is assembled (the key identity depends on it)', () => {
  const code = ROUTE_SRC.split('\n');
  const vdsAt = code.findIndex(l => /assessment\._vdsParts = assembleVdsParts\(/.test(l));
  const storedAt = code.findIndex(l => /assessment\._reconciledParts = gatedParts;/.test(l));
  assert.ok(vdsAt > 0 && storedAt > vdsAt, 'guard: both lines found, VDS first');
  const between = code.slice(vdsAt + 1, storedAt).filter(l => !l.trim().startsWith('//'));
  assert.ok(!between.some(l => /gatedParts\s*\.\s*(splice|push|unshift|pop|shift|sort|reverse)\s*\(|gatedParts\s*\[[^\]]+\]\s*=[^=]/.test(l)),
    'a gatedParts mutation between VDS assembly and the stored ledger would desynchronise the keys');
});

test('115 WIRING: both surfaces render the VDS through editedVdsParts (screen marks, PDF drops)', () => {
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  assert.match(page, /const vdsParts = editedVdsParts\(assessment\._vdsParts \|\| \[\], edited\);/);
  assert.match(page, /p\._struck \? \{ textDecoration: 'line-through'/);
  assert.match(pdf, /const vdsParts = editedVdsParts\(assessment\._vdsParts \|\| \[\], edited, \{ dropStruck: true \}\);/);
  assert.ok(!/assessment\._vdsParts \|\| \[\];/.test(page) && !/const vdsParts = assessment\._vdsParts/.test(pdf), 'no surface still reads the raw stored VDS');
});
