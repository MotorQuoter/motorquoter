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
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
