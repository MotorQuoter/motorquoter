// Validator — stored-reports (paid_reports) re-open model (£0: no network, no Stripe, no supplier).
//
// The defect this defends: a paid report was SINGLE-VIEW. A refresh / tab-close / crash 403'd the
// re-open and told a paying customer "Payment could not be verified." The fix stores the served
// payload keyed on the purchase and re-opens it as a pure DB read.
//
// The two load-bearing guarantees:
//   • Test 2 (commercial): a re-open makes ZERO supplier calls — enforced structurally, the decision
//     block returns before the fetch, and decideStoredReport('serve') carries the stored payload.
//   • Test 7 (customer): expiry is HONEST — never the false "payment could not be verified".
//
// Run: node scripts/validate-stored-reports.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideStoredReport, readStoredReport, writeStoredReport, sweepExpiredStoredReports } from '../lib/paidReports.mjs';
import { STORED_REPORT_TTL_MINUTES, STORED_REPORT_TTL_MS } from '../config/storedReports.mjs';
import { isFirstRedemption } from '../lib/promoRedemption.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let pass = 0, fail = 0;

function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function assertTrue(label, cond) { assert(label, !!cond, true); }

const T0 = Date.parse('2026-08-22T12:00:00Z');
const freshRow = () => ({ vrm: 'AB12CDE', payload: { make: 'FORD', mileageVerdict: { status: 'ok' }, checks: ['valuation'] }, created_at: new Date(T0).toISOString() });

// ── 1. The constant ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. Retention constant');
assert('STORED_REPORT_TTL_MINUTES is 10 (Vincent, 21 Aug)', STORED_REPORT_TTL_MINUTES, 10);
assert('TTL ms derives from the minutes', STORED_REPORT_TTL_MS, 10 * 60 * 1000);

// ── 2. decideStoredReport — serve ────────────────────────────────────────────────────────────────
console.log('\n2. Fresh row, VRM match → serve (the commercial path: this return precedes any fetch)');
{
  const d = decideStoredReport(freshRow(), 'AB12CDE', T0 + 60_000); // 1 min later
  assert('action is serve', d.action, 'serve');
  assert('served payload is the stored payload', d.payload.make, 'FORD');
  assert('_stored flag is set', d.payload._stored, true);
  assert('_storedAt carries the purchase time', d.payload._storedAt, freshRow().created_at);
}

// ── 3. Expiry is honest, never a refetch ─────────────────────────────────────────────────────────
console.log('\n3. Beyond the window → expired (NOT serve, NOT proceed-to-refetch)');
{
  const d = decideStoredReport(freshRow(), 'AB12CDE', T0 + STORED_REPORT_TTL_MS + 1);
  assert('action is expired', d.action, 'expired');
  assert('expired never returns a payload to re-serve', d.payload, undefined);
  assert('expired never says proceed (which would re-run the paid stack for free)', d.action === 'proceed', false);
  // Exactly at the boundary is still served (<= ttl).
  assert('at the TTL boundary the row is still served', decideStoredReport(freshRow(), 'AB12CDE', T0 + STORED_REPORT_TTL_MS).action, 'serve');
}

// ── 4. No row / VRM mismatch → proceed (a first view, or a reject) ────────────────────────────────
console.log('\n4. Absence and VRM mismatch');
assert('null row → proceed', decideStoredReport(null, 'AB12CDE', T0).action, 'proceed');
assert('row without payload → proceed', decideStoredReport({ vrm: 'AB12CDE', created_at: new Date(T0).toISOString() }, 'AB12CDE', T0).action, 'proceed');
assert('a row for VRM A must NOT serve a request for VRM B', decideStoredReport(freshRow(), 'ZZ99ZZZ', T0).action, 'proceed');
assert('VRM match is case-insensitive (normalised both sides)', decideStoredReport(freshRow(), 'ab12cde', T0 + 1000).action, 'serve');

// ── 5. ?mileage on the re-open is ignored — the served verdict is part of what was bought ─────────
console.log('\n5. The stored verdict is verbatim — decideStoredReport has no mileage input at all');
{
  // Whatever mileage the customer re-opens with, the decision takes only (row, vrm, clock): the served
  // mileageVerdict can never be recomputed from a new ?mileage because it is never an input here.
  const d = decideStoredReport(freshRow(), 'AB12CDE', T0 + 1000);
  assert('served verdict is the stored one, unchanged', d.payload.mileageVerdict, { status: 'ok' });
  // Required params are (row, cleanVrm); now/ttl are defaulted. No mileage parameter exists, so the
  // served verdict can never be recomputed from a re-open's ?mileage.
  assert('decideStoredReport takes no mileage input (2 required params: row, vrm)', decideStoredReport.length, 2);
}

// ── 6. read/write round-trip against an in-memory client (no network) ─────────────────────────────
console.log('\n6. writeStoredReport → readStoredReport round-trip, and zero supplier surface');
{
  const store = new Map();
  const fake = {
    from(table) {
      if (table !== 'paid_reports') throw new Error('unexpected table ' + table);
      return {
        _eq: null,
        upsert(rowOrRows) { const r = Array.isArray(rowOrRows) ? rowOrRows[0] : rowOrRows; store.set(r.session_id, r); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq(_col, val) { this._eq = val; return this; },
        maybeSingle() { return Promise.resolve({ data: store.get(this._eq) || null, error: null }); },
        // .delete().lt('created_at', cutoff) — the retention sweep.
        delete() { return { lt(_col, cutoff) { for (const [k, v] of store) if (v.created_at < cutoff) store.delete(k); return Promise.resolve({ error: null }); } }; },
      };
    },
  };
  // Seed an already-expired row (relative to REAL now, since the sweep uses Date.now()); the write's
  // opportunistic sweep must remove it.
  store.set('cs_old', { session_id: 'cs_old', vrm: 'OLD', payload: { a: 1 }, created_at: new Date(Date.now() - STORED_REPORT_TTL_MS - 60_000).toISOString() });
  const served = { make: 'BMW', mileageVerdict: { status: 'ok' }, checks: ['valuation', 'full_history'] };
  const wrote = await writeStoredReport(fake, { sessionId: 'cs_test_1', vrm: 'AB12CDE', checks: ['valuation', 'full_history'], market: 'GB', payload: served });
  assertTrue('write reports success', wrote);
  assert('checks stored comma-joined', store.get('cs_test_1').checks, 'valuation,full_history');
  assert('payload stored verbatim', store.get('cs_test_1').payload.make, 'BMW');
  assertTrue('the write swept the expired row (retention, batch 31 §4)', !store.has('cs_old'));
  assertTrue('the fresh row it just wrote survives the sweep', store.has('cs_test_1'));

  const reopen = await readStoredReport(fake, 'cs_test_1', 'AB12CDE');
  assert('re-open serves', reopen.action, 'serve');
  assert('re-open payload byte-identical to what was served', { make: reopen.payload.make, checks: reopen.payload.checks }, { make: 'BMW', checks: ['valuation', 'full_history'] });
  assert('re-open of an unknown session → proceed (first view)', (await readStoredReport(fake, 'cs_unknown', 'AB12CDE')).action, 'proceed');

  // The sweep is best-effort — a delete error never throws.
  const brokenSweep = { from() { return { delete() { return { lt() { return Promise.resolve({ error: { code: 'XX', message: 'no' } }); } }; } }; } };
  await sweepExpiredStoredReports(brokenSweep); // must not throw
  assertTrue('sweep with a delete error does not throw', true);
}

// ── 7. Degrade-safe: a missing paid_reports table must NOT surface as a false failure ─────────────
console.log('\n7. Missing table / DB error → degrade to a normal first view (never a false 401/403)');
{
  const brokenRead = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "paid_reports" does not exist' } }); } }; } };
  assert('read error → proceed (bind+fetch as today), not serve/expired', (await readStoredReport(brokenRead, 'cs_x', 'AB12CDE')).action, 'proceed');
  const brokenWrite = { from() { return { upsert() { return Promise.resolve({ error: { code: '42P01', message: 'relation "paid_reports" does not exist' } }); } }; } };
  assert('write error → false, never throws (report still served)', await writeStoredReport(brokenWrite, { sessionId: 'cs_x', vrm: 'AB12CDE', checks: [], market: 'GB', payload: { a: 1 } }), false);
  const throwingRead = { from() { throw new Error('supabase down'); } };
  assert('read exception → proceed (never bubbles)', (await readStoredReport(throwingRead, 'cs_x', 'AB12CDE')).action, 'proceed');
}

// ── 8. STRUCTURAL — the ordering the guarantees depend on, asserted against the real route source ──
console.log('\n8. Source ordering in app/api/vehicle/route.js (structural — protects the guarantees)');
{
  const src = readFileSync(join(ROOT, 'app/api/vehicle/route.js'), 'utf8');
  const iPaid    = src.indexOf("payment_status !== 'paid'");
  const iDecide  = src.indexOf('readStoredReport(supabase, stripeSessionId, cleanVrm)');
  const iBind    = src.indexOf('const vehicleBindKey');
  const iFetch   = src.indexOf('Promise.all', iDecide); // the first PAID supplier fan-out AFTER the decision (the free-tier Promise.all is earlier)
  assertTrue('the paid check exists', iPaid > 0);
  assertTrue('the stored-report decision exists', iDecide > 0);
  assertTrue('the replay bind exists', iBind > 0);
  assertTrue('unpaid is rejected BEFORE the stored-report decision (unpaid never served)', iPaid < iDecide);
  assertTrue('stored-report decision runs BEFORE the replay bind (a re-open is not 403d)', iDecide < iBind);
  assertTrue('stored-report decision runs BEFORE the supplier fetch (zero supplier calls on re-open)', iDecide < iFetch);
  assertTrue('serve returns the stored payload directly', src.includes('return NextResponse.json(stored.payload)'));
  assertTrue('expiry is honest, not the false payment-failed message', src.includes('This report has expired'));
  assertTrue('every paid return persists the served artefact', (src.match(/persistAndEmailReport\(/g) || []).length >= 6); // helper def + 5 call sites
  assertTrue('the email is dispatched post-response via after()', src.includes('after(async () =>'));
}

// ── 9. STRUCTURAL — verify no longer gates report access; promo counts exactly once ───────────────
console.log('\n9. app/api/stripe/verify/route.js — de-gated, promo increment once-only');
{
  const v = readFileSync(join(ROOT, 'app/api/stripe/verify/route.js'), 'utf8');
  const stripePath = v.slice(v.indexOf('── Stripe path'));
  assertTrue('the Stripe path no longer 403s a returning customer', !stripePath.includes('already been used'));
  assertTrue('promo increment is gated on a first redemption only', stripePath.includes('firstRedemption'));
  assertTrue('the first-redemption decision uses the shared once-guard helper', stripePath.includes('isFirstRedemption(insertError)'));
  // The increment MUTATION must sit behind the firstRedemption gate, not fire on every open.
  const iGate   = stripePath.indexOf('promoCode && firstRedemption');
  const iUpdate = stripePath.indexOf('.update({ uses_so_far');
  assertTrue('the uses_so_far update is inside the firstRedemption-gated block', iGate > 0 && iGate < iUpdate);
}

// ── 9b. Promo counted EXACTLY ONCE across three opens of one session (§3a — the behaviour, tested) ─
console.log('\n9b. Three opens of one promo session → uses_so_far incremented exactly once');
{
  // Simulate the used_sessions once-guard: the first insert is clean; a session_id PK collision on
  // every later open returns 23505. isFirstRedemption(insertError) is the exact gate the route uses.
  const used = new Set();
  const insert = (sid) => (used.has(sid) ? { code: '23505' } : (used.add(sid), null));
  let increments = 0;
  for (let open = 1; open <= 3; open++) {
    const err = insert('cs_promo_1');
    if (isFirstRedemption(err)) increments += 1; // the route only increments uses_so_far here
  }
  assert('a promo session opened three times increments uses_so_far exactly once', increments, 1);
  assert('the first open is the redemption', isFirstRedemption(null), true);
  assert('a 23505 collision is never a redemption', isFirstRedemption({ code: '23505' }), false);
  assert('a transient DB error is NOT counted (undercount is the safe direction)', isFirstRedemption({ code: '08006' }), false);
}

// ── 10. STRUCTURAL — the email is one shared sender, and it never fails a page load ───────────────
console.log('\n10. lib/email.mjs — one Brevo sender, report email fully guarded');
{
  const em = readFileSync(join(ROOT, 'lib/email.mjs'), 'utf8');
  assertTrue('dispatchReportEmail returns false (never throws) on a missing recipient', em.includes("missing ${!to ? 'recipient'"));
  assertTrue('a Brevo failure is caught, not propagated', em.includes('report still delivered on-screen'));
  assertTrue('jsPDF is imported lazily so the plain sender stays light', em.includes("await import('@/app/api/generate-pdf/route')"));
  const freeReq = readFileSync(join(ROOT, 'app/api/salvage/free-report/request/route.js'), 'utf8');
  assertTrue('the free-report route now uses the shared sender (no second Brevo copy)', freeReq.includes("from '@/lib/email.mjs'") && !freeReq.includes('api.brevo.com'));
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
