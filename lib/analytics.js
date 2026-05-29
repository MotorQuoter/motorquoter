import { createClient } from '@supabase/supabase-js';

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

export async function logEvent(event_type, { vrm, tier, market, stripe_session_id, metadata, promo_code } = {}) {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from('events').insert({
    event_type,
    vrm: vrm ? vrm.toUpperCase() : null,
    tier,
    market,
    stripe_session_id,
    metadata,
    promo_code: promo_code || null,
  });
  if (error) console.error('Analytics insert failed:', error);
}
