import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normaliseEmail, emailDomain, isValidEmail, clientIp, syncBrevoContact } from '@/lib/freeReport.mjs';
import { cleanUtm, hasUtm } from '@/lib/utm.mjs';
import { PRICING } from '@/config/pricing';
import { sendFreeReportReadyEmail, freeReportReadyLink } from '../readyEmail.mjs';
import {
  FREE_REPORT_IP_LIMIT_PER_DAY, FREE_REPORT_GLOBAL_LIMIT_PER_DAY,
  FREE_REPORT_REQUEST_PRUNE_DAYS, FREE_REPORT_STRINGS, FREE_REPORT_BREVO_LIST_ID, DISPOSABLE_DOMAINS,
} from '@/config/freeReport.mjs';

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function baseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');
}

// batch 229 — the permanent record of where accepted requests came from (free_report_attribution; never pruned,
// no email, no IP). One row per accepted request: outcome 'requested' | 'resent' | 'capped' | 'used'. Best-effort: a failed
// insert (or a missing table) is logged and never changes the response.
async function recordAttribution(supabase, utm, outcome) {
  try {
    const { error } = await supabase.from('free_report_attribution').insert({ ...utm, outcome });
    if (error) console.error('[FREE REPORT] attribution insert failed:', error.code || '', error.message || '');
  } catch (err) {
    console.error('[FREE REPORT] attribution insert failed:', err.message);
  }
}

// Per-IP cap reply (batch 236: new and repeat addresses now get their link straight back, not this).
const neutral = () => NextResponse.json({ ok: true, message: FREE_REPORT_STRINGS.neutral });
// batch 236 — no confirm email (Vincent, 15 Oct): the page goes straight to readyUrl. The cost guards are the 20/day
// run cap and the alert on every use (promo-checkout). Vincent accepted that this and the alreadyUsed reply tell a
// visitor whether an address has used its free report.
const ready = (token) => NextResponse.json({ ok: true, readyUrl: freeReportReadyLink(baseUrl(), token) });
const alreadyUsed = () => NextResponse.json({ ok: false, message: FREE_REPORT_STRINGS.alreadyUsed(PRICING.salvageAssessment.price) });

// Email the ready link too, so a person who leaves the page can get back to an unused report. Never blocks.
async function sendReadyBestEffort(to, token) {
  try {
    await sendFreeReportReadyEmail(to, token, baseUrl());
  } catch (err) {
    console.error('[FREE REPORT] ready email send failed:', err.message);
  }
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { email, marketingOptIn } = body || {};
  const utm = cleanUtm(body); // batch 229 — strings only, trimmed, 100-char cap; anything else → null. Never rejects.
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  }

  const normalised = normaliseEmail(email);
  if (DISPOSABLE_DOMAINS.has(emailDomain(normalised))) {
    return NextResponse.json({ error: FREE_REPORT_STRINGS.disposable }, { status: 400 });
  }

  const supabase = getSupabase();
  const ip = clientIp(request);
  const nowMs = Date.now();
  const dayAgoISO = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  // Opportunistic prune (ruling): drop rows older than the retention window, in this route's path.
  await supabase.from('free_report_requests').delete()
    .lt('created_at', new Date(nowMs - FREE_REPORT_REQUEST_PRUNE_DAYS * 24 * 3600 * 1000).toISOString());

  // Rate limits (ruling D), counted at the request route. Cap suppressions are logged (which cap,
  // its value, the date bucket) so silent throttling is visible in Vercel logs. The window is a
  // rolling 24h, not a calendar day; `bucket` is a UTC-date label only. No email in the log line —
  // the per-IP line carries a truncated IP hash as a correlator, never the raw IP or the address.
  const bucket = new Date(nowMs).toISOString().slice(0, 10); // UTC date label for the log
  const { count: ipCount } = await supabase.from('free_report_requests')
    .select('*', { count: 'exact', head: true }).eq('ip', ip).gt('created_at', dayAgoISO);
  if ((ipCount ?? 0) >= FREE_REPORT_IP_LIMIT_PER_DAY) {
    const ipHash = createHash('sha256').update(String(ip)).digest('hex').slice(0, 10);
    console.log(`[FREE REPORT][CAP] per-IP suppressed — cap=${FREE_REPORT_IP_LIMIT_PER_DAY} window=24h bucket=${bucket} ipHash=${ipHash}`);
    await recordAttribution(supabase, utm, 'capped');
    return neutral(); // no oracle for the per-IP cap — outward response unchanged
  }

  const { count: globalCount } = await supabase.from('free_report_requests')
    .select('*', { count: 'exact', head: true }).gt('created_at', dayAgoISO);
  if ((globalCount ?? 0) >= FREE_REPORT_GLOBAL_LIMIT_PER_DAY) {
    console.log(`[FREE REPORT][CAP] global suppressed — cap=${FREE_REPORT_GLOBAL_LIMIT_PER_DAY} window=24h bucket=${bucket}`);
    await recordAttribution(supabase, utm, 'capped');
    return NextResponse.json({ ok: true, message: FREE_REPORT_STRINGS.globalCap });
  }

  // Already issued for this email (batch 224). Used → the alreadyUsed line, no send, no request recorded. Unused →
  // record the request (so the caps above count it), email their EXISTING token again and hand back its link. The
  // rate limits above already ran, so a resend is capped like any other request.
  const { data: existing } = await supabase.from('free_report_tokens')
    .select('token, consumed_at').eq('email_normalised', normalised).maybeSingle();
  if (existing) {
    if (existing.consumed_at) {
      await recordAttribution(supabase, utm, 'used'); // batch 230 — counted; no send
      return alreadyUsed();
    }
    await supabase.from('free_report_requests').insert({ ip });
    await recordAttribution(supabase, utm, 'resent');
    await sendReadyBestEffort(normalised, existing.token);
    return ready(existing.token);
  }

  // batch 236 — record the request (rate-limit accounting) and issue the token here, with the fields verify/route.js
  // writes, plus the UTM values when the visitor arrived tagged.
  await supabase.from('free_report_requests').insert({ ip });
  await recordAttribution(supabase, utm, 'requested');

  const token = randomUUID(); // app-generated, matching promo/redeem
  const { error } = await supabase.from('free_report_tokens').insert({
    email_normalised: normalised,
    token,
    issued_at: new Date().toISOString(),
    marketing_opt_in: !!marketingOptIn,
    issue_ip: ip,
    ...(hasUtm(utm) ? utm : {}),
  });

  // UNIQUE(email_normalised) is the one-per-email gate. 23505 = issued by a concurrent request for the same address:
  // hand back that token if it is unused, else the alreadyUsed line. No second token is ever created.
  if (error) {
    if (error.code === '23505') {
      const { data: raced } = await supabase.from('free_report_tokens')
        .select('token, consumed_at').eq('email_normalised', normalised).maybeSingle();
      if (raced && !raced.consumed_at) return ready(raced.token);
      return alreadyUsed();
    }
    console.error('[FREE REPORT] token insert failed:', JSON.stringify(error));
    return NextResponse.json({ error: 'Something went wrong — please try again.' }, { status: 500 });
  }

  // Marketing mirror — opt-in only, best-effort; token issuance already succeeded and never blocks.
  if (await syncBrevoContact(normalised, !!marketingOptIn, FREE_REPORT_BREVO_LIST_ID)) {
    await supabase.from('free_report_tokens')
      .update({ brevo_synced_at: new Date().toISOString() }).eq('token', token);
  }

  await sendReadyBestEffort(normalised, token);
  return ready(token);
}
