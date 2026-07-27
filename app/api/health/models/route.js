import { NextResponse } from 'next/server';
import { MODEL_IDS } from '@/config/models';

// Daily model-dependency canary. MODEL_IDS is the app's declared model set (config/models.js) —
// this route verifies every one is still live at the Anthropic API and emails ALERT_EMAIL via
// Brevo on any failure, so a retired model is caught within a day instead of hiding for weeks as
// a silent per-request failure (the plate-scanner outage this whole series exists to prevent).
// Triggered by Vercel Cron (vercel.json) which sends Authorization: Bearer ${CRON_SECRET}.
export const dynamic = 'force-dynamic';

// GET /v1/models/{id}: 200 while live, 404 (not_found_error) once retired. Aliases and dated
// snapshot ids are both retrievable. Plain fetch, no SDK.
async function checkModel(id) {
  try {
    const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    return { id, ok: res.ok, status: res.status };
  } catch (err) {
    return { id, ok: false, status: `fetch-error: ${err.message}` };
  }
}

// One email listing every failure. Mirrors the free-report Brevo pattern (api-key header, same
// sender). Missing config → loud console.error, no throw (caller still returns JSON, never 500).
async function sendAlert(failures) {
  const key = process.env.BREVO_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) {
    console.error(`[MODEL CANARY] cannot send alert — missing ${!key ? 'BREVO_API_KEY ' : ''}${!to ? 'ALERT_EMAIL' : ''}`.trim());
    return;
  }
  const rows = failures
    .map(f => `<li><code>${f.id}</code> — status ${f.status} — likely retired</li>`)
    .join('');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'MotorQuoter', email: 'noreply@motorquoter.app' },
      to: [{ email: to }],
      subject: `⚠️ MotorQuoter model check FAILED — ${failures.length} model(s) unavailable`,
      htmlContent:
        `<p>The daily model canary found ${failures.length} model(s) the app depends on are no longer available at the Anthropic API:</p>` +
        `<ul>${rows}</ul>` +
        `<p>These are likely retired. See <a href="https://platform.claude.com/docs/en/about-claude/model-deprecations">the model deprecation page</a> and swap the failing id(s) in <code>config/models.js</code>.</p>`,
    }),
  });
  if (!res.ok) {
    console.error(`[MODEL CANARY] Brevo send failed: ${res.status} ${await res.text()}`);
  }
}

export async function GET(request) {
  // Auth: Vercel Cron sends Authorization: Bearer ${CRON_SECRET} automatically when the env var
  // is set. Missing/wrong (or CRON_SECRET unset) → 401, no work, no upstream calls.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await Promise.all(MODEL_IDS.map(checkModel));
  const ok = results.filter(r => r.ok).map(r => r.id);
  const failures = results.filter(r => !r.ok).map(r => ({ id: r.id, status: r.status }));

  if (failures.length > 0) {
    console.error(`[MODEL CANARY] ${failures.length} FAILURE(S): ${JSON.stringify(failures)}`);
    try {
      await sendAlert(failures);
    } catch (err) {
      console.error(`[MODEL CANARY] alert send threw: ${err.message}`);
    }
  }

  // Always 200 with the report — the email is the alert; the JSON is for the manual curl check.
  return NextResponse.json({ checked: MODEL_IDS.length, ok, failures });
}
