// ─────────────────────────────────────────────────────────────────────────────
// SERVICE_HISTORY_COVERAGE — the SINGLE source of OE service-history coverage.
// Both the server (app/api/vehicle/route.js) and the browser (the menu gate in app/page.js)
// import this. It was previously an inline Map in vehicle/route.js, server-only and evaluated
// only AFTER payment — so the menu could offer Service History on a car the vendor cannot cover,
// which then charged and refunded. Lifting it lets the menu gate on make + year BEFORE payment,
// turning a would-be refund into a non-sale.
//
// The two large, knowable exclusions — make not covered, pre-2012 — are enforceable client-side
// because the free DVLA lookup returns make and year before checkout. VIN presence is NOT knowable
// pre-payment (DVLA returns no VIN), so it stays a server-side outcome with the existing honest
// post-purchase refund path (the wording merged at 916b222). Do NOT add a paid call to learn the
// VIN before purchase.
//
// Coverage tiers: 'full' | 'limited' | 'workshop'. The presence of a make in the Map (any tier) is
// what makes it offerable; the tier is carried through for the report copy.
// ─────────────────────────────────────────────────────────────────────────────

export const SERVICE_HISTORY_COVERAGE = new Map([
  ['AUDI', 'full'], ['BMW', 'full'], ['CUPRA', 'full'], ['FORD', 'full'],
  ['HONDA', 'full'], ['INFINITI', 'full'], ['JAGUAR', 'full'], ['LAND ROVER', 'full'],
  ['LEXUS', 'full'], ['MAZDA', 'full'], ['MERCEDES-BENZ', 'full'], ['MINI', 'full'],
  ['NISSAN', 'full'], ['OPEL', 'full'], ['PORSCHE', 'full'], ['SEAT', 'full'],
  ['SKODA', 'full'], ['TOYOTA', 'full'], ['VAUXHALL', 'full'], ['VOLKSWAGEN', 'full'],
  ['AIXAM', 'limited'], ['ALPINE', 'limited'], ['BENTLEY', 'limited'], ['DAF', 'limited'],
  ['DS', 'limited'], ['FERRARI', 'limited'], ['IVECO', 'limited'], ['MASERATI', 'limited'],
  ['PIAGGIO', 'limited'], ['SUBARU', 'limited'], ['SUZUKI', 'limited'], ['YAMAHA', 'limited'],
  ['ALFA ROMEO', 'workshop'], ['CHRYSLER', 'workshop'], ['CITROEN', 'workshop'],
  ['DACIA', 'workshop'], ['DODGE', 'workshop'], ['FIAT', 'workshop'], ['JEEP', 'workshop'],
  ['KIA', 'workshop'], ['PEUGEOT', 'workshop'], ['POLESTAR', 'workshop'],
  ['RENAULT', 'workshop'], ['VOLVO', 'workshop'],
]);

// OE coverage starts at MODEL YEAR 2012. DVLA gives year of MANUFACTURE, so a car built late 2011
// could be a 2012 model — the pre-2012 client gate therefore only excludes years strictly below 2012,
// matching the server's own floor at the two call sites.
export const SERVICE_HISTORY_MIN_YEAR = 2012;

/**
 * serviceHistoryOfferable — the pre-payment gate the MENU uses. Make + year only, because those are
 * the two facts the free DVLA lookup returns before checkout. VIN is deliberately NOT checked here.
 * @param {{ make?:string, yearOfManufacture?:number|string }} v
 * @returns {{ offerable:boolean, reason:null|'make_not_covered'|'pre_2012', tier:string|null }}
 */
export function serviceHistoryOfferable({ make, yearOfManufacture } = {}) {
  const m = String(make || '').toUpperCase().trim();
  const tier = SERVICE_HISTORY_COVERAGE.get(m) || null;
  if (!tier) return { offerable: false, reason: 'make_not_covered', tier: null };
  if (yearOfManufacture && Number(yearOfManufacture) < SERVICE_HISTORY_MIN_YEAR) {
    return { offerable: false, reason: 'pre_2012', tier };
  }
  return { offerable: true, reason: null, tier };
}
