// Validator — the One Auto fetch choke point (feat/oneauto-fetch, batch 37 commit 1).
//
// Commit 1 is a PURE REFACTOR: one base, one header, one fetch, ZERO observable change. This guards
// exactly that — the request oneAutoFetch builds is byte-identical to the old inline fetch, no bare
// One Auto fetch survives outside the wrapper, and the base/header are each defined once.
//
// It does NOT assert anything about COST — this branch produces call counts, never rates.
//
// Run: ONE_AUTO_API_KEY=… node scripts/validate-oneauto-fetch.mjs   (key defaults to a test value)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.ONE_AUTO_API_KEY ??= 'test-key';
const { oneAutoFetch, oneAutoHeaders, ONE_AUTO_BASE } = await import('../lib/oneAuto.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── 1. Byte-identity — the wrapped request equals the old inline fetch ─────────────────────────────
console.log('\n1. oneAutoFetch builds byte-identical requests');
{
  const realFetch = globalThis.fetch;
  let cap;
  globalThis.fetch = (url, init) => { cap = { url, init }; return Promise.resolve({ status: 200 }); };
  try {
    // Direct caller: relative path → base prepended, One Auto key header added.
    oneAutoFetch('cartell/vehicleidentity?vehicle_registration_mark=AB12CDE');
    assert('relative path → ${ONE_AUTO_BASE}/path (unchanged URL)', cap.url, `${ONE_AUTO_BASE}/cartell/vehicleidentity?vehicle_registration_mark=AB12CDE`);
    assert('relative path → oneAutoHeaders() applied', cap.init.headers, oneAutoHeaders());
    // Polling caller: absolute URL + preset headers → passed through untouched.
    const abs = `${ONE_AUTO_BASE}/ezyvin/servicehistory/?vehicle_identification_number=XYZ`;
    oneAutoFetch(abs, { headers: { 'x-api-key': 'test-key' } });
    assert('absolute URL passes through unchanged', cap.url, abs);
    assert('preset headers are preserved (not overwritten)', cap.init.headers, { 'x-api-key': 'test-key' });
    // Query string is caller-built and untouched (mileage_unit ordering etc.).
    oneAutoFetch('cartell/priceguide/?vehicle_registration_mark=AB12CDE&current_mileage=50000&mileage_unit=km');
    assert('query string is passed through verbatim', cap.url, `${ONE_AUTO_BASE}/cartell/priceguide/?vehicle_registration_mark=AB12CDE&current_mileage=50000&mileage_unit=km`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 2. No bare One Auto fetch survives outside the wrapper ─────────────────────────────────────────
console.log('\n2. No bare One Auto fetch outside the choke point');
for (const f of ['app/api/vehicle/route.js', 'app/api/vehicle-image/route.js']) {
  const src = read(f);
  ok(`${f}: no fetch( on a ONE_AUTO_BASE URL`, !/fetch\(\s*`?\$\{ONE_AUTO_BASE\}/.test(src));
  ok(`${f}: no local ONE_AUTO_BASE / oneAutoHeaders definition`, !/const (ONE_AUTO_BASE|oneAutoHeaders) =/.test(src));
  ok(`${f}: imports oneAutoFetch from the shared module`, /from '@\/lib\/oneAuto\.mjs'/.test(src));
}
// DVLA (driver-vehicle-licensing) and DVSA are NOT One Auto and must stay direct.
ok('the DVLA fetch is untouched (not a One Auto call)', read('app/api/vehicle/route.js').includes('driver-vehicle-licensing.api.gov.uk'));

// ── 3. Base + header defined exactly once, in the shared module ───────────────────────────────────
console.log('\n3. Single definition of base and header');
{
  const mod = read('lib/oneAuto.mjs');
  assert('ONE_AUTO_BASE defined once (module)', (mod.match(/export const ONE_AUTO_BASE =/g) || []).length, 1);
  assert('oneAutoHeaders defined once (module)', (mod.match(/export const oneAutoHeaders =/g) || []).length, 1);
  ok('the module exports the choke point', mod.includes('export function oneAutoFetch'));
  // Count call sites now routed through the wrapper (the drift-hiding surface, was ~20 bare fetches).
  const routed = (read('app/api/vehicle/route.js').match(/oneAutoFetch\(/g) || []).length
               + (read('app/api/vehicle-image/route.js').match(/oneAutoFetch\(/g) || []).length;
  console.log(`  note — ${routed} oneAutoFetch call sites now route through the one choke point`);
  ok('at least the known One Auto call sites are routed', routed >= 16);
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
