// Validator — auto-refund POLARITY (audit C§6). £0: the pure decision only, no Stripe.
//
// THE ONE RULE EVERYTHING HERE DEFENDS (brief §6): a paid item is auto-refunded when — and ONLY when —
// its provider call FAILED (state 2). A genuine qty:0 is a delivered clean result and must NEVER
// refund. Getting this backwards refunds nearly every sale. This is the inverse-regression guard.
//
// Run: node scripts/validate-refund-registry.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { refundableItems, REFUND_REGISTRY } from '../lib/refundRegistry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }

// ── 1. THE POLARITY — refund on provider failure ONLY, never on a clean result ────────────────────
console.log('\n1. Refund polarity (the money)');
// Bought full_history; AutoCheck came back CLEAN (qty:0 → outcome ok). NEVER refund.
assert('clean AutoCheck (ok) → NO refund', refundableItems(['full_history'], { autocheck: 'ok' }), []);
// Bought full_history; AutoCheck ERRORED → refund.
assert('AutoCheck error → refund full_history', refundableItems(['full_history'], { autocheck: 'error' }), ['full_history']);
// Bought full_history; AutoCheck empty body → refund (an empty body is a failure, not a clean result).
assert('AutoCheck empty → refund full_history', refundableItems(['full_history'], { autocheck: 'empty' }), ['full_history']);
// Not purchased, but the block somehow failed → never refund something unpaid.
assert('not purchased → no refund even if the block failed', refundableItems([], { autocheck: 'error' }), []);
// Block absent (not requested) → no refund.
assert('block outcome absent → no refund', refundableItems(['full_history'], {}), []);
assert('outcomes null → no refund', refundableItems(['full_history'], null), []);

// ── 2. Every registered item obeys the same rule ──────────────────────────────────────────────────
console.log('\n2. Each registered item, both polarities');
for (const [item, reg] of Object.entries(REFUND_REGISTRY)) {
  assert(`${item}: clean (ok) → no refund`, refundableItems([item], { [reg.block]: 'ok' }), []);
  assert(`${item}: error → refund`, refundableItems([item], { [reg.block]: 'error' }), [item]);
}

// ── 3. Multiple items — each decided on its own outcome ───────────────────────────────────────────
console.log('\n3. Mixed baskets');
// Cazana down → both market_demand and previous_adverts fail; AutoCheck fine. Refund the two Cazana items only.
assert('two same-priced Cazana items both fail → BOTH refund (not deduped)',
  refundableItems(['full_history', 'market_demand', 'previous_adverts'], { autocheck: 'ok', market_demand: 'error', previous_adverts: 'error' }).sort(),
  ['market_demand', 'previous_adverts']);
assert('the failed one refunds, the clean ones do not',
  refundableItems(['full_history', 'valuation', 'salvagehistory'], { autocheck: 'ok', valuation: 'error', salvagehistory: 'ok' }),
  ['valuation']);

// ── 4. service_history is NOT in this registry (different trigger, own evaluator) ─────────────────
console.log('\n4. service_history stays out (empty-records trigger, not provider-failure)');
ok('service_history is not a registry key', !('service_history' in REFUND_REGISTRY));
assert('a service_history basket yields nothing from this registry', refundableItems(['service_history'], { }), []);

// ── 5. STRUCTURAL — the route wires the registry and stays idempotent per item ────────────────────
console.log('\n5. Route wiring');
{
  const route = readFileSync(join(ROOT, 'app/api/vehicle/route.js'), 'utf8');
  ok('route imports refundableItems', route.includes('refundableItems'));
  ok('route carries per-item refund state to the render (_refunds)', route.includes('_refunds'));
  ok('refunds are idempotent per item via refund metadata (not by amount — two items can share a price)',
     route.includes('metadata') && route.includes("r.metadata?.item"));
  // The clean-result guard must be the pure decision, not re-derived inline.
  ok('the refund set comes from refundableItems, not an inline outcome check', route.includes('refundableItems(checks'));
  // A provider failure must NOT be frozen into the shared cache (would refund another customer).
  ok('a provider failure is not cached (anyProviderFailed guards the cache write)', route.includes('!anyProviderFailed'));

  const page = readFileSync(join(ROOT, 'app/payment-success/page.js'), 'utf8');
  ok('web confirms the refund in the failed block ("We\'ve refunded this item")', page.includes("We've refunded this item"));
  const pdf = readFileSync(join(ROOT, 'app/api/generate-pdf/route.js'), 'utf8');
  ok('PDF confirms the refund on a failed block', pdf.includes('Could not be completed - refunded'));

  // C§7 — the signal: a paid provider failure fires a throttled ops alert (auto-top-up killed the
  // balance cue). Sibling predicate isProviderFailure, not isInfraFailure.
  ok('a paid provider failure fires the oneauto-paid-call-failed ops alert', route.includes("'oneauto-paid-call-failed'"));
  ok('the alert is gated on anyProviderFailed', /anyProviderFailed\)\s*\{[\s\S]{0,600}oneauto-paid-call-failed/.test(route));
}

// ── 6. IE parity (batch 48 §8) — ie_valuation now gets the same honesty+refund as GB valuation ──────
console.log('\n6. IE failure-honesty parity');
ok('ie_valuation is a registry key', 'ie_valuation' in REFUND_REGISTRY);
ok('ie_valuation resolves its € price via cfgIE (not the GB cfg)', REFUND_REGISTRY.ie_valuation.cfgIE === 'ie_valuation');
ok('ie_valuation has its OWN block (no collision with GB valuation)',
   REFUND_REGISTRY.ie_valuation.block === 'ie_valuation' && REFUND_REGISTRY.valuation.block === 'valuation');
// Polarity, explicit.
assert('ie_valuation error → refund', refundableItems(['ie_valuation'], { ie_valuation: 'error' }), ['ie_valuation']);
assert('ie_valuation empty → refund', refundableItems(['ie_valuation'], { ie_valuation: 'empty' }), ['ie_valuation']);
assert('ie_valuation ok (delivered, maybe no bands) → NO refund', refundableItems(['ie_valuation'], { ie_valuation: 'ok' }), []);
// Inert on GB — a GB basket never carries ie_valuation, so it can never refund there.
assert('GB basket cannot refund ie_valuation', refundableItems(['full_history', 'valuation'], { autocheck: 'ok', valuation: 'ok', ie_valuation: 'error' }), []);

console.log('\n7. IE branch + render wiring');
{
  const route = readFileSync(join(ROOT, 'app/api/vehicle/route.js'), 'utf8');
  // The IE branch must run the SAME classify → outcomes → refund → alert path GB has.
  ok('IE classifies the ie_valuation provider call', route.includes('bregoOutcome') && route.includes('classifyApiResult(bregoRoiRaw)'));
  ok('IE records the ie_valuation outcome', route.includes('checkOutcomes.ie_valuation'));
  ok('IE runs the generalised evaluatePaidRefunds', /evaluatePaidRefunds\([\s\S]{0,120}checkOutcomes/.test(route));
  ok('IE payload carries _checkOutcomes and _refunds', /market: 'IE'[\s\S]{0,200}_checkOutcomes/.test(route));
  ok('IE fires the ops alert with Market: IE', route.includes('Market: IE'));
  // The IE cache write must be guarded on anyProviderFailed too (route now has two such guards: GB + IE).
  ok('both branches guard the cache on !anyProviderFailed', (route.match(/!anyProviderFailed/g) || []).length >= 2);

  const page = readFileSync(join(ROOT, 'app/payment-success/page.js'), 'utf8');
  ok('payment-success maps ie_valuation in BLOCK_TO_ITEM', /BLOCK_TO_ITEM\s*=\s*\{[^}]*ie_valuation:/.test(page));
  ok('the ie_valuation section renders on purchase, not only when bregoRoi is present',
     page.includes("checks.includes('ie_valuation') && <BregoRoiValuationSection") && !/ie_valuation'\) && result\.bregoRoi && <BregoRoiValuationSection/.test(page));
  ok('the section shows the honest failure text for ie_valuation', page.includes("emptyText(result, 'ie_valuation'"));

  const pdf = readFileSync(join(ROOT, 'app/api/generate-pdf/route.js'), 'utf8');
  ok('PDF gates the IE valuation on the purchase, not on bregoRoi presence',
     pdf.includes("isIE && has('ie_valuation')") && !/has\('ie_valuation'\) && result\.bregoRoi\)/.test(pdf));
  ok('PDF maps ie_valuation in PDF_BLOCK_TO_ITEM', /PDF_BLOCK_TO_ITEM\s*=\s*\{[^}]*ie_valuation:/.test(pdf));
  ok('PDF shows the honest failure verdict for ie_valuation', pdf.includes("}, 'ie_valuation')"));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
