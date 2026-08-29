// Validator — self-reference by LOT NUMBER (batch 79 TASK-1). £0: no supplier call, no vision, no API.
//
// Vincent's ruling (29 Aug 2026): a salvage record is the current lot's OWN auction event — a
// self-reference, not a prior — iff its documented lot number (salvage_auction_record_id) equals the
// engine's vd.lotNumber. The retired 14-day-window + mileage + category predicate could not separate
// self from a genuine prior (the record sits 0–81 days before the listing's own sale date, no pattern).
//
// This validator proves, all against the SHIPPED source (extracted, then executed):
//   (A) STRUCTURAL — SELF_REF_DATE_WINDOW_DAYS is gone (both uses); the id-identity test is wired;
//       the prose-override date guard is removed; the future-date guard is present.
//   (B) BEHAVIOURAL (synthetic) — id-match → self; id-miss → genuine prior; missing id → prior;
//       future-dated record → not a prior; null lot number → prior. Portable, no fixtures needed.
//   (C) FIXTURE-DRIVEN — over every fixtures/<VRM>/fixture.json on disk: after the change EVERY
//       record-bearing fixture must report recordsExcludingSelf === 0 (== genuinePriorCount with no
//       prose override). Today six reported 1. Fixtures are gitignored/regenerable, so this section
//       SKIPS (does not fail) when the directory is absent.
//
// Run: node scripts/validate-self-reference.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const src = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');

// ── Extract the real tagSelfReference from the shipped source and execute it ───────────────────────
const fnSrc = src.match(/function tagSelfReference\(shResult, vd\) \{[\s\S]*?\n\}/);
if (!fnSrc) { console.log('  FAIL — could not extract tagSelfReference from route.js'); process.exit(1); }
const tagSelfReference = new Function(`${fnSrc[0]}\nreturn tagSelfReference;`)();

// Helper: run the real function on raw records + vd, return the prior count it computes.
function priorsFor(records, vd) {
  const shResult = { salvage_auction_records: records };
  tagSelfReference(shResult, vd);
  return shResult;
}

// ── (A) STRUCTURAL ─────────────────────────────────────────────────────────────────────────────
console.log('\n(A) STRUCTURAL — the shipped source');
ok('SELF_REF_DATE_WINDOW_DAYS constant is deleted', !/SELF_REF_DATE_WINDOW_DAYS/.test(src));
ok('lot-number identity test is wired (salvage_auction_record_id vs lotNumber)',
   /salvage_auction_record_id/.test(fnSrc[0]) && /vd\.lotNumber/.test(fnSrc[0]));
ok('retired predicate is gone (no mileage/category self-match in tagSelfReference)',
   !/mileageMatch|categoryMatch|catLetter\(/.test(fnSrc[0]));
ok('future-date guard is present (saleDate.ms comparison)',
   /saleDate\?\.ms|saleMs/.test(fnSrc[0]) && /salvage_auction_lot_date/.test(fnSrc[0]));
ok('prose-override date guard removed from buildSalvageCountSlot (no overrideDateOk)',
   !/overrideDateOk/.test(src));
ok('every self-ref path logs (id-hit / id-miss / future-date-guard)',
   /id-hit/.test(fnSrc[0]) && /id-miss/.test(fnSrc[0]) && /future-date-guard/.test(fnSrc[0]));

// ── (B) BEHAVIOURAL — synthetic, portable ────────────────────────────────────────────────────────
console.log('\n(B) BEHAVIOURAL — synthetic cases');
const SALE_MS = Date.parse('2026-08-31T00:00:00Z');
const vdBase = { lotNumber: 57562265, saleDate: { ms: SALE_MS, offsetH: 0 } };

{ // id-match → self-reference, zero priors
  const r = priorsFor([{ salvage_auction_record_id: 57562265, salvage_auction_lot_date: '2026-08-15' }], vdBase);
  ok('id-match → self-reference (recordsExcludingSelf 0, selfMatchCount 1)',
     r.recordsExcludingSelf === 0 && r.selfMatchCount === 1 && r.isSelfReferenceFirstWriteOff === true);
}
{ // id-miss (earlier, different lot) → genuine prior retained (over-count direction)
  const r = priorsFor([{ salvage_auction_record_id: 40000001, salvage_auction_lot_date: '2025-01-10' }], vdBase);
  ok('id-miss on an earlier record → genuine prior retained (recordsExcludingSelf 1)',
     r.recordsExcludingSelf === 1 && r.selfMatchCount === 0);
}
{ // missing id on the record → cannot prove self → prior
  const r = priorsFor([{ salvage_auction_lot_date: '2025-01-10' }], vdBase);
  ok('missing record id → genuine prior retained', r.recordsExcludingSelf === 1);
}
{ // future-dated record (after the listing sale), non-matching id → cannot be a prior
  const r = priorsFor([{ salvage_auction_record_id: 99999999, salvage_auction_lot_date: '2026-09-30' }], vdBase);
  ok('future-dated non-matching record → not a prior (future-date guard)', r.recordsExcludingSelf === 0);
}
{ // null lot number on the vd → cannot prove self by id → prior (unless future-dated)
  const r = priorsFor([{ salvage_auction_record_id: 57562265, salvage_auction_lot_date: '2025-01-10' }], { lotNumber: null, saleDate: null });
  ok('null vd.lotNumber → genuine prior retained (no guess)', r.recordsExcludingSelf === 1);
}
{ // two records: one self (id-match), one genuine earlier prior → count 1
  const r = priorsFor([
    { salvage_auction_record_id: 57562265, salvage_auction_lot_date: '2026-08-15' },
    { salvage_auction_record_id: 40000001, salvage_auction_lot_date: '2024-03-01' },
  ], vdBase);
  ok('mixed: self + one real prior → recordsExcludingSelf 1, not self-first-writeoff',
     r.recordsExcludingSelf === 1 && r.selfMatchCount === 1 && r.isSelfReferenceFirstWriteOff === false);
}

// ── (C) FIXTURE-DRIVEN — the acceptance lock ─────────────────────────────────────────────────────
console.log('\n(C) FIXTURE-DRIVEN — fixtures/<VRM>/fixture.json (gitignored; SKIP if absent)');
const FIXROOT = join(ROOT, 'fixtures');
if (!existsSync(FIXROOT)) {
  console.log('  SKIP — fixtures/ not present (regenerable via scripts/capture-fixture.mjs); structural + synthetic lock stands.');
} else {
  const vrms = readdirSync(FIXROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXROOT, d.name, 'fixture.json')))
    .map((d) => d.name);
  let recordBearing = 0;
  for (const vrm of vrms) {
    const j = JSON.parse(readFileSync(join(FIXROOT, vrm, 'fixture.json'), 'utf8'));
    const vd = j.vehicleDetails || {};
    const records = j.paidFixtures?.salvageHistory?.salvage_auction_records || [];
    if (records.length === 0) { console.log(`  (skip ${vrm} — no salvage record)`); continue; }
    recordBearing++;
    const r = priorsFor(records, vd);
    ok(`${vrm}: ${records.length} record(s) → recordsExcludingSelf === 0 (genuinePriorCount 0)`,
       r.recordsExcludingSelf === 0);
  }
  ok(`fixture coverage: at least the 12 known record-bearing lots exercised (saw ${recordBearing})`,
     recordBearing >= 12);
}

// ── Result ───────────────────────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
