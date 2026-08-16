// Unit validator for lib/importCost.mjs — deterministic, no network.
// Run from repo root:  node scripts/validate-import-cost.mjs
// Part of the standing gate for the ROI import-cost estimator.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateImportCost, estimateImportCostRange, estimateImportPresentation,
  classifyNewMeansOfTransport, importScopeRefusal,
  noxLevyRaw, co2Band, parseEuroClass, normaliseFuel,
} from '../lib/importCost.mjs';
import { CO2_BANDS, VRT_MINIMUM, NOX_CAP } from '../config/vrt.mjs';
import { buildJurisdictionTimeline, provenanceConflict, yearOf } from '../lib/importProvenance.mjs';

// Helper: a DVSA/DVA-NI MOT test as the route sees it (completedDate = DD/MM/YYYY, formatDate output).
const mot = (dataSource, year) => ({ dataSource, completedDate: `15/06/${year}` });

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

test('GB customs duty exposes the compounded add-on (duty + VAT on the duty)', () => {
  const r = estimateImportCost({
    omsp: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel',
    provenance: 'GB', purchasePrice: 20000,
  });
  assert.equal(r.customsDutyFlag.indicativeAmount, 2000);       // 10% × 20,000
  assert.equal(r.customsDutyFlag.indicativeWithVat, 2000 + 460); // + 23% × 2,000 = 2,460
  assert.match(r.customsDutyFlag.note, /VAT is also charged on the duty/);
  // Still excluded from the headline total.
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

// ── Jurisdiction timeline (TASK J) — code-computed provenance evidence ─────────

test('yearOf parses DD/MM/YYYY and ISO', () => {
  assert.equal(yearOf('15/06/2022'), 2022);
  assert.equal(yearOf('2019-03-01T00:00:00.000Z'), 2019);
  assert.equal(yearOf(''), null);
  assert.equal(yearOf(null), null);
});

test('GB_TEST_AFTER_2020: a DVSA test after 2020 forces the GB route (VAT+customs on)', () => {
  const j = buildJurisdictionTimeline([mot('DVSA', 2022), mot('DVA NI', 2019)], '2016-01-01');
  assert.equal(j.flags.GB_TEST_AFTER_2020, true);
  assert.equal(j.flags.NI_CONTINUOUS, false);          // GB-after-2020 forecloses continuity
  assert.equal(j.suggestedProvenance, 'GB');
  assert.equal(j.confidence, 'high');
  assert.match(j.reason, /cannot apply|VAT and customs/i);
});

test('NI_CONTINUOUS: NI tests either side of 2021 with no later GB test → suggests NI', () => {
  const j = buildJurisdictionTimeline([mot('DVA NI', 2019), mot('DVA NI', 2022)], '2017-05-01');
  assert.equal(j.flags.NI_CONTINUOUS, true);
  assert.equal(j.flags.GB_TEST_AFTER_2020, false);
  assert.equal(j.suggestedProvenance, 'NI');
});

test('NI pre-2021 only (not continuous) → stays GB default, flags NI_TESTS_PRE_2021', () => {
  const j = buildJurisdictionTimeline([mot('DVA NI', 2019)], '2016-01-01');
  assert.equal(j.flags.NI_TESTS_PRE_2021, true);
  assert.equal(j.flags.NI_CONTINUOUS, false);
  assert.equal(j.suggestedProvenance, 'GB');
});

test('MIXED_HISTORY when both jurisdictions appear', () => {
  const j = buildJurisdictionTimeline([mot('DVA NI', 2019), mot('DVSA', 2022)]);
  assert.equal(j.flags.MIXED_HISTORY, true);
});

test('NO_TEST_HISTORY evidences nothing', () => {
  const j = buildJurisdictionTimeline([], null);
  assert.equal(j.flags.NO_TEST_HISTORY, true);
  assert.equal(j.confidence, 'none');
  assert.match(j.reason, /falls back to your declaration/i);
});

test('PRE_2017_BLIND from firstUsedDate before the NI 2017 data floor', () => {
  const j = buildJurisdictionTimeline([mot('DVSA', 2019)], '2015-08-01');
  assert.equal(j.flags.PRE_2017_BLIND, true);
});

test('evidence: NI MOT is shown only when NI tests exist; V5C/service always buyer-obtained', () => {
  const withNi = buildJurisdictionTimeline([mot('DVA NI', 2019)]);
  const niDoc = withNi.evidence.revenueDocuments.find(d => /NI MOT/.test(d.doc));
  assert.equal(niDoc.canEvidence, true);
  const noNi = buildJurisdictionTimeline([mot('DVSA', 2022)]);
  assert.equal(noNi.evidence.revenueDocuments.find(d => /NI MOT/.test(d.doc)).canEvidence, false);
  // V5C + service history are never auto-evidenced.
  assert.ok(withNi.evidence.revenueDocuments.filter(d => d.canEvidence === false).length >= 2);
});

test('provenanceConflict fires ONLY when the buyer claims NI against a post-2020 GB test', () => {
  const gbAfter = buildJurisdictionTimeline([mot('DVSA', 2022)]).flags;
  assert.match(provenanceConflict('NI', gbAfter), /pre-2021 NI route likely does not apply/i);
  assert.equal(provenanceConflict('GB', gbAfter), null);        // buyer at GB → no conflict
  const niOnly = buildJurisdictionTimeline([mot('DVA NI', 2019), mot('DVA NI', 2022)]).flags;
  assert.equal(provenanceConflict('NI', niOnly), null);         // NI claim consistent with NI evidence
});

test('absence of NI tests never inverts to "not in NI" — reason stays non-committal', () => {
  const j = buildJurisdictionTimeline([mot('DVSA', 2019)], '2018-01-01'); // GB-only, but pre-2021 (no GB-after)
  assert.equal(j.flags.GB_TEST_AFTER_2020, false);
  assert.match(j.reason, /not proof the car was never in NI/i);
});

// ── Dual-figure presentation (TASK batch 26) — call the engine twice, no second code path ─────

const DUAL_INPUTS = { omspLow: 30000, omspAvg: 30000, omspHigh: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', purchasePrice: 20000 };

test('private seller → DUAL: NI (VRT only) beside GB (VRT + VAT), neither applied', () => {
  const p = estimateImportPresentation({ sellerType: 'private', ...DUAL_INPUTS });
  assert.equal(p.mode, 'dual');
  assert.equal(p.supported, true);
  assert.equal(p.dual.ni.vat, 0);                       // NI branch: no VAT
  assert.equal(p.dual.ni.customsDutyFlag.applies, false);
  assert.equal(p.dual.gb.vat, 4600);                    // GB branch: 23% × 20,000
  assert.equal(p.dual.gb.customsDutyFlag.indicativeWithVat, 2460); // duty + VAT on duty
  // The two grand totals differ by exactly VAT (+ nothing else auto-added).
  assert.equal(p.dual.gb.grandTotal - p.dual.ni.grandTotal, 4600);
});

test('dealer seller → DUAL, same shape as private', () => {
  const p = estimateImportPresentation({ sellerType: 'dealer', ...DUAL_INPUTS });
  assert.equal(p.mode, 'dual');
  assert.ok(p.dual.ni && p.dual.gb);
});

test('pre2021 → SINGLE NI (EU goods, VRT only)', () => {
  const p = estimateImportPresentation({ sellerType: 'pre2021', ...DUAL_INPUTS });
  assert.equal(p.mode, 'single');
  assert.equal(p.vat, 0);
  assert.equal(p.basis.provenance, 'NI');
});

test('gb / unknown → SINGLE GB (customs flagged)', () => {
  const gb = estimateImportPresentation({ sellerType: 'gb', ...DUAL_INPUTS });
  assert.equal(gb.mode, 'single');
  assert.equal(gb.basis.provenance, 'GB');
  assert.equal(gb.vat, 4600);
  // Unknown sellerType defaults to the safe GB single.
  const unknown = estimateImportPresentation({ sellerType: 'wat', ...DUAL_INPUTS });
  assert.equal(unknown.mode, 'single');
  assert.equal(unknown.basis.provenance, 'GB');
});

// ── New means of transport (batch 27) — VAT applies regardless of NI reliefs ──────────────────

test('classify: age limb alone (≤6 months) → new', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 3, odometerKm: 40000 });
  assert.equal(c.isNew, true); assert.equal(c.ageNew, true); assert.equal(c.kmNew, false);
});
test('classify: distance limb alone (≤6,000 km) → new', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 24, odometerKm: 5000 });
  assert.equal(c.isNew, true); assert.equal(c.kmNew, true); assert.equal(c.ageNew, false);
});
test('classify: both limbs → new', () => {
  assert.equal(classifyNewMeansOfTransport({ ageMonths: 2, odometerKm: 1000 }).isNew, true);
});
test('classify: neither limb → used', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 24, odometerKm: 40000 });
  assert.equal(c.isNew, false); assert.equal(c.near, false);
});
test('classify: near threshold (7 months / 6,500 km) flags near, not new', () => {
  assert.equal(classifyNewMeansOfTransport({ ageMonths: 7, odometerKm: 40000 }).near, true);
  assert.equal(classifyNewMeansOfTransport({ ageMonths: 24, odometerKm: 6500 }).near, true);
  assert.equal(classifyNewMeansOfTransport({ ageMonths: 7, odometerKm: 6500 }).isNew, false);
});
test('classify: unknown mileage + not-new age → distance limb uncheckable', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 24, odometerKm: null });
  assert.equal(c.isNew, false); assert.equal(c.distanceUncheckable, true);
});
test('classify: unknown mileage but new by age → not uncheckable (age settled it)', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 3, odometerKm: null });
  assert.equal(c.isNew, true); assert.equal(c.distanceUncheckable, false);
});

test('engine: new means of transport forces VAT even on NI provenance', () => {
  const used = estimateImportCost({ omsp: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', provenance: 'NI', purchasePrice: 20000, ageMonths: 36, odometerKm: 60000 });
  assert.equal(used.vat, 0);                       // used NI car — VRT only
  const brandNew = estimateImportCost({ omsp: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', provenance: 'NI', purchasePrice: 20000, ageMonths: 3, odometerKm: 1000 });
  assert.equal(brandNew.vat, 4600);                // NEW NI car — VAT still due
  assert.equal(brandNew.newMeansOfTransport.isNew, true);
  assert.equal(brandNew.grandTotal, brandNew.vrt.total + 4600);
});

test('presentation: NEW means of transport SUPPRESSES the dual fork (private/dealer → single, VAT on)', () => {
  const priv = estimateImportPresentation({ sellerType: 'private', omspLow: 30000, omspAvg: 30000, omspHigh: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', purchasePrice: 20000, ageMonths: 3, odometerKm: 1000 });
  assert.equal(priv.mode, 'single');               // no fork
  assert.equal(priv.newMeansForcedSingle, true);
  assert.equal(priv.vat, 4600);                    // VAT applies despite 'private'
  // pre2021 new car also gets VAT (single path, engine forces it).
  const pre = estimateImportPresentation({ sellerType: 'pre2021', omspLow: 30000, omspAvg: 30000, omspHigh: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', purchasePrice: 20000, ageMonths: 2, odometerKm: 500 });
  assert.equal(pre.mode, 'single');
  assert.equal(pre.vat, 4600);
  // A USED private car still forks.
  const used = estimateImportPresentation({ sellerType: 'private', omspLow: 30000, omspAvg: 30000, omspHigh: 30000, co2: 120, euroClass: 'Euro 6', fuel: 'Diesel', purchasePrice: 20000, ageMonths: 36, odometerKm: 60000 });
  assert.equal(used.mode, 'dual');
});

// ── Category C by age (batch 28) — over 30 years → flat €200, CO2/NOx bypassed ────────────────

test('over 30 years → Category C flat €200 VRT, CO2/NOx bypassed', () => {
  const r = estimateImportCost({ omsp: 40000, co2: 260, euroClass: 'Euro 2', fuel: 'Petrol', provenance: 'GB', purchasePrice: 30000, ageMonths: 31 * 12 });
  assert.equal(r.categoryC, true);
  assert.equal(r.vrt.total, 200);           // flat — not 41% of €40,000
  assert.equal(r.vrt.categoryC, true);
  assert.equal(r.vrt.co2Charge, null);
  assert.equal(r.vrt.noxLevy, 0);
});

test('just under 30 years → normal Category A (no flat rate)', () => {
  const r = estimateImportCost({ omsp: 40000, co2: 120, euroClass: 'Euro 6', fuel: 'Petrol', provenance: 'GB', purchasePrice: 30000, ageMonths: 29 * 12 });
  assert.equal(r.categoryC, false);
  assert.ok(r.vrt.co2Charge > 200);         // CO2-banded, not flat
});

test('within 6 months of 30 years → near flag, still Category A', () => {
  const r = estimateImportCost({ omsp: 20000, co2: 120, euroClass: 'Euro 5', fuel: 'Petrol', provenance: 'GB', purchasePrice: 15000, ageMonths: 30 * 12 - 3 });
  assert.equal(r.categoryC, false);
  assert.equal(r.categoryCNear, true);
  assert.ok(r.notes.some(n => /close to 30 years/i.test(n)));
});

test('a >30yr car is NOT a new means of transport even at low km (classic guard); GB VAT still applies', () => {
  const c = classifyNewMeansOfTransport({ ageMonths: 31 * 12, odometerKm: 3000 });
  assert.equal(c.isNew, false);             // low km must not flag a classic as "new"
  const r = estimateImportCost({ omsp: 40000, co2: 200, fuel: 'Petrol', provenance: 'GB', purchasePrice: 30000, ageMonths: 31 * 12, odometerKm: 3000 });
  assert.equal(r.vrt.total, 200);           // Cat C VRT
  assert.equal(r.vat, 6900);                // GB import VAT (23% × 30,000) still applies
  assert.equal(r.newMeansOfTransport.isNew, false);
  // NI-sourced used classic → no VAT
  const ni = estimateImportCost({ omsp: 40000, co2: 200, fuel: 'Petrol', provenance: 'NI', purchasePrice: 30000, ageMonths: 31 * 12, odometerKm: 3000 });
  assert.equal(ni.vat, 0);
  assert.equal(ni.vrt.total, 200);
});

// ── Import scope gate (batch 28) — passenger cars (M1) only ───────────────────────────────────

test('importScopeRefusal: M1 in scope; commercials/buses/tractors/unknown refused', () => {
  assert.equal(importScopeRefusal('M1'), null);
  assert.match(importScopeRefusal('N1'), /commercial|passenger cars only/i);
  assert.match(importScopeRefusal('N3'), /commercial|passenger cars only/i);
  assert.match(importScopeRefusal('M2'), /bus|passenger cars only/i);
  assert.match(importScopeRefusal('T3'), /tractor|passenger cars only/i);
  assert.match(importScopeRefusal(''), /couldn.t confirm|passenger car/i);   // absent → refuse, never assume M1
  assert.match(importScopeRefusal(null), /couldn.t confirm|passenger car/i);
});
