// batch 253 A2 — the waiting page's poll decisions. BROWSER-SAFE: no imports (app/salvage/success/page.js imports this;
// the server-side status reply lives in lib/assessStatus.mjs).
export const POLL_INTERVAL_MS = 15000;
// 72 polls × 15 s = 18 min — past the 800 s run plus the 900 s dead-run window, so a dead run is always reached.
export const MAX_POLLS = 72;

/** 'show' (render the report) | 'fail' (error state) | 'reassess' (ask the assess GET once) | 'continue' (poll again). */
export function nextPollAction(reply) {
  const s = reply?.status;
  if (s === 'complete' && reply.assessment) return 'show';
  if (s === 'dead') return 'reassess';
  if (s === 'processing') return 'continue';
  return 'fail';
}

/** A dropped connection (fetch threw) or 409 "already in progress" hands over to polling; anything else does not. */
export function shouldPoll({ networkError = false, httpStatus = null } = {}) {
  return networkError === true || httpStatus === 409;
}
