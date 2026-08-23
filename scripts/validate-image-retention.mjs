// Validator — 24-hour image retention sweep (batch 39). £0: pure sweep logic against an in-memory
// fake client + structural checks. This is DESTRUCTIVE production infra, so the guards are the point:
// dry-run deletes nothing, a missing keep column ABORTS, keep=true is never touched, and storage is
// removed BEFORE the row (row-first would orphan the bytes).
//
// Run: node scripts/validate-image-retention.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sweepExpiredImages } from '../lib/imageRetention.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Fake supabase. Rows are expired keep=false candidates already (the sweep's query is simulated by
// `rows`); `keepColumnMissing` makes the select error, to prove the abort. Tracks the call ORDER.
function makeFake({ rows = [], objectsById = {}, keepColumnMissing = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = {
        _op: null,
        select() { this._op = 'select'; return this; },
        lt() { return this; },
        eq() { return this; },
        limit() {
          if (keepColumnMissing) return Promise.resolve({ data: null, error: { message: 'column "keep" does not exist' } });
          return Promise.resolve({ data: rows, error: null });
        },
        delete() { this._op = 'delete'; return this; },
      };
      // delete().eq().eq() resolves as a thenable — capture the id from the first eq.
      const del = { _id: null, eq(_c, v) { if (this._id == null) this._id = v; return this; }, then(res) { calls.push(`row-delete:${this._id}`); res({ error: null }); } };
      q.delete = () => del;
      return q;
    },
    storage: {
      from() {
        return {
          list(id) { calls.push(`storage-list:${id}`); return Promise.resolve({ data: objectsById[id] || [], error: null }); },
          remove(paths) { calls.push(`storage-remove:${paths.length}`); return Promise.resolve({ error: null }); },
        };
      },
    },
  };
}

// ── 1. Dry run — counts candidates, deletes NOTHING ───────────────────────────────────────────────
console.log('\n1. Dry run reports the size and destroys nothing');
{
  const fake = makeFake({ rows: [{ id: 'a' }, { id: 'b' }] });
  const r = await sweepExpiredImages(fake, { dryRun: true });
  assert('candidates counted', r.candidates, 2);
  assert('nothing swept in a dry run', r.rowsSwept, 0);
  ok('no storage or row delete calls made', fake.calls.length === 0);
}

// ── 2. Missing keep column → ABORT, delete nothing ────────────────────────────────────────────────
console.log('\n2. Missing keep column aborts the whole sweep');
{
  const fake = makeFake({ rows: [{ id: 'a' }], keepColumnMissing: true });
  const r = await sweepExpiredImages(fake, { dryRun: false });
  assert('ok:false (aborted)', r.ok, false);
  ok('reason names the abort', /aborting, nothing deleted/.test(r.reason || ''));
  ok('no deletes attempted', fake.calls.length === 0);
}

// ── 3. Real run — storage removed BEFORE the row, per assessment ──────────────────────────────────
console.log('\n3. Storage first, then the row (never orphan the bytes)');
{
  const fake = makeFake({
    rows: [{ id: 'lot1' }],
    objectsById: { lot1: [{ name: '0.jpg', metadata: { size: 1000 } }, { name: '1.jpg', metadata: { size: 500 } }] },
  });
  const r = await sweepExpiredImages(fake, { dryRun: false });
  assert('one row swept', r.rowsSwept, 1);
  assert('both objects removed', r.objectsRemoved, 2);
  assert('freed bytes summed from real object sizes', r.freedBytes, 1500);
  assert('order: list → remove → row-delete (storage before row)', fake.calls, ['storage-list:lot1', 'storage-remove:2', 'row-delete:lot1']);
}

// ── 4. An assessment with no stored objects still removes its row (legacy base64-only) ────────────
console.log('\n4. Legacy row with no storage objects still purges');
{
  const fake = makeFake({ rows: [{ id: 'legacy1' }], objectsById: { legacy1: [] } });
  const r = await sweepExpiredImages(fake, { dryRun: false });
  assert('row swept, zero objects', [r.rowsSwept, r.objectsRemoved], [1, 0]);
  // list runs, remove is skipped (nothing to remove), row deleted.
  assert('list then row-delete, no empty remove call', fake.calls, ['storage-list:legacy1', 'row-delete:legacy1']);
}

// ── 5. STRUCTURAL — the safety guards live in the code, not just the test ─────────────────────────
console.log('\n5. Code-level guards');
{
  const lib = read('lib/imageRetention.mjs');
  ok('the row query selects keep (forces the column to exist → abort if missing)', /\.select\('id, keep/.test(lib));
  ok('the row query filters keep=false', /\.eq\('keep', false\)/.test(lib));
  ok('the row delete also guards keep=false', (lib.match(/\.eq\('keep', false\)/g) || []).length >= 2);
  ok('storage objects are LISTED, not guessed', lib.includes('.from(BUCKET).list(') && !/\d+\.jpg`/.test(lib));

  const cron = read('app/api/cron/sweep-images/route.js');
  ok('cron requires CRON_SECRET bearer auth', cron.includes("`Bearer ${secret}`") && cron.includes('401'));
  ok('cron is DRY-RUN unless IMAGE_SWEEP_ENABLED=true (inert on deploy)', cron.includes("process.env.IMAGE_SWEEP_ENABLED === 'true'") && cron.includes('dryRun: !armed'));
  ok('cron never 500s (returns 200 even on throw)', !cron.includes('status: 500'));
  ok('cron alerts on failure via opsAlert', cron.includes("sendOpsAlert('image-sweep-failed'"));

  const vercel = JSON.parse(read('vercel.json'));
  ok('vercel.json schedules the sweep cron', vercel.crons.some(c => c.path === '/api/cron/sweep-images'));
  ok('the model canary cron is still scheduled', vercel.crons.some(c => c.path === '/api/health/models'));

  ok('schema.sql adds the keep column + the ALTER for the live table', read('supabase/schema.sql').includes('keep              boolean') && read('supabase/schema.sql').includes('ADD COLUMN IF NOT EXISTS keep'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
