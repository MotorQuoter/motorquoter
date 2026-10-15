// batch 236 — one email to Vincent every time a free report is used (promo-checkout, after the token is consumed and
// the session exists). Not throttled. Best-effort and time-boxed like lib/opsAlert.mjs: callers await it, it never
// throws, and it never changes their response. No customer email address goes in it.
import { sendTransactionalEmail } from '@/lib/email.mjs';
import { FREE_REPORT_ALERT_TO, FREE_REPORT_RUN_LIMIT_PER_DAY } from '@/config/freeReport.mjs';

const ALERT_TIMEOUT_MS = 2000;

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The alert's subject and body. Pure, so the validator can read it. usedToday = consumed in the rolling 24h,
// this one included.
export function freeReportAlertEmail({ usedToday, at, utm, vrm, lotNumber }) {
  const utmLine = [utm?.utm_source, utm?.utm_medium, utm?.utm_campaign].some((v) => v != null)
    ? [utm.utm_source, utm.utm_medium, utm.utm_campaign].map((v) => esc(v ?? '-')).join(' / ')
    : 'none';
  const vehicle = [vrm && `reg ${esc(vrm)}`, lotNumber && `lot ${esc(lotNumber)}`].filter(Boolean).join(', ') || 'none';
  return {
    to: FREE_REPORT_ALERT_TO,
    subject: `Free report used (${usedToday} in last 24h)`,
    htmlContent:
      `<p>Time (UTC): ${esc(at.toISOString().replace('T', ' ').slice(0, 19))}</p>` +
      `<p>Source / medium / campaign: ${utmLine}</p>` +
      `<p>Vehicle: ${vehicle}</p>` +
      `<p>Free reports used in the last 24 hours: ${usedToday} of ${FREE_REPORT_RUN_LIMIT_PER_DAY}</p>`,
  };
}

// Never throws. Returns { sent: true } or { error } for logging/tests.
export async function sendFreeReportAlert(details, send = sendTransactionalEmail) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ALERT_TIMEOUT_MS); });
    await Promise.race([send(freeReportAlertEmail(details)), timeout]);
    return { sent: true };
  } catch (err) {
    console.error('[FREE REPORT][ALERT] send failed:', err.message);
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
