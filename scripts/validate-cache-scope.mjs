// Validator — cache-scope (audit findings 2 + 7): a cache key must carry every input that changes the
// answer. £0: pure key builders + structural source checks. No network, no DB, no supplier.
//
// Finding 2: reg_lookup_cache omitted the entered mileage, so a second customer looking up the same
//   reg at a different mileage was sold the FIRST customer's valuation (Defect-4 class, on the paid
//   valuation this time).
// Finding 7: oneauto_cache keyed on callType:reg only, so a re-listed salvage VRM (Cat N → Cat S)
//   served the stale Cat-N bid prediction for the rest of the 30-day TTL.
//
// Run: node scripts/validate-cache-scope.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mileageCacheKeyPart } from '../lib/valuationCacheKey.mjs';
import { oneAutoCacheKey } from '../lib/oneautoCache.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function assertTrue(label, cond) { assert(label, !!cond, true); }

// ── 1. Finding 2 — mileage normalisation into the reg_lookup_cache key ────────────────────────────
console.log('\n1. mileageCacheKeyPart — the entered mileage becomes part of the key');
assert('a specific mileage keeps its digits', mileageCacheKeyPart('145000'), '145000');
assert('commas/spaces are stripped', mileageCacheKeyPart('145,000'), '145000');
assert('blank → def (all default-mileage lookups share)', mileageCacheKeyPart(''), 'def');
assert('null → def', mileageCacheKeyPart(null), 'def');
assert('undefined → def', mileageCacheKeyPart(undefined), 'def');
assert('zero → def (0 is not a real reading)', mileageCacheKeyPart('0'), 'def');
assert('garbage → def', mileageCacheKeyPart('abc'), 'def');
// The load-bearing property: two DIFFERENT mileages never collide; the SAME mileage always does.
assertTrue('145,000 and 42,000 produce different key parts', mileageCacheKeyPart('145000') !== mileageCacheKeyPart('42000'));
assertTrue('the same mileage, differently formatted, collides (legitimate repeat)', mileageCacheKeyPart('145,000') === mileageCacheKeyPart('145000'));

// ── 2. Finding 2 — the route wires it into the right keys, and ONLY when a valuation was bought ────
console.log('\n2. app/api/vehicle/route.js — mileage in the GB/IE key iff valuation, always in ROI');
{
  const src = readFileSync(join(ROOT, 'app/api/vehicle/route.js'), 'utf8');
  assertTrue('the GB/IE checks key appends mileage only when valuation is in the basket',
    src.includes("checks.includes('valuation') || checks.includes('ie_valuation')") &&
    src.includes('valuationInKey ? `_mi:${mileageCacheKeyPart(mileage)}`'));
  assertTrue('the ROI key always carries the mileage (its hit path returns verbatim, no recompute)',
    src.includes('`roi:${roiTierParam}_mi:${mileageCacheKeyPart(mileage)}`'));
  assertTrue('the mileage VERDICT recompute on a hit is left intact (not touched by this fix)',
    src.includes('Mileage verdict/detail are REQUEST-SCOPED'));
}

// ── 3. Finding 7 — oneAutoCacheKey folds varying params into the key ──────────────────────────────
console.log('\n3. oneAutoCacheKey — params that vary the answer vary the key');
assert('no params → bare callType:reg (param-free callers unchanged)', oneAutoCacheKey('SALVAGEHISTORY', 'AB12CDE', {}), 'SALVAGEHISTORY:AB12CDE');
assert('null params → bare key', oneAutoCacheKey('BREGO_ROI', 'AB12CDE', null), 'BREGO_ROI:AB12CDE');
assert('empty-valued params are ignored (still bare)', oneAutoCacheKey('X', 'AB12CDE', { a: '', b: null, c: undefined }), 'X:AB12CDE');
{
  const catN = oneAutoCacheKey('SALVAGEGUIDE', 'AB12CDE', { salvage_category: 'N', current_mileage: '50000', primary_damage_desc: 'REAR' });
  const catS = oneAutoCacheKey('SALVAGEGUIDE', 'AB12CDE', { salvage_category: 'S', current_mileage: '50000', primary_damage_desc: 'FRONT' });
  assertTrue('Cat N and Cat S on the same VRM produce DIFFERENT keys (the bug the finding names)', catN !== catS);
  assertTrue('the suffix is appended to callType:reg', catN.startsWith('SALVAGEGUIDE:AB12CDE:'));
  // Order-independent + deterministic: same params in any order → same key.
  const a = oneAutoCacheKey('BREGO_GB', 'AB12CDE', { current_mileage: '10000' });
  const b = oneAutoCacheKey('BREGO_GB', 'AB12CDE', { current_mileage: '10000' });
  assert('deterministic — identical params → identical key', a, b);
  const o1 = oneAutoCacheKey('SG', 'AB12CDE', { a: '1', b: '2' });
  const o2 = oneAutoCacheKey('SG', 'AB12CDE', { b: '2', a: '1' });
  assert('param order does not change the key (sorted before hashing)', o1, o2);
  assertTrue('a different mileage changes the BREGO_GB key', oneAutoCacheKey('BREGO_GB', 'AB12CDE', { current_mileage: '10000' }) !== oneAutoCacheKey('BREGO_GB', 'AB12CDE', { current_mileage: '90000' }));
}

// ── 4. Finding 7 — the two param-bearing call sites actually pass their params; legacy overload holds ─
console.log('\n4. Call sites pass params; the legacy (callType, reg, fetchFn) overload still works');
{
  const cache = readFileSync(join(ROOT, 'lib/oneautoCache.js'), 'utf8');
  assertTrue('withOneAutoCache detects the legacy 3-arg (fetchFn) shape',
    cache.includes("typeof paramsOrFetch === 'function'"));
  assertTrue('the key is built by the shared helper, not string-munged per call site',
    cache.includes('oneAutoCacheKey(callType, normReg, params)'));
  const assess = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');
  assertTrue('BREGO_GB now passes current_mileage as a keyed param',
    assess.includes("withOneAutoCache('BREGO_GB', cleanVrmB, { current_mileage: brMileage }"));
  assertTrue('SALVAGEGUIDE passes category + mileage + damage as keyed params',
    assess.includes("{ salvage_category: sgCat, current_mileage: sgMileage, primary_damage_desc: sgDamage }"));
  // A param-free caller left in legacy form proves the overload is exercised in real code.
  assertTrue('a legacy param-free caller (SALVAGEHISTORY) is untouched',
    assess.includes("withOneAutoCache('SALVAGEHISTORY', cleanVrmB, async () =>"));
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
