// The single choke point for every One Auto API call (feat/oneauto-fetch, batch 37).
//
// Before this, ONE_AUTO_BASE and oneAutoHeaders were each defined TWICE (vehicle/route.js +
// vehicle-image/route.js) and ~20 bare fetch() sites hit One Auto directly — so nothing could count
// our supplier calls, because nothing they all pass through existed (§7 part-2's structural blocker).
// One base, one header, one fetch. Commit 2 wraps a per-call LOG around oneAutoFetch — and only a
// count: this file produces call COUNTS, never COSTS. A count against a list price is still a list
// price; the invoice rate is Vincent's to pull.
//
// (CARTELL_BASE was here and dead — defined but never in a fetch; cartell/vehiclehistorycheck builds
// from ONE_AUTO_BASE. Removed batch 39 §5. If a sandbox Cartell base is ever needed, add it back at
// its real call site, not as an orphan.)

import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';

export const ONE_AUTO_BASE = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
export const oneAutoHeaders = () => ({ 'x-api-key': process.env.ONE_AUTO_API_KEY });

// ── Per-request call log (commit 2) ───────────────────────────────────────────────────────────────
// A basket fires up to ~14 supplier calls. Writing one Supabase row PER call would be N awaited writes
// on a paying customer's request (Vercel freezes post-response work, so they cannot be safely
// deferred). Instead each request COLLECTS its calls in memory via AsyncLocalStorage — request-scoped
// with no threading through the 18 call sites and no cross-request contamination — and flushes ONE row
// via after(). This records call COUNTS + latency, never a cost: the rate is Vincent's invoice to pull.
const oneAutoLogStore = new AsyncLocalStorage();

// Run fn with a fresh per-request collector; returns { result, calls }. The route flushes `calls` once.
export async function withOneAutoLog(fn) {
  const collector = { calls: [] };
  const result = await oneAutoLogStore.run(collector, fn);
  return { result, calls: collector.calls };
}

// One buffered write for the whole request. Non-fatal — the log must never affect the response.
export async function flushOneAutoLog(calls, sessionId) {
  if (!Array.isArray(calls) || calls.length === 0) return;
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await supabase.from('oneauto_call_log').insert({
      session_id: sessionId ?? null,
      vrm: calls.find(c => c.vrm)?.vrm ?? null,
      call_count: calls.length,
      calls,   // jsonb: [{ endpoint, vrm, ok, ms, ts }] — counts + latency, NO cost
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[ONEAUTO LOG] flush failed (non-fatal):', err?.message || err);
  }
}

/**
 * oneAutoFetch — every One Auto request goes through here.
 * @param {string} target  a RELATIVE path with its query already built (byte-identical to the old
 *   `${ONE_AUTO_BASE}/…` template), OR an ABSOLUTE url (the polling path already has one in hand).
 * @param {object} [opts]  fetch init; `base` overrides ONE_AUTO_BASE for a relative target; if the
 *   caller already set `headers` (the polling callers do) they are kept, else the One Auto key header
 *   is added. Returns the raw Response, exactly as `fetch` did — no body/status/shape change. When a
 *   request-scoped log is active it records { endpoint, vrm, ok, ms } for this call; otherwise it is a
 *   plain fetch (tests, un-wrapped callers) — the request itself is identical either way.
 */
export async function oneAutoFetch(target, opts = {}) {
  const { base = ONE_AUTO_BASE, headers, ...init } = opts;
  const url = /^https?:\/\//.test(target) ? target : `${base}/${target}`;
  const store = oneAutoLogStore.getStore();
  if (!store) return fetch(url, { headers: headers ?? oneAutoHeaders(), ...init });
  const started = Date.now();
  let ok = false;
  try {
    const res = await fetch(url, { headers: headers ?? oneAutoHeaders(), ...init });
    ok = res.ok;
    return res;
  } finally {
    let endpoint = target, vrm = null;
    try {
      const u = new URL(url);
      endpoint = u.pathname.replace(/^\//, '');
      vrm = u.searchParams.get('vehicle_registration_mark') || u.searchParams.get('vrm') || u.searchParams.get('vehicle_identification_number') || null;
    } catch { /* keep the raw target on a parse failure */ }
    store.calls.push({ endpoint, vrm, ok, ms: Date.now() - started, ts: new Date().toISOString() });
  }
}
