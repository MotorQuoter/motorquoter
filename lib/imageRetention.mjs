// The deletion that never existed (batch 39, corrected by batches 40 + 41). Supabase is over quota
// (FILE STORAGE 1.13 GB / 1 GB, restricted 14 Sep) because nothing has ever removed a salvage image.
//
// Vincent's rule: a salvage assessment's photos live 24 HOURS, then they are gone — for EVERYONE,
// including us. And the entire existing backlog is purged now (a 24-hour-forward rule would not clear
// the 1.13 GB, which is history).
//
// The sweep deletes on AGE ALONE — NO exemptions, NO keep-flag, NO conditions (batch 41). Ground-truth
// lots are kept on the local disk via scripts/capture-fixture.mjs, NOT pinned in the quota-limited DB.
//
// For each expired assessment it removes the images from BOTH stores — the lot-images bucket AND the
// legacy base64 salvage_sessions.images column (cleared by the row delete) — STORAGE FIRST, then the
// row, so a crash never orphans the bytes (row-first is exactly the bug in the commented-out cleanup).
//
// Batched + resumable + idempotent: it pages through expired rows deleting each page's images then its
// row, so a large backlog cannot time out in one giant remove(), and a second run finds nothing left.

const BUCKET = 'lot-images';

// Purge one assessment: storage objects FIRST (listed, never guessed), then the row (which also clears
// the legacy base64 column). Throws before the row delete on any error, so a failure leaves BOTH
// copies rather than a half-deletion.
async function purgeAssessment(supabase, id) {
  const { data: listed, error: listErr } = await supabase.storage.from(BUCKET).list(id, { limit: 1000 });
  if (listErr) throw new Error(`list ${id}: ${listErr.message}`);
  const paths = (listed || []).map(o => `${id}/${o.name}`);
  const freedBytes = (listed || []).reduce((s, o) => s + (o.metadata?.size || 0), 0);
  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmErr) throw new Error(`remove ${id}: ${rmErr.message}`);
  }
  const { error: delErr } = await supabase.from('salvage_sessions').delete().eq('id', id);
  if (delErr) throw new Error(`delete row ${id}: ${delErr.message}`);
  return { objects: paths.length, freedBytes };
}

/**
 * Sweep salvage images by AGE ALONE.
 * @param {*} supabase service-role client
 * @param {{ olderThanHours?: number, purgeAll?: boolean, dryRun?: boolean, pageSize?: number, nowMs?: number }} opts
 *   purgeAll:true ignores the age cutoff and deletes EVERYTHING currently held (the one-time backlog
 *   purge). Otherwise deletes rows older than olderThanHours (24 for the daily cron).
 * @returns {{ ok, dryRun, purgeAll, olderThanHours, candidates, rowsSwept, objectsRemoved, freedBytes, errors }}
 */
export async function sweepExpiredImages(supabase, opts = {}) {
  const { olderThanHours = 24, purgeAll = false, dryRun = false, pageSize = 100, nowMs = Date.now() } = opts;
  const cutoff = new Date(nowMs - olderThanHours * 3600 * 1000).toISOString();
  const out = { ok: true, dryRun, purgeAll, olderThanHours, candidates: 0, rowsSwept: 0, objectsRemoved: 0, freedBytes: 0, errors: [] };
  const applyAge = (q) => (purgeAll ? q : q.lt('created_at', cutoff));

  // Dry run: count exactly what a real run would delete, touch nothing.
  if (dryRun) {
    const { count, error } = await applyAge(supabase.from('salvage_sessions').select('*', { count: 'exact', head: true }));
    if (error) { out.ok = false; out.reason = `count failed: ${error.message}`; return out; }
    out.candidates = count ?? 0;
    return out;
  }

  // Real run: page → purge each row's images then row → next page. Deleting advances the window, so a
  // re-run is safe and finds nothing. A page that deletes NOTHING (every row errored) breaks the loop
  // rather than spinning forever on a persistently-failing row.
  for (;;) {
    const { data: rows, error } = await applyAge(
      supabase.from('salvage_sessions').select('id, created_at').order('created_at', { ascending: true })
    ).limit(pageSize);
    if (error) { out.ok = false; out.reason = `query failed: ${error.message}`; return out; }
    if (!rows || rows.length === 0) break;

    let deletedThisPage = 0;
    for (const row of rows) {
      out.candidates += 1;
      try {
        const { objects, freedBytes } = await purgeAssessment(supabase, row.id);
        out.rowsSwept += 1;
        out.objectsRemoved += objects;
        out.freedBytes += freedBytes;
        deletedThisPage += 1;
      } catch (err) {
        out.errors.push(String(err?.message || err));
      }
    }
    if (deletedThisPage === 0) break; // no progress possible — stop rather than loop forever
  }
  return out;
}
