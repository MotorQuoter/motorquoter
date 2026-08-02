// Guard for the FAILED-MOT expiry sentinel fix in lib/dvsa.js.
// DVSA returns a 1900-01-01 sentinel in expiryDate for FAILED / abandoned tests;
// formatExpiry() must map that (and blanks) to null so no render surface prints
// "Expires 01/01/1900". This mirrors the helper in lib/dvsa.js verbatim — that
// module is CommonJS-typed and can't be imported by a node .mjs test, so if you
// edit formatDate/formatExpiry there, mirror the change here.
// Run: node --test scripts/validate-mot-expiry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

function formatDate(str) {
  if (!str) return str;
  const [y, m, d] = str.split(/[ T]/)[0].split('-');
  return d ? `${d}/${m}/${y}` : str;
}

function formatExpiry(str) {
  if (!str) return null;
  if (str.split(/[ T]/)[0] === '1900-01-01') return null;
  return formatDate(str);
}

test('1900-01-01 sentinel → null (date-only)', () => {
  assert.equal(formatExpiry('1900-01-01'), null);
});

test('1900-01-01 sentinel with time component → null', () => {
  assert.equal(formatExpiry('1900-01-01 00:00:00'), null);
  assert.equal(formatExpiry('1900-01-01T00:00:00.000Z'), null);
});

test('blank / missing → null', () => {
  assert.equal(formatExpiry(''), null);
  assert.equal(formatExpiry(null), null);
  assert.equal(formatExpiry(undefined), null);
});

test('genuine PASS expiry formats normally', () => {
  assert.equal(formatExpiry('2024-06-13'), '13/06/2024');
  assert.equal(formatExpiry('2024-06-13T00:00:00.000Z'), '13/06/2024');
});
