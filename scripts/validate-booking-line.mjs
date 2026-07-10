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
check("past-generic line says the sale already happened (not 'must be booked')",
      /already taken place/.test(computeBookingLine({ _saleDateMs: now - 5 * H }).line) &&
      !/must be booked/.test(computeBookingLine({ _saleDateMs: now - 5 * H }).line));

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

// YH23 witnessed (10 Jul): model fused the booking clause into the sentence with an em-dash;
// the sentence-level detector under-stripped it (whole sentence dropped → empty → never-blank
// guard returned the original), recreating the contradiction above a "sale has taken place" checklist.
const emdash = 'Book a £10 Copart WhatsApp video inspection (min 48hrs before sale) — the visible damage is clear, but confirm the underside before bidding.';
check("em-dash-fused OPEN → untouched",             suppressBookingSentence(emdash, 'deadline') === emdash);
check("em-dash-fused CLOSED → booking clause gone", !/WhatsApp|Book a £10|inspection/.test(suppressBookingSentence(emdash, 'past-generic')));
check("em-dash-fused CLOSED → continuation kept",   /visible damage is clear/.test(suppressBookingSentence(emdash, 'past-generic')) && /confirm the underside/.test(suppressBookingSentence(emdash, 'past-generic')));
check("em-dash-fused CLOSED → not blank",           suppressBookingSentence(emdash, 'window-closed').length > 0);

console.log('\n── bookingHeaderSuffix ──');
check("window-closed → 'window closed' wording", bookingHeaderSuffix('window-closed') === '48-hour booking window closed');
check("past-generic → 'sale has taken place' (matches its line)", bookingHeaderSuffix('past-generic') === 'sale has taken place');
check("open → 'book 48hrs' wording",     bookingHeaderSuffix('deadline') === 'book 48hrs before sale');
check("generic → 'book 48hrs' wording",  bookingHeaderSuffix('absent-generic') === 'book 48hrs before sale');
// Header must never contradict the line beneath it: past-generic header + line agree the sale is gone.
check("past-generic header + line agree (no contradiction)",
      /taken place/.test(bookingHeaderSuffix('past-generic')) &&
      /taken place/.test(computeBookingLine({ _saleDateMs: Date.now() - 5 * H }).line));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
