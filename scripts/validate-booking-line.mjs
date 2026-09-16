// Unit tests for lib/bookingLine.mjs — booking window state machine + code-owned checklist warning.
// Run: node scripts/validate-booking-line.mjs   (expect "N passed, 0 failed")
import { computeBookingLine, bookingHeaderSuffix, isChecklistSuppressed, checklistWarning } from '../lib/bookingLine.mjs';
import * as BOOKING from '../config/booking.mjs';
import { SALE_PASSED_WARNING, WINDOW_CLOSED_WARNING, SALE_PASSED_REJECT_PAID, SALE_PASSED_REJECT_PROMO, SALE_PASSED_REJECT_FREE } from '../config/booking.mjs';

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

// batch 144 U1 + batch 142 R1 (Vincent — INFORM, DO NOT DECIDE): both warnings state the FACT and
// stop. Neither tells the buyer how to weigh the lot or what to bid. Pinned so a wording pass cannot
// put the judgement back.
check("SALE_PASSED ends at 'remain unverified.'", SALE_PASSED_WARNING.endsWith('remain unverified.'));
check("SALE_PASSED drops the 'when judging this purchase' tail", !/judging this purchase|treat all flagged items/i.test(SALE_PASSED_WARNING));
check("WINDOW_CLOSED drops the 'bid accordingly' tail", !/bid accordingly|wait for the lot to relist/i.test(WINDOW_CLOSED_WARNING));
for (const [name, w] of [['SALE_PASSED', SALE_PASSED_WARNING], ['WINDOW_CLOSED', WINDOW_CLOSED_WARNING]]) {
  check(`${name} carries no bid instruction`, !/bid (accordingly|with confidence)|do not bid|walk away/i.test(w));
  check(`${name} still states the fact it exists for`, /inspection/i.test(w) && /unverified|unresolved/i.test(w));
}

console.log('\n── bookingHeaderSuffix (collapsed to open/deadline case) ──');
check("returns the open/deadline suffix",        bookingHeaderSuffix() === 'book 48hrs before sale');
check("no state dependence (ignores any arg)",   bookingHeaderSuffix('past-generic') === 'book 48hrs before sale' && bookingHeaderSuffix('window-closed') === 'book 48hrs before sale');

console.log('\n-- the Bid Directive is GONE (batch 144 U2) --');
// Vincent, 16 Sep: "remove it. The inspection flags already list the unknowns." CAT_NU_DIRECTIVE and
// categoryDirective() are deleted, and with them the Bid Directive block on both surfaces. These
// checks pin the REMOVAL, so neither the constant nor the block can come back unnoticed.
check('CAT_NU_DIRECTIVE is gone from the booking config', !('CAT_NU_DIRECTIVE' in BOOKING));
check('categoryDirective() is gone from the booking config', !('categoryDirective' in BOOKING));
check('no bid directive of any kind survives in the config',
      !Object.values(BOOKING).some((v) => typeof v === 'string' && /Do not bid on this lot|verified before bidding — lower structural risk/i.test(v)));
{
  const { readFileSync } = await import('node:fs');
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf  = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  const cfg  = readFileSync('config/booking.mjs', 'utf8');
  check('screen: no Bid Directive block renders', !page.includes('<div className="field-key">Bid Directive</div>'));
  check('PDF: no Bid Directive block renders', !pdf.includes("fieldBlock('Bid Directive'"));
  check('neither surface still imports categoryDirective',
        !/import \{[^}]*categoryDirective/.test(page) && !/import \{[^}]*categoryDirective/.test(pdf));
  check('the config exports neither symbol',
        !cfg.includes('export const CAT_NU_DIRECTIVE') && !cfg.includes('export function categoryDirective'));
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
