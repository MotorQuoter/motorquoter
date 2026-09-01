import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { salvage_id, session_id, promo_token } = body;
  if (!salvage_id || !UUID_RE.test(String(salvage_id))) {
    return NextResponse.json({ error: 'Missing or invalid salvage_id' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('salvage_sessions')
    .select('rerun_count, assessment, stripe_session_id, vehicle_details')
    .eq('id', salvage_id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Ownership: caller must supply a credential that matches the stored session record
  const ownsViaStripe = session_id && data.stripe_session_id && data.stripe_session_id === session_id;
  const ownsViaPromo  = promo_token && data.vehicle_details?.promoToken && data.vehicle_details.promoToken === promo_token;
  if (!ownsViaStripe && !ownsViaPromo) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });
  }

  const currentCount = data.rerun_count ?? 0;
  if (currentCount >= 1) return NextResponse.json({ error: 'Re-run limit reached' }, { status: 403 });

  // Batch 103 §1 (Vincent): the free re-run must STOP destroying the paid report. Preserve the
  // assessment the buyer paid for into prior_assessment before blanking `assessment` for the
  // re-run. data.assessment is already in hand from the select above — no extra read.
  // Guard: if the current assessment is null (e.g. a prior aborted re-run left it blank), do NOT
  // overwrite an already-populated prior_assessment with null — keep the last good report.
  const update = { assessment: null, status: 'pending', rerun_count: currentCount + 1 };
  if (data.assessment != null) update.prior_assessment = data.assessment;

  await supabase
    .from('salvage_sessions')
    .update(update)
    .eq('id', salvage_id);

  return NextResponse.json({ success: true });
}
