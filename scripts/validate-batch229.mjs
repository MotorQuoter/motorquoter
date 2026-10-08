// batch 229 — record where free-report visitors came from (UTM capture).
// Drives the real request POST and verify GET handlers against a faked Supabase (PostgREST over fetch) and a faked
// Brevo, plus the pure capture/clean rules in lib/utm.mjs against a fake sessionStorage. Nothing leaves the process.
// £0, no live email, no model call, no DB.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch229.mjs
import { readFileSync } from 'node:fs';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-key-fixed';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
process.env.BREVO_API_KEY = 'test-brevo';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

// ── fake world ───────────────────────────────────────────────────────────────────────────────────────
// db.tokens: free_report_tokens · db.requests: free_report_requests · db.attr: free_report_attribution.
// attrMissing: the attribution table / token utm columns do not exist yet (migration not applied).
let db, calls, attrMissing;
function reset({ tokens = [], requests = [], missing = false } = {}) {
  db = { tokens: tokens.map(r => ({ ...r })), requests: requests.map(r => ({ ...r })), attr: [] };
  calls = []; attrMissing = missing;
}
const json = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } });
const eqParam = (url, col) => { const v = url.searchParams.get(col); return v && v.startsWith('eq.') ? decodeURIComponent(v.slice(3)) : null; };
const UTM_COLS = ['utm_source', 'utm_medium', 'utm_campaign'];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ host: url.host, path: url.pathname, method, body });

  if (url.host === 'api.brevo.com') return json({ messageId: 'x' }, 201);
  if (url.host !== 'sb.test') throw new Error(`unexpected fetch ${url.href}`);
  const table = url.pathname.replace('/rest/v1/', '');
  const accept = new Headers(init.headers).get('accept') || '';
  const single = (rows) => accept.includes('vnd.pgrst.object')
    ? (rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'no rows' }, 406))
    : json(rows);

  if (table === 'free_report_requests') {
    if (method === 'DELETE') return json(null, 204);
    if (method === 'HEAD' || method === 'GET') {
      const ip = eqParam(url, 'ip');
      const n = ip ? db.requests.filter(r => r.ip === ip).length : db.requests.length;
      return new Response(null, { status: 200, headers: { 'content-range': `*/${n}` } });
    }
    if (method === 'POST') { db.requests.push(body); return json(null, 201); }
  }
  if (table === 'free_report_attribution') {
    if (attrMissing) return json({ code: 'PGRST205', message: "Could not find the table 'public.free_report_attribution'" }, 404);
    if (method === 'POST') { db.attr.push(body); return json(null, 201); }
  }
  if (table === 'free_report_tokens') {
    if (method === 'GET') return single(db.tokens.filter(r => r.email_normalised === eqParam(url, 'email_normalised')));
    if (method === 'POST') {
      if (db.tokens.some(r => r.email_normalised === body.email_normalised)) return json({ code: '23505', message: 'duplicate key' }, 409);
      db.tokens.push({ ...body, consumed_at: null }); return json(null, 201);
    }
    if (method === 'PATCH') {
      if (attrMissing && UTM_COLS.some(k => k in body)) return json({ code: 'PGRST204', message: "Could not find the 'utm_source' column" }, 400);
      const row = db.tokens.find(r => r.token === eqParam(url, 'token'));
      if (row) Object.assign(row, body);
      return json(null, 204);
    }
  }
  throw new Error(`unhandled ${method} ${url.href}`);
};

const smtpSends = () => calls.filter(c => c.host === 'api.brevo.com' && c.path === '/v3/smtp/email');
const req = (body, ip = '1.2.3.4') => new Request('https://app.test/api/salvage/free-report/request', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

const { FREE_REPORT_STRINGS, FREE_REPORT_IP_LIMIT_PER_DAY, FREE_REPORT_GLOBAL_LIMIT_PER_DAY } = await import('../config/freeReport.mjs');
const { signLink, verifyLink } = await import('../lib/freeReport.mjs');
const utmLib = await import('../lib/utm.mjs');
const { cleanUtmValue, cleanUtm, utmFromSearch, captureUtm, readStoredUtm, UTM_STORAGE_KEY } = utmLib;
const { GET: verifyGET } = await import('../app/api/salvage/free-report/verify/route.js');
const { POST: requestPOST } = await import('../app/api/salvage/free-report/request/route.js');

const errs = []; const origErr = console.error;
console.error = (...a) => { errs.push(a.join(' ')); };

const META = { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'salvage_short_test' };
const NONE = { utm_source: null, utm_medium: null, utm_campaign: null };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isNeutral = (r) => r.body?.ok === true && r.body.message === FREE_REPORT_STRINGS.neutral && !r.init?.status;

// ── 1. clean / trim / cap / null ─────────────────────────────────────────────────────────────────────
console.log('── clean: trim, cap, null ──');
check('trimmed', cleanUtmValue('  meta  ') === 'meta');
check('capped at 100 chars', cleanUtmValue('x'.repeat(250)) === 'x'.repeat(100));
check('control characters removed', cleanUtmValue('me\u0000ta\n') === 'meta');
check('empty / whitespace → null', cleanUtmValue('') === null && cleanUtmValue('   ') === null);
check('non-strings → null (number, bool, object, array, null, undefined)',
  [42, true, { a: 1 }, ['meta'], null, undefined].every(v => cleanUtmValue(v) === null));
check('cleanUtm always returns the three keys', same(cleanUtm({ utm_source: ' meta ', other: 'x' }), { utm_source: 'meta', utm_medium: null, utm_campaign: null }));
check('cleanUtm of null / string / array → all null', [null, 'x', [1]].every(v => same(cleanUtm(v), NONE)));
check('utmFromSearch: the ad URL', same(utmFromSearch('?utm_source=meta&utm_medium=paid&utm_campaign=salvage_short_test'), META));
check('utmFromSearch: no utm → null', utmFromSearch('?free_error=expired') === null && utmFromSearch('') === null);
check('utmFromSearch: decoded + trimmed', same(utmFromSearch('?utm_source=%20face%20book%20'), { utm_source: 'face book', utm_medium: null, utm_campaign: null }));

// ── 2. capture on arrival (sessionStorage) ───────────────────────────────────────────────────────────
console.log('\n── capture on arrival ──');
const fakeStorage = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
{
  const s = fakeStorage();
  captureUtm('?utm_source=meta&utm_medium=paid&utm_campaign=salvage_short_test', s);
  check('stored under one key', s.m.size === 1 && s.m.has(UTM_STORAGE_KEY));
  check('read back for the request body', same(readStoredUtm(s), META));
  captureUtm('?utm_source=google&utm_medium=cpc', s);
  check('first touch wins: a later tagged URL does not overwrite', same(readStoredUtm(s), META));
  captureUtm('?free_error=expired', s);
  check('survives the ?free_error= bounce / an untagged page', same(readStoredUtm(s), META));
}
{
  const s = fakeStorage();
  captureUtm('/salvage', s);
  check('untagged arrival stores nothing → body all null', s.m.size === 0 && same(readStoredUtm(s), NONE));
}
{
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  let threw = false;
  try { captureUtm('?utm_source=meta', throwing); captureUtm('?utm_source=meta', null); } catch { threw = true; }
  check('storage that throws / no storage: capture never throws', !threw);
  check('storage that throws / no storage: read → all null', same(readStoredUtm(throwing), NONE) && same(readStoredUtm(null), NONE));
  const s = fakeStorage(); s.setItem(UTM_STORAGE_KEY, '{not json');
  check('corrupt stored value → all null', same(readStoredUtm(s), NONE));
  const t = fakeStorage(); t.setItem(UTM_STORAGE_KEY, JSON.stringify({ utm_source: 7, utm_medium: 'x'.repeat(300) }));
  check('tampered stored value re-cleaned on read', same(readStoredUtm(t), { utm_source: null, utm_medium: 'x'.repeat(100), utm_campaign: null }));
}

// ── 3. signed link round-trip ────────────────────────────────────────────────────────────────────────
console.log('\n── signed link ──');
const exp = () => Date.now() + 3600e3;
{
  const v = verifyLink(signLink({ email: 'a@b.co', optIn: true, expMs: exp(), utm: META }), Date.now());
  check('round-trips the three values', v.ok && v.email === 'a@b.co' && v.optIn === true && same(v.utm, META));
  const plainNew = signLink({ email: 'a@b.co', optIn: false, expMs: 1e15 });
  const plainNull = signLink({ email: 'a@b.co', optIn: false, expMs: 1e15, utm: NONE });
  const payload = JSON.parse(Buffer.from(plainNew.split('.')[0], 'base64url').toString('utf8'));
  check('untagged link: no `u` in the payload (same shape as before batch 229)', same(Object.keys(payload), ['e', 'o', 'x']) && plainNew === plainNull);
  check('untagged / pre-229 link verifies with utm all null', same(verifyLink(plainNew, Date.now()).utm, NONE));
  const [b, mac] = signLink({ email: 'a@b.co', optIn: false, expMs: exp(), utm: META }).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString('utf8')), u: { utm_source: 'forged' } })).toString('base64url');
  check('utm is inside the signature (edited payload → bad-signature)', verifyLink(`${forged}.${mac}`, Date.now()).reason === 'bad-signature');
}

// ── 4. request route: one attribution row per accepted request ───────────────────────────────────────
console.log('\n── request route: attribution rows ──');
const sigFromEmail = () => {
  const html = smtpSends().at(-1)?.body.htmlContent || '';
  const m = html.match(/verify\?sig=([^"]+)"/);
  return m ? decodeURIComponent(m[1]) : null;
};
{
  reset();
  const r = await requestPOST(req({ email: 'new@b.co', ...META }));
  check('requested: one row, outcome requested, the three values', db.attr.length === 1 && same(db.attr[0], { ...META, outcome: 'requested' }));
  check('requested: no email, no IP in the row', !JSON.stringify(db.attr[0]).includes('new@b.co') && !JSON.stringify(db.attr[0]).includes('1.2.3.4'));
  check('requested: response unchanged (neutral)', isNeutral(r));
  const v = verifyLink(sigFromEmail(), Date.now());
  check('requested: the emailed link carries the values', v.ok && same(v.utm, META));
}
{
  reset();
  await requestPOST(req({ email: 'new@b.co' }));
  check('untagged request: row still written, all null (organic count)', db.attr.length === 1 && same(db.attr[0], { ...NONE, outcome: 'requested' }));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }] });
  const r = await requestPOST(req({ email: 'old@b.co', ...META }));
  check('resent: one row, outcome resent', db.attr.length === 1 && same(db.attr[0], { ...META, outcome: 'resent' }) && isNeutral(r));
}
{
  reset({ requests: Array.from({ length: FREE_REPORT_IP_LIMIT_PER_DAY }, () => ({ ip: '1.2.3.4' })) });
  const r = await requestPOST(req({ email: 'new@b.co', ...META }));
  check('per-IP cap: one row, outcome capped, response neutral, no send', db.attr.length === 1 && same(db.attr[0], { ...META, outcome: 'capped' })
    && isNeutral(r) && smtpSends().length === 0);
}
{
  reset({ requests: Array.from({ length: FREE_REPORT_GLOBAL_LIMIT_PER_DAY }, () => ({ ip: '9.9.9.9' })) });
  const r = await requestPOST(req({ email: 'new@b.co', ...META }));
  check('global cap: one row, outcome capped, globalCap message unchanged', db.attr.length === 1 && same(db.attr[0], { ...META, outcome: 'capped' })
    && r.body?.message === FREE_REPORT_STRINGS.globalCap && smtpSends().length === 0);
}
{
  reset({ tokens: [{ email_normalised: 'used@b.co', token: 'tok-used', consumed_at: '2026-10-01T00:00:00Z' }] });
  const r = await requestPOST(req({ email: 'used@b.co', ...META }));
  check('already used: no row (not one of the three outcomes — flagged in handoff), neutral', db.attr.length === 0 && isNeutral(r));
}
{
  reset();
  const r1 = await requestPOST(req({ email: 'bad', ...META }));
  const r2 = await requestPOST(req({ email: 'x@mailinator.com', ...META }));
  check('rejected requests (invalid / disposable): 400, no row', r1.init?.status === 400 && r2.init?.status === 400 && db.attr.length === 0);
}
{
  reset();
  const r = await requestPOST(req({ email: 'new@b.co', utm_source: 12, utm_medium: { a: 1 }, utm_campaign: 'y'.repeat(500) }));
  check('bad UTM values never fail the request: neutral + row with nulls / capped',
    isNeutral(r) && same(db.attr[0], { utm_source: null, utm_medium: null, utm_campaign: 'y'.repeat(100), outcome: 'requested' }));
  check('bad UTM values: the verification email is still sent', smtpSends().length === 1);
}
{
  reset({ missing: true }); errs.length = 0;
  const r = await requestPOST(req({ email: 'new@b.co', ...META }));
  check('table missing (migration not applied): response unchanged, email still sent', isNeutral(r) && smtpSends().length === 1);
  check('table missing: logged', errs.some(e => e.startsWith('[FREE REPORT] attribution insert failed:')));
}

// ── 5. verify writes them on the token row ───────────────────────────────────────────────────────────
console.log('\n── verify: token row ──');
const vreq = (s) => new Request(`https://app.test/api/salvage/free-report/verify?sig=${encodeURIComponent(s)}`);
{
  reset();
  await requestPOST(req({ email: 'new@b.co', ...META }));
  const res = await verifyGET(vreq(sigFromEmail()));
  const row = db.tokens[0] || {};
  check('verify (via the emailed link): token row carries the three values',
    row.utm_source === 'meta' && row.utm_medium === 'paid' && row.utm_campaign === 'salvage_short_test');
  check('verify: redirect unchanged', res.redirect === `https://app.test/salvage?free_report_token=${row.token}`);
  const insert = calls.find(c => c.path.endsWith('/free_report_tokens') && c.method === 'POST');
  check('verify: the token insert itself is unchanged (no utm keys)', !!insert && !UTM_COLS.some(k => k in insert.body));
}
{
  reset();
  await verifyGET(vreq(signLink({ email: 'plain@b.co', optIn: false, expMs: exp() })));
  const utmPatches = calls.filter(c => c.method === 'PATCH' && UTM_COLS.some(k => k in (c.body || {})));
  check('verify, untagged link: no utm write at all', db.tokens.length === 1 && utmPatches.length === 0);
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null, utm_source: 'first' }] });
  const res = await verifyGET(vreq(signLink({ email: 'old@b.co', optIn: false, expMs: exp(), utm: META })));
  check('verify, re-verify (23505): first record kept, not overwritten', db.tokens[0].utm_source === 'first'
    && res.redirect === 'https://app.test/salvage?free_report_token=tok-old');
}
{
  reset({ missing: true }); errs.length = 0;
  const res = await verifyGET(vreq(signLink({ email: 'new@b.co', optIn: false, expMs: exp(), utm: META })));
  check('columns missing (migration not applied): token still issued + redirected', db.tokens.length === 1
    && res.redirect === `https://app.test/salvage?free_report_token=${db.tokens[0].token}`);
  check('columns missing: logged', errs.some(e => e.startsWith('[FREE REPORT] token utm write failed:')));
}

// ── 6. wiring + no buyer-facing change ───────────────────────────────────────────────────────────────
console.log('\n── wiring ──');
const layoutSrc = readFileSync('app/layout.js', 'utf8');
const captureSrc = readFileSync('app/UtmCapture.js', 'utf8');
const pageSrc = readFileSync('app/salvage/free-report/page.js', 'utf8');
const requestSrc = readFileSync('app/api/salvage/free-report/request/route.js', 'utf8');
check('root layout mounts <UtmCapture /> (every page load)', /import UtmCapture from "\.\/UtmCapture"/.test(layoutSrc) && /<UtmCapture \/>/.test(layoutSrc));
check('UtmCapture is a client component calling captureUtm(window.location.search, …)', captureSrc.startsWith("'use client'")
  && /captureUtm\(window\.location\.search, storage\)/.test(captureSrc) && /return null;/.test(captureSrc));
check('free-report form POSTs the stored values', /readStoredUtm\(storage\)/.test(pageSrc) && /JSON\.stringify\(\{ email, marketingOptIn: optIn, \.\.\.utm \}\)/.test(pageSrc));
check('request route: exactly 4 attribution writes (requested, resent, 2× capped)', (requestSrc.match(/recordAttribution\(supabase, utm, '/g) || []).length === 4);
const cfgSrc = readFileSync('config/freeReport.mjs', 'utf8');
check('rate limits unchanged (3 per IP, 100 global)', /FREE_REPORT_IP_LIMIT_PER_DAY\s+=\s+3;/.test(cfgSrc) && /FREE_REPORT_GLOBAL_LIMIT_PER_DAY\s+=\s+100;/.test(cfgSrc));
const sql = readFileSync('migrations/20261008_free_report_attribution.sql', 'utf8');
check('migration: attribution table with the brief\'s columns, no email / ip', /create table if not exists public\.free_report_attribution/.test(sql)
  && ['id', 'created_at', 'utm_source', 'utm_medium', 'utm_campaign', 'outcome'].every(c => new RegExp(`^\\s+${c}\\s`, 'm').test(sql))
  && !/^\s+(email|ip)\b/m.test(sql));
check('migration: three nullable utm columns on free_report_tokens', UTM_COLS.every(c => sql.includes(`alter table public.free_report_tokens add column if not exists ${c}`)));
check('migration: RLS on + grants revoked', sql.includes('alter table public.free_report_attribution enable row level security')
  && sql.includes('revoke all on public.free_report_attribution from anon, authenticated'));

console.error = origErr;
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail) process.exit(1);
