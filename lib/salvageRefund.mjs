// batch 138 item 3 (Vincent, 15 Sep — ruling on the batch 136 E flag: "yes").
// A PAID salvage report that fails to save is refunded automatically — through the same refund path the 529/overload
// abort uses (this helper; both call sites share it), idempotent (never refunds twice), and with no live Stripe call
// in validation: the Stripe client is passed in, so validate-refund-registry drives it with a fake.
//
// Idempotency follows the vehicle route's executeItemRefund pattern (list the payment intent's refunds first): a
// salvage assessment is ONE item per charge, so any refunds already on the intent that cover the charge mean it has
// been refunded — reuse, never create a second. New refunds carry metadata { item, reason, salvage_id }.
//
// Promo and free-report sessions carry a promo token (both enter through promo-checkout); nothing was charged, so no
// refund — the status reset stays exactly as before (the route's catch: promo_redeemed).

export const SALVAGE_REFUND_ITEM = 'salvage_assessment';

// Wording APPROVED by Vincent, 15 Sep (batch 138 item 3 — "Say it was refunded").
export const SAVE_FAILED_REFUNDED_MESSAGE = "Your assessment couldn't be saved, so your payment has been refunded automatically. It should return to your account within a few working days.";
export function saveFailedRefundFailedMessage(paymentIntentId) {
  return `Your assessment couldn't be saved. We couldn't refund you automatically — please contact support@motorquoter.app and we'll refund you straight away.${paymentIntentId ? ` (Reference: ${paymentIntentId}).` : ''}`;
}

// Refund the whole charge once. Returns { status: 'refunded', refundId, idempotent } or { status: 'refund_failed', error }.
export async function refundSalvageCharge(stripe, { paymentIntentId, chargeAmount, salvageId, reason } = {}) {
  if (!paymentIntentId || !chargeAmount) {
    return { status: 'refund_failed', error: 'payment intent or charge amount not captured — manual reconciliation needed' };
  }
  try {
    const existing = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const live = (existing?.data || []).filter((r) => r.status !== 'failed' && r.status !== 'canceled');
    const refunded = live.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    if (refunded >= chargeAmount) {
      return { status: 'refunded', refundId: live[0]?.id ?? null, idempotent: true };
    }
    const r = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: chargeAmount - refunded,
      metadata: { item: SALVAGE_REFUND_ITEM, reason: reason || 'unspecified', salvage_id: salvageId || '' },
    });
    return { status: 'refunded', refundId: r.id, idempotent: false };
  } catch (err) {
    return { status: 'refund_failed', error: err?.message ?? String(err) };
  }
}

// The failed-save decision, end to end. Promo / free report → { generic: true } (the route throws into its catch:
// status reset to promo_redeemed, the existing "Assessment failed"). Paid → status reset to failed, refund once, log,
// and the approved message for the route to return.
export async function settleFailedSave({ promoToken, salvageId, paymentIntentId, chargeAmount, stripe, resetStatus, log = console.error } = {}) {
  if (promoToken) return { generic: true, refundStatus: 'no_charge' };
  await resetStatus();
  const refund = await refundSalvageCharge(stripe, { paymentIntentId, chargeAmount, salvageId, reason: 'save-failed' });
  if (refund.status === 'refunded') {
    log(`[ASSESSMENT SAVE FAILED][REFUNDED] salvageId=${salvageId} refundId=${refund.refundId} idempotent=${refund.idempotent} paymentIntentId=${paymentIntentId} amount=${chargeAmount}`);
    return { generic: false, refundStatus: 'refunded', message: SAVE_FAILED_REFUNDED_MESSAGE };
  }
  log(`[ASSESSMENT SAVE FAILED][REFUND FAILED] salvageId=${salvageId} paymentIntentId=${paymentIntentId ?? 'none'} amount=${chargeAmount ?? 'none'} error=${JSON.stringify(refund.error)}`);
  return { generic: false, refundStatus: 'refund_failed', message: saveFailedRefundFailedMessage(paymentIntentId) };
}

// batch 140 W4 (Vincent, 15 Sep: "yes block."): once a salvage charge has been refunded — by the failed-save path, the 529
// abort, or by hand — that session never runs an assessment again. READ-ONLY: lists the payment intent's refunds (the same
// record refundSalvageCharge reads) and never creates one. Returns { refunded, refundedAmount[, error] }. If Stripe cannot
// be read the answer is refunded:false with the error — the route then ALLOWS the run and logs it, so a paying customer is
// never blocked by a failed check.
export const REFUNDED_SESSION_MESSAGE = "The payment for this assessment has been refunded, so it can't be run again.";
export async function chargeRefunded(stripe, paymentIntentId, chargeAmount) {
  if (!paymentIntentId || !chargeAmount) return { refunded: false, refundedAmount: 0 };
  try {
    const existing = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const live = (existing?.data || []).filter((r) => r.status !== 'failed' && r.status !== 'canceled');
    const refundedAmount = live.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    return { refunded: refundedAmount >= chargeAmount, refundedAmount };
  } catch (err) {
    return { refunded: false, refundedAmount: 0, error: err?.message ?? String(err) };
  }
}
