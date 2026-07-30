import { NextResponse } from 'next/server';
import { normaliseEmail, emailDomain, isValidEmail, clientIp } from '@/lib/freeReport.mjs';
import { DISPOSABLE_DOMAINS } from '@/config/freeReport.mjs';

// ── Import magnet — optional "email me this estimate" capture (Tier 1) ─────────
// Consent-gated. Adds the buyer to a Brevo contacts list (the NI/ROI import list) and sends a
// transactional copy of their estimate. Never blocks the free result; neutral responses (no oracle).
// Config: BREVO_API_KEY (send) + BREVO_IMPORT_LIST_ID (list to add to; if unset, contact still
// upserts without a list so nothing is lost). Brevo list should have double-opt-in enabled its side.

const RL = new Map();
const RL_MAX = 10, RL_WINDOW_MS = 60 * 60 * 1000; // 10 / hour / IP — abuse protection
function rateOk(ip) {
  const now = Date.now(); const e = RL.get(ip);
  if (!e || now > e.reset) { RL.set(ip, { n: 1, reset: now + RL_WINDOW_MS }); return true; }
  if (e.n >= RL_MAX) return false;
  e.n++; return true;
}

async function brevoUpsertContact(email, attributes) {
  const key = process.env.BREVO_API_KEY;
  if (!key) { console.warn('[IMPORT SUBSCRIBE] BREVO_API_KEY missing — capture skipped'); return; }
  const listId = process.env.BREVO_IMPORT_LIST_ID ? Number(process.env.BREVO_IMPORT_LIST_ID) : null;
  const body = { email, updateEnabled: true, attributes };
  if (Number.isFinite(listId)) body.listIds = [listId];
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  // 201 created / 204 updated are success; a "contact already exists" 400 is also fine.
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    if (!/already|exist/i.test(t)) throw new Error(`Brevo contacts ${res.status}: ${t.slice(0, 140)}`);
  }
}

async function brevoSendEstimate(email, summary) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return;
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://motorquoter.app';
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'MotorQuoter', email: 'noreply@motorquoter.app' },
      to: [{ email }],
      subject: 'Your rough import estimate',
      htmlContent:
        `<p>Here's the rough import estimate you asked for:</p>` +
        `<p style="font-size:16px"><strong>${summary || 'Estimate'}</strong></p>` +
        `<p>This is a floor based on the price you entered — Revenue values the car using its own Irish market price, usually higher, so the real figure is likely more.</p>` +
        `<p><a href="${base}/import" style="display:inline-block;padding:12px 20px;background:#f05a1a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Get the exact figure — €9.99</a></p>` +
        `<p style="font-size:12px;color:#888">Estimate only. The binding VRT is set by Revenue/NCTS at registration; VAT/customs are indicative and depend on the car's origin.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Brevo email ${res.status}`);
}

const neutral = () => NextResponse.json({ ok: true });

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }
  const { email, consent, vrm, summary } = body || {};
  if (!consent) return NextResponse.json({ error: 'Please tick the box to confirm you’re happy to be emailed.' }, { status: 400 });
  if (!isValidEmail(email)) return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });

  const normalised = normaliseEmail(email);
  if (DISPOSABLE_DOMAINS.has(emailDomain(normalised))) {
    return NextResponse.json({ error: 'Please use a non-disposable email address.' }, { status: 400 });
  }
  if (!rateOk(clientIp(request))) return neutral(); // no oracle for the per-IP cap

  try {
    await brevoUpsertContact(normalised, {
      SOURCE: 'import_magnet',
      LAST_VRM: String(vrm || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
      CONSENT: true,
    });
    await brevoSendEstimate(normalised, String(summary || '').slice(0, 200));
  } catch (e) {
    // Never leak provider state; the user sees a neutral success and can retry.
    console.error('[IMPORT SUBSCRIBE] failed:', e.message);
  }
  return neutral();
}
