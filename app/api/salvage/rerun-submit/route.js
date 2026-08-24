import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  const body = await request.json();
  const { salvage_id, session_id, promo_token, vehicleDetails, imagePaths, market } = body;

  if (!salvage_id || !imagePaths?.length) {
    return NextResponse.json({ error: 'Missing salvage_id or image paths' }, { status: 400 });
  }
  if (imagePaths.length > 35) {
    return NextResponse.json({ error: 'Maximum 35 images allowed' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: session, error } = await supabase
    .from('salvage_sessions')
    .select('rerun_count, stripe_session_id, status, vehicle_details')
    .eq('id', salvage_id)
    .single();

  if (error || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Ownership — caller must supply a credential that matches the stored record. salvage_id alone is
  // NOT proof: it is in the success_url (salvage/checkout:135), so it travels in the address bar and
  // any forwarded link. Without this, anyone with the link could overwrite another customer's images
  // and vehicle_details and reset their assessment. Copied from the sibling rerun/route.js:36-41.
  const ownsViaStripe = session_id && session.stripe_session_id && session.stripe_session_id === session_id;
  const ownsViaPromo  = promo_token && session.vehicle_details?.promoToken && session.vehicle_details.promoToken === promo_token;
  if (!ownsViaStripe && !ownsViaPromo) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });
  }

  if ((session.rerun_count ?? 0) < 1) {
    return NextResponse.json({ error: 'Re-run not authorised — use /api/salvage/rerun first' }, { status: 403 });
  }

  // Bound the re-assessment loop. rerun/route.js increments rerun_count to authorise ONE re-run and
  // leaves status 'pending'; this route never increments it, so `rerun_count >= 1` alone would stay
  // satisfied forever — a paid session could be re-submitted (and re-assessed, ~£1.79 One Auto + model
  // each) without limit, and auto top-up means it no longer self-limits. A re-submit is only valid
  // while the authorised re-run is still pending re-assessment; once assess advances the status it
  // cannot be replayed.
  if (session.status !== 'pending') {
    return NextResponse.json({ error: 'Re-run already used for this assessment' }, { status: 409 });
  }

  const isPromo  = !!session.vehicle_details?.promoToken;

  const { error: updateError } = await supabase
    .from('salvage_sessions')
    .update({
      image_paths: imagePaths,
      vehicle_details: {
        ...(vehicleDetails || {}),
        // Carry forward the immutable original paste (write-once): the stored value wins over
        // a possibly paste-less rerun form. A rerun re-derives the whole Copart block from it
        // via normaliseLot — it must NOT be replaced/discarded by the form submit.
        rawCopartPaste: (session.vehicle_details?.rawCopartPaste || vehicleDetails?.rawCopartPaste) || null,
        ...(session.vehicle_details?.promoToken && { promoToken: session.vehicle_details.promoToken }),
      },
      market: market || 'GB',
      assessment: null,
      status: 'pending',
    })
    .eq('id', salvage_id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }

  return NextResponse.json(
    isPromo
      ? { salvage_id, promoToken: session.vehicle_details.promoToken }
      : { salvage_id, stripe_session_id: session.stripe_session_id }
  );
}
