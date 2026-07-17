// Single owner of the Copart £10 inspection booking reminder + the code-owned checklist warning.
// Holds: the computed-deadline state machine, the checklist-section suppression predicate, the
// state-appropriate warning line (rendered in place of the section when suppressed), and the
// checklist-header suffix. Shared by web (success/page.js) and PDF (pdf/route.js) so both
// surfaces speak with one voice on inspection timing.
//
// State is TIME-RELATIVE (Date.now()) — computed at render, never frozen at assess time:
// a report assessed while the window was open can be viewed after it closes. The inputs
// (_saleDateMs / _saleDateOffsetH) are stamped server-side (route.js) and persisted.
//
// computeBookingLine is impure (Date.now()); NEVER call it in a React render/effect body —
// call it in a handler and store the {line, state}. isChecklistSuppressed, checklistWarning and
// bookingHeaderSuffix ARE pure (state in, string out) and are render-safe.
import { SALE_PASSED_WARNING, WINDOW_CLOSED_WARNING } from '../config/booking.mjs';

// States: 'deadline' (window open, book-by date), 'window-closed' (sale <48h away),
// 'past-generic' (sale already passed), 'absent-generic' / 'unparseable-generic' (no
// computable sale date → generic 48h wording, window status UNKNOWN, not shut).
export function computeBookingLine(assessment) {
  const GEN = 'Physical inspection: £10, ~10 min — must be booked at least 48 hours before the sale.';
  const ms = assessment?._saleDateMs;
  const offH = assessment?._saleDateOffsetH;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return { line: GEN, state: (ms == null ? 'absent' : 'unparseable') + '-generic' };
  }
  const now = Date.now();
  const deadline = ms - 48 * 3600 * 1000;
  if (ms > now && now < deadline) {
    const d = new Date(deadline + (offH || 0) * 3600000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let h = d.getUTCHours(); const mnt = d.getUTCMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    const when = `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${String(mnt).padStart(2, '0')} ${ap} GMT${offH >= 0 ? '+' : ''}${offH}`;
    return { line: `Physical inspection: £10, ~10 min — book by ${when} at the latest (48h before the sale).`, state: 'deadline' };
  }
  // Sale within 48h or already passed → the checklist section is suppressed and
  // checklistWarning(state) renders in its place; no booking line is shown, so `line` is null.
  return { line: null, state: ms > now ? 'window-closed' : 'past-generic' };
}

// True when the checklist section must be suppressed ENTIRELY (header, items, £10 fee line,
// booking line) — the window is definitively shut (sale <48h away, or already passed). The
// generic states (deadline unknown) are NOT shut. Named for the section-gate call sites.
export function isChecklistSuppressed(state) {
  return state === 'window-closed' || state === 'past-generic';
}

// The code-owned line that renders IN PLACE OF the checklist section when it is suppressed.
// Returns null for non-suppressed states (callers gate on isChecklistSuppressed first; the null
// return keeps it safe either way).
export function checklistWarning(state) {
  if (state === 'past-generic')  return SALE_PASSED_WARNING;
  if (state === 'window-closed') return WINDOW_CLOSED_WARNING;
  return null;
}

// Checklist-header suffix (no "£10", no separator — each surface formats around it). The header
// only ever renders in the non-suppressed states (the section gate hides it when shut), so the
// former window-closed / past-generic suffixes are gone with the section.
export function bookingHeaderSuffix() {
  return 'book 48hrs before sale';
}
