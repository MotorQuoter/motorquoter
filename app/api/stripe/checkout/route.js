import { NextResponse } from 'next/server';
import Stripe from 'stripe';

const TIER_PRICES = {
  standard: { amount: 499, label: 'Standard Check — Valuation & AutoCheck' },
  pro: { amount: 1299, label: 'Pro Check — Full Vehicle Intelligence' },
};

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { vrm, tier, mileage, market } = await request.json();

    if (!vrm || !tier || !TIER_PRICES[tier]) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const price = TIER_PRICES[tier];
    const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.vercel.app');

    // Build success URL — {CHECKOUT_SESSION_ID} is replaced by Stripe automatically
    // Must NOT be URL-encoded, so we build it as a plain string
    const successUrl = `${baseUrl}/payment-success?vrm=${cleanVrm}&tier=${tier}&mileage=${mileage || ''}&market=${market || 'GB'}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/?cancelled=true`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `MotorQuoter ${tier.charAt(0).toUpperCase() + tier.slice(1)} Check`,
              description: `${price.label} — ${cleanVrm}`,
            },
            unit_amount: price.amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        vrm: cleanVrm,
        tier,
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