// Validator — failure honesty (audit C§5): a paid check that FAILED at the provider must not read as
// "…not available for this vehicle". £0: pure classifier + structural checks on route/render sources.
//
// The defect: extractApiResult collapsed "provider errored" and "genuinely not held" into one null,
// so the report blamed the customer's car for our supplier failure — and (C§6) never refunded it.
//
// Run: node scripts/validate-failure-honesty.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyApiResult, isProviderFailure, extractApiResult } from '../lib/apiOutcome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── 1. classifyApiResult — the three states separated at the source ───────────────────────────────
console.log('\n1. classifyApiResult separates provider-error / empty / usable');
assert('top-level error → reason error, no result', classifyApiResult({ error: 'boom' }), { ok: false, reason: 'error', result: null });
assert('result.error → reason error', classifyApiResult({ result: { error: 'boom' } }), { ok: false, reason: 'error', result: null });
assert('null (empty body) → reason empty', classifyApiResult(null), { ok: false, reason: 'empty', result: null });
assert('undefined → reason empty', classifyApiResult(undefined), { ok: false, reason: 'empty', result: null });
// THE CRITICAL ONE: a clean qty:0 is a USABLE result (state 1), never a failure.
assert('a clean qty:0 result is ok (state 1), NOT a failure', classifyApiResult({ result: { condition_data_qty: 0 } }), { ok: true, reason: null, result: { condition_data_qty: 0 } });
assert('a populated result unwraps from .result', classifyApiResult({ result: { retail_low_valuation: 1000 } }).result, { retail_low_valuation: 1000 });
assert('a bare object with no .result wrapper is the result', classifyApiResult({ high_risk_data_qty: 2 }).result, { high_risk_data_qty: 2 });

// ── 2. isProviderFailure — the single shared predicate for wording + refund ───────────────────────
console.log('\n2. isProviderFailure — refund/‘could not be completed’ on failure ONLY');
ok('error is a failure', isProviderFailure('error'));
ok('empty is a failure', isProviderFailure('empty'));
ok("'ok' is NOT a failure", !isProviderFailure('ok'));
ok('null is NOT a failure', !isProviderFailure(null));
ok('undefined is NOT a failure (block not requested)', !isProviderFailure(undefined));

// ── 3. extractApiResult back-compat — unchanged for the ~10 callers ───────────────────────────────
console.log('\n3. extractApiResult back-compat');
assert('ok → the result object', extractApiResult({ result: { a: 1 } }), { a: 1 });
assert('error → null (as before)', extractApiResult({ error: 'x' }), null);
assert('empty → null (as before)', extractApiResult(null), null);

// ── 4. STRUCTURAL — the route carries per-block outcomes and the renders read them ────────────────
console.log('\n4. Wiring: route builds _checkOutcomes; web + PDF pick honest wording');
{
  const route = read('app/api/vehicle/route.js');
  ok('route classifies AutoCheck into an outcome', route.includes('classifyApiResult(autocheck)'));
  ok('route classifies valuation into an outcome', route.includes('classifyApiResult(valuation)'));
  ok('route ships _checkOutcomes in the GB payload', route.includes('_checkOutcomes: checkOutcomes'));
  ok('AutoCheck outcome keyed as autocheck (covers all six Experian blocks)', route.includes('checkOutcomes.autocheck'));

  const page = read('app/payment-success/page.js');
  ok('web reads the per-block outcome (checkFailed)', page.includes("o === 'error' || o === 'empty'"));
  ok('web routes the write-off empty state through emptyText', page.includes("emptyText(result, 'autocheck', 'Write-off data not available for this vehicle')"));
  ok('web routes valuation through emptyText', page.includes("emptyText(result, 'valuation',"));
  ok('web routes market-demand through emptyText', page.includes("emptyText(result, 'market_demand',"));
  ok('web failure copy says "could not be completed", not "not available"', page.includes('could not be completed'));

  const pdf = read('app/api/generate-pdf/route.js');
  ok('PDF distinguishes a provider failure (providerFailed)', pdf.includes('_checkOutcomes?.[block]'));
  ok('PDF overrides the missing verdict text on a failure (verdictValue)', pdf.includes('verdictValue(v, acBlock)'));
  ok('PDF failure copy says "could not be completed"', pdf.includes('could not be completed'));
  // State 1 must not move: the PDF override only fires on v.missing AND providerFailed.
  ok('PDF override is gated on v.missing (a clean qty:0 is untouched)', pdf.includes('(v.missing && providerFailed(block))'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
