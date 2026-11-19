// Validator — batch 254 item 3: a Fable check before any dash-vs-listing discrepancy (Vincent R4, 19 Nov). £0: every model call
// here is a fake fetch. Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch254-odometer.mjs
import { readFileSync } from 'node:fs';
import { askOdometer, buildOdometerConfirmBody, parseOdometerConfirm, needsOdometerConfirm, odometerConfirmOutcome,
  ODO_CONFIRM_QUESTION, ODO_CONFIRM_MAX_TOKENS } from '../lib/odometerConfirm.mjs';
import { buildConfirmBody } from '../lib/notesConfirm.mjs';
import { misreadText } from '../lib/mileageCheck.mjs';
import { MODELS } from '../config/models.js';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const IMG = Array.from({ length: 5 }, (_, i) => `data:image/jpeg;base64,QUJD${i}`);
const quiet = () => {};

console.log('\n1. The question');
const body = buildOdometerConfirmBody(IMG), nc = buildConfirmBody(IMG, 'BONNET');
ok('Fable (assessPrimary), max_tokens bounded', body.model === MODELS.assessPrimary && body.max_tokens === ODO_CONFIRM_MAX_TOKENS && ODO_CONFIRM_MAX_TOKENS === 4000);
ok('the same cached photo prefix as the notes-confirm questions (system + photos + cache mark, byte for byte)',
  body.system === nc.system && JSON.stringify(body.messages[0].content.slice(0, -1)) === JSON.stringify(nc.messages[0].content.slice(0, -1))
  && body.messages[0].content.at(-2).cache_control?.type === 'ephemeral');
ok('asks for the main odometer, NOT trip / clock / range / temperature / speed; digits as shown + photo, or "unreadable"',
  /main odometer/.test(ODO_CONFIRM_QUESTION) && /trip meter, the clock, the range, the temperature or the speed/.test(ODO_CONFIRM_QUESTION)
  && /digits exactly as shown/.test(ODO_CONFIRM_QUESTION) && /"unreadable"/.test(ODO_CONFIRM_QUESTION) && body.messages[0].content.at(-1).text === ODO_CONFIRM_QUESTION);

console.log('\n2. The parse (fail closed)');
ok('"8,915" photo 3 → 8915, photo index 2', JSON.stringify(parseOdometerConfirm('{"odometer":"8,915","photo":3}', 5)) === JSON.stringify({ reading: 8915, photo: 2, verdict: 'read' }));
ok('"107423" / "107 423" / "8915.4" read', parseOdometerConfirm('{"odometer":"107423","photo":1}', 5).reading === 107423
  && parseOdometerConfirm('{"odometer":"107 423","photo":1}', 5).reading === 107423 && parseOdometerConfirm('{"odometer":"8915.4","photo":1}', 5).reading === 8915);
ok('"unreadable" → no reading', parseOdometerConfirm('{"odometer":"unreadable","photo":null}', 5).reading === null);
ok('a reading with no / an out-of-range photo → no reading', parseOdometerConfirm('{"odometer":"8915","photo":null}', 5).reading === null && parseOdometerConfirm('{"odometer":"8915","photo":9}', 5).reading === null);
ok('words, units or junk → no reading', parseOdometerConfirm('{"odometer":"8915 miles","photo":1}', 5).reading === null && parseOdometerConfirm('about 8915', 5).reading === null && parseOdometerConfirm('', 5).reading === null);

console.log('\n3. The call (fake fetch) — any failure is no reading');
const reply = (o) => async () => new Response(JSON.stringify({ model: MODELS.assessPrimary, stop_reason: 'end_turn', usage: {}, content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: JSON.stringify(o) }], ...(o.__over || {}) }), { status: 200 });
ok('a good reply reads (text block after a thinking block)', (await askOdometer(IMG, { fetchImpl: reply({ odometer: '8,915', photo: 4 }), log: quiet })).reading === 8915);
ok('stop max_tokens → no reading', (await askOdometer(IMG, { fetchImpl: reply({ odometer: '8915', photo: 4, __over: { stop_reason: 'max_tokens' } }), log: quiet })).reading === null);
ok('stop refusal → no reading', (await askOdometer(IMG, { fetchImpl: reply({ odometer: '8915', photo: 4, __over: { stop_reason: 'refusal' } }), log: quiet })).reading === null);
ok('HTTP 500 → no reading', (await askOdometer(IMG, { fetchImpl: async () => new Response('{}', { status: 500 }), log: quiet })).reading === null);
ok('a throw → no reading (never throws)', (await askOdometer(IMG, { fetchImpl: async () => { throw new Error('net'); }, log: quiet })).reading === null);
ok('529 exhausted → no reading', (await askOdometer(IMG, { fetchImpl: reply({}), retry: async () => ({ res: null, exhausted: true }), log: quiet })).reading === null);

console.log('\n4. The trigger');
ok('KT73YAJ: Haiku 1,201 v listing 8,915 → ask', needsOdometerConfirm([1201], 8915) === true);
ok('within 3,000 → no ask (AMZ3790 107,243 v 107,423)', needsOdometerConfirm([107243], 107423) === false);
ok('no listing → no ask (the no-listing case is not built)', needsOdometerConfirm([56058], NaN) === false);
ok('no Haiku figure → no ask', needsOdometerConfirm([], 8915) === false);
ok('multi-number divergence (none near the listing) → ask; one near → no ask', needsOdometerConfirm([1201, 30000], 8915) === true && needsOdometerConfirm([1201, 8915], 8915) === false);

console.log('\n5. The outcome (code-owned)');
const o1 = odometerConfirmOutcome({ fable: 8915, haiku: [1201], listing: 8915 });
ok('Fable ≈ listing → the photo read becomes Fable\'s figure, no flag, no misread line', o1.branch === 'listing' && o1.value === 8915 && o1.text === null);
const o2 = odometerConfirmOutcome({ fable: 56058, haiku: [56058], listing: 50098 });
ok('Fable ≈ Haiku (both off the listing) → the discrepancy stands (branch haiku, nothing replaced)', o2.branch === 'haiku' && o2.value === null && o2.text === null);
const o3 = odometerConfirmOutcome({ fable: null, haiku: [1201], listing: 8915 });
ok('unreadable → the 252 misread line with Haiku\'s figure and the listing', o3.branch === 'unreadable' && o3.text === misreadText(1201, 8915)
  && o3.text === 'The dash photo could not be read reliably (it reads as 1,201 against a listed 8,915). Check the odometer on inspection.');
const o4 = odometerConfirmOutcome({ fable: 30000, haiku: [1201], listing: 8915 });
ok('neither → the misread line', o4.branch === 'neither' && o4.text === misreadText(1201, 8915));
ok('near both → listing wins (no discrepancy)', odometerConfirmOutcome({ fable: 107423, haiku: [107243], listing: 107423 }).branch === 'listing');

console.log('\n6. The route');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const at = route.indexOf('needsOdometerConfirm(_haikuNums, _listedN)');
ok('after the misread rule, before the discrepancy flag, the valuation mileage and Call 1\'s PHOTO MILEAGE line',
  at > route.indexOf('[HAIKU ODO MISREAD]') && at < route.indexOf('enrichedVd.photoMileageFlag = `Photo odometer reads')
  && at < route.indexOf('getMileageForValuation({') && at < route.indexOf('`PHOTO MILEAGE DISCREPANCY: ${enrichedVd.photoMileageFlag}`'));
ok('listing branch: photoOdometer = Fable, flag deleted; unreadable/neither: misread line, photoOdometer null, flag deleted',
  /_out\.branch === 'listing'\) \{\s*photoOdometer = _out\.value;\s*delete enrichedVd\.photoMileageFlag;/.test(route)
  && /_out\.branch === 'unreadable' \|\| _out\.branch === 'neither'\) \{\s*enrichedVd\.photoOdometerMisread = _out\.text;\s*photoOdometer = null;\s*delete enrichedVd\.photoMileageFlag;/.test(route));
ok('stored on the assessment', route.includes('confirm: enrichedVd._odometerConfirm ?? null'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
