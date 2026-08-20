// ─────────────────────────────────────────────────────────────────────────────
// Road tax (VED) — pure, deterministic. COMPUTED from the free DVLA payload; £0 cost.
// Guide-only, same discipline as config/vrt.mjs. Understating is the dangerous direction,
// so where a figure cannot be sourced we return null and say so — never a guessed number.
//
// SOURCE: gov.uk/vehicle-tax-rate-tables, transcribed 20 Aug 2026 (tax year 2025/26).
//   - CO2 bands (2001–2017) and the 2017+ standard rate + expensive-car supplement were read
//     directly off gov.uk on 20 Aug 2026 and are current for 2025/26.
//   - PRE-2001 engine-size rates are published ONLY in the V149 PDF (not in the HTML tables) and
//     could not be verified on 20 Aug 2026. They are intentionally left null here rather than
//     transcribed from memory. `estimateRoadTax` returns a guide-to-gov.uk line for pre-2001 cars.
//     ⚠️ TODO before pre-2001 is priced as a firm figure: transcribe the two rates from V149.
//
// RE-CHECK RULE: VED rates change every April (Budget). Re-verify this table each April, and
//   whenever a customer disputes a figure. The EV expensive-car threshold and the live Electric
//   Vehicle Excise Duty consultation may move these numbers — confirm before relying on them.
// ─────────────────────────────────────────────────────────────────────────────

// Standard 12-month rate by CO2 band, cars registered 1 Mar 2001 – 31 Mar 2017 (2025/26).
// Petrol/diesel figures. Alternative-fuel cars may pay up to £10 less per band; we use the
// petrol/diesel figure for all fuels so the guide never UNDERSTATES.
const CO2_BANDS_2001 = [
  { band: 'A', maxCo2: 100, annual: 20 },
  { band: 'B', maxCo2: 110, annual: 20 },
  { band: 'C', maxCo2: 120, annual: 35 },
  { band: 'D', maxCo2: 130, annual: 170 },
  { band: 'E', maxCo2: 140, annual: 200 },
  { band: 'F', maxCo2: 150, annual: 225 },
  { band: 'G', maxCo2: 165, annual: 275 },
  { band: 'H', maxCo2: 175, annual: 325 },
  { band: 'I', maxCo2: 185, annual: 360 },
  { band: 'J', maxCo2: 200, annual: 410 },
  { band: 'K', maxCo2: 225, annual: 445 },
  { band: 'L', maxCo2: 255, annual: 760 },
  { band: 'M', maxCo2: Infinity, annual: 790 },
];

// Cars registered on/after 1 Apr 2017 — standard (second licence onward) 12-month rate (2025/26).
// One flat figure for petrol/diesel/alternative/electric (electric became taxable Apr 2025).
const STANDARD_RATE_2017 = 200;
// Expensive-car supplement: added to the standard rate for 5 years (the 2nd–6th licences) where the
// list price when new exceeded the threshold. DVLA does NOT return list price, so this is shown as a
// CONDITIONAL line, never applied silently. £440/yr × 5 = £2,200 — omitting it is the costly error.
const EXPENSIVE_SUPPLEMENT = { amount: 440, years: 5, thresholdPetrolDiesel: 40000, thresholdElectric: 50000 };

const CUTOVER_2001 = Date.UTC(2001, 2, 1);   // 1 Mar 2001
const CUTOVER_2017 = Date.UTC(2017, 3, 1);   // 1 Apr 2017

// Parse "YYYY-MM" / "YYYY-MM-DD" (DVLA monthOfFirstRegistration is "YYYY-MM"); fall back to a bare year.
function regMs(firstRegistration, yearOfManufacture) {
  if (firstRegistration) {
    const m = String(firstRegistration).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  }
  if (yearOfManufacture && /^\d{4}$/.test(String(yearOfManufacture))) return Date.UTC(+yearOfManufacture, 5, 1);
  return null;
}

function isElectric(fuelType) {
  const f = String(fuelType || '').toUpperCase();
  return f.includes('ELECTRIC') && !f.includes('HYBRID') && !f.includes('PETROL') && !f.includes('DIESEL');
}

/**
 * estimateRoadTax — guide-only annual VED for a GB car, from the free DVLA payload.
 * @param {{ firstRegistration?:string, yearOfManufacture?:number|string, co2?:number|null,
 *           fuelType?:string, engineCC?:number|null }} input
 * @returns {{ regime:'pre2001'|'co2_2001'|'standard_2017'|'unknown', annual:number|null,
 *   basis:string, band?:string, supplement:null|{amount:number,years:number,thresholdText:string,note:string},
 *   guideOnly:true, note:string, source:string }}
 */
export function estimateRoadTax({ firstRegistration, yearOfManufacture, co2, fuelType, engineCC } = {}) {
  const source = 'gov.uk/vehicle-tax-rate-tables (2025/26)';
  const ms = regMs(firstRegistration, yearOfManufacture);

  if (ms == null) {
    return { regime: 'unknown', annual: null, basis: 'Registration date unavailable', supplement: null,
      guideOnly: true, note: 'We could not read this vehicle’s registration date to work out its tax band. Check the current rate at gov.uk/vehicle-tax-rate-tables.', source };
  }

  // ── Regime 1: registered before 1 March 2001 — engine-size bands (PDF-only, not transcribed) ──
  if (ms < CUTOVER_2001) {
    const overText = engineCC != null ? (engineCC > 1549 ? 'over 1,549cc' : '1,549cc or under') : 'by engine size';
    return { regime: 'pre2001', annual: null,
      basis: `Registered before 1 March 2001 — taxed ${overText}`, supplement: null, guideOnly: true,
      note: 'Cars registered before March 2001 are taxed by engine size. The exact current rate is published in the DVLA V149 — see gov.uk/vehicle-tax-rate-tables.', source };
  }

  // ── Regime 2: 1 Mar 2001 – 31 Mar 2017 — CO2 band ──
  if (ms < CUTOVER_2017) {
    if (co2 == null || !Number.isFinite(Number(co2))) {
      return { regime: 'co2_2001', annual: null, basis: 'Registered 2001–2017 — taxed on CO2, but no CO2 figure is on record',
        supplement: null, guideOnly: true,
        note: 'This car is taxed on its CO2 emissions, which are not on its DVLA record. Check the rate at gov.uk/vehicle-tax-rate-tables.', source };
    }
    const c = Number(co2);
    const row = CO2_BANDS_2001.find(b => c <= b.maxCo2);
    return { regime: 'co2_2001', annual: row.annual, band: row.band,
      basis: `Registered 2001–2017 · CO2 band ${row.band} (${c} g/km)`, supplement: null, guideOnly: true,
      note: 'Standard 12-month rate. Alternative-fuel cars may pay up to £10 less.', source };
  }

  // ── Regime 3: registered on/after 1 April 2017 — flat standard rate + conditional supplement ──
  const ev = isElectric(fuelType);
  const supplement = {
    amount: EXPENSIVE_SUPPLEMENT.amount,
    years: EXPENSIVE_SUPPLEMENT.years,
    thresholdText: ev ? `£${EXPENSIVE_SUPPLEMENT.thresholdElectric.toLocaleString('en-GB')}` : `£${EXPENSIVE_SUPPLEMENT.thresholdPetrolDiesel.toLocaleString('en-GB')}`,
    note: `If this car’s list price when new was over ${ev ? '£50,000' : '£40,000'}, add £${EXPENSIVE_SUPPLEMENT.amount}/year for five years from the second tax payment. We can’t confirm the list price, so this may or may not apply.`,
  };
  return { regime: 'standard_2017', annual: STANDARD_RATE_2017,
    basis: 'Registered April 2017 onward · standard rate', supplement, guideOnly: true,
    note: 'Flat standard rate from the second tax payment onward.', source };
}
