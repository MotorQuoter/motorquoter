import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// batch 225 — is this free-report token still usable? Read only: one select of consumed_at from free_report_tokens,
// no writes, never the email. /salvage calls it once on load so a used or unknown token is caught before any upload.
// Checkout's atomic consume (promo-checkout) stays the final gate.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  if (!UUID.test(token)) return NextResponse.json({ state: 'unknown' });

  const { data, error } = await getSupabase().from('free_report_tokens')
    .select('consumed_at').eq('token', token).maybeSingle();
  if (error) {
    console.error('[FREE REPORT] status lookup failed:', JSON.stringify(error));
    return NextResponse.json({ error: 'status unavailable' }, { status: 500 }); // the page leaves the token in place
  }
  return NextResponse.json({ state: !data ? 'unknown' : data.consumed_at ? 'used' : 'unused' });
}
