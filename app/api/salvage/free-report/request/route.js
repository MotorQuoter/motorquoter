import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { normaliseEmail, emailDomain, isValidEmail, signLink, clientIp } from '@/lib/freeReport.mjs';
import { sendTransactionalEmail } from '@/lib/email.mjs';
import {
  FREE_REPORT_IP_LIMIT_PER_DAY, FREE_REPORT_GLOBAL_LIMIT_PER_DAY, FREE_REPORT_LINK_TTL_HOURS,
  FREE_REPORT_REQUEST_PRUNE_DAYS, FREE_REPORT_STRINGS, DISPOSABLE_DOMAINS,
} from '@/config/freeReport.mjs';

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function baseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');
}

// Verification email — the shared transactional sender (lib/email.mjs), one Brevo caller for the app.
async function sendVerificationEmail(to, verifyUrl) {
  await sendTransactionalEmail({
    to,
    subject: FREE_REPORT_STRINGS.emailSubject,
    htmlContent:
      `<p>${FREE_REPORT_STRINGS.emailBody}</p>` +
      `<p><a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#f05a1a;color:#fff;` +
      `text-decoration:none;border-radius:8px;font-weight:600">Confirm your email</a></p>`,
  });
}

// Neutral success — identical for new, repeat, and per-IP-limited addresses (enumeration-safe, no oracle).
const neutral = () => NextResponse.json({ ok: true, message: FREE_REPORT_STRINGS.neutral });

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { email, marketingOptIn } = body || {};
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
    return neutral(); // no oracle for the per-IP cap — outward response unchanged
  }

  const { count: globalCount } = await supabase.from('free_report_requests')
    .select('*', { count: 'exact', head: true }).gt('created_at', dayAgoISO);
  if ((globalCount ?? 0) >= FREE_REPORT_GLOBAL_LIMIT_PER_DAY) {
    console.log(`[FREE REPORT][CAP] global suppressed — cap=${FREE_REPORT_GLOBAL_LIMIT_PER_DAY} window=24h bucket=${bucket}`);
    return NextResponse.json({ ok: true, message: FREE_REPORT_STRINGS.globalCap });
  }

  // Already issued for this email → neutral, no send, no request recorded (no cost, no oracle).
  const { data: existing } = await supabase.from('free_report_tokens')
    .select('id').eq('email_normalised', normalised).maybeSingle();
  if (existing) return neutral();

  // Record the request (rate-limit accounting) then send the signed link. No token row until verify.
  await supabase.from('free_report_requests').insert({ ip });

  const expMs = nowMs + FREE_REPORT_LINK_TTL_HOURS * 3600 * 1000;
  const sig = signLink({ email: normalised, optIn: !!marketingOptIn, expMs });
  const verifyUrl = `${baseUrl()}/api/salvage/free-report/verify?sig=${encodeURIComponent(sig)}`;
  try {
    await sendVerificationEmail(normalised, verifyUrl);
  } catch (err) {
    // Never leak provider state to the caller; the request is recorded, the user can retry.
    console.error('[FREE REPORT] verification email send failed:', err.message);
  }
  return neutral();
}
