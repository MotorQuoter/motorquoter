// Validator — batch 252 A + B: run time (maxDuration 800, the dead-run window), _runFacts, _runProgress, and the automatic
// refund of a paid run that died. £0: synthetic rows, an in-memory row store and a FAKE Stripe client only — no live
// Stripe call, no real row, no model call.
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch252-run.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RUN_MAX_SECS, STALE_RUN_SECS, STALE_FALLBACK_SECS, isRunDead, runAge, runStartStamp, settleDeadRun, isDeliveredRerun,
  RUN_DIED_REFUNDED_MESSAGE, RUN_DIED_FREE_MESSAGE, RUN_TIMED_OUT_MESSAGE, runDiedRefundFailedMessage,
} from '../lib/runLifecycle.mjs';
import { chargeRefunded } from '../lib/salvageRefund.mjs';
import { newRunFacts, runWithFacts, markPhase, recordCall, summariseRunFacts, callClass, currentRunFacts } from '../lib/runFacts.mjs';
import { checkServedModel } from '../lib/servedModel.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const route = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const quiet = () => {};

// ── A1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA1. maxDuration 800 and the dead-run window');
assert('route exports maxDuration = 800', (route.match(/export const maxDuration = (\d+);/) || [])[1], '800');
assert('RUN_MAX_SECS equals the route maxDuration', RUN_MAX_SECS, 800);
ok('the window from the start stamp exceeds maxDuration with margin (900 > 800)', STALE_RUN_SECS === 900 && STALE_RUN_SECS > RUN_MAX_SECS);
ok('the created_at fallback window is wider still (1800)', STALE_FALLBACK_SECS === 1800);
ok('the old 600 s constant is gone from the route', !/STALE_PROCESSING_SECS/.test(route));
ok('both stale guards (promo + paid) decide with isRunDead and settle with _settleDead',
  (route.match(/if \(isRunDead\((current|check)\)\) \{\s*const settled = await _settleDead\(\1, (true|false)\);/g) || []).length === 2);

// ── A3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA3. _runProgress');
const st = runStartStamp('abc123', NOW);
assert('start stamp shape', st, { sha: 'abc123', startedAt: '2026-11-19T12:00:00.000Z', phase: 'start', ms: 0 });
ok('paid path: the start stamp rides in the SAME update that claims processing',
  /const sessionUpdate = \{ status: 'processing', vehicle_details: session\.vehicle_details \};/.test(route));
ok('progress writes are filtered on status processing (a late write never touches a saved row)',
  /update\(\{ vehicle_details: \{ \.\.\._baseVd, _runProgress: stamp \} \}\)\s*\.eq\('id', salvageId\)\.eq\('status', 'processing'\)/.test(route));
ok('progress writes are drained before the final save, then _runFacts is stamped',
  /await _progressChain;\s*assessment\._runFacts = summariseRunFacts\(_facts/.test(route));
ok('a failed progress write is logged, never thrown', /\[RUN PROGRESS\] write threw/.test(route) && /\[RUN PROGRESS\] write failed/.test(route));
ok('six progress stamps: start + per-view, call1, call2, ledger-probes, finish',
  ['per-view', 'call1', 'call2', 'ledger-probes', 'finish'].every(p => route.includes(`markPhase('${p}', { stamp: true })`)));

// ── A2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nA2. _runFacts');
assert('callClass', ['per-view-12', 'notes-confirm-WINDSCREEN', 'notes-opened-bonnet', 'call1'].map(callClass), ['per-view', 'notes-confirm', 'notes-opened', 'call1']);
{
  let t = 1000; const now = () => t;
  const stamps = [];
  const store = newRunFacts({ sha: 's1', onPhase: (p, ms) => stamps.push([p, ms]), now });
  const reply = (model, usage, stop = 'end_turn') => new Response(JSON.stringify({ model, usage, stop_reason: stop, content: [{ type: 'text', text: 'x' }] }), { status: 200 });
  const bodyAfter = await runWithFacts(store, async () => {
    t = 1500; markPhase('odometer');
    const r1 = reply('claude-haiku-4-5-20251001', { input_tokens: 25000, output_tokens: 6 });
    await recordCall('haiku-odo', r1, 900);
    const kept = await r1.json();   // the caller still reads its own body
    t = 41500; markPhase('per-view', { stamp: true });
    await recordCall('per-view-3', reply('claude-fable-5-2', { input_tokens: 1618, output_tokens: 1000, cache_read_input_tokens: 7692, cache_creation_input_tokens: 0 }), 12000);
    await recordCall('call1', reply('claude-fable-5-2', { input_tokens: 40000, output_tokens: 10000 }, 'max_tokens'), 100000);
    await recordCall('notes-confirm-BONNET', reply('claude-fable-5-2', { input_tokens: 100, output_tokens: 10 }, 'refusal'), 900);
    await recordCall('call2', new Response('{}', { status: 400 }), 300);
    await recordCall('frame-zone', null, 50);
    await checkServedModel('call1', { model: 'claude-opus-4-8' }, { log: quiet, alert: async () => {} });
    t = 161500; markPhase('finish', { stamp: true });
    return kept;
  });
  const f = summariseRunFacts(store, { photos: 23 });
  ok('recordCall reads a clone: the caller still gets the full body', bodyAfter?.model === 'claude-haiku-4-5-20251001');
  assert('runMs and per-phase ms', [f.runMs, f.phasesMs], [160500, { odometer: 500, 'per-view': 40000, finish: 120000 }]);
  assert('onPhase fires only for stamp:true phases', stamps, [['per-view', 40500], ['finish', 160500]]);
  assert('served models per call class', f.servedModels, { 'haiku-odo': ['claude-haiku-4-5-20251001'], 'per-view': ['claude-fable-5-2'], call1: ['claude-fable-5-2'], 'notes-confirm': ['claude-fable-5-2'] });
  assert('stop reasons, refusals, max_tokens', [f.stopReasons, f.refusals, f.maxTokens], [{ end_turn: 2, max_tokens: 1, refusal: 1 }, 1, 1]);
  assert('HTTP errors (a 400 and a network failure) and the mismatch count', [f.httpErrors, f.mismatchCount], [2, 1]);
  // USD: haiku 25000×1 + 6×5 = 0.02503; per-view 1618×8 + 1000×40 + 7692×0.2 = 0.0544824; call1 40000×8 + 10000×40 = 0.72; confirm 100×8 + 10×40 = 0.0012
  assert('USD by model, priced from config/models.js MODEL_PRICES', f.usd, { 'claude-haiku-4-5-20251001': 0.025, 'claude-fable-5-2': 0.7757, total: 0.8007 });
  assert('token totals by model (fable)', f.tokens['claude-fable-5-2'], { calls: 3, input: 41718, output: 11010, cacheWrite: 0, cacheRead: 7692 });
  assert('extra fields carried', f.photos, 23);
}
{
  let threw = false;
  try { markPhase('x'); await recordCall('call1', new Response('{}')); } catch { threw = true; }
  ok('no store (replay harness, validators) → markPhase / recordCall are silent no-ops', !threw && currentRunFacts() === null);
}
ok('route: runAssessment runs its body inside the facts store only when the route passes one',
  /return args\?\.facts \? runWithFacts\(args\.facts, \(\) => _runAssessmentBody\(args\)\) : _runAssessmentBody\(args\);/.test(route));
ok('route: with529Retry records every reply (ok, network failure, 529-exhausted)',
  /await recordCall\(name, res, Date\.now\(\) - _t\);/.test(route) && /await recordCall\(name, null, Date\.now\(\) - _t\);/.test(route) && /exhausted: true \}\);/.test(route));
ok('route: _runFacts is stripped from every assessment sent to the browser (3 sites)',
  (route.match(/assessment: forBuyer\(/g) || []).length === 3 && /const \{ _runFacts, \.\.\.rest \} = assessment;/.test(route));

// ── B: the dead paid run ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nB. Dead runs: state transitions (synthetic rows, fake Stripe)');
function harness(row, { refunds = [], createThrows = false, claimWins = true, rereadRow = null, markThrows = false } = {}) {
  const calls = { list: 0, create: [], claim: [], mark: [], alert: [] };
  const stripe = { refunds: {
    list: async () => { calls.list++; return { data: refunds }; },
    create: async (p) => { calls.create.push(p); if (createThrows) throw new Error('card_declined'); return { id: 're_test_1', ...p }; },
  } };
  const effects = {
    claimDead: async (next) => { calls.claim.push(next); if (claimWins) row.status = next; return claimWins; },
    markRow: async (fields) => { calls.mark.push(fields); if (markThrows) throw new Error('db down'); row.vehicle_details = { ...row.vehicle_details, ...fields }; },
    reread: async () => rereadRow,
    alert: async (...a) => { calls.alert.push(a); },
  };
  return { stripe, effects, calls };
}
const paidRow = (over = {}) => ({ status: 'processing', assessment: null, created_at: ago(1000), rerun_count: 0, prior_assessment: null,
  vehicle_details: { _runProgress: { sha: 's', startedAt: ago(901), phase: 'call1', ms: 120000 } }, ...over });
const settle = (row, h, extra = {}) => settleDeadRun({ row, promo: false, salvageId: 'sal-1', paymentIntentId: 'pi_1', chargeAmount: 1499,
  stripe: h.stripe, ...h.effects, log: quiet, now: NOW, ...extra });

// dead / alive decisions
ok('T1 processing, assessment null, start stamp 901 s ago → dead', isRunDead(paidRow(), NOW));
ok('T2 start stamp 899 s ago → ALIVE (never refunded while it could still run)', !isRunDead(paidRow({ vehicle_details: { _runProgress: { startedAt: ago(899) } } }), NOW));
ok('T3 a completed run (assessment present) → never dead', !isRunDead(paidRow({ assessment: { ok: 1 } }), NOW));
ok('T4 status failed / assessed / promo_redeemed → not a dead run', ['failed', 'assessed', 'promo_redeemed'].every(s => !isRunDead(paidRow({ status: s }), NOW)));
ok('T5 no start stamp: created_at 1000 s ago → alive (fallback 1800 s)', !isRunDead(paidRow({ vehicle_details: {} }), NOW));
ok('T5b no start stamp: created_at 1801 s ago → dead', isRunDead(paidRow({ vehicle_details: {}, created_at: ago(1801) }), NOW));
assert('runAge basis', [runAge(paidRow(), NOW).basis, runAge(paidRow({ vehicle_details: {} }), NOW).basis], ['startedAt', 'created_at']);

{ // T6 paid dead → refunded once
  const row = paidRow(); const h = harness(row);
  const out = await settle(row, h);
  assert('T6 paid dead run: status processing → failed (the lock)', h.calls.claim, ['failed']);
  assert('T6 one refund for the full charge, metadata reason run-died', h.calls.create.map(c => [c.payment_intent, c.amount, c.metadata.reason, c.metadata.salvage_id]), [['pi_1', 1499, 'run-died', 'sal-1']]);
  assert('T6 row marked _refunded with reason and phase', row.vehicle_details._refunded && [row.vehicle_details._refunded.reason, row.vehicle_details._refunded.phase, row.vehicle_details._refunded.status, row.vehicle_details._refunded.refundId], ['run died', 'call1', 'refunded', 're_test_1']);
  assert('T6 buyer reply: 500, refunded:true, the approved sentence', [out.http, out.body.refunded, out.body.refundStatus, out.body.error], [500, true, 'refunded', RUN_DIED_REFUNDED_MESSAGE]);
  assert('T6 the approved sentence, verbatim', RUN_DIED_REFUNDED_MESSAGE, 'Your assessment did not complete, so we have refunded your payment in full. You can run it again from the salvage page.');
}
{ // T7 already refunded on Stripe → never twice
  const row = paidRow(); const h = harness(row, { refunds: [{ id: 're_old', amount: 1499, status: 'succeeded' }] });
  const out = await settle(row, h);
  assert('T7 charge already refunded (Stripe list covers it) → NO second refund, reply still "refunded"', [h.calls.create.length, out.body.refundStatus, row.vehicle_details._refunded.refundId], [0, 'refunded', 're_old']);
}
{ // T8 lost the race
  const row = paidRow(); const h = harness(row, { claimWins: false, rereadRow: { status: 'failed', vehicle_details: { _refunded: { status: 'refunded' } } } });
  const out = await settle(row, h);
  assert('T8 another request settled first → no Stripe call at all, same refunded reply', [h.calls.list, h.calls.create.length, out.body.error], [0, 0, RUN_DIED_REFUNDED_MESSAGE]);
  const h2 = harness(paidRow(), { claimWins: false, rereadRow: { status: 'processing', vehicle_details: {} } });
  const out2 = await settle(paidRow(), h2);
  assert('T8b lost the flip, row shows no settlement → 409, nothing done', [out2.http, h2.calls.create.length], [409, 0]);
}
{ // T9 refund fails
  const row = paidRow(); const h = harness(row, { createThrows: true });
  const out = await settle(row, h);
  assert('T9 refund failure → logged, paged once, row marked refund_failed, buyer told to contact support with the reference',
    [h.calls.alert.length, h.calls.alert[0]?.[0], row.vehicle_details._refunded.status, out.body.refunded, out.body.error],
    [1, 'run-died-refund-failed', 'refund_failed', false, runDiedRefundFailedMessage('pi_1')]);
  ok('T9 the reference is the payment intent', out.body.error.includes('(Reference: pi_1)') && out.body.error.includes('support@motorquoter.app'));
}
{ // T10 payment intent not captured
  const row = paidRow(); const h = harness(row);
  const out = await settle(row, h, { paymentIntentId: null });
  assert('T10 no payment intent → no Stripe call, refund_failed, paged', [h.calls.list, h.calls.create.length, out.body.refundStatus, h.calls.alert.length], [0, 0, 'refund_failed', 1]);
}
{ // T11 promo / free
  const row = paidRow({ vehicle_details: { promoToken: 't', _runProgress: { startedAt: ago(1000), phase: 'per-view' } } }); const h = harness(row);
  const out = await settleDeadRun({ row, promo: true, salvageId: 'sal-2', paymentIntentId: null, chargeAmount: null, stripe: null, ...h.effects, log: quiet, now: NOW });
  assert('T11 promo/free dead run: status → promo_redeemed (the same session runs again), no Stripe, the approved sentence',
    [h.calls.claim, h.calls.list, out.body.error, row.vehicle_details._runDied.phase], [['promo_redeemed'], 0, RUN_DIED_FREE_MESSAGE, 'per-view']);
  assert('T11 the approved sentence, verbatim', RUN_DIED_FREE_MESSAGE, 'Your assessment did not complete. Your free report has not been used - you can run it again.');
}
{ // T12 dead free re-run of a delivered paid report
  const row = paidRow({ rerun_count: 1, prior_assessment: { ok: 1 } }); const h = harness(row);
  const out = await settle(row, h);
  ok('T12 isDeliveredRerun', isDeliveredRerun(row));
  assert('T12 a dead RE-RUN of a delivered report → no refund (the paid report was delivered), old wording', [h.calls.create.length, out.body.error, out.body.refundStatus], [0, RUN_TIMED_OUT_MESSAGE, 'no_charge']);
}
{ // T13 mark failure never breaks the reply
  const row = paidRow(); const h = harness(row, { markThrows: true });
  const out = await settle(row, h);
  assert('T13 the row mark fails → refund still issued once and the buyer still told', [h.calls.create.length, out.body.refundStatus], [1, 'refunded']);
}
{ // T14 after the refund the retry is a new purchase: the batch 140 check sees the refund
  const r = await chargeRefunded({ refunds: { list: async () => ({ data: [{ amount: 1499, status: 'succeeded' }] }) } }, 'pi_1', 1499);
  ok('T14 after a run-died refund the batch 140 check reports refunded → the route refuses a re-run', r.refunded === true);
  ok('T14 route: the batch 140 refusal runs after the stale guard and before any image fetch',
    route.indexOf('if (isRunDead(check))') < route.indexOf('const refundCheck = await chargeRefunded(') &&
    route.indexOf('const refundCheck = await chargeRefunded(') < route.indexOf('images = await fetchImagesFromStorage('));
}
ok('route: the settle lock flips only processing rows with no assessment',
  /\.eq\('id', salvageId\)\.eq\('status', 'processing'\)\.is\('assessment', null\)\.select\('id'\)/.test(route));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
