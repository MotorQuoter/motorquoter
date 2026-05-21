import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function logEvent(event_type, { vrm, tier, market, stripe_session_id, metadata } = {}) {
  await supabase.from('events').insert({
    event_type,
    vrm: vrm ? vrm.toUpperCase() : null,
    tier,
    market,
    stripe_session_id,
    metadata,
  });
}
