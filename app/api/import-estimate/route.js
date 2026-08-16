import { NextResponse } from 'next/server';
import { estimateImportPresentation } from '@/lib/importCost';

// ── Free "VRT magnet" — Tier 1 of the Import to Ireland funnel ────────────────
// DVLA-only (CO2 / fuel / year / euroStatus), no One Auto, no Brego, no Stripe → ~£0/use.
// OMSP = the user's own purchase price, used DIRECTLY as a FLOOR (Revenue's Irish OMSP is
// usually higher), so the figure is honestly a floor and drives the €9.99 upgrade. Shares the
// SAME engine (estimateImportCostRange) as the paid check — only the OMSP source differs.

// Light in-memory per-IP limiter — abuse protection only (the call costs ~£0, so the cap is
// generous). Per-instance, resets on cold start; a DB-backed per-IP/day limit (mirroring
// free_report_requests) is the hardening path if abuse appears — needs a migration.
const RL = new Map();
const RL_MAX = 40;                 // requests / window / IP
const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
function rateOk(request) {
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const e = RL.get(ip);
  if (!e || now > e.reset) { RL.set(ip, { n: 1, reset: now + RL_WINDOW_MS }); return true; }
  if (e.n >= RL_MAX) return false;
  e.n++; return true;
}

// Euro standard from year + fuel when DVLA has no discrete euroStatus. Biased so as NOT to
// under-state NOx (older/higher-NOx assumption on the boundary) — the free tier errs high.
function euroFromYear(year) {
  const y = parseInt(year, 10);
  if (!Number.isFinite(y)) return null;
  if (y >= 2016) return 6;   // Euro 6 mandatory for all new registrations from Sep 2015
  if (y >= 2011) return 5;
  if (y >= 2006) return 4;
  if (y >= 2001) return 3;
  return 2;
}

export async function GET(request) {
  if (!rateOk(request)) {
    return NextResponse.json({ error: 'Too many requests — please try again shortly.' }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const vrm = (searchParams.get('vrm') || '').toUpperCase().replace(/\s/g, '');
  if (!vrm) return NextResponse.json({ error: 'Enter the registration of the car you want to import.' }, { status: 400 });

  const rawSeller = (searchParams.get('seller_type') || '').toLowerCase();
  const sellerType = ['private', 'dealer', 'pre2021', 'gb'].includes(rawSeller)
    ? rawSeller
    : ((searchParams.get('provenance') || 'GB').toUpperCase() === 'NI' ? 'pre2021' : 'gb');
  const purchasePrice = parseInt((searchParams.get('purchase_price') || searchParams.get('price') || '0').replace(/[^\d]/g, ''), 10) || null;
  const noxRaw = searchParams.get('nox');
  const noxOverride = (noxRaw != null && noxRaw !== '') ? Number(noxRaw) : undefined;

  // DVLA Vehicle Enquiry Service — the free data source (same one the free GB lookup uses).
  let dvla = null;
  try {
    const r = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
      method: 'POST',
      headers: { 'x-api-key': process.env.DVLA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationNumber: vrm }),
    });
    if (r.ok) dvla = await r.json();
  } catch (e) {
    console.error('[IMPORT ESTIMATE] DVLA lookup failed:', e.message);
  }
  if (!dvla || !dvla.make) {
    return NextResponse.json({ error: "We couldn't find that registration with the DVLA — check it and try again." }, { status: 404 });
  }

  const euroClass = dvla.euroStatus || euroFromYear(dvla.yearOfManufacture);
  // Free tier: purchase price IS the OMSP, used as a floor (no range — low = avg = high).
  // Same presentation wrapper as the paid check — single or dual by sellerType.
  const estimate = estimateImportPresentation({
    sellerType,
    omspLow: purchasePrice, omspAvg: purchasePrice, omspHigh: purchasePrice,
    co2: dvla.co2Emissions, euroClass, fuel: dvla.fuelType, noxOverride, purchasePrice,
  });

  return NextResponse.json({
    tier: 'free',
    floor: true,
    vehicle: {
      make: dvla.make,
      colour: dvla.colour ?? null,
      year: dvla.yearOfManufacture ?? null,
      fuel: dvla.fuelType ?? null,
      co2: dvla.co2Emissions ?? null,
      euro: euroClass ?? null,
    },
    estimate,
  });
}
