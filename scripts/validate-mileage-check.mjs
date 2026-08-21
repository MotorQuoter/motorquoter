// Unit validator for lib/mileageCheck.mjs — deterministic, no network.
// Run: node --test scripts/validate-mileage-check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMileageTimeline, toMiles } from '../lib/mileageCheck.mjs';

// DVSA-shaped test (newest-first, as the API returns — the checker sorts by date itself).
const T = (date, value, unit) => ({ completedDate: date, odometerValue: value, odometerUnit: unit, testResult: 'PASSED' });
const KM = (n) => Math.round(n * 0.621371);   // reference conversion for assertions only

// ── THE MANDATORY CASE: mixed mi/km must NOT false-flag a clean, rising timeline ──
test('mixed mi/km, actually monotonic → CONSISTENT (no false rollback)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '62000', 'mi'),   // 62,000 mi
    T('01/06/2022', '88000', 'km'),   // 88,000 km = 54,681 mi  (raw 88000 would look like a rollback)
    T('01/06/2021', '30000', 'mi'),   // 30,000 mi
  ]);
  assert.equal(r.status, 'consistent', r.verdict);
  assert.equal(r.mixedUnits, true);
  assert.equal(r.anomalies.length, 0);
  assert.match(r.verdict, /consistent/i);
});

test('km normalisation math: 88,000 km → 54,681 mi in the timeline', () => {
  const r = checkMileageTimeline([T('01/06/2022', '88000', 'km')], { currentMileage: 60000 });
  const km = r.readings.find((x) => x.unit === 'km');
  assert.equal(km.miles, Math.round(88000 * 0.621371)); // 54681
});

test('single-unit genuine rollback → DISCREPANCY (X→Y)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '40000', 'mi'),
    T('01/06/2022', '65000', 'mi'),
    T('01/06/2021', '60000', 'mi'),
  ]);
  assert.equal(r.status, 'discrepancy');
  assert.equal(r.anomalies[0].fromMiles, 65000);
  assert.equal(r.anomalies[0].toMiles, 40000);
  assert.match(r.verdict, /65,000 mi.*40,000 mi/);
});

test('mixed-unit REAL rollback is still caught (normalisation does not hide it)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '50000', 'km'),   // 31,069 mi
    T('01/06/2022', '60000', 'mi'),   // 60,000 mi
    T('01/06/2021', '40000', 'mi'),   // 40,000 mi
  ]);
  assert.equal(r.status, 'discrepancy');
  assert.equal(r.anomalies[0].fromMiles, 60000);
});

test('unsorted input is handled (checker sorts by date)', () => {
  const r = checkMileageTimeline([
    T('01/06/2021', '30000', 'mi'),
    T('01/06/2023', '62000', 'mi'),
    T('01/06/2022', '50000', 'mi'),
  ]);
  assert.equal(r.status, 'consistent');
  assert.deepEqual(r.readings.map((x) => x.miles), [30000, 50000, 62000]);
});

test('tiny drop within tolerance → consistent (absorbs rounding/granularity)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '61950', 'mi'),
    T('01/06/2022', '62000', 'mi'),
  ], { toleranceMiles: 150 });
  assert.equal(r.status, 'consistent');
});

test('user-entered current mileage below the latest MOT → query (confirm-the-figure, unit-aware)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '62000', 'mi'),
    T('01/06/2022', '55000', 'mi'),
  ], { currentMileage: 48000 });
  assert.equal(r.status, 'query');
  assert.ok(r.anomalies.some((a) => a._userEntered && a.toMiles === 48000));
});

test('user-entered current mileage in km does NOT false-flag', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '30000', 'mi'),
    T('01/06/2022', '20000', 'mi'),
  ], { currentMileage: 60000, currentUnit: 'km' }); // 60,000 km = 37,282 mi > 30,000
  assert.equal(r.status, 'consistent');
});

test('insufficient data (<2 readings, no current) → insufficient', () => {
  assert.equal(checkMileageTimeline([T('01/06/2023', '62000', 'mi')]).status, 'insufficient');
  assert.equal(checkMileageTimeline([]).status, 'insufficient');
});

test('ISO dates + comma-formatted odometer are parsed', () => {
  const r = checkMileageTimeline([
    { completedDate: '2023-06-01', odometerValue: '62,000', odometerUnit: 'mi' },
    { completedDate: '2021-06-01', odometerValue: '30,000', odometerUnit: 'mi' },
  ]);
  assert.equal(r.status, 'consistent');
  assert.equal(r.readings.length, 2);
});

test('null/blank odometer → N/A row: shown but excluded from tally + comparison', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '62000', 'mi'),
    { completedDate: '01/06/2022', odometerValue: null, odometerUnit: 'mi' },
    T('01/06/2021', '30000', 'mi'),
  ]);
  assert.equal(r.status, 'consistent');
  assert.equal(r.readingCount, 2);        // genuine count excludes the N/A
  assert.equal(r.readings.length, 3);     // N/A row still present for display
  const na = r.readings.find((x) => x.miles == null);
  assert.ok(na && na.na === true);
  assert.match(r.verdict, /consistent across 2 MOT readings/);
});

test('0-mile MOT reading (S50VNY case) → N/A, excluded, no false rollback', () => {
  const r = checkMileageTimeline([
    T('18/06/2022', '15000', 'mi'),
    T('18/06/2020', '0', 'mi'),          // tester mis-entry — a 2001 bike was not at 0 mi in 2020
    T('18/06/2019', '12000', 'mi'),
  ]);
  assert.equal(r.status, 'consistent');
  assert.equal(r.readingCount, 2);        // 0-mile row excluded from the tally
  assert.equal(r.anomalies.length, 0);    // 0 is NOT treated as a rollback from 12,000
  assert.match(r.verdict, /consistent across 2 MOT readings/);
  const zero = r.readings.find((x) => x.raw === 0);
  assert.ok(zero && zero.miles == null && zero.na === true);   // rendered N/A, not "0 mi"
});

test('a REAL rollback is still caught even with a 0-mile row present', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '40000', 'mi'),
    T('01/06/2022', '0', 'mi'),          // N/A — skipped
    T('01/06/2021', '65000', 'mi'),      // genuine 65k → genuine 40k = real rollback
  ]);
  assert.equal(r.status, 'discrepancy');
  assert.equal(r.anomalies[0].fromMiles, 65000);
  assert.equal(r.anomalies[0].toMiles, 40000);
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIT NORMALISATION (21 Aug) — the unit is a property of the data, resolved once
// at the DVSA boundary (lib/dvsa.js → odometerMiles). These cover both the engine's
// own fallback conversion AND the boundary-preferred path (no double conversion).
// ─────────────────────────────────────────────────────────────────────────────

// GY67LLD — the live fixture: six real tests, two of them km, sitting BELOW four later mi readings.
// Independent OE service data proves 64,915 mi on 28/10/2020. This is the "apparent drop that is not a
// rollback" case in one vehicle. Rows as DVSA returns them (un-normalised, uppercase units, FAILED row).
const GY67LLD = [
  { completedDate: '27/11/2025', odometerValue: 111119, odometerUnit: 'MI', testResult: 'PASSED' },
  { completedDate: '28/12/2023', odometerValue: 96601,  odometerUnit: 'MI', testResult: 'PASSED' },
  { completedDate: '04/11/2022', odometerValue: 86538,  odometerUnit: 'MI', testResult: 'PASSED' },
  { completedDate: '29/10/2021', odometerValue: 72743,  odometerUnit: 'MI', testResult: 'PASSED' },
  { completedDate: '03/11/2020', odometerValue: 104498, odometerUnit: 'KM', testResult: 'PASSED' },
  { completedDate: '27/10/2020', odometerValue: 104471, odometerUnit: 'KM', testResult: 'FAILED' },
];

test('GY67LLD fixture — mixed mi/km, six readings, CONSISTENT, km rows resolve to miles', () => {
  const r = checkMileageTimeline(GY67LLD);
  assert.equal(r.status, 'consistent', r.verdict);
  assert.equal(r.mixedUnits, true);
  assert.equal(r.readingCount, 6);
  assert.equal(r.anomalies.length, 0);                 // the apparent 104,471→72,743 "drop" is a unit artefact, not a rollback
  const oct2020 = r.readings.find((x) => x.date === '27/10/2020');
  assert.equal(oct2020.miles, KM(104471));             // 64,915 — matches the independent service record
  assert.equal(oct2020.miles, 64915);
});

test('LATEST MOT in km → the valuation/headline input is the CONVERTED figure (the money case)', () => {
  // The paid path takes motTests[0].odometerMiles for the Brego valuation and the headline. A km-latest
  // vehicle (ordinary NI/ROI import) must be priced on converted miles, never the raw ~61%-high number.
  const newestKm = 120000;
  const money = toMiles(newestKm, 'KM');               // exactly what route.js reads as odometerMiles
  assert.equal(money, KM(120000));                     // 74,565, not 120,000
  assert.notEqual(money, 120000);
  // and the timeline's newest genuine reading agrees
  const r = checkMileageTimeline([
    { completedDate: '01/06/2024', odometerValue: newestKm, odometerUnit: 'KM', testResult: 'PASSED' },
    { completedDate: '01/06/2022', odometerValue: 60000, odometerUnit: 'KM', testResult: 'PASSED' },
  ]);
  const newest = r.readings[r.readings.length - 1];
  assert.equal(newest.miles, KM(120000));
});

test('unit ABSENT → treated as miles, no throw', () => {
  assert.equal(toMiles(50000, undefined), 50000);
  assert.equal(toMiles(50000, null), 50000);
  assert.doesNotThrow(() => checkMileageTimeline([
    { completedDate: '01/06/2023', odometerValue: 50000, testResult: 'PASSED' },
    { completedDate: '01/06/2022', odometerValue: 40000, testResult: 'PASSED' },
  ]));
});

test('unit casing does not matter — Km / km / KM resolve identically', () => {
  assert.equal(toMiles(100000, 'Km'), toMiles(100000, 'km'));
  assert.equal(toMiles(100000, 'KM'), toMiles(100000, 'km'));
  assert.equal(toMiles(100000, 'km'), KM(100000));
});

test('0 km reading → null (N/A), excluded from tally + comparison', () => {
  assert.equal(toMiles(0, 'KM'), null);
  const r = checkMileageTimeline([
    { completedDate: '01/06/2023', odometerValue: 15000, odometerUnit: 'mi', testResult: 'PASSED' },
    { completedDate: '01/06/2022', odometerValue: 0, odometerUnit: 'KM', testResult: 'PASSED' },   // mis-entry
    { completedDate: '01/06/2021', odometerValue: 12000, odometerUnit: 'mi', testResult: 'PASSED' },
  ]);
  assert.equal(r.status, 'consistent');
  assert.equal(r.readingCount, 2);
  assert.equal(r.anomalies.length, 0);
});

test('boundary-normalised rows are NOT double-converted', () => {
  // Simulate exactly what lib/dvsa.js emits: odometerMiles set, odometerValue/odometerUnit kept.
  const TM = (date, recVal, recUnit) => ({
    completedDate: date,
    odometerValue: recVal, odometerUnit: recUnit,
    odometerMiles: toMiles(recVal, recUnit),
    odometerRecordedValue: recVal, odometerRecordedUnit: recUnit.toLowerCase(),
    testResult: 'PASSED',
  });
  const r = checkMileageTimeline([
    TM('01/06/2024', 111119, 'MI'),
    TM('01/06/2021', 104471, 'KM'),   // already normalised to 64,915 at the boundary
  ]);
  const km = r.readings.find((x) => x.unit === 'km');
  assert.equal(km.miles, KM(104471));               // 64,915 — used odometerMiles, did NOT re-multiply
  assert.notEqual(km.miles, KM(KM(104471)));        // the double-conversion figure (40,338) must NOT appear
  assert.equal(r.status, 'consistent');
});
