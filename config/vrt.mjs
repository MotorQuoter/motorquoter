// ─────────────────────────────────────────────────────────────────────────────
// VRT / import-cost reference tables — single source of truth (Category A cars).
// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC DATA ONLY. No model authors any figure here. Consumed by
// lib/importCost.mjs. Every number below is transcribed from an official source of
// record on the retrieval date; refresh when Revenue changes them (usually a Budget).
//
// SOURCES OF RECORD (retrieved 2026-07-30):
//   CO2 bands + minimum VRT — revenue.ie "Applying the tax"
//     https://www.revenue.ie/en/vrt/calculating-vrt/applying-tax.aspx
//     Category A table, effective "since 1 January 2022" — this is the CURRENT table
//     on 2026-07-30 (Category A unchanged; only Category B rates changed 1 July 2025).
//   NOx levy tiers + caps — revenue.ie "Calculating the NOx charge"
//     https://www.revenue.ie/en/vrt/calculating-vrt/calculating-nox-charge.aspx
//   Euro-standard NOx limits — EU type-approval emission limits (Euro 1–6), stable reference.
//   VAT (import) 23% + customs duty 10% (WTO/MFN car rate) — revenue.ie import guidance / TCA.
//
// NOTE (brief deviation, intentional): the ship brief cited a "€100" minimum VRT from
// memory. Revenue's current published minimum VRT payable is €140 (band-1 minimum) — used here.

// RE-VERIFIED against revenue.ie 2026-08-16 (TASK I): all 20 CO2 Category-A bands, €140 minimum
// VRT, NOx tiers €5/€15/€25, caps €4,850/€600, VAT 23%, duty 10% — unchanged since retrieval.
// RE-CHECK CADENCE: annual Budget sweep for these VRT tables; the NI import-provenance rules in
// lib/importProvenance.mjs move faster — re-check those quarterly and on any cited-URL 404.
export const VRT_TABLES_RETRIEVED = '2026-07-30';

// ── CO2 charge (Category A) ──────────────────────────────────────────────────
// CO2 charge = rate × OMSP, subject to the per-band € minimum.
// maxCo2 = INCLUSIVE upper bound (g/km); the last band (>190) uses Infinity.
export const CO2_BANDS = [
  { maxCo2: 50,       rate: 0.07,   min: 140 },
  { maxCo2: 80,       rate: 0.09,   min: 180 },
  { maxCo2: 85,       rate: 0.0975, min: 195 },
  { maxCo2: 90,       rate: 0.105,  min: 210 },
  { maxCo2: 95,       rate: 0.1125, min: 225 },
  { maxCo2: 100,      rate: 0.12,   min: 240 },
  { maxCo2: 105,      rate: 0.1275, min: 255 },
  { maxCo2: 110,      rate: 0.135,  min: 270 },
  { maxCo2: 115,      rate: 0.1525, min: 305 },
  { maxCo2: 120,      rate: 0.16,   min: 320 },
  { maxCo2: 125,      rate: 0.1675, min: 335 },
  { maxCo2: 130,      rate: 0.175,  min: 350 },
  { maxCo2: 135,      rate: 0.1925, min: 385 },
  { maxCo2: 140,      rate: 0.20,   min: 400 },
  { maxCo2: 145,      rate: 0.215,  min: 430 },
  { maxCo2: 150,      rate: 0.25,   min: 500 },
  { maxCo2: 155,      rate: 0.275,  min: 550 },
  { maxCo2: 170,      rate: 0.30,   min: 600 },
  { maxCo2: 190,      rate: 0.35,   min: 700 },
  { maxCo2: Infinity, rate: 0.41,   min: 820 },
];

// Minimum VRT payable (Revenue). Band-1 min already ≥ this, so it is a backstop.
export const VRT_MINIMUM = 140;

// ── NOx levy ─────────────────────────────────────────────────────────────────
// Tiered € per mg/km, cumulative across boundaries.
// Worked example (Revenue): 90 mg/km → 40×5 + 40×15 + 10×25 = €1,050.
export const NOX_TIERS = [
  { upTo: 40,       rate: 5 },
  { upTo: 80,       rate: 15 },
  { upTo: Infinity, rate: 25 },
];

// Caps applied when NOx is not satisfactorily documented (Revenue).
export const NOX_CAP = { diesel: 4850, other: 600 };

// ── Euro-standard NOx estimate (mg/km) ───────────────────────────────────────
// EU type-approval NOx limits by Euro standard and fuel. Used when the actual NOx
// (V5C box V.3) is not supplied. These are the regulatory LIMITS, not real-world
// figures (real diesels often exceed them) — the estimate is capped at NOX_CAP and
// always labelled as an estimate. Euro 1/2 predate a standalone NOx limit (combined
// HC+NOx) → conservative approximations, lowest confidence.
export const EURO_NOX_ESTIMATE = {
  diesel: { 6: 80, 5: 180, 4: 250, 3: 500, 2: 700, 1: 900 },
  petrol: { 6: 60, 5: 60,  4: 80,  3: 150, 2: 250, 1: 490 },
};

// ── VAT / customs (GB imports) ───────────────────────────────────────────────
export const VAT_RATE = 0.23;          // Irish import VAT on a GB car (customs value basis)
export const CUSTOMS_DUTY_RATE = 0.10; // WTO/MFN passenger-car rate; ZERO if UK preferential-origin
                                       // under the TCA — origin is not auto-determinable, so this is
                                       // only ever surfaced as an origin-dependent FLAG, never baked in.
