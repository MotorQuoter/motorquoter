import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { PRICING } from '@/config/pricing';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const { vehicleDetails, images, market } = await request.json();

    if (!Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }
    if (images.length > 20) {
      return NextResponse.json({ error: 'Maximum 20 images allowed' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: session, error: dbError } = await supabase
      .from('salvage_sessions')
      .insert({
        status: 'pending_payment',
        vehicle_details: vehicleDetails || {},
        images,
        market: market || 'GB',
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return NextResponse.json({ error: 'Failed to store session' }, { status: 500 });
    }

    const salvageId = session.id;
    const price = PRICING.salvageAssessment.price;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.vercel.app');

    const vd = vehicleDetails || {};
    const identifier = vd.vrm || vd.lotNumber || [vd.make, vd.model, vd.year].filter(Boolean).join(' ') || '';

    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'MotorQuoter Damage Assessment',
            description: identifier ? `Assessment for ${identifier}` : 'AI-powered salvage & damage assessment',
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/salvage/success?salvage_id=${salvageId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/salvage?cancelled=true`,
      metadata: { salvage_id: salvageId, market: market || 'GB' },
    });

    return NextResponse.json({ url: stripeSession.url });

  } catch (err) {
    console.error('Salvage checkout error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}
