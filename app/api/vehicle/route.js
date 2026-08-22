import { NextResponse, after } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getDvsaMotHistory } from '@/lib/dvsa';
import { isRoiPlate, formatRoiVrm } from '@/lib/roiPlate';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';
import { checkMileageTimeline } from '@/lib/mileageCheck';
import { summariseOwnerHistory, summarisePlateChanges } from '@/lib/ownerHistory';
import { estimateRoadTax } from '@/lib/roadTax';
import { SERVICE_HISTORY_COVERAGE } from '@/config/serviceHistoryCoverage';
import { needsAutocheck as autocheckNeeded } from '@/lib/menuGate';
import { sendOpsAlert } from '@/lib/opsAlert';
import { readStoredReport, writeStoredReport } from '@/lib/paidReports';
import { dispatchReportEmail } from '@/lib/email.mjs';
import { mileageCacheKeyPart } from '@/lib/valuationCacheKey.mjs';
import {
  classifyServiceHistory,
  normaliseServiceEvents,
  serviceHistoryNotAttempted,
  shouldRefundServiceHistory,
  isUncacheableServiceHistory,
  cachedServiceHistoryOutcome,
} from '@/lib/serviceHistory';
import { PRICING, IE_MENU } from '@/config/pricing';

// Explicit, was inherited. Confirmed from the project's own resource config rather than assumed:
// plan `pro`, `fluid: true`, `functionDefaultTimeout: 300` — so this route already had a 300s
// ceiling, not the 10–15s a classic-serverless default would have given it. Declared anyway,
// because the service-history call is now allowed to poll for up to 60s (see SERVICE_HISTORY_POLL)
// and that headroom must not depend on a project-level default nobody set deliberately. A Vercel
// hard kill at the ceiling bypasses try/catch (see assess/route.js:2838) and would land as exactly
// the kind of silent null this whole branch exists to eliminate. Matches app/api/salvage/*.
export const maxDuration = 300;

// Free mileage/clocking verdict from the DVSA MOT timeline (already pulled — no new cost).
// Returns the one-line verdict + status only; the full reading-by-reading timeline is the paid
// `mileage_detail` add-on. `null` when there is nothing worth surfacing (insufficient readings).
function buildMileageVerdict(motTests, opts = {}) {
  const m = checkMileageTimeline(motTests || [], opts);
  if (m.status === 'insufficient') return null;
  return { status: m.status, verdict: m.verdict, mixedUnits: m.mixedUnits, readingCount: m.readingCount,
    hasRollback: m.hasRollback, enteredQuery: m.enteredQuery, enteredBelowMot: m.enteredBelowMot, enteredAboveRate: m.enteredAboveRate };
}

// ── VIN scrub (DVLA display condition) ────────────────────────────────────────
// The One Auto vehicleandmodeldetailsfromvrm response carries the full VIN. We only extract
// keeper/plate data from it, but the VIN must NEVER reach a client-readable field, so we mask it
// in place on the raw parsed response before any downstream use — belt-and-braces defence.
const VIN_KEY = /vehicle_identification_number|^vin$/i;
const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/i;
function scrubVin(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && (VIN_KEY.test(k) || VIN_SHAPE.test(v.trim()))) {
      node[k] = v.trim().length >= 5 ? `…${v.trim().slice(-5)}` : null;
    } else if (v && typeof v === 'object') {
      scrubVin(v, depth + 1);
    }
  }
  return node;
}

// Find the first array value whose key matches `keyRe` anywhere in a nested object (One Auto nests
// keeper_change_list under result.vehicle_details.*; the plate list's exact nesting is unconfirmed).
function deepFindArray(node, keyRe, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  for (const [k, v] of Object.entries(node)) {
    if (keyRe.test(k) && Array.isArray(v)) return v;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const found = deepFindArray(v, keyRe, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Service-history auto-refund amount, CHARGE-DERIVED (never a hardcoded GBP figure): read the
// actual amount charged for the "Service History" line from the Stripe session, in ITS currency,
// so a EUR purchase refunds the EUR sum (€5.99) and a GBP one refunds £5.00/£3.49 — drift-proof
// if list prices change. Fallback (no distinct line, e.g. a promo-collapsed basket): the config
// list price in the SESSION's currency — still never a hardcoded GBP amount on a EUR charge.
async function deriveServiceHistoryRefund(stripe, stripeSessionId, paidSession) {
  const currency = (paidSession?.currency || 'gbp').toLowerCase();
  try {
    const li = await stripe.checkout.sessions.listLineItems(stripeSessionId, { limit: 100 });
    const svc = li.data.find(l => /service history/i.test(l.description || ''));
    if (svc && svc.amount_total > 0) {
      return { amount: svc.amount_total, currency: (svc.currency || currency).toLowerCase() };
    }
  } catch (e) {
    console.warn('[SVC REFUND] line-item read failed:', e.message);
  }
  const isIE = (paidSession?.metadata?.market || 'GB') === 'IE';
  const eur = currency === 'eur';
  const cfg = isIE ? IE_MENU.find(i => i.key === 'ie_service_history') : PRICING.menu.find(i => i.key === 'service_history');
  const price = eur ? (cfg?.priceEUR ?? cfg?.price) : cfg?.price;
  return { amount: Math.round((price ?? 0) * 100), currency };
}

// Execute the service-history refund IN-PROCESS via the Stripe SDK — the SAME client (hence key
// and mode) that read the line items, so charge-mode and refund-mode cannot diverge. Awaited;
// success logs the re_ id, failure logs the Stripe error. Replaces the env-resolved
// cross-service fetch to NEXT_PUBLIC_APP_URL/api/refund (deleted) whose outcome was invisible.
async function executeServiceHistoryRefund(stripe, paymentIntentId, refund) {
  try {
    // Idempotency (mandatory — refund is now evaluated on EVERY invocation incl. cache hits and
    // client re-fetches): if a refund of this amount already exists on the payment intent, reuse
    // it. Guarantees one refund per charge however many times the payload is fetched. Inside the
    // helper so no caller can bypass it.
    const existing = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const dup = existing.data.find(r => r.amount === refund.amount);
    if (dup) {
      console.log(`[SVC REFUND] idempotent ${dup.id} (already refunded) — ${refund.currency} ${refund.amount} (paymentIntent ${paymentIntentId})`);
      return { ok: true, refundId: dup.id };
    }
    const r = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: refund.amount });
    console.log(`[SVC REFUND] executed ${r.id} — ${refund.currency} ${refund.amount} (paymentIntent ${paymentIntentId})`);
    return { ok: true, refundId: r.id };
  } catch (err) {
    console.error(`[SVC REFUND] FAILED — ${refund.currency} ${refund.amount} (paymentIntent ${paymentIntentId}): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Single evaluation of the service-history refund — called by the fresh IE, fresh GB, AND
// cache-hit paths so they cannot drift. Refund state is NEVER cached: vehicle data may be
// replayed from cache, but the refund verdict is computed live for every invocation, against the
// retrieved session's own payment_intent (mode-matched), and idempotent via executeServiceHistoryRefund.
// `outcome` is the discriminated result from fetchServiceHistory (or, on a cache hit, the outcome
// reconstructed from the stored payload). REFUND ON 'empty' ONLY — a provider error or an
// unanswered poll is not an empty result, and must never silently refund: the customer keeps their
// report with service history marked unavailable, and the failure is logged with its status code.
// No paidSession / payment_intent → no attempt → all-false → render falls to plain "not found".
async function evaluateServiceHistoryRefund(stripe, paidSession, stripeSessionId, outcome, needsServiceHistory) {
  const out = { serviceHistoryRefunded: false, serviceHistoryRefund: null, serviceHistoryRefundFailed: false };
  const svcEmpty = needsServiceHistory && shouldRefundServiceHistory(outcome);
  const refundTarget = typeof paidSession?.payment_intent === 'string' ? paidSession.payment_intent : paidSession?.payment_intent?.id ?? null;
  if (!svcEmpty || !refundTarget) return out;
  const refund = await deriveServiceHistoryRefund(stripe, stripeSessionId, paidSession);
  const result = await executeServiceHistoryRefund(stripe, refundTarget, refund);
  if (result.ok) {
    out.serviceHistoryRefunded = true;
    out.serviceHistoryRefund = { ...refund, refundId: result.refundId };
  } else {
    out.serviceHistoryRefundFailed = true;
  }
  return out;
}

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

// Poll budget for service history ONLY (Task 4). Sized against an observed live trace, not a
// guess: GY67LLD returned 200 after 13,192 ms — 202 at 0 / 2456 / 4649 / 6806 / 8933 / 11062 ms,
// then the payload. The old default (5 × 1500 = 7,500 ms) abandoned that call during its fifth
// 202, ~5.7s early, returned null and refunded. 30 × 2000 = 60s gives ~4.5× the one completion we
// have measured, and one sample is not a distribution. The 2s interval matches the vendor's own
// observed cadence. Well inside the 300s function ceiling declared above.
//
// Deliberately NOT applied to fetchWithPolling's default: cartell/vehiclehistorycheck is the other
// caller and its timing profile is unmeasured. Per call site, as briefed.
const SERVICE_HISTORY_POLL = { maxAttempts: 30, intervalMs: 2000 };

async function fetchWithPolling(url, options, { maxAttempts = 5, intervalMs = 1500 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, options);
    if (res.status !== 202) return res;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Service history fetch: IO + logging + alert. The outcome model itself lives in
// lib/serviceHistory.mjs so it can be unit-tested without a network, a provider or Stripe.
//
// Until 19 Aug 2026 this returned a bare Response and nine documented vendor status codes
// collapsed into one null, which meant "no records", which auto-refunded the customer. Failure is
// now distinguishable from emptiness, and only emptiness is allowed to spend money.
async function fetchServiceHistory(url, options, pollOptions) {
  // Elapsed time is logged on EVERY outcome, not just failures. Two live samples came in at 271 ms
  // and 13,192 ms — a 48× spread — so the 60s window is sized against a distribution we do not
  // have. This line is how one accumulates: grep [SVC HISTORY] in the logs and the real profile
  // builds itself from production traffic instead of from two data points.
  const startedAt = Date.now();

  // Every error return goes through here: one log line carrying the status code, and one throttled
  // ops alert. Awaited (Vercel does not guarantee post-response work runs) and time-boxed inside
  // sendOpsAlert, which never throws. Query string stripped — a VIN must not travel to an inbox.
  const fail = async (outcome, logLine) => {
    console.error(`[SVC HISTORY] error after ${Date.now() - startedAt}ms — ${logLine}`);
    await sendOpsAlert(
      'service_history_failure',
      'MotorQuoter — service history call failed',
      `Service history provider call failed.<br>Endpoint: ${url.split('?')[0]}<br>HTTP status: ${outcome.httpStatus ?? 'n/a'}<br>Detail: ${String(outcome.detail ?? '').slice(0, 300)}<br><br>The customer was NOT auto-refunded — the report renders with service history marked unavailable.`
    );
    return outcome;
  };

  let res;
  try {
    res = await fetchWithPolling(url, options, pollOptions);
  } catch (err) {
    return fail(classifyServiceHistory({ httpStatus: 0, detail: err.message }), `fetch threw — ${err.message} (${url})`);
  }

  // fetchWithPolling exhausts its attempts on a sustained 202 and returns null. That is the
  // provider still working, NOT an empty result — distinct log line, no refund, no alert storm.
  if (!res) {
    console.error(`[SVC HISTORY] pending after ${Date.now() - startedAt}ms — 202 polling exhausted, provider did not answer inside the polling window (${url})`);
    return classifyServiceHistory({ exhausted: true });
  }

  if (res.status !== 200) {
    let body = '';
    try { body = (await res.text()).slice(0, 500); } catch { /* body already consumed or empty */ }
    return fail(
      classifyServiceHistory({ httpStatus: res.status, detail: body }),
      `HTTP ${res.status} ${url} :: ${body.replace(/\s+/g, ' ')}`
    );
  }

  let raw;
  try {
    raw = await safeJson(res);
  } catch (err) {
    return fail(
      classifyServiceHistory({ httpStatus: 200, detail: `unparseable body: ${err.message}` }),
      `HTTP 200 with unparseable body: ${err.message} (${url})`
    );
  }

  const result = extractApiResult(raw);
  const outcome = classifyServiceHistory({
    httpStatus: 200,
    result,
    detail: result ? null : (raw?.result?.error ?? raw?.error ?? null),
  });
  if (outcome.status === 'error') {
    return fail(outcome, `HTTP 200 but unusable — ${JSON.stringify(outcome.detail ?? '').slice(0, 300)} (keys: ${result ? Object.keys(result).join(',').slice(0, 200) : 'none'}) (${url})`);
  }
  console.log(`[SVC HISTORY] ${outcome.status} in ${Date.now() - startedAt}ms — ${outcome.records.length} event(s) (${url.split('?')[0]})`);
  return outcome;
}

// SERVICE_HISTORY_COVERAGE lifted to config/serviceHistoryCoverage.mjs (20 Aug) so the MENU can gate
// on make+year before payment — one source, server and browser agree. Behaviour here is unchanged.

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

// Persist the EXACT served payload under the purchase (so a re-open is a pure DB read), then email
// the PDF to the customer post-response (BUILD_StoredReports §2.2 / §4b). The write is awaited — a
// re-open within the window must find the row. The email runs in after() so the customer's page load
// never waits on Brevo; both are internally guarded and never fail the response. Called at EVERY paid
// return site, cached or fresh — a first view served from reg_lookup_cache must still be stored under
// THIS session, or that customer's re-open would fall through to the replay-bind 403.
async function persistAndEmailReport(supabase, paidSession, { sessionId, vrm, checks, market, served }) {
  await writeStoredReport(supabase, { sessionId, vrm, checks, market, payload: served });
  const email = paidSession?.customer_details?.email || null;
  if (!email) {
    console.warn(`[REPORT EMAIL] no customer_details.email on session=${String(sessionId).slice(0, 14)}… — not sent`);
    return;
  }
  after(async () => {
    await dispatchReportEmail({ to: email, vrm, result: served, checks: served?.checks || checks, market });
  });
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

    // Entered mileage is REQUEST-SCOPED: it must be recomputed per request and NEVER served from a
    // VRM-keyed cache row. A verdict baked from one customer's entered figure would otherwise be shown
    // to the next customer looking up the same reg (Defect 4, 20 Aug — a stale free_GB row served
    // "consistent" over a fresh entered figure). Same class as money-fields-never-cached. Computed
    // here so it governs both the cache-hit and the fresh path below.
    const freeMileageNum = parseInt((mileage || '').replace(/,/g, ''), 10);
    const freeMileageValid = !isNaN(freeMileageNum) && freeMileageNum >= 1 && freeMileageNum <= 999999;
    const freeMileageOpts = freeMileageValid ? { currentMileage: freeMileageNum, asOf: Date.now() } : {};

    const cacheKey = 'free_GB';
    const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
    if (cached) {
      // Recompute the mileage verdict from the CACHED MOT substrate + THIS request's entered mileage —
      // never trust the verdict stored on the row (it was computed for a different request).
      const freshVerdict = buildMileageVerdict(cached.payload?.motHistory, freeMileageOpts);
      return NextResponse.json({ ...cached.payload, mileageVerdict: freshVerdict, _cached: true, _cachedAt: cached.created_at });
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
        motMileage: freeLatestMot?.odometerMiles ?? null,   // unit-normalised (km→mi) at the DVSA boundary
        motResult: freeLatestMot?.testResult || null,
        motHistory: freeMotTests,
        // CACHE the MOT-only (vehicle-scoped) verdict — no entered mileage. The response below carries
        // the request-scoped verdict; the two are deliberately different so the row stays reusable.
        mileageVerdict: buildMileageVerdict(freeMotTests),
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
      // Response carries the request-scoped verdict (entered mileage applied) — NOT the base verdict
      // just cached. The free lookup and the paid check now compute the entered figure identically.
      return NextResponse.json({ ...payload, mileageVerdict: buildMileageVerdict(freeMotTests, freeMileageOpts) });
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
  // ── Stored-report re-open (BUILD_StoredReports) ──────────────────────────────────────────────
  // The purchase is genuine (paid + VRM-matched). If it was already served, re-open it as a PURE DB
  // READ — no supplier calls, no reg_lookup_cache read, no replay bind — and return BEFORE the bind
  // below (whose job is first-view replay protection, and which would otherwise 403 a legitimate
  // returning customer with the very "already used" message this branch exists to remove). A missing
  // paid_reports table degrades to a normal first view (see lib/paidReports.mjs), never to a false
  // "payment could not be verified".
  {
    const stored = await readStoredReport(supabase, stripeSessionId, cleanVrm);
    if (stored.action === 'serve') {
      console.log(`[STORED REPORT] re-open served session=${stripeSessionId.slice(0, 14)}… vrm=${cleanVrm} (zero supplier calls)`);
      return NextResponse.json(stored.payload);
    }
    if (stored.action === 'expired') {
      console.log(`[STORED REPORT] expired session=${stripeSessionId.slice(0, 14)}… vrm=${cleanVrm}`);
      return NextResponse.json(
        { error: 'This report has expired. Please check your emailed copy, or buy a fresh report for current data.',
          storedReportExpired: true, storedAt: stored.storedAt },
        { status: 410 }
      );
    }
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
    // Finding 2: every ROI tier includes a valuation (bregoRoi / cartell priceguide) computed at the
    // entered mileage, and the ROI hit path returns the cached payload VERBATIM with no recompute — so
    // the mileage MUST be in the key here, always, or a different-mileage buyer gets the wrong figure.
    const roiCacheKey = `roi:${roiTierParam}_mi:${mileageCacheKeyPart(mileage)}`;

    const roiCached = await getCachedResult(supabase, cleanVrm, roiCacheKey);
    if (roiCached) {
      const served = { ...roiCached.payload, _cached: true, _cachedAt: roiCached.created_at };
      await persistAndEmailReport(supabase, paidSession, { sessionId: stripeSessionId, vrm: cleanVrm, checks: [roiTierParam], market: 'IE', served });
      return NextResponse.json(served);
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
    await persistAndEmailReport(supabase, paidSession, { sessionId: stripeSessionId, vrm: cleanVrm, checks: [roiTierParam], market: 'IE', served: roiPayload });
    return NextResponse.json(roiPayload);
  }

  const sortedKey = [...checks].sort().join(',');
  // Mileage-key the entry only when a valuation (GB `valuation` / IE `ie_valuation`) was bought — the
  // one field that is priced at the entered mileage. Everything else is mileage-independent and keeps
  // its shared entry (the mileage VERDICT is recomputed per-request on a hit at :588-612, unaffected).
  const valuationInKey = checks.includes('valuation') || checks.includes('ie_valuation');
  const cacheKey = `checks:${sortedKey}_${market}${valuationInKey ? `_mi:${mileageCacheKeyPart(mileage)}` : ''}`;

  const cached = await getCachedResult(supabase, cleanVrm, cacheKey);
  if (cached) {
    // Strip any per-transaction refund fields from cached vehicle data (defensive — pre-fix rows,
    // incl. the live 182D19228 row, carried them; makes a manual row purge unnecessary). Then
    // evaluate the refund LIVE against THIS request's paid session, via the same shared path as a
    // fresh miss — so a repeat buyer of the same reg gets their OWN refund, never a replayed one.
    const clean = { ...cached.payload };
    delete clean.serviceHistoryRefunded;
    delete clean.serviceHistoryRefund;
    delete clean.serviceHistoryRefundFailed;
    // Mileage verdict/detail are REQUEST-SCOPED (they depend on the entered mileage) — recompute them
    // from the CACHED MOT substrate + THIS request's entered figure, never serve the row's stored
    // verdict. Same class as the refund strip above and the free-path fix (Defect 4, 20 Aug).
    {
      const um = parseInt((mileage || '').replace(/,/g, ''), 10);
      const umValid = !isNaN(um) && um >= 1 && um <= 999999;
      const tl = checkMileageTimeline(clean.motHistory || [], umValid ? { currentMileage: um, asOf: Date.now() } : {});
      clean.mileageVerdict = tl.status !== 'insufficient'
        ? { status: tl.status, verdict: tl.verdict, mixedUnits: tl.mixedUnits, readingCount: tl.readingCount, hasRollback: tl.hasRollback, enteredQuery: tl.enteredQuery, enteredBelowMot: tl.enteredBelowMot, enteredAboveRate: tl.enteredAboveRate }
        : null;
      if (checks.includes('mileage_detail')) {
        clean.mileageDetail = { status: tl.status, verdict: tl.verdict, readings: tl.readings, anomalies: tl.anomalies, mixedUnits: tl.mixedUnits };
      }
    }
    const needsServiceHistory = checks.includes('ie_service_history') || checks.includes('service_history');
    const refundState = await evaluateServiceHistoryRefund(
      new Stripe(process.env.STRIPE_SECRET_KEY), paidSession, stripeSessionId, cachedServiceHistoryOutcome(clean), needsServiceHistory);
    const servedCached = { ...clean, ...refundState, _cached: true, _cachedAt: cached.created_at };
    await persistAndEmailReport(supabase, paidSession, { sessionId: stripeSessionId, vrm: cleanVrm, checks, market, served: servedCached });
    return NextResponse.json(servedCached);
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
      //
      // Endpoint corrected 19 Aug 2026. This line carried two independent faults, either of which
      // was fatal: `oneauto/servicehistory/` is retired (404 "Requested API is not available",
      // confirmed against both sandbox and live), and `vin` is not a parameter on any Ezyvin
      // endpoint — the documented name is `vehicle_identification_number`, and a missing mandatory
      // parameter returns 400. ie_service_history has therefore never worked and could not have.
      // Task 5b — the IE path checked only that a VIN existed. `ezyvin/servicehistory/` is the same
      // Ezyvin manufacturer dataset as the GB endpoint, keyed by VIN instead of VRM ("OE Service
      // History (Europe) from VIN"), so the SAME 44-manufacturer list and the SAME MY-2012 floor
      // apply. Cartell supplies the make as `manufacturer_desc` and the year as `manufactured_year`.
      // The year limb is not in the brief's 5b, but it is the same vendor rule as 5a and leaving it
      // off the IE path would knowingly keep half the gate open.
      const ieMake = (cartell.manufacturer_desc || '').toUpperCase();
      const ieCoverage = needsServiceHistory ? (SERVICE_HISTORY_COVERAGE.get(ieMake) || null) : null;
      const ieSkipReason = !needsServiceHistory ? null
        : !vin ? 'no_vin'
        : ieCoverage === null ? 'make_not_covered'
        : (cartell.manufactured_year && Number(cartell.manufactured_year) < 2012) ? 'pre_2012'
        : null;

      const svcHistoryPromise = !needsServiceHistory
        ? Promise.resolve(null)
        : ieSkipReason
          // Paid for, but unsupplyable — no call, refund still fires, exactly as before.
          ? Promise.resolve(serviceHistoryNotAttempted(ieSkipReason))
          : fetchServiceHistory(
              `${ONE_AUTO_BASE}/ezyvin/servicehistory/?vehicle_identification_number=${encodeURIComponent(vin)}`,
              { headers: oneAutoHeaders() },
              SERVICE_HISTORY_POLL
            );

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

      // Await polling results. Service history returns a discriminated outcome, not a Response.
      const [svcOutcome, historyRes] = await Promise.all([svcHistoryPromise, historyPromise]);

      // Parse
      const nctRaw    = nctHistoryRes  ? await safeJson(nctHistoryRes)  : null;
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
      const serviceHistory = svcOutcome?.result ?? null;
      const ieHistory    = histRaw ? extractApiResult(histRaw) : null;

      // Refund evaluated live (shared path), gated on a real re_ id, idempotent. NOT cached.
      const refundState = await evaluateServiceHistoryRefund(
        new Stripe(process.env.STRIPE_SECRET_KEY), paidSession, stripeSessionId, svcOutcome, needsServiceHistory);

      const cc     = cartell.engine_capacity_cc ?? null;
      const nctDue = cartell.nct_due_date ?? null;
      const nctStatus = nctDue ? (new Date(nctDue) > new Date() ? 'Valid' : 'Expired') : null;

      // Vehicle data only — the three refund fields are attached to the RESPONSE below, never cached.
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
        serviceHistoryStatus: svcOutcome?.status ?? null,
        serviceHistoryRecords: normaliseServiceEvents(svcOutcome?.records ?? null),
        serviceHistoryNotAttempted: svcOutcome?.notAttempted ?? null,
        ieHistory,
        market: 'IE',
        checks,
      };

      // Never cache a provider failure: a 48h TTL on an error would replay "unavailable" to every
      // later buyer of this reg and hide the recovery. Empty and ok results cache as before.
      if (!isUncacheableServiceHistory(svcOutcome)) {
        await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      }
      logEvent('report_viewed', { vrm: cleanVrm, tier: checks.join(','), market: 'IE' });
      const served = { ...payload, ...refundState };
      await persistAndEmailReport(supabase, paidSession, { sessionId: stripeSessionId, vrm: cleanVrm, checks, market: 'IE', served });
      return NextResponse.json(served);

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

      // AutoCheck is now driven by the single `full_history` bundle (£6.99), NOT by the retired
      // writeoff/finance/stolen singles. Those three keys can no longer be purchased (rejected at
      // checkout, 20 Aug) so a live basket never carries them; their render components remain for
      // already-paid historical reports. One call still serves all six AutoCheck blocks.
      const needsAutocheck = autocheckNeeded(checks);
      const needsValuation = checks.includes('valuation');
      const needsMot = checks.includes('mot');
      const needsMarketDemand = checks.includes('market_demand');
      const needsPreviousAdverts = checks.includes('previous_adverts');
      const needsServiceHistory = checks.includes('service_history');
      const needsSalvageHistory = checks.includes('salvagehistory');
      const needsMileageDetail = checks.includes('mileage_detail');
      const needsOwnerHistory = checks.includes('owner_history');
      const needsRoadTax = checks.includes('road_tax');

      const dvlaMake = dvla.make?.toUpperCase() || '';
      const svcCoverage = needsServiceHistory ? (SERVICE_HISTORY_COVERAGE.get(dvlaMake) || null) : null;
      // Task 5a — the vendor's OE coverage starts at MODEL YEAR 2012, and the make filter alone
      // let a 2008 Ford through to a call that could only ever return nothing. DVLA gives year of
      // manufacture, not model year, so a car built late in 2011 could be a 2012 model and is
      // skipped here; that costs a sale we could not have been confident of anyway, whereas
      // calling for a genuinely pre-2012 car risks a chargeable 200 with no events.
      const svcSkipReason = !needsServiceHistory ? null
        : svcCoverage === null ? 'make_not_covered'
        : (dvla.yearOfManufacture && Number(dvla.yearOfManufacture) < 2012) ? 'pre_2012'
        : null;

      // Service history may need polling — start it first.
      //
      // Endpoint corrected 19 Aug 2026. `oneauto/servicehistory/` returns 404 "Requested API is
      // not available" on BOTH sandbox and live — the path is retired, and every 404 fell through
      // to a null result and auto-refunded the customer. Verified by probe on 19 Aug: the
      // documented `ezyvin/servicehistoryfromvrm/` resolves (reaches the authoriser) where the old
      // path does not. Note that One Auto retire paths individually — a sibling legacy path still
      // being served is not evidence that this one is, which is why each was tested separately.
      const svcHistoryPromise = !needsServiceHistory
        ? Promise.resolve(null)
        : svcSkipReason
          // Paid for, but we know up front we cannot supply it — no call is made and the refund
          // still fires. Cheaper than a call that cannot succeed, and honest in the report.
          ? Promise.resolve(serviceHistoryNotAttempted(svcSkipReason))
          : fetchServiceHistory(
              `${ONE_AUTO_BASE}/ezyvin/servicehistoryfromvrm/?vehicle_registration_mark=${cleanVrm}`,
              { headers: oneAutoHeaders() },
              SERVICE_HISTORY_POLL
            );

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
        dvsaMileage: earlyDvsaData?.motTests?.[0]?.odometerMiles ?? null,   // normalised miles — the valuation is priced on THIS
        formMileageSource: 'user_entered',
      });

      const [autocheckRes, bregoRes, cazAdvRes, cazDemRes, dvsaData, salvageHistoryRes, ownerDetailsRes] = await Promise.all([
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
        ((needsMot || needsMileageDetail) && !needsDvsaFirst) ? getDvsaMotHistory(cleanVrm) : Promise.resolve(earlyDvsaData),
        needsSalvageHistory
          ? fetch(`${ONE_AUTO_BASE}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
        // TASK-6 — stop the keeper double-buy. AutoCheck already returns keeper_data_items /
        // cherished_data_items, so when the basket also triggers AutoCheck (full_history) we serve
        // keeper + plate data from that payload and skip this 20p (24p true) UKVD call. owner_history
        // bought standalone still fetches UKVD, so the call is correct when it is the only source.
        (needsOwnerHistory && !needsAutocheck)
          ? fetch(`${ONE_AUTO_BASE}/ukvehicledata/vehicleandmodeldetailsfromvrm?vehicle_registration_mark=${cleanVrm}`, { headers: oneAutoHeaders() })
          : Promise.resolve(null),
      ]);

      const autocheck = autocheckRes ? await safeJson(autocheckRes) : null;
      const valuation = bregoRes ? await safeJson(bregoRes) : null;
      const cazanaAdverts = cazAdvRes ? await safeJson(cazAdvRes) : null;
      const cazanaDemand = cazDemRes ? await safeJson(cazDemRes) : null;
      const motTests = dvsaData?.motTests || null;
      const salvageHistoryRaw = salvageHistoryRes ? await safeJson(salvageHistoryRes) : null;

      // ── Owner / keeper history (GB & NI) ────────────────────────────────────────
      // Parse → scrub the VIN OUT of the raw response IMMEDIATELY (display condition) → then read
      // only keeper/plate data from the scrubbed object. The VIN never reaches `payload`.
      let ownerHistory = null;
      if (needsOwnerHistory && needsAutocheck && autocheck?.result) {
        // TASK-6 — derive keeper/plate history from the AutoCheck payload already in hand (no UKVD
        // call). `keeper_data_items` carries the SAME { number_previous_keepers,
        // date_of_last_keeper_change } shape summariseOwnerHistory() consumes (confirmed against the
        // cached IJI2900 payload), and summarisePlateChanges() already reads cherished_data_items
        // defensively — same normaliser, both sources, one output shape.
        const ac = autocheck.result;
        const summary = summariseOwnerHistory(ac.keeper_data_items);
        ownerHistory = { ...summary, plateChanges: summarisePlateChanges(ac.cherished_data_items) };
      } else if (needsOwnerHistory && ownerDetailsRes) {
        const ownerRaw = scrubVin(await safeJson(ownerDetailsRes));
        const ownerResult = extractApiResult(ownerRaw);
        if (ownerResult) {
          const keeperList = deepFindArray(ownerResult, /keeper_change_list/i);
          const plateList = deepFindArray(ownerResult, /plate_change_list|vrm_change_list|previous_vrm|registration_change|number_plate_change/i);
          const summary = summariseOwnerHistory(keeperList);
          ownerHistory = { ...summary, plateChanges: summarisePlateChanges(plateList) };
        }
      }

      const svcOutcome = await svcHistoryPromise;
      const serviceHistoryData = svcOutcome?.result ?? null;

      // Refund evaluated live (shared path), gated on a real re_ id, idempotent. NOT cached.
      const refundState = await evaluateServiceHistoryRefund(
        new Stripe(process.env.STRIPE_SECRET_KEY), paidSession, stripeSessionId, svcOutcome, needsServiceHistory);

      const latestMot = motTests?.[0] || null;

      // Mileage/clocking timeline (unit-normalised). Verdict rides every GB report that has MOT
      // data; the full reading-by-reading breakdown is the paid `mileage_detail` add-on. The
      // user-entered mileage, when valid, is checked against the latest MOT as a "now" reading.
      const mileageTimeline = checkMileageTimeline(motTests || [], userMileageValid ? { currentMileage: userMileageNum, asOf: Date.now() } : {});
      // Base (MOT-only) timeline for the CACHE — entered mileage is request-scoped and must not be
      // frozen into a VRM-keyed row (Defect 4, 20 Aug). The response below carries the entered figure.
      const mileageTimelineBase = checkMileageTimeline(motTests || [], {});
      const mkVerdict = (tl) => tl.status !== 'insufficient'
        ? { status: tl.status, verdict: tl.verdict, mixedUnits: tl.mixedUnits, readingCount: tl.readingCount, hasRollback: tl.hasRollback, enteredQuery: tl.enteredQuery, enteredBelowMot: tl.enteredBelowMot, enteredAboveRate: tl.enteredAboveRate }
        : null;
      const mkDetail = (tl) => needsMileageDetail
        ? { status: tl.status, verdict: tl.verdict, readings: tl.readings, anomalies: tl.anomalies, mixedUnits: tl.mixedUnits }
        : null;

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
        motMileage: latestMot?.odometerMiles ?? null,   // unit-normalised (km→mi) at the DVSA boundary
        motResult: latestMot?.testResult || null,
        motHistory: motTests || null,
        cazanaAdverts: cazanaAdverts?.error ? null : cazanaAdverts,
        cazanaDemand: extractApiResult(cazanaDemand),
        serviceHistory: serviceHistoryData,
        serviceHistoryCoverage: svcCoverage,
        serviceHistoryStatus: svcOutcome?.status ?? null,
        serviceHistoryRecords: normaliseServiceEvents(svcOutcome?.records ?? null),
        serviceHistoryNotAttempted: svcOutcome?.notAttempted ?? null,
        salvageHistory: extractApiResult(salvageHistoryRaw),
        mileageVerdict: mkVerdict(mileageTimelineBase),
        mileageDetail: mkDetail(mileageTimelineBase),
        ownerHistory,
        roadTax: needsRoadTax ? estimateRoadTax({
          firstRegistration: dvla.monthOfFirstRegistration,
          yearOfManufacture: dvla.yearOfManufacture,
          co2: dvla.co2Emissions,
          fuelType: dvla.fuelType,
          engineCC: dvla.engineCapacity ?? null,
        }) : null,
        market: 'GB',
        checks,
        valuationMileage: needsValuation ? bregoMileage : null,
        valuationMileageSource: needsValuation ? bregoMileageSource : null,
        valuationMileageDate: (needsValuation && bregoMileageSource === 'dvsa_mot') ? (latestMot?.completedDate || null) : null,
        dvsaLastMileage: latestMot?.odometerMiles ?? null,   // normalised: the payment-success >500 flag compares this to valuationMileage (also miles)
        dvsaLastMileageDate: latestMot?.completedDate || null,
      };

      // See isUncacheableServiceHistory — a provider failure must not be frozen into the 48h cache.
      if (!isUncacheableServiceHistory(svcOutcome)) {
        await storeCachedResult(supabase, cleanVrm, cacheKey, payload);
      }
      logEvent('report_viewed', { vrm: cleanVrm, tier: checks.join(','), market: 'GB' });
      // Response carries the request-scoped mileage verdict/detail (entered figure applied), NOT the
      // MOT-only versions just cached. This SERVED object — not the cached one — is what is stored, so
      // a re-open shows the customer the exact verdict they bought (§2.2).
      const served = { ...payload, mileageVerdict: mkVerdict(mileageTimeline), mileageDetail: mkDetail(mileageTimeline), ...refundState };
      await persistAndEmailReport(supabase, paidSession, { sessionId: stripeSessionId, vrm: cleanVrm, checks, market: 'GB', served });
      return NextResponse.json(served);
    }

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}
