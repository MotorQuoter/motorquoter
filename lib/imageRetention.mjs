// The deletion that never existed (batch 39). Supabase is over quota because nothing has ever removed
// a salvage image. Vincent's rule: a salvage assessment's photos live 24 HOURS — free re-run inside
// the window, a new purchase after.
//
// For each EXPIRED, keep=false assessment this removes its images from BOTH stores (the lot-images
// bucket AND the legacy base64 column) and then its row — STORAGE FIRST, so a crash never orphans the
// bytes (row-first is exactly the bug in the commented-out cleanup query).
//
// SAFETY (this is destructive and irreversible):
//  - NEVER touches keep=true (fixtures / ground truth must outlive the window — batch 39 §3a).
//  - LISTS the actual objects under the assessment prefix — never a guessed 0.jpg..40.jpg (a partial
//    upload leaves gaps; a guessed list silently leaves bytes behind).
//  - Requires the keep column: the row query filters on it, so if the column is missing the query
//    ERRORS and the whole sweep ABORTS — deleting nothing rather than deleting without the keep guard.
//  - dryRun counts exactly what a real run would delete, touching nothing — so the first-pass size is
//    known before anything is destroyed (batch 39 §7.3).
//
// ⚠️ NOTE FOR THE MAINTAINER: deleting the ROW removes the assessment RESULT and the paid-transaction
// record (stripe_session_id, payment_kind) with it — not just the photos. The quota is freed by the
// storage + base64 removal alone; the row delete is per batch 39 §4 and §2 ("a new assessment is a new
// purchase"). If the intent is photos-only (keep the paid record + the viewable report), delete just
// the storage objects and null the images column, and keep the row. Flagged, not decided here.

const BUCKET = 'lot-images';

// Purge one expired assessment: storage objects FIRST, then the row (which takes the base64 column
// with it). The .eq('keep', false) on the delete is a belt-and-braces second guard. Throws on any
// storage/db error BEFORE the row delete, so a failure leaves BOTH copies (never a half-deletion).
async function purgeAssessment(supabase, id) {
  // 1. List the real objects under `${id}/` and remove them.
  const { data: listed, error: listErr } = await supabase.storage.from(BUCKET).list(id, { limit: 1000 });
  if (listErr) throw new Error(`list ${id}: ${listErr.message}`);
  const paths = (listed || []).map(o => `${id}/${o.name}`);
  const freedBytes = (listed || []).reduce((s, o) => s + (o.metadata?.size || 0), 0);
  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmErr) throw new Error(`remove ${id}: ${rmErr.message}`);
  }
  // 2. Delete the row AFTER storage is gone — this also clears the legacy base64 images column.
  const { error: delErr } = await supabase.from('salvage_sessions').delete().eq('id', id).eq('keep', false);
  if (delErr) throw new Error(`delete row ${id}: ${delErr.message}`);
  return { objects: paths.length, freedBytes };
}

/**
 * Sweep expired salvage images.
 * @param {*} supabase service-role client
 * @param {{ olderThanHours?: number, dryRun?: boolean, limit?: number, nowMs?: number }} opts
 * @returns {{ ok, dryRun, candidates, rowsSwept, objectsRemoved, freedBytes, errors }}
 *   ok:false + a reason means the sweep ABORTED and deleted nothing (e.g. keep column missing).
 */
export async function sweepExpiredImages(supabase, opts = {}) {
  const { olderThanHours = 24, dryRun = false, limit = 500, nowMs = Date.now() } = opts;
  const cutoff = new Date(nowMs - olderThanHours * 3600 * 1000).toISOString();
  const out = { ok: true, dryRun, candidates: 0, rowsSwept: 0, objectsRemoved: 0, freedBytes: 0, errors: [] };

  // Find expired, NOT-kept rows. Selecting `keep` forces the column to exist — if it doesn't, this
  // errors and we abort (never delete without the guard).
  const { data: rows, error } = await supabase
    .from('salvage_sessions')
    .select('id, keep, created_at')
    .lt('created_at', cutoff)
    .eq('keep', false)
    .limit(limit);
  if (error) {
    out.ok = false;
    out.reason = `query failed (aborting, nothing deleted): ${error.message}`;
    return out;
  }
  out.candidates = rows?.length ?? 0;
  if (dryRun || out.candidates === 0) return out; // dry run: report the size, delete nothing

  for (const row of rows) {
    try {
      const { objects, freedBytes } = await purgeAssessment(supabase, row.id);
      out.rowsSwept += 1;
      out.objectsRemoved += objects;
      out.freedBytes += freedBytes;
    } catch (err) {
      out.errors.push(String(err?.message || err));
    }
  }
  return out;
}
