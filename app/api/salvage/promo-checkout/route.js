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

    const { vehicleDetails, images, market, roiTier, promoCode } = body;

    if (!promoCode) {
      return NextResponse.json({ error: 'Promo code required' }, { status: 400 });
    }
    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }
    if (images.length > 20) {
      return NextResponse.json({ error: 'Maximum 20 images allowed' }, { status: 400 });
    }

    const code = promoCode.trim().toUpperCase();
    const supabase = getSupabase();

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

    // Increment uses immediately — before session creation to prevent double-use on retry
    await supabase
      .from('promo_codes')
      .update({ uses_so_far: promo.uses_so_far + 1 })
      .eq('code', code);

    const promoToken = randomUUID();
    const roiTierKey = market === 'IE' ? (roiTier || 'roi_free') : null;

    const { data: session, error: dbError } = await supabase
      .from('salvage_sessions')
      .insert({
        status: 'promo_redeemed',
        vehicle_details: { ...(vehicleDetails || {}), roiTier: roiTierKey, promoToken },
        images,
        market: market || 'GB',
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
    }

    return NextResponse.json({ salvage_id: session.id, promoToken });
  } catch (err) {
    console.error('Promo checkout error:', err);
    return NextResponse.json({ error: err.message || 'Promo checkout failed' }, { status: 500 });
  }
}
