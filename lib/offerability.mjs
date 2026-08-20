// ─────────────────────────────────────────────────────────────────────────────
// Per-vehicle offerability — the SECOND axis the per-product allow-list can't see.
//
// menuGate.rejectedKeys enforces "is this key a purchasable PRODUCT". This enforces "is this product
// offerable for THIS vehicle". A key can be enabled (a real product) yet not offerable for the car in
// the request — service history when the make/year fail the coverage gate. That gap let a £4.99
// Service History sale through checkout for a call that could never succeed (Defect 2, 20 Aug).
//
// Both the menu (client) and the checkout gate (server) must reject the same keys for the same
// vehicle — this is the shared source for that. Fix the class: register a key's predicate here, don't
// special-case service history at each call site. Relative import so the validator can load it too.
// ─────────────────────────────────────────────────────────────────────────────
import { serviceHistoryOfferable } from '../config/serviceHistoryCoverage.mjs';

// key → (vehicle) => boolean offerable. Keys absent here are always offerable.
const OFFERABILITY_RULES = {
  service_history: (v) => serviceHistoryOfferable({ make: v?.make, yearOfManufacture: v?.yearOfManufacture }).offerable,
};

/** True if any requested key carries a per-vehicle precondition (→ the caller needs vehicle facts). */
export function hasVehicleGatedKey(checks) {
  return (checks || []).some((k) => k in OFFERABILITY_RULES);
}

/**
 * notOfferableForVehicle — requested keys that ARE enabled products but are not offerable for this
 * vehicle. A non-empty result means checkout must reject (same shape as menuGate.rejectedKeys).
 * @param {string[]} checks
 * @param {{make?:string, yearOfManufacture?:number|string}} vehicle
 * @returns {string[]}
 */
export function notOfferableForVehicle(checks, vehicle) {
  return (checks || []).filter((k) => OFFERABILITY_RULES[k] && !OFFERABILITY_RULES[k](vehicle));
}
