// ─────────────────────────────────────────────────────────────────────────────
// Menu-scope gate — pure, shared by app/api/stripe/checkout/route.js (the enforcement point) and
// scripts/validate-pricing.mjs (the regression test). No config import: callers pass the menu, so
// the same functions the route runs are the ones the test asserts on.
//
// Guards the ROI_TIERS-class hole: a DISABLED or UNKNOWN key must be REJECTED at checkout before it
// can reach the Stripe session metadata, because /api/vehicle binds the paid scope from that metadata
// and would otherwise serve a paid provider call the customer never paid for. And only `full_history`
// may trigger the paid Experian AutoCheck — the retired writeoff/finance/stolen singles must not.
// ─────────────────────────────────────────────────────────────────────────────

/** Set of keys that are currently purchasable/valid (enabled menu items). */
export function enabledKeySet(menu) {
  return new Set((menu || []).filter(i => i && i.enabled).map(i => i.key));
}

/**
 * rejectedKeys — requested keys that are NOT currently-enabled menu items. A non-empty result means
 * the whole checkout request must be rejected (allow-list, not deny-list; reject, do not drop).
 * @param {string[]} checks  requested keys
 * @param {Array<{key:string,enabled?:boolean}>} menu  the full menu (GB + IE)
 * @returns {string[]} the offending keys
 */
export function rejectedKeys(checks, menu) {
  const enabled = enabledKeySet(menu);
  return (checks || []).filter(k => !enabled.has(k));
}

/**
 * needsAutocheck — whether a basket triggers the single paid Experian AutoCheck call. ONLY the
 * `full_history` bundle does; the retired writeoff/finance/stolen keys must never reach this true.
 * @param {string[]} checks
 * @returns {boolean}
 */
export function needsAutocheck(checks) {
  return (checks || []).includes('full_history');
}
