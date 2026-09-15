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

// ── 8. batch 138 item 3 — a PAID salvage report that fails to save is refunded automatically, once ─────────────────
// £0: the Stripe client is a fake (the helper takes it as an argument); nothing reaches Stripe.
console.log('\n8. Salvage: a paid report that fails to save is refunded automatically — idempotent, promo/free never refunded');
{
  const { refundSalvageCharge, settleFailedSave, SALVAGE_REFUND_ITEM, SAVE_FAILED_REFUNDED_MESSAGE, saveFailedRefundFailedMessage } =
    await import('../lib/salvageRefund.mjs');
  const fakeStripe = (store = [], { throwOnCreate = false } = {}) => {
    const calls = { list: 0, create: [] };
    return {
      calls,
      refunds: {
        list: async (p) => { calls.list++; return { data: store.filter((r) => r.payment_intent === p.payment_intent) }; },
        create: async (p) => {
          calls.create.push(p);
          if (throwOnCreate) throw new Error('card_declined: refund not permitted');
          const r = { id: `re_fake_${calls.create.length}`, amount: p.amount, payment_intent: p.payment_intent, metadata: p.metadata, status: 'succeeded' };
          store.push(r);
          return r;
        },
      },
    };
  };
  const logs = [];
  const log = (l) => logs.push(l);
  let resets = 0;
  const resetStatus = async () => { resets++; };

  // Paid, first failure → one refund for the whole charge, tagged, the approved message.
  const store = [];
  const s1 = fakeStripe(store);
  const o1 = await settleFailedSave({ promoToken: null, salvageId: 'sess-1', paymentIntentId: 'pi_1', chargeAmount: 899, stripe: s1, resetStatus, log });
  assert('paid save failure → refunded', o1.refundStatus, 'refunded');
  ok('the status is reset (the buyer is not left in processing)', resets === 1);
  ok('exactly one Stripe refund, for the full charge (899p), on the right payment intent', s1.calls.create.length === 1 && s1.calls.create[0].amount === 899 && s1.calls.create[0].payment_intent === 'pi_1');
  ok('the refund carries metadata item + reason + salvage id', s1.calls.create[0].metadata.item === SALVAGE_REFUND_ITEM && s1.calls.create[0].metadata.reason === 'save-failed' && s1.calls.create[0].metadata.salvage_id === 'sess-1');
  ok('logged as [ASSESSMENT SAVE FAILED][REFUNDED]', logs.some((l) => l.startsWith('[ASSESSMENT SAVE FAILED][REFUNDED] salvageId=sess-1 refundId=re_fake_1 idempotent=false')));
  assert('the buyer is told they were refunded (approved wording)', o1.message, SAVE_FAILED_REFUNDED_MESSAGE);
  ok('not the generic path', o1.generic === false);

  // The same charge again (a retry that fails to save again) → NEVER refunded twice.
  const s2 = fakeStripe(store);
  const o2 = await refundSalvageCharge(s2, { paymentIntentId: 'pi_1', chargeAmount: 899, salvageId: 'sess-1', reason: 'save-failed' });
  ok('second attempt on the same payment intent → idempotent, no second refund created', o2.status === 'refunded' && o2.idempotent === true && s2.calls.create.length === 0 && o2.refundId === 're_fake_1');
  // An earlier 529 refund on the same intent also counts (one charge, one refund, whatever the reason).
  const s3 = fakeStripe([{ id: 're_529', amount: 899, payment_intent: 'pi_2', status: 'succeeded', metadata: {} }]);
  const o3 = await refundSalvageCharge(s3, { paymentIntentId: 'pi_2', chargeAmount: 899, salvageId: 'sess-2', reason: 'save-failed' });
  ok('a charge already refunded by the 529 path is not refunded again', o3.status === 'refunded' && o3.idempotent === true && s3.calls.create.length === 0);

  // Promo / free report → no refund, no Stripe, the generic path (status reset to promo_redeemed in the route catch).
  const s4 = fakeStripe([]);
  resets = 0;
  const o4 = await settleFailedSave({ promoToken: 'promo-abc', salvageId: 'sess-3', paymentIntentId: null, chargeAmount: null, stripe: s4, resetStatus, log });
  ok('promo / free report → no refund, no Stripe call, generic path', o4.generic === true && o4.refundStatus === 'no_charge' && s4.calls.list === 0 && s4.calls.create.length === 0 && resets === 0);

  // Stripe refuses → refund_failed, the approved "contact support" message with the reference.
  logs.length = 0;
  const s5 = fakeStripe([], { throwOnCreate: true });
  const o5 = await settleFailedSave({ promoToken: null, salvageId: 'sess-4', paymentIntentId: 'pi_5', chargeAmount: 899, stripe: s5, resetStatus, log });
  ok('refund refused → refund_failed, message names support and the reference', o5.refundStatus === 'refund_failed' && o5.message === saveFailedRefundFailedMessage('pi_5') && o5.message.includes('support@motorquoter.app') && o5.message.includes('(Reference: pi_5)'));
  ok('refund refused → logged [ASSESSMENT SAVE FAILED][REFUND FAILED]', logs.some((l) => l.startsWith('[ASSESSMENT SAVE FAILED][REFUND FAILED] salvageId=sess-4')));

  // Paid but the payment intent was never captured → no Stripe call, refund_failed (manual reconciliation).
  const s6 = fakeStripe([]);
  const o6 = await refundSalvageCharge(s6, { paymentIntentId: null, chargeAmount: 899, salvageId: 'sess-5' });
  ok('no payment intent captured → refund_failed, Stripe untouched', o6.status === 'refund_failed' && s6.calls.list === 0 && s6.calls.create.length === 0);

  // Route wiring (source, comments stripped).
  const assess = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const iLoud = assess.indexOf('[ASSESSMENT SAVE FAILED] salvageId=');
  const iSettle = assess.indexOf('await settleFailedSave({', iLoud);
  const iGeneric = assess.indexOf("if (outcome.generic) throw new Error('Assessment failed');", iSettle);
  const iPaid500 = assess.indexOf('return NextResponse.json({ error: outcome.message, refundStatus: outcome.refundStatus }, { status: 500 });', iGeneric);
  const iReport = assess.indexOf('return NextResponse.json({ assessment, vehicleDetails: enrichedVd,', iPaid500);
  ok('assess route: a failed save goes through settleFailedSave', iLoud > 0 && iSettle > iLoud);
  ok('assess route: promo / free → generic throw; paid → 500 with the refund message — both before the report is returned', iGeneric > iSettle && iPaid500 > iGeneric && iReport > iPaid500);
  ok('assess route: the paid status reset matches the catch (failed, only while processing)', /resetStatus: \(\) => supabase\.from\('salvage_sessions'\)\.update\(\{ status: 'failed' \}\)\.eq\('id', salvageId\)\.eq\('status', 'processing'\)/.test(assess));
  ok('assess route: the 529/overload abort refunds through the SAME helper (refundSalvageCharge)', /refundSalvageCharge\([\s\S]{0,200}reason: 'overloaded'/.test(assess));
  ok('assess route: no bare stripe refunds.create left (one idempotent path)', !/refunds\.create\(/.test(assess));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
