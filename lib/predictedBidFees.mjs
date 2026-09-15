// batch 138 item 1 (Vincent, 15 Sep — ruling on the batch 136 D4 STOP, option a: "yes").
// When NEITHER Brego nor Cazana returns a valuation there is no exit value, so no margin ladder can exist (the ladder's
// hammers are 10–50% of the exit value). The buyer still needs the auction costs: show the Copart fee stack at each of
// SalvageGuide's predicted bids — low, average, high — as the hammer rows. Margin and outcome are null (rendered "—",
// never £0): nothing here is an exit value or a price-band source. FEES ONLY.
//
// Stored on its OWN field (assessment._predictedBidFees), never in _marginScenarios: the ceilings, the break-even, the
// SalvageGuide divergence and the buyer ledger edits all read _marginScenarios and treat a margin as a number
// (Number(null) === 0), so a null-margin row there would become a false £0 break-even.

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Math.round(Number(v));

// PURE. salvageGuide = enrichedVd.salvageGuide (the supplier's own field names); feeStackFn = FEE_STACKS[auctionSource]
// (hammer → { buyerFee, bidFee, retrieval, vatAmount, totalIncVat }); vatQualifying = the lot carries VAT on the hammer.
// Returns null when SalvageGuide is absent or carries no usable bid.
export function feeRowsAtPredictedBids(salvageGuide, feeStackFn, vatQualifying) {
  if (!salvageGuide || typeof feeStackFn !== 'function') return null;
  const bids = [
    ['low', num(salvageGuide.salvage_auction_predicted_bid_low_gbp)],
    ['average', num(salvageGuide.salvage_auction_predicted_bid_average_gbp)],
    ['high', num(salvageGuide.salvage_auction_predicted_bid_high_gbp)],
  ].filter(([, hammer]) => hammer != null && hammer > 0);
  if (!bids.length) return null;
  return bids.map(([which, hammer]) => {
    const fees = feeStackFn(hammer);
    // Same hammer-VAT rule as the margin ladder (assess route: Math.round(hammer * 0.20 * 100) / 100 on a VAT lot).
    const hammerVat = vatQualifying ? Math.round(hammer * 0.20 * 100) / 100 : 0;
    return { label: `SalvageGuide predicted bid (${which})`, which, hammer, hammerVat, ...fees, margin: null, outcome: null };
  });
}
