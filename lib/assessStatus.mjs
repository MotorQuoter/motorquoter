// batch 253 A2 (Vincent, 19 Nov) — THE WAITING PAGE SURVIVES A DROPPED CONNECTION. Pure decisions, no I/O:
//   ownsSession(row, creds)   — the same credential the assess GET binds: a promo token must equal the row's promoToken; a paid
//                               session id must equal the row's stripe_session_id (written by the assess GET in the same update
//                               that claims 'processing'; the re-run route checks ownership the same way). No Stripe call.
//   statusReply(row, now)     — what GET /api/salvage/status answers for a row the caller owns.
//   nextPollAction / shouldPoll — the waiting page's half, in lib/assessPoll.mjs (browser-safe, re-exported here).
// The status route never settles a dead run itself (that needs Stripe): it says 'dead' and the page asks the assess GET once,
// which runs settleDeadRun (lib/runLifecycle.mjs) and returns the refund / free-run reply.
import { isRunDead, RUN_DIED_REFUNDED_MESSAGE, RUN_DIED_FREE_MESSAGE, runDiedRefundFailedMessage } from './runLifecycle.mjs';
import { forBuyer } from './runFacts.mjs';

export { POLL_INTERVAL_MS, MAX_POLLS, nextPollAction, shouldPoll } from './assessPoll.mjs';   // browser-safe half

export function ownsSession(row, { sessionId = null, promoToken = null } = {}) {
  if (!row) return false;
  if (promoToken) return !!row.vehicle_details?.promoToken && row.vehicle_details.promoToken === promoToken;
  if (sessionId) return !!row.stripe_session_id && row.stripe_session_id === sessionId;
  return false;
}

export function statusReply(row, now = Date.now()) {
  if (!row) return { http: 404, body: { status: 'missing', error: 'Session not found' } };
  const vd = row.vehicle_details || {};
  if (row.assessment) {
    return { http: 200, body: {
      status: 'complete',
      assessment: forBuyer(row.assessment), vehicleDetails: vd, market: row.market,
      rerunCount: row.rerun_count ?? 0, bregoData: vd.bregoValuation ?? null,
    } };
  }
  if (vd._refunded?.status === 'refunded') return { http: 200, body: { status: 'failed', refunded: true, refundStatus: 'refunded', error: RUN_DIED_REFUNDED_MESSAGE } };
  if (vd._refunded?.status === 'refund_failed') return { http: 200, body: { status: 'failed', refunded: false, refundStatus: 'refund_failed', error: runDiedRefundFailedMessage(null) } };
  if (row.status === 'processing') {
    if (isRunDead(row, now)) return { http: 200, body: { status: 'dead' } };
    return { http: 200, body: { status: 'processing', phase: vd._runProgress?.phase ?? null } };
  }
  if (vd._runDied?.kind === 'promo' && row.status === 'promo_redeemed') return { http: 200, body: { status: 'failed', refunded: false, refundStatus: 'no_charge', error: RUN_DIED_FREE_MESSAGE } };
  // 'failed' / 'promo_redeemed' / 'pending' with no report: the run ended without one (a caught failure); the page offers Retry.
  return { http: 200, body: { status: 'failed', refunded: false, error: 'Your assessment did not complete. Please try again.' } };
}
