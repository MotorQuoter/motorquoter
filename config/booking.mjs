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
export const CAT_S_DIRECTIVE = "Do not bid on this lot without independently verifying the key unknowns above — this is a high-risk lot without further information.";
export const CAT_NU_DIRECTIVE = "The key unknowns above should be independently verified before bidding — lower structural risk than a Cat S, but they remain unquantified downside.";

// Category letter → bid directive. Worst case wins: only a confidently-N or -U category softens;
// Cat S, an unrecognised letter (A/B/C/D historic), or an absent category all get the strong
// directive. Format branches mirror the assess route's catLetter (cat/category X · X repairable ·
// bare X) but extend to 'u' — catLetter omits U, this must recognise it (Cat U → NU, ruled intended).
export function categoryDirective(categoryRaw) {
  const t = String(categoryRaw || '').trim().toLowerCase();
  const m = t.match(/^cat(?:egory)?\s+([snu])\b/) || t.match(/^([snu])\s+repairable/) || t.match(/^([snu])$/);
  const letter = m ? m[1] : null;
  return (letter === 'n' || letter === 'u') ? CAT_NU_DIRECTIVE : CAT_S_DIRECTIVE;
}

// Sale-passed reject strings (Commit 4). Returned as the 4xx error body when a lot's auction has
// already taken place — before any charge / credential consumption. Variant per entry path.
export const SALE_PASSED_REJECT_PAID  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so no payment has been taken.";
export const SALE_PASSED_REJECT_PROMO = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your code has not been used.";
export const SALE_PASSED_REJECT_FREE  = "This lot's auction has already taken place — an assessment can no longer inform a bid, so your free report has not been used.";
