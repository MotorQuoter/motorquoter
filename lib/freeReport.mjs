// Free First Report — pure helpers: email normalisation, HMAC-signed verification links, client IP.
// No config import (kept import-free so the validation script loads it under plain node; lib/utm.mjs is import-free too).
// The signing key is DERIVED from SUPABASE_SERVICE_ROLE_KEY via a labelled HMAC (key separation),
// so there is no new env var / no new deploy blocker; swappable to a dedicated secret later.
import crypto from 'node:crypto';
import { cleanUtm, hasUtm } from './utm.mjs';

function signingKey() {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return crypto.createHmac('sha256', base).update('motorquoter-free-report-link-v1').digest();
}

// gmail-class plus-tag strip + lowercase + trim: "Vincent+x@Gmail.com " -> "vincent@gmail.com".
export function normaliseEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  return `${local}@${domain}`;
}

export function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1).toLowerCase() : '';
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

// Signed link payload = { email, optIn, expiry, utm }. Returns base64url(payload)."."base64url(hmac).
// batch 229: `u` carries the three UTM values only when any is set; untagged links are byte-identical to before.
export function signLink({ email, optIn, expMs, utm }) {
  const u = cleanUtm(utm);
  const b = Buffer.from(JSON.stringify({ e: email, o: !!optIn, x: expMs, ...(hasUtm(u) ? { u } : {}) })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey()).update(b).digest('base64url');
  return `${b}.${sig}`;
}

// Verify signature + expiry. Returns { ok, email, optIn, utm } or { ok:false, reason }. A link signed before batch 229
// has no `u` → utm all null.
export function verifyLink(sig, nowMs) {
  if (!sig || typeof sig !== 'string' || !sig.includes('.')) return { ok: false, reason: 'malformed' };
  const [b, mac] = sig.split('.');
  const expect = crypto.createHmac('sha256', signingKey()).update(b).digest('base64url');
  const a = Buffer.from(mac || '', 'utf8');
  const e = Buffer.from(expect, 'utf8');
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return { ok: false, reason: 'bad-signature' };
  let p;
  try { p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (typeof p.x !== 'number' || nowMs > p.x) return { ok: false, reason: 'expired' };
  return { ok: true, email: p.e, optIn: !!p.o, utm: cleanUtm(p.u) };
}

// First hop of x-forwarded-for (Vercel sets it); fall back to x-real-ip, else 'unknown'.
export function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  const first = xff ? xff.split(',')[0].trim() : '';
  return first || request.headers.get('x-real-ip') || 'unknown';
}
