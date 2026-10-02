// Validator — batch 205: "the sale has passed" means after the END OF THE SALE DAY in the sale's own time
// zone, not after the lane start (Vincent, 2 Oct 2026). £0: no network, no DB, no Stripe, no model.
// Run: node scripts/validate-sale-day-end.mjs   (expect "N passed, 0 failed")
import { readFileSync } from 'node:fs';
import { saleDayEndMs, isSalePassed } from '../lib/saleTiming.mjs';
import { computeBookingLine, checklistWarning } from '../lib/bookingLine.mjs';
import { parseCopartSaleDate, normaliseLot } from '../lib/normaliseLot.js';
import { SALE_PASSED_WARNING, WINDOW_CLOSED_WARNING } from '../config/booking.mjs';

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const MIN = 60000, H = 3600000;
const state = (sd, now) => computeBookingLine({ _saleDateMs: sd ? sd.ms : null, _saleDateOffsetH: sd ? sd.offsetH : null }, now).state;

console.log('── WM75FTK shape: lane start 12:30 BST, now 12:31 the same day ──');
const RAW = 'Fri. Oct 02, 2026 12:30 PM GMT+1';
const sd = parseCopartSaleDate(RAW);
check('parses to the stored row (1790940600000, GMT+1)', sd && sd.ms === 1790940600000 && sd.offsetH === 1);
const n1231 = sd.ms + MIN;
check('12:31 → NOT passed',                       isSalePassed(sd, n1231) === false);
check('12:31 → checkout allowed (the checkout reads normaliseLot(vd).saleDate)',
  isSalePassed(normaliseLot({ saleDateRaw: RAW }).saleDate, n1231) === false);
check('12:31 → state window-closed',              state(sd, n1231) === 'window-closed');
check('12:31 → warning = WINDOW_CLOSED_WARNING',  checklistWarning(state(sd, n1231)) === WINDOW_CLOSED_WARNING);
const n2359 = Date.UTC(2026, 9, 2, 23, 59, 59, 999) - 1 * H;   // 23:59:59.999 BST
check('day end = 23:59:59.999 BST',               saleDayEndMs(sd) === n2359);
check('23:59:59.999 BST → NOT passed',            isSalePassed(sd, n2359) === false && state(sd, n2359) === 'window-closed');

console.log('── 00:00:01 the next day, local ──');
const nNext = Date.UTC(2026, 9, 3, 0, 0, 1) - 1 * H;
check('00:00:01 BST next day → passed',           isSalePassed(sd, nNext) === true);
check('→ checkout refused',                        isSalePassed(normaliseLot({ saleDateRaw: RAW }).saleDate, nNext) === true);
check('→ state past-generic',                      state(sd, nNext) === 'past-generic');
check('→ warning = SALE_PASSED_WARNING',           checklistWarning(state(sd, nNext)) === SALE_PASSED_WARNING);

console.log('── null / unparseable → never passed ──');
check('null → never passed',                       isSalePassed(null, Date.UTC(2099, 0, 1)) === false && saleDayEndMs(null) === null);
check('undefined → never passed',                  isSalePassed(undefined) === false);
check('NaN ms → never passed',                     isSalePassed({ ms: NaN, offsetH: 1 }) === false);
check('unparseable raw → saleDate null → checkout allowed', normaliseLot({ saleDateRaw: 'next Friday' }).saleDate === null);
check('null → state absent-generic (unchanged)',   computeBookingLine({ _saleDateMs: null }).state === 'absent-generic');

console.log('── GMT+0 straddling midnight ──');
const g0 = parseCopartSaleDate('Sat. Nov 07, 2026 11:00 PM GMT+0');
check('GMT+0 parses',                              g0 && g0.offsetH === 0 && g0.ms === Date.UTC(2026, 10, 7, 23, 0));
check('GMT+0 23:59:59 → NOT passed',               isSalePassed(g0, Date.UTC(2026, 10, 7, 23, 59, 59)) === false);
check('GMT+0 00:00:01 next day → passed',          isSalePassed(g0, Date.UTC(2026, 10, 8, 0, 0, 1)) === true);

console.log('── GMT+1 straddling midnight (local date ≠ UTC date) ──');
const g1 = parseCopartSaleDate('Fri. Oct 02, 2026 11:30 PM GMT+1');   // 22:30 UTC
check('GMT+1 parses to 22:30 UTC',                 g1 && g1.ms === Date.UTC(2026, 9, 2, 22, 30));
check('GMT+1 23:59 local (22:59 UTC) → NOT passed', isSalePassed(g1, Date.UTC(2026, 9, 2, 22, 59)) === false);
check('GMT+1 00:00:01 local (23:00:01 UTC, still 2 Oct in UTC) → passed', isSalePassed(g1, Date.UTC(2026, 9, 2, 23, 0, 1)) === true);
const g1am = parseCopartSaleDate('Fri. Oct 02, 2026 12:30 AM GMT+1'); // 23:30 UTC on 1 Oct
check('GMT+1 00:30 local lane (1 Oct in UTC) → its day is 2 Oct local', saleDayEndMs(g1am) === Date.UTC(2026, 9, 2, 22, 59, 59, 999));
check('GMT+1 00:30 lane, now 1 Oct 23:59 UTC → NOT passed', isSalePassed(g1am, Date.UTC(2026, 9, 1, 23, 59)) === false);

console.log('── the 48h booking deadline is untouched ──');
check('sale 100h away → deadline',                 state({ ms: Date.UTC(2026, 9, 6, 11, 30), offsetH: 1 }, Date.UTC(2026, 9, 2, 7, 30)) === 'deadline');
check('sale 10h away → window-closed',             state({ ms: Date.UTC(2026, 9, 2, 17, 30), offsetH: 1 }, Date.UTC(2026, 9, 2, 7, 30)) === 'window-closed');

console.log('── every sale-vs-now site goes through the one owner ──');
const ck = readFileSync(new URL('../app/api/salvage/checkout/route.js', import.meta.url), 'utf8');
const pc = readFileSync(new URL('../app/api/salvage/promo-checkout/route.js', import.meta.url), 'utf8');
const bl = readFileSync(new URL('../lib/bookingLine.mjs', import.meta.url), 'utf8');
check('paid checkout: isSalePassed(_saleDate)',    /if \(isSalePassed\(_saleDate\)\)/.test(ck));
check('promo/free checkout: _salePassed = isSalePassed(_saleDate)', /const _salePassed = isSalePassed\(_saleDate\);/.test(pc));
check('bookingLine: past-generic via isSalePassed', /isSalePassed\(\{ ms, offsetH: offH \}, now\) \? 'past-generic' : 'window-closed'/.test(bl));
check('no bare ".ms < Date.now()" left in either checkout', !/\.ms\s*<\s*Date\.now\(\)/.test(ck + pc));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
