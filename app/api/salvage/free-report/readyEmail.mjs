// batch 224 — ONE owner for the "your free report is ready" email. It builds the direct link back to the
// free report and sends it. verify/route.js (on confirm) and request/route.js (on asking again with an
// unused token) both call it; nothing else builds this link. Throws on a send failure — callers log it.
import { sendTransactionalEmail } from '@/lib/email.mjs';
import { FREE_REPORT_STRINGS } from '@/config/freeReport.mjs';

export function freeReportReadyLink(base, token) {
  return `${base}/salvage?free_report_token=${encodeURIComponent(token)}`;
}

export async function sendFreeReportReadyEmail(to, token, base, send = sendTransactionalEmail) {
  const link = freeReportReadyLink(base, token);
  await send({
    to,
    subject: FREE_REPORT_STRINGS.readySubject,
    htmlContent:
      `<p>${FREE_REPORT_STRINGS.readyBody}</p>` +
      `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#f05a1a;color:#fff;` +
      `text-decoration:none;border-radius:8px;font-weight:600">${FREE_REPORT_STRINGS.readyButton}</a></p>`,
  });
}
