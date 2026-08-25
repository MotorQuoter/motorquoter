// Validator — VIN-no-display net (batch 68). £0: no supplier call, no fixture.
//
// The binding rule is our own: the full VIN is BACKGROUND-USE-ONLY and must never reach the client
// payload, the HTML source or the PDF (DVLA/Mark display condition; VDG terms 7.3). `scrubVin`
// (app/api/vehicle/route.js) masks a full VIN in place; batch 68 applied it as a belt-and-braces net
// on EVERY payload return path — GB and IE, fresh and cache-hit — because the raw AutoCheck result is
// embedded whole at `payload.autocheck` and the Cartell HPI at `payload.hpi`.
//
// This validator does two things at zero cost:
//   (A) BEHAVIOURAL — extracts the REAL scrubVin from route.js (so the test can never drift from the
//       shipped implementation) and proves a full 17-char VIN embedded in an AutoCheck / HPI payload
//       is masked, by both key name and 17-char shape, at depth, on the GB and IE shapes — while a
//       normal field of similar length is NOT over-masked.
//   (B) STRUCTURAL — asserts the net is actually invoked on every payload return path, so the proven
//       function is reached fresh AND cached, GB AND IE, plus the stored-report re-open.
//
// Run: node scripts/validate-vin-scrub.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const src = readFileSync(join(ROOT, 'app/api/vehicle/route.js'), 'utf8');

// ── Extract the real scrubVin (VIN_KEY + VIN_SHAPE + function) from the shipped source ────────────
const slice = src.match(/const VIN_KEY[\s\S]*?\n\}\n/);
if (!slice) { console.log('  FAIL — could not extract scrubVin from route.js'); process.exit(1); }
const scrubVin = new Function(`${slice[0]}\nreturn scrubVin;`)();

const FULL_VIN = 'WF0AXXWPMAA123456';           // 17 chars, no I/O/Q — a valid VIN shape
const has = (obj) => JSON.stringify(obj).includes(FULL_VIN);
const masked = (v) => typeof v === 'string' && v.startsWith('…');

// ── (A) BEHAVIOURAL ───────────────────────────────────────────────────────────────────────────────
console.log('\n(A) scrubVin masks a full VIN in AutoCheck / HPI payloads');

// GB: raw AutoCheck result embedded whole at payload.autocheck (route.js ~:1162) — VIN by KEY NAME.
{
  const payload = { make: 'FORD', model: 'Focus',
    autocheck: { vehicle_identification_number: FULL_VIN, keeper_data_items: [{ number_previous_keepers: 3 }] } };
  scrubVin(payload);
  ok('GB — VIN masked by key name inside payload.autocheck', masked(payload.autocheck.vehicle_identification_number));
  ok('GB — no full VIN survives anywhere in the payload', !has(payload));
  ok('GB — non-VIN sibling data is untouched', payload.autocheck.keeper_data_items[0].number_previous_keepers === 3);
}

// GB: a full VIN under a DIFFERENTLY-named key is still caught by 17-char SHAPE.
{
  const payload = { hpi: { chassis_number: FULL_VIN } };
  scrubVin(payload);
  ok('GB — VIN masked by 17-char shape under a non-standard key', masked(payload.hpi.chassis_number));
  ok('GB — no full VIN survives (shape path)', !has(payload));
}

// IE: Cartell HPI embedded at payload.hpi (route.js :712) — nested deep.
{
  const payload = { market: 'IE', hpi: { report: { details: { vehicle_identification_number: FULL_VIN } } }, nctHistory: {} };
  scrubVin(payload);
  ok('IE — VIN masked deep inside payload.hpi', masked(payload.hpi.report.details.vehicle_identification_number));
  ok('IE — no full VIN survives anywhere in the payload', !has(payload));
}

// NEGATIVE — a normal field of similar length must NOT be over-masked (no false positives).
{
  const payload = { _cachedAt: '2026-08-25T12:00:00.000Z', model: 'Focus ST Estate', sessionRef: 'order_1234567890' };
  const before = JSON.stringify(payload);
  scrubVin(payload);
  ok('non-VIN fields of similar length are left untouched', JSON.stringify(payload) === before);
}

// ── (B) STRUCTURAL — the net is invoked on every payload return path ───────────────────────────────
console.log('\n(B) the net is wired on every payload return path');
ok('scrubVin is defined', /function scrubVin\(/.test(src));
ok('free cache-hit return is scrubbed',        /return NextResponse\.json\(scrubVin\(\{ \.\.\.cached\.payload, mileageVerdict: freshVerdict/.test(src));
ok('free fresh payload is scrubbed before cache', /scrubVin\(payload\);[^\n]*\n\s*await storeCachedResult\(supabase, cleanVrm, cacheKey, payload\);[\s\S]{0,120}logEvent\('lookup_submitted'/.test(src));
ok('stored-report re-open is scrubbed',        /return NextResponse\.json\(scrubVin\(stored\.payload\)\)/.test(src));
ok('IE ROI cache-hit served object is scrubbed', /const served = \{ \.\.\.roiCached\.payload[\s\S]{0,80}scrubVin\(served\)/.test(src));
ok('IE ROI fresh payload is scrubbed before cache', /scrubVin\(roiPayload\);\s*\n\s*await storeCachedResult\(supabase, cleanVrm, roiCacheKey, roiPayload\)/.test(src));
ok('GB cache-hit served object is scrubbed',   /const servedCached = \{ \.\.\.clean, \.\.\.refundState[\s\S]{0,80}scrubVin\(servedCached\)/.test(src));
ok('IE fresh paid payload is scrubbed before the cache guard', /mirror of the GB path\. Strip any echoed full VIN \(Cartell[\s\S]{0,200}scrubVin\(payload\);/.test(src));
ok('GB fresh paid payload is scrubbed before the cache guard', /strip any echoed full VIN before it is cached, persisted or[\s\S]{0,320}scrubVin\(payload\);/.test(src));
// The raw AutoCheck embed must be downstream-protected: the embed exists and a scrub runs on the served path.
ok('raw AutoCheck result is embedded (the thing being protected)', /autocheck: autocheck\?\.result \|\| null/.test(src));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
