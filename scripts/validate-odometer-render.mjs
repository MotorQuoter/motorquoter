// Render validator for lib/odometerDisplay.mjs — the ONE helper every MOT display surface uses.
// Deterministic, no network. Run: node --test scripts/validate-odometer-render.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOdometer } from '../lib/odometerDisplay.mjs';

const KM = (n) => Math.round(n * 0.621371);

// A row as lib/dvsa.js emits it AFTER 73f283c (boundary-normalised).
const POST = (recVal, recUnit) => ({
  odometerValue: recVal, odometerUnit: recUnit,
  odometerMiles: recUnit.toLowerCase() === 'km' ? (recVal ? KM(recVal) : null) : (recVal || null),
  odometerRecordedValue: recVal,
  odometerRecordedUnit: recUnit.toLowerCase(),
});
// A row cached/stored BEFORE the change — no odometer* extras, just the raw DVSA fields.
const PRE = (recVal, recUnit) => ({ odometerValue: recVal, odometerUnit: recUnit });

test('mi row → "111,119 mi", no annotation', () => {
  const o = formatOdometer(POST(111119, 'MI'));
  assert.equal(o.label, '111,119 mi');
  assert.equal(o.isKm, false);
  assert.equal(o.miles, 111119);
});

test('km row → "64,915 mi (104,471 km)"', () => {
  const o = formatOdometer(POST(104471, 'KM'));
  assert.equal(o.label, '64,915 mi (104,471 km)');
  assert.equal(o.isKm, true);
  assert.equal(o.miles, KM(104471));
});

test('kmSuffix variant → "(104,471 km recorded)" (the screen/paid-timeline wording)', () => {
  const o = formatOdometer(POST(104471, 'KM'), { kmSuffix: ' recorded' });
  assert.equal(o.label, '64,915 mi (104,471 km recorded)');
});

// THE back-compat assertion — a returning customer opening a pre-change cached/stored report.
test('pre-change row renders IDENTICALLY to a post-change row (mi and km)', () => {
  assert.equal(formatOdometer(PRE(111119, 'MI')).label, formatOdometer(POST(111119, 'MI')).label);
  assert.equal(formatOdometer(PRE(104471, 'KM')).label, formatOdometer(POST(104471, 'KM')).label);
  // and concretely, the km one is the converted figure, not the raw
  assert.equal(formatOdometer(PRE(104471, 'KM')).label, '64,915 mi (104,471 km)');
});

test('comma-formatted recorded value does not double the km annotation', () => {
  const o = formatOdometer({ odometerValue: '104,471', odometerUnit: 'km' });
  assert.equal(o.label, '64,915 mi (104,471 km)');   // not "104,471,471"
});

test('absent unit → treated as miles, no throw', () => {
  assert.doesNotThrow(() => formatOdometer({ odometerValue: 50000 }));
  const o = formatOdometer({ odometerValue: 50000 });
  assert.equal(o.label, '50,000 mi');
  assert.equal(o.isKm, false);
});

test('no genuine reading → label null (surfaces render their empty/"-" state)', () => {
  assert.equal(formatOdometer({ odometerValue: 0, odometerUnit: 'KM' }).label, null);
  assert.equal(formatOdometer({ odometerValue: null }).label, null);
  assert.equal(formatOdometer(null).label, null);
  assert.equal(formatOdometer(undefined).label, null);
});
