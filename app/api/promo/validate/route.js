import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawCode = searchParams.get('code');

  if (!rawCode) {
    return NextResponse.json({ valid: false, error: 'No code provided' }, { status: 400 });
  }

  const code = rawCode.trim().toUpperCase();
  const supabase = getSupabase();

  const { data: promo } = await supabase
    .from('promo_codes')
    .select('code, discount_type, discount_value, max_uses, uses_so_far, expires_at, active, allowed_products')
    .eq('code', code)
    .eq('active', true)
    .maybeSingle();

  if (!promo) {
    return NextResponse.json({ valid: false, error: 'Invalid promo code' });
  }

  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return NextResponse.json({ valid: false, error: 'Promo code has expired' });
  }

  if (promo.max_uses !== null && promo.uses_so_far >= promo.max_uses) {
    return NextResponse.json({ valid: false, error: 'Promo code has no uses remaining' });
  }

  return NextResponse.json({
    valid: true,
    discount_type: promo.discount_type,
    discount_value: promo.discount_value,
    allowed_products: promo.allowed_products ?? null,
  });
}
