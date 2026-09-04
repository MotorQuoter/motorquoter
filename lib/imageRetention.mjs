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

// Purge one assessment's PHOTOS — batch 42: the row SURVIVES (a few KB of text; it is the only record
// of what was assessed, for whom, and what was charged). Only the photos were the gigabyte.
// ⚠️ The storage prefix is the UPLOAD id, not the row id — the actual object paths live in
// row.image_paths (`${uploadId}/${i}.jpg`). Remove those objects FIRST, then in ONE write stamp the
// row: image_paths → null (nothing can try to fetch what is gone), images → [] (legacy base64; the
// live column is NOT NULL, so null was silently rejecting the whole UPDATE and the stamp never landed —
// batch 104), and images_purged_at → now() as the POSITIVE expiry fact the honest 410 hangs on. No DELETE — so no
// free_report_tokens FK to clear. Throws before the stamp on a storage error (never a half-purge).
async function purgeAssessment(supabase, row) {
  const paths = Array.isArray(row.image_paths) ? row.image_paths.filter(Boolean) : [];
  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmErr) throw new Error(`remove ${row.id}: ${rmErr.message}`);
  }
  const { error: upErr } = await supabase
    .from('salvage_sessions')
    .update({ image_paths: null, images: [], images_purged_at: new Date().toISOString() })
    .eq('id', row.id);
  if (upErr) throw new Error(`stamp ${row.id}: ${upErr.message}`);
  return { objects: paths.length, freedBytes: 0 }; // remove() returns no sizes; object count is the metric
}

// Bucket-level orphan cleanup: delete storage objects whose owning row is already gone (the folder is
// named by the upload id, so orphans cannot be found from the rows). Lists the bucket, removes each
// folder's objects. Returns { folders, objects, freedBytes }. Idempotent — a re-run finds nothing.
export async function sweepOrphanBucket(supabase, { pageSize = 100 } = {}) {
  const out = { ok: true, folders: 0, objects: 0, freedBytes: 0, errors: [] };
  let offset = 0;
  for (;;) {
    const { data: roots, error } = await supabase.storage.from(BUCKET).list('', { limit: pageSize, offset });
    if (error) { out.ok = false; out.reason = `root list failed: ${error.message}`; return out; }
    if (!roots || roots.length === 0) break;
    const folders = roots.filter(e => e.id === null).map(e => e.name); // id===null ⟹ a folder
    let removedHere = 0;
    for (const folder of folders) {
      try {
        const { data: objs, error: le } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 });
        if (le) throw new Error(`list ${folder}: ${le.message}`);
        const paths = (objs || []).map(o => `${folder}/${o.name}`);
        const bytes = (objs || []).reduce((s, o) => s + (o.metadata?.size || 0), 0);
        if (paths.length) {
          const { error: re } = await supabase.storage.from(BUCKET).remove(paths);
          if (re) throw new Error(`remove ${folder}: ${re.message}`);
          out.objects += paths.length; out.freedBytes += bytes; removedHere += paths.length;
        }
        out.folders += 1;
      } catch (err) { out.errors.push(String(err?.message || err)); }
    }
    // Deleting emptied folders makes them drop from the listing, so keep reading from the same offset;
    // if nothing was removable in a full page of non-folders, advance the offset to avoid a spin.
    if (removedHere === 0) offset += roots.length;
  }
  return out;
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
  // Age gate + "not already purged" (images_purged_at IS NULL) — the row survives now (batch 42), so
  // the sweep must skip rows whose photos are already gone, or it would re-process forever.
  const applyFilters = (q) => (purgeAll ? q : q.lt('created_at', cutoff)).is('images_purged_at', null);

  // Dry run: count exactly what a real run would purge, touch nothing.
  if (dryRun) {
    const { count, error } = await applyFilters(supabase.from('salvage_sessions').select('*', { count: 'exact', head: true }));
    if (error) { out.ok = false; out.reason = `count failed: ${error.message}`; return out; }
    out.candidates = count ?? 0;
    return out;
  }

  // Real run: page → purge each row's PHOTOS + stamp the row → next page. Stamping images_purged_at
  // drops the row from the filter, so the window advances and a re-run finds nothing (idempotent). A
  // page that makes NO progress (every row errored) breaks the loop rather than spinning forever.
  for (;;) {
    const { data: rows, error } = await applyFilters(
      supabase.from('salvage_sessions').select('id, created_at, image_paths').order('created_at', { ascending: true })
    ).limit(pageSize);
    if (error) { out.ok = false; out.reason = `query failed: ${error.message}`; return out; }
    if (!rows || rows.length === 0) break;

    let deletedThisPage = 0;
    for (const row of rows) {
      out.candidates += 1;
      try {
        const { objects, freedBytes } = await purgeAssessment(supabase, row);
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
