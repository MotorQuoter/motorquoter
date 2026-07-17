// Free First Report (Option A) — code-owned config: single owner of the rate limits, link
// lifetime, the locked user-facing strings (ruling E), and the disposable-domain blocklist.
// .mjs so the validation script can import it under plain node (repo has no "type":"module").

// Rate limits (ruling D) — named constants, single-line changes later.
export const FREE_REPORT_IP_LIMIT_PER_DAY     = 3;   // verification-email requests per IP per day
export const FREE_REPORT_GLOBAL_LIMIT_PER_DAY = 100;  // global cap, counted at the request route
export const FREE_REPORT_LINK_TTL_HOURS       = 24;  // signed-link lifetime (matches email copy)
export const FREE_REPORT_REQUEST_PRUNE_DAYS   = 2;   // opportunistic prune of free_report_requests

// Brevo marketing list (optional). Empty → contact is created/updated without list membership
// (consent still recorded on the token row, which is the source of truth). Set later if wanted.
export const FREE_REPORT_BREVO_LIST_ID = null;

// Locked strings (ruling E — verbatim, do not vary). String 1 (marking) is used by Commit 4.
// The disposable string is CC-picked (ruling delegated) and open to your reword — non-blocking.
export const FREE_REPORT_STRINGS = {
  marking:      'Free sample report — your complimentary MotorQuoter assessment.',
  requestForm:  "Get your first assessment free. Enter your email and we'll send you a verification link — one free report per buyer, no card needed.",
  consent:      'Send me occasional salvage buying tips and MotorQuoter updates. You can unsubscribe at any time.',
  emailSubject: 'Your free MotorQuoter report — confirm your email',
  emailBody:    "Tap the button below to confirm your email and unlock your free salvage assessment. This link expires in 24 hours. If you didn't request this, ignore this email — nothing will be sent.",
  neutral:      'If that address is eligible, a verification link is on its way. Check your inbox and spam folder.',
  globalCap:    "Today's free reports have all been claimed — more available tomorrow.",
  disposable:   'Please use a non-disposable email address so we can send your verification link.',
};

// Static disposable / temporary-email domain blocklist (code-owned, in repo). Inherently
// incomplete — new throwaway domains appear; this is a coarse first filter, not a guarantee.
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'getnada.com', 'trashmail.com', 'fakeinbox.com',
  'sharklasers.com', 'maildrop.cc', 'dispostable.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'emailondeck.com', 'tempinbox.com', 'spamgourmet.com', 'mytemp.email',
  'discard.email', 'moakt.com', 'tempr.email', 'burnermail.io', 'guerrillamailblock.com',
]);
