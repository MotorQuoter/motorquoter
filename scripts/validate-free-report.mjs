// Unit tests for the Free First Report pure surface (lib/freeReport.mjs + config blocklist).
// Deterministic signing key for the test run.
// batch 236 — also drives the request route (no confirm step), the 20/day run cap and the used-report alert in
// promo-checkout against a faked Supabase + Brevo. £0, nothing leaves the process.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-free-report.mjs
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-key-fixed';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
process.env.BREVO_API_KEY = 'test-brevo';
const { normaliseEmail, emailDomain, isValidEmail, signLink, verifyLink } = await import('../lib/freeReport.mjs');
const { DISPOSABLE_DOMAINS, FREE_REPORT_STRINGS } = await import('../config/freeReport.mjs');

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

console.log('── normaliseEmail ──');
check("gmail plus-tag stripped + lowercased + trimmed", normaliseEmail(' Vincent+salvage@Gmail.com ') === 'vincent@gmail.com');
check("plain address passes through", normaliseEmail('buyer@outlook.com') === 'buyer@outlook.com');
check("no plus untouched", normaliseEmail('a.b@domain.co.uk') === 'a.b@domain.co.uk');
check("emailDomain lowercased", emailDomain('X@Sub.Example.COM') === 'sub.example.com');

console.log('\n── isValidEmail ──');
check("valid", isValidEmail('a@b.co') === true);
check("no @", isValidEmail('ab.co') === false);
check("no tld", isValidEmail('a@b') === false);
check("empty", isValidEmail('') === false);

console.log('\n── disposable blocklist ──');
check("mailinator blocked", DISPOSABLE_DOMAINS.has('mailinator.com'));
check("gmail not blocked", !DISPOSABLE_DOMAINS.has('gmail.com'));

console.log('\n── signLink / verifyLink ──');
const now = 1_000_000;
const sig = signLink({ email: 'vincent@gmail.com', optIn: true, expMs: now + 1000 });
const okV = verifyLink(sig, now);
check("round-trip ok", okV.ok === true && okV.email === 'vincent@gmail.com' && okV.optIn === true);
check("expired rejected", verifyLink(sig, now + 2000).ok === false && verifyLink(sig, now + 2000).reason === 'expired');
check("tampered signature rejected", verifyLink(sig.slice(0, -2) + 'xx', now).ok === false);
const [b] = sig.split('.');
check("tampered payload rejected", verifyLink(`${b}.deadbeef`, now).reason === 'bad-signature');
check("malformed (no dot) rejected", verifyLink('garbage', now).reason === 'malformed');
check("null sig rejected", verifyLink(null, now).ok === false);
check("optIn=false round-trips", verifyLink(signLink({ email: 'a@b.co', optIn: false, expMs: now + 1000 }), now).optIn === false);

console.log('\n── locked strings present ──');
check("neutral (per-IP cap) string set", FREE_REPORT_STRINGS.neutral === 'Too many requests from this connection today. Please try again tomorrow.');
check("globalCap string set", /more available tomorrow/.test(FREE_REPORT_STRINGS.globalCap));
check("disposable string set", FREE_REPORT_STRINGS.disposable === 'Please use a non-disposable email address.');
check("no live string still promises a verification link (legacy emailSubject/emailBody aside)",
  Object.entries(FREE_REPORT_STRINGS).filter(([k, v]) => typeof v === 'string' && !['emailSubject', 'emailBody'].includes(k))
    .every(([, v]) => !/verification link/i.test(v)));

// ── batch 236: fake world (Supabase PostgREST + Brevo over fetch) ──────────────────────────────────────
const { readFileSync } = await import('node:fs');
const { PRICING } = await import('../config/pricing.js');
const { FREE_REPORT_RUN_LIMIT_PER_DAY, FREE_REPORT_IP_LIMIT_PER_DAY } = await import('../config/freeReport.mjs');
let db, sends, brevoFail;
const reset = ({ tokens = [], requests = [] } = {}) => { db = { tokens: tokens.map(r => ({ ...r })), requests: requests.map(r => ({ ...r })) }; sends = []; brevoFail = false; };
const json = (b, st = 200) => new Response(b == null ? null : JSON.stringify(b), { status: st, headers: { 'content-type': 'application/json' } });
const param = (url, col, op = 'eq.') => { const v = url.searchParams.get(col); return v && v.startsWith(op) ? decodeURIComponent(v.slice(op.length)) : null; };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const m = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.host === 'api.brevo.com') {
    if (url.pathname.endsWith('/smtp/email')) sends.push(body);
    return brevoFail ? json({ message: 'down' }, 500) : json({ messageId: 'x' }, 201);
  }
  const t = url.pathname.replace('/rest/v1/', '');
  const accept = new Headers(init.headers).get('accept') || '';
  const one = (rows) => accept.includes('vnd.pgrst.object')
    ? (rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'no rows' }, 406)) : json(rows);
  if (t === 'free_report_requests') {
    if (m === 'DELETE') return json(null, 204);
    if (m === 'HEAD' || m === 'GET') {
      const ip = param(url, 'ip'); const n = ip ? db.requests.filter(r => r.ip === ip).length : db.requests.length;
      return new Response(null, { status: 200, headers: { 'content-range': `*/${n}` } });
    }
    if (m === 'POST') { db.requests.push(body); return json(null, 201); }
  }
  if (t === 'free_report_attribution' && m === 'POST') return json(null, 201);
  if (t === 'free_report_tokens') {
    const since = param(url, 'consumed_at', 'gt.');
    if (since) return new Response(null, { status: 200, headers: { 'content-range': `*/${db.tokens.filter(r => r.consumed_at && r.consumed_at > since).length}` } });
    if (m === 'GET') return one(db.tokens.filter(r => r.email_normalised === param(url, 'email_normalised')));
    if (m === 'POST') {
      if (db.tokens.some(r => r.email_normalised === body.email_normalised)) return json({ code: '23505', message: 'duplicate key' }, 409);
      db.tokens.push({ ...body, consumed_at: null }); return json(null, 201);
    }
    if (m === 'PATCH') {
      const r = db.tokens.find(x => x.token === param(url, 'token'));
      if (url.searchParams.get('consumed_at') === 'is.null') {
        if (!r || r.consumed_at) return json({ code: 'PGRST116', message: 'no rows' }, 406);
        Object.assign(r, body); return one([r]);
      }
      if (r) Object.assign(r, body); return json(null, 204);
    }
  }
  if (t === 'salvage_sessions' && m === 'POST') return one([{ id: 'sess-1' }]);
  throw new Error(`unexpected fetch ${m} ${url.href}`);
};
const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
const origLog = console.log; const logs = []; const capLog = (...a) => { logs.push(a.join(' ')); };

const { POST: requestPOST } = await import('../app/api/salvage/free-report/request/route.js');
const { POST: checkoutPOST } = await import('../app/api/salvage/promo-checkout/route.js');
const reqReq = (b) => new Request('https://app.test/api/salvage/free-report/request', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(b) });
const readyUrl = (tok) => `https://app.test/salvage?free_report_token=${tok}`;
const USED_LINE = FREE_REPORT_STRINGS.alreadyUsed(PRICING.salvageAssessment.price);

console.log('\n── batch 236: request — no confirm step ──');
{
  reset();
  const r = await requestPOST(reqReq({ email: 'New+x@B.co', marketingOptIn: false, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'c1' }));
  const row = db.tokens[0] || {};
  check('new address → one token row (normalised email, issue_ip, opt-in, issued_at)', db.tokens.length === 1 && row.email_normalised === 'new@b.co'
    && row.issue_ip === '1.2.3.4' && row.marketing_opt_in === false && !!row.issued_at && !!row.token);
  check('new address → token row carries the UTM values', row.utm_source === 'meta' && row.utm_medium === 'paid' && row.utm_campaign === 'c1');
  check('new address → { ok: true, readyUrl } for that token', r.body?.ok === true && r.body.readyUrl === readyUrl(row.token) && !r.init?.status);
  check('new address → one email, the READY email (no confirm email)', sends.length === 1 && sends[0].subject === FREE_REPORT_STRINGS.readySubject
    && sends[0].htmlContent.includes(`free_report_token=${row.token}`));
  check('new address → request row recorded (caps count it)', db.requests.length === 1);
}
{
  reset(); brevoFail = true; errs.length = 0;
  const r = await requestPOST(reqReq({ email: 'new@b.co' }));
  check('ready email fails → still readyUrl, logged', r.body?.readyUrl === readyUrl(db.tokens[0]?.token) && errs.some(e => e.startsWith('[FREE REPORT] ready email send failed:')));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }] });
  const r = await requestPOST(reqReq({ email: 'old@b.co' }));
  check('unused existing → the SAME token\'s readyUrl, no new row, ready email resent', r.body?.ok === true && r.body.readyUrl === readyUrl('tok-old')
    && db.tokens.length === 1 && sends.length === 1 && sends[0].htmlContent.includes('free_report_token=tok-old'));
}
{
  reset({ tokens: [{ email_normalised: 'used@b.co', token: 'tok-used', consumed_at: '2026-10-01T00:00:00Z' }] });
  const r = await requestPOST(reqReq({ email: 'used@b.co' }));
  check(`used → { ok: false, message: alreadyUsed } at the pricing.js price ("${USED_LINE}")`, r.body?.ok === false && r.body.message === USED_LINE
    && !('readyUrl' in r.body) && sends.length === 0);
}
{
  reset({ requests: Array.from({ length: FREE_REPORT_IP_LIMIT_PER_DAY }, () => ({ ip: '1.2.3.4' })) });
  console.log = capLog;
  const r = await requestPOST(reqReq({ email: 'new@b.co' }));
  console.log = origLog;
  check('per-IP cap unchanged → neutral reply, no token, no send', r.body?.message === FREE_REPORT_STRINGS.neutral && db.tokens.length === 0 && sends.length === 0);
}
{
  const src = readFileSync('app/api/salvage/free-report/request/route.js', 'utf8');
  check('grep: no confirm-email caller left in request/route.js (sendVerificationEmail / emailSubject / signLink / verify?sig)',
    !/sendVerificationEmail|emailSubject|emailBody|signLink|verify\?sig/.test(src));
  check('grep: alreadyUsed price read from PRICING, not a literal', /alreadyUsed\(PRICING\.salvageAssessment\.price\)/.test(src) && !/8\.99/.test(src));
  const page = readFileSync('app/salvage/free-report/page.js', 'utf8');
  check('page: readyUrl → window.location.assign(data.readyUrl)', /window\.location\.assign\(data\.readyUrl\)/.test(page));
  check('page: ok:false → shows message', /data\.ok === false[\s\S]{0,80}setMessage\(data\.message/.test(page));
  check('page: idle button label is readyButton; sending label unchanged', page.includes("{status === 'sending' ? 'Sending…' : FREE_REPORT_STRINGS.readyButton}")
    && FREE_REPORT_STRINGS.readyButton === 'Start my free report');
  check('copy: requestForm is the batch 236 line', FREE_REPORT_STRINGS.requestForm === 'Get your first assessment free. Enter your email and start straight away - one free report per buyer, no card needed.');
}

console.log('\n── batch 236: run cap + alert (promo-checkout) ──');
const coReq = (tok) => new Request('https://app.test/api/salvage/promo-checkout', { method: 'POST', body: JSON.stringify({
  free_report_token: tok, imagePaths: ['a.jpg'], market: 'GB', vehicleDetails: { typeApproval: 'M1', vrm: 'AB12CDE', lotNumber: '123' } }) });
const recent = (n) => Array.from({ length: n }, (_, i) => ({ email_normalised: `u${i}@b.co`, token: `old${i}`, consumed_at: new Date(Date.now() - 3600e3).toISOString() }));
const withT = (n, extra = {}) => reset({ tokens: [...recent(n), { email_normalised: 't@b.co', token: 'T', consumed_at: null,
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'salvage_short_test', ...extra }] });
const T = () => db.tokens.find(x => x.token === 'T');
check('FREE_REPORT_RUN_LIMIT_PER_DAY = 20', FREE_REPORT_RUN_LIMIT_PER_DAY === 20);
{
  withT(20); logs.length = 0; console.log = capLog;
  const r = await checkoutPOST(coReq('T'));
  console.log = origLog;
  check('20 used in 24h → 429 + runCap', r.init?.status === 429 && r.body?.error === FREE_REPORT_STRINGS.runCap);
  check('capped → token NOT consumed, no alert', T().consumed_at === null && sends.length === 0);
  check('capped → [FREE REPORT][RUN CAP] logged with the count', logs.some(l => l.startsWith('[FREE REPORT][RUN CAP]') && l.includes('used=20')));
}
{
  withT(19);
  const r = await checkoutPOST(coReq('T'));
  check('19 used → runs: session created, token consumed + linked', !r.init?.status && r.body?.salvage_id === 'sess-1' && !!T().consumed_at && T().session_id === 'sess-1');
  const a = sends[0] || {}; const h = a.htmlContent || '';
  check('alert sent exactly once', sends.length === 1);
  check('alert to FREE_REPORT_ALERT_TO, subject "Free report used (20 in last 24h)"', a.to?.[0]?.email === 'vincent@motorquoter.app' && a.subject === 'Free report used (20 in last 24h)');
  check('alert body: UTC time, utm, reg, lot, 20 of 20', /Time \(UTC\): \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(h) && h.includes('meta / paid / salvage_short_test')
    && h.includes('reg AB12CDE') && h.includes('lot 123') && h.includes('20 of 20'));
  check('alert carries no customer email address', !h.includes('@'));
}
{
  withT(0, { utm_source: null, utm_medium: null, utm_campaign: null });
  await checkoutPOST(coReq('T'));
  check('untagged → "none", subject (1 in last 24h)', sends[0]?.htmlContent.includes('campaign: none') && sends[0]?.subject === 'Free report used (1 in last 24h)');
}
{
  withT(0); brevoFail = true; errs.length = 0;
  const r = await checkoutPOST(coReq('T'));
  check('alert fails → response unchanged (session), logged', !r.init?.status && r.body?.salvage_id === 'sess-1' && errs.some(e => e.startsWith('[FREE REPORT][ALERT] send failed:')));
}
{
  withT(0);
  await checkoutPOST(coReq('T')); const r = await checkoutPOST(coReq('T'));
  check('second consume of the same token → 403, still one alert', r.init?.status === 403 && sends.length === 1);
}
console.error = origErr;

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
