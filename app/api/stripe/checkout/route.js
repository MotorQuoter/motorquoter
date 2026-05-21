import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { PRICING, IE_MENU } from '@/config/pricing';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function validatePromoServer(supabase, code) {
  if (!code) return null;
  const { data: promo } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('active', true)
    .maybeSingle();
  if (!promo) return null;
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return null;
  if (promo.max_uses !== null && promo.uses_so_far >= promo.max_uses) return null;
  return promo;
}

function applyDiscountPence(totalPence, promo) {
  if (promo.discount_type === 'percent') {
    return Math.round(totalPence * (1 - Number(promo.discount_value) / 100));
  }
  if (promo.discount_type === 'fixed') {
    return Math.max(0, totalPence - Math.round(Number(promo.discount_value) * 100));
  }
  return totalPence;
}

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vrm, checks, mileage, market, promoCode } = await request.json();

    if (!vrm) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');

    if (!Array.isArray(checks) || checks.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // Resolve prices server-side — client cannot spoof amounts
    const allMenuItems = [...PRICING.menu, ...IE_MENU];
    const menuMap = Object.fromEntries(allMenuItems.map(i => [i.key, i]));
    let lineItems = checks
      .filter(key => menuMap[key] && menuMap[key].enabled && menuMap[key].price > 0)
      .map(key => ({
        price_data: {
          currency: 'gbp',
          product_data: { name: menuMap[key].label },
          unit_amount: Math.round(menuMap[key].price * 100),
        },
        quantity: 1,
      }));

    if (lineItems.length === 0) {
      return NextResponse.json({ error: 'No paid items selected' }, { status: 400 });
    }

    // Always add 25p service fee to cover payment processing on small baskets
    lineItems.push({
      price_data: { currency: 'gbp', product_data: { name: 'Service fee' }, unit_amount: 25 },
      quantity: 1,
    });

    const gbMetadata = {
      vrm: cleanVrm,
      checks: checks.join(','),
      mileage: mileage || '',
      market: market || 'GB',
    };

    if (promoCode) {
      const supabase = getSupabase();
      const promo = await validatePromoServer(supabase, promoCode);
      if (promo && promo.discount_type !== 'free') {
        const originalPence = lineItems.reduce((s, i) => s + i.price_data.unit_amount, 0);
        const discountedPence = applyDiscountPence(originalPence, promo);
        lineItems = [{
          price_data: {
            currency: 'gbp',
            product_data: { name: 'Vehicle Report' },
            unit_amount: Math.max(30, discountedPence),
          },
          quantity: 1,
        }];
        gbMetadata.promo_code = promo.code;
      }
    }

    const checksStr = checks.join(',');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${baseUrl}/payment-success?vrm=${cleanVrm}&checks=${checksStr}&mileage=${mileage || ''}&market=${market || 'GB'}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?cancelled=true`,
      metadata: gbMetadata,
    });

    return NextResponse.json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}
