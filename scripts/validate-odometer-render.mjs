// Render validator for lib/odometerDisplay.mjs — the ONE helper every MOT display surface uses.
// Deterministic, no network. Run: node --test scripts/validate-odometer-render.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { jsPDF } from 'jspdf';
import { formatOdometer, formatOdometerCompact } from '../lib/odometerDisplay.mjs';

const KM = (n) => Math.round(n * 0.621371);
const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (vrm) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'mot', `${vrm}.dvsa.json`), 'utf8'));

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

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION (21 Aug) — the CALLERS, exercised with the captured GY67LLD fixture.
// formatOdometer is well unit-covered above; what was untested is that each surface
// actually assembles the right string for a km row. GY67LLD carries two km rows.
// ─────────────────────────────────────────────────────────────────────────────
const GY = loadFixture('GY67LLD').motTests;
const kmRow  = GY.find((t) => String(t.odometerValue) === '104471');           // 27/10/2020 KM, FAILED → 64,915 mi
const kmRow2 = GY.find((t) => String(t.odometerValue) === '104498');           // 03/11/2020 KM, PASSED → 64,932 mi
const miRow  = GY.find((t) => String(t.odometerUnit).toLowerCase() === 'mi');  // 111,119 MI

test('fixture sanity — GY67LLD has a km row (104,471) and a mi row (111,119)', () => {
  assert.ok(kmRow && miRow);
  assert.equal(String(kmRow.odometerValue), '104471');
  assert.equal(String(miRow.odometerValue), '111119');
});

// §2.1 — the £8.99 assessment PROMPT block (app/api/salvage/assess/route.js). Rebuild it the way the
// route does, through the SAME formatOdometerCompact() the route now calls — so this covers the actual
// model-input path, not a replica of its formatting.
test('assessment prompt block — km row is normalised miles + explicit "(recorded …km)", never bare mi', () => {
  const lines = GY.slice(0, 15).map((t) => {
    const result = (t.testResult || '').toUpperCase() === 'PASSED' ? 'PASS' : 'FAIL';
    const odo = formatOdometerCompact(t);
    return [t.completedDate, result, odo].filter(Boolean).join(' ');
  });
  const block = `DVSA MOT History (most recent first):\n${lines.join('\n')}`;

  assert.match(block, /64,915mi \(recorded 104,471km\)/);       // km row 1, converted + annotated
  assert.match(block, /64,932mi \(recorded 104,498km\)/);       // km row 2
  assert.match(block, /111,119mi/);                             // a mi row, plain
  assert.doesNotMatch(block, /104,?471\s*mi\b/);                // NEVER the raw km value labelled mi
  assert.doesNotMatch(block, /104,?498\s*mi\b/);
  assert.equal(formatOdometerCompact(kmRow), '64,915mi (recorded 104,471km)');
  assert.equal(formatOdometerCompact(kmRow2), '64,932mi (recorded 104,498km)');
  assert.equal(formatOdometerCompact(miRow), '111,119mi');
});

// §2.2 — the salvage PDF MOT line (app/api/salvage/pdf/route.js:391). Free-flow join, no column budget.
test('salvage PDF MOT line — km row carries the converted+annotated label', () => {
  const pass = kmRow.testResult === 'PASSED';
  const testLine = [kmRow.testResult, kmRow.completedDate, formatOdometer(kmRow).label,
    pass && kmRow.expiryDate ? `exp ${kmRow.expiryDate}` : null].filter(Boolean).join(' - ');
  assert.equal(testLine, 'FAILED - 27/10/2020 - 64,915 mi (104,471 km)');
  assert.doesNotMatch(testLine, /104,?471\s*mi\b/);
});

// §2.3 — the GB PDF MOT table (app/api/generate-pdf/route.js). The inline label must FIT the 36mm
// budget to the Expiry column, so the sub-line branch (kmSubline) must NOT fire for GY67LLD. Measure
// with the same font/size the table uses; if this ever flips, it is a silent layout regression.
test('GB PDF MOT table — GY67LLD km label fits inline; kmSubline stays null', () => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const budget = 90 - 52 - 2;   // Mileage col (MARGIN+52) → Expiry col (MARGIN+90), less 2mm
  for (const t of GY.filter((x) => String(x.odometerUnit).toLowerCase() === 'km')) {
    const label = formatOdometer(t).label;
    assert.ok(doc.getTextWidth(label) <= budget, `${label} = ${doc.getTextWidth(label).toFixed(1)}mm > ${budget}mm → would drop to sub-line`);
  }
});

// §2.4 — both screen surfaces.
test('screen MOT cards — km row wording per surface', () => {
  // payment-success (report screen) mirrors the paid timeline: "… km recorded"
  assert.equal(formatOdometer(kmRow, { kmSuffix: ' recorded' }).label, '64,915 mi (104,471 km recorded)');
  // salvage screen + salvage success: plain "(… km)"
  assert.equal(formatOdometer(kmRow).label, '64,915 mi (104,471 km)');
  // a mi row is unchanged on every surface
  assert.equal(formatOdometer(miRow).label, '111,119 mi');
});
