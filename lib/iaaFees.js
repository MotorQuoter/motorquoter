// IAA UK / SYNETIQ buyer-fee stack — mirrors lib/copartFees.js shape exactly
// (feeStack(hammer) → { buyerFee, bidFee, retrieval, vatAmount, totalIncVat }) so the
// source-generic margin block in the assess route can call either interchangeably.
//
// Schedule: IAA UK "Standard-Volume" (eff. 1 Apr 2026) — the low-volume default, matching
// the Copart Fee-B choice. Update the bands here if IAA changes the schedule.
const VOLUME_TIER = 'Standard';                  // low-volume default (parallels Copart Fee B)
export const VAT_RATE = 0.20;
const RETRIEVAL_FEE = 50;                         // IAA "Location fee"
const BUYER_FEE_PERCENTAGE_THRESHOLD = 10000;    // at/above this: percentage applies
const BUYER_FEE_PERCENTAGE_RATE = 0.064;         // 6.4%
const ADMIN_FEE_ABOVE_MAX = 109;                 // admin fee above the top band

// Buyer's premium — flat bands up to £9,999.99, then percentage above.
// Each entry: hammer <= max → fee applies.
const BUYER_FEE_BANDS = [
  { max:    49.99, fee:  10 },
  { max:    99.99, fee:  55 },
  { max:   199.99, fee:  75 },
  { max:   299.99, fee:  95 },
  { max:   349.99, fee: 105 },
  { max:   399.99, fee: 115 },
  { max:   449.99, fee: 125 },
  { max:   499.99, fee: 130 },
  { max:   549.99, fee: 135 },
  { max:   599.99, fee: 140 },
  { max:   699.99, fee: 155 },
  { max:   799.99, fee: 170 },
  { max:   899.99, fee: 185 },
  { max:   999.99, fee: 200 },
  { max:  1199.99, fee: 215 },
  { max:  1299.99, fee: 235 },
  { max:  1399.99, fee: 245 },
  { max:  1499.99, fee: 255 },
  { max:  1599.99, fee: 265 },
  { max:  1699.99, fee: 275 },
  { max:  1799.99, fee: 290 },
  { max:  1999.99, fee: 300 },
  { max:  2399.99, fee: 330 },
  { max:  2499.99, fee: 355 },
  { max:  2999.99, fee: 380 },
  { max:  3499.99, fee: 415 },
  { max:  3999.99, fee: 455 },
  { max:  4499.99, fee: 500 },
  { max:  4999.99, fee: 525 },
  { max:  5999.99, fee: 545 },
  { max:  7499.99, fee: 555 },
  { max:  9999.99, fee: 580 },
];

// Admin fee (the `bidFee` slot) — hammer <= max → fee applies; above the top band → 109.
// Same band structure as Copart's bid fee, per the IAA schedule.
const ADMIN_FEE_BANDS = [
  { max:    99.99, fee:   0 },
  { max:   499.99, fee:  35 },
  { max:   999.99, fee:  49 },
  { max:  1499.99, fee:  69 },
  { max:  1999.99, fee:  79 },
  { max:  3999.99, fee:  89 },
  { max:  5999.99, fee:  99 },
  { max:  7499.99, fee: 105 },
];

/**
 * Returns the IAA UK / SYNETIQ fee stack for a given hammer price.
 * VAT applies to fees independently of VAT-on-Sale status (same as Copart).
 * Volume tier: Standard (low-volume default). Slot names mirror copartFees.feeStack:
 *   buyerFee  = buyer's premium
 *   bidFee    = admin fee
 *   retrieval = location fee (£50)
 */
export function feeStack(hammer) {
  const h = Number(hammer);

  let buyerFee;
  if (h >= BUYER_FEE_PERCENTAGE_THRESHOLD) {
    buyerFee = Math.round(h * BUYER_FEE_PERCENTAGE_RATE * 100) / 100;
  } else {
    const band = BUYER_FEE_BANDS.find(b => h <= b.max);
    buyerFee = band ? band.fee : BUYER_FEE_BANDS[BUYER_FEE_BANDS.length - 1].fee;
  }

  const adminBand = ADMIN_FEE_BANDS.find(b => h <= b.max);
  const bidFee = adminBand ? adminBand.fee : ADMIN_FEE_ABOVE_MAX;

  const retrieval = RETRIEVAL_FEE;
  const subTotal = buyerFee + bidFee + retrieval;
  const vatAmount = Math.round(subTotal * VAT_RATE * 100) / 100;
  const totalIncVat = Math.round((subTotal + vatAmount) * 100) / 100;

  return { buyerFee, bidFee, retrieval, vatAmount, totalIncVat };
}
