import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ONE_AUTO_BASE = 'https://api.oneautoapi.com';
const CACHE_TTL_HOURS = 48;

// Server-side Supabase client using service role key (never exposed to client)
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── TIER RESOLUTION ─────────────────────────────────────────────────────────
// Tier is NEVER trusted from the client. It is resolved server-side only.
// For now: reads from Supabase session cookie. If no session = free.
// When Stripe subscriptions go live, this reads from the subscriptions table.
async function resolveUserTier(request) {
  try {
    const supabase = getSupabase();

    // Extract session token from cookie
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/sb-access-token=([^;]+)/);
    const accessToken = match?.[1];

    if (!accessToken) return 'free';

    // Verify the token and get the user
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) return 'free';

    // Look up their subscription tier
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('tier')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    return subscription?.tier || 'free';

  } catch {
    // On any auth error, fail safe to free tier — never grant upward
    return 'free';
  }
}

// ─── CACHE HELPERS ───────────────────────────────────────────────────────────
async function getCachedResult(supabase, cleanVrm, tier) {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

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
}

async function storeCachedResult(supabase, cleanVrm, tier, payload) {
  // Upsert — if same reg+tier already cached, replace it
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

  // Resolve tier server-side — client-supplied tier param is ignored entirely
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
    // FREE TIER: DVLA gov API only — zero One Auto cost
    // STANDARD/PRO: DVLA + One Auto calls appropriate to tier
    let dvla, mot, autocheck, valuation;

    // DVLA is always free — call it for every tier
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

    dvla = await dvlaRes.json();

    if (!dvlaRes.ok) {
      return NextResponse.json(
        { error: dvla.message || 'DVLA lookup failed' },
        { status: dvlaRes.status }
      );
    }

    // STANDARD: DVLA + AutoCheck + Valuation
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

    // PRO: DVLA + AutoCheck + Valuation + MOT History
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

    // Build the response payload
    const latestMot = mot?.[0] || null;

    const payload = {
      // ── Always returned (free + all tiers) ──
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

      // ── Standard + Pro only ──
      autocheck: autocheck?.result || null,
      valuation: valuation?.result || null,

      // ── Pro only ──
      motExpiryDate: tier === 'pro' ? (latestMot?.mot_expiry_date || null) : null,
      motMileage: tier === 'pro' ? (latestMot?.observation_mileage || null) : null,
      motResult: tier === 'pro' ? (latestMot?.mot_test_result || null) : null,
      motHistory: tier === 'pro' ? (mot || []) : null,

      // Tier returned so the frontend knows what it received
      tier: tier
    };

    // ── STORE IN CACHE ───────────────────────────────────────────────────
    await storeCachedResult(supabase, cleanVrm, tier, payload);

    return NextResponse.json(payload);

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}