import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { PRICING } from '@/config/pricing';

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vrm, checks, mileage, market } = await request.json();

    if (!vrm || !Array.isArray(checks) || checks.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');

    // Resolve prices server-side — client cannot spoof amounts
    const menuMap = Object.fromEntries(PRICING.menu.map(i => [i.key, i]));
    const lineItems = checks
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
      price_data: {
        currency: 'gbp',
        product_data: { name: 'Service fee' },
        unit_amount: 25,
      },
      quantity: 1,
    });

    const checksStr = checks.join(',');
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.vercel.app');

    const successUrl = `${baseUrl}/payment-success?vrm=${cleanVrm}&checks=${checksStr}&mileage=${mileage || ''}&market=${market || 'GB'}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/?cancelled=true`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        vrm: cleanVrm,
        checks: checksStr,
        mileage: mileage || '',
        market: market || 'GB',
      },
    });

    return NextResponse.json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}
