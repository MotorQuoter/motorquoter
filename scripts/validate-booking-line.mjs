// Unit tests for lib/bookingLine.mjs — booking window state machine + code-owned checklist warning.
// Run: node scripts/validate-booking-line.mjs   (expect "N passed, 0 failed")
import { computeBookingLine, bookingHeaderSuffix, isChecklistSuppressed, checklistWarning } from '../lib/bookingLine.mjs';
import * as BOOKING from '../config/booking.mjs';
import { SALE_PASSED_WARNING, WINDOW_CLOSED_WARNING, CAT_NU_DIRECTIVE, categoryDirective, SALE_PASSED_REJECT_PAID, SALE_PASSED_REJECT_PROMO, SALE_PASSED_REJECT_FREE } from '../config/booking.mjs';

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

console.log('\n── categoryDirective (batch 134: the Cat S "Do not bid" directive is REMOVED — null, no Bid Directive; Cat N/U unchanged) ──');
check("'S' → no directive (null)",              categoryDirective('S') === null);
check("'Cat S' → no directive (null)",          categoryDirective('Cat S') === null);
check("'S Repairable' → no directive (null)",   categoryDirective('S Repairable') === null);
check("HV25ODX 'S REPAIRABLE STRUCTURAL' → no directive (null)", categoryDirective('S REPAIRABLE STRUCTURAL') === null);
check("'N' → CAT_NU",             categoryDirective('N') === CAT_NU_DIRECTIVE);
check("'Category N' → CAT_NU",    categoryDirective('Category N') === CAT_NU_DIRECTIVE);
check("'N Repairable' → CAT_NU",  categoryDirective('N Repairable') === CAT_NU_DIRECTIVE);
check("'U' → CAT_NU",             categoryDirective('U') === CAT_NU_DIRECTIVE);
check("'Cat U' → CAT_NU",         categoryDirective('Cat U') === CAT_NU_DIRECTIVE);
check("absent → no directive (null)",        categoryDirective('') === null && categoryDirective(null) === null);
check("unrecognised 'C' / 'A' / 'B' → no directive (null)", categoryDirective('C') === null && categoryDirective('A') === null && categoryDirective('B') === null);
check('the "Do not bid on this lot" text no longer exists anywhere in the booking config', !('CAT_S_DIRECTIVE' in BOOKING) && !Object.values(BOOKING).some((v) => typeof v === 'string' && /Do not bid on this lot/i.test(v)));
{
  const { readFileSync } = await import('node:fs');
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  check('screen: the Bid Directive renders only when categoryDirective returns a string', page.includes("some(f => f.weight === 'high') && categoryDirective(vehicleDetails?.category) && ("));
  check('PDF: the Bid Directive renders only when categoryDirective returns a string', pdf.includes("if (pdfFlags.some(f => f.weight === 'high') && categoryDirective(vd.category)) {"));
}

console.log('\n── sale-passed reject strings (Commit 4) ──');
const _rejects = [SALE_PASSED_REJECT_PAID, SALE_PASSED_REJECT_PROMO, SALE_PASSED_REJECT_FREE];
check("all three defined and non-empty", _rejects.every(s => typeof s === 'string' && s.length > 0));
check("all three distinct",              new Set(_rejects).size === 3);
check("paid variant says no payment taken",   /no payment has been taken/.test(SALE_PASSED_REJECT_PAID));
check("promo variant says code not used",     /your code has not been used/.test(SALE_PASSED_REJECT_PROMO));
check("free variant says free report not used", /your free report has not been used/.test(SALE_PASSED_REJECT_FREE));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
