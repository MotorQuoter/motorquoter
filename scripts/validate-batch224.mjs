// batch 224 — a person with an unused free report can always get back to it.
// Drives the real verify GET and request POST handlers against a faked Supabase (PostgREST over fetch) and a
// faked Brevo. Nothing leaves the process: every fetch is answered here. £0, no live email, no model call.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch224.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-key-fixed';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
process.env.BREVO_API_KEY = 'test-brevo';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

// ── fake world ───────────────────────────────────────────────────────────────────────────────────────
// db.tokens: rows of free_report_tokens; db.requests: rows of free_report_requests; calls: every fetch.
let db, calls, brevoFails;
function reset({ tokens = [], requests = [], failBrevo = false } = {}) {
  db = { tokens: tokens.map(r => ({ ...r })), requests: requests.map(r => ({ ...r })) };
  calls = []; brevoFails = failBrevo;
}
const json = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } });
const eqParam = (url, col) => { const v = url.searchParams.get(col); return v && v.startsWith('eq.') ? decodeURIComponent(v.slice(3)) : null; };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ host: url.host, path: url.pathname, method, body });

  if (url.host === 'api.brevo.com') {
    if (url.pathname === '/v3/smtp/email' && brevoFails) return new Response('boom', { status: 500 });
    return json({ messageId: 'x' }, 201);
  }
  if (url.host !== 'sb.test') throw new Error(`unexpected fetch ${url.href}`);
  const table = url.pathname.replace('/rest/v1/', '');
  const accept = new Headers(init.headers).get('accept') || '';
  const single = (rows) => accept.includes('vnd.pgrst.object')
    ? (rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'no rows' }, 406))
    : json(rows);

  if (table === 'free_report_requests') {
    if (method === 'DELETE') return json(null, 204);
    if (method === 'HEAD' || method === 'GET') return new Response(null, { status: 200, headers: { 'content-range': `*/${db.requests.length}` } });
    if (method === 'POST') { db.requests.push(body); return json(null, 201); }
  }
  if (table === 'free_report_tokens') {
    if (method === 'GET') {
      const e = eqParam(url, 'email_normalised');
      return single(db.tokens.filter(r => r.email_normalised === e));
    }
    if (method === 'POST') {
      if (db.tokens.some(r => r.email_normalised === body.email_normalised)) return json({ code: '23505', message: 'duplicate key' }, 409);
      db.tokens.push({ ...body, consumed_at: null }); return json(null, 201);
    }
    if (method === 'PATCH') return json(null, 204);
  }
  throw new Error(`unhandled ${method} ${url.href}`);
};

const smtpSends = () => calls.filter(c => c.host === 'api.brevo.com' && c.path === '/v3/smtp/email');
const req = (body, ip = '1.2.3.4') => new Request('https://app.test/api/salvage/free-report/request', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

const { FREE_REPORT_STRINGS, DISPOSABLE_DOMAINS, FREE_REPORT_IP_LIMIT_PER_DAY } = await import('../config/freeReport.mjs');
const { signLink } = await import('../lib/freeReport.mjs');
const { freeReportReadyLink, sendFreeReportReadyEmail } = await import('../app/api/salvage/free-report/readyEmail.mjs');
const { GET: verifyGET } = await import('../app/api/salvage/free-report/verify/route.js');
const { POST: requestPOST } = await import('../app/api/salvage/free-report/request/route.js');

const errs = []; const origErr = console.error;
console.error = (...a) => { errs.push(a.join(' ')); };

// ── 1. one owner of the ready link ──────────────────────────────────────────────────────────────────
console.log('── one owner of the ready link ──');
const SRC_DIRS = ['app', 'lib', 'config', 'components'];
const walk = (d) => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const srcFiles = SRC_DIRS.flatMap(d => { try { return walk(d); } catch { return []; } }).filter(p => /\.(m?js|jsx|tsx?)$/.test(p));
const builders = srcFiles.filter(p => /salvage\?free_report_token=\$\{/.test(readFileSync(p, 'utf8')));
check(`exactly one file builds "/salvage?free_report_token=\${…}" (found: ${builders.join(', ')})`,
  builders.length === 1 && /readyEmail\.mjs$/.test(builders[0]));
const verifySrc = readFileSync('app/api/salvage/free-report/verify/route.js', 'utf8');
const requestSrc = readFileSync('app/api/salvage/free-report/request/route.js', 'utf8');
check('verify route imports the owner (send + link for its redirects)', /import \{ sendFreeReportReadyEmail, freeReportReadyLink \} from '\.\.\/readyEmail\.mjs'/.test(verifySrc));
check('request route imports sendFreeReportReadyEmail', /import \{ sendFreeReportReadyEmail \} from '\.\.\/readyEmail\.mjs'/.test(requestSrc));
check('builder shape', freeReportReadyLink('https://x.test', 'abc-123') === 'https://x.test/salvage?free_report_token=abc-123');
{
  const sent = [];
  await sendFreeReportReadyEmail('a@b.co', 'tok-1', 'https://x.test', async (m) => { sent.push(m); });
  const m = sent[0] || {};
  check('ready email: subject is readySubject', m.subject === FREE_REPORT_STRINGS.readySubject);
  check('ready email: body carries readyBody + readyButton + the link', m.htmlContent?.includes(FREE_REPORT_STRINGS.readyBody)
    && m.htmlContent.includes(`>${FREE_REPORT_STRINGS.readyButton}</a>`) && m.htmlContent.includes('href="https://x.test/salvage?free_report_token=tok-1"'));
  const confirmStyle = requestSrc.replace(/`\s*\+\s*`/g, '').match(/style="([^"]+)"/)?.[1]; // join the split template literals
  check('ready button styled exactly like the confirm button', !!confirmStyle && m.htmlContent.includes(`style="${confirmStyle}"`));
}

// ── 2. verify (confirm) ──────────────────────────────────────────────────────────────────────────────
console.log('\n── verify: confirm ──');
const sig = (email) => encodeURIComponent(signLink({ email, optIn: false, expMs: Date.now() + 3600e3 }));
const vreq = (email) => new Request(`https://app.test/api/salvage/free-report/verify?sig=${sig(email)}`);
{
  reset();
  const res = await verifyGET(vreq('new@b.co'));
  const tok = db.tokens[0]?.token;
  const s = smtpSends();
  check('success: token row inserted', db.tokens.length === 1 && !!tok);
  check('success: one ready email to v.email', s.length === 1 && s[0].body.to[0].email === 'new@b.co' && s[0].body.subject === FREE_REPORT_STRINGS.readySubject);
  check('success: email carries the same token as the redirect', s[0]?.body.htmlContent.includes(`free_report_token=${tok}`)
    && res.redirect === `https://app.test/salvage?free_report_token=${tok}`);
}
{
  reset({ failBrevo: true }); errs.length = 0;
  const res = await verifyGET(vreq('new@b.co'));
  check('send failure: still redirects with the token', res.redirect === `https://app.test/salvage?free_report_token=${db.tokens[0]?.token}`);
  check('send failure: logged with the brief\'s prefix', errs.some(e => e.startsWith('[FREE REPORT] ready email send failed:')));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }] });
  const res = await verifyGET(vreq('old@b.co'));
  check('23505 + unused: redirect carries existing token, NO email', res.redirect === 'https://app.test/salvage?free_report_token=tok-old' && smtpSends().length === 0);
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: '2026-10-01T00:00:00Z' }] });
  const res = await verifyGET(vreq('old@b.co'));
  check('23505 + used: already_used, NO email', /free_error=already_used$/.test(res.redirect) && smtpSends().length === 0);
}

// ── 3. request (asking again) ────────────────────────────────────────────────────────────────────────
console.log('\n── request: asking again ──');
const neutralBody = { ok: true, message: FREE_REPORT_STRINGS.neutral };
const isNeutral = (r) => JSON.stringify(r.body) === JSON.stringify(neutralBody) && r.init === undefined;
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }] });
  const r = await requestPOST(req({ email: 'Old+x@B.co' }));
  const s = smtpSends();
  check('issued + unused: request row inserted (caps count it)', db.requests.length === 1 && db.requests[0].ip === '1.2.3.4');
  check('issued + unused: ready email with the EXISTING token', s.length === 1 && s[0].body.to[0].email === 'old@b.co'
    && s[0].body.subject === FREE_REPORT_STRINGS.readySubject && s[0].body.htmlContent.includes('free_report_token=tok-old'));
  check('issued + unused: no new token row', db.tokens.length === 1);
  check('issued + unused: neutral()', isNeutral(r));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }], failBrevo: true }); errs.length = 0;
  const r = await requestPOST(req({ email: 'old@b.co' }));
  check('issued + unused + send failure: still neutral(), logged', isNeutral(r) && errs.some(e => e.startsWith('[FREE REPORT] ready email send failed:')));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: '2026-10-01T00:00:00Z' }] });
  const r = await requestPOST(req({ email: 'old@b.co' }));
  check('issued + used: NO send, NO request row, neutral()', smtpSends().length === 0 && db.requests.length === 0 && isNeutral(r));
}
{
  reset();
  const r = await requestPOST(req({ email: 'fresh@b.co' }));
  const s = smtpSends();
  check('not issued: unchanged — confirm email (emailSubject), request row, neutral()', s.length === 1
    && s[0].body.subject === FREE_REPORT_STRINGS.emailSubject && db.requests.length === 1 && isNeutral(r));
}
{
  reset({ tokens: [{ email_normalised: 'old@b.co', token: 'tok-old', consumed_at: null }],
    requests: Array.from({ length: FREE_REPORT_IP_LIMIT_PER_DAY }, () => ({ ip: '1.2.3.4' })) });
  const r = await requestPOST(req({ email: 'old@b.co' }));
  check('issued + unused but capped: NO send, NO new row, neutral() (cap runs first)',
    smtpSends().length === 0 && db.requests.length === FREE_REPORT_IP_LIMIT_PER_DAY && isNeutral(r));
}
{
  const capIdx = requestSrc.indexOf('FREE_REPORT_IP_LIMIT_PER_DAY) {');
  const gcapIdx = requestSrc.indexOf('FREE_REPORT_GLOBAL_LIMIT_PER_DAY) {');
  const issuedIdx = requestSrc.indexOf(".from('free_report_tokens')");
  check('source order: per-IP cap < global cap < already-issued lookup', capIdx > 0 && gcapIdx > capIdx && issuedIdx > gcapIdx);
  const branch = requestSrc.slice(issuedIdx, requestSrc.indexOf('// Record the request (rate-limit accounting)'));
  const returns = branch.match(/return [^;]+;/g) || [];
  check(`issued branch: every return is neutral() (${returns.join(' | ')})`, returns.length === 2 && returns.every(x => x === 'return neutral();'));
}

// ── 4. strings, blocklist, page ──────────────────────────────────────────────────────────────────────
console.log('\n── strings, blocklist, page ──');
check('readySubject verbatim', FREE_REPORT_STRINGS.readySubject === 'Your free MotorQuoter salvage report is ready');
check('readyBody verbatim', FREE_REPORT_STRINGS.readyBody === "Your free salvage assessment is waiting. Open the button below on whichever device has the auction photos. It works until you use it, so there's no rush. Paste the auction listing, add the photos, and you'll get the itemised repair, what the car is worth fixed, the auction fees and the most you can bid to break even.");
check('readyButton verbatim', FREE_REPORT_STRINGS.readyButton === 'Start my free report');
check('readyOnPage verbatim', FREE_REPORT_STRINGS.readyOnPage === "We've emailed you this link too. If you close this page, open that email and tap the button again. Your free report stays there until you use it.");
check('dreameg.com blocked (set)', DISPOSABLE_DOMAINS.has('dreameg.com'));
{
  reset();
  const r = await requestPOST(req({ email: 'x@dreameg.com' }));
  check('dreameg.com blocked (route): 400 disposable, no send, no row', r.init?.status === 400
    && r.body.error === FREE_REPORT_STRINGS.disposable && smtpSends().length === 0 && db.requests.length === 0);
}
const pageSrc = readFileSync('app/salvage/page.js', 'utf8');
check('page imports FREE_REPORT_STRINGS', /import \{ FREE_REPORT_STRINGS \} from '@\/config\/freeReport\.mjs'/.test(pageSrc));
const uses = pageSrc.match(/FREE_REPORT_STRINGS\.readyOnPage/g) || [];
check('page: readyOnPage rendered once, only under `freeReportToken &&`', uses.length === 1
  && /\{freeReportToken && \(\s*<div[^>]*>\s*\{FREE_REPORT_STRINGS\.readyOnPage\}/.test(pageSrc));
check('page: line sits right after the submit button', /<\/button>\s*\{\/\*[^*]*\*\/\}\s*\{freeReportToken && \(/.test(pageSrc));

console.error = origErr;
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail) process.exit(1);
