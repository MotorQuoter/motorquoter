// paid_reports — a paid report survives the tab closing (BUILD_StoredReports, 21 Aug 2026).
//
// The store holds the EXACT payload the customer was served, keyed on the purchase (Stripe cs_… or
// the promo/free UUID token). A re-open is then a database read and nothing else: no supplier calls,
// no reg_lookup_cache read, no replay bind. Retention is short (STORED_REPORT_TTL_MINUTES) — the
// durable copy reaches the customer by email at purchase.
//
// Two hard rules encoded here:
//   1. Serve the stored artefact verbatim — never recompute the mileage verdict from a new ?mileage.
//      The delivered figure is part of what was bought (§2.4).
//   2. Degrade to today's behaviour if paid_reports does not exist yet. schema.sql is not
//      auto-applied; if the migration lags the deploy, a missing table must fall through to a normal
//      (bind + fetch) first-view, NOT surface as the false "payment could not be verified" this
//      branch exists to remove. Every DB touch is wrapped; a failure returns 'none' / logs and moves on.
//
// £0 to test: decideStoredReport is pure; read/write take an injected supabase-like client.

// Relative (not '@/') so `node scripts/validate-stored-reports.mjs` can import this module directly,
// without the Next path-alias resolver. Next resolves the relative path just the same.
import { STORED_REPORT_TTL_MS } from '../config/storedReports.mjs';

// Pure decision. Given a row (or null), the requested VRM, and the clock, say what the route must do.
//   { action: 'serve',   payload }   → return the stored artefact immediately (before any fetch/bind)
//   { action: 'expired', storedAt }  → honest "expired, see your emailed copy" (never a refetch)
//   { action: 'proceed' }            → no usable stored row; verify + fetch + store as a first view
export function decideStoredReport(row, cleanVrm, nowMs = Date.now(), ttlMs = STORED_REPORT_TTL_MS) {
  if (!row || !row.payload) return { action: 'proceed' };
  // VRM guard — a stored row for VRM A must never serve a request for VRM B (§6 test 4). Defensive:
  // upstream Stripe VRM-match already pins cleanVrm to the paid VRM, so this can only differ if a
  // session_id were reused across vehicles, which cannot happen. Treat a mismatch as no row.
  if (!cleanVrm || String(row.vrm).toUpperCase() !== String(cleanVrm).toUpperCase()) {
    return { action: 'proceed' };
  }
  const createdMs = new Date(row.created_at).getTime();
  const ageMs = nowMs - createdMs;
  if (!(ageMs >= 0) || ageMs > ttlMs) {
    // NaN created_at, or beyond the window → expired. Honest, and still not a refetch.
    return { action: 'expired', storedAt: row.created_at };
  }
  // Serve the artefact verbatim. _stored/_storedAt let the page render the "as at" line; the ?mileage
  // on the re-open request is deliberately ignored — the served verdict is part of what was bought.
  return { action: 'serve', payload: { ...row.payload, _stored: true, _storedAt: row.created_at } };
}

// DB read → decision. Never throws; a missing table or any error degrades to 'proceed'.
export async function readStoredReport(supabase, sessionId, cleanVrm, nowMs = Date.now()) {
  if (!supabase || !sessionId) return { action: 'proceed' };
  try {
    const { data, error } = await supabase
      .from('paid_reports')
      .select('vrm, payload, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) {
      console.error(`[STORED REPORT] read failed (degrading to fresh view): ${error.code || ''} ${error.message || error}`);
      return { action: 'proceed' };
    }
    return decideStoredReport(data, cleanVrm, nowMs);
  } catch (err) {
    console.error('[STORED REPORT] read exception (degrading to fresh view):', err?.message || err);
    return { action: 'proceed' };
  }
}

// DB write of the served artefact. Never throws, never blocks the response — a failure is logged and
// the customer still gets their report (they lose only the 10-minute re-open safety net, not the goods).
export async function writeStoredReport(supabase, { sessionId, vrm, checks, market, payload }) {
  if (!supabase || !sessionId || !payload) return false;
  try {
    const { error } = await supabase
      .from('paid_reports')
      .upsert(
        {
          session_id: sessionId,
          vrm: (vrm || '').toUpperCase(),
          checks: Array.isArray(checks) ? checks.join(',') : (checks || ''),
          market: market || 'GB',
          payload,
          created_at: new Date().toISOString(),
        },
        { onConflict: 'session_id' }
      );
    if (error) {
      console.error(`[STORED REPORT] write failed (report still served): ${error.code || ''} ${error.message || error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[STORED REPORT] write exception (report still served):', err?.message || err);
    return false;
  }
}
