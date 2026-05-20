import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.json({ paid: false, error: 'No session ID' }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('used_sessions')
    .select('session_id')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'This payment link has already been used' }, { status: 403 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid';

    if (!paid) {
      return NextResponse.json({ paid: false });
    }

    // Insert with conflict check — guards against two simultaneous requests racing through the check above
    try {
      const { error: insertError } = await supabase
        .from('used_sessions')
        .insert({ session_id: sessionId });

      if (insertError?.code === '23505') {
        return NextResponse.json({ error: 'This payment link has already been used' }, { status: 403 });
      }
      if (insertError) {
        console.error('used_sessions insert error:', insertError);
      }
    } catch (insertErr) {
      console.error('used_sessions insert exception:', insertErr);
    }

    return NextResponse.json({
      paid: true,
      checks: session.metadata?.checks || '',
      vrm: session.metadata?.vrm || null,
      market: session.metadata?.market || 'GB',
      roiTier: session.metadata?.roiTier || null,
    });
  } catch (err) {
    console.error('Stripe verify error:', err);
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}
