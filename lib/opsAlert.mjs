// Throttled live alert for Claude INFRASTRUCTURE failures (retired model / auth / API down) on a
// live call path — closes the gap between daily model-canary runs. Distinguishes an infra failure
// from a normal bad-input failure (a 400 invalid_request_error from a bad image, or the plate
// route's 422 no-plate) so it never fires on ordinary user errors — the exact distinction that was
// missing when the plate-scanner outage hid for six weeks.
// .mjs so it imports cleanly from the route files (matches lib/parts.mjs etc.).
import { createClient } from '@supabase/supabase-js';

const THROTTLE_MINUTES = 60;
const BREVO_TIMEOUT_MS = 2000;

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// TRUE only for infrastructure-class failures. A 400 invalid_request_error (bad image) and the
// plate route's own 422 no-plate are NOT infra failures and must never trip this.
export function isInfraFailure(status, data) {
  if (status === 404 || status >= 500) return true;
  const t = data?.error?.type;
  return t === 'not_found_error' || t === 'authentication_error' || t === 'permission_error';
}

// Throttled Brevo alert. NEVER throws — callers are already on a failing path. Returns a small
// status object for logging/tests. Time-boxed so it can be awaited on the error path without
// hanging the response (Vercel does not guarantee post-response work runs, so callers MUST await).
export async function sendOpsAlert(kind, subject, html) {
  // Throttle via ops_alert_state (id = kind). Fail-open: if the read/upsert errors (e.g. the table
  // isn't created yet) we send anyway — a duplicate alert beats a missed outage.
  try {
    const supabase = getSupabase();
    const { data: row, error: readErr } = await supabase
      .from('ops_alert_state')
      .select('last_sent_at')
      .eq('id', kind)
      .maybeSingle();
    if (readErr) {
      console.error(`[OPS ALERT] throttle read failed (${kind}) — sending anyway: ${readErr.message}`);
    } else if (row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < THROTTLE_MINUTES * 60 * 1000) {
      return { skipped: true };
    } else {
      const { error: upErr } = await supabase
        .from('ops_alert_state')
        .upsert({ id: kind, last_sent_at: new Date().toISOString() });
      if (upErr) console.error(`[OPS ALERT] throttle upsert failed (${kind}) — sending anyway: ${upErr.message}`);
    }
  } catch (err) {
    console.error(`[OPS ALERT] throttle store threw (${kind}) — sending anyway: ${err.message}`);
  }

  const key = process.env.BREVO_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) {
    console.error(`[OPS ALERT] cannot send (${kind}) — missing ${!key ? 'BREVO_API_KEY ' : ''}${!to ? 'ALERT_EMAIL' : ''}`.trim());
    return { error: 'missing-config' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BREVO_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        sender: { name: 'MotorQuoter', email: 'noreply@motorquoter.app' },
        to: [{ email: to }],
        subject,
        htmlContent: `<p>${html}</p>`,
      }),
    });
    if (!res.ok) {
      console.error(`[OPS ALERT] Brevo send failed (${kind}): ${res.status} ${await res.text().catch(() => '')}`);
      return { error: `brevo-${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[OPS ALERT] Brevo send threw/timed out (${kind}): ${err.message}`);
    return { error: 'send-failed' };
  } finally {
    clearTimeout(timer);
  }
}
