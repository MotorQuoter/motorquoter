// Self-contained assertions for the IAA UK / SYNETIQ fee stack — logic inlined to
// avoid CJS/ESM friction (mirrors lib/iaaFees.js verbatim; if you edit the bands
// there, mirror them here). Run: node scripts/testIaaFees.mjs
// Every assertion checks buyerFee, bidFee, AND retrieval individually so a future
// dropped component fails loudly rather than hiding in a correct total.
//
// £2,510 sample lot → buyer £380 (£2,500–£2,999.99 band) + admin £89 + retrieval £50
// = £519, +VAT £103.80 = £622.80 totalIncVat. (Cowork's ruling, 4 Aug: the band table
// is authoritative; the earlier worked-check £330/£562.80 grabbed the band one too low.)

const VAT_RATE = 0.20;
const RETRIEVAL_FEE = 50;
const BUYER_FEE_PERCENTAGE_THRESHOLD = 10000;
const BUYER_FEE_PERCENTAGE_RATE = 0.064;
const ADMIN_FEE_ABOVE_MAX = 109;

const BUYER_FEE_BANDS = [
  { max:    49.99, fee:  10 }, { max:    99.99, fee:  55 }, { max:   199.99, fee:  75 },
  { max:   299.99, fee:  95 }, { max:   349.99, fee: 105 }, { max:   399.99, fee: 115 },
  { max:   449.99, fee: 125 }, { max:   499.99, fee: 130 }, { max:   549.99, fee: 135 },
  { max:   599.99, fee: 140 }, { max:   699.99, fee: 155 }, { max:   799.99, fee: 170 },
  { max:   899.99, fee: 185 }, { max:   999.99, fee: 200 }, { max:  1199.99, fee: 215 },
  { max:  1299.99, fee: 235 }, { max:  1399.99, fee: 245 }, { max:  1499.99, fee: 255 },
  { max:  1599.99, fee: 265 }, { max:  1699.99, fee: 275 }, { max:  1799.99, fee: 290 },
  { max:  1999.99, fee: 300 }, { max:  2399.99, fee: 330 }, { max:  2499.99, fee: 355 },
  { max:  2999.99, fee: 380 }, { max:  3499.99, fee: 415 }, { max:  3999.99, fee: 455 },
  { max:  4499.99, fee: 500 }, { max:  4999.99, fee: 525 }, { max:  5999.99, fee: 545 },
  { max:  7499.99, fee: 555 }, { max:  9999.99, fee: 580 },
];
const ADMIN_FEE_BANDS = [
  { max:    99.99, fee:   0 }, { max:   499.99, fee:  35 }, { max:   999.99, fee:  49 },
  { max:  1499.99, fee:  69 }, { max:  1999.99, fee:  79 }, { max:  3999.99, fee:  89 },
  { max:  5999.99, fee:  99 }, { max:  7499.99, fee: 105 },
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
  const adminBand = ADMIN_FEE_BANDS.find(b => h <= b.max);
  const bidFee = adminBand ? adminBand.fee : ADMIN_FEE_ABOVE_MAX;
  const retrieval = RETRIEVAL_FEE;
  const subTotal = buyerFee + bidFee + retrieval;
  const vatAmount = Math.round(subTotal * VAT_RATE * 100) / 100;
  const totalIncVat = Math.round((subTotal + vatAmount) * 100) / 100;
  return { buyerFee, bidFee, retrieval, vatAmount, totalIncVat };
}

let passed = 0, failed = 0;
function assert(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); console.error(`        expected: ${JSON.stringify(expected)}`); console.error(`        got:      ${JSON.stringify(got)}`); failed++; }
}

// ── Worked check: £2,510 sample lot (Cowork-confirmed £622.80) ────────────────
console.log('\n=== Worked check: £2,510 sample lot ===\n');
assert('feeStack(2510)  — buyer 380 + admin 89 + retrieval 50 = £622.80',
  feeStack(2510),
  { buyerFee: 380, bidFee: 89, retrieval: 50, vatAmount: 103.80, totalIncVat: 622.80 }
);
// Lower band edge for contrast — the £2,000–£2,399.99 band (buyer 330):
assert('feeStack(2399.99) — buyer 330 band',
  feeStack(2399.99),
  { buyerFee: 330, bidFee: 89, retrieval: 50, vatAmount: 93.80, totalIncVat: 562.80 }
);

// ── ≥£10k percentage tier (6.4%) ──────────────────────────────────────────────
console.log('\n=== Percentage tier (6.4%) ===\n');
assert('feeStack(10000) — 6.4% buyer, admin fallback 109',
  feeStack(10000),
  { buyerFee: 640, bidFee: 109, retrieval: 50, vatAmount: 159.80, totalIncVat: 958.80 }
);
assert('feeStack(20000) — 6.4% buyer',
  feeStack(20000).buyerFee, 1280
);

// ── Buyer band boundaries ─────────────────────────────────────────────────────
console.log('\n=== Buyer band boundaries ===\n');
assert('feeStack(49.99)  buyerFee=10  (first band)',   feeStack(49.99).buyerFee, 10);
assert('feeStack(50)     buyerFee=55  (second band)',  feeStack(50).buyerFee, 55);
assert('feeStack(2399.99) buyerFee=330',               feeStack(2399.99).buyerFee, 330);
assert('feeStack(2400)   buyerFee=355',                feeStack(2400).buyerFee, 355);
assert('feeStack(2500)   buyerFee=380',                feeStack(2500).buyerFee, 380);
assert('feeStack(9999.99) buyerFee=580 (last flat band)', feeStack(9999.99).buyerFee, 580);
assert('feeStack(10000)  buyerFee=640 (6.4% tier)',    feeStack(10000).buyerFee, 640);

// ── Admin fee (bidFee slot) boundaries ────────────────────────────────────────
console.log('\n=== Admin fee boundaries ===\n');
assert('feeStack(99.99)  bidFee=0',   feeStack(99.99).bidFee, 0);
assert('feeStack(100)    bidFee=35',  feeStack(100).bidFee, 35);
assert('feeStack(7499.99) bidFee=105 (last band)',   feeStack(7499.99).bidFee, 105);
assert('feeStack(7500)   bidFee=109 (fallback constant)', feeStack(7500).bidFee, 109);

// ── Retrieval is never zero ───────────────────────────────────────────────────
console.log('\n=== Retrieval constant (all should be 50) ===\n');
for (const h of [50, 500, 1000, 2510, 7000, 8000, 10000, 20000]) {
  assert(`feeStack(${h}).retrieval === 50`, feeStack(h).retrieval, 50);
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
