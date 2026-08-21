// Sweep for lib/roiPlate.js isRoiPlate — the Salvage IE-door detector must FAIL OPEN:
// a false reject on a valid UK reg costs a sale and looks broken. Run: node --test scripts/validate-roi-plate.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRoiPlate } from '../lib/roiPlate.js';

// ── THE ONE THAT MATTERS: zero rejections of valid UK registrations ──
test('UK plates are NEVER matched as Irish (fail open)', () => {
  const uk = [
    '123 ABC',   // dateless (digits-letters — no trailing digits, unlike Irish)
    '1 ABC',     // short dateless
    '123456',    // numeric-only novelty
    'A123 BCD',  // prefix (1983-2001)
    'ABC 123A',  // suffix (1963-1983)
    'AB12 CDE',  // current
    'XYZ 1234',  // NI
    'AAA 1',     // NI short
    'VRM',       // garbage letters
  ];
  for (const p of uk) assert.equal(isRoiPlate(p), false, `${p} must NOT be treated as Irish`);
});

// ── True rejects: real Irish registrations, separated and unseparated ──
test('Irish registrations ARE matched (old + new format, dashed + bare)', () => {
  const ie = [
    '08-D-12345', '08D12345',   // old format
    '99-KY-1234',               // old, 2-letter county
    '131-D-12345', '191-D-1234',// new format (2013+)
    '232-C-5678', '232C5678',   // new, single-letter county
    '12 C 3456',                // space-separated
  ];
  for (const p of ie) assert.equal(isRoiPlate(p), true, `${p} must be treated as Irish`);
});

// ── An Irish-SHAPED string with an unknown county code falls through (fail open) ──
test('Irish shape but unrecognised county → NOT matched (falls to DVLA, fails naturally)', () => {
  assert.equal(isRoiPlate('08-ZZ-1234'), false);   // ZZ is not a county
  assert.equal(isRoiPlate('08ZZ1234'), false);
});
