// Validator — 24-hour image retention sweep (batch 39, corrected by 40 + 41). £0: sweep logic against
// an in-memory fake client + structural checks. DESTRUCTIVE production infra, so the guards are the
// point: delete on AGE ALONE (no keep/exemption), storage BEFORE the row (row-first orphans bytes),
// batched + resumable + idempotent (a re-run finds nothing), and a dry run that touches nothing.
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

// Live fake: a mutable store of rows + per-id objects. select pages the store; delete removes a row;
// storage.remove is a no-op. Tracks call ORDER so we can prove storage-before-row.
function makeFake(initialRows, objectsById = {}) {
  const store = [...initialRows];              // [{ id, created_at }]
  const calls = [];
  function selectBuilder(head) {
    let filtered = () => [...store];
    const b = {
      _count: head,
      lt(_c, cutoff) { const prev = filtered; filtered = () => prev().filter(r => r.created_at < cutoff); return b; },
      order() { return b; },
      limit(n) { const rows = filtered().slice(0, n); return Promise.resolve({ data: rows, error: null }); },
      // head/count path: thenable
      then(res) { res({ count: filtered().length, data: null, error: null }); },
    };
    return b;
  }
  return {
    store, calls,
    from() {
      return {
        select(_cols, opts) { return selectBuilder(opts?.head); },
        delete() { return { eq(_c, id) { calls.push(`row-delete:${id}`); const i = store.findIndex(r => r.id === id); if (i >= 0) store.splice(i, 1); return Promise.resolve({ error: null }); } }; },
      };
    },
    storage: { from() { return {
      list(id) { calls.push(`storage-list:${id}`); return Promise.resolve({ data: objectsById[id] || [], error: null }); },
      remove(paths) { calls.push(`storage-remove:${paths.length}`); return Promise.resolve({ error: null }); },
    }; } },
  };
}

const T = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString(); // h hours ago

// ── 1. Dry run counts, deletes nothing ────────────────────────────────────────────────────────────
console.log('\n1. Dry run reports the size and destroys nothing');
{
  const fake = makeFake([{ id: 'a', created_at: T(48) }, { id: 'b', created_at: T(1) }]);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, dryRun: true });
  assert('counts only rows older than 24h', r.candidates, 1);
  assert('nothing swept', r.rowsSwept, 0);
  ok('no delete/storage calls', fake.calls.length === 0);
  ok('store untouched', fake.store.length === 2);
}

// ── 2. Real 24h sweep: storage BEFORE row, only expired rows ──────────────────────────────────────
console.log('\n2. 24h sweep — expired only, storage before row');
{
  const fake = makeFake(
    [{ id: 'old', created_at: T(48) }, { id: 'fresh', created_at: T(2) }],
    { old: [{ name: '0.jpg', metadata: { size: 1000 } }, { name: '1.jpg', metadata: { size: 500 } }] },
  );
  const r = await sweepExpiredImages(fake, { olderThanHours: 24 });
  assert('one expired row swept', r.rowsSwept, 1);
  assert('objects + bytes counted from real sizes', [r.objectsRemoved, r.freedBytes], [2, 1500]);
  assert('order: list → remove → row-delete (storage first)', fake.calls, ['storage-list:old', 'storage-remove:2', 'row-delete:old']);
  ok('the fresh (<24h) row is untouched', fake.store.length === 1 && fake.store[0].id === 'fresh');
}

// ── 3. purgeAll ignores age — the full backlog ────────────────────────────────────────────────────
console.log('\n3. purgeAll deletes everything regardless of age');
{
  const fake = makeFake([{ id: 'a', created_at: T(1) }, { id: 'b', created_at: T(0.1) }, { id: 'c', created_at: T(100) }]);
  const r = await sweepExpiredImages(fake, { purgeAll: true });
  assert('every row purged regardless of age', r.rowsSwept, 3);
  ok('store emptied', fake.store.length === 0);
}

// ── 4. Batched + resumable + idempotent ───────────────────────────────────────────────────────────
console.log('\n4. Paged through a big backlog, and a re-run finds nothing');
{
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, created_at: T(48) }));
  const fake = makeFake(many);
  const r = await sweepExpiredImages(fake, { olderThanHours: 24, pageSize: 100 });
  assert('all 250 swept across pages', r.rowsSwept, 250);
  ok('store emptied', fake.store.length === 0);
  const again = await sweepExpiredImages(fake, { olderThanHours: 24, pageSize: 100 });
  assert('a second run finds nothing (idempotent)', again.rowsSwept, 0);
}

// ── 5. STRUCTURAL — age alone, no keep, correct wiring ────────────────────────────────────────────
console.log('\n5. Code-level guards');
{
  const lib = read('lib/imageRetention.mjs');
  ok('NO keep column/filter in the code — deletes on age alone', !lib.includes("'keep'") && !/\bkeep\s*[:=]/.test(lib) && !/keep\s+boolean/i.test(lib));
  ok('storage objects are LISTED, not guessed', lib.includes('.from(BUCKET).list(') && !/\d+\.jpg`/.test(lib));
  ok('the row delete keys on id only (no exemption filter)', /\.delete\(\)\.eq\('id', id\)/.test(lib));

  const cron = read('app/api/cron/sweep-images/route.js');
  ok('cron requires CRON_SECRET bearer auth', cron.includes("`Bearer ${secret}`") && cron.includes('401'));
  ok('cron has NO arm-flag / dry-run gate (deletes 24h for real)', !cron.includes('IMAGE_SWEEP_ENABLED') && cron.includes('olderThanHours: 24'));
  ok('cron never 500s', !cron.includes('status: 500'));
  ok('cron alerts on failure via opsAlert', cron.includes("sendOpsAlert('image-sweep-failed'"));

  const vercel = JSON.parse(read('vercel.json'));
  ok('vercel.json schedules the sweep cron', vercel.crons.some(c => c.path === '/api/cron/sweep-images'));
  ok('the model canary cron is still scheduled', vercel.crons.some(c => c.path === '/api/health/models'));

  ok('schema.sql has NO keep column', !/keep\s+boolean/i.test(read('supabase/schema.sql')));

  const assess = read('app/api/salvage/assess/route.js');
  ok('assess fails honestly on expired/swept photos (410, not a 500 or partial)', assess.includes('have expired') && assess.includes('expired: true'));
  const succ = read('app/salvage/success/page.js');
  ok('success page states the 24-hour rule with no override', succ.includes('24 hours') && !/unless|normally/i.test(succ.split('rerun-note')[1]?.slice(0, 300) || ''));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
