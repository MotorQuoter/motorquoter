// Validator — 24-hour image retention sweep (batch 39, corrected by 40 + 41; storage-path fix). £0.
// DESTRUCTIVE production infra, so the guards are the point: delete on AGE ALONE (no keep/exemption),
// remove the row's REAL image_paths (the folder is the upload id, not the row id), storage BEFORE the
// row, clear the free_report_tokens FK first, batched + resumable + idempotent, dry run touches nothing.
//
// Run: node scripts/validate-image-retention.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sweepExpiredImages, sweepOrphanBucket } from '../lib/imageRetention.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Live fake for the row sweep. Rows carry image_paths. Tracks call order; storage.remove records the
// exact paths it was given (proving it uses image_paths, not `${id}/`).
function makeFake(initialRows) {
  const store = [...initialRows];
  const calls = [];
  function selectBuilder(head) {
    let filtered = () => [...store];
    const b = {
      lt(_c, cutoff) { const p = filtered; filtered = () => p().filter(r => r.created_at < cutoff); return b; },
      order() { return b; },
      limit(n) { return Promise.resolve({ data: filtered().slice(0, n), error: null }); },
      then(res) { res({ count: filtered().length, error: null }); },
    };
    return head ? b : b;
  }
  return {
    store, calls,
    from(table) {
      if (table === 'free_report_tokens') return { delete() { return { eq(_c, id) { calls.push(`frt-delete:${id}`); return Promise.resolve({ error: null }); } }; } };
      return {
        select(_c, opts) { return selectBuilder(opts?.head); },
        delete() { return { eq(_c, id) { calls.push(`row-delete:${id}`); const i = store.findIndex(r => r.id === id); if (i >= 0) store.splice(i, 1); return Promise.resolve({ error: null }); } }; },
      };
    },
    storage: { from() { return {
      remove(paths) { calls.push(`storage-remove:${paths.join(',')}`); return Promise.resolve({ error: null }); },
      list() { return Promise.resolve({ data: [], error: null }); },
    }; } },
  };
}
const T = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// ── 1. Dry run counts, deletes nothing ────────────────────────────────────────────────────────────
console.log('\n1. Dry run');
{
  const fake = makeFake([{ id: 'a', created_at: T(48), image_paths: ['u1/0.jpg'] }, { id: 'b', created_at: T(1), image_paths: [] }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, dryRun: true });
  assert('counts only rows older than 24h', r.candidates, 1);
  ok('no delete/storage calls', fake.calls.length === 0);
}

// ── 2. Real sweep removes the ROW'S image_paths (not id/), FK first, storage before row ───────────
console.log('\n2. Removes row.image_paths, clears the FK, storage before row');
{
  const fake = makeFake([{ id: 'row-xyz', created_at: T(48), image_paths: ['upload-abc/0.jpg', 'upload-abc/1.jpg'] }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24 });
  assert('one row swept, two objects', [r.rowsSwept, r.objectsRemoved], [1, 2]);
  assert('order: remove(real paths) → free_report_tokens delete → row delete', fake.calls,
    ['storage-remove:upload-abc/0.jpg,upload-abc/1.jpg', 'frt-delete:row-xyz', 'row-delete:row-xyz']);
  ok('the storage path uses the UPLOAD id, not the row id', fake.calls[0].includes('upload-abc') && !fake.calls[0].includes('row-xyz'));
}

// ── 3. Legacy base64 row (no image_paths) still purges, removes nothing from storage ──────────────
console.log('\n3. Legacy base64-only row');
{
  const fake = makeFake([{ id: 'legacy', created_at: T(48), image_paths: null }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24 });
  assert('row swept, zero objects, no storage-remove call', [r.rowsSwept, r.objectsRemoved, fake.calls.some(c => c.startsWith('storage-remove'))], [1, 0, false]);
}

// ── 4. Batched + idempotent ───────────────────────────────────────────────────────────────────────
console.log('\n4. Paged backlog, re-run finds nothing');
{
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, created_at: T(48), image_paths: [`u${i}/0.jpg`] }));
  const fake = makeFake(many);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, pageSize: 100 });
  assert('all 250 swept', r.rowsSwept, 250);
  assert('idempotent re-run finds nothing', (await sweepExpiredImages(fake, { olderThanHours: 24 })).rowsSwept, 0);
}

// ── 5. sweepOrphanBucket removes storage folders whose rows are gone ──────────────────────────────
console.log('\n5. Orphan bucket sweep');
{
  const objectsByFolder = { 'f1': [{ name: '0.jpg', metadata: { size: 1000 } }], 'f2': [{ name: '0.jpg', metadata: { size: 500 } }, { name: '1.jpg', metadata: { size: 500 } }] };
  let removedFolders = new Set();
  const fake = { storage: { from() { return {
    list(path, { offset = 0 } = {}) {
      if (path === '') { // root: return folders not yet removed
        const roots = ['f1', 'f2'].filter(f => !removedFolders.has(f)).map(n => ({ name: n, id: null }));
        return Promise.resolve({ data: roots.slice(offset), error: null });
      }
      return Promise.resolve({ data: objectsByFolder[path] || [], error: null });
    },
    remove(paths) { const folder = paths[0].split('/')[0]; removedFolders.add(folder); return Promise.resolve({ error: null }); },
  }; } } };
  const r = await sweepOrphanBucket(fake, { pageSize: 100 });
  assert('both folders swept', r.folders, 2);
  assert('all objects removed', r.objects, 3);
  assert('bytes summed', r.freedBytes, 2000);
}

// ── 6. STRUCTURAL — age alone, no keep, right storage source, FK handled ──────────────────────────
console.log('\n6. Code-level guards');
{
  const lib = read('lib/imageRetention.mjs');
  ok('NO keep column/filter — age alone', !lib.includes("'keep'") && !/\bkeep\s*[:=]/.test(lib) && !/keep\s+boolean/i.test(lib));
  ok('removes the ROW image_paths, not a guessed ${id}/ prefix', lib.includes('row.image_paths') && !/\$\{id\}\//.test(lib));
  ok('clears the free_report_tokens FK before deleting the row', /free_report_tokens'\)\.delete\(\)\.eq\('session_id'/.test(lib));
  ok('exposes a bucket-level orphan sweep', lib.includes('export async function sweepOrphanBucket'));

  const cron = read('app/api/cron/sweep-images/route.js');
  ok('cron requires CRON_SECRET bearer auth', cron.includes('`Bearer ${secret}`') && cron.includes('401'));
  ok('cron deletes 24h for real, no arm flag', !cron.includes('IMAGE_SWEEP_ENABLED') && cron.includes('olderThanHours: 24'));
  ok('cron never 500s', !cron.includes('status: 500'));
  ok('cron alerts on failure', cron.includes("sendOpsAlert('image-sweep-failed'"));

  const vercel = JSON.parse(read('vercel.json'));
  ok('sweep cron scheduled + canary intact', vercel.crons.some(c => c.path === '/api/cron/sweep-images') && vercel.crons.some(c => c.path === '/api/health/models'));
  ok('schema.sql has no keep column', !/keep\s+boolean/i.test(read('supabase/schema.sql')));

  const assess = read('app/api/salvage/assess/route.js');
  ok('assess fails honestly on expired photos (410)', assess.includes('have expired') && assess.includes('expired: true'));
  ok('success page states 24h with no override', read('app/salvage/success/page.js').includes('24 hours'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
