// Service-history outcome model — the pure half, kept out of the route so it can be unit-tested
// at zero cost (no network, no Stripe, no provider).
//
// WHY THIS EXISTS. Until 19 Aug 2026 a service-history call collapsed nine documented vendor
// status codes into one `null`, and `null` meant "no records", and "no records" auto-refunded the
// customer. Every purchase of this product since launch was refunded — three sales, two real
// customers, 3 of 3, net revenue £0. Two independent faults, either of them sufficient:
//   1. `oneauto/servicehistory/` was retired (404 on live AND sandbox, probed 19 Aug).
//   2. the refund check read `records`, a key that appears nowhere in the payload or the renderers
//      — so even a perfect 200 full of service events would have refunded.
// The fix is not "return better data". It is to make failure DISTINGUISHABLE from emptiness, and
// to let exactly one of those two states spend the customer's money.

// The array of service events has travelled under three names: the vendor's documented
// `service_events`, `service_records` (what the report and PDF render), and `records` (what the
// refund check read). One reader for all consumers so a decision and a render can never disagree.
export const SERVICE_HISTORY_RECORD_KEYS = ['service_events', 'service_records', 'records'];

// Returns an array (possibly empty) when a recognised shape is present; null when NO recognised
// array is there at all. That difference is load-bearing: "200 with zero events" is a refundable
// empty result, "200 in a shape we don't recognise" is an error and must not silently refund.
export function extractServiceRecords(result) {
  if (!result || typeof result !== 'object') return null;
  for (const key of SERVICE_HISTORY_RECORD_KEYS) {
    if (Array.isArray(result[key])) return result[key];
  }
  return null;
}

// Per-event field names, same problem one level down. The renderers read `rec.date`, `rec.mileage`,
// `rec.service_type`, `rec.dealer`; the live 19 Aug trace shows the vendor sends
// `date_of_service_event`, `mileage_observed` and `mileage_unit`. Left alone, a car with six
// genuine records would have rendered six rows with a blank date and no mileage — the product
// still visibly broken after the endpoint, the key name and the polling window were all fixed.
// Normalise once, here, and let both renderers read the same shape.
//
// Mileage unit is carried rather than assumed: the report hardcoded "mi", and an Irish vehicle
// through the Europe endpoint can legitimately be in km.
export function normaliseServiceEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const pick = (...keys) => { for (const k of keys) if (ev[k] !== undefined && ev[k] !== null && ev[k] !== '') return ev[k]; return null; };
  const provider = pick('service_provider', 'dealer', 'garage', 'workshop');
  return {
    date: pick('date_of_service_event', 'service_date', 'date'),
    mileage: pick('mileage_observed', 'odometer_reading', 'mileage'),
    mileageUnit: (pick('mileage_unit', 'odometer_unit') || 'mi').toString().toLowerCase().startsWith('k') ? 'km' : 'mi',
    serviceType: pick('service_type', 'event_type', 'description', 'service_description'),
    dealer: provider && typeof provider === 'object' ? (provider.name ?? null) : provider,
  };
}

export function normaliseServiceEvents(records) {
  if (!Array.isArray(records)) return null;
  return records.map(normaliseServiceEvent).filter(Boolean);
}

// Pure classifier. Callers do the IO and hand over what they got.
//   { status: 'ok',      records }              HTTP 200 with events
//   { status: 'empty',   records: [] }          HTTP 200, genuinely zero events → the ONLY refundable case
//   { status: 'pending' }                       202 polling exhausted — provider never answered
//   { status: 'error',   httpStatus, detail }   everything else (403/400/429/204/206/503/…)
export function classifyServiceHistory({ exhausted = false, httpStatus = null, result = null, detail = null } = {}) {
  if (exhausted) return { status: 'pending' };
  if (httpStatus !== 200) return { status: 'error', httpStatus, detail };
  if (!result) return { status: 'error', httpStatus: 200, detail: detail ?? 'empty or error body on HTTP 200' };

  const records = extractServiceRecords(result);
  if (records === null) {
    return { status: 'error', httpStatus: 200, detail: detail ?? 'unrecognised payload shape', result };
  }
  return records.length === 0
    ? { status: 'empty', records: [], result }
    : { status: 'ok', records, result };
}

// The call we deliberately DON'T make: an unlisted make (GB) or no VIN to look up (IE). We know
// up front we cannot supply the product for this vehicle, so this is a refundable empty result —
// not an error. Behaviour predates this fix and is preserved on purpose: before the outcome model
// existed, a skipped call produced `null` records and refunded. `reason` is carried so the log and
// the report can say WHY, rather than implying the provider was asked and said no.
export function serviceHistoryNotAttempted(reason) {
  return { status: 'empty', records: [], notAttempted: reason };
}

// The single gate on spending money. Refund on a genuine EMPTY result AND on a provider FAILURE —
// `error` or `pending`. `ok` (records delivered) never refunds.
//
// DECISION: Vincent, 24 August 2026 (batch 51). This widens the earlier `empty`-only rule (19 Aug),
// which the comment here used to say "must be a decision someone made, not an accident of
// null-handling" — this is that decision. Rationale: nothing delivers the data later. No callback is
// wired, `fetchWithPolling` exhausts and returns, and the stored report is written once — so a
// `pending` customer never receives what they paid for, and their outcome is identical to an `error`.
// It also makes service_history consistent with the rest of the paid menu, where a provider failure
// already refunds (lib/refundRegistry.mjs, 22–23 Aug). This evaluator stays SEPARATE from the registry
// on purpose (different idempotency basis; and the registry has no `pending`) — do not merge them.
export function shouldRefundServiceHistory(outcome) {
  const s = outcome?.status;
  return s === 'empty' || s === 'error' || s === 'pending';
}

// A payload whose service-history call errored or never answered must not enter the 48h cache —
// the next buyer of that reg would inherit a stale failure and the recovery would stay hidden.
// A request that never needed service history (outcome null) caches normally.
export function isUncacheableServiceHistory(outcome) {
  return outcome?.status === 'error' || outcome?.status === 'pending';
}

// Rebuild the outcome on a cache hit. Fresh rows carry `serviceHistoryStatus` and replay verbatim.
// Rows written before this fix carry no status and are reconstructed from the payload — and a row
// with no recognised records array reconstructs as 'error', NOT 'empty'. Those rows are precisely
// the 404s that caused the refunds; replaying them as 'empty' would refund a repeat buyer for a
// provider fault all over again.
export function cachedServiceHistoryOutcome(payload) {
  const records = payload?.serviceHistory ? extractServiceRecords(payload.serviceHistory) : null;
  const stored = payload?.serviceHistoryStatus;
  if (stored) return { status: stored, records: records ?? [] };
  if (records === null) return { status: 'error', httpStatus: null, detail: 'legacy cache row, outcome unknown' };
  return records.length === 0 ? { status: 'empty', records: [] } : { status: 'ok', records };
}
