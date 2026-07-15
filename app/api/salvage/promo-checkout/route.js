import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { vehicleDetails, imagePaths, market, roiTier, promoCode, free_report_token } = body;

    // Two credentials feed this single owner of free-session creation: a promo_codes code, or a
    // free-report token (Commit 3). Exactly one is required.
    if (!promoCode && !free_report_token) {
      return NextResponse.json({ error: 'Promo code or free-report token required' }, { status: 400 });
    }
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }
    if (imagePaths.length > 35) {
      return NextResponse.json({ error: 'Maximum 35 images allowed' }, { status: 400 });
    }

    const _ta = (vehicleDetails || {}).typeApproval;
    if (!_ta || !['M1', 'N1', 'M2'].includes(_ta)) {
      return NextResponse.json({ error: 'Vehicle type not supported' }, { status: 400 });
    }

    const supabase = getSupabase();
    let payment_kind;

    if (free_report_token) {
      // Free-report credential (Commit 3). Atomic consume is the race-safe gate: the single-use
      // token + `consumed_at IS NULL` filter means a concurrent second consume matches 0 rows and
      // is rejected — same discipline as the promo_codes uses_so_far claim. Consume WITHOUT
      // session_id first (the FK target does not exist yet); it is backfilled after the insert.
      const { data: consumed } = await supabase
        .from('free_report_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('token', free_report_token)
        .is('consumed_at', null)
        .select('id')
        .maybeSingle();
      if (!consumed) {
        return NextResponse.json({ error: 'This free report has already been used.' }, { status: 403 });
      }
      payment_kind = 'free_report';
    } else {
      const code = promoCode.trim().toUpperCase();

      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', code)
        .eq('active', true)
        .maybeSingle();

      if (!promo) return NextResponse.json({ error: 'Invalid promo code' }, { status: 400 });
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return NextResponse.json({ error: 'Promo code has expired' }, { status: 400 });
      }
      if (promo.max_uses !== null && promo.uses_so_far >= promo.max_uses) {
        return NextResponse.json({ error: 'Promo code has no uses remaining' }, { status: 400 });
      }
      if (promo.discount_type !== 'free') {
        return NextResponse.json({ error: 'This endpoint is for free codes only' }, { status: 400 });
      }
      if (promo.allowed_products && !promo.allowed_products.includes('salvage')) {
        return NextResponse.json({ error: 'This code is not valid for this product' }, { status: 400 });
      }

      // Atomic conditional increment using optimistic concurrency.
      // For limited codes the WHERE clause pins the value we read; if another concurrent request
      // already incremented, the update matches 0 rows → we reject rather than double-counting.
      if (promo.max_uses !== null) {
        const { data: claimed } = await supabase
          .from('promo_codes')
          .update({ uses_so_far: promo.uses_so_far + 1 })
          .eq('code', code)
          .eq('active', true)
          .eq('uses_so_far', promo.uses_so_far)
          .select('code')
          .maybeSingle();
        if (!claimed) {
          return NextResponse.json({ error: 'Promo code has no uses remaining' }, { status: 400 });
        }
      } else {
        await supabase
          .from('promo_codes')
          .update({ uses_so_far: promo.uses_so_far + 1 })
          .eq('code', code);
      }
      payment_kind = 'promo';
    }

    const promoToken = randomUUID();
    const roiTierKey = market === 'IE' ? (roiTier || 'roi_free') : null;

    const { data: session, error: dbError } = await supabase
      .from('salvage_sessions')
      .insert({
        status: 'promo_redeemed',
        payment_kind,
        vehicle_details: { ...(vehicleDetails || {}), roiTier: roiTierKey, promoToken },
        image_paths: imagePaths,
        market: market || 'GB',
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Roll back a consumed free-report token so a failed insert never burns the user's one report.
      if (free_report_token) {
        await supabase.from('free_report_tokens').update({ consumed_at: null }).eq('token', free_report_token);
      }
      return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
    }

    // Link the free-report token to its session (the FK target now exists).
    if (free_report_token) {
      await supabase.from('free_report_tokens').update({ session_id: session.id }).eq('token', free_report_token);
    }

    return NextResponse.json({ salvage_id: session.id, promoToken });
  } catch (err) {
    console.error('Promo checkout error:', err);
    return NextResponse.json({ error: err.message || 'Promo checkout failed' }, { status: 500 });
  }
}
