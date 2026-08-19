// Validator — service-history outcome model (£0: no network, no provider, no Stripe).
//
// Guards the fix for the defect that refunded 100% of service-history sales since launch.
// The one rule everything here defends: A REFUND MAY FIRE ON 'empty' AND ON NOTHING ELSE.
//
// Run: node scripts/validate-service-history.mjs

import {
  extractServiceRecords,
  normaliseServiceEvent,
  normaliseServiceEvents,
  classifyServiceHistory,
  serviceHistoryNotAttempted,
  shouldRefundServiceHistory,
  isUncacheableServiceHistory,
  cachedServiceHistoryOutcome,
} from '../lib/serviceHistory.mjs';

let pass = 0, fail = 0;

function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}

const EVENT = { date: '2019-04-02', mileage: 34000, service_type: 'Full service', dealer: 'Main dealer' };

// ── 1. extractServiceRecords — all three key spellings, and the unknown shape ────────────────
console.log('\n1. Canonical record extraction');
assert('vendor-documented service_events is read', extractServiceRecords({ service_events: [EVENT] }), [EVENT]);
assert('service_records (what the report renders) is read', extractServiceRecords({ service_records: [EVENT] }), [EVENT]);
assert('records (what the old refund check read) is read', extractServiceRecords({ records: [EVENT] }), [EVENT]);
assert('empty array is an array, not an absence', extractServiceRecords({ service_events: [] }), []);
// THE SECOND BUG: the refund check read `records`, which no payload and no renderer ever used.
// A payload full of events under service_events therefore looked empty and refunded the customer.
assert('a populated payload is never mistaken for empty', extractServiceRecords({ service_events: [EVENT, EVENT] })?.length, 2);
assert('unrecognised shape → null (NOT an empty array)', extractServiceRecords({ something_else: [EVENT] }), null);
assert('null input → null', extractServiceRecords(null), null);
assert('non-object input → null', extractServiceRecords('nope'), null);

// ── 2. classifyServiceHistory — the nine vendor codes stop collapsing into one ────────────────
console.log('\n2. Status classification');
assert('200 with events → ok', classifyServiceHistory({ httpStatus: 200, result: { service_events: [EVENT] } }).status, 'ok');
assert('200 with zero events → empty', classifyServiceHistory({ httpStatus: 200, result: { service_events: [] } }).status, 'empty');
assert('202 polling exhausted → pending', classifyServiceHistory({ exhausted: true }).status, 'pending');
for (const code of [204, 206, 400, 403, 404, 429, 500, 503]) {
  assert(`HTTP ${code} → error`, classifyServiceHistory({ httpStatus: code, detail: 'x' }).status, 'error');
}
assert('network throw (httpStatus 0) → error', classifyServiceHistory({ httpStatus: 0, detail: 'ECONNRESET' }).status, 'error');
assert('200 with no usable result → error', classifyServiceHistory({ httpStatus: 200, result: null }).status, 'error');
assert('200 in an unrecognised shape → error, not empty', classifyServiceHistory({ httpStatus: 200, result: { mystery: 1 } }).status, 'error');
assert('error keeps its status code for the log/alert', classifyServiceHistory({ httpStatus: 403, detail: 'not enabled' }).httpStatus, 403);
assert('ok carries the records through', classifyServiceHistory({ httpStatus: 200, result: { service_records: [EVENT] } }).records, [EVENT]);

// ── 3. THE MONEY GATE ─────────────────────────────────────────────────────────────────────────
console.log('\n3. Refund fires on empty and on nothing else');
assert('empty → REFUND', shouldRefundServiceHistory({ status: 'empty', records: [] }), true);
assert('ok → no refund', shouldRefundServiceHistory({ status: 'ok', records: [EVENT] }), false);
assert('pending → no refund', shouldRefundServiceHistory({ status: 'pending' }), false);
assert('error → no refund', shouldRefundServiceHistory({ status: 'error', httpStatus: 404 }), false);
assert('null outcome → no refund', shouldRefundServiceHistory(null), false);
assert('undefined outcome → no refund', shouldRefundServiceHistory(undefined), false);
// The exact live defect, end to end: the retired path answered 404 on every call.
assert(
  'THE LIVE DEFECT: 404 from the retired path no longer refunds',
  shouldRefundServiceHistory(classifyServiceHistory({ httpStatus: 404, detail: 'Requested API is not available' })),
  false,
);
// The second live defect: a good 200 whose events sit under a key the refund check didn't read.
assert(
  'THE SECOND DEFECT: a full 200 under service_events no longer refunds',
  shouldRefundServiceHistory(classifyServiceHistory({ httpStatus: 200, result: { service_events: [EVENT, EVENT] } })),
  false,
);

// ── 3b. The deliberately-skipped call must STILL refund (pre-fix behaviour, preserved) ─────────
// Regression guard: moving from "null records" to an outcome model silently dropped these two
// refunds, because a skipped call has no outcome at all. An uncovered make and a missing VIN are
// cases where we know up front we cannot supply the product — the customer gets their money back.
console.log('\n3b. Skipped calls still refund');
assert('GB uncovered make → refund', shouldRefundServiceHistory(serviceHistoryNotAttempted('make_not_covered')), true);
assert('IE no VIN → refund', shouldRefundServiceHistory(serviceHistoryNotAttempted('no_vin')), true);
assert('skipped call carries its reason', serviceHistoryNotAttempted('make_not_covered').notAttempted, 'make_not_covered');
assert('skipped call is cacheable (a stable fact about the vehicle)', isUncacheableServiceHistory(serviceHistoryNotAttempted('no_vin')), false);

// ── 4. Cacheability — a provider failure must not be frozen for 48h ───────────────────────────
console.log('\n4. Cacheability');
assert('error is not cached', isUncacheableServiceHistory({ status: 'error', httpStatus: 503 }), true);
assert('pending is not cached', isUncacheableServiceHistory({ status: 'pending' }), true);
assert('ok is cached', isUncacheableServiceHistory({ status: 'ok', records: [EVENT] }), false);
assert('empty is cached', isUncacheableServiceHistory({ status: 'empty', records: [] }), false);
assert('no service-history call at all → cached normally', isUncacheableServiceHistory(null), false);

// ── 5. Cache-hit reconstruction, incl. the pre-fix rows already in the table ───────────────────
console.log('\n5. Cache-hit outcome reconstruction');
assert('fresh row replays its stored status',
  cachedServiceHistoryOutcome({ serviceHistoryStatus: 'empty', serviceHistory: { service_events: [] } }).status, 'empty');
assert('fresh ok row replays as ok',
  cachedServiceHistoryOutcome({ serviceHistoryStatus: 'ok', serviceHistory: { service_events: [EVENT] } }).status, 'ok');
// Pre-fix rows are the 404s that caused the original refunds. Replaying them as 'empty' would
// refund a repeat buyer for a provider fault all over again.
assert('legacy row with null serviceHistory → error, NOT empty',
  cachedServiceHistoryOutcome({ serviceHistory: null }).status, 'error');
assert('legacy row therefore does not refund',
  shouldRefundServiceHistory(cachedServiceHistoryOutcome({ serviceHistory: null })), false);
assert('legacy row with a genuinely empty array → empty (refundable)',
  cachedServiceHistoryOutcome({ serviceHistory: { service_records: [] } }).status, 'empty');
assert('legacy row with records → ok',
  cachedServiceHistoryOutcome({ serviceHistory: { service_records: [EVENT] } }).status, 'ok');
assert('missing payload → error (never refund on nothing)',
  cachedServiceHistoryOutcome(undefined).status, 'error');

// ── 6. Per-event field names — the mismatch one level below the array name ────────────────────
// The live 19 Aug trace showed the vendor sends `date_of_service_event` / `mileage_observed` /
// `mileage_unit`, while both renderers read `date` / `mileage` / `service_type`. Unnormalised, a
// car with six genuine records renders six rows with a blank date and no mileage.
console.log('\n6. Per-event normalisation');
const LIVE_SHAPE = { date_of_service_event: '2019-04-02', mileage_observed: 34000, mileage_unit: 'miles', service_type: 'Full service', service_provider: 'Main dealer' };
assert('vendor date_of_service_event → date', normaliseServiceEvent(LIVE_SHAPE).date, '2019-04-02');
assert('vendor mileage_observed → mileage', normaliseServiceEvent(LIVE_SHAPE).mileage, 34000);
assert('mileage_unit "miles" → mi', normaliseServiceEvent(LIVE_SHAPE).mileageUnit, 'mi');
assert('mileage_unit "km" preserved (Europe endpoint)', normaliseServiceEvent({ ...LIVE_SHAPE, mileage_unit: 'km' }).mileageUnit, 'km');
assert('missing unit defaults to mi', normaliseServiceEvent({ date: 'x' }).mileageUnit, 'mi');
assert('service_provider string → dealer', normaliseServiceEvent(LIVE_SHAPE).dealer, 'Main dealer');
assert('service_provider object → its name', normaliseServiceEvent({ service_provider: { name: 'Bristol VW' } }).dealer, 'Bristol VW');
assert('legacy flat shape still normalises', normaliseServiceEvent({ date: '2020-01-01', mileage: 10, service_type: 'Oil', dealer: 'X' }).serviceType, 'Oil');
assert('array maps and drops junk', normaliseServiceEvents([LIVE_SHAPE, null]).length, 1);
assert('non-array → null', normaliseServiceEvents('nope'), null);

// ── Summary ───────────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
