// Free First Report (Option A) — code-owned config: single owner of the rate limits, link
// lifetime, the locked user-facing strings (ruling E), and the disposable-domain blocklist.
// .mjs so the validation script can import it under plain node (repo has no "type":"module").

// Rate limits (ruling D) — named constants, single-line changes later.
export const FREE_REPORT_IP_LIMIT_PER_DAY     = 3;   // verification-email requests per IP per day
export const FREE_REPORT_GLOBAL_LIMIT_PER_DAY = 100;  // global cap, counted at the request route
export const FREE_REPORT_LINK_TTL_HOURS       = 24;  // signed-link lifetime (matches email copy)
export const FREE_REPORT_REQUEST_PRUNE_DAYS   = 2;   // opportunistic prune of free_report_requests
// batch 236 — free reports RUN (tokens consumed) in a rolling 24h, checked in promo-checkout before the consume.
// Each run is ~£1.60 of model calls; this is the cost guard now that there is no confirm-email step.
export const FREE_REPORT_RUN_LIMIT_PER_DAY    = 20;
// batch 236 — every free report used emails this address (no customer email in the alert).
export const FREE_REPORT_ALERT_TO = 'vincent@motorquoter.app';

// Brevo marketing list (optional). Empty → contact is created/updated without list membership
// (consent still recorded on the token row, which is the source of truth). Set later if wanted.
export const FREE_REPORT_BREVO_LIST_ID = null;

// Locked strings (ruling E — verbatim, do not vary). String 1 (marking) is used by Commit 4.
// The disposable string is CC-picked (ruling delegated) and open to your reword — non-blocking.
export const FREE_REPORT_STRINGS = {
  marking:      'Free sample report — your complimentary MotorQuoter assessment.',
  // batch 240 — /salvage/free-report, top to bottom: intro line, form, "How it works", the example label.
  introLine:    'Enter your email here to try it free. No card needed - one free report per buyer.',
  howHeading:   'How it works',
  howSteps: [
    'Enter your email and tap Start.',
    "Paste the Copart lot page and add the lot's photos (the zip Copart lets you download).",
    "Get the repair cost, what it's worth fixed, the auction fees and the most you can bid to break even.",
  ],
  howDevice:    "Photos are easiest from a computer - we email you the link so you can finish there.",
  exampleLabel: "Here's a real report:",
  // batch 240 — /salvage while a free-report token is held: the box at the top of the form.
  freeStepsHeading: 'Your free report - two steps',
  freeSteps: ['1. Paste the whole Copart lot page.', '2. Add the photos zip.'],
  freeStepsThen: 'Then tap Get my free assessment.',
  consent:      'Send me occasional salvage buying tips and MotorQuoter updates. You can unsubscribe at any time.',
  // legacy - confirm step dropped batch 236 (verify/route.js still serves links already sent)
  emailSubject: 'Your free MotorQuoter report — confirm your email',
  // legacy - confirm step dropped batch 236
  emailBody:    "Tap the button below to confirm your email and unlock your free salvage assessment. This link expires in 24 hours. If you didn't request this, ignore this email — nothing will be sent.",
  neutral:      'Too many requests from this connection today. Please try again tomorrow.', // batch 236 — now the per-IP cap reply only
  globalCap:    "Today's free reports have all been claimed — more available tomorrow.",
  disposable:   'Please use a non-disposable email address.',
  // batch 224 — the "your free report is ready" email (sent on confirm, and again when an unused address asks
  // again) and the line under the submit button. Code-owned, verbatim from the brief.
  readySubject: 'Your free MotorQuoter salvage report is ready',
  readyBody:    "Your free salvage assessment is waiting. Open the button below on whichever device has the auction photos. It works until you use it, so there's no rush. Paste the auction listing, add the photos, and you'll get the itemised repair, what the car is worth fixed, the auction fees and the most you can bid to break even.",
  readyButton:  'Start my free report',
  readyOnPage:  "We've emailed you this link too. If you close this page, open that email and tap the button again. Your free report stays there until you use it.",
  // batch 225 — why a link failed, and a used free report. alreadyUsed takes the price from PRICING (never a literal).
  linkFailed:    "That link didn't work. Links last 24 hours. Enter your email again below and we'll send you a fresh one.",
  linkFailedCta: 'Get a fresh link',
  alreadyUsed:   (price, symbol = '£') => `This free report has already been used. Further reports are ${symbol}${Number(price).toFixed(2)}.`,
  // batch 227 — the line under the /salvage price badge that links to /salvage/free-report.
  freeLinkOnSalvage: 'First report free — get your free link',
  // batch 236 — the rolling-24h run cap is reached. The token is NOT consumed, so it still works tomorrow.
  runCap: "Today's free reports have all been used. Your free report is still yours - come back tomorrow and it will be waiting.",
};

// batch 225 — the one line /salvage/free-report shows for ?free_error=<reason>. already_used → the used-report line;
// every other reason (malformed, bad-signature, expired, issue_failed) and any unknown value → linkFailed. No reason → null.
export function freeErrorLine(reason, price, symbol = '£') {
  if (!reason) return null;
  return reason === 'already_used' ? FREE_REPORT_STRINGS.alreadyUsed(price, symbol) : FREE_REPORT_STRINGS.linkFailed;
}

// Static disposable / temporary-email domain blocklist (code-owned, in repo). Inherently
// incomplete — new throwaway domains appear; this is a coarse first filter, not a guarantee.
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'getnada.com', 'trashmail.com', 'fakeinbox.com',
  'sharklasers.com', 'maildrop.cc', 'dispostable.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'emailondeck.com', 'tempinbox.com', 'spamgourmet.com', 'mytemp.email',
  'discard.email', 'moakt.com', 'tempr.email', 'burnermail.io', 'guerrillamailblock.com',
  'dreameg.com', // batch 224
]);
