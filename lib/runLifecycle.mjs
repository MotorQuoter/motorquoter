// batch 252 A1/A3/B — THE ONE OWNER OF "IS THIS RUN DEAD, AND WHAT HAPPENS THEN".
//
// A1 (Vincent, 19 Nov): the assess route's maxDuration is 800 s (Pro + fluid). A run is only judged dead once it CANNOT
// still be alive: STALE_RUN_SECS after the run's own start stamp (`vehicle_details._runProgress.startedAt`, written in
// the same update that claims status 'processing' on the paid path). 900 = 800 + 100 s margin. The start stamp is written
// before the image fetch and the pipeline, and Vercel's kill counts from the request's start (earlier still), so at
// startedAt + 900 the function has been gone for at least 100 s.
// A row with no start stamp (a legacy row, or a promo row whose separate stamp write failed) falls back to created_at,
// which is EARLIER than the run start by the whole checkout/upload time, so it gets a far wider window.
//
// A3: `_runProgress` = { sha, startedAt, phase, ms } in vehicle_details, written at phase boundaries. A stamp write
// never fails the run (the route swallows and logs it). `assessment` stays null until the final save.
//
// B (commercial ruling, Vincent 19 Nov: "yes"): a PAID run found dead (status 'processing', assessment null, past the
// window) is refunded once, idempotently, through refundSalvageCharge (the helper the 529 abort and the failed-save path
// share; it reads the intent's refunds first and never refunds twice). A promo / free run is reset to promo_redeemed so
// the same session runs again — the use it consumed is restored by that reset, never by a counter decrement (that would
// hand back a second use). Never refunded: a run that completed (assessment present), a run that could still be alive
// (inside the window), a re-run of a report already delivered (rerun_count >= 1 or prior_assessment present — the buyer
// got what they paid for), or a row another request has already settled (the status flip is the lock).
import { refundSalvageCharge } from './salvageRefund.mjs';

export const RUN_MAX_SECS = 800;          // = export const maxDuration in app/api/salvage/assess/route.js (validator pins both)
export const STALE_RUN_SECS = 900;        // from _runProgress.startedAt: RUN_MAX_SECS + 100 s margin
export const STALE_FALLBACK_SECS = 1800;  // from created_at (no start stamp): checkout + upload time on top of the run

// Buyer wording — Vincent, batch 252 B1 (verbatim).
export const RUN_DIED_REFUNDED_MESSAGE = 'Your assessment did not complete, so we have refunded your payment in full. You can run it again from the salvage page.';
export const RUN_DIED_FREE_MESSAGE = 'Your assessment did not complete. Your free report has not been used - you can run it again.';
export function runDiedRefundFailedMessage(reference) {
  return `Your assessment did not complete. We could not refund your payment automatically — please contact support@motorquoter.app and we will refund you straight away.${reference ? ` (Reference: ${reference}).` : ''}`;
}
// A dead free RE-RUN of a delivered paid report: nothing to refund (the report was delivered); the old wording stands.
export const RUN_TIMED_OUT_MESSAGE = 'Assessment timed out — please try again';

/** The run-start stamp, written with status 'processing'. */
export function runStartStamp(sha, now = Date.now()) {
  return { sha: sha || 'n/a', startedAt: new Date(now).toISOString(), phase: 'start', ms: 0 };
}

/** { ageSec, basis, windowSec } for a row { created_at, vehicle_details: { _runProgress } }. */
export function runAge(row, now = Date.now()) {
  const started = Date.parse(row?.vehicle_details?._runProgress?.startedAt ?? '');
  if (Number.isFinite(started)) return { ageSec: (now - started) / 1000, basis: 'startedAt', windowSec: STALE_RUN_SECS };
  const created = Date.parse(row?.created_at ?? '');
  if (Number.isFinite(created)) return { ageSec: (now - created) / 1000, basis: 'created_at', windowSec: STALE_FALLBACK_SECS };
  return { ageSec: Infinity, basis: 'none', windowSec: STALE_FALLBACK_SECS };
}

/** true only when the row is a run that cannot still be alive. */
export function isRunDead(row, now = Date.now()) {
  if (row?.status !== 'processing' || row?.assessment != null) return false;
  const { ageSec, windowSec } = runAge(row, now);
  return ageSec > windowSec;
}

/** A re-run of a report the buyer already received (rerun/route.js sets rerun_count and keeps prior_assessment). */
export function isDeliveredRerun(row) {
  return (row?.rerun_count ?? 0) >= 1 || row?.prior_assessment != null;
}

/**
 * Settle a dead run. Caller has already checked isRunDead(row). Injected effects (no Supabase / Stripe import here):
 *   claimDead(nextStatus) → Promise<boolean>  atomic flip 'processing' → nextStatus where assessment is null; true = this
 *                                             request won (the lock: exactly one request settles a dead run)
 *   markRow(fields)       → Promise           merge fields into vehicle_details (failure is logged, never thrown)
 *   reread()              → Promise<row>      the row after losing the flip
 *   stripe                                    Stripe client (paid only)
 *   alert(kind, subject, body)                ops page on a refund failure
 * Returns { http, body } for the route to send.
 */
export async function settleDeadRun({ row, promo, salvageId, paymentIntentId, chargeAmount, stripe, claimDead, markRow, reread, alert, log = console.error, now = Date.now() } = {}) {
  const phase = row?.vehicle_details?._runProgress?.phase ?? 'unknown';
  const at = new Date(now).toISOString();
  const age = runAge(row, now);
  const tag = `[RUN DIED] salvageId=${salvageId} phase=${phase} age=${Math.round(age.ageSec)}s basis=${age.basis}`;

  if (promo) {
    const won = await claimDead('promo_redeemed');
    if (!won) return loserReply(await safe(reread), log, tag);
    log(`${tag} promo/free — reset to promo_redeemed; the same session runs again (use restored)`);
    await safeMark(markRow, { _runDied: { at, phase, kind: 'promo' } }, log, tag);
    return { http: 500, body: { error: RUN_DIED_FREE_MESSAGE, runDied: true, refundStatus: 'no_charge' } };
  }

  const won = await claimDead('failed');
  if (!won) return loserReply(await safe(reread), log, tag);

  if (isDeliveredRerun(row)) {
    log(`${tag} free re-run of a delivered report — no refund (the paid report was delivered); reset to failed`);
    await safeMark(markRow, { _runDied: { at, phase, kind: 'rerun' } }, log, tag);
    return { http: 500, body: { error: RUN_TIMED_OUT_MESSAGE, runDied: true, refundStatus: 'no_charge' } };
  }

  const refund = await refundSalvageCharge(stripe, { paymentIntentId, chargeAmount, salvageId, reason: 'run-died' });
  if (refund.status === 'refunded') {
    log(`${tag} refunded refundId=${refund.refundId} idempotent=${refund.idempotent} paymentIntentId=${paymentIntentId} amount=${chargeAmount}`);
    await safeMark(markRow, { _refunded: { at, reason: 'run died', phase, refundId: refund.refundId ?? null, status: 'refunded' } }, log, tag);
    return { http: 500, body: { error: RUN_DIED_REFUNDED_MESSAGE, refunded: true, refundStatus: 'refunded', runDied: true } };
  }
  log(`${tag} REFUND FAILED paymentIntentId=${paymentIntentId ?? 'none'} amount=${chargeAmount ?? 'none'} error=${JSON.stringify(refund.error)}`);
  await safeMark(markRow, { _refunded: { at, reason: 'run died', phase, refundId: null, status: 'refund_failed', error: String(refund.error ?? '') } }, log, tag);
  try {
    await alert?.('run-died-refund-failed', 'MotorQuoter: a dead paid assessment could not be refunded',
      `salvage ${salvageId}, payment intent ${paymentIntentId ?? 'not captured'}, amount ${chargeAmount ?? '?'}: the run died in phase ${phase} and the automatic refund failed (${refund.error}). Refund it by hand.`);
  } catch (err) { log(`${tag} alert failed: ${err?.message || err}`); }
  return { http: 500, body: { error: runDiedRefundFailedMessage(paymentIntentId || salvageId), refunded: false, refundStatus: 'refund_failed', runDied: true } };
}

// Another request settled (or a run started) between our read and our flip: report what the row now says, never act.
function loserReply(row, log, tag) {
  const vd = row?.vehicle_details || {};
  if (vd._refunded?.status === 'refunded') return { http: 500, body: { error: RUN_DIED_REFUNDED_MESSAGE, refunded: true, refundStatus: 'refunded', runDied: true } };
  if (vd._refunded?.status === 'refund_failed') return { http: 500, body: { error: runDiedRefundFailedMessage(null), refunded: false, refundStatus: 'refund_failed', runDied: true } };
  if (vd._runDied?.kind === 'promo') return { http: 500, body: { error: RUN_DIED_FREE_MESSAGE, runDied: true, refundStatus: 'no_charge' } };
  log(`${tag} lost the settle race — row status=${row?.status ?? '?'}; no action`);
  return { http: 409, body: { error: 'Assessment already in progress' } };
}
async function safe(fn) { try { return await fn?.(); } catch { return null; } }
async function safeMark(markRow, fields, log, tag) {
  try { await markRow?.(fields); } catch (err) { log(`${tag} row mark failed: ${err?.message || err}`); }
}
