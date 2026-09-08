// Unit validator for lib/mileageCheck.mjs — deterministic, no network.
// Run: node --test scripts/validate-mileage-check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkMileageTimeline, toMiles, resolvePhotoOdometerReading } from '../lib/mileageCheck.mjs';
import { buildMileageCorroborationSlot, countIndependentMileageSources } from '../lib/mileageCorroboration.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (vrm) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'mot', `${vrm}.dvsa.json`), 'utf8'));

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
// rollback" case in one vehicle. Loaded from the CAPTURED DVSA response (scripts/fixtures/mot), not
// hand-typed — the project's own rule: read what was actually received, never a memory of it. (DVSA
// returns odometerValue as a STRING; parseOdometer handles it, so the assertions are unchanged.)
const GY67LLD = loadFixture('GY67LLD').motTests;

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

// ── batch 75 §2b — photo-odometer CROSS-CHECK (confirm or diverge, never silently discard) ──────
test('§2b: exactly one number → used as-is', () => {
  assert.deepEqual(resolvePhotoOdometerReading([29869], 29869), { value: 29869, diverged: false });
});
test('§2b: several numbers, exactly ONE matches the listing → confirmed (rest were trip/range)', () => {
  // 29869 odometer + 312 trip + 208 range; listing 29,869 → the odometer is confirmed.
  assert.deepEqual(resolvePhotoOdometerReading([29869, 312, 208], 29869), { value: 29869, diverged: false });
});
test('§2b: match within tolerance (±500) still confirms', () => {
  assert.deepEqual(resolvePhotoOdometerReading([29900, 312], 29869), { value: 29900, diverged: false });
});
test('§2b: several numbers, NONE matches the listing → divergence, not a silent discard', () => {
  const r = resolvePhotoOdometerReading([88000, 312], 29869);
  assert.equal(r.value, null);
  assert.equal(r.diverged, true);
});
test('§2b: multiple numbers but NO listing to check against → fall back (no divergence)', () => {
  assert.deepEqual(resolvePhotoOdometerReading([29869, 312], NaN), { value: null, diverged: false });
});
test('§2b: no numbers → fall back to listing (unchanged)', () => {
  assert.deepEqual(resolvePhotoOdometerReading([], 29869), { value: null, diverged: false });
});
test('§2b: the OLD behaviour is fixed — a two-number cluster read is no longer discarded', () => {
  // Pre-batch-75 (`uniq.length===1 ? uniq[0] : NaN`) returned null here; now it confirms 29,869.
  assert.equal(resolvePhotoOdometerReading([29869, 312], 29869).value, 29869);
});

// ── batch 106 §2 (EO-01) — the mileage CORROBORATION slot: silence is not agreement ──────────────
// The defect: a lot with a listing figure and NO MOT ladder was told its mileage was "corroborated
// against other sources" — verdict:confirmed / confidence:corroborated — when there were no other
// sources. "Confirmed" must now require a SECOND independent source that positively agreed.

test('EO-01: listing figure, NO MOT ladder (single source) → NOT corroborated, NOT confirmed', () => {
  // AMZ3790 shape: source is the Copart listing field, and it is the ONLY mileage source present.
  const slot = buildMileageCorroborationSlot(
    { _mileageSourceCount: 1 },   // one independent source only
    107423, 'copart_listed',
  );
  assert.notEqual(slot.verdict, 'confirmed');           // must NOT collapse into "Verified clear"
  assert.notEqual(slot.confidence, 'corroborated');     // must NOT claim corroboration
  assert.equal(slot.verdict, 'unconfirmed');
  assert.ok(slot.flag && slot.flag.tier === 1);         // carries the tier-1 odometer-photo ask
  assert.match(slot.detail, /only mileage source|nothing independent/i);
});

test('EO-01: single-source slot agrees with the Red Flags line (does not claim corroboration)', () => {
  const slot = buildMileageCorroborationSlot({ _mileageSourceCount: 1 }, 50000, 'listing_odometer');
  assert.doesNotMatch(slot.detail, /no discrepancy flagged|cross-checked/i);
});

test('EO-01: two or more sources agreeing (no flag) → confirmed / corroborated is TRUE', () => {
  const slot = buildMileageCorroborationSlot({ _mileageSourceCount: 2 }, 60000, 'listing_odometer');
  assert.equal(slot.verdict, 'confirmed');
  assert.equal(slot.confidence, 'corroborated');
  assert.equal(slot.flag, null);                        // a genuinely-clear slot carries no flag
  assert.match(slot.detail, /cross-checked against 1 other source\b/);
});

test('EO-01: three sources agreeing → pluralised "2 other sources"', () => {
  const slot = buildMileageCorroborationSlot({ _mileageSourceCount: 3 }, 60000, 'dvsa_mot');
  assert.equal(slot.verdict, 'confirmed');
  assert.match(slot.detail, /cross-checked against 2 other sources\b/);
});

test('EO-01: a discrepancy flag still wins over the source count (unchanged first branch)', () => {
  const slot = buildMileageCorroborationSlot(
    { _mileageSourceCount: 2, motMileageFlag: 'Photo 40,000 vs listing 90,000 — verify' },
    90000, 'listing_odometer',
  );
  assert.equal(slot.verdict, 'discrepancy');
  assert.ok(slot.flag);
});

test('EO-01: age-estimate branch is unchanged — still unconfirmed with the photo ask', () => {
  const slot = buildMileageCorroborationSlot({ _mileageSourceCount: 0 }, 120000, 'age_anomaly');
  assert.equal(slot.verdict, 'unconfirmed');
  assert.match(slot.detail, /ESTIMATED from vehicle age/);
  assert.ok(slot.flag && slot.flag.tier === 1);
});

test('EO-01: missing count defaults to single-source (never silently corroborates)', () => {
  // Defensive: an older stored assessment without _mileageSourceCount must NOT read as corroborated.
  const slot = buildMileageCorroborationSlot({}, 50000, 'copart_listed');
  assert.notEqual(slot.confidence, 'corroborated');
  assert.equal(slot.verdict, 'unconfirmed');
});

// ── batch 106 §4 (EO-01 re-opened) — the listing figure IS the dashboard reading ──────────────────
// Vincent's ruling, 8 Sep: "if it is reading the dash mileage, comparing that to the listed mileage
// and saying corroborated, that is wrong — because the person listing it is using the dash mileage."
// The §2 fix corrected the VERDICT branch and left the COUNT wrong, so listing + dash-photo scored 2
// and AMZ3790 was told it had been cross-checked against an independent source that does not exist.
// These assert the counting rule and the slot it feeds, end to end.

// A count → slot helper, so each case reads as the lot shape it represents.
const slotFor = (sources, brMileage, brMileageSource, extra = {}) =>
  buildMileageCorroborationSlot(
    { _mileageSourceCount: countIndependentMileageSources(sources), ...extra },
    brMileage, brMileageSource,
  );

test('EO-01 §4: THE AMZ3790 CASE — listing + dash photo, NO DVSA → NOT corroborated', () => {
  // The regression test for the ruling. Two readings of one dashboard is one source.
  const sources = { listingMileagePresent: true, photoOdometerPresent: true, dvsaMileagePresent: false };
  assert.equal(countIndependentMileageSources(sources), 1);
  const slot = slotFor(sources, 107423, 'copart_listed');
  assert.equal(slot.verdict, 'unconfirmed');
  assert.equal(slot.confidence, 'inferred');
  assert.notEqual(slot.confidence, 'corroborated');
  assert.ok(slot.flag && slot.flag.tier === 1);
  assert.doesNotMatch(slot.detail, /cross-checked against/i);   // the phrase must NOT appear
});

test('EO-01 §4: listing + dash photo + DVSA → confirmed, "1 other source" (not 2)', () => {
  const sources = { listingMileagePresent: true, photoOdometerPresent: true, dvsaMileagePresent: true };
  assert.equal(countIndependentMileageSources(sources), 2);
  const slot = slotFor(sources, 60000, 'copart_listed');
  assert.equal(slot.verdict, 'confirmed');
  assert.equal(slot.confidence, 'corroborated');
  assert.match(slot.detail, /cross-checked against 1 other source with no discrepancy/);
  assert.doesNotMatch(slot.detail, /2 other sources/);
});

test('EO-01 §4: dash photo only (no listing, no DVSA) → unconfirmed, NOT the age-estimate branch', () => {
  // The dashboard must still count as 1 — a 0 would claim no mileage was available at all.
  const sources = { listingMileagePresent: false, photoOdometerPresent: true, dvsaMileagePresent: false };
  assert.equal(countIndependentMileageSources(sources), 1);
  const slot = slotFor(sources, 88000, 'photo_odometer');
  assert.equal(slot.verdict, 'unconfirmed');
  assert.match(slot.detail, /only mileage source|nothing independent/i);
  assert.doesNotMatch(slot.detail, /ESTIMATED from vehicle age/);   // must not mis-route
});

test('EO-01 §4: listing + DVSA, no dash photo → confirmed / corroborated', () => {
  const sources = { listingMileagePresent: true, photoOdometerPresent: false, dvsaMileagePresent: true };
  assert.equal(countIndependentMileageSources(sources), 2);
  const slot = slotFor(sources, 60000, 'listing_odometer');
  assert.equal(slot.verdict, 'confirmed');
  assert.equal(slot.confidence, 'corroborated');
});

test('EO-01 §4: the discrepancy branch still wins over the count — the asymmetry is the point', () => {
  // Agreement between a figure and its own origin is not corroboration; DISAGREEMENT between them is
  // still real information (transcription error, swapped cluster, wrong lot) and must keep flagging.
  const sources = { listingMileagePresent: true, photoOdometerPresent: true, dvsaMileagePresent: false };
  const slot = slotFor(sources, 90000, 'listing_odometer',
    { photoMileageFlag: 'Photo odometer reads 40,000 miles; listing shows 90,000 miles' });
  assert.equal(slot.verdict, 'discrepancy');
  assert.ok(slot.flag && slot.flag.tier === 1);
});

test('EO-01 §4: no mileage at all → 0 sources', () => {
  assert.equal(countIndependentMileageSources({}), 0);
  assert.equal(countIndependentMileageSources({ listingMileagePresent: false, photoOdometerPresent: false, dvsaMileagePresent: false }), 0);
});
