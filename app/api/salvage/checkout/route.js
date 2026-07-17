import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { PRICING, ROI_TIERS } from '@/config/pricing';
import { normaliseLot } from '@/lib/normaliseLot';
import { SALE_PASSED_REJECT_PAID } from '@/config/booking.mjs';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  try {
    const { vehicleDetails, imagePaths, market, roiTier, currency } = await request.json();

    if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
      return NextResponse.json({ error: 'At least one image is required' }, { status: 400 });
    }
    if (imagePaths.length > 35) {
      return NextResponse.json({ error: 'Maximum 35 images allowed' }, { status: 400 });
    }

    const _ta = (vehicleDetails || {}).typeApproval;
    if (!_ta || !['M1', 'N1', 'M2'].includes(_ta)) {
      return NextResponse.json({ error: 'Vehicle type not supported' }, { status: 400 });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const roiTierKey = market === 'IE' ? (roiTier || 'roi_free') : null;
    const roiTierMeta = roiTierKey ? ROI_TIERS.find(t => t.key === roiTierKey) : null;
    const roiAddOn = roiTierMeta?.addOn || 0; // GBP add-on doubles as the "is this a paid ROI tier" gate

    // Payment currency is INDEPENDENT of market. GBP is the default everywhere. EUR is opt-in and
    // valid ONLY on an IE-market lot (two guards: explicit 'eur' request AND market==='IE'). A
    // GB/NI lot requesting EUR is malformed — reject it (do NOT silently coerce), so the frontend
    // bug that sent it is visible. Both line items share ONE currency (Stripe rejects mixed).
    const reqCurrency = (currency || 'gbp').toLowerCase();
    if (reqCurrency !== 'gbp' && reqCurrency !== 'eur') {
      return NextResponse.json({ error: `Unsupported currency "${reqCurrency}"` }, { status: 400 });
    }
    if (reqCurrency === 'eur' && market !== 'IE') {
      return NextResponse.json({ error: 'EUR payment is only available for IE-market lots' }, { status: 400 });
    }
    const useEUR = reqCurrency === 'eur' && market === 'IE';
    const curr = useEUR ? 'eur' : 'gbp';

    // Fail LOUD on missing/invalid EUR config — NEVER silently charge GBP to an opted-in EUR
    // customer (that is the reconciliation-only failure this whole change exists to avoid).
    const posNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const baseAmount = useEUR ? PRICING.salvageAssessment.priceEUR : PRICING.salvageAssessment.price;
    if (useEUR && !posNum(baseAmount)) {
      console.error(`[CHECKOUT][CURR] EUR opted-in but salvageAssessment.priceEUR missing/invalid: ${baseAmount}`);
      return NextResponse.json({ error: 'EUR pricing is temporarily unavailable — please contact support' }, { status: 500 });
    }
    const roiAddOnAmount = useEUR ? roiTierMeta?.addOnEUR : roiAddOn;
    if (useEUR && roiAddOn > 0 && !posNum(roiAddOnAmount)) {
      console.error(`[CHECKOUT][CURR] EUR opted-in but addOnEUR missing/invalid for tier ${roiTierKey}: ${roiAddOnAmount}`);
      return NextResponse.json({ error: 'EUR pricing is temporarily unavailable — please contact support' }, { status: 500 });
    }

    // Sale-passed reject gate: if the auction has already happened, an assessment can't inform a
    // bid. Reject before any DB row or Stripe session is created (no orphan pending_payment row).
    // saleDate is computed on the spot from the raw paste already in vehicleDetails; null saleDate
    // (absent/unparseable) never fires.
    const _saleDate = normaliseLot(vehicleDetails || {}).saleDate;
    if (_saleDate && _saleDate.ms < Date.now()) {
      return NextResponse.json({ error: SALE_PASSED_REJECT_PAID }, { status: 409 });
    }

    const supabase = getSupabase();
    const { data: session, error: dbError } = await supabase
      .from('salvage_sessions')
      .insert({
        status: 'pending_payment',
        payment_kind: 'paid',
        vehicle_details: { ...(vehicleDetails || {}), roiTier: roiTierKey },
        image_paths: imagePaths,
        market: market || 'GB',
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      return NextResponse.json({ error: 'Failed to store session' }, { status: 500 });
    }

    const salvageId = session.id;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');

    const vd = vehicleDetails || {};
    const identifier = vd.vrm || vd.lotNumber || [vd.make, vd.model, vd.year].filter(Boolean).join(' ') || '';

    const lineItems = [
      {
        price_data: {
          currency: curr,
          product_data: {
            name: 'MotorQuoter Damage Assessment',
            description: identifier ? `Assessment for ${identifier}` : 'AI-powered salvage & damage assessment',
          },
          unit_amount: Math.round(baseAmount * 100),
        },
        quantity: 1,
      },
    ];

    if (roiAddOn > 0 && roiTierMeta) {
      lineItems.push({
        price_data: {
          currency: curr,
          product_data: {
            name: `ROI Vehicle Data — ${roiTierMeta.label}`,
            description: roiTierMeta.description,
          },
          unit_amount: Math.round(roiAddOnAmount * 100),
        },
        quantity: 1,
      });
    }

    // Single-currency invariant: every line item uses `curr`, so a mixed-currency session
    // (which Stripe rejects) is impossible by construction.
    console.log(`[CHECKOUT][CURR] market=${market || 'GB'} currency=${curr} base=${Math.round(baseAmount * 100)}${roiAddOn > 0 ? ` addOn=${Math.round(roiAddOnAmount * 100)}` : ''}`);

    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${baseUrl}/salvage/success?salvage_id=${salvageId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/salvage?cancelled=true`,
      metadata: { salvage_id: salvageId, market: market || 'GB', currency: curr },
    });

    return NextResponse.json({ url: stripeSession.url });

  } catch (err) {
    console.error('Salvage checkout error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}
