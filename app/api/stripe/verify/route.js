import { NextResponse } from 'next/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Verifies a Stripe Checkout session was actually paid
// Called by the payment-success page before running the vehicle lookup
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');

  if (!sessionId) {
    return NextResponse.json({ paid: false, error: 'No session ID' }, { status: 400 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paid = session.payment_status === 'paid';

    return NextResponse.json({
      paid,
      tier: session.metadata?.tier || null,
      vrm: session.metadata?.vrm || null,
    });

  } catch (err) {
    console.error('Stripe verify error:', err);
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}