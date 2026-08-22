// One transactional email sender for the whole app (BUILD_StoredReports §4b).
//
// Brevo `/v3/smtp/email`, plain fetch, no SDK — the same call that was inline in
// app/api/salvage/free-report/request/route.js. Extracted here so there is ONE sender, not two
// copies. Sends from noreply@motorquoter.app.
//
// The purchase email (dispatchReportEmail) is TRANSACTIONAL — it is the goods the customer paid for.
// Every Checkout Session has consent_collection:none, so NO marketing consent exists: this email
// carries the report and nothing promotional.
//
// buildPdf (and its jsPDF dependency) is imported LAZILY inside dispatchReportEmail so that callers
// which only need the plain sender — e.g. the free-report verification link — do not pull jsPDF into
// their bundle.

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const SENDER = { name: 'MotorQuoter', email: 'noreply@motorquoter.app' };

// Low-level sender. Throws on a missing key or a non-2xx response — callers decide whether that is
// fatal (verification flow) or swallow-and-log (the report email, which must never fail a page load).
export async function sendTransactionalEmail({ to, subject, htmlContent, attachment }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY missing');
  const body = { sender: SENDER, to: [{ email: to }], subject, htmlContent };
  if (attachment) body.attachment = Array.isArray(attachment) ? attachment : [attachment];
  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return true;
}

function reportFilename(vrm, now) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
  return `${(vrm || 'report').toUpperCase()}_${datePart}.pdf`;
}

// Build the report PDF server-side and email it as an attachment. FULLY GUARDED: returns false on
// any problem (no email address, PDF build error, Brevo failure) and never throws — the customer's
// page load must not depend on this. Call it from `after()` so it runs post-response.
export async function dispatchReportEmail({ to, vrm, result, checks, market }) {
  try {
    if (!to || !result || !vrm) {
      console.warn(`[REPORT EMAIL] skipped — missing ${!to ? 'recipient' : !result ? 'result' : 'vrm'} (vrm=${vrm || '∅'})`);
      return false;
    }
    const now = new Date();
    const checksArr = Array.isArray(checks) ? checks : (checks || '').split(',').filter(Boolean);
    const { buildPdf } = await import('@/app/api/generate-pdf/route');
    const pdfBuffer = buildPdf(result, vrm, checksArr, now.toLocaleDateString('en-GB'));
    const base64 = Buffer.from(pdfBuffer).toString('base64');
    const filename = reportFilename(vrm, now);
    const isIE = market === 'IE';
    await sendTransactionalEmail({
      to,
      subject: `Your MotorQuoter report — ${vrm.toUpperCase()}`,
      htmlContent:
        `<p>Thank you for your purchase. Your ${isIE ? 'Irish ' : ''}vehicle report for ` +
        `<strong>${vrm.toUpperCase()}</strong> is attached as a PDF.</p>` +
        `<p>This is your copy to keep. The online report remains available for a short time only, ` +
        `so please save this email.</p>` +
        `<p>— MotorQuoter</p>`,
      attachment: { content: base64, name: filename },
    });
    console.log(`[REPORT EMAIL] sent vrm=${vrm.toUpperCase()} to=${String(to).replace(/(.).*(@.*)/, '$1***$2')}`);
    return true;
  } catch (err) {
    console.error('[REPORT EMAIL] send failed (report still delivered on-screen):', err?.message || err);
    return false;
  }
}
