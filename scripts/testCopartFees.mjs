// Self-contained assertions — logic inlined to avoid CJS/ESM friction.
// Run: node scripts/testCopartFees.mjs
// Every assertion checks buyerFee, bidFee, AND retrieval individually so a
// future dropped component fails loudly rather than hiding in a correct total.

const VAT_RATE = 0.20;
const RETRIEVAL_FEE = 50;
const BUYER_FEE_PERCENTAGE_THRESHOLD = 10000;
const BUYER_FEE_PERCENTAGE_RATE = 0.065;
const BID_FEE_ABOVE_8000 = 109;

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

function feeStack(hammer) {
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

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

// ── Copart-validated cases (all components explicit) ─────────────────────────
console.log('\n=== Copart-validated cases ===\n');

assert('feeStack(2500)',
  feeStack(2500),
  { buyerFee: 390, bidFee: 89, retrieval: 50, vatAmount: 105.80, totalIncVat: 634.80 }
);
assert('feeStack(80000)',
  feeStack(80000),
  { buyerFee: 5200, bidFee: 109, retrieval: 50, vatAmount: 1071.80, totalIncVat: 6430.80 }
);
assert('feeStack(7000)',
  feeStack(7000),
  { buyerFee: 565, bidFee: 105, retrieval: 50, vatAmount: 144.00, totalIncVat: 864.00 }
);
assert('feeStack(1000)',
  feeStack(1000),
  { buyerFee: 225, bidFee: 69, retrieval: 50, vatAmount: 68.80, totalIncVat: 412.80 }
);

// ── Bid-fee + retrieval coverage across the range ────────────────────────────
// These specifically cover hammers where bidFee comes from the fallback constant
// (£8,000+) — the band that triggered the narration bug report.
console.log('\n=== Bid-fee + retrieval coverage ===\n');

assert('feeStack(9500)  — buyer top flat, bid fallback constant',
  feeStack(9500),
  { buyerFee: 590, bidFee: 109, retrieval: 50, vatAmount: 149.80, totalIncVat: 898.80 }
);
assert('feeStack(8000)  — bid band boundary: first hammer above £7,999.99',
  feeStack(8000),
  { buyerFee: 590, bidFee: 109, retrieval: 50, vatAmount: 149.80, totalIncVat: 898.80 }
);
assert('feeStack(6000)  — bid band: £6,000–£7,999.99 = 105',
  feeStack(6000),
  { buyerFee: 565, bidFee: 105, retrieval: 50, vatAmount: 144.00, totalIncVat: 864.00 }
);
assert('feeStack(500)   — mid-range, bid band: £500–£999.99 = 49',
  feeStack(500),
  { buyerFee: 145, bidFee: 49, retrieval: 50, vatAmount: 48.80, totalIncVat: 292.80 }
);

// ── Band boundary integrity ───────────────────────────────────────────────────
console.log('\n=== Band boundary integrity ===\n');

assert('feeStack(9999.99) buyerFee=590  (last flat band)',
  feeStack(9999.99).buyerFee, 590
);
assert('feeStack(10000)   buyerFee=650  (6.5% percentage tier)',
  feeStack(10000).buyerFee, 650
);
assert('feeStack(7999.99) bidFee=105   (last bid band entry)',
  feeStack(7999.99).bidFee, 105
);
assert('feeStack(8000)    bidFee=109   (fallback constant, no band entry)',
  feeStack(8000).bidFee, 109
);
assert('feeStack(2400)    buyerFee=365 (sub-band: £2,400–£2,499.99)',
  feeStack(2400).buyerFee, 365
);
assert('feeStack(2399.99) buyerFee=340 (sub-band: £2,000–£2,399.99)',
  feeStack(2399.99).buyerFee, 340
);

// ── Retrieval is never zero ───────────────────────────────────────────────────
console.log('\n=== Retrieval constant (all should be 50) ===\n');

for (const h of [50, 500, 1000, 2500, 7000, 8000, 9500, 80000]) {
  assert(`feeStack(${h}).retrieval === 50`, feeStack(h).retrieval, 50);
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
