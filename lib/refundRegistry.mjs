// Per-item auto-refund registry (audit C§6) — the PURE polarity decision, tested at £0.
//
// The defect: only service_history had a refund path. A £6.99 Full History Check where Experian
// ERRORS took the money in full. This generalises "refund a paid item whose provider call failed"
// to every provider-backed paid item — WITHOUT a second special-case.
//
// ⚠️ THE POLARITY IS THE WHOLE RISK (brief §6): refund on a PROVIDER FAILURE (state 2) ONLY. A genuine
// qty:0 is a DELIVERED clean result ("no write-off recorded") and must NEVER refund — getting this
// backwards refunds nearly every sale. isProviderFailure (lib/apiOutcome) is 'error'|'empty' only;
// 'ok' (which includes a clean qty:0) is not a failure. This module NEVER decides a refund for a
// block whose outcome is 'ok' or absent.
//
// service_history is deliberately NOT here: it refunds on EMPTY RECORDS (the customer paid for service
// records and there are none — a non-product), a different trigger from provider-failure, and its
// live refunds were created by amount without metadata. It keeps its own evaluator (route.js) so this
// generalisation cannot disturb in-flight service-history refunds. Documented, not overlooked.

import { isProviderFailure } from './apiOutcome.mjs';

// item (menu key) → { block: the _checkOutcomes key, line: line-item description matcher for the
// charge-derived amount, cfg: PRICING.menu key, cfgIE: IE_MENU key for the £/€ config fallback }.
export const REFUND_REGISTRY = {
  full_history:     { block: 'autocheck',        line: /full history/i,      cfg: 'full_history' },
  valuation:        { block: 'valuation',        line: /valuation/i,         cfg: 'valuation' },
  salvagehistory:   { block: 'salvagehistory',   line: /salvage/i,           cfg: 'salvagehistory' },
  market_demand:    { block: 'market_demand',    line: /market demand/i,     cfg: 'market_demand' },
  previous_adverts: { block: 'previous_adverts', line: /previous advert|advert history/i, cfg: 'previous_adverts' },
  // IE (batch 48 §8) — ie_valuation is Brego-Ireland, live and sold today with no failure path. Its own
  // block so it never collides with GB `valuation`; cfgIE resolves the € (or £) price from IE_MENU when
  // no charge line matches (deriveItemRefund already prefers cfgIE on an IE session). Guarded by
  // checks.includes in refundableItems, so it is inert on every GB basket.
  ie_valuation:     { block: 'ie_valuation',     line: /valuation/i,         cfg: 'valuation', cfgIE: 'ie_valuation' },
};

// PURE. Given the basket (checks) and the per-block outcomes, return the list of menu-item keys that
// must be auto-refunded — requested AND its provider call failed. Nothing else. This is the decision
// the money hangs on; everything downstream (derive amount, execute refund) is mechanical.
export function refundableItems(checks, checkOutcomes) {
  const set = Array.isArray(checks) ? checks : [];
  const out = [];
  for (const [item, reg] of Object.entries(REFUND_REGISTRY)) {
    if (!set.includes(item)) continue;                       // not purchased → never refund
    if (!isProviderFailure(checkOutcomes?.[reg.block])) continue; // ok / clean qty:0 / not-run → no refund
    out.push(item);
  }
  return out;
}
