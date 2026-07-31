// Unit validator for lib/importCost.mjs — deterministic, no network.
// Run from repo root:  node scripts/validate-import-cost.mjs
// Part of the standing gate for the ROI import-cost estimator.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateImportCost, estimateImportCostRange,
  noxLevyRaw, co2Band, parseEuroClass, normaliseFuel,
} from '../lib/importCost.mjs';
import { CO2_BANDS, VRT_MINIMUM, NOX_CAP } from '../config/vrt.mjs';

test('NOx worked example reproduces Revenue: 90 mg/km diesel = €1,050', () => {
  assert.equal(noxLevyRaw(90), 1050); // 40×5 + 40×15 + 10×25
});

test('NOx tier boundaries', () => {
  assert.equal(noxLevyRaw(0), 0);
  assert.equal(noxLevyRaw(40), 200);           // 40×5
  assert.equal(noxLevyRaw(80), 200 + 600);     // +40×15
  assert.equal(noxLevyRaw(100), 800 + 500);    // +20×25
});

test('CO2 bands: boundaries map to the right rate', () => {
  assert.equal(co2Band(0).rate, 0.07);
  assert.equal(co2Band(50).rate, 0.07);
  assert.equal(co2Band(51).rate, 0.09);
  assert.equal(co2Band(120).rate, 0.16);
  assert.equal(co2Band(190).rate, 0.35);
  assert.equal(co2Band(191).rate, 0.41);
  assert.equal(co2Band(999).rate, 0.41);
});

test('CO2 band table is monotonic and complete (20 bands, last = Infinity)', () => {
  assert.equal(CO2_BANDS.length, 20);
  assert.equal(CO2_BANDS[CO2_BANDS.length - 1].maxCo2, Infinity);
  for (let i = 1; i < CO2_BANDS.length; i++) {
    assert.ok(CO2_BANDS[i].maxCo2 > CO2_BANDS[i - 1].maxCo2, `band ${i} not ascending`);
    assert.ok(CO2_BANDS[i].rate >= CO2_BANDS[i - 1].rate, `rate ${i} not non-decreasing`);
  }
});

test('parseEuroClass handles discrete, numeric and embedded forms', () => {
  assert.equal(parseEuroClass('Euro 6'), 6);
  assert.equal(parseEuroClass('EURO6'), 6);
  assert.equal(parseEuroClass(5), 5);
  assert.equal(parseEuroClass('2.0 TDI 190 Euro 6 S tronic'), 6);
  assert.equal(parseEuroClass('petrol'), null);
  assert.equal(parseEuroClass(null), null);
});

// One Auto emission_class arrives as a bare Euro sub-phase code (confirmed live 31 Jul:
// GY67LLD="6b", FE68AOP="6c"). The sub-phase letter is Euro 6 either way — must not fall through
// to null (which sent NOx to the statutory cap and over-costed VRT ~€4k on diesels).
test('parseEuroClass handles One Auto bare emission_class codes (6b/6c/6d-temp)', () => {
  assert.equal(parseEuroClass('6b'), 6);
  assert.equal(parseEuroClass('6c'), 6);
  assert.equal(parseEuroClass('6d'), 6);
  assert.equal(parseEuroClass('6d-temp'), 6);
  assert.equal(parseEuroClass('6'), 6);
  assert.equal(parseEuroClass('5a'), 5);
  assert.equal(parseEuroClass('4'), 4);
  // must NOT greedily match a non-code string that merely starts with a digit
  assert.equal(parseEuroClass('6 speed manual'), null);
});

test('normaliseFuel', () => {
  assert.equal(normaliseFuel('DIESEL'), 'diesel');
  assert.equal(normaliseFuel('Petrol'), 'petrol');
  assert.equal(normaliseFuel('Petrol/Electric Hybrid'), 'hybrid');
  assert.equal(normaliseFuel('Electric'), 'electric');
  assert.equal(normaliseFuel(''), null);
});

test('GB diesel: CO2 charge + NOx estimate + VAT + duty flag', () => {
  const r = estimateImportCost({
    omsp: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel',
    provenance: 'GB', purchasePrice: 20000,
  });
  assert.equal(r.supported, true);
  // CO2: 120 g/km → 16% × 30,000 = 4,800 (above band min 320)
  assert.equal(r.vrt.co2Charge, 4800);
  // NOx: Euro 6 diesel → 80 mg/km → €800
  assert.equal(r.vrt.noxLevy, noxLevyRaw(80));
  assert.equal(r.vrt.total, 4800 + 800);
  // VAT: 23% × 20,000
  assert.equal(r.vat, 4600);
  // Duty flagged, origin-dependent, NOT in the grand total
  assert.equal(r.customsDutyFlag.applies, 'origin-dependent');
  assert.equal(r.customsDutyFlag.indicativeAmount, 2000);
  assert.equal(r.grandTotal, r.vrt.total + r.vat);
});

test('NI-qualifying: VRT only, no VAT, duty does not apply', () => {
  const r = estimateImportCost({
    omsp: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel',
    provenance: 'NI', purchasePrice: 20000,
  });
  assert.equal(r.vat, 0);
  assert.equal(r.customsDutyFlag.applies, false);
  assert.equal(r.grandTotal, r.vrt.total);
});

test('V5C NOx override beats the estimate and is not capped', () => {
  const r = estimateImportCost({
    omsp: 20000, co2: 100, euroClass: 'Euro 5', fuel: 'Diesel',
    provenance: 'GB', purchasePrice: 15000, noxOverride: 90,
  });
  assert.equal(r.vrt.noxLevy, 1050);
  assert.match(r.vrt.noxBasis, /V5C/);
});

test('petrol EV: NOx €0, lowest band, EV relief note', () => {
  const r = estimateImportCost({ omsp: 25000, co2: 0, fuel: 'Electric', provenance: 'GB', purchasePrice: 25000 });
  assert.equal(r.vrt.noxLevy, 0);
  assert.equal(r.vrt.band.rate, 0.07);
  assert.ok(r.notes.some(n => /electric/i.test(n) && /relief/i.test(n)));
});

test('old diesel NOx estimate is capped at €4,850', () => {
  const r = estimateImportCost({ omsp: 10000, co2: 200, euroClass: 'Euro 3', fuel: 'Diesel', provenance: 'GB' });
  // Euro 3 diesel = 500 mg/km → raw 200+600+ (420×25=10500)=11300 → capped
  assert.equal(r.vrt.noxLevy, NOX_CAP.diesel);
  assert.ok(r.vrt.noxBasis.includes('capped'));
});

test('undocumented NOx falls back to the statutory cap', () => {
  const r = estimateImportCost({ omsp: 15000, co2: 130, fuel: 'Diesel', provenance: 'GB' }); // no euro, no override
  assert.equal(r.vrt.noxLevy, NOX_CAP.diesel);
  assert.match(r.vrt.noxBasis, /undocumented/);
});

test('CO2 band minimum floors a low-OMSP car', () => {
  const r = estimateImportCost({ omsp: 1000, co2: 60, fuel: 'Petrol', provenance: 'NI' });
  // 9% × 1,000 = 90 < band min 180 → floored to 180 (≥ VRT_MINIMUM)
  assert.equal(r.vrt.co2Charge, 180);
  assert.equal(r.vrt.floorApplied, true);
  assert.ok(r.vrt.co2Charge >= VRT_MINIMUM);
});

test('Category B (van) is rejected cleanly', () => {
  const r = estimateImportCost({ omsp: 20000, co2: 150, fuel: 'Diesel', category: 'B' });
  assert.equal(r.supported, false);
  assert.match(r.reason, /Category A/);
});

test('ROI provenance = not an import', () => {
  const r = estimateImportCost({ omsp: 20000, co2: 120, fuel: 'Petrol', provenance: 'ROI' });
  assert.equal(r.supported, false);
  assert.match(r.reason, /Irish plates/);
});

test('graceful degrade: no OMSP → no VRT, but VAT still computes', () => {
  const r = estimateImportCost({ co2: 120, fuel: 'Petrol', provenance: 'GB', purchasePrice: 10000 });
  assert.equal(r.vrt, null);
  assert.equal(r.vat, 2300);
  assert.ok(r.notes.some(n => /OMSP/.test(n)));
});

test('range wrapper spreads low→high and keeps a central estimate', () => {
  const r = estimateImportCostRange({
    omspLow: 25000, omspAvg: 30000, omspHigh: 35000,
    co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', provenance: 'GB', purchasePrice: 20000,
  });
  assert.equal(r.supported, true);
  assert.ok(r.range.low < r.range.high);
  assert.equal(r.range.omspAvg, 30000);
  // central VRT = 16% × 30,000 + 800 NOx
  assert.equal(r.vrt.total, 4800 + 800);
});
