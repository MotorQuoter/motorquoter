// The single choke point for every One Auto API call (feat/oneauto-fetch, batch 37).
//
// Before this, ONE_AUTO_BASE and oneAutoHeaders were each defined TWICE (vehicle/route.js +
// vehicle-image/route.js) and ~20 bare fetch() sites hit One Auto directly — so nothing could count
// our supplier calls, because nothing they all pass through existed (§7 part-2's structural blocker).
// One base, one header, one fetch. Commit 2 wraps a per-call LOG around oneAutoFetch — and only a
// count: this file produces call COUNTS, never COSTS. A count against a list price is still a list
// price; the invoice rate is Vincent's to pull.
//
// ⚠️ CARTELL_BASE is currently UNUSED (grep: defined once at vehicle/route.js:214, never in a fetch —
// cartell/vehiclehistorycheck builds its URL from ONE_AUTO_BASE, not this). Kept here for parity and
// flagged as dead, not removed (this branch does not fold in unrelated fixes).

export const ONE_AUTO_BASE = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
export const CARTELL_BASE = process.env.ONEAUTO_SANDBOX === 'true' ? 'https://sandbox.oneautoapi.com' : ONE_AUTO_BASE;
export const oneAutoHeaders = () => ({ 'x-api-key': process.env.ONE_AUTO_API_KEY });

/**
 * oneAutoFetch — every One Auto request goes through here.
 * @param {string} target  a RELATIVE path with its query already built (byte-identical to the old
 *   `${ONE_AUTO_BASE}/…` template), OR an ABSOLUTE url (the polling path already has one in hand).
 * @param {object} [opts]  fetch init; `base` overrides ONE_AUTO_BASE for a relative target; if the
 *   caller already set `headers` (the polling callers do) they are kept, else the One Auto key header
 *   is added. Returns the raw Response, exactly as `fetch` did — no body/status/shape change.
 */
export function oneAutoFetch(target, opts = {}) {
  const { base = ONE_AUTO_BASE, headers, ...init } = opts;
  const url = /^https?:\/\//.test(target) ? target : `${base}/${target}`;
  return fetch(url, { headers: headers ?? oneAutoHeaders(), ...init });
}
