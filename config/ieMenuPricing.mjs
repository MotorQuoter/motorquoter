// The IE_MENU sterling-price rule (Vincent, 22 Aug — batch 32).
//
//   An IE row's sterling `price` is DERIVED from its euro `priceEUR`:
//       price = priceEUR ÷ GBP_EUR_RATE, rounded to the NEAREST .99 (on an exact tie, round UP)
//   …and then HELD AS A LITERAL in config/pricing.js, with validate-pricing asserting the relationship.
//
// It must NOT be computed at request time. Vincent's 21 Aug FX decision is explicit — "nothing repins
// automatically; that is Vincent's decision" — so a runtime derivation would let a future repin
// silently reprice the live IE menu. Held as literals with an assertion, a repin instead turns the
// gate RED and hands him the consequence to approve. This module is the SINGLE definition of both
// "nearest .99" and the rate the literals are checked against — the config comment and the validator
// import the same one, so they cannot disagree (batch 32 §1.2 / standing rule 5).
//
// ⚠️ RATE-DUPLICATION FLAG: the import product pins the same GBP/EUR rate as `GBP_EUR_RATE` in
//   config/vrt.mjs — but that file exists ONLY on the unmerged feat/import-revive branch, not on main.
//   The rate is therefore pinned here independently for now. When import-revive merges, reconcile the
//   two 1.17 pins to one shared source (standing rule 5; config/pricing.js is the known collision
//   surface). Reported to Cowork, batch 32 head-of-C.
export const IE_MENU_GBP_EUR_RATE = 1.17;

// Round a target to the nearest price point of the form n + 0.99 (n a non-negative integer).
// Candidates: 0.99, 1.99, 2.99, …  The optimal integer is n* = target − 0.99; Math.round rounds a
// half UP for positive values, which is exactly the tie rule ("round UP"). Non-positive/NaN → 0
// (callers skip zero-priced rows).
export function nearest99(target) {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const n = Math.max(0, Math.round(t - 0.99));
  return Math.round((n + 0.99) * 100) / 100;
}

// The sterling price an IE row's euro price implies under the rule.
export function derivedIeGbpPrice(priceEUR) {
  const eur = Number(priceEUR);
  if (!Number.isFinite(eur) || eur <= 0) return 0; // zero-priced rows (ie_nct) are out of scope
  return nearest99(eur / IE_MENU_GBP_EUR_RATE);
}
