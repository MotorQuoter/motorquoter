export const ROI_TIERS = [
  {
    key: 'roi_free',
    label: 'Identity Only',
    addOn: 0,
    addOnEUR: 0,
    description: 'Vehicle identity from ROI register',
    features: ['Make, model, year, colour', 'Engine size & fuel type', 'NCT status', 'First registration date'],
  },
  {
    key: 'roi_standard',
    label: 'Standard',
    addOn: 4.99,
    addOnEUR: 5.99,
    description: 'Identity + current market valuation + demand',
    features: ['Everything in Identity', 'Current market valuation', 'Market demand score', 'Days to sell estimate'],
  },
  {
    key: 'roi_pro',
    label: 'Pro',
    addOn: 12.99,
    addOnEUR: 15.99,
    description: 'Standard + future valuation + price guide',
    features: ['Everything in Standard', 'Future value projection', 'Market price guide', 'Depreciation forecast'],
  },
  {
    key: 'roi_history',
    label: 'History',
    addOn: 17.99,
    addOnEUR: 20.99,
    description: 'Pro + full Cartell vehicle history check',
    features: ['Everything in Pro', 'Full Cartell history', 'Outstanding finance', 'Ownership count'],
  },
];

export const IE_MENU = [
  {
    key: 'ie_valuation',
    label: 'Valuation',
    description: 'Trade and retail values for the Irish market',
    price: 2.99,
    priceEUR: 3.99,
    preSelected: true,
    locked: true,
    enabled: true,
  },
  {
    key: 'ie_nct',
    // Honest name (batch 38): we serve STATUS only — cartell/vehicleidentity.nct_due_date gives the
    // due date and a Valid/Expired verdict. There is no test-history product (cartell/ncthistory/v1
    // 404s), so the label/description promise no history, past tests or records.
    label: 'NCT Status',
    description: 'NCT due date and Valid/Expired status',
    price: 0,
    priceEUR: 0,
    preSelected: true,   // unchanged — the pre-selected/locked/£0 question is separate (batch 38 §4)
    locked: true,
    enabled: true,
  },
  {
    key: 'ie_service_history',
    label: 'Service History',
    description: 'OE digital service records where available',
    // IE sterling-price rule (config/ieMenuPricing.mjs): €5.99 ÷ 1.17 = £5.12 → nearest .99 = £4.99.
    price: 4.99,       // ⚠️ LIVE −1p (was £5.00) — the default GBP charging path for an IE customer.
    priceEUR: 5.99,
    preSelected: false,
    locked: false,
    enabled: true,
  },
  {
    key: 'ie_history',
    label: 'Full History Check',
    description: 'Cartell — write-off, finance, mileage, stolen, tax, NCT detail',
    // IE sterling-price rule (config/ieMenuPricing.mjs): €24.99 ÷ 1.17 = £21.36 → nearest .99 = £20.99.
    // priceEUR €24.99 is the 16 Aug decision; £20.99 is its sterling twin under the rule (Vincent, 22
    // Aug — batch 32). Still enabled:false, so no live exposure. ROI_TIERS deletion rides the ROI menu
    // work, not here.
    price: 20.99,      // derived; do NOT edit in isolation — change priceEUR and re-derive via the rule
    priceEUR: 24.99,
    preSelected: false,
    locked: false,
    enabled: false,
  },
];

export const PRICING = {
  menu: [
    {
      key: 'valuation',
      label: 'Valuation',
      description: 'Trade, retail and private sale values',
      price: 1.99,
      preSelected: true,
      locked: true,
      enabled: true,
    },
    // Full History Check — single Experian AutoCheck (£2.00 list / £2.40 true, VAT-inc; we are not
    // VAT registered and cannot reclaim). Supersedes the former writeoff/finance/stolen singles, which
    // each forced the same £2.40 call against a sub-£2.50 sale and lost money bought alone (VAT finding,
    // 20 Aug). Those three keys are removed from the menu; their render components stay for already-paid
    // historical reports. One call now serves six blocks: write-off/Cat S·N, finance, stolen, high-risk
    // markers, plate changes and previous searches.
    {
      key: 'full_history',
      label: 'Full History Check',
      description: 'Write-off & Cat S/N, outstanding finance, stolen marker, high-risk markers (ex-fleet/ex-rental & recorded interests), plate changes and previous searches — one Experian AutoCheck.',
      price: 6.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'salvagehistory',
      label: 'Salvage History Check',
      description: 'See if this vehicle has been previously sold at a salvage auction — lot date, damage description, mileage, and photos from prior listings',
      price: 1.49,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'market_demand',
      label: 'Market Demand',
      description: 'How quickly this vehicle sells in the current market',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'previous_adverts',
      label: 'Previous Adverts',
      description: 'Previous asking prices and listings for this vehicle',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'mot',
      label: 'MOT History',
      description: 'Full MOT pass/fail history from DVSA',
      price: 0,
      preSelected: true,
      locked: true,
      enabled: true,
    },
    {
      key: 'mileage_detail',
      label: 'Mileage / Clocking Check',
      description: 'Full MOT mileage timeline with rollback detection (mi & km normalised). A free verdict shows on your lookup; this adds the detailed reading-by-reading timeline to your report.',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'service_history',
      label: 'Service History',
      description: 'OE manufacturer service records where available',
      // £3.49 → £4.99 (20 Aug): at true cost (£2.50 list / £3.00 inc VAT) the old price cleared 7%.
      // Offered only when the vehicle passes the coverage gate (make + year, client-side; VIN checked
      // server-side) so a legitimately-uncovered car is a non-sale, not a charge-then-refund.
      price: 4.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'owner_history',
      label: 'Owner / Keeper History',
      description: 'Number of previous keepers, each ownership-change date, and any previous registration plates (GB & NI).',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      // Road tax (VED) — COMPUTED from the free DVLA payload (reg date, CO2, fuel, engine size). Cost £0;
      // One Auto's tax endpoint adds nothing we cannot compute (list price is an optional input there too,
      // and DVLA never returns it — the expensive-car supplement is shown as a conditional line, never
      // silently omitted). Guide-only framing, same discipline as VRT. See lib/roadTax.mjs.
      key: 'road_tax',
      label: 'Road Tax Cost',
      description: 'Annual road tax (VED) for this vehicle, worked out from its DVLA record — registration date, CO2, fuel type and engine size.',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: true,
    },
    {
      key: 'salvage_predictor',
      label: 'Salvage Bid Predictor',
      description: 'Predicted auction hammer price for salvage vehicles',
      price: 0.99,
      preSelected: false,
      locked: false,
      enabled: false,
    },
  ],
  salvageAssessment: {
    price: 8.99,
    priceEUR: 10.99, // EUR opt-in (ROI/IE lots only); GBP remains the default base
    enabled: true,
  },
}
