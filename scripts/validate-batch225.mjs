// batch 225 — a failed confirm link says why (on the email form), and a used or unknown free report is caught when
// /salvage opens, before any upload. Drives the real verify + status handlers against an in-process fake Supabase
// (PostgREST over fetch). Nothing leaves the process. £0, no live email, no model call.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch225.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-key-fixed';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.test';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
process.env.BREVO_API_KEY = 'test-brevo';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

// ── fake Supabase ────────────────────────────────────────────────────────────────────────────────────
let tokens, calls, dbFails;
function reset({ rows = [], failDb = false } = {}) { tokens = rows.map(r => ({ ...r })); calls = []; dbFails = failDb; }
const json = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ host: url.host, path: url.pathname, method, search: url.search });
  if (url.host === 'api.brevo.com') return json({ messageId: 'x' }, 201);
  if (url.host !== 'sb.test') throw new Error(`unexpected fetch ${url.href}`);
  if (dbFails) return json({ code: 'XX000', message: 'db down' }, 500);
  const table = url.pathname.replace('/rest/v1/', '');
  if (table !== 'free_report_tokens') throw new Error(`unexpected table ${table}`);
  if (method === 'GET') {
    const col = url.searchParams.has('token') ? 'token' : 'email_normalised';
    const v = decodeURIComponent((url.searchParams.get(col) || '').replace(/^eq\./, ''));
    const hit = tokens.filter(r => r[col] === v);
    const accept = new Headers(init.headers).get('accept') || '';
    if (accept.includes('vnd.pgrst.object')) return hit.length === 1 ? json(hit[0]) : json({ code: 'PGRST116' }, 406);
    return json(hit);
  }
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    if (tokens.some(r => r.email_normalised === body.email_normalised)) return json({ code: '23505', message: 'dup' }, 409);
    tokens.push({ ...body, consumed_at: null }); return json(null, 201);
  }
  throw new Error(`unhandled ${method} ${url.href}`);
};
const writes = () => calls.filter(c => c.host === 'sb.test' && c.method !== 'GET' && c.method !== 'HEAD');

const { FREE_REPORT_STRINGS, freeErrorLine } = await import('../config/freeReport.mjs');
const { PRICING } = await import('../config/pricing.js');
const { signLink } = await import('../lib/freeReport.mjs');
const { GET: verifyGET } = await import('../app/api/salvage/free-report/verify/route.js');
const { GET: statusGET } = await import('../app/api/salvage/free-report/status/route.js');
const { checkFreeReportToken } = await import('../lib/freeReportStatus.mjs');
const origErr = console.error; console.error = () => {};

const PRICE = PRICING.salvageAssessment.price;
const USED_LINE = FREE_REPORT_STRINGS.alreadyUsed(PRICE, '£');

// ── 1. strings ───────────────────────────────────────────────────────────────────────────────────────
console.log('── strings ──');
check('linkFailed verbatim', FREE_REPORT_STRINGS.linkFailed === "That link didn't work. Links last 24 hours. Enter your email again below and we'll send you a fresh one.");
check('linkFailedCta verbatim', FREE_REPORT_STRINGS.linkFailedCta === 'Get a fresh link');
check(`alreadyUsed renders today as the brief's line ("${USED_LINE}")`, USED_LINE === 'This free report has already been used. Further reports are £8.99.');
check('alreadyUsed follows the price it is given (not a literal)', FREE_REPORT_STRINGS.alreadyUsed(12.5, '£') === 'This free report has already been used. Further reports are £12.50.');
const noLiteral = ['config/freeReport.mjs', 'app/salvage/page.js', 'app/salvage/free-report/page.js', 'lib/freeReportStatus.mjs']
  .filter(f => /8\.99/.test(readFileSync(f, 'utf8')));
check(`no literal 8.99 in the strings or either page (found in: ${noLiteral.join(', ') || 'none'})`, noLiteral.length === 0);

// ── 2. verify: failed links go to the email form, reason kept ────────────────────────────────────────
console.log('\n── verify: failed links → /salvage/free-report ──');
const signed = (email, expMs) => encodeURIComponent(signLink({ email, optIn: false, expMs }));
const vget = (sig) => verifyGET(new Request(`https://app.test/api/salvage/free-report/verify?sig=${sig}`));
{
  reset(); let r = await vget('garbage');
  check(`malformed → ${r.redirect}`, r.redirect === 'https://app.test/salvage/free-report?free_error=malformed');
  const good = signLink({ email: 'a@b.co', optIn: false, expMs: Date.now() + 3600e3 });
  r = await vget(encodeURIComponent(good.slice(0, -2) + 'xx'));
  check(`bad-signature → ${r.redirect}`, r.redirect === 'https://app.test/salvage/free-report?free_error=bad-signature');
  r = await vget(signed('a@b.co', Date.now() - 1000));
  check(`expired → ${r.redirect}`, r.redirect === 'https://app.test/salvage/free-report?free_error=expired');
  reset({ rows: [{ email_normalised: 'u@b.co', token: 't', consumed_at: '2026-10-01T00:00:00Z' }] });
  r = await vget(signed('u@b.co', Date.now() + 3600e3));
  check(`already_used → ${r.redirect}`, r.redirect === 'https://app.test/salvage/free-report?free_error=already_used');
  reset({ failDb: true });
  r = await vget(signed('n@b.co', Date.now() + 3600e3));
  check(`issue_failed → ${r.redirect}`, r.redirect === 'https://app.test/salvage/free-report?free_error=issue_failed');
  const vsrc = readFileSync('app/api/salvage/free-report/verify/route.js', 'utf8');
  check('no redirect left to /salvage?free_error=', !/\/salvage\?free_error=/.test(vsrc) && (vsrc.match(/\/salvage\/free-report\?free_error=/g) || []).length === 3);
}

// ── 3. the free-report page maps every reason ────────────────────────────────────────────────────────
console.log('\n── /salvage/free-report: reason → line ──');
for (const reason of ['malformed', 'bad-signature', 'expired', 'issue_failed', 'something-new'])
  check(`${reason} → linkFailed`, freeErrorLine(reason, PRICE) === FREE_REPORT_STRINGS.linkFailed);
check('already_used → alreadyUsed (£8.99 today)', freeErrorLine('already_used', PRICE) === USED_LINE);
check('no reason → nothing shown', freeErrorLine(null, PRICE) === null && freeErrorLine('', PRICE) === null);
{
  const fp = readFileSync('app/salvage/free-report/page.js', 'utf8');
  check('page reads free_error through freeErrorLine with PRICING.salvageAssessment.price',
    /new URLSearchParams\(window\.location\.search\)\.get\('free_error'\)/.test(fp)
    && /freeErrorLine\(freeErrorReason, PRICING\.salvageAssessment\.price\)/.test(fp));
  check('page shows the line above the form, which stays rendered', fp.indexOf('{freeError && ') > 0
    && fp.indexOf('{freeError && ') < fp.indexOf('<form onSubmit={submit}>'));
}

// ── 4. status route ──────────────────────────────────────────────────────────────────────────────────
console.log('\n── GET /api/salvage/free-report/status ──');
const T_UNUSED = '11111111-1111-4111-8111-111111111111', T_USED = '22222222-2222-4222-8222-222222222222';
const ROWS = [
  { email_normalised: 'x@b.co', token: T_UNUSED, consumed_at: null },
  { email_normalised: 'y@b.co', token: T_USED, consumed_at: '2026-10-01T00:00:00Z' },
];
const sget = (t) => statusGET(new Request(`https://app.test/api/salvage/free-report/status?token=${encodeURIComponent(t)}`));
{
  reset({ rows: ROWS });
  const a = await sget(T_UNUSED), b = await sget(T_USED), c = await sget('33333333-3333-4333-8333-333333333333'), d = await sget('not-a-uuid');
  check('unused → { state: "unused" }', JSON.stringify(a.body) === '{"state":"unused"}');
  check('used → { state: "used" }', JSON.stringify(b.body) === '{"state":"used"}');
  check('no such token → { state: "unknown" }', JSON.stringify(c.body) === '{"state":"unknown"}');
  check('not a uuid → { state: "unknown" }, no DB call', JSON.stringify(d.body) === '{"state":"unknown"}' && calls.length === 3);
  check('never returns the email (no "@" in any body)', ![a, b, c, d].some(r => JSON.stringify(r.body).includes('@')));
  check('selects consumed_at only', calls.every(c => new URLSearchParams(c.search).get('select') === 'consumed_at'));
  check('no writes', writes().length === 0);
  reset({ rows: ROWS, failDb: true });
  const e = await sget(T_UNUSED);
  check('DB error → 500 (page leaves the token)', e.init?.status === 500 && !('state' in e.body));
}

// ── 5. /salvage on-load check ────────────────────────────────────────────────────────────────────────
console.log('\n── /salvage: on-load token check ──');
const fakeStatus = (resp) => async () => resp;
const ok = (state) => fakeStatus(new Response(JSON.stringify({ state }), { status: 200 }));
check('unused → keep', JSON.stringify(await checkFreeReportToken(T_UNUSED, ok('unused'))) === '{"keep":true}');
check('used → clear + alreadyUsed', JSON.stringify(await checkFreeReportToken(T_USED, ok('used'))) === '{"keep":false,"notice":"alreadyUsed"}');
check('unknown → clear + linkFailed', JSON.stringify(await checkFreeReportToken('x', ok('unknown'))) === '{"keep":false,"notice":"linkFailed"}');
check('5xx → keep (nothing changes)', JSON.stringify(await checkFreeReportToken(T_USED, fakeStatus(new Response('{}', { status: 500 })))) === '{"keep":true}');
check('network error → keep', JSON.stringify(await checkFreeReportToken(T_USED, async () => { throw new Error('offline'); })) === '{"keep":true}');
check('bad JSON → keep', JSON.stringify(await checkFreeReportToken(T_USED, fakeStatus(new Response('<html>', { status: 200 })))) === '{"keep":true}');
{
  let asked = ''; await checkFreeReportToken(T_UNUSED, async (u) => { asked = u; return new Response('{"state":"unused"}'); });
  check('calls the status route with the token', asked === `/api/salvage/free-report/status?token=${T_UNUSED}`);
}
{
  const ps = readFileSync('app/salvage/page.js', 'utf8');
  const effStart = ps.indexOf("const frt = params.get('free_report_token');");
  const effEnd = ps.indexOf('}, []);', effStart);
  const eff = ps.slice(effStart, effEnd);
  check('load effect: calls checkFreeReportToken(frt) once', (eff.match(/checkFreeReportToken\(frt\)/g) || []).length === 1
    && (ps.match(/checkFreeReportToken\(/g) || []).length === 1);
  check('load effect: !keep clears the token and sets the notice', /if \(!r\.keep\) \{ setFreeReportToken\(''\); setFreeNotice\(r\.notice\); \}/.test(eff));
  check('load effect: no upload in it (uploads happen only on submit)', !/upload-urls|uploadUrl/.test(eff));
  check('notice: alreadyUsed from PRICING price + page symbol', /FREE_REPORT_STRINGS\.alreadyUsed\(price, displaySymbol\)/.test(ps)
    && /const price = PRICING\.salvageAssessment\.price;/.test(ps));
  check('notice: linkFailed + "Get a fresh link" → /salvage/free-report',
    /\{FREE_REPORT_STRINGS\.linkFailed\} <a href="\/salvage\/free-report"[^>]*>\{FREE_REPORT_STRINGS\.linkFailedCta\}<\/a>/.test(ps));
  check('readyOnPage still shows only while the token is held', /\{freeReportToken && \(\s*<div[^>]*>\s*\{FREE_REPORT_STRINGS\.readyOnPage\}/.test(ps));
}

// ── 6. earlier validators unchanged ──────────────────────────────────────────────────────────────────
console.log('\n── earlier validators ──');
const run = (f, loader) => spawnSync(process.execPath, [...(loader ? ['--loader', './scripts/lib/alias-loader.mjs'] : []), f], { encoding: 'utf8' }).stdout;
const r224 = run('scripts/validate-batch224.mjs', true).match(/Result: (\d+) passed, (\d+) failed/);
const rfr = run('scripts/validate-free-report.mjs', false).match(/Result: (\d+) passed, (\d+) failed/);
check(`validate-batch224 33/0 (got ${r224?.[1]}/${r224?.[2]})`, r224?.[1] === '33' && r224?.[2] === '0');
check(`validate-free-report 20/0 (got ${rfr?.[1]}/${rfr?.[2]})`, rfr?.[1] === '20' && rfr?.[2] === '0');

console.error = origErr;
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail) process.exit(1);
