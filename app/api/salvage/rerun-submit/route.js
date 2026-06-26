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
  const { salvage_id, vehicleDetails, imagePaths, market } = body;

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

  if ((session.rerun_count ?? 0) < 1) {
    return NextResponse.json({ error: 'Re-run not authorised — use /api/salvage/rerun first' }, { status: 403 });
  }

  const isStripe = !!session.stripe_session_id;
  const isPromo  = !!session.vehicle_details?.promoToken;
  if (!isStripe && !isPromo) {
    return NextResponse.json({ error: 'No payment session on record' }, { status: 400 });
  }

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
