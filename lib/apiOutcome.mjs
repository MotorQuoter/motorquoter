// Discriminated outcome for a provider (One Auto / Experian / Cartell) response — audit C§5.
//
// The old extractApiResult collapsed THREE states into one null:
//   1. the provider call FAILED (top-level error, result.error, or an unusable/empty body), and
//   2. the provider answered but holds nothing for this vehicle.
// So the report said "…data not available for this vehicle" — a statement about the CAR — when the
// truth was often "our supplier call failed". This classifier separates them AT THE SOURCE so:
//   • the render can tell the truth ("this check could not be completed" vs "not available"), and
//   • the refund (C§6) can fire on a provider FAILURE only, never on a genuine clean/empty result.
//
// Outcome:
//   { ok:false, reason:'error', result:null } — an explicit provider error (data.error/result.error).
//   { ok:false, reason:'empty', result:null } — no usable result object at all (null / empty body).
//         A HEALTHY "no record held" answer is a POPULATED object with empty fields (ok:true below),
//         never an empty body — so an empty body is a failure for wording + refund, not a clean result.
//   { ok:true,  reason:null,  result }         — a usable result object. It may legitimately contain
//         zero records: that "clean (state 1) vs genuinely-not-held (state 3)" call is per-FIELD and
//         belongs to the render (e.g. experianVerdict), NOT here.
//
// isProviderFailure(reason) is the single predicate the render wording and the refund registry share,
// so "which states refund / say 'could not be completed'" is defined once.
export function classifyApiResult(data) {
  if (data && data.error) return { ok: false, reason: 'error', result: null };
  if (!data)              return { ok: false, reason: 'empty', result: null };
  const result = data.result ?? data;
  if (result && result.error) return { ok: false, reason: 'error', result: null };
  return { ok: true, reason: null, result };
}

// A provider FAILURE (state 2) — refundable, and rendered as "could not be completed". Both an
// explicit error and an unusable/empty body count; a genuine clean/empty RESULT (ok:true) does not.
export function isProviderFailure(reason) {
  return reason === 'error' || reason === 'empty';
}

// Back-compat shim: the many callers that only ever needed the result object keep working unchanged.
export function extractApiResult(data) {
  return classifyApiResult(data).result;
}
