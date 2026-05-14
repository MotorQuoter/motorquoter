import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getDvsaMotHistory } from '@/lib/dvsa';

const ONE_AUTO_BASE = 'https://api.oneautoapi.com';
const CACHE_TTL_HOURS = 48;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Tier is passed from payment-success page after Stripe verification
// Never trusted from client directly — only accepted when verified=true
async function resolveUserTier(request) {
  const { searchParams } = new URL(request.url);
  const verified = searchParams.get('verified');
  const tier = searchParams.get('tier');

  if (verified === 'true' && tier && ['standard', 'pro'].includes(tier)) {
    return tier;
  }
  return 'free';
}

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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const mileage = searchParams.get('mileage') || '50000';
  const cleanMileage = mileage.replace(/,/g, '');

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
  const tier = await resolveUserTier(request);
  const supabase = getSupabase();

  // Cache check
  const cached = await getCachedResult(supabase, cleanVrm, tier);
  if (cached) {
    return NextResponse.json({
      ...cached.payload,
      _cached: true,
      _cachedAt: cached.created_at
    });
  }

  // Live API calls
  try {
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

    if (tier === 'pro') {
      const [autocheckRes, bregoRes, dvsaData] = await Promise.all([
        fetch(
          `${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        fetch(
          `${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${cleanMileage}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        getDvsaMotHistory(cleanVrm)
      ]);
      autocheck = await autocheckRes.json();
      valuation = await bregoRes.json();
      mot = dvsaData?.motTests || [];
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
      motExpiryDate: tier === 'pro' ? (latestMot?.expiryDate || null) : null,
      motMileage: tier === 'pro' ? (latestMot?.odometerValue || null) : null,
      motResult: tier === 'pro' ? (latestMot?.testResult || null) : null,
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