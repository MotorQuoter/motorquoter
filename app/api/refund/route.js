import { NextResponse } from 'next/server';
import Stripe from 'stripe';

export async function POST(request) {
  try {
    const { paymentIntentId, amount } = await request.json();

    if (!paymentIntentId || amount == null) {
      return NextResponse.json(
        { success: false, error: 'paymentIntentId and amount are required' },
        { status: 400 }
      );
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, error: 'amount must be a positive integer (pence)' },
        { status: 400 }
      );
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount,
    });

    return NextResponse.json({ success: true, refundId: refund.id });
  } catch (err) {
    console.error('Refund error:', err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
