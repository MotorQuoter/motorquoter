// Unit tests for lib/bookingLine.mjs — booking window state machine + code-owned checklist warning.
// Run: node scripts/validate-booking-line.mjs   (expect "N passed, 0 failed")
import { computeBookingLine, bookingHeaderSuffix, isChecklistSuppressed, checklistWarning } from '../lib/bookingLine.mjs';
import { SALE_PASSED_WARNING, WINDOW_CLOSED_WARNING } from '../config/booking.mjs';

let pass = 0, fail = 0;
const H = 3600 * 1000;
const now = Date.now();
function check(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

console.log('── computeBookingLine states (Date.now()-relative) ──');
check("open (sale >48h away) → 'deadline'",          computeBookingLine({ _saleDateMs: now + 100 * H, _saleDateOffsetH: 1 }).state === 'deadline');
check("closed (sale <48h away) → 'window-closed'",   computeBookingLine({ _saleDateMs: now + 10 * H,  _saleDateOffsetH: 1 }).state === 'window-closed');
check("past (sale already gone) → 'past-generic'",   computeBookingLine({ _saleDateMs: now - 5 * H,   _saleDateOffsetH: 1 }).state === 'past-generic');
check("absent sale date → 'absent-generic'",         computeBookingLine({ _saleDateMs: null }).state === 'absent-generic');
check("unparseable (NaN) → 'unparseable-generic'",   computeBookingLine({ _saleDateMs: NaN }).state === 'unparseable-generic');
// Shut states no longer carry a booking line — the section is suppressed and checklistWarning owns the text.
check("window-closed → line is null (section suppressed)", computeBookingLine({ _saleDateMs: now + 10 * H }).line === null);
check("past-generic → line is null (section suppressed)",  computeBookingLine({ _saleDateMs: now - 5 * H }).line === null);
// Live (rendered) states still carry a booking line.
check("deadline → line present",                     typeof computeBookingLine({ _saleDateMs: now + 100 * H, _saleDateOffsetH: 1 }).line === 'string');
check("absent-generic → generic 48h line present",   /must be booked at least 48 hours/.test(computeBookingLine({ _saleDateMs: null }).line));

console.log('\n── isChecklistSuppressed ──');
check("window-closed is suppressed",  isChecklistSuppressed('window-closed') === true);
check("past-generic is suppressed",   isChecklistSuppressed('past-generic') === true);
check("deadline is NOT suppressed",   isChecklistSuppressed('deadline') === false);
check("absent-generic NOT suppressed", isChecklistSuppressed('absent-generic') === false);

console.log('\n── checklistWarning ──');
check("past-generic → SALE_PASSED_WARNING",     checklistWarning('past-generic') === SALE_PASSED_WARNING);
check("window-closed → WINDOW_CLOSED_WARNING",  checklistWarning('window-closed') === WINDOW_CLOSED_WARNING);
check("deadline → null (no warning)",           checklistWarning('deadline') === null);
check("absent-generic → null (no warning)",     checklistWarning('absent-generic') === null);
// The two suppressed states map to distinct, non-empty warnings.
check("SALE_PASSED and WINDOW_CLOSED differ",   SALE_PASSED_WARNING !== WINDOW_CLOSED_WARNING && SALE_PASSED_WARNING.length > 0 && WINDOW_CLOSED_WARNING.length > 0);

console.log('\n── bookingHeaderSuffix (collapsed to open/deadline case) ──');
check("returns the open/deadline suffix",        bookingHeaderSuffix() === 'book 48hrs before sale');
check("no state dependence (ignores any arg)",   bookingHeaderSuffix('past-generic') === 'book 48hrs before sale' && bookingHeaderSuffix('window-closed') === 'book 48hrs before sale');

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
