import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only N1-resolving values are accepted — matches the success-page picklist exactly.
// People carrier / Minibus are intentionally excluded: they don't resolve N1 UNRESOLVED
// (no regex match in _classifyBodyString) and would loop back to the same error.
const VALID_BODY_STYLES = new Set([
  'Panel van', 'Crew van', 'Pickup', 'Luton van', 'Dropside tipper flatbed',
]);

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { salvage_id, body_style, session_id, promo_token } = body;

  if (!salvage_id || !UUID_RE.test(String(salvage_id))) {
    return NextResponse.json({ error: 'Missing or invalid salvage_id' }, { status: 400 });
  }
  if (!body_style || !VALID_BODY_STYLES.has(body_style)) {
    return NextResponse.json({ error: 'Invalid body_style value' }, { status: 400 });
  }
  if (!session_id && !promo_token) {
    return NextResponse.json({ error: 'Missing payment token' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: session, error: fetchErr } = await supabase
    .from('salvage_sessions')
    .select('stripe_session_id, vehicle_details, status')
    .eq('id', salvage_id)
    .single();

  if (fetchErr || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Ownership: same pattern as the rerun endpoint — compare stored credentials directly.
  // No live Stripe call needed: if the stored stripe_session_id matches, payment was already
  // verified when the assess route first ran this session.
  const ownsViaStripe = session_id && session.stripe_session_id && session.stripe_session_id === session_id;
  const ownsViaPromo  = promo_token && session.vehicle_details?.promoToken && session.vehicle_details.promoToken === promo_token;
  if (!ownsViaStripe && !ownsViaPromo) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });
  }

  const { error: updateErr } = await supabase
    .from('salvage_sessions')
    .update({
      vehicle_details: {
        ...session.vehicle_details,
        bodyStyle: body_style,
      },
    })
    .eq('id', salvage_id);

  if (updateErr) {
    return NextResponse.json({ error: 'Failed to patch body type' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
