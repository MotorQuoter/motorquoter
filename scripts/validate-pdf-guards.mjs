// Guard validator for lib/experianHistory.mjs — proves the PDF cannot print a green all-clear when
// the Experian/HPI check never ran (Finding 1). Deterministic, no network.
// Run: node --test scripts/validate-pdf-guards.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { experianVerdict } from '../lib/experianHistory.mjs';

const KINDS = ['writeoff', 'finance', 'stolen', 'high_risk', 'plate', 'searches'];

// ── TEST 1 — the assertion that matters: a NULL provider block never reads as clean ──
test('null Experian block → "not available", never [OK]/clean (all six sections)', () => {
  for (const kind of KINDS) {
    const v = experianVerdict(null, kind);
    assert.equal(v.missing, true, kind);
    assert.doesNotMatch(v.value, /\[OK\]/, `${kind}: must not contain [OK]`);
    assert.doesNotMatch(v.value, /No write-off recorded|No finance recorded|Not recorded stolen|None recorded|No recent searches/, `${kind}: must not read as a clean result`);
    assert.match(v.value, /not available/i, `${kind}: must say unavailable`);
    assert.notEqual(v.tone, 'good', `${kind}: unavailable is never green`);
  }
});

// The IE path feeds result.hpi and the GB path result.autocheck — both null-collapse identically,
// so a null block is "missing" regardless of which market's block it came from.
test('null covers BOTH the GB (autocheck) and IE (hpi) branches — same decision', () => {
  // buildPdf selects `acRaw = isIE ? result.hpi : result.autocheck`; either being null lands here.
  assert.equal(experianVerdict(null, 'writeoff').missing, true);
  assert.equal(experianVerdict(null, 'finance').missing, true);
});

// ── TEST 2 — the one people get wrong: a REAL "checked, clear" must NOT regress to unavailable ──
test('qty 0 → genuine clean "[OK]" result, NOT "unavailable"', () => {
  const w = experianVerdict({ condition_data_qty: 0 }, 'writeoff');
  assert.equal(w.missing, false);
  assert.equal(w.value, '[OK] No write-off recorded');
  assert.equal(w.tone, 'good');

  assert.equal(experianVerdict({ finance_data_qty: 0 }, 'finance').value, '[OK] No finance recorded');
  assert.equal(experianVerdict({ stolen_vehicle_data_qty: 0 }, 'stolen').value, '[OK] Not recorded stolen');
  assert.equal(experianVerdict({ high_risk_data_qty: 0 }, 'high_risk').value, '[OK] None recorded');
  assert.equal(experianVerdict({ cherished_data_qty: 0 }, 'plate').value, '[OK] None recorded');
  assert.equal(experianVerdict({ previous_search_qty: 0 }, 'searches').value, '[OK] No recent searches');
});

// ── TEST 3 — a positive marker still flags ──
test('qty > 0 → flagged "[!]" with the right tone', () => {
  const w = experianVerdict({ condition_data_qty: 1, condition_data_items: [{ recovered_category_desc: 'CAT S' }] }, 'writeoff');
  assert.equal(w.value, '[!] Cat S');
  assert.equal(w.tone, 'bad');

  assert.equal(experianVerdict({ finance_data_qty: 1 }, 'finance').tone, 'bad');
  assert.equal(experianVerdict({ stolen_vehicle_data_qty: 1 }, 'stolen').value, '[!] Recorded as stolen');
  assert.equal(experianVerdict({ high_risk_data_qty: 2 }, 'high_risk').value, '[!] 2 markers recorded');
  assert.equal(experianVerdict({ cherished_data_qty: 1 }, 'plate').value, '1 recorded');   // plate change is neutral, not "bad"
  assert.equal(experianVerdict({ cherished_data_qty: 1 }, 'plate').tone, undefined);
});

// ── TEST 4 — empty {} (call succeeded, returned nothing meaningful) is a real clean, not missing ──
// Distinct from null: {} is "provider answered, no markers", which IS reassuring; only null is absence.
test('empty object {} is a genuine clean result, not "missing"', () => {
  const w = experianVerdict({}, 'writeoff');
  assert.equal(w.missing, false);
  assert.equal(w.value, '[OK] No write-off recorded');
});
