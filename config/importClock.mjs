// Registration clock (batch 53 gap 4) — the two statutory deadlines a buyer is on the moment the car
// enters the State, and the fact that being late costs more.
//
// CONTENT, NOT A COMPUTED LIABILITY. We never know the customer's arrival date, so we NEVER compute a
// per-customer late charge, and we publish NO per-day formula: Revenue's public page states only that
// "additional VRT" becomes payable, with no multiplier (the master doc's VRT × 0.001 × days does NOT
// appear at source — Hard Rule 3 forbids printing an unverified figure). If a formula is ever wanted it
// must come from the VRT Tax and Duty Manual, cited.
//
// This is the one gap-4 item that survives even if the estimator is gutted to a checklist — it is
// checklist content, zero data cost, no supplier, no dependency on the OMSP question.
// Source: revenue.ie "VRT and registration" (7-day inspection, 30-day registration), read 24 Aug 2026.
export const REGISTRATION_CLOCK = {
  heading: 'Two deadlines once the car arrives in Ireland',
  lines: [
    'Book the NCTS registration inspection within 7 days of the vehicle arriving in the State.',
    'Complete registration within 30 days of it arriving.',
    'Miss the 30-day deadline and Revenue charge additional VRT — register promptly to avoid it.',
  ],
};
