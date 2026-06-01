// Named config constants — update here if Copart changes their fee schedule
const VOLUME_TIER = 'B';                          // Fee B: low-volume buyer default
const BID_TYPE = 'live';                          // Online Live Bid Fee
export const VAT_RATE = 0.20;
const RETRIEVAL_FEE = 50;
const BUYER_FEE_PERCENTAGE_THRESHOLD = 10000;     // at/above this: percentage applies
const BUYER_FEE_PERCENTAGE_RATE = 0.065;          // 6.5%
const BID_FEE_ABOVE_8000 = 109;                   // Online Live Bid Fee for £8,000+

// Fee B buyer fee — flat bands up to £9,999.99, then percentage above
// Each entry: hammer <= max → fee applies
const BUYER_FEE_BANDS = [
  { max:    49.99, fee:  20 },
  { max:    99.99, fee:  65 },
  { max:   199.99, fee:  85 },
  { max:   299.99, fee: 105 },
  { max:   349.99, fee: 115 },
  { max:   399.99, fee: 125 },
  { max:   449.99, fee: 135 },
  { max:   499.99, fee: 140 },
  { max:   549.99, fee: 145 },
  { max:   599.99, fee: 150 },
  { max:   699.99, fee: 165 },
  { max:   799.99, fee: 180 },
  { max:   899.99, fee: 195 },
  { max:   999.99, fee: 210 },
  { max:  1199.99, fee: 225 },
  { max:  1299.99, fee: 245 },
  { max:  1399.99, fee: 255 },
  { max:  1499.99, fee: 265 },
  { max:  1599.99, fee: 275 },
  { max:  1699.99, fee: 285 },
  { max:  1799.99, fee: 300 },
  { max:  1999.99, fee: 310 },
  { max:  2399.99, fee: 340 },
  { max:  2499.99, fee: 365 },
  { max:  2999.99, fee: 390 },
  { max:  3499.99, fee: 425 },
  { max:  3999.99, fee: 465 },
  { max:  4499.99, fee: 510 },
  { max:  4999.99, fee: 535 },
  { max:  5999.99, fee: 555 },
  { max:  7499.99, fee: 565 },
  { max:  9999.99, fee: 590 },
];

// Online Live Bid Fee bands; hammer <= max → fee applies; above £7,999.99 → BID_FEE_ABOVE_8000
const BID_FEE_BANDS = [
  { max:    99.99, fee:   0 },
  { max:   499.99, fee:  35 },
  { max:   999.99, fee:  49 },
  { max:  1499.99, fee:  69 },
  { max:  1999.99, fee:  79 },
  { max:  3999.99, fee:  89 },
  { max:  5999.99, fee:  99 },
  { max:  7999.99, fee: 105 },
];

/**
 * Returns the exact Copart UK fee stack for a given hammer price.
 * VAT applies to fees independently of VAT-on-Sale status.
 * Volume tier: B (conservative default). Bid type: Online Live.
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

  const bidBand = BID_FEE_BANDS.find(b => h <= b.max);
  const bidFee = bidBand ? bidBand.fee : BID_FEE_ABOVE_8000;

  const retrieval = RETRIEVAL_FEE;
  const subTotal = buyerFee + bidFee + retrieval;
  const vatAmount = Math.round(subTotal * VAT_RATE * 100) / 100;
  const totalIncVat = Math.round((subTotal + vatAmount) * 100) / 100;

  return { buyerFee, bidFee, retrieval, vatAmount, totalIncVat };
}
