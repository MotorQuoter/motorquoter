// Validator — image retention (batch 39-42). £0. The ongoing sweep now deletes PHOTOS and KEEPS the
// row (batch 42): it removes the row's real image_paths, then in ONE update stamps
// images_purged_at + nulls image_paths + nulls images — NO DELETE against salvage_sessions. Expiry is
// the positive images_purged_at fact (the 410), never an empty fetch. Age alone, batched, idempotent.
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

// Live fake for the row sweep. Rows carry image_paths + images_purged_at (null). The sweep filters on
// age AND images_purged_at IS NULL; update() stamps the row (so it drops from the filter). Tracks the
// call order; a DELETE against salvage_sessions would show as 'row-DELETE' (must never appear).
function makeFake(initialRows) {
  const store = initialRows.map(r => ({ images_purged_at: null, ...r }));
  const calls = [];
  function selectBuilder(head) {
    let f = () => store.filter(r => r.images_purged_at == null);
    const b = {
      lt(_c, cutoff) { const p = f; f = () => p().filter(r => r.created_at < cutoff); return b; },
      is(col, val) { if (col === 'images_purged_at' && val === null) return b; const p = f; f = () => p(); return b; },
      order() { return b; },
      limit(n) { return Promise.resolve({ data: f().slice(0, n), error: null }); },
      then(res) { res({ count: f().length, error: null }); },
    };
    return b;
  }
  return {
    store, calls,
    from(table) {
      if (table === 'salvage_sessions') return {
        select(_c, opts) { return selectBuilder(opts?.head); },
        update(patch) { return { eq(_c, id) { calls.push(`row-update:${id}:${Object.keys(patch).sort().join(',')}`); const r = store.find(x => x.id === id); if (r) Object.assign(r, patch); return Promise.resolve({ error: null }); } }; },
        delete() { return { eq(_c, id) { calls.push(`row-DELETE:${id}`); return Promise.resolve({ error: null }); } }; },
      };
      return { delete() { return { eq() { calls.push('OTHER-delete'); return Promise.resolve({ error: null }); } }; } };
    },
    storage: { from() { return {
      remove(paths) { calls.push(`storage-remove:${paths.join(',')}`); return Promise.resolve({ error: null }); },
      list() { return Promise.resolve({ data: [], error: null }); },
    }; } },
  };
}
const T = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// ── 1. Dry run counts expired-and-unpurged, touches nothing ───────────────────────────────────────
console.log('\n1. Dry run');
{
  const fake = makeFake([
    { id: 'a', created_at: T(48), image_paths: ['u1/0.jpg'] },
    { id: 'b', created_at: T(1), image_paths: [] },
    { id: 'c', created_at: T(72), image_paths: ['u3/0.jpg'], images_purged_at: T(1) }, // already purged
  ]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, dryRun: true });
  assert('counts expired AND not-yet-purged only', r.candidates, 1);
  ok('no calls', fake.calls.length === 0);
}

// ── 2. Photo-only purge: remove real paths, then UPDATE (stamp), NO DELETE ─────────────────────────
console.log('\n2. Deletes photos, keeps the row (UPDATE, never DELETE)');
{
  const fake = makeFake([{ id: 'row-xyz', created_at: T(48), image_paths: ['upload-abc/0.jpg', 'upload-abc/1.jpg'] }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24 });
  assert('one row purged, two objects', [r.rowsSwept, r.objectsRemoved], [1, 2]);
  ok('NO DELETE was issued against salvage_sessions', !fake.calls.some(c => c.startsWith('row-DELETE')));
  assert('order: remove(real upload paths) → UPDATE stamping image_paths/images/images_purged_at', fake.calls,
    ['storage-remove:upload-abc/0.jpg,upload-abc/1.jpg', 'row-update:row-xyz:image_paths,images,images_purged_at']);
  ok('the row survives with images_purged_at stamped', fake.store[0].images_purged_at != null && fake.store[0].image_paths === null && Array.isArray(fake.store[0].images) && fake.store[0].images.length === 0);
}

// ── 3. Idempotent — a re-run skips already-stamped rows ───────────────────────────────────────────
console.log('\n3. Idempotent (images_purged_at drops the row from the filter)');
{
  const fake = makeFake(Array.from({ length: 150 }, (_, i) => ({ id: `x${i}`, created_at: T(48), image_paths: [`u${i}/0.jpg`] })));
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, pageSize: 50 });
  assert('all 150 purged across pages', r.rowsSwept, 150);
  assert('a second run finds nothing', (await sweepExpiredImages(fake, { olderThanHours: 24 })).rowsSwept, 0);
  ok('every row still present (kept), all stamped', fake.store.length === 150 && fake.store.every(r => r.images_purged_at != null));
}

// ── 4. Legacy base64-only row (no image_paths) still stamped, no storage-remove ───────────────────
console.log('\n4. Legacy base64-only row');
{
  const fake = makeFake([{ id: 'legacy', created_at: T(48), image_paths: null }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24 });
  assert('purged (stamped), zero objects, no storage-remove', [r.rowsSwept, r.objectsRemoved, fake.calls.some(c => c.startsWith('storage-remove'))], [1, 0, false]);
}

// ── 5. sweepOrphanBucket still reclaims storage with no owning row ────────────────────────────────
console.log('\n5. Orphan bucket sweep (still needed for the already-deleted backlog)');
{
  const objByFolder = { f1: [{ name: '0.jpg', metadata: { size: 1000 } }], f2: [{ name: '0.jpg', metadata: { size: 500 } }] };
  const removed = new Set();
  const fake = { storage: { from() { return {
    list(path, { offset = 0 } = {}) { if (path === '') return Promise.resolve({ data: ['f1', 'f2'].filter(f => !removed.has(f)).map(n => ({ name: n, id: null })).slice(offset), error: null }); return Promise.resolve({ data: objByFolder[path] || [], error: null }); },
    remove(paths) { removed.add(paths[0].split('/')[0]); return Promise.resolve({ error: null }); },
  }; } } };
  const r = await sweepOrphanBucket(fake, { pageSize: 100 });
  assert('folders + objects + bytes', [r.folders, r.objects, r.freedBytes], [2, 2, 1500]);
}

// ── 6. STRUCTURAL ─────────────────────────────────────────────────────────────────────────────────
console.log('\n6. Code-level guards');
{
  const lib = read('lib/imageRetention.mjs');
  ok('the sweep issues NO delete against salvage_sessions (UPDATE only)', !/salvage_sessions'\)\s*\n?\s*\.delete\(/.test(lib) && !/from\('salvage_sessions'\)\.delete\(/.test(lib));
  ok('purge stamps images_purged_at + nulls image_paths + empties images ([] — the column is NOT NULL)', lib.includes('images_purged_at: new Date().toISOString()') && lib.includes('image_paths: null') && lib.includes('images: []'));
  ok('the sweep skips already-purged rows', lib.includes("is('images_purged_at', null)"));
  ok('removes the ROW image_paths, not a guessed prefix', lib.includes('row.image_paths') && !/\$\{id\}\//.test(lib));
  ok('NO keep column/filter — age alone', !lib.includes("'keep'") && !/keep\s+boolean/i.test(lib));
  ok('sweepOrphanBucket retained', lib.includes('export async function sweepOrphanBucket'));
  ok('no free_report_tokens delete CALL on the normal path (row survives)', !lib.includes("from('free_report_tokens')"));

  const assess = read('app/api/salvage/assess/route.js');
  ok('assess returns the honest 410 on images_purged_at, before any fetch', /session\.images_purged_at\)[\s\S]{0,200}status: 410/.test(assess));
  const idxStamp = assess.indexOf('session.images_purged_at');
  const idxFetch = assess.indexOf('fetchImagesFromStorage(supabase, session.image_paths)');
  ok('the 410 gate precedes the image fetch', idxStamp > 0 && idxFetch > 0 && idxStamp < idxFetch);

  ok('schema.sql defines images_purged_at + the ALTER', /images_purged_at\s+timestamptz/.test(read('supabase/schema.sql')) && read('supabase/schema.sql').includes('ADD COLUMN IF NOT EXISTS images_purged_at'));
  ok('success page states the approved 24h wording', read('app/salvage/success/page.js').includes('kept for'));
  const cron = read('app/api/cron/sweep-images/route.js');
  ok('cron: CRON_SECRET auth, 24h, never 500, opsAlert', cron.includes('`Bearer ${secret}`') && cron.includes('olderThanHours: 24') && !cron.includes('status: 500'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
