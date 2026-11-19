// Validator — batch 253 A2: the waiting page survives a dropped connection (status route + poll). £0: synthetic rows only.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch253-a2.mjs
import { readFileSync } from 'node:fs';
import { ownsSession, statusReply } from '../lib/assessStatus.mjs';
import { nextPollAction, shouldPoll, POLL_INTERVAL_MS, MAX_POLLS } from '../lib/assessPoll.mjs';
import { RUN_DIED_REFUNDED_MESSAGE, RUN_DIED_FREE_MESSAGE, STALE_RUN_SECS, RUN_MAX_SECS } from '../lib/runLifecycle.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const REPORT = { _reconciledParts: [{ panelId: 'BONNET', used: 300 }], _runFacts: { usd: { total: 2.1 } }, 'Red Flags': '- x' };
const row = (over = {}) => ({ status: 'processing', assessment: null, market: 'GB', rerun_count: 0, stripe_session_id: 'cs_1', created_at: ago(120),
  vehicle_details: { promoToken: null, _runProgress: { startedAt: ago(100), phase: 'call1' } }, ...over });

// Drive the page's loop over a sequence of rows the status route would read, exactly as pollForResult does.
function drive(rows, { firstFetch }) {
  const trace = [];
  if (!shouldPoll(firstFetch)) return { trace: ['no-poll'], end: 'direct' };
  for (let i = 0; i < Math.min(rows.length, MAX_POLLS); i++) {
    const reply = statusReply(rows[i], NOW).body;
    const next = nextPollAction(reply);
    trace.push(`${reply.status}→${next}`);
    if (next !== 'continue') return { trace, end: next, reply };
  }
  return { trace, end: 'timeout' };
}

console.log('\nHand-over to polling');
ok('a network error hands over', shouldPoll({ networkError: true }));
ok('a 409 "already in progress" hands over', shouldPoll({ httpStatus: 409 }));
ok('a normal 200 / 500 / 503 / 410 does not (no change on a normal run)', [200, 500, 503, 410, 402].every(s => !shouldPoll({ httpStatus: s })));
ok('poll every 15 s, for longer than the run + the dead-run window', POLL_INTERVAL_MS === 15000 && MAX_POLLS * POLL_INTERVAL_MS / 1000 > RUN_MAX_SECS + STALE_RUN_SECS - RUN_MAX_SECS);

console.log('\nThe state machine');
{
  const r = drive([row(), row({ vehicle_details: { _runProgress: { startedAt: ago(100), phase: 'call2' } } }), row({ status: 'assessed', assessment: REPORT })], { firstFetch: { httpStatus: 409 } });
  ok('processing → processing → report (409 start)', r.end === 'show' && r.trace.join(' ') === 'processing→continue processing→continue complete→show');
  ok('the report reaches the page through forBuyer (no _runFacts)', r.reply.assessment && !('_runFacts' in r.reply.assessment) && r.reply.assessment._reconciledParts.length === 1);
  ok('the reply has the assess GET\'s shape (assessment, vehicleDetails, market, rerunCount, bregoData)', ['assessment', 'vehicleDetails', 'market', 'rerunCount', 'bregoData'].every(k => k in r.reply));
}
{
  const r = drive([row(), row({ status: 'assessed', assessment: REPORT })], { firstFetch: { networkError: true } });
  ok('network error → processing → report', r.end === 'show' && r.trace.join(' ') === 'processing→continue complete→show');
}
{
  const dead = row({ vehicle_details: { _runProgress: { startedAt: ago(STALE_RUN_SECS + 1), phase: 'call1' } } });
  const r = drive([row(), dead], { firstFetch: { networkError: true } });
  ok('processing → dead → ask the assess GET once (it settles the refund)', r.end === 'reassess');
  const refunded = row({ status: 'failed', vehicle_details: { _refunded: { status: 'refunded', reason: 'run died' } } });
  const r2 = drive([row(), refunded], { firstFetch: { httpStatus: 409 } });
  ok('processing → refunded: fail with refunded:true and the approved sentence', r2.end === 'fail' && r2.reply.refunded === true && r2.reply.error === RUN_DIED_REFUNDED_MESSAGE);
  const free = row({ status: 'promo_redeemed', vehicle_details: { promoToken: 't', _runDied: { kind: 'promo' } } });
  ok('a dead free run → the free sentence, retry allowed', statusReply(free, NOW).body.error === RUN_DIED_FREE_MESSAGE && statusReply(free, NOW).body.refunded === false);
  const caught = row({ status: 'failed', vehicle_details: {} });
  ok('a caught failure (status failed, no report) → fail, retry allowed', nextPollAction(statusReply(caught, NOW).body) === 'fail' && statusReply(caught, NOW).body.refunded === false);
}

console.log('\nAuth: never another session\'s report');
ok('paid: the session id must equal the row\'s stripe_session_id', ownsSession(row(), { sessionId: 'cs_1' }) && !ownsSession(row(), { sessionId: 'cs_2' }));
ok('paid: a row with no stored session id is never owned', !ownsSession(row({ stripe_session_id: null }), { sessionId: 'cs_1' }));
ok('promo: the token must equal the row\'s promoToken', ownsSession(row({ vehicle_details: { promoToken: 'p1' } }), { promoToken: 'p1' }) && !ownsSession(row({ vehicle_details: { promoToken: 'p1' } }), { promoToken: 'p2' }));
ok('no credential → not owned', !ownsSession(row(), {}));

console.log('\nRoute and page');
const route = readFileSync('app/api/salvage/status/route.js', 'utf8');
ok('status route: one row read, ownership checked before any reply, no Stripe, no model call',
  route.includes("if (!ownsSession(row, { sessionId, promoToken })) return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });")
  && !/stripe|anthropic/i.test(route.replace(/\/\/.*$/gm, '').replace(/stripe_session_id/g, '')));
ok('status route: no caching', route.includes("'Cache-Control': 'no-store'") && route.includes("export const dynamic = 'force-dynamic'"));
const page = readFileSync('app/salvage/success/page.js', 'utf8');
ok('page: one showReport for the direct reply and the poll', (page.match(/showReport\(/g) || []).length === 2 && page.includes('const showReport = (data) =>') && page.includes('if (next === \'show\') return showReport(reply);'));
ok('page: a dropped fetch and a 409 hand over to polling; the poll\'s own re-ask never loops', page.includes('if (shouldPoll({ networkError: true })) return pollForResult();') && page.includes('if (!fromPoll && shouldPoll({ httpStatus: res.status })) return pollForResult();'));
ok('page: imports only the browser-safe half (lib/assessPoll.mjs)', page.includes("from '@/lib/assessPoll.mjs'") && !page.includes('assessStatus'));
ok('page: the loading text is unchanged', page.includes('This usually takes 2 to 4 minutes'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
