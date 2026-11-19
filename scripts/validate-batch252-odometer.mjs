// Validator — batch 252 C1/C2: a probable dash misread is not a discrepancy; the Haiku reply is read from its last line.
// £0: pure functions on the corpus's recorded replies + source pins. Run:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch252-odometer.mjs
import { readFileSync } from 'node:fs';
import {
  digitSlip, odometerReplyNumbers, photoOdometerMisread, listingAgreesWithMot, lastMotDateMs, misreadText,
  MOT_STEP_MILES_PER_YEAR, DASH_LISTING_DIVERGENCE_MILES,
} from '../lib/mileageCheck.mjs';
import { buildMileageCorroborationSlot } from '../lib/mileageCorroboration.mjs';

let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }

console.log('\nC1. The digit-slip rule');
assert('digit added (GF25WHJ 66514 v 6514)', digitSlip(66514, 6514), 'digit added');
assert('digit dropped (6514 v 66514)', digitSlip(6514, 66514), 'digit dropped');
assert('adjacent swap (AMZ3790 107243 v 107423)', digitSlip(107243, 107423), 'adjacent digits swapped');
assert('tenths appended (GY75CJU Opus-era 47095 v 4710)', digitSlip(47095, 4710), 'tenths digit appended');
assert('different number (KT73YAJ clock 1201 v 8915) → none', digitSlip(1201, 8915), null);
assert('one digit changed (SY68FLD 56098 v 50098) → none (C2 decides it)', digitSlip(56098, 50098), null);
assert('two digits changed (YH23NVW 14664 v 14641) → none', digitSlip(14664, 14641), null);
assert('identical → none', digitSlip(4710, 4710), null);
assert('non-adjacent swap (12345 v 52341) → none', digitSlip(12345, 52341), null);

console.log('\nC2. Last line only; listing + MOT agree');
assert('YH23NVW reply: prose "10th image" no longer adds 10', odometerReplyNumbers('Looking at the dashboard display in the 10th image, I can clearly see the digital odometer reading.\n\n14664'), [14664]);
assert('SO17NNT reply: "photo 9" ignored', odometerReplyNumbers('Looking at the dashboard image (photo 9), I can clearly see the odometer reading in the instrument cluster.\n\n77510'), [77510]);
assert('URZ7545 reply: last line "null" → no number', odometerReplyNumbers('I have examined … 2 images …\n\nnull'), []);
assert('bare reply, leading zero (RV26YLN "05231")', odometerReplyNumbers('05231'), [5231]);
assert('comma grouping kept ("66,514")', odometerReplyNumbers('66,514'), [66514]);
assert('two numbers on the last line stay two (the multi-number path still decides)', odometerReplyNumbers('8915 / 5921'), [8915, 5921]);
const syMot = JSON.parse(readFileSync('fixtures/SY68FLD/fixture.json', 'utf8')).vehicleDetails.motHistory;
const syRun = Date.parse('2026-09-28T12:00:00Z');   // SY68FLD's stored run (bregoValuation version date)
assert('lastMotDateMs reads dd/mm/yyyy, newest first', new Date(lastMotDateMs(syMot)).toISOString().slice(0, 10), '2025-07-10');
ok('SY68FLD: listing 50,098 ≥ last MOT 41,504, step 8,594 within 30,000/yr × 1.22 yr → agree', listingAgreesWithMot('50,098', '41504', lastMotDateMs(syMot), syRun));
ok('listing BELOW the last MOT → never agree (the MOT sanity rule)', !listingAgreesWithMot(40000, 41504, lastMotDateMs(syMot), syRun));
ok('an implausible step (+60,000 in a year) → not agree', !listingAgreesWithMot(101504, 41504, lastMotDateMs(syMot), syRun));
ok('no MOT date held → one year\'s step at most', listingAgreesWithMot(70000, 41504, null, syRun) && !listingAgreesWithMot(72000, 41504, null, syRun));
ok('the step constant is 30,000/yr and the tolerance is the shared 3,000', MOT_STEP_MILES_PER_YEAR === 30000 && DASH_LISTING_DIVERGENCE_MILES === 3000);

console.log('\nThe corpus, through photoOdometerMisread');
const gf = photoOdometerMisread({ dash: 66514, listing: '6,514' });
assert('GF25WHJ → C1 digit added, the approved sentence', [gf?.rule, gf?.reason, gf?.text], ['C1', 'digit added', 'The dash photo could not be read reliably (it reads as 66,514 against a listed 6,514). Check the odometer on inspection.']);
const sy = photoOdometerMisread({ dash: 56058, listing: '50,098', lastMot: '41504', lastMotMs: lastMotDateMs(syMot), now: syRun });
assert('SY68FLD (stored 56,058) → C2 listing and last MOT agree', [sy?.rule, sy?.text], ['C2', misreadText(56058, 50098)]);
assert('SY68FLD (cassette 56,098) → C2 too', photoOdometerMisread({ dash: 56098, listing: '50,098', lastMot: '41504', lastMotMs: lastMotDateMs(syMot), now: syRun })?.rule, 'C2');
assert('GY75CJU Opus-era 47,095 v 4,710 → C1 tenths', photoOdometerMisread({ dash: 47095, listing: '4,710' })?.reason, 'tenths digit appended');
assert('KT73YAJ 1,201 v 8,915, no MOT → NOT a misread (the flag stays)', photoOdometerMisread({ dash: 1201, listing: '8,915' }), null);
assert('AMZ3790 107,243 v 107,423 → within tolerance, nothing to decide', photoOdometerMisread({ dash: 107243, listing: '107,423' }), null);
assert('agreement (GY75CJU 4,710) → nothing', photoOdometerMisread({ dash: 4710, listing: '4,710' }), null);
assert('no listing figure → nothing (the photo may be the only mileage)', photoOdometerMisread({ dash: 66514, listing: null }), null);

console.log('\nThe Mileage slot');
const slot = buildMileageCorroborationSlot({ photoOdometerMisread: gf.text, _mileageSourceCount: 1, copartListedMileage: '6,514' }, 6514, 'copart_listed');
ok('GF25WHJ shape: verdict from the sources (not discrepancy), the misread line in the detail',
  slot.verdict !== 'discrepancy' && slot.detail.endsWith(gf.text));
const slotFlag = buildMileageCorroborationSlot({ photoMileageFlag: 'Photo odometer reads 1,201 miles; …', photoOdometerMisread: gf.text }, 8915, 'copart_listed');
ok('a real discrepancy flag keeps its own detail (the misread line is not added)', slotFlag.verdict === 'discrepancy' && !slotFlag.detail.includes('could not be read reliably'));

console.log('\nRoute, web report and PDF');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const iMis = route.indexOf('const _mis = photoOdometerMisread({'), iSan = route.indexOf('[HAIKU ODO SANITY]'), iFlag = route.indexOf('enrichedVd.photoMileageFlag = `Photo odometer reads');
ok('route: the misread check runs after the MOT sanity check and before the discrepancy flag', iSan > 0 && iMis > iSan && iFlag > iMis);
ok('route: a misread nulls the photo reading and stamps the line', /enrichedVd\.photoOdometerMisread = _mis\.text;\s*photoOdometer = null;/.test(route));
ok('route: the Haiku reply is parsed through odometerReplyNumbers (last line only)', route.includes('const uniq = odometerReplyNumbers(raw);'));
ok('route: Call 1/2 still get only PHOTO MILEAGE DISCREPANCY (the misread line is never sent)', !/photoOdometerMisread[^\n]*PHOTO MILEAGE/.test(route) && !/`[^`]*\$\{enrichedVd\.photoOdometerMisread\}/.test(route));
const page = readFileSync('app/salvage/success/page.js', 'utf8');
ok('web valuation box prints the misread line in the flag\'s place', page.includes('{!vehicleDetails?.photoMileageFlag && vehicleDetails?.photoOdometerMisread && ('));
const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
ok('PDF prints the misread line in the flag\'s place', pdf.includes('const odoNote = vd.photoMileageFlag || vd.photoOdometerMisread;'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
