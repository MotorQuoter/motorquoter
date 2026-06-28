import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getDvsaMotHistory } from '@/lib/dvsa';
import { isRoiPlate, formatRoiVrm } from '@/lib/roiPlate';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';

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
    const { data, error } = await supabase
      .from('reg_lookup_cache')
      .select('*')
      .eq('reg_plate', cleanVrm)
      .eq('tier', cacheKey)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[CACHE READ] reg_lookup_cache failed: ${error.code} ${error.message}`);
    }
    return data || null;
  } catch (err) {
    console.error('[CACHE READ] threw:', err.message);
    return null;
  }
}

async function storeCachedResult(supabase, cleanVrm, cacheKey, payload) {
  try {
    const { error } = await supabase
      .from('reg_lookup_cache')
      .upsert(
        { reg_plate: cleanVrm, tier: cacheKey, payload, created_at: new Date().toISOString() },
        { onConflict: 'reg_plate,tier' }
      );
    if (error) console.error(`[CACHE WRITE] reg_lookup_cache failed: ${error.code} ${error.message}`);
  } catch (err) {
    console.error('[CACHE WRITE] threw:', err.message);
  }
}

const oneAutoHeaders = () => ({ 'x-api-key': process.env.ONE_AUTO_API_KEY });

const FREE_RATE_LIMIT = 10;
const FREE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const freeRateLimitMap = new Map();

function checkFreeRateLimit(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
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
  const mileage = searchParams.get('mileage') || '';
  const market = (searchParams.get('market') || 'GB').toUpperCase();
  const tier = searchParams.get('tier');
  const paymentIntentId = searchParams.get('paymentIntentId') || null;

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
    // IE has no free tier — reject early so the paid Cartell endpoint is never called without payment
    if (isRoiPlate(cleanVrm) || market === 'IE') {
      return NextResponse.json({ error: 'Free lookups are not available for Irish-registered vehicles' }, { status: 400 });
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
        typeApproval: dvla.typeApproval || '',
        wheelplan: dvla.wheelplan || '',
        revenueWeight: dvla.revenueWeight ?? null,
        market: 'GB',
        tier: 'free',
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      logEvent('lookup_submitted', { vrm: cleanVrm, tier: 'free', market: 'GB' });
      return NextResponse.json(payload);
    } catch (err) {
      console.error('DVLA lookup error:', err);
      return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
    }
  }

  // ── PAID LOOKUP ──────────────────────────────────────────────────────────────
  const checksParam = searchParams.get('checks') || '';
  const checks = checksParam.split(',').map(s => s.trim()).filter(Boolean);
  const roiTierParam = searchParams.get('roiTier');

  if (checks.length === 0 && !roiTierParam) {
    return NextResponse.json({ error: 'No checks specified' }, { status: 400 });
  }

  // ── Payment verification — server-side Stripe truth (replaces the spoofable verified=true) ──
  // Mirrors the salvage/assess in-route retrieve (assess/route.js:2080-2087): retrieve the checkout
  // session, require payment_status==='paid', then bind the paid scope to this request — exact VRM
  // match + requested checks (GB) / roiTier (IE) ⊆ paid metadata — and replay-bind so one session
  // can't trigger the paid One Auto fan-out more than once at this route. NO query param
  // (verified / tier) is trusted; the Stripe session is the only proof of payment. Every paid call
  // downstream (GB autocheck/brego/previousadverts/marketdemand/salvagecheck; ROI cartell/percayso;
  // IE cartell/brego-ie) sits behind this block — none in front.
  const stripeSessionId = searchParams.get('session_id');
  if (!stripeSessionId) {
    return NextResponse.json({ error: 'Unauthorised — payment session required' }, { status: 401 });
  }
  let paidSession;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    paidSession = await stripe.checkout.sessions.retrieve(stripeSessionId);
  } catch (stripeErr) {
    console.warn('[VEHICLE AUTH] session retrieve failed:', stripeErr.message);
    return NextResponse.json({ error: 'Payment could not be verified' }, { status: 401 });
  }
  if (paidSession?.payment_status !== 'paid') {
    return NextResponse.json({ error: 'Payment not confirmed' }, { status: 402 });
  }
  // Exact VRM match — normalise the paid VRM the SAME way as cleanVrm (toUpperCase + strip spaces).
  const paidVrm = (paidSession.metadata?.vrm || '').toUpperCase().replace(/\s/g, '');
  if (!paidVrm || paidVrm !== cleanVrm) {
    console.warn(`[VEHICLE AUTH] VRM mismatch — paid=${paidVrm || '∅'} requested=${cleanVrm}`);
    return NextResponse.json({ error: 'Payment does not match this vehicle' }, { status: 403 });
  }
  // Checks / tier subset — every requested check (GB) or the roiTier (IE) must be covered by what
  // the session actually paid for. A requested item absent from the paid metadata → reject.
  if (market === 'IE' && roiTierParam) {
    if ((paidSession.metadata?.roiTier || '') !== roiTierParam) {
      console.warn(`[VEHICLE AUTH] roiTier not covered — paid=${paidSession.metadata?.roiTier || '∅'} requested=${roiTierParam}`);
      return NextResponse.json({ error: 'Requested tier not covered by payment' }, { status: 403 });
    }
  } else {
    const paidChecks = (paidSession.metadata?.checks || '').split(',').map(s => s.trim()).filter(Boolean);
    const unpaid = checks.filter(c => !paidChecks.includes(c));
    if (unpaid.length > 0) {
      console.warn(`[VEHICLE AUTH] checks not covered — unpaid=[${unpaid.join(',')}] paid=[${paidChecks.join(',')}]`);
      return NextResponse.json({ error: 'Requested checks not covered by payment' }, { status: 403 });
    }
  }
  // Replay binding — DISTINCT namespaced key (`vehicle:<id>`) so it never collides with
  // /api/stripe/verify's plain-session_id record in used_sessions (already consumed at
  // payment-success). The legitimate FIRST /api/vehicle call after payment-success is therefore
  // never false-rejected; a SECOND call with the same session (only reachable by replay — the
  // success page can't re-verify a single-use session) hits the PK unique constraint → 403, before
  // any paid call.
  const vehicleBindKey = `vehicle:${stripeSessionId}`;
  {
    const { data: bound } = await supabase
      .from('used_sessions')
      .select('session_id')
      .eq('session_id', vehicleBindKey)
      .maybeSingle();
    if (bound) {
      return NextResponse.json({ error: 'This payment has already been used for a lookup' }, { status: 403 });
    }
    const { error: bindErr } = await supabase
      .from('used_sessions')
      .insert({ session_id: vehicleBindKey });
    if (bindErr?.code === '23505') {
      return NextResponse.json({ error: 'This payment has already been used for a lookup' }, { status: 403 });
    }
    if (bindErr) {
      console.error('[VEHICLE AUTH] replay-bind insert error (non-fatal):', bindErr.message);
    }
  }
  console.log(`[VEHICLE AUTH] verified session=${stripeSessionId.slice(0, 14)}… vrm=${cleanVrm} scope=${market === 'IE' && roiTierParam ? `roiTier:${roiTierParam}` : `checks:[${checks.join(',')}]`}`);

  // ── ROI TIER PAID PATH ───────────────────────────────────────────────────────
  if (market === 'IE' && roiTierParam) {
    const isPro = ['roi_pro', 'roi_history'].includes(roiTierParam);
    const isHistory = roiTierParam === 'roi_history';
    const roiCacheKey = `roi:${roiTierParam}`;

    const roiCached = await getCachedResult(supabase, cleanVrm, roiCacheKey);
    if (roiCached) {
      return NextResponse.json({ ...roiCached.payload, _cached: true, _cachedAt: roiCached.created_at });
    }

    const roiMileage = parseInt((searchParams.get('mileage') || '0').replace(/,/g, ''), 10);

    const [cartellRes, demandRes, priceGuideRes, hpiRes, nctRes] = await Promise.all([
      fetch(`${ONE_AUTO_BASE}/cartell/vehicleidentity?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }),
      fetch(`${ONE_AUTO_BASE}/percayso/marketdemandfromvrm/?vrm=${cleanVrm}`, { headers: oneAutoHeaders() }),
      fetch(`${ONE_AUTO_BASE}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}&current_mileage=${roiMileage}&mileage_unit=km`, { headers: oneAutoHeaders() }),
      isHistory ? fetch(`${ONE_AUTO_BASE}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }) : Promise.resolve(null),
      isHistory ? fetch(`${ONE_AUTO_BASE}/cartell/ncthistory/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() }) : Promise.resolve(null),
    ]);

    const cartellData = await safeJson(cartellRes);
    const cartell = cartellData?.success === true ? cartellData.result : null;
    if (!cartell?.vehicle_registration_mark) {
      return NextResponse.json({ error: 'Vehicle not found in Irish register' }, { status: 404 });
    }

    const demandRaw   = await safeJson(demandRes);
    const pgRaw       = await safeJson(priceGuideRes);
    const hpiRaw      = isHistory ? await safeJson(hpiRes)        : null;
    const nctRaw      = isHistory ? await safeJson(nctRes)        : null;

    const roiPriceGuide   = extractApiResult(pgRaw);
    const roiValuation    = roiPriceGuide ? {
      retail: roiPriceGuide.retail_valuation ?? null,
      trade:  roiPriceGuide.trade_valuation  ?? null,
    } : null;
    const roiMarketDemand = extractApiResult(demandRaw);
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
    logEvent('report_viewed', { vrm: cleanVrm, tier: roiTierParam, market: 'IE' });
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
      const roiMileage = parseInt((searchParams.get('mileage') || '0').replace(/,/g, ''), 10);
      const needsValuation      = checks.includes('ie_valuation');
      const needsNct            = checks.includes('ie_nct');
      const needsServiceHistory = checks.includes('ie_service_history');
      const needsHistory        = checks.includes('ie_history');

      // Cartell identity — always fetched; provides base vehicle data and VIN
      const cartellRes = await fetch(
        `${ONE_AUTO_BASE}/cartell/vehicleidentity?vehicle_registration_mark=${cleanVrm}`,
        { headers: oneAutoHeaders() }
      );
      const cartellData = await safeJson(cartellRes);
      const cartell = cartellData?.success === true ? cartellData.result : null;
      if (!cartell?.vehicle_registration_mark) {
        return NextResponse.json({ error: 'Vehicle not found in Irish register' }, { status: 404 });
      }

      const vin = cartell.vehicle_identification_number ?? null;

      // Start polling calls before awaiting non-polling calls
      const svcHistoryPromise = (needsServiceHistory && vin)
        ? fetchWithPolling(
            `${ONE_AUTO_BASE}/oneauto/servicehistory/?vin=${vin}`,
            { headers: oneAutoHeaders() }
          )
        : Promise.resolve(null);

      const historyPromise = needsHistory
        ? fetchWithPolling(
            `${ONE_AUTO_BASE}/cartell/vehiclehistorycheck/?vehicle_registration_mark=${cleanVrm}&current_mileage=${roiMileage}`,
            { headers: oneAutoHeaders() }
          )
        : Promise.resolve(null);

      // Non-polling calls in parallel
      const [nctHistoryRes, bregoRoiRes] = await Promise.all([
        // Cartell Price Guide — commented out; Brego is sole ROI valuation provider
        // needsValuation
        //   ? fetch(`${ONE_AUTO_BASE}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}&current_mileage=${roiMileage || 50000}&mileage_unit=km`, { headers: oneAutoHeaders() })
        //   : Promise.resolve(null),
        needsNct
          ? fetch(`${ONE_AUTO_BASE}/cartell/ncthistory/v1?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsValuation
          ? fetch(`${ONE_AUTO_BASE}/brego/ireland/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_kms=${roiMileage || 50000}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
      ]);

      // Await polling results
      const [svcRes, historyRes] = await Promise.all([svcHistoryPromise, historyPromise]);

      // Parse
      const nctRaw    = nctHistoryRes  ? await safeJson(nctHistoryRes)  : null;
      const svcRaw    = svcRes         ? await safeJson(svcRes)         : null;
      const histRaw   = historyRes     ? await safeJson(historyRes)     : null;
      const bregoRoiRaw  = bregoRoiRes  ? await safeJson(bregoRoiRes)   : null;
      const bregoRoiData = bregoRoiRaw  ? extractApiResult(bregoRoiRaw) : null;

      // const roiValuation = pgData ? {   // Cartell Price Guide — commented out
      //   retail: pgData.retail_valuation ?? null,
      //   trade:  pgData.trade_valuation  ?? null,
      // } : null;
      const bregoRoi = bregoRoiData ? {
        retailLow:  bregoRoiData.retail_low_valuation     ?? null,
        retailAvg:  bregoRoiData.retail_average_valuation ?? null,
        retailHigh: bregoRoiData.retail_high_valuation    ?? null,
        tradeLow:   bregoRoiData.trade_low_valuation      ?? null,
        tradeAvg:   bregoRoiData.trade_average_valuation  ?? null,
        tradeHigh:  bregoRoiData.trade_high_valuation     ?? null,
        currency:   bregoRoiData.currency_unit            ?? null,
      } : null;
      const nctHistory   = nctRaw  ? extractApiResult(nctRaw)  : null;
      const serviceHistory = svcRaw ? extractApiResult(svcRaw) : null;
      const ieHistory    = histRaw ? extractApiResult(histRaw) : null;

      const svcEmpty = needsServiceHistory && (!serviceHistory || !serviceHistory.records || serviceHistory.records.length === 0);
      const serviceHistoryRefunded = svcEmpty && !!paymentIntentId;
      if (serviceHistoryRefunded) {
        const refundAmount = 500;
        fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId, amount: refundAmount }),
        });
      }

      const cc     = cartell.engine_capacity_cc ?? null;
      const nctDue = cartell.nct_due_date ?? null;
      const nctStatus = nctDue ? (new Date(nctDue) > new Date() ? 'Valid' : 'Expired') : null;

      const payload = {
        make:                     cartell.manufacturer_desc ?? null,
        model:                    cartell.model_desc ?? null,
        colour:                   cartell.colour ?? null,
        fuelType:                 cartell.fuel_type_desc ?? null,
        engineSize:               cc ? `${cc}cc` : null,
        yearOfManufacture:        cartell.manufactured_year ?? null,
        motStatus:                nctStatus,
        nctExpiryDate:            nctDue,
        co2Emissions:             cartell.co2_gkm != null ? String(cartell.co2_gkm) : null,
        monthOfFirstRegistration: cartell.first_registration_ireland_date ?? cartell.first_registration_date ?? null,
        // roiValuation,  // Cartell Price Guide — commented out; Brego is sole ROI valuation provider
        bregoRoi,
        nctHistory,
        serviceHistory,
        ieHistory,
        serviceHistoryRefunded,
        market: 'IE',
        checks,
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      logEvent('report_viewed', { vrm: cleanVrm, tier: checks.join(','), market: 'IE' });
      return NextResponse.json(payload);

    } else {
      // ── GB PAID PATH ──────────────────────────────────────────────────────────
      if (market === 'IE') {
        return NextResponse.json({ error: 'Irish plates must use IE market path' }, { status: 400 });
      }
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

      // ── Brego mileage: user-entered → DVSA last MOT → 50,000 default ────────────
      const userMileageRaw = mileage.replace(/,/g, '');
      const userMileageNum = parseInt(userMileageRaw, 10);
      const userMileageValid = !isNaN(userMileageNum) && userMileageNum >= 1 && userMileageNum <= 999999;
      const needsDvsaFirst = needsValuation && !userMileageValid;

      let earlyDvsaData = null;
      if (needsDvsaFirst) {
        earlyDvsaData = await getDvsaMotHistory(cleanVrm).catch(() => null);
      }

      const { mileage: bregoMileage, source: bregoMileageSource } = getMileageForValuation({
        formMileage: userMileageValid ? userMileageNum : null,
        dvsaMileage: earlyDvsaData?.motTests?.[0]?.odometerValue ?? null,
        formMileageSource: 'user_entered',
      });

      const [autocheckRes, bregoRes, cazAdvRes, cazDemRes, dvsaData, salvageHistoryRes] = await Promise.all([
        needsAutocheck
          ? fetch(`${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsValuation
          ? fetch(`${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${bregoMileage}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsPreviousAdverts
          ? fetch(`${ONE_AUTO_BASE}/percayso/previousadvertsfromvrm/?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        needsMarketDemand
          ? fetch(`${ONE_AUTO_BASE}/percayso/marketdemandfromvrm/?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        (needsMot && !needsDvsaFirst) ? getDvsaMotHistory(cleanVrm) : Promise.resolve(earlyDvsaData),
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
      const serviceHistoryData = extractApiResult(serviceHistory);

      const svcEmpty = needsServiceHistory && (!serviceHistoryData || !serviceHistoryData.records || serviceHistoryData.records.length === 0);
      const serviceHistoryRefunded = svcEmpty && !!paymentIntentId;
      if (serviceHistoryRefunded) {
        const refundAmount = 349;
        fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentIntentId, amount: refundAmount }),
        });
      }

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
        typeApproval: dvla.typeApproval || '',
        wheelplan: dvla.wheelplan || '',
        revenueWeight: dvla.revenueWeight ?? null,
        hasOutstandingRecall: dvsaData?.hasOutstandingRecall ?? null,
        autocheck: autocheck?.result || null,
        valuation: valuation?.result || null,
        motExpiryDate: latestMot?.expiryDate || null,
        motMileage: latestMot?.odometerValue || null,
        motResult: latestMot?.testResult || null,
        motHistory: motTests || null,
        cazanaAdverts: cazanaAdverts?.error ? null : cazanaAdverts,
        cazanaDemand: extractApiResult(cazanaDemand),
        serviceHistory: serviceHistoryData,
        serviceHistoryCoverage: svcCoverage,
        salvageHistory: extractApiResult(salvageHistoryRaw),
        serviceHistoryRefunded,
        market: 'GB',
        checks,
        valuationMileage: needsValuation ? bregoMileage : null,
        valuationMileageSource: needsValuation ? bregoMileageSource : null,
        valuationMileageDate: (needsValuation && bregoMileageSource === 'dvsa_mot') ? (latestMot?.completedDate || null) : null,
        dvsaLastMileage: latestMot?.odometerValue || null,
        dvsaLastMileageDate: latestMot?.completedDate || null,
      };

      await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      logEvent('report_viewed', { vrm: cleanVrm, tier: checks.join(','), market: 'GB' });
      return NextResponse.json(payload);
    }

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}
