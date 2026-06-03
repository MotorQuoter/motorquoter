import { createClient } from '@supabase/supabase-js';

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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
export async function withOneAutoCache(callType, reg, fetchFn) {
  const key = `${callType}:${reg.replace(/\s+/g, '').toUpperCase()}`;
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
