// Unit validator for lib/ownerHistory.mjs — deterministic, no network.
// Run: node --test scripts/validate-owner-history.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseOwnerHistory, summarisePlateChanges } from '../lib/ownerHistory.mjs';

test('GY67LLD real shape → 3 keepers, 2 changes, last change 28 Aug 2025', () => {
  const r = summariseOwnerHistory([
    { number_previous_keepers: 2, date_of_last_keeper_change: '2025-08-28' },
    { number_previous_keepers: 1, date_of_last_keeper_change: '2023-04-07' },
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.totalKeepers, 3);
  assert.equal(r.keeperChanges, 2);
  assert.equal(r.latestChangeDate, '28 Aug 2025');
  assert.match(r.verdict, /3 keepers · 2 recorded changes · last change 28 Aug 2025/);
});

test('unsorted input → latest change is the newest date', () => {
  const r = summariseOwnerHistory([
    { number_previous_keepers: 1, date_of_last_keeper_change: '2023-04-07' },
    { number_previous_keepers: 2, date_of_last_keeper_change: '2025-08-28' },
  ]);
  assert.equal(r.latestChangeDate, '28 Aug 2025');
  assert.equal(r.totalKeepers, 3);
});

test('single keeper change → 2 keepers', () => {
  const r = summariseOwnerHistory([{ number_previous_keepers: 1, date_of_last_keeper_change: '2020-01-01' }]);
  assert.equal(r.totalKeepers, 2);
  assert.equal(r.keeperChanges, 1);
  assert.match(r.verdict, /2 keepers · 1 recorded change/);
});

test('empty / non-array → no_data', () => {
  assert.equal(summariseOwnerHistory([]).status, 'no_data');
  assert.equal(summariseOwnerHistory(null).status, 'no_data');
  assert.equal(summariseOwnerHistory(undefined).status, 'no_data');
});

test('missing number_previous_keepers → falls back to changes+1', () => {
  const r = summariseOwnerHistory([
    { date_of_last_keeper_change: '2021-01-01' },
    { date_of_last_keeper_change: '2023-01-01' },
  ]);
  assert.equal(r.totalKeepers, 3); // 2 changes + current
  assert.equal(r.keeperChanges, 2);
});

test('DD/MM/YYYY dates are parsed too', () => {
  const r = summariseOwnerHistory([{ number_previous_keepers: 1, date_of_last_keeper_change: '07/04/2023' }]);
  assert.equal(r.latestChangeDate, '7 Apr 2023');
});

// ── Plate-change history (defensive extraction) ──────────────────────────────
test('plate list (registration_mark + date_of_change) → oldest-first, deduped', () => {
  const r = summarisePlateChanges([
    { registration_mark: 'LT65 AAA', date_of_change: '2021-06-01' },
    { registration_mark: 'AB12 CDE', date_of_change: '2018-03-15' },
    { registration_mark: 'LT65AAA',  date_of_change: '2021-06-01' }, // dup (spaces normalised)
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 2);
  assert.deepEqual(r.plates.map((p) => p.plate), ['AB12CDE', 'LT65AAA']);
  assert.equal(r.plates[0].date, '15 Mar 2018');
});

test('One Auto plate_change_list real shape (S500VNY live) → previous plates, oldest-first', () => {
  const r = summarisePlateChanges([
    { current_vehicle_registration_mark: 'IGZ3096', previous_vehicle_registration_mark: 'BLZ4444', transfer_type: 'DataMove', date_of_receipt: '2017-12-07', cherished_plate_transfer_date: '2017-12-07' },
    { current_vehicle_registration_mark: 'S500VNY', previous_vehicle_registration_mark: 'IGZ3096', transfer_type: 'DataMove', date_of_receipt: '2021-07-06', cherished_plate_transfer_date: '2021-07-06' },
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 2);
  // PREVIOUS plates only — the current plate (S500VNY) must NOT appear.
  assert.deepEqual(r.plates.map((p) => p.plate), ['BLZ4444', 'IGZ3096']);
  assert.ok(!r.plates.some((p) => p.plate === 'S500VNY'));
  assert.equal(r.plates[0].date, '7 Dec 2017');
  assert.equal(r.plates[1].date, '6 Jul 2021');
});

test('alternate field names (vrm / date) still extract', () => {
  const r = summarisePlateChanges([{ vrm: 'YH23 NVW', date: '2022-01-10' }]);
  assert.equal(r.status, 'ok');
  assert.equal(r.plates[0].plate, 'YH23NVW');
});

test('bare-string plate entries are accepted', () => {
  const r = summarisePlateChanges(['SF69YBB', 'ab12cde']);
  assert.equal(r.count, 2);
  assert.ok(r.plates.every((p) => /^[A-Z0-9]+$/.test(p.plate)));
});

test('empty / non-array / junk → no_data (never throws)', () => {
  assert.equal(summarisePlateChanges([]).status, 'no_data');
  assert.equal(summarisePlateChanges(null).status, 'no_data');
  assert.equal(summarisePlateChanges([{ foo: 'bar' }, {}]).status, 'no_data');
});
