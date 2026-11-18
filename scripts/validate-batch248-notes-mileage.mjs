// batch 248 B2 (Vincent, 18 Nov) — a mileage figure in the auction notes is compared, never dropped silently.
// Code reads the figure from the note text (lib/mileageCheck.mjs notesMileageFigures / notesMileageCheck); it is never a
// mileage source; a disagreement gets one code-owned Red Flags + checklist line and makes the Mileage slot "unconfirmed".
// £0. Synthetic cases + the LC72NZV stored row (production-row data, gitignored fixtures/b248/ — skips cleanly without it).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch248-notes-mileage.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { notesMileageFigures, notesMileageCheck, DASH_LISTING_DIVERGENCE_MILES } from '@/lib/mileageCheck.mjs';
import { stampCopartNotes } from '@/lib/copartNotes.mjs';
import { buildMileageCorroborationSlot } from '@/lib/mileageCorroboration.mjs';

const LC_LINE = 'The auction notes say: "ODOMETER READING 20735". The listing and the dash photo both read 95,139.';

test('the figure is read by code from the note text, in every format; a line with no figure is nothing', () => {
  const f = (l) => notesMileageFigures([l]).map(x => x.miles);
  assert.deepEqual(f('ODOMETER READING 20735'), [20735]);
  assert.deepEqual(f('MILEAGE 20,735'), [20735]);
  assert.deepEqual(f('ODOMETER 20 735'), [20735]);
  assert.deepEqual(f('ODOMETER READING: 20.735'), [20735]);
  assert.deepEqual(f('20735 MILES'), [20735]);
  assert.deepEqual(f('ODOMETER READING 33,370 KM'), [20735]);   // km → miles via toMiles, the one conversion
  assert.deepEqual(f('VIEW FULL VEHICLE MILEAGE HISTORY VIA VEHICLE REPORT'), []);
  assert.deepEqual(f('NUMBER OF KEYS 1'), []);
  assert.deepEqual(f('UNABLE TO OPEN BONNET'), []);
});

test('the wording: listing + dash agree / listing only / listing and dash differ / dash only; agreement → no line', () => {
  const lines = ['ODOMETER READING 20735'];
  assert.equal(notesMileageCheck(lines, { listing: '95,139', dash: 95139 })[0].text, LC_LINE);
  assert.equal(notesMileageCheck(lines, { listing: '95,139', dash: null })[0].text,
    'The auction notes say: "ODOMETER READING 20735". The listing reads 95,139.');
  assert.equal(notesMileageCheck(lines, { listing: 95139, dash: 60000 })[0].text,
    'The auction notes say: "ODOMETER READING 20735". The listing reads 95,139; the dash photo reads 60,000.');
  assert.equal(notesMileageCheck(lines, { listing: null, dash: 95139 })[0].text,
    'The auction notes say: "ODOMETER READING 20735". The dash photo reads 95,139.');
  // a pasted Copart page names Copart, as every notes line does
  assert.match(notesMileageCheck(lines, { listing: 95139, source: 'paste' })[0].text, /^Copart's notes say: "ODOMETER READING 20735"\./);
  // agreement within the dash-vs-listing tolerance → no line; just outside → a line
  assert.deepEqual(notesMileageCheck(['ODOMETER READING 95139'], { listing: 95139, dash: 95139 }), []);
  assert.deepEqual(notesMileageCheck([`ODOMETER READING ${95139 + DASH_LISTING_DIVERGENCE_MILES}`], { listing: 95139 }), []);
  assert.equal(notesMileageCheck([`ODOMETER READING ${95139 + DASH_LISTING_DIVERGENCE_MILES + 1}`], { listing: 95139 }).length, 1);
  // nothing to compare against → no line; a figure-less mileage line → no line
  assert.deepEqual(notesMileageCheck(lines, { listing: null, dash: null }), []);
  assert.deepEqual(notesMileageCheck(['VIEW FULL VEHICLE MILEAGE HISTORY VIA VEHICLE REPORT'], { listing: 95139, dash: 1 }), []);
});

test('the tolerance is the dash-vs-listing check\'s own constant, used by the route for both', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.ok(/diff > DASH_LISTING_DIVERGENCE_MILES/.test(src), 'photoMileageFlag reads the shared constant');
  assert.ok(!/diff > 3000/.test(src));
});

test('never a mileage source: computed after the source count, never passed to it or to the valuation mileage', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const count = src.indexOf('enrichedVd._mileageSourceCount = countIndependentMileageSources(');
  const check = src.indexOf('enrichedVd._notesMileage = notesMileageCheck(');
  const val = src.indexOf('getMileageForValuation({');
  assert.ok(count > 0 && check > count, 'notes check runs after the source count');
  assert.ok(val > 0 && val < check, 'the valuation mileage is chosen before the notes are read');
  const countCall = src.slice(count, src.indexOf('});', count));
  assert.ok(!/notes/i.test(countCall), 'no notes input to the source count');
  const valCall = src.slice(val, src.indexOf('});', val));
  assert.ok(!/notes/i.test(valCall), 'no notes input to the valuation mileage');
});

test('the Mileage slot: a notes disagreement → unconfirmed with that reason, never "confirmed"; none → as before', () => {
  const vd = { _mileageSourceCount: 2 };
  assert.equal(buildMileageCorroborationSlot(vd, 95139, 'photo_odometer').verdict, 'confirmed');
  const e = notesMileageCheck(['ODOMETER READING 20735'], { listing: '95,139', dash: 95139 });
  const s = buildMileageCorroborationSlot({ ...vd, _notesMileage: e }, 95139, 'photo_odometer');
  assert.equal(s.verdict, 'unconfirmed');
  assert.match(s.detail, /20,735 miles .*listing reads 95,139/);
  // an existing dash/MOT discrepancy still wins (already not confirmed)
  assert.equal(buildMileageCorroborationSlot({ ...vd, _notesMileage: e, motMileageFlag: 'MOT gap' }, 95139, 'photo_odometer').verdict, 'discrepancy');
});

test('stampCopartNotes: the mileage line goes into Red Flags + checklist once; the reader\'s line for that note never prints', () => {
  const vd = { copartNotes: 'UNABLE TO OPEN BONNET\nODOMETER READING 20735' };
  const read = { fallback: false, lines: [
    { line: 'UNABLE TO OPEN BONNET', kind: 'concern', panels: [] },
    { line: 'ODOMETER READING 20735', kind: 'concern', panels: [] },   // even if the reader calls it a concern
  ] };
  const a = { 'Red Flags': '- Model line.', 'WhatsApp Inspection Checklist': '1. Model item.' };
  const nm = notesMileageCheck(['ODOMETER READING 20735'], { listing: '95,139', dash: 95139 });
  stampCopartNotes(a, vd, { notesRead: read, notesMileage: nm });
  stampCopartNotes(a, vd, { notesRead: read, notesMileage: nm });   // idempotent
  const rf = a['Red Flags'].split('\n');
  assert.equal(rf.filter(l => l.includes('ODOMETER READING 20735')).length, 1);
  assert.ok(rf.includes(`- ${LC_LINE}`));
  assert.equal(a['WhatsApp Inspection Checklist'].split('\n').filter(l => l.includes(LC_LINE)).length, 1);
  // agreement → the note line prints nowhere outside "as written", whatever the reader said
  const b = { 'Red Flags': '', 'WhatsApp Inspection Checklist': '' };
  stampCopartNotes(b, { copartNotes: 'ODOMETER READING 95139' }, { notesRead: { fallback: false, lines: [{ line: 'ODOMETER READING 95139', kind: 'concern', panels: [] }] }, notesMileage: [] });
  assert.ok(!b['Red Flags'].includes('ODOMETER'));
});

// ── LC72NZV stored row (production data, gitignored) ──
const FIX_PATH = 'fixtures/b248/lc72nzv-row.json';
const ROW = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = ROW ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture test skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);

test('LC72NZV: the stored notes, listing and dash read give exactly Vincent\'s line, and the slot goes unconfirmed', { skip: SKIP }, () => {
  const vd = ROW.vehicle_details, a = ROW.assessment;
  const nm = notesMileageCheck(a._copartNotes.lines, { listing: vd.copartListedMileage ?? vd.odometer, dash: a._photoOdometer.value, source: a._copartNotes.source });
  assert.equal(nm.length, 1);
  assert.equal(nm[0].text, LC_LINE);
  const slot = buildMileageCorroborationSlot({ ...vd, _notesMileage: nm }, 95139, 'photo_odometer');
  assert.equal(slot.verdict, 'unconfirmed');
  assert.equal(buildMileageCorroborationSlot(vd, 95139, 'photo_odometer').verdict, 'confirmed', 'stored row was "confirmed"');
  const out = { 'Red Flags': a['Red Flags'], 'WhatsApp Inspection Checklist': a['WhatsApp Inspection Checklist'] };
  stampCopartNotes(out, vd, { notesRead: a._notesRead, notesMileage: nm });
  assert.equal(out['Red Flags'].split('\n').filter(l => l.includes(LC_LINE)).length, 1);
  assert.equal(out['WhatsApp Inspection Checklist'].split('\n').filter(l => l.includes(LC_LINE)).length, 1);
});
