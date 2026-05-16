import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getDvsaMotHistory } from '@/lib/dvsa';

const ONE_AUTO_BASE = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
const CACHE_TTL_HOURS = 48;

function extractApiResult(data) {
  if (!data || data.error) return null;
  const result = data.result ?? data;
  if (result?.error) return null;
  return result;
}

async function safeJson(res) {
  const text = await res.text();
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

async function fetchWithPolling(url, options, { maxAttempts = 5, intervalMs = 1500 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, options);
    if (res.status !== 202) return res;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

const SERVICE_HISTORY_COVERAGE = new Map([
  ['AUDI', 'full'], ['BMW', 'full'], ['CUPRA', 'full'], ['FORD', 'full'],
  ['HONDA', 'full'], ['INFINITI', 'full'], ['JAGUAR', 'full'], ['LAND ROVER', 'full'],
  ['LEXUS', 'full'], ['MAZDA', 'full'], ['MERCEDES-BENZ', 'full'], ['MINI', 'full'],
  ['NISSAN', 'full'], ['OPEL', 'full'], ['PORSCHE', 'full'], ['SEAT', 'full'],
  ['SKODA', 'full'], ['TOYOTA', 'full'], ['VAUXHALL', 'full'], ['VOLKSWAGEN', 'full'],
  ['AIXAM', 'limited'], ['ALPINE', 'limited'], ['BENTLEY', 'limited'], ['DAF', 'limited'],
  ['DS', 'limited'], ['FERRARI', 'limited'], ['IVECO', 'limited'], ['MASERATI', 'limited'],
  ['PIAGGIO', 'limited'], ['SUBARU', 'limited'], ['SUZUKI', 'limited'], ['YAMAHA', 'limited'],
  ['ALFA ROMEO', 'workshop'], ['CHRYSLER', 'workshop'], ['CITROEN', 'workshop'],
  ['DACIA', 'workshop'], ['DODGE', 'workshop'], ['FIAT', 'workshop'], ['JEEP', 'workshop'],
  ['KIA', 'workshop'], ['PEUGEOT', 'workshop'], ['POLESTAR', 'workshop'],
  ['RENAULT', 'workshop'], ['VOLVO', 'workshop'],
]);

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function getCachedResult(supabase, cleanVrm, cacheKey) {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();
  try {
    const { data } = await supabase
      .from('reg_lookup_cache')
      .select('*')
      .eq('reg_plate', cleanVrm)
      .eq('tier', cacheKey)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data || null;
  } catch {
    return null;
  }
}

async function storeCachedResult(supabase, cleanVrm, cacheKey, payload) {
  try {
    await supabase
      .from('reg_lookup_cache')
      .upsert(
        { reg_plate: cleanVrm, tier: cacheKey, payload, created_at: new Date().toISOString() },
        { onConflict: 'reg_plate,tier' }
      );
  } catch (err) {
    console.error('Cache write error:', err);
  }
}

const oneAutoHeaders = () => ({ 'x-api-key': process.env.ONE_AUTO_API_KEY });

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const mileage = searchParams.get('mileage') || '50000';
  const cleanMileage = mileage.replace(/,/g, '');
  const market = (searchParams.get('market') || 'GB').toUpperCase();
  const tier = searchParams.get('tier');
  const isVerified = searchParams.get('verified') === 'true';

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');
  const supabase = getSupabase();

  // ── FREE GB LOOKUP ───────────────────────────────────────────────────────────
  if (tier === 'free') {
    if (market === 'IE') {
      return NextResponse.json(
        { error: 'Irish vehicle data is only available in paid reports' },
        { status: 400 }
      );
    }

    const cacheKey = 'free_GB';
    const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
    if (cached) {
      return NextResponse.json({ ...cached.payload, _cached: true, _cachedAt: cached.created_at });
    }

    try {
      const dvlaRes = await fetch(
        'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
        {
          method: 'POST',
          headers: { 'x-api-key': process.env.DVLA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrationNumber: cleanVrm }),
        }
      );
      const dvla = await safeJson(dvlaRes);
      if (!dvlaRes.ok || !dvla) {
        return NextResponse.json(
          { error: dvla?.message || 'DVLA lookup failed' },
          { status: dvlaRes.ok ? 500 : dvlaRes.status }
        );
      }

      const payload = {
        make: dvla.make,
        model: dvla.model,
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
        market: 'GB',
        tier: 'free',
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      return NextResponse.json(payload);
    } catch (err) {
      console.error('DVLA lookup error:', err);
      return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
    }
  }

  // ── PAID LOOKUP ──────────────────────────────────────────────────────────────
  if (!isVerified) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const checksParam = searchParams.get('checks') || '';
  const checks = checksParam.split(',').map(s => s.trim()).filter(Boolean);

  if (checks.length === 0) {
    return NextResponse.json({ error: 'No checks specified' }, { status: 400 });
  }

  const sortedKey = [...checks].sort().join(',');
  const cacheKey = `checks:${sortedKey}_${market}`;

  const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached.payload, _cached: true, _cachedAt: cached.created_at });
  }

  try {
    if (market === 'IE') {
      // ── IE PAID PATH ─────────────────────────────────────────────────────────
      const cartellRes = await fetch(
        `${ONE_AUTO_BASE}/cartell/vehicleidentity/v1?vehicle_registration_mark=${cleanVrm}`,
        { headers: oneAutoHeaders() }
      );
      const cartellData = await safeJson(cartellRes);
      const cartell = extractApiResult(cartellData);
      if (!cartellRes.ok || !cartell) {
        return NextResponse.json(
          { error: cartellData?.message || 'Vehicle not found in Irish register' },
          { status: cartellRes.ok ? 500 : cartellRes.status }
        );
      }

      const needsHpi = checks.some(c => ['writeoff', 'finance', 'stolen'].includes(c));
      const needsNct = checks.includes('mot');

      const [hpiRes, nctRes] = await Promise.all([
        needsHpi
          ? fetch(`${ONE_AUTO_BASE}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsNct
          ? fetch(`${ONE_AUTO_BASE}/cartell/ncthistory/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
      ]);

      const hpiData = hpiRes ? extractApiResult(await safeJson(hpiRes)) : null;
      const nctData = nctRes ? extractApiResult(await safeJson(nctRes)) : null;

      const cc = cartell.engine_capacity ?? cartell.engineCapacity ?? cartell.cc ?? null;
      const rawTax = cartell.motor_tax_status ?? cartell.motorTaxStatus ?? null;
      let taxStatus = null;
      if (rawTax) {
        const t = rawTax.toLowerCase();
        taxStatus = (t.includes('paid') || t.includes('taxed') || t === 'current') ? 'Taxed' : rawTax;
      }
      const rawNct = cartell.nct_status ?? cartell.nctStatus ?? null;
      let nctStatus = null;
      if (rawNct) {
        const n = rawNct.toLowerCase();
        nctStatus = (n === 'valid' || n.includes('valid') || n === 'current') ? 'Valid' : rawNct;
      }

      const payload = {
        make: cartell.make ?? cartell.manufacturer ?? null,
        model: cartell.model ?? null,
        colour: cartell.colour ?? cartell.color ?? null,
        fuelType: cartell.fuel_type ?? cartell.fuelType ?? null,
        engineSize: cc ? `${cc}cc` : null,
        yearOfManufacture: cartell.year_of_first_registration ?? cartell.yearOfFirstRegistration ?? cartell.year_of_manufacture ?? null,
        taxStatus,
        taxDueDate: cartell.motor_tax_expiry_date ?? cartell.motorTaxExpiryDate ?? null,
        motStatus: nctStatus,
        nctExpiryDate: cartell.nct_expiry_date ?? cartell.nctExpiryDate ?? null,
        co2Emissions: cartell.co2_emissions ?? cartell.co2 ?? null,
        monthOfFirstRegistration: cartell.first_registration_date_in_ireland ?? cartell.first_registration_date ?? null,
        hpi: hpiData,
        nctHistory: nctData,
        valuation: null,
        cazanaAdverts: null,
        cazanaDemand: null,
        serviceHistory: null,
        serviceHistoryCoverage: null,
        market: 'IE',
        checks,
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      return NextResponse.json(payload);

    } else {
      // ── GB PAID PATH ──────────────────────────────────────────────────────────
      const dvlaRes = await fetch(
        'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
        {
          method: 'POST',
          headers: { 'x-api-key': process.env.DVLA_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrationNumber: cleanVrm }),
        }
      );
      const dvla = await safeJson(dvlaRes);
      if (!dvlaRes.ok || !dvla) {
        return NextResponse.json(
          { error: dvla?.message || 'DVLA lookup failed' },
          { status: dvlaRes.ok ? 500 : dvlaRes.status }
        );
      }

      const needsAutocheck = checks.some(c => ['writeoff', 'finance', 'stolen'].includes(c));
      const needsValuation = checks.includes('valuation');
      const needsMot = checks.includes('mot');
      const needsMarketDemand = checks.includes('market_demand');
      const needsPreviousAdverts = checks.includes('previous_adverts');
      const needsServiceHistory = checks.includes('service_history');

      const dvlaMake = dvla.make?.toUpperCase() || '';
      const svcCoverage = needsServiceHistory ? (SERVICE_HISTORY_COVERAGE.get(dvlaMake) || null) : null;

      // Service history may need polling — start it first
      const svcHistoryPromise = (needsServiceHistory && svcCoverage !== null)
        ? fetchWithPolling(
            `${ONE_AUTO_BASE}/oneauto/servicehistory/?vehicle_registration_mark=${cleanVrm}`,
            { headers: oneAutoHeaders() }
          )
        : Promise.resolve(null);

      const [autocheckRes, bregoRes, cazAdvRes, cazDemRes, dvsaData] = await Promise.all([
        needsAutocheck
          ? fetch(`${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsValuation
          ? fetch(`${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${cleanMileage}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsPreviousAdverts
          ? fetch(`${ONE_AUTO_BASE}/percayso/previousadvertsfromvrm/?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsMarketDemand
          ? fetch(`${ONE_AUTO_BASE}/percayso/marketdemandfromvrm/?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsMot ? getDvsaMotHistory(cleanVrm) : Promise.resolve(null),
      ]);

      const autocheck = autocheckRes ? await safeJson(autocheckRes) : null;
      const valuation = bregoRes ? await safeJson(bregoRes) : null;
      const cazanaAdverts = cazAdvRes ? await safeJson(cazAdvRes) : null;
      const cazanaDemand = cazDemRes ? await safeJson(cazDemRes) : null;
      const motTests = dvsaData?.motTests || null;

      const svcRes = await svcHistoryPromise;
      const serviceHistory = svcRes ? await safeJson(svcRes) : null;

      const latestMot = motTests?.[0] || null;

      const payload = {
        make: dvla.make,
        model: dvla.model,
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
        motExpiryDate: latestMot?.expiryDate || null,
        motMileage: latestMot?.odometerValue || null,
        motResult: latestMot?.testResult || null,
        motHistory: motTests || null,
        cazanaAdverts: cazanaAdverts?.error ? null : cazanaAdverts,
        cazanaDemand: extractApiResult(cazanaDemand),
        serviceHistory: extractApiResult(serviceHistory),
        serviceHistoryCoverage: svcCoverage,
        market: 'GB',
        checks,
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      return NextResponse.json(payload);
    }

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}
