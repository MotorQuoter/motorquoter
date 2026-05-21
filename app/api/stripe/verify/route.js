import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { logEvent } from '@/lib/analytics';

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
  const isFree    = searchParams.get('free') === 'true';

  if (!sessionId) {
    return NextResponse.json({ paid: false, error: 'No session ID' }, { status: 400 });
  }

  const supabase = getSupabase();

  // ── Free promo path ──────────────────────────────────────────────────────────
  if (isFree) {
    const { data: redeemed } = await supabase
      .from('redeemed_sessions')
      .select('*')
      .eq('token', sessionId)
      .eq('used', false)
      .maybeSingle();

    if (!redeemed) {
      return NextResponse.json({ error: 'Invalid or already used session' }, { status: 403 });
    }

    await supabase
      .from('redeemed_sessions')
      .update({ used: true })
      .eq('token', sessionId);

    return NextResponse.json({
      paid:    true,
      checks:  redeemed.checks   || '',
      vrm:     redeemed.vrm      || null,
      market:  redeemed.market   || 'GB',
      roiTier: redeemed.roi_tier || null,
    });
  }

  // ── Stripe path ──────────────────────────────────────────────────────────────
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

    // Increment uses_so_far for any non-free promo code used at checkout
    const promoCode = session.metadata?.promo_code;
    if (promoCode) {
      supabase
        .from('promo_codes')
        .select('uses_so_far')
        .eq('code', promoCode)
        .single()
        .then(({ data: p }) => {
          if (p) {
            return supabase
              .from('promo_codes')
              .update({ uses_so_far: (p.uses_so_far || 0) + 1 })
              .eq('code', promoCode);
          }
        })
        .catch(() => {});
    }

    logEvent('payment_completed', {
      vrm: session.metadata?.vrm || '',
      tier: session.metadata?.roiTier || session.metadata?.checks || '',
      market: session.metadata?.market || 'GB',
      stripe_session_id: session.id,
      promo_code: promoCode || null,
    });

    return NextResponse.json({
      paid:    true,
      checks:  session.metadata?.checks  || '',
      vrm:     session.metadata?.vrm     || null,
      market:  session.metadata?.market  || 'GB',
      roiTier: session.metadata?.roiTier || null,
    });
  } catch (err) {
    console.error('Stripe verify error:', err);
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}
