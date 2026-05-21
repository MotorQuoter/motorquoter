import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logEvent } from '@/lib/analytics';

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

  const { vrm, checks, mileage, market, roiTier, promo_code } = body;

  if (!vrm || !promo_code) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const code = promo_code.trim().toUpperCase();
  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
  const supabase = getSupabase();

  // Re-validate server-side
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

  // Increment uses_so_far
  await supabase
    .from('promo_codes')
    .update({ uses_so_far: promo.uses_so_far + 1 })
    .eq('code', code);

  // Create redeemed session token — generate UUID here so we never need to read it back
  const token = randomUUID();
  const checksStr = Array.isArray(checks) ? checks.join(',') : (checks || '');
  const { error: sessionError } = await supabase
    .from('redeemed_sessions')
    .insert({
      id: token,
      token: token,
      vrm: cleanVrm,
      checks: checksStr,
      mileage: mileage || '',
      market: market || 'GB',
      roi_tier: roiTier || null,
      promo_code: code,
    });

  if (sessionError) {
    console.error('redeemed_sessions insert error:', sessionError);
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }

  logEvent('payment_completed', {
    vrm: cleanVrm,
    tier: checksStr || roiTier || '',
    market: market || 'GB',
    stripe_session_id: token,
    promo_code: code,
  });

  return NextResponse.json({ token });
}
