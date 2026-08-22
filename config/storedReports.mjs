// Stored-reports retention — Vincent's decision, 21 Aug 2026.
//
// A paid report is stored (paid_reports) the moment it is served, keyed on the purchase, so a
// refresh / tab-close / crash inside the window re-opens it as a pure DB read — no supplier calls,
// no free re-fetch. The window is deliberately SHORT: crash recovery only. The customer's durable
// copy reaches them by email at purchase (BUILD_StoredReports §4b); after the window they buy again.
//
// Data held is minimal and short-lived — the right posture for an ICO-registered B2C product.
export const STORED_REPORT_TTL_MINUTES = 10;
export const STORED_REPORT_TTL_MS = STORED_REPORT_TTL_MINUTES * 60 * 1000;
