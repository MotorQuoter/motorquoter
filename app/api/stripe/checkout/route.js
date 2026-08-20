import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { PRICING, IE_MENU } from '@/config/pricing';
import { rejectedKeys } from '@/lib/menuGate';
import { hasVehicleGatedKey, notOfferableForVehicle } from '@/lib/offerability';

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
    const { vrm, checks, mileage, market, promoCode, currency } = await request.json();

    if (!vrm) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // Payment currency is INDEPENDENT of market. GBP is the default everywhere. EUR is opt-in and
    // valid ONLY on an IE-market basket (two guards: explicit 'eur' AND market==='IE'). A GB
    // request asking EUR is malformed — reject, do NOT silently coerce. Every line item uses the
    // single `curr` below, so a mixed-currency session (which Stripe rejects) is impossible.
    const reqCurrency = (currency || 'gbp').toLowerCase();
    if (reqCurrency !== 'gbp' && reqCurrency !== 'eur') {
      return NextResponse.json({ error: `Unsupported currency "${reqCurrency}"` }, { status: 400 });
    }
    if (reqCurrency === 'eur' && market !== 'IE') {
      return NextResponse.json({ error: 'EUR payment is only available for IE-market lots' }, { status: 400 });
    }
    const useEUR = reqCurrency === 'eur' && market === 'IE';
    const curr = useEUR ? 'eur' : 'gbp';

    const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');

    if (!Array.isArray(checks) || checks.length === 0) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // Resolve prices server-side — client cannot spoof amounts
    const allMenuItems = [...PRICING.menu, ...IE_MENU];
    const menuMap = Object.fromEntries(allMenuItems.map(i => [i.key, i]));
    const posNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

    // ── Allow-list gate — reject unknown or DISABLED keys outright (not a deny-list) ─────────────
    // Every requested key must be a CURRENTLY-ENABLED menu item. A disabled key (e.g. writeoff /
    // finance / stolen after the 20 Aug removal) or an unknown key must never survive into
    // `metadata.checks` / `success_url` below: /api/vehicle binds the paid scope from that metadata,
    // so a key that reaches it is treated as paid. This is the ROI_TIERS hole exactly — a crafted
    // `valuation,writeoff` basket bills £1.99 (writeoff dropped from line items) yet, if writeoff
    // rode into metadata, would fire the £2.40 AutoCheck the customer never paid for. Reject the whole
    // request; do NOT silently drop the offending key.
    const invalidKeys = rejectedKeys(checks, allMenuItems);
    if (invalidKeys.length > 0) {
      console.warn(`[CHECKOUT] rejected unavailable keys: [${invalidKeys.join(',')}] vrm=${cleanVrm}`);
      return NextResponse.json({ error: `Unavailable items: ${invalidKeys.join(', ')}` }, { status: 400 });
    }

    // ── Per-vehicle offerability gate (Defect 2, 20 Aug) ──────────────────────────────────────────
    // A key can be an enabled product yet not offerable for THIS vehicle (service history off the
    // 44-make/2012 coverage gate). The allow-list only knows per-product state, so a disabled checkbox
    // that still carried its key reached here and was charged. Re-derive make/year from DVLA
    // server-side (the client's disabled control is only a courtesy) and run the SAME offerability the
    // menu runs. Only fetch DVLA when a gated key is actually in the basket — no cost, but latency.
    if (market !== 'IE' && hasVehicleGatedKey(checks)) {
      try {
        const dvlaRes = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
          method: 'POST',
          headers: { 'x-api-key': process.env.DVLA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrationNumber: cleanVrm }),
        });
        if (dvlaRes.ok) {
          const dvla = await dvlaRes.json();
          const notOfferable = notOfferableForVehicle(checks, { make: dvla.make, yearOfManufacture: dvla.yearOfManufacture });
          if (notOfferable.length > 0) {
            console.warn(`[CHECKOUT] rejected not-offerable-for-vehicle: [${notOfferable.join(',')}] vrm=${cleanVrm} make=${dvla.make} year=${dvla.yearOfManufacture}`);
            return NextResponse.json({ error: `Not available for this vehicle: ${notOfferable.join(', ')}` }, { status: 400 });
          }
        } else {
          // DVLA unreachable — do NOT block the sale on a transient outage. The vehicle route's own
          // coverage skip + refund remains the backstop. Logged loud so the failure is distinguishable.
          console.error(`[CHECKOUT] offerability DVLA precheck HTTP ${dvlaRes.status} vrm=${cleanVrm} — allowing, refund backstop stands`);
        }
      } catch (dvlaErr) {
        console.error(`[CHECKOUT] offerability DVLA precheck threw (${dvlaErr.message}) vrm=${cleanVrm} — allowing, refund backstop stands`);
      }
    }
    const paidKeys = checks.filter(key => menuMap[key] && menuMap[key].enabled && menuMap[key].price > 0);
    // FAIL LOUD: an opted-in EUR basket with any paid item lacking a positive priceEUR must NOT
    // fall back to GBP (silent GBP-charge-to-a-EUR-customer is the reconciliation-only failure).
    if (useEUR) {
      const missing = paidKeys.filter(key => !posNum(menuMap[key].priceEUR));
      if (missing.length > 0) {
        console.error(`[IE_CHECKOUT] EUR opted-in but priceEUR missing/invalid for: ${missing.join(',')}`);
        return NextResponse.json({ error: 'EUR pricing is temporarily unavailable — please contact support' }, { status: 500 });
      }
    }
    let lineItems = paidKeys
      .map(key => ({
        price_data: {
          currency: curr,
          product_data: { name: menuMap[key].label },
          unit_amount: Math.round((useEUR ? menuMap[key].priceEUR : menuMap[key].price) * 100),
        },
        quantity: 1,
      }));

    if (lineItems.length === 0) {
      return NextResponse.json({ error: 'No paid items selected' }, { status: 400 });
    }

    const gbMetadata = {
      vrm: cleanVrm,
      checks: checks.join(','),
      mileage: mileage || '',
      market: market || 'GB',
      currency: curr,
    };

    if (promoCode) {
      const supabase = getSupabase();
      const promo = await validatePromoServer(supabase, promoCode);
      if (promo && promo.discount_type !== 'free') {
        const originalPence = lineItems.reduce((s, i) => s + i.price_data.unit_amount, 0);
        const discountedPence = applyDiscountPence(originalPence, promo);
        lineItems = [{
          price_data: {
            currency: curr,
            product_data: { name: 'Vehicle Report' },
            unit_amount: Math.max(30, discountedPence),
          },
          quantity: 1,
        }];
        gbMetadata.promo_code = promo.code;
      }
    }

    console.log(`[IE_CHECKOUT] market=${market || 'GB'} currency=${curr} base=${lineItems.reduce((s, i) => s + i.price_data.unit_amount, 0)}`);

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
