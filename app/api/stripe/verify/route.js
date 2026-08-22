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
    const { data: session, error: sessionError } = await supabase
      .from('redeemed_sessions')
      .select('*')
      .eq('token', sessionId)
      .eq('used', false)
      .maybeSingle();

    const redeemed = session;

    if (!redeemed) {
      return NextResponse.json({ error: 'Invalid or already used session' }, { status: 403 });
    }

    await supabase
      .from('redeemed_sessions')
      .update({ used: true })
      .eq('token', sessionId);

    return NextResponse.json({
      paid:            true,
      checks:          redeemed.checks ? redeemed.checks.split(',') : [],
      vrm:             redeemed.vrm      || null,
      market:          redeemed.market   || 'GB',
      roiTier:         redeemed.roi_tier || null,
      paymentIntentId: null,
    });
  }

  // ── Stripe path ──────────────────────────────────────────────────────────────
  // verify is NO LONGER a report-access gate. Its old 403-on-second-call is exactly what told a
  // paying customer "payment could not be verified" the moment they refreshed (BUILD_StoredReports
  // §2.3). Report access is decided in ONE place now — /api/vehicle, stored-vs-fresh. Here, a genuinely
  // paid session ALWAYS returns its checks/vrm/market, whether or not it has been seen before.
  //
  // used_sessions is KEPT for the one thing it is actually needed for: counting a promo redemption
  // exactly once. The insert is the atomic once-guard — a clean insert means "first time, do the
  // increment"; a 23505 conflict means "already counted, skip it" (a repeat open must not re-increment).
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === 'paid';

    if (!paid) {
      return NextResponse.json({ paid: false });
    }

    // Claim the once-guard. Only a CLEAN insert (no error) is a first redemption → increment. A 23505
    // (already present) or any other error → do NOT increment, but still return the paid report.
    let firstRedemption = false;
    try {
      const { error: insertError } = await supabase
        .from('used_sessions')
        .insert({ session_id: sessionId });
      if (!insertError) {
        firstRedemption = true;
      } else if (insertError.code !== '23505') {
        console.error('used_sessions insert error (promo increment skipped, report still served):', insertError);
      }
    } catch (insertErr) {
      console.error('used_sessions insert exception (promo increment skipped, report still served):', insertErr);
    }

    // Increment uses_so_far for a non-free promo code — ONCE per session, on the first redemption only.
    const promoCode = session.metadata?.promo_code;
    if (promoCode && firstRedemption) {
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
      paid:            true,
      checks:          session.metadata?.checks ? session.metadata.checks.split(',') : [],
      vrm:             session.metadata?.vrm     || null,
      market:          session.metadata?.market  || 'GB',
      roiTier:         session.metadata?.roiTier || null,
      paymentIntentId: session.payment_intent ?? null,
    });
  } catch (err) {
    console.error('Stripe verify error:', err);
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}
