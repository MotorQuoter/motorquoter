// Single owner of the code-owned booking/inspection warning strings. When the inspection
// booking window is shut (sale within 48h) or the sale has already taken place, the checklist
// section is suppressed (see the section gate in success/page.js + pdf/route.js) and one of
// these lines renders in its place. Wording may be amended by the wording-markup pass; this is
// the single edit point. Reject strings (Commit 4) will live here too.
export const SALE_PASSED_WARNING = "Inspection no longer possible — the sale has taken place. The inspection-class risks in this report remain unverified; treat all flagged items as unresolved when judging this purchase.";

export const WINDOW_CLOSED_WARNING = "Inspection booking window closed — sale is within 48 hours. The inspection-class risks in this report can no longer be verified before bidding; treat all flagged items as unresolved and bid accordingly, or wait for the lot to relist.";
