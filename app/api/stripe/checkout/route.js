import { NextResponse } from 'next/server';
import Stripe from 'stripe';



// Prices in pence
const TIER_PRICES = {
  standard: { amount: 199, label: 'Standard Check — Valuation & AutoCheck' },
  pro: { amount: 699, label: 'Pro Check — Full Vehicle Intelligence' },
};

export async function POST(request) {
  
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { vrm, tier, mileage, market } = await request.json();
    

    if (!vrm || !tier || !TIER_PRICES[tier]) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const price = TIER_PRICES[tier];
    const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');

    // Build success URL — includes lookup params so the success page can fetch the result
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://motorquoter.vercel.app';
    const successParams = new URLSearchParams({
      vrm: cleanVrm,
      tier,
      mileage: mileage || '',
      market: market || 'GB',
      session_id: '{CHECKOUT_SESSION_ID}' // Stripe replaces this token automatically
    });

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
      success_url: `${baseUrl}/payment-success?${successParams}`,
      cancel_url: `${baseUrl}/?cancelled=true`,
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