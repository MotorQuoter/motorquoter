// Single owner of the code-owned booking/inspection warning strings. When the inspection
// booking window is shut (sale within 48h) or the sale has already taken place, the checklist
// section is suppressed (see the section gate in success/page.js + pdf/route.js) and one of
// these lines renders in its place. Wording may be amended by the wording-markup pass; this is
// the single edit point. Reject strings (Commit 4) will live here too.
export const SALE_PASSED_WARNING = "Inspection no longer possible — the sale has taken place. The inspection-class risks in this report remain unverified; treat all flagged items as unresolved when judging this purchase.";

export const WINDOW_CLOSED_WARNING = "Inspection booking window closed — sale is within 48 hours. The inspection-class risks in this report can no longer be verified before bidding; treat all flagged items as unresolved and bid accordingly, or wait for the lot to relist.";

// Code-owned bid directive (rendered at the head of the Recommended Action section when a
// HIGH-weight inspection flag is present). The model no longer authors a bid directive (Commit 1);
// this is its single owner. Wording may be amended by the wording-markup pass.
// batch 134 (Vincent, 15 Sep — "INFORM, DO NOT DECIDE"): the Cat S "Do not bid on this lot…" directive is REMOVED.
// It was advice, not a fact. Every case that returned it (Cat S, an absent category, an unrecognised letter) now
// returns null and no Bid Directive renders. The Cat N / Cat U text below is UNCHANGED — the brief stops short of it
// and Vincent rules on it separately. The Cat A/B legal hard stop is a different path (assess route
// catABHardStopLetter) and is untouched.
// batch 136 task D3 (Vincent, 15 Sep: "A valuation should always come back. Even if it doesn't the app can still provide a
// repair estimate."): where the live market valuation belongs when none came back — screen AND PDF, one owner. Replaces
// the false "Unavailable — engine used wider confidence range" (no code widens anything; batch 135) and the PDF's silence.
export const NO_VALUATION_NOTE = "No market valuation was returned for this vehicle, so the after-repair value, bid ladder and rebuild ceiling are not shown. The repair estimate above is complete.";

export const CAT_NU_DIRECTIVE = "The key unknowns above should be independently verified before bidding — lower structural risk than a Cat S, but they remain unquantified downside.";

// Category letter → bid directive, or null for no directive. Format branches mirror the assess route's catLetter
// (cat/category X · X repairable · bare X) but extend to 'u' — catLetter omits U, this must recognise it (Cat U → NU,
// ruled intended). Callers render the Bid Directive only when this returns a string.
export function categoryDirective(categoryRaw) {
  const t = String(categoryRaw || '').trim().toLowerCase();
  const m = t.match(/^cat(?:egory)?\s+([snu])\b/) || t.match(/^([snu])\s+repairable/) || t.match(/^([snu])$/);
  const letter = m ? m[1] : null;
  return (letter === 'n' || letter === 'u') ? CAT_NU_DIRECTIVE : null;
}

// Sale-passed reject strings (Commit 4). Returned as the 4xx error body when a lot's auction has
// already taken place — before any charge / credential consumption. Variant per entry path.
export const SALE_PASSED_REJECT_PAID  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so no payment has been taken.";
export const SALE_PASSED_REJECT_PROMO = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your code has not been used.";
export const SALE_PASSED_REJECT_FREE  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your free report has not been used.";
