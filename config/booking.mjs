// Single owner of the code-owned booking/inspection warning strings. When the inspection
// booking window is shut (sale within 48h) or the sale has already taken place, the checklist
// section is suppressed (see the section gate in success/page.js + pdf/route.js) and one of
// these lines renders in its place. Wording may be amended by the wording-markup pass; this is
// the single edit point. Reject strings (Commit 4) will live here too.
// batch 144 U1 (Vincent, 16 Sep): ends at "remain unverified." The tail — "treat all flagged items
// as unresolved when judging this purchase" — told the buyer how to weigh the lot, which is his
// call, not the report's. Same rule as batch 142 R1, which cut the equivalent tail from
// WINDOW_CLOSED_WARNING below. What is left is the fact and nothing else.
export const SALE_PASSED_WARNING = "Inspection no longer possible — the sale has taken place. The inspection-class risks in this report remain unverified.";

// batch 142 R1 (Vincent, 16 Sep — INFORM, DO NOT DECIDE): the FACTUAL part of the notice is kept;
// the bid directive that followed it is removed. "bid accordingly, or wait for the lot to relist"
// told the buyer what to do about the closed window — that is his decision, not the report's.
// What is left states the window, the deadline and what that means for the flags, and stops.
export const WINDOW_CLOSED_WARNING = "Inspection booking window closed — sale is within 48 hours. The inspection-class risks in this report can no longer be verified before bidding; they remain unresolved.";

// batch 144 U2 (Vincent, 16 Sep — "remove it. The inspection flags already list the unknowns"):
// THE BID DIRECTIVE IS GONE. CAT_NU_DIRECTIVE and categoryDirective() are deleted, and with them
// the Bid Directive block on both surfaces — nothing else rendered it. It was the last survivor
// of the pattern batch 134 started (cutting the Cat S "Do not bid on this lot…" text) and batch
// 142 R1 finished on the Recommended Action verdict: the report informs, it does not decide. The
// unknowns it pointed at are already listed, one by one, in Inspection Flags. The Cat A/B legal
// hard stop is a different path (assess route catABHardStopLetter) and is untouched.
// batch 136 task D3 (Vincent, 15 Sep: "A valuation should always come back. Even if it doesn't the app can still provide a
// repair estimate."): where the live market valuation belongs when none came back — screen AND PDF, one owner. Replaces
// the false "Unavailable — engine used wider confidence range" (no code widens anything; batch 135) and the PDF's silence.
// batch 138 item 2 (Vincent, 15 Sep: yes): the second sentence "The repair estimate above is complete." is REMOVED
// everywhere — in the PDF the valuation sits above the estimate, and without a price band the estimate is not checked.
export const NO_VALUATION_NOTE = "No market valuation was returned for this vehicle, so the after-repair value, bid ladder and rebuild ceiling are not shown.";


// Sale-passed reject strings (Commit 4). Returned as the 4xx error body when a lot's auction has
// already taken place — before any charge / credential consumption. Variant per entry path.
export const SALE_PASSED_REJECT_PAID  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so no payment has been taken.";
export const SALE_PASSED_REJECT_PROMO = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your code has not been used.";
export const SALE_PASSED_REJECT_FREE  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your free report has not been used.";
