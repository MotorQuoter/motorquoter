import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const ONE_AUTO_BASE = 'https://api.oneautoapi.com';
const CACHE_TTL_HOURS = 48;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── TIER RESOLUTION ─────────────────────────────────────────────────────────
// Two paths:
// 1. Paid lookup — session_id from Stripe is verified, tier taken from metadata
// 2. Free lookup — no session, defaults to free
async function resolveUserTier(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');

  // If a Stripe session ID is provided, verify it and use its tier
  if (sessionId && sessionId !== '{CHECKOUT_SESSION_ID}') {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status === 'paid') {
        return session.metadata?.tier || 'free';
      }
    } catch (err) {
      console.error('Stripe session verify error:', err);
    }
  }

  // No valid session — free tier
  return 'free';
}

// ─── CACHE HELPERS ───────────────────────────────────────────────────────────
async function getCachedResult(supabase, cleanVrm, tier) {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  try {
    const { data } = await supabase
      .from('reg_lookup_cache')
      .select('*')
      .eq('reg_plate', cleanVrm)
      .eq('tier', tier)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return data || null;
  } catch {
    return null;
  }
}

async function storeCachedResult(supabase, cleanVrm, tier, payload) {
  try {
    await supabase
      .from('reg_lookup_cache')
      .upsert(
        {
          reg_plate: cleanVrm,
          tier: tier,
          payload: payload,
          created_at: new Date().toISOString()
        },
        { onConflict: 'reg_plate,tier' }
      );
  } catch (err) {
    console.error('Cache write error:', err);
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const mileage = searchParams.get('mileage') || '50000';
  const cleanMileage = mileage.replace(/,/g, '');

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');

  // Resolve tier — from Stripe session if paid, otherwise free
  const tier = await resolveUserTier(request);

  const supabase = getSupabase();

  // ── CACHE CHECK ──────────────────────────────────────────────────────────
  const cached = await getCachedResult(supabase, cleanVrm, tier);
  if (cached) {
    return NextResponse.json({
      ...cached.payload,
      _cached: true,
      _cachedAt: cached.created_at
    });
  }

  // ── LIVE API CALLS ───────────────────────────────────────────────────────
  try {
    // DVLA — always free
    const dvlaRes = await fetch(
      'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
      {
        method: 'POST',
        headers: {
          'x-api-key': process.env.DVLA_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ registrationNumber: cleanVrm })
      }
    );

    const dvla = await dvlaRes.json();

    if (!dvlaRes.ok) {
      return NextResponse.json(
        { error: dvla.message || 'DVLA lookup failed' },
        { status: dvlaRes.status }
      );
    }

    let autocheck = null;
    let valuation = null;
    let mot = null;

    // STANDARD: AutoCheck + Valuation
    if (tier === 'standard') {
      const [autocheckRes, bregoRes] = await Promise.all([
        fetch(
          `${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        fetch(
          `${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${cleanMileage}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        )
      ]);
      autocheck = await autocheckRes.json();
      valuation = await bregoRes.json();
    }

    // PRO: AutoCheck + Valuation + MOT History
    if (tier === 'pro') {
      const [autocheckRes, bregoRes, motRes] = await Promise.all([
        fetch(
          `${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        fetch(
          `${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${cleanMileage}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        fetch(
          `${ONE_AUTO_BASE}/oneauto/mothistoryandtaxstatus/v2?vehicle_registration_mark=${cleanVrm}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        )
      ]);
      autocheck = await autocheckRes.json();
      valuation = await bregoRes.json();
      const motData = await motRes.json();
      mot = motData?.result?.dvsa_data?.mot_tests || [];
    }

    const latestMot = mot?.[0] || null;

    const payload = {
      make: dvla.make,
      colour: dvla.colour,
      fuelType: dvla.fuelType,
      engineSize: dvla.engineCapacity ? `${dvla.engineCapacity}cc` : null,
      yearOfManufacture: dvla.yearOfManufacture,
      taxStatus: dvla.taxStatus,
      taxDueDate: dvla.taxDueDate,
      motStatus: dvla.motStatus,
      co2Emissions: dvla.co2Emissions,
      dateOfLastV5CIssued: dvla.dateOfLastV5CIssued,
      monthOfFirstRegistration: dvla.monthOfFirstRegistration,
      autocheck: autocheck?.result || null,
      valuation: valuation?.result || null,
      motExpiryDate: tier === 'pro' ? (latestMot?.mot_expiry_date || null) : null,
      motMileage: tier === 'pro' ? (latestMot?.observation_mileage || null) : null,
      motResult: tier === 'pro' ? (latestMot?.mot_test_result || null) : null,
      motHistory: tier === 'pro' ? (mot || []) : null,
      tier: tier
    };

    await storeCachedResult(supabase, cleanVrm, tier, payload);

    return NextResponse.json(payload);

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}