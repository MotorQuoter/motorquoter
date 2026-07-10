// Unit tests for lib/bookingLine.mjs — booking window state machine + prose suppression.
// Run: node scripts/validate-booking-line.mjs   (expect "N passed, 0 failed")
import { computeBookingLine, suppressBookingSentence, bookingHeaderSuffix, isBookingShut } from '../lib/bookingLine.mjs';

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
check("window-closed line carries the closed message", /booking window has closed/.test(computeBookingLine({ _saleDateMs: now + 10 * H }).line));

console.log('\n── isBookingShut ──');
check("window-closed is shut",  isBookingShut('window-closed') === true);
check("past-generic is shut",   isBookingShut('past-generic') === true);
check("deadline is NOT shut",   isBookingShut('deadline') === false);
check("absent-generic NOT shut", isBookingShut('absent-generic') === false);

console.log('\n── suppressBookingSentence (boundary tests) ──');
const RA = 'Option B — proceed with caution. Book a £10 Copart WhatsApp video inspection (48hrs before sale minimum). Ask the handler to check the sills.';
check("window OPEN → prose untouched",       suppressBookingSentence(RA, 'deadline') === RA);
check("absent/unparseable → prose untouched", suppressBookingSentence(RA, 'absent-generic') === RA);
const shut = suppressBookingSentence(RA, 'window-closed');
check("CLOSED → booking sentence removed",   !/WhatsApp|Book a £10/.test(shut));
check("CLOSED → surrounding prose kept",     /Option B/.test(shut) && /Ask the handler/.test(shut));
check("never blanks the field (only-booking prose kept when closed)",
      suppressBookingSentence('Book a WhatsApp inspection now.', 'window-closed') === 'Book a WhatsApp inspection now.');
check("null text → null (no throw)",         suppressBookingSentence(null, 'window-closed') === null);

console.log('\n── bookingHeaderSuffix ──');
check("shut → 'window closed' wording",  bookingHeaderSuffix('window-closed') === '48-hour booking window closed');
check("open → 'book 48hrs' wording",     bookingHeaderSuffix('deadline') === 'book 48hrs before sale');
check("generic → 'book 48hrs' wording",  bookingHeaderSuffix('absent-generic') === 'book 48hrs before sale');

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
