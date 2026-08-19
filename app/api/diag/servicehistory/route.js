// ⚠️ TEMPORARY DIAGNOSTIC ROUTE — DELETE BEFORE MERGING TO main.
//
// Added 19 Aug 2026 for one purpose: the service-history fix needs an OBSERVED 202→200 transition
// before the polling window (Task 4) can be sized. `ONE_AUTO_API_KEY` cannot be read out of Vercel
// (values are masked after creation), so the only way to make an authenticated call is from a
// deployed surface that already has the key in its environment. This route is that surface and
// nothing else.
//
// It exists in its own commit so removal is a single revert. It must not reach production.
//
// NOTE — the brief specified `app/api/_diag/servicehistory/`. That path produces NO ROUTE: Next.js
// App Router treats an underscore-prefixed folder as a private folder and excludes it from
// routing, silently. Built there, it returned 404 for every request including a correct token.
// Renamed to `app/api/diag/servicehistory/`. Obscurity was never the control here — the DIAG_TOKEN
// gate and Vercel SSO are — so the visible name costs nothing.
//
// Safety properties, all deliberate:
//   · gated on ?token= matching DIAG_TOKEN, with each failure state answering distinctly (401 /
//     403 / 500) so the route can diagnose itself. Preview's Vercel SSO is the second lock.
//   · SANDBOX by default and hardcoded — it does NOT inherit ONE_AUTO_BASE_URL, which on preview
//     points at live. Live requires an explicit ?base=live.
//   · no database write, no cache write, no Stripe, no refund logic, no logEvent. Read-only.
//   · never returns the API key, and never echoes request headers.
//   · returns metadata only — status, timing, success/error, a record count and per-event dates
//     and mileages. Never the full payload, never a VIN, never service_provider address data.

import { NextResponse } from 'next/server';

// The polling window is the measurement. Needs headroom well past the 90s ceiling below.
export const maxDuration = 120;

const SANDBOX = 'https://sandbox.oneautoapi.com';
const LIVE = 'https://api.oneautoapi.com';

const POLL_CEILING_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

const RECORD_KEYS = ['service_events', 'service_records', 'records'];

function recordCount(result) {
  if (!result || typeof result !== 'object') return null;
  for (const key of RECORD_KEYS) {
    if (Array.isArray(result[key])) return { key, count: result[key].length, events: result[key] };
  }
  return null;
}

// A count is not verification. `recordsLength: 6` told us the API returned six things; it could not
// tell us they were THIS car's service history. Dates and mileages let that be sanity-checked —
// roughly annual intervals, mileage climbing plausibly for the vehicle's age. Deliberately NOT
// service_provider: that is address data with no diagnostic value here.
function eventDigest(events) {
  if (!Array.isArray(events)) return null;
  return events.slice(0, 25).map(ev => ({
    date: ev?.date_of_service_event ?? ev?.service_date ?? ev?.date ?? null,
    mileage: ev?.mileage_observed ?? ev?.odometer_reading ?? ev?.mileage ?? null,
    mileageUnit: ev?.mileage_unit ?? ev?.odometer_unit ?? null,
    // Field names only, so an unexpected shape is visible without dumping the payload.
    fields: ev && typeof ev === 'object' ? Object.keys(ev).slice(0, 15) : null,
  }));
}

// Poll a single endpoint to a terminal status, recording the timing of every attempt. The per
// attempt trace IS the deliverable — Task 4 sizes the production polling window against it.
async function probe(label, url, apiKey) {
  const started = Date.now();
  const attempts = [];
  let res = null;

  while (Date.now() - started < POLL_CEILING_MS) {
    const t0 = Date.now();
    try {
      res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    } catch (err) {
      attempts.push({ at_ms: t0 - started, error: err.message });
      return { label, url: url.split('?')[0], outcome: 'fetch-threw', totalElapsedMs: Date.now() - started, attempts };
    }
    attempts.push({ at_ms: t0 - started, status: res.status, tookMs: Date.now() - t0 });
    if (res.status !== 202) break;
    if (Date.now() - started + POLL_INTERVAL_MS >= POLL_CEILING_MS) {
      return { label, url: url.split('?')[0], outcome: 'still-202-at-ceiling', totalElapsedMs: Date.now() - started, attempts };
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const totalElapsedMs = Date.now() - started;
  let bodyText = '';
  try { bodyText = await res.text(); } catch { /* empty body */ }

  let parsed = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }

  const result = parsed?.result ?? parsed ?? null;
  const counted = recordCount(result);

  return {
    label,
    url: url.split('?')[0],
    httpStatus: res.status,
    totalElapsedMs,
    attempts,
    // Body metadata ONLY — never the payload itself.
    success: parsed?.success ?? null,
    error: parsed?.result?.error ?? parsed?.error ?? null,
    recordsKey: counted?.key ?? null,
    recordsLength: counted?.count ?? null,
    events: eventDigest(counted?.events),
    topLevelKeys: result && typeof result === 'object' ? Object.keys(result).slice(0, 25) : null,
    bodyBytes: bodyText.length,
  };
}

// The link upstream of every fix on this branch. `ie_service_history` feeds Cartell's
// `vehicle_identification_number` into Ezyvin and is gated on that VIN being truthy — and nobody
// has ever observed it populated for an Irish vehicle. If Cartell returns it null, the Irish
// product cannot fire at all and the path, key and polling fixes are irrelevant to it.
// Reports PRESENCE ONLY. The VIN itself is never returned — it is display-restricted data and the
// production route scrubs it for exactly that reason.
// Returns { report, vin } — the VIN stays INSIDE this module. Callers may chain it into the next
// request but must never place it in the response. `report` is safe to return as-is.
async function fetchCartellIdentity(vrm, base, apiKey) {
  const url = `${base}/cartell/vehicleidentity?vehicle_registration_mark=${encodeURIComponent(vrm)}`;
  const label = 'IE step 1 — cartell/vehicleidentity (VIN presence only)';
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    const result = parsed?.result ?? null;
    const vin = result?.vehicle_identification_number ?? null;
    return {
      vin: typeof vin === 'string' && vin.trim() ? vin.trim() : null,
      report: {
        label,
        url: url.split('?')[0],
        httpStatus: res.status,
        elapsedMs: Date.now() - t0,
        success: parsed?.success ?? null,
        error: parsed?.result?.error ?? parsed?.error ?? null,
        vehicleFound: Boolean(result?.vehicle_registration_mark),
        vinPresent: Boolean(vin),
        vinLength: typeof vin === 'string' ? vin.length : null,
        // Both of these now drive the production 5b gate, so they are worth seeing.
        manufacturerDesc: result?.manufacturer_desc ?? null,
        manufacturedYear: result?.manufactured_year ?? null,
        bodyBytes: text.length,
      },
    };
  } catch (err) {
    return { vin: null, report: { label, url: url.split('?')[0], outcome: 'fetch-threw', error: err.message, elapsedMs: Date.now() - t0 } };
  }
}

async function probeCartellIdentity(vrm, base, apiKey) {
  const { report } = await fetchCartellIdentity(vrm, base, apiKey);
  return report;
}

// TASK 1c — the whole Irish product in one request, exactly as production runs it:
// Cartell identity → its VIN → ezyvin/servicehistory/. Test A with a UK VIN proves the corrected
// path and parameter name; only this proves an IRISH car has coverage. A null here is a coverage
// finding, not a plumbing one — and the two must not be confused.
//
// The VIN is extracted server-side, chained straight into step 2, and never returned.
async function probeIeFull(vrm, base, apiKey) {
  const { vin, report } = await fetchCartellIdentity(vrm, base, apiKey);
  const out = [report];

  if (!vin) {
    out.push({
      label: 'IE step 2 — ezyvin/servicehistory/ (SKIPPED)',
      skipped: 'Cartell returned no vehicle_identification_number, so there is nothing to look up. In production this is the `no_vin` skip: refundable, no call made.',
    });
    return out;
  }

  const step2 = await probe(
    'IE step 2 — ezyvin/servicehistory/ from the Cartell VIN (the real end-to-end Irish test)',
    `${base}/ezyvin/servicehistory/?vehicle_identification_number=${encodeURIComponent(vin)}`,
    apiKey,
  );
  out.push(step2);
  return out;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);

  // Three states that a bare 404 made indistinguishable — not deployed, wrong token, and
  // DIAG_TOKEN missing from the runtime — now answer differently. None of them advertises what
  // the route does; the token and Vercel SSO are the controls, obscurity never was. A bare
  // `Not Found` from this path now means one thing only: the route is not deployed.
  const expected = process.env.DIAG_TOKEN;
  const supplied = searchParams.get('token');
  if (!expected) {
    return NextResponse.json({ diag: 'DIAG_TOKEN not configured' }, { status: 500 });
  }
  if (!supplied) {
    // Also the signature of an SSO login round-trip having dropped the query string — authenticate
    // on the preview root first, then load this URL with its parameters intact.
    return NextResponse.json({ diag: 'token required' }, { status: 401 });
  }
  if (supplied !== expected) {
    return NextResponse.json({ diag: 'denied' }, { status: 403 });
  }

  const apiKey = process.env.ONE_AUTO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ diag: 'ONE_AUTO_API_KEY not present in this runtime' }, { status: 500 });
  }

  const vrm = (searchParams.get('vrm') || '').toUpperCase().replace(/\s/g, '');
  const vin = (searchParams.get('vin') || '').toUpperCase().replace(/\s/g, '');
  // Separate parameter, separate question — see TEST A / TEST B below.
  const ievrm = (searchParams.get('ievrm') || '').toUpperCase().replace(/\s/g, '');
  const iefull = (searchParams.get('iefull') || '').toUpperCase().replace(/\s/g, '');
  if (!vrm && !ievrm && !iefull) {
    return NextResponse.json({
      error: 'pass ?vrm=, ?ievrm= or ?iefull=.',
      params: {
        vrm: 'TEST A — GB endpoint + the retired-path controls.',
        vin: 'TEST A — ezyvin/servicehistory/ plumbing. Any VIN, a UK one is fine. This is the Europe-from-VIN endpoint, NOT an Irish one.',
        ievrm: 'TEST B — Irish registration. cartell/vehicleidentity, VIN PRESENCE only. Answers whether the Irish product can fire at all.',
        iefull: 'TEST C — Irish registration, CHAINED end to end: Cartell identity → its VIN → ezyvin/servicehistory/, as production runs it. Subsumes TEST A and TEST B. The VIN is never returned.',
        base: 'live | (default sandbox)',
      },
    }, { status: 400 });
  }

  // Sandbox unless live is asked for by name. Never inherits ONE_AUTO_BASE_URL.
  const live = searchParams.get('base') === 'live';
  const base = live ? LIVE : SANDBOX;

  const targets = [];
  if (vrm) {
    targets.push(['GB — ezyvin/servicehistoryfromvrm/ (the 2a fix)', `${base}/ezyvin/servicehistoryfromvrm/?vehicle_registration_mark=${encodeURIComponent(vrm)}`]);
  }
  if (vin) {
    // TEST A. Vendor name: "OE Service History (Europe) from VIN" — European coverage INCLUDING
    // non-EU markets such as the UK. Passing a UK VIN tests the 2b plumbing (corrected path +
    // corrected parameter name) and says nothing whatsoever about Irish coverage. Do not conflate.
    targets.push(['PLUMBING — ezyvin/servicehistory/ Europe-from-VIN (the 2b fix)', `${base}/ezyvin/servicehistory/?vehicle_identification_number=${encodeURIComponent(vin)}`]);
  }
  if (vrm) {
    targets.push(
      ['CONTROL — retired GB path, expect 404', `${base}/oneauto/servicehistory/?vehicle_registration_mark=${encodeURIComponent(vrm)}`],
      ['CONTROL — cartell/ncthistory/v1, expect 404', `${base}/cartell/ncthistory/v1?vehicle_registration_mark=${encodeURIComponent(vrm)}`],
    );
  }

  // Sequential, not parallel: concurrent calls would distort the timing profile this exists to measure.
  const results = [];
  for (const [label, url] of targets) {
    results.push(await probe(label, url, apiKey));
  }

  // TEST B — the separate question: can the Irish product fire at all?
  if (ievrm) {
    results.push(await probeCartellIdentity(ievrm, base, apiKey));
  }

  // TEST C — the chained end-to-end Irish product test.
  if (iefull) {
    results.push(...await probeIeFull(iefull, base, apiKey));
  }

  return NextResponse.json({
    warning: 'TEMPORARY DIAGNOSTIC ROUTE — must be deleted before merge to main.',
    base: live ? 'LIVE' : 'SANDBOX',
    billing: live
      ? '⚠️ LIVE. Service history: £2.50 per HTTP 200; every other status code is free. Vehicle Identity (Ireland) from VRM: 15p PrePay / 10p Business / 8p Enterprise — a call production already makes on every IE report, so not new spend. A full &iefull= run is therefore ~£2.65 if step 2 returns 200, 15p if it does not.'
      : 'SANDBOX — nothing chargeable.',
    // Carried from the 231T1905 comparison: sandbox returned NISSAN/2017 with the vendor's
    // documentation placeholder error string, where live returned VOLKSWAGEN/2023, error null.
    // A fixture that passes both the make gate and the MY-2012 floor proves nothing about either.
    sandboxCaveat: live ? null : 'SANDBOX VALIDATES SHAPE ONLY, NEVER COVERAGE — it serves fixtures. Treat make, year, record counts and dates from a sandbox run as meaningless.',
    vrm: vrm || null,
    vinSupplied: Boolean(vin),
    ieVrm: ievrm || null,
    ieFullVrm: iefull || null,
    pollCeilingMs: POLL_CEILING_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    results,
  });
}
