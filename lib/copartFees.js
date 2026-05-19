const FEE_B_TIERS = [
  { max: 99,    buyersFee: 50,  band: '£0–£99' },
  { max: 499,   buyersFee: 75,  band: '£100–£499' },
  { max: 999,   buyersFee: 115, band: '£500–£999' },
  { max: 1499,  buyersFee: 155, band: '£1,000–£1,499' },
  { max: 1999,  buyersFee: 185, band: '£1,500–£1,999' },
  { max: 2999,  buyersFee: 220, band: '£2,000–£2,999' },
  { max: 3999,  buyersFee: 255, band: '£3,000–£3,999' },
  { max: 4999,  buyersFee: 280, band: '£4,000–£4,999' },
  { max: 5999,  buyersFee: 310, band: '£5,000–£5,999' },
  { max: 7999,  buyersFee: 350, band: '£6,000–£7,999' },
  { max: 9999,  buyersFee: 390, band: '£8,000–£9,999' },
  { max: 11999, buyersFee: 440, band: '£10,000–£11,999' },
  { max: 14999, buyersFee: 490, band: '£12,000–£14,999' },
];

const INTERNET_BID_TIERS = [
  { max: 99,   fee: 0 },
  { max: 499,  fee: 35 },
  { max: 999,  fee: 49 },
  { max: 1499, fee: 69 },
  { max: 1999, fee: 79 },
  { max: 3999, fee: 89 },
  { max: 5999, fee: 99 },
  { max: 7999, fee: 105 },
];

const LOT_RETRIEVAL_FEE = 50;

export function getCopartFees(hammerPrice) {
  const p = Number(hammerPrice);

  const feeBTier       = FEE_B_TIERS.find(t => p <= t.max);
  const internetTier   = INTERNET_BID_TIERS.find(t => p <= t.max);

  const buyersFee      = feeBTier    ? feeBTier.buyersFee : null;
  const internetBidFee = internetTier ? internetTier.fee  : 109;
  const band           = feeBTier    ? feeBTier.band      : '£15,000+';

  if (buyersFee === null) {
    return {
      buyersFee:       null,
      internetBidFee,
      lotRetrievalFee: LOT_RETRIEVAL_FEE,
      totalExVat:      null,
      totalIncVat:     null,
      band,
      note:            "Confirm buyer's fee with Copart — above standard table",
    };
  }

  const totalExVat = buyersFee + internetBidFee + LOT_RETRIEVAL_FEE;
  return {
    buyersFee,
    internetBidFee,
    lotRetrievalFee: LOT_RETRIEVAL_FEE,
    totalExVat,
    totalIncVat:     Math.round(totalExVat * 1.20),
    band,
  };
}

export function getAllCopartFeeBands() {
  const bands = FEE_B_TIERS.map(tier => getCopartFees(tier.max));
  bands.push(getCopartFees(15000));
  return bands;
}
