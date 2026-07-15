import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyLink, clientIp } from '@/lib/freeReport.mjs';
import { FREE_REPORT_BREVO_LIST_ID } from '@/config/freeReport.mjs';

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function baseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://motorquoter.app');
}

// Marketing MIRROR (Supabase is the truth). Best-effort Brevo contact upsert; never blocks issuance.
// Returns true only on a confirmed sync so the caller can stamp brevo_synced_at.
async function syncBrevoContact(email, marketingOptIn) {
  if (!marketingOptIn) return false;
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        email,
        updateEnabled: true,
        ...(FREE_REPORT_BREVO_LIST_ID ? { listIds: [FREE_REPORT_BREVO_LIST_ID] } : {}),
      }),
    });
    // 201 create / 204 update = success; 400 "already associated" is also effectively synced.
    return res.ok || res.status === 204;
  } catch (err) {
    console.error('[FREE REPORT] Brevo contact sync failed:', err.message);
    return false;
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sig = searchParams.get('sig');
  const v = verifyLink(sig, Date.now());
  if (!v.ok) {
    return NextResponse.redirect(`${baseUrl()}/salvage?free_error=${encodeURIComponent(v.reason)}`);
  }

  const supabase = getSupabase();
  const token = randomUUID(); // app-generated, matching promo/redeem
  const { error } = await supabase.from('free_report_tokens').insert({
    email_normalised: v.email,
    token,
    issued_at: new Date().toISOString(),
    marketing_opt_in: v.optIn,
    issue_ip: clientIp(request),
  });

  // UNIQUE(email_normalised) is the one-per-email gate. 23505 = already issued (double-click /
  // re-verify): reuse the existing token if it hasn't been consumed, else send them to an
  // already-used state. No second token is ever created.
  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabase.from('free_report_tokens')
        .select('token, consumed_at').eq('email_normalised', v.email).maybeSingle();
      if (existing && !existing.consumed_at) {
        return NextResponse.redirect(`${baseUrl()}/salvage?free_report_token=${existing.token}`);
      }
      return NextResponse.redirect(`${baseUrl()}/salvage?free_error=already_used`);
    }
    console.error('[FREE REPORT] token insert failed:', JSON.stringify(error));
    return NextResponse.redirect(`${baseUrl()}/salvage?free_error=issue_failed`);
  }

  // Marketing mirror — opt-in only, best-effort; token issuance already succeeded and never blocks.
  if (await syncBrevoContact(v.email, v.optIn)) {
    await supabase.from('free_report_tokens')
      .update({ brevo_synced_at: new Date().toISOString() }).eq('token', token);
  }

  return NextResponse.redirect(`${baseUrl()}/salvage?free_report_token=${token}`);
}
