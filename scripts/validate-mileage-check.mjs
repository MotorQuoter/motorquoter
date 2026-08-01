// Unit validator for lib/mileageCheck.mjs — deterministic, no network.
// Run: node --test scripts/validate-mileage-check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMileageTimeline } from '../lib/mileageCheck.mjs';

// DVSA-shaped test (newest-first, as the API returns — the checker sorts by date itself).
const T = (date, value, unit) => ({ completedDate: date, odometerValue: value, odometerUnit: unit, testResult: 'PASSED' });

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

test('user-entered current mileage below the latest MOT → discrepancy (old guard, unit-aware)', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '62000', 'mi'),
    T('01/06/2022', '55000', 'mi'),
  ], { currentMileage: 48000 });
  assert.equal(r.status, 'discrepancy');
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

test('readings with no odometer are skipped, not crashed', () => {
  const r = checkMileageTimeline([
    T('01/06/2023', '62000', 'mi'),
    { completedDate: '01/06/2022', odometerValue: null, odometerUnit: 'mi' },
    T('01/06/2021', '30000', 'mi'),
  ]);
  assert.equal(r.status, 'consistent');
  assert.equal(r.readings.length, 2);
});
