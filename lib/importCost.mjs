// ─────────────────────────────────────────────────────────────────────────────
// Import Cost Estimator — pure, deterministic (Category A cars). No model, no I/O.
// ─────────────────────────────────────────────────────────────────────────────
// Computes the Irish import charge stack for a GB/NI car:
//   VRT (CO2 charge + NOx levy)  +  (GB only) VAT 23%  +  customs-duty FLAG.
// Every figure is derived by code from config/vrt.mjs. VRT is an ESTIMATE (binding
// figure set by Revenue/NCTS at inspection); VAT/customs are INDICATIVE. Callers must
// surface those disclaimers. Degrades gracefully: missing inputs narrow the answer,
// never fabricate one.

import {
  CO2_BANDS, VRT_MINIMUM, NOX_TIERS, NOX_CAP, EURO_NOX_ESTIMATE,
  VAT_RATE, CUSTOMS_DUTY_RATE,
} from '../config/vrt.mjs';

// Normalise a fuel string to one of: 'electric' | 'diesel' | 'hybrid' | 'petrol' | null.
export function normaliseFuel(fuel) {
  const s = String(fuel || '').toLowerCase();
  if (!s) return null;
  if (/electric|\bev\b|battery/.test(s) && !/hybrid/.test(s)) return 'electric';
  if (/hybrid|phev|hev|plug/.test(s)) return 'hybrid';
  if (/diesel|\bhdi\b|\btdi\b|\bdci\b/.test(s)) return 'diesel';
  if (/petrol|gasoline|\bpetol\b|hybrid.?petrol/.test(s)) return 'petrol';
  return null;
}

// For NOx: hybrids and anything non-diesel/non-EV are treated on the petrol/"other" side
// (petrol Euro limits, €600 cap) per Revenue. EVs are excluded (NOx = €0) upstream.
function noxFuelClass(fuel) {
  const f = normaliseFuel(fuel);
  if (f === 'electric') return 'electric';
  if (f === 'diesel') return 'diesel';
  return 'other'; // petrol, hybrid, unknown-but-combustion
}

// Parse a Euro standard (1–6) from: a number; "Euro 6"; a derivative string that embeds it
// ("… 2.0 TDI Euro 6 …"); OR One Auto's bare emission_class code — "6", "6b", "6c", "6d",
// "6d-temp", "5a" (confirmed live 31 Jul: GY67LLD="6b", FE68AOP="6c"). The sub-phase letter is
// discarded — 6a/6b/6c/6d are all Euro 6. Returns an integer 1–6 or null.
export function parseEuroClass(euroClass) {
  if (euroClass == null) return null;
  if (typeof euroClass === 'number' && Number.isFinite(euroClass)) {
    const n = Math.trunc(euroClass);
    return n >= 1 && n <= 6 ? n : null;
  }
  const s = String(euroClass);
  let m = s.match(/euro\s*([1-6])/i);           // "Euro 6" / "…Euro 6…"
  if (m) return Number(m[1]);
  m = s.match(/^\s*([1-6])[a-z]?(?:-?temp)?\s*$/i); // bare code: "6", "6b", "6d-temp", "5a"
  return m ? Number(m[1]) : null;
}

// The CO2 band for a given g/km. Returns the band object; null if co2 is not a finite number.
export function co2Band(co2) {
  const c = typeof co2 === 'string' ? parseFloat(co2.replace(/[^\d.]/g, '')) : co2;
  if (!Number.isFinite(c) || c < 0) return null;
  return CO2_BANDS.find(b => c <= b.maxCo2) || CO2_BANDS[CO2_BANDS.length - 1];
}

// Tiered NOx levy (€) for a given mg/km, before any cap. Cumulative across boundaries.
export function noxLevyRaw(noxMgKm) {
  const n = Number(noxMgKm);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let levy = 0, prev = 0;
  for (const tier of NOX_TIERS) {
    const upper = Math.min(n, tier.upTo);
    if (upper > prev) levy += (upper - prev) * tier.rate;
    prev = upper;
    if (n <= tier.upTo) break;
  }
  return Math.round(levy);
}

const euro = n => `€${Math.round(n).toLocaleString('en-IE')}`;

// ── CO2 charge ────────────────────────────────────────────────────────────────
// Returns { co2Charge, band, rate, floorApplied } or null if CO2 unknown.
function computeCo2Charge(co2, omsp) {
  const band = co2Band(co2);
  if (!band || !Number.isFinite(Number(omsp)) || Number(omsp) <= 0) return null;
  const raw = Math.round(band.rate * Number(omsp));
  const floorApplied = raw < band.min;
  return { co2Charge: Math.max(raw, band.min, VRT_MINIMUM), band, rate: band.rate, floorApplied };
}

// ── NOx levy (estimate / override / cap) ─────────────────────────────────────
// Returns { noxLevy, noxBasis, noxMgKm, capped }.
function computeNox({ fuel, euroClass, noxOverride }) {
  const cls = noxFuelClass(fuel);
  if (cls === 'electric') {
    return { noxLevy: 0, noxBasis: 'pure electric — NOx levy does not apply (€0)', noxMgKm: 0, capped: false };
  }
  const cap = cls === 'diesel' ? NOX_CAP.diesel : NOX_CAP.other;
  const fuelLabel = cls === 'diesel' ? 'diesel' : 'petrol/hybrid';

  // 1) Exact figure from the buyer's V5C (box V.3) — documented, NOT capped.
  if (noxOverride != null && Number.isFinite(Number(noxOverride)) && Number(noxOverride) >= 0) {
    return {
      noxLevy: noxLevyRaw(noxOverride),
      noxBasis: `from your V5C (${Number(noxOverride)} mg/km)`,
      noxMgKm: Number(noxOverride), capped: false,
    };
  }

  // 2) Estimate from Euro standard + fuel — capped at the fuel's undocumented cap.
  const e = parseEuroClass(euroClass);
  const table = cls === 'diesel' ? EURO_NOX_ESTIMATE.diesel : EURO_NOX_ESTIMATE.petrol;
  if (e != null && table[e] != null) {
    const raw = noxLevyRaw(table[e]);
    const capped = raw > cap;
    return {
      noxLevy: Math.min(raw, cap),
      noxBasis: `estimated from Euro ${e} ${fuelLabel} (${table[e]} mg/km limit)${capped ? `, capped at ${euro(cap)}` : ''}`,
      noxMgKm: table[e], capped,
    };
  }

  // 3) Nothing to go on → statutory undocumented cap.
  return {
    noxLevy: cap,
    noxBasis: `NOx undocumented — statutory ${fuelLabel} cap ${euro(cap)} applied`,
    noxMgKm: null, capped: true,
  };
}

// ── Provenance → VAT / customs ───────────────────────────────────────────────
// 'ROI'  → not an import (estimator N/A)
// 'NI'   → NI-qualifying (Windsor Framework): VRT only, no VAT/customs
// 'GB'   → GB direct: VRT + VAT 23% + customs-duty FLAG (origin-dependent)
const PROVENANCE = new Set(['GB', 'NI', 'ROI']);

/**
 * estimateImportCost — the single deterministic entry point.
 * @param {object} p
 *   omsp          {number}  Irish OMSP proxy (Brego Ireland retail). Required for VRT.
 *   co2           {number|string} CO2 g/km. Required for the CO2 charge.
 *   euroClass     {string|number} e.g. "Euro 6" (default NOx basis).
 *   fuel          {string}  fuel type.
 *   noxOverride   {number}  optional exact NOx (mg/km) from the V5C — overrides the estimate.
 *   provenance    {'GB'|'NI'|'ROI'} where the car legally is/was. Default 'GB'.
 *   purchasePrice {number}  what the buyer is paying (for VAT). GB only.
 *   category      {'A'|'B'} VRT category. Only 'A' is supported in v1.
 * @returns {object} { supported, reason?, vrt, vat, customsDutyFlag, grandTotal, basis, notes }
 */
// ── New means of transport (VAT) ──────────────────────────────────────────────
// Revenue: a vehicle is "new" for VAT if EITHER limb is met — 6 months old or less since first
// registration, OR 6,000 km or less. A NEW vehicle attracts Irish VAT at 23% REGARDLESS of NI
// reliefs or seller (an intra-Community acquisition of a new means of transport is taxable on the
// acquirer either way). Source: revenue.ie/en/vrt/calculating-vrt/vat-customs-duty.aspx (16 Aug 2026).
// Pure/deterministic — the caller supplies ageMonths + odometerKm (already unit-converted to km);
// no Date/unit logic here so it is trivially unit-tested.
export const NEW_MEANS_AGE_MONTHS = 6;
export const NEW_MEANS_KM = 6000;
const NEAR_AGE_MONTHS = 1;   // within 1 month of the age limb → "near", flag don't decide
const NEAR_KM = 1000;        // within 1,000 km of the distance limb → "near"

export function classifyNewMeansOfTransport({ ageMonths, odometerKm } = {}) {
  const ageKnown = Number.isFinite(ageMonths) && ageMonths >= 0;
  const kmKnown  = Number.isFinite(odometerKm) && odometerKm >= 0;
  const ageNew = ageKnown && ageMonths <= NEW_MEANS_AGE_MONTHS;
  const kmNew  = kmKnown  && odometerKm <= NEW_MEANS_KM;
  const isNew  = ageNew || kmNew;
  const ageNear = ageKnown && !ageNew && ageMonths <= NEW_MEANS_AGE_MONTHS + NEAR_AGE_MONTHS;
  const kmNear  = kmKnown  && !kmNew  && odometerKm <= NEW_MEANS_KM + NEAR_KM;
  const near = !isNew && (ageNear || kmNear);
  // The distance limb is uncheckable when km is unknown AND age has not already settled "new".
  const distanceUncheckable = !kmKnown && !ageNew;
  return {
    isNew, near, ageNew, kmNew, ageKnown, kmKnown, distanceUncheckable,
    ageMonths: ageKnown ? ageMonths : null,
    odometerKm: kmKnown ? odometerKm : null,
  };
}

export function estimateImportCost({
  omsp, co2, euroClass, fuel, noxOverride,
  provenance = 'GB', purchasePrice, category = 'A',
  ageMonths, odometerKm,
} = {}) {
  const notes = [];

  // Category gate — vans (Cat B) and anything non-A are out of scope in v1.
  if (category && category !== 'A') {
    return { supported: false, reason: `VRT category ${category} not supported — v1 covers Category A passenger cars only.` };
  }
  const prov = PROVENANCE.has(provenance) ? provenance : 'GB';
  if (prov === 'ROI') {
    return { supported: false, reason: 'Already on Irish plates — not an import; VRT was paid at first registration.' };
  }

  const fuelNorm = normaliseFuel(fuel);
  const isEV = fuelNorm === 'electric';

  // ── VRT ──
  const co2Part = computeCo2Charge(co2, omsp);
  const noxPart = computeNox({ fuel, euroClass, noxOverride });
  let vrt = null;
  if (co2Part) {
    const total = co2Part.co2Charge + noxPart.noxLevy;
    vrt = {
      co2Charge: co2Part.co2Charge,
      noxLevy: noxPart.noxLevy,
      noxBasis: noxPart.noxBasis,
      total: Math.max(total, VRT_MINIMUM),
      floorApplied: co2Part.floorApplied,
      band: { rate: co2Part.rate, minCharge: co2Part.band.min, maxCo2: co2Part.band.maxCo2 },
    };
    if (isEV) notes.push('Electric vehicle — lowest CO2 band applied and NOx is €0; a VRT relief (up to €5,000) may further reduce the amount — check Revenue.');
  } else {
    notes.push(!Number.isFinite(Number(omsp)) || Number(omsp) <= 0
      ? 'No Irish valuation (OMSP) available — VRT cannot be estimated.'
      : 'CO2 figure unavailable — VRT cannot be estimated.');
  }

  // ── New means of transport: forces VAT regardless of NI reliefs / seller ──
  const nmt = classifyNewMeansOfTransport({ ageMonths, odometerKm });

  // ── VAT + customs ──
  // VAT applies on a GB import OR on ANY new means of transport (incl. NI/pre-2021). Customs duty is
  // a separate, GB-origin-only concern (NI-sourced cars carry no duty), independent of the VAT limb.
  let vat = 0;
  let customsDutyFlag;
  const price = Number(purchasePrice);
  const havePrice = Number.isFinite(price) && price > 0;
  const vatApplies = prov === 'GB' || nmt.isNew;

  if (prov === 'NI') {
    customsDutyFlag = {
      applies: false,
      note: nmt.isNew
        ? 'New means of transport: Irish VAT at 23% is due regardless of NI provenance. No customs duty (NI/EU goods).'
        : 'NI route (Windsor Framework): free of import VAT and customs duty IF the vehicle was legally imported into NI and is a USED vehicle. Evidence required — original V5C (last NI keeper) + NI service history + NI test history.',
    };
    if (!nmt.isNew) notes.push('NI route shown for a used vehicle — no VAT/customs, subject to the NI evidence above.');
  } else { // GB
    const dutyIndicative = havePrice ? Math.round(CUSTOMS_DUTY_RATE * price) : null;
    const dutyIndicativeWithVat = dutyIndicative != null
      ? dutyIndicative + Math.round(VAT_RATE * dutyIndicative)
      : null;
    customsDutyFlag = {
      applies: 'origin-dependent',
      rate: CUSTOMS_DUTY_RATE,
      indicativeAmount: dutyIndicative,
      indicativeWithVat: dutyIndicativeWithVat, // duty + VAT on the duty — the real add-on if it applies
      note: `Customs duty is ${Math.round(CUSTOMS_DUTY_RATE * 100)}% of the customs value UNLESS the car qualifies as UK preferential-origin under the TCA (then €0). If it applies, VAT is also charged on the duty${dutyIndicativeWithVat != null ? ` — about €${dutyIndicativeWithVat.toLocaleString('en-IE')} in total` : ''}. Origin cannot be determined automatically — treat as an open item. Not included in the headline total.`,
    };
  }

  // VAT 23% on the customs value (approximated from purchase price; transport/insurance/duty add to it).
  if (vatApplies) {
    if (havePrice) {
      vat = Math.round(VAT_RATE * price);
      notes.push(nmt.isNew
        ? 'This car counts as NEW for VAT (6 months old or less, or 6,000 km or less) — Irish VAT at 23% is due regardless of where it has been or who is selling it.'
        : 'VAT computed on purchase price only; the true customs value also includes transport, insurance and any customs duty — actual VAT will be a little higher.');
    } else {
      notes.push('Purchase price not provided — VAT (23%) not computed.');
    }
  }
  if (nmt.near) notes.push('This car is close to Revenue’s "new vehicle" threshold (near 6 months old or 6,000 km). Confirm with Revenue before relying on either figure.');
  if (nmt.distanceUncheckable) notes.push('We could not confirm the mileage, so the 6,000 km "new vehicle" limb could not be checked — if the car has 6,000 km or less it counts as new and VAT (23%) is due.');

  // ── Grand total: VRT + VAT. Customs duty is deliberately excluded (origin-dependent flag). ──
  const grandTotal = (vrt ? vrt.total : 0) + vat;

  const basis = {
    provenance: prov,
    omsp: Number.isFinite(Number(omsp)) ? Number(omsp) : null,
    omspBasis: 'Brego Ireland retail valuation (Irish market) used as the OMSP proxy — an estimate until NCTS.',
    fuel: fuelNorm,
    vatRate: vatApplies ? VAT_RATE : 0,
    grandTotalIncludes: vatApplies
      ? 'VRT + VAT. Excludes customs duty (origin-dependent) and any transport/insurance.'
      : 'VRT only. No VAT/customs (used NI-qualifying vehicle).',
    disclaimer: 'VRT is an estimate — the binding figure is set by Revenue/NCTS at inspection. VAT/customs are indicative.',
  };

  return { supported: true, vrt, vat, customsDutyFlag, grandTotal, basis, notes, newMeansOfTransport: nmt };
}

// Range wrapper (Ruling 3): run the estimate across Brego retail low/avg/high OMSP and return
// the spread with a central figure. Missing tiers fall back to whatever is present. `central` is
// the full estimate object at the average OMSP; low/high are the grand totals at the bounds.
export function estimateImportCostRange({ omspLow, omspAvg, omspHigh, ...rest }) {
  const avg = [omspAvg, omspHigh, omspLow].find(v => Number.isFinite(Number(v)) && Number(v) > 0);
  const central = estimateImportCost({ ...rest, omsp: avg });
  if (!central.supported) return central;
  const at = (o) => (Number.isFinite(Number(o)) && Number(o) > 0)
    ? estimateImportCost({ ...rest, omsp: Number(o) }) : null;
  const lo = at(omspLow), hi = at(omspHigh);
  return {
    ...central,
    range: {
      low:  lo ? lo.grandTotal : central.grandTotal,
      high: hi ? hi.grandTotal : central.grandTotal,
      vrtLow:  lo?.vrt ? lo.vrt.total : central.vrt?.total ?? null,
      vrtHigh: hi?.vrt ? hi.vrt.total : central.vrt?.total ?? null,
      omspLow:  Number(omspLow)  || null,
      omspAvg:  Number(avg)      || null,
      omspHigh: Number(omspHigh) || null,
    },
  };
}

// Presentation wrapper (Vincent's dual-figure ruling, batch 26). `sellerType` decides whether the
// buyer sees ONE outcome or a FORK of two, computed by calling the SAME engine twice — never a
// second cost code path. Presenting the NI figure beside the GB one is NOT applying it: the buyer
// is shown a fork, not steered. Nothing here authors a figure or asserts sufficiency.
//   'private' | 'dealer'  → DUAL: { ni (VRT only), gb (VRT+VAT+duty flag) }, equal weight, no default
//   'pre2021'             → SINGLE NI (EU goods before 1 Jan 2021 — genuinely unambiguous)
//   'gb' (or unknown)     → SINGLE GB (customs flagged per Option B)
export function estimateImportPresentation({ sellerType, ...inputs }) {
  const st = ['private', 'dealer', 'pre2021', 'gb'].includes(sellerType) ? sellerType : 'gb';
  // New means of transport: VAT is due regardless of seller/reliefs → NO evidence-dependent fork.
  // Collapse private/dealer to a SINGLE figure (NI provenance so no customs, but the engine applies
  // VAT because the car is new). pre2021/gb are already single and the engine handles VAT for them.
  const nmt = classifyNewMeansOfTransport(inputs);
  if (nmt.isNew && (st === 'private' || st === 'dealer')) {
    return { mode: 'single', sellerType: st, newMeansForcedSingle: true, ...estimateImportCostRange({ ...inputs, provenance: 'NI' }) };
  }
  if (st === 'private' || st === 'dealer') {
    const ni = estimateImportCostRange({ ...inputs, provenance: 'NI' });
    const gb = estimateImportCostRange({ ...inputs, provenance: 'GB' });
    return { mode: 'dual', sellerType: st, supported: ni.supported || gb.supported, dual: { ni, gb } };
  }
  const provenance = st === 'pre2021' ? 'NI' : 'GB';
  return { mode: 'single', sellerType: st, ...estimateImportCostRange({ ...inputs, provenance }) };
}
