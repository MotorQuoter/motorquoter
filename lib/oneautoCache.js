import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Finding 7 (audit): the cache key must include the parameters that vary the response, not just
// callType:reg. SALVAGEGUIDE keys on salvage_category / current_mileage / primary_damage_desc and
// BREGO_GB on current_mileage — none of which were in the key, so a re-listed VRM (Cat N → Cat S)
// served the stale Cat-N bid prediction for the rest of the 30-day TTL. A stable hash of the sorted,
// non-empty param entries becomes a key suffix; EMPTY params yield NO suffix, so param-free callers
// (SALVAGEHISTORY, BREGO_ROI, MARKETDEMAND, …) keep their existing keys unchanged. The hash lives in
// the shared helper — not munged into callType at each call site — so a future caller that passes a
// new param is protected by construction.
export function oneAutoCacheKey(callType, normReg, params) {
  const base = `${callType}:${normReg}`;
  const entries = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return base;
  const canon = entries.map(([k, v]) => `${k}=${v}`).join('&');
  return `${base}:${createHash('sha1').update(canon).digest('hex').slice(0, 12)}`;
}

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// --- Replay-harness seam (Cowork §7/§8) --------------------------------------------------------
// PROD-INERT by construction: the override is only ever set by scripts/replay.mjs, which the app
// never imports — so in production `_replayProvider` is always null and withOneAutoCache runs
// exactly as before (the guard below is a never-taken branch). When a replay registers a provider,
// every One Auto call returns a stored fixture with ZERO DB reads/writes and ZERO paid provider
// calls — the replay guarantee: no re-charge, no prod DB write. Signature mirrors the cache: it
// receives (callType, normalisedReg) and returns the fixture object or null (null = "no data",
// handled identically to a live empty response).
let _replayProvider = null;
export function __setOneAutoReplayProvider(fn) { _replayProvider = fn; }

/**
 * Read-through cache for a single One Auto API call.
 *
 * @param {string} callType  e.g. 'BREGO_GB', 'SALVAGEHISTORY'
 * @param {string} reg       raw VRM — normalised internally
 * @param {() => Promise<object|null>} fetchFn
 *   Must return the extracted result object on success, or null to signal
 *   an error/empty response.  null results are never cached.
 * @returns {Promise<object|null>}
 */
export async function withOneAutoCache(callType, reg, paramsOrFetch, maybeFetch) {
  // Overload for backward compatibility: legacy callers pass (callType, reg, fetchFn) with no varying
  // params; param-bearing callers pass (callType, reg, params, fetchFn). A function in the 3rd slot is
  // the legacy shape.
  const params  = typeof paramsOrFetch === 'function' ? {} : (paramsOrFetch || {});
  const fetchFn = typeof paramsOrFetch === 'function' ? paramsOrFetch : maybeFetch;
  const normReg = reg.replace(/\s+/g, '').toUpperCase();
  if (_replayProvider) return _replayProvider(callType, normReg);   // replay-only; null in prod
  const key = oneAutoCacheKey(callType, normReg, params);
  const client = db();

  // 1. Unexpired hit
  try {
    const { data, error } = await client
      .from('oneauto_cache')
      .select('payload')
      .eq('cache_key', key)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!error && data?.payload) {
      console.log(`[ONEAUTO CACHE] ${key} HIT`);
      return data.payload;
    }
  } catch (readErr) {
    console.warn(`[ONEAUTO CACHE] ${key} read error (falling through to live):`, readErr.message);
  }

  // 2. Miss — live fetch
  console.log(`[ONEAUTO CACHE] ${key} MISS->fetch`);
  let liveResult = null;
  let liveFailed = false;
  try {
    liveResult = await fetchFn();
  } catch (fetchErr) {
    liveFailed = true;
    console.warn(`[ONEAUTO CACHE] ${key} live fetch threw:`, fetchErr.message);
  }

  if (!liveFailed && liveResult != null) {
    // Store only complete successful responses
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_MS);
    try {
      await client.from('oneauto_cache').upsert(
        { cache_key: key, payload: liveResult, created_at: now.toISOString(), expires_at: expiresAt.toISOString() },
        { onConflict: 'cache_key' }
      );
    } catch (writeErr) {
      console.warn(`[ONEAUTO CACHE] ${key} write error (non-fatal):`, writeErr.message);
    }
    return liveResult;
  }

  // 3. Live failed — stale-on-error fallback (serve expired entry if present)
  try {
    const { data, error } = await client
      .from('oneauto_cache')
      .select('payload')
      .eq('cache_key', key)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data?.payload) {
      console.log(`[ONEAUTO CACHE] ${key} STALE-SERVED (live failed)`);
      return data.payload;
    }
  } catch (staleErr) {
    console.warn(`[ONEAUTO CACHE] ${key} stale read error:`, staleErr.message);
  }

  return null;
}
