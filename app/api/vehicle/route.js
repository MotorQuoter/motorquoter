import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getDvsaMotHistory } from '@/lib/dvsa';
import { isRoiPlate, formatRoiVrm } from '@/lib/roiPlate';

const ONE_AUTO_BASE = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
const CARTELL_BASE = process.env.ONEAUTO_SANDBOX === 'true' ? 'https://sandbox.oneautoapi.com' : ONE_AUTO_BASE;
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

const FREE_RATE_LIMIT = 10;
const FREE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const freeRateLimitMap = new Map();

function checkFreeRateLimit(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : (request.connection?.remoteAddress || 'unknown');
  const now = Date.now();
  const entry = freeRateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    freeRateLimitMap.set(ip, { count: 1, resetTime: now + FREE_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= FREE_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

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

  // ── FREE LOOKUP ──────────────────────────────────────────────────────────────
  if (tier === 'free') {
    if (!checkFreeRateLimit(request)) {
      return NextResponse.json(
        { error: 'Too many requests — please try again later' },
        { status: 429 }
      );
    }
    if (isRoiPlate(cleanVrm)) {
      const cacheKey = 'free_IE';
      const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
      if (cached) {
        return NextResponse.json({ ...cached.payload, _cached: true, _cachedAt: cached.created_at });
      }
      try {
        const cartellRes = await fetch(
          `${CARTELL_BASE}/cartell/vehicleidentity?vehicle_registration_mark=${cleanVrm}`,
          { headers: oneAutoHeaders() }
        );
        const cartellData = await safeJson(cartellRes);
        const cartell = cartellData?.success === true ? cartellData.result : null;
        if (!cartell?.vehicle_registration_mark) {
          return NextResponse.json(
            { error: 'Vehicle not found in Irish register — please check the registration' },
            { status: 404 }
          );
        }
        const cc = cartell.engine_capacity_cc ?? null;
        const nctDue = cartell.nct_due_date ?? null;
        const nctStatus = nctDue ? (new Date(nctDue) > new Date() ? 'Valid' : 'Expired') : null;
        const payload = {
          make: cartell.manufacturer_desc ?? null,
          model: cartell.model_desc ?? null,
          colour: cartell.colour ?? null,
          fuelType: cartell.fuel_type_desc ?? null,
          engineSize: cc ? `${cc}cc` : null,
          yearOfManufacture: cartell.manufactured_year ?? null,
          taxStatus: null,
          taxDueDate: null,
          motStatus: nctStatus,
          motExpiryDate: nctDue,
          motMileage: null,
          motResult: null,
          motHistory: null,
          hasOutstandingRecall: null,
          co2Emissions: cartell.co2_gkm != null ? String(cartell.co2_gkm) : null,
          monthOfFirstRegistration: cartell.first_registration_ireland_date ?? cartell.first_registration_date ?? null,
          market: 'IE',
          tier: 'free',
        };
        await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
        return NextResponse.json(payload);
      } catch (err) {
        console.error('Cartell lookup error:', err);
        return NextResponse.json({ error: err.message || 'Irish register lookup failed' }, { status: 500 });
      }
    }

    const cacheKey = 'free_GB';
    const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
    if (cached) {
      return NextResponse.json({ ...cached.payload, _cached: true, _cachedAt: cached.created_at });
    }

    try {
      const [dvlaRes, dvsaData] = await Promise.all([
        fetch(
          'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
          {
            method: 'POST',
            headers: { 'x-api-key': process.env.DVLA_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ registrationNumber: cleanVrm }),
          }
        ),
        getDvsaMotHistory(cleanVrm).catch(() => null),
      ]);
      const dvla = await safeJson(dvlaRes);
      if (!dvlaRes.ok || !dvla) {
        return NextResponse.json(
          { error: dvla?.message || 'DVLA lookup failed' },
          { status: dvlaRes.ok ? 500 : dvlaRes.status }
        );
      }

      const freeMotTests = dvsaData?.motTests || null;
      const freeLatestMot = freeMotTests?.[0] || null;

      const payload = {
        make: dvla.make,
        model: dvsaData?.model || null,
        colour: dvla.colour,
        fuelType: dvla.fuelType,
        engineSize: dvla.engineCapacity ? `${dvla.engineCapacity}cc` : null,
        yearOfManufacture: dvla.yearOfManufacture,
        taxStatus: dvla.taxStatus,
        taxDueDate: dvla.taxDueDate,
        motStatus: dvla.motStatus,
        motExpiryDate: freeLatestMot?.expiryDate || null,
        motMileage: freeLatestMot?.odometerValue || null,
        motResult: freeLatestMot?.testResult || null,
        motHistory: freeMotTests,
        hasOutstandingRecall: dvsaData?.hasOutstandingRecall ?? null,
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
  const roiTierParam = searchParams.get('roiTier');

  if (checks.length === 0 && !roiTierParam) {
    return NextResponse.json({ error: 'No checks specified' }, { status: 400 });
  }

  // ── ROI TIER PAID PATH ───────────────────────────────────────────────────────
  if (market === 'IE' && roiTierParam) {
    const isPro = ['roi_pro', 'roi_history'].includes(roiTierParam);
    const isHistory = roiTierParam === 'roi_history';
    const roiCacheKey = `roi:${roiTierParam}`;

    const roiCached = await getCachedResult(supabase, cleanVrm, roiCacheKey);
    if (roiCached) {
      return NextResponse.json({ ...roiCached.payload, _cached: true, _cachedAt: roiCached.created_at });
    }

    const [cartellRes, demandRes, priceGuideRes, hpiRes, nctRes] = await Promise.all([
      fetch(`${ONE_AUTO_BASE}/cartell/vehicleidentity?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }),
      fetch(`${ONE_AUTO_BASE}/percayso/marketdemandfromvrm/?vrm=${cleanVrm}`, { headers: oneAutoHeaders() }),
      isPro  ? fetch(`${ONE_AUTO_BASE}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }) : Promise.resolve(null),
      isHistory ? fetch(`${ONE_AUTO_BASE}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }) : Promise.resolve(null),
      isHistory ? fetch(`${ONE_AUTO_BASE}/cartell/ncthistory/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }) : Promise.resolve(null),
    ]);

    const cartellData = await safeJson(cartellRes);
    const cartell = cartellData?.success === true ? cartellData.result : null;
    if (!cartell?.vehicle_registration_mark) {
      return NextResponse.json({ error: 'Vehicle not found in Irish register' }, { status: 404 });
    }

    const bregoRes = await fetch(
      `${ONE_AUTO_BASE}/brego/ireland/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_kms=${cleanMileage}`,
      { headers: oneAutoHeaders() }
    );
    console.log('[ROI BREGO STATUS]', bregoRes.status);
    const bregoText = await bregoRes.text();
    console.log('[ROI BREGO BODY]', bregoText);
    let bregoRaw = null;
    try { bregoRaw = bregoText ? JSON.parse(bregoText) : null; } catch {}

    const demandRaw   = await safeJson(demandRes);
    const pgRaw       = isPro     ? await safeJson(priceGuideRes) : null;
    const hpiRaw      = isHistory ? await safeJson(hpiRes)        : null;
    const nctRaw      = isHistory ? await safeJson(nctRes)        : null;

    const roiValuation    = extractApiResult(bregoRaw);
    const roiMarketDemand = extractApiResult(demandRaw);
    const roiPriceGuide   = isPro ? extractApiResult(pgRaw)  : null;
    const hpiData         = isHistory ? extractApiResult(hpiRaw) : null;
    const nctData         = isHistory ? extractApiResult(nctRaw) : null;

    const cc      = cartell.engine_capacity_cc ?? null;
    const nctDue  = cartell.nct_due_date ?? null;
    const nctStatus = nctDue ? (new Date(nctDue) > new Date() ? 'Valid' : 'Expired') : null;

    const roiPayload = {
      make:                    cartell.manufacturer_desc ?? null,
      model:                   cartell.model_desc ?? null,
      colour:                  cartell.colour ?? null,
      fuelType:                cartell.fuel_type_desc ?? null,
      engineSize:              cc ? `${cc}cc` : null,
      yearOfManufacture:       cartell.manufactured_year ?? null,
      motStatus:               nctStatus,
      nctExpiryDate:           nctDue,
      co2Emissions:            cartell.co2_gkm != null ? String(cartell.co2_gkm) : null,
      monthOfFirstRegistration: cartell.first_registration_ireland_date ?? cartell.first_registration_date ?? null,
      roiValuation,
      roiMarketDemand,
      roiPriceGuide,
      hpi:        hpiData,
      nctHistory: nctData,
      market:     'IE',
      roiTier:    roiTierParam,
    };

    await storeCachedResult(supabase, cleanVrm, roiCacheKey, roiPayload);
    return NextResponse.json(roiPayload);
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
        `${ONE_AUTO_BASE}/cartell/vehicleidentity?vehicle_registration_mark=${cleanVrm}`,
        { headers: oneAutoHeaders() }
      );
      const cartellData = await safeJson(cartellRes);
      const cartell = cartellData?.success === true ? cartellData.result : null;
      if (!cartell?.vehicle_registration_mark) {
        return NextResponse.json(
          { error: 'Vehicle not found in Irish register' },
          { status: 404 }
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

      const cc = cartell.engine_capacity_cc ?? null;
      const nctDue = cartell.nct_due_date ?? null;
      const nctStatus = nctDue ? (new Date(nctDue) > new Date() ? 'Valid' : 'Expired') : null;

      const payload = {
        make: cartell.manufacturer_desc ?? null,
        model: cartell.model_desc ?? null,
        colour: cartell.colour ?? null,
        fuelType: cartell.fuel_type_desc ?? null,
        engineSize: cc ? `${cc}cc` : null,
        yearOfManufacture: cartell.manufactured_year ?? null,
        taxStatus: null,
        taxDueDate: null,
        motStatus: nctStatus,
        nctExpiryDate: nctDue,
        co2Emissions: cartell.co2_gkm != null ? String(cartell.co2_gkm) : null,
        monthOfFirstRegistration: cartell.first_registration_ireland_date ?? cartell.first_registration_date ?? null,
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
      const needsSalvageHistory = checks.includes('salvagehistory');

      const dvlaMake = dvla.make?.toUpperCase() || '';
      const svcCoverage = needsServiceHistory ? (SERVICE_HISTORY_COVERAGE.get(dvlaMake) || null) : null;

      // Service history may need polling — start it first
      const svcHistoryPromise = (needsServiceHistory && svcCoverage !== null)
        ? fetchWithPolling(
            `${ONE_AUTO_BASE}/oneauto/servicehistory/?vehicle_registration_mark=${cleanVrm}`,
            { headers: oneAutoHeaders() }
          )
        : Promise.resolve(null);

      const [autocheckRes, bregoRes, cazAdvRes, cazDemRes, dvsaData, salvageHistoryRes] = await Promise.all([
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
        needsSalvageHistory
          ? fetch(`${ONE_AUTO_BASE}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
      ]);

      const autocheck = autocheckRes ? await safeJson(autocheckRes) : null;
      const valuation = bregoRes ? await safeJson(bregoRes) : null;
      const cazanaAdverts = cazAdvRes ? await safeJson(cazAdvRes) : null;
      const cazanaDemand = cazDemRes ? await safeJson(cazDemRes) : null;
      const motTests = dvsaData?.motTests || null;
      const salvageHistoryRaw = salvageHistoryRes ? await safeJson(salvageHistoryRes) : null;

      const svcRes = await svcHistoryPromise;
      const serviceHistory = svcRes ? await safeJson(svcRes) : null;

      const latestMot = motTests?.[0] || null;

      const payload = {
        make: dvla.make,
        model: dvsaData?.model || null,
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
        hasOutstandingRecall: dvsaData?.hasOutstandingRecall ?? null,
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
        salvageHistory: extractApiResult(salvageHistoryRaw),
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
