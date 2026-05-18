import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export async function GET(request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
      checks: session.metadata?.checks || '',
      vrm: session.metadata?.vrm || null,
      market: session.metadata?.market || 'GB',
      roiTier: session.metadata?.roiTier || null,
    });
  } catch (err) {
    console.error('Stripe verify error:', err);
    return NextResponse.json({ paid: false, error: err.message }, { status: 500 });
  }
}
