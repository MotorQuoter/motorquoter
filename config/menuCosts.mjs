// The single source of what each menu item costs US (branch E, batch 43). The account's OWN per-country
// rate cards, read behind Vincent's One Auto login — stronger than the published price list every prior
// figure came from, but still RATES, not per-call charges. One definition, imported by the validator.
//
// grossCost — what we pay, VAT-INCLUSIVE (UK list ×1.20, Irish list ×1.23). NEVER a list price.
// basis     — how the number is known:
//     'account-rate' — from the One Auto account rate card (behind login). Permits enabled:true.
//     'free'         — no supplier call at all (DVSA / DVLA / computed), definitively £0. Permits.
//     'unknown'      — cost not known. BLOCKS enabled:true (quarantine). This caught ie_history at £15.
//     'invoiced'     — reserved; a real per-call CHARGE was read. NOT used yet — One Auto publish no
//                      per-call statement (all 18 invoices are unitemised £30 top-ups). Do not mark
//                      anything invoiced until a charge is actually read (overstating is rule-1's exact
//                      failure). Upgrading a row is then a one-field edit.
// sharedWith — keys whose purchase makes THIS item's marginal cost £0 (owner_history rides AutoCheck).
// perResult  — One Auto bills "per result": a zero-result call may cost nothing (the service-history
//              refund evaluator's basis). The worst-case floor assumes a result IS returned (the costly
//              case), so this is recorded, not discounted.
//
// Provider-name note: the master log trades "Cazana" (market_demand, previous_adverts → endpoint
// percayso) and "SalvageGuide" (salvagehistory → endpoint carguide). Percayso acquired Cazana, so that
// pair is probably one product renamed — an observation, not a conclusion. The ENDPOINT is the identity.
export const MENU_COSTS = {
  valuation:          { grossCost: 0.84,  basis: 'account-rate' },                                  // brego/valuationfromvrm/v2
  full_history:       { grossCost: 2.40,  basis: 'account-rate' },                                  // experian/autocheck/v3
  service_history:    { grossCost: 3.00,  basis: 'account-rate', perResult: true },                 // ezyvin/servicehistoryfromvrm
  salvagehistory:     { grossCost: 0.60,  basis: 'account-rate' },                                  // carguide/salvagecheck/v2 (config said 0.50 ex-VAT)
  market_demand:      { grossCost: 0.48,  basis: 'account-rate' },                                  // percayso/marketdemandfromvrm
  previous_adverts:   { grossCost: 0.59,  basis: 'account-rate' },                                  // percayso/previousadvertsfromvrm
  owner_history:      { grossCost: 0.24,  basis: 'account-rate', sharedWith: ['full_history'] },    // ukvehicledata/... — £0 with full_history
  salvage_predictor:  { grossCost: 0.71,  basis: 'account-rate' },                                  // salvageguide/bidpredictionfromvrm (disabled)
  mot:                { grossCost: 0,     basis: 'free' },                                          // DVSA
  mileage_detail:     { grossCost: 0,     basis: 'free' },                                          // DVSA (computed)
  road_tax:           { grossCost: 0,     basis: 'free' },                                          // computed from DVLA
  ie_valuation:       { grossCost: 0.84,  basis: 'account-rate' },                                  // brego/ireland/valuationfromvrm/v2
  ie_service_history: { grossCost: 3.00,  basis: 'account-rate', perResult: true },                 // ezyvin/servicehistory (Europe from VIN)
  ie_history:         { grossCost: 14.40, basis: 'account-rate', perResult: true },                 // cartell/vehiclehistorycheck (disabled)
  ie_nct:             { grossCost: 0,     basis: 'free' },                                          // no such service on the IE rate card (404s)
};

// Basket-level overhead — calls fired once per REQUEST for a market, attributable to no item. A flat
// per-item cost cannot represent these, which is why they went unnoticed.
export const MARKET_OVERHEAD = {
  GB: { grossCost: 0,    basis: 'free' },          // confirmed: no unconditional paid GB call (all ternary-gated; DVLA/DVSA free)
  IE: { grossCost: 0.18, basis: 'account-rate' },  // cartell/vehicleidentity — "always fetched", once per IE request (ncthistory is £0, no such service)
};

// Stripe: the VERIFIED fit over 41 settled charges (21 Aug). net = price × 0.98441 − 0.2005.
// ⚠️ GBP ONLY — no EUR charge has ever settled, so any EUR margin computed with this is MODELLED.
export function stripeNet(price) { return price * 0.98441 - 0.2005; }

// Minimum NET margin as a fraction of price. A FLOOR to catch LOSSES, not a target (the thinnest live
// item, previous_adverts, sits at ~19%). 15% recommended — Vincent's to move.
export const COST_FLOOR_PCT = 0.15;

// Worst-case single-item margin: the item bought ALONE (sharedWith IGNORED — the loss was always in
// single-item baskets) PLUS its market's basket overhead. Returns null for an unknown item so the
// caller fails loudly rather than treating absence as £0.
export function worstCaseMargin(key, price, market = 'GB') {
  const c = MENU_COSTS[key];
  if (!c) return null;
  const overhead = MARKET_OVERHEAD[market]?.grossCost ?? 0;
  const net = stripeNet(price);
  const cost = c.grossCost + overhead; // sharedWith deliberately ignored
  return { net, cost, margin: net - cost, marginPct: price > 0 ? (net - cost) / price : 0, basis: c.basis };
}
