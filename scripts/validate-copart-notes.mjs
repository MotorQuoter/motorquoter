// batch 202 — the auction's notes shown AS WRITTEN (lib/copartNotes.mjs) + batch 199's multi-value damage fields
// (lib/normaliseLot.js). Deterministic, no network, £0. The pastes copy the SHAPE of real stored pastes (CX-3 592b6f2e,
// AMZ3790 e65674f0 / 2a55407c, BL24FYD 0108ec93, SD75YGC, GY75CJU, CK75ONW f75db268); the name/email line is a
// stand-in, not real data.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-copart-notes.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  copartNotes, copartPasteNoteLines, copartNotesCodeLines, stampCopartNotes, keysFromNotes, keysDetailText,
  carryForwardNotes, CODE_LINE_WORDING, NOTES_HEADING, NOTES_SOURCE_LINE, NOTES_NOT_COSTED,
} from '../lib/copartNotes.mjs';
import { normaliseLot } from '../lib/normaliseLot.js';

const VAT = 'VAT to be added to final price:\nNo\n';
const ABOVE = 'Primary damage:\nFront End\nSecondary damage:\nMechanical\nAdditional damage:\nSide\nUndercarriage\nEstimated retail value:\n£11,401.00GBP\n\nFuel:\nPetrol\n' + VAT;
// After "Reports and services", first note glued onto "Vehicle report" (CX-3).
const CX3 = ABOVE + 'Highlights:\nAdditional Info\n\nEngine Start Program\n\nVehicle Report\n\nAdditional information:\nView Notes\nReports and services\nVehicle reportNUMBER OF KEYS 1\nVIEW FULL VEHICLE MILEAGE HISTORY VIA VEHICLE REPORT\nUNDIAGNOSED NOISE FROM ENGINE BAY\nTRANSMISSION FAULT\nUNDERCARRIAGE DAMAGE\n2ND SET OF KEYS AVAILABLE';
const CX3_LINES = ['NUMBER OF KEYS 1', 'VIEW FULL VEHICLE MILEAGE HISTORY VIA VEHICLE REPORT', 'UNDIAGNOSED NOISE FROM ENGINE BAY', 'TRANSMISSION FAULT', 'UNDERCARRIAGE DAMAGE', '2ND SET OF KEYS AVAILABLE'];
// Notes BEFORE "View Notes", glued onto "Additional information:" (AMZ3790 e65674f0).
const BEFORE = VAT + 'Highlights:\nAdditional Info\n\nAdditional information:WINDSCREEN DAMAGED\nNUMBER OF KEYS 1\nAIRBAGS DEPLOYED\nView Notes';
// Glued onto the "Reports and services" line itself (AMZ3790 2a55407c).
const ONTO_RS = VAT + 'Additional information:\nView Notes\nReports and servicesWINDSCREEN DAMAGED\nNUMBER OF KEYS 1';
// No "View Notes" marker at all (GY75CJU).
const NO_MARKER = VAT + 'Additional information:\nDASHBOARD WARNING LIGHT ILLUMINATED\nVEHICLE DRIVES BUT NEARSIDE FRONT WHEEL AREA DAMAGED RIM';
// The other glue strings, a cut-off line, a lower-case name/email (f75db268 shape), a mixed-case note.
const GLUE = VAT + 'View NotesALPHA ONE\nVirtual vehicle viewingdditional Information\nBETA TWO\nBook viewingEYLESS ENTRY AND START\nGet alerts on similar vehicles\njane example\njane@example.com\nHPI CHECK ON 1/9/20\nHPI CHECK ON 21/7/2026 SHOWS CATEGORY s';
const STOLEN = VAT + 'View Notes\nReports and services\nVehicle reportSTOLEN RECOVERED VEHICLE\nIGNITION DAMAGED\nNUMBER OF KEYS 2';
const PYRO = VAT + 'Additional information:KEYLESS ENTRY AND START\nPYRO FUSES BYPASSED FOR INSPECTION. ENGINE REVS HIGH WHEN S\nView Notes';
const ENGINE_PUSHED = VAT + 'View NotesPLEASE SEE IMAGES FOR TRANSMISSION TYPE\nENGINE PUSHED TO OFFSIDE MAKING BELT RUB\nReports and services';

test('fallback: notes found wherever Copart put them (after Reports and services / before View Notes / glued onto R&S / no marker)', () => {
  assert.deepEqual(copartPasteNoteLines(CX3), CX3_LINES);
  assert.deepEqual(copartPasteNoteLines(BEFORE), ['WINDSCREEN DAMAGED', 'NUMBER OF KEYS 1', 'AIRBAGS DEPLOYED']);
  assert.deepEqual(copartPasteNoteLines(ONTO_RS), ['WINDSCREEN DAMAGED', 'NUMBER OF KEYS 1']);
  assert.deepEqual(copartPasteNoteLines(NO_MARKER), ['DASHBOARD WARNING LIGHT ILLUMINATED', 'VEHICLE DRIVES BUT NEARSIDE FRONT WHEEL AREA DAMAGED RIM']);
});

test('fallback: every glue prefix stripped; cut-off lines kept as written; lower-case lines (page text, name, email) never kept', () => {
  assert.deepEqual(copartPasteNoteLines(GLUE), ['ALPHA ONE', 'BETA TWO', 'EYLESS ENTRY AND START', 'HPI CHECK ON 1/9/20']);
  const out = copartPasteNoteLines(GLUE).join('\n');
  for (const s of ['jane', 'example.com', 'Get alerts', 'CATEGORY s']) assert.ok(!out.includes(s), s);
});

test('fallback reads only BELOW the VAT line; no VAT line → nothing', () => {
  assert.deepEqual(copartPasteNoteLines('TRANSMISSION FAULT\nno vat line here'), []);
  assert.deepEqual(copartPasteNoteLines(ABOVE), []);   // above-VAT upper case ("S REPAIRABLE…", titles) is never read
});

test('the box wins over the paste and is never merged; box lines trimmed, blanks dropped, case kept', () => {
  const r = copartNotes({ auctionSource: 'copart', rawCopartPaste: CX3, copartNotes: '  Seller says gearbox slips  \n\n  lower case kept\r\n' });
  assert.deepEqual(r, { source: 'box', lines: ['Seller says gearbox slips', 'lower case kept'] });
});

test('empty / whitespace-only box → Copart fallback; legacy row with no auctionSource is Copart', () => {
  assert.deepEqual(copartNotes({ auctionSource: 'copart', rawCopartPaste: CX3, copartNotes: '   \n ' }), { source: 'paste', lines: CX3_LINES });
  assert.deepEqual(copartNotes({ rawCopartPaste: CX3 }), { source: 'paste', lines: CX3_LINES });
});

test('non-Copart source: the box works, the paste fallback never runs', () => {
  assert.deepEqual(copartNotes({ auctionSource: 'iaa', rawCopartPaste: CX3 }), { source: 'none', lines: [] });
  assert.deepEqual(copartNotes({ auctionSource: 'bca', copartNotes: 'Cat N, light front damage' }), { source: 'box', lines: ['Cat N, light front damage'] });
});

test('no notes anywhere → none', () => {
  assert.deepEqual(copartNotes({ auctionSource: 'copart', rawCopartPaste: VAT + 'Highlights:\nAdditional Info\nView Notes\nReports and services' }), { source: 'none', lines: [] });
  assert.deepEqual(copartNotes({}), { source: 'none', lines: [] });
});

test('code lines: stolen and pyro fire from the paste AND from the box; pyro first; Copart wording verbatim', () => {
  const fromPaste = copartNotesCodeLines(copartNotes({ rawCopartPaste: STOLEN + '\n' }).lines, 'copart');
  assert.deepEqual(fromPaste, [CODE_LINE_WORDING.STOLEN.copart]);
  assert.deepEqual(copartNotesCodeLines(copartNotes({ rawCopartPaste: PYRO }).lines, 'copart'), [CODE_LINE_WORDING.PYRO.copart]);
  const both = copartNotesCodeLines(copartNotes({ copartNotes: 'stolen recovered vehicle\npyro fuses bypassed' }).lines, 'copart');
  assert.deepEqual(both, [CODE_LINE_WORDING.PYRO.copart, CODE_LINE_WORDING.STOLEN.copart]);
  assert.match(CODE_LINE_WORDING.STOLEN.copart, /^Copart record this vehicle as stolen and recovered\. Before bidding, ask Copart to confirm the registration number \(VRM\) and chassis number \(VIN\)/);
  assert.match(CODE_LINE_WORDING.PYRO.copart, /^Copart declare the high-voltage pyro fuses have been bypassed for inspection\. Safety item — /);
});

test('code lines: non-Copart wording ("The notes record" / "ask the auction house" / "The notes say"), no "Copart"', () => {
  const l = copartNotesCodeLines(['PYRO FUSE BYPASSED', 'STOLEN RECOVERED'], 'iaa');
  assert.deepEqual(l, [CODE_LINE_WORDING.PYRO.other, CODE_LINE_WORDING.STOLEN.other]);
  for (const s of l) assert.ok(!/Copart/.test(s), s);
  assert.match(l[0], /^The notes say the high-voltage pyro fuses/);
  assert.match(l[1], /^The notes record this vehicle as stolen and recovered\. Before bidding, ask the auction house to confirm/);
});

test('engine pushed → box only: no code line, nothing else', () => {
  const n = copartNotes({ rawCopartPaste: ENGINE_PUSHED });
  assert.deepEqual(n.lines, ['PLEASE SEE IMAGES FOR TRANSMISSION TYPE', 'ENGINE PUSHED TO OFFSIDE MAKING BELT RUB']);
  assert.deepEqual(copartNotesCodeLines(n.lines, 'copart'), []);
});

test('stamp: no money moves; code lines top of Red Flags below a Cat A/B stop line; checklist appended; idempotent; model lines never dropped', () => {
  const ledger = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'replace', used: 95 }];
  const recon = { parts_sum: 95 };
  const stop = 'Cat B — break for parts only.';
  const a = { 'Red Flags': `- ${stop}\n- Windscreen is starred/cracked — replacement likely.\n- Run condition is engine-start only; drivetrain unknown.`,
    'WhatsApp Inspection Checklist': '1. Show the wing.', _reconciledParts: ledger, _partsReconciliation: recon };
  const before = JSON.stringify({ ledger, recon });
  stampCopartNotes(a, { rawCopartPaste: STOLEN + '\nPYRO FUSES BYPASSED' }, { catABStopLine: stop });
  assert.equal(JSON.stringify({ ledger: a._reconciledParts, recon: a._partsReconciliation }), before);
  const rf = a['Red Flags'].split('\n');
  assert.equal(rf[0], `- ${stop}`);
  assert.equal(rf[1], `- ${CODE_LINE_WORDING.PYRO.copart}`);
  assert.equal(rf[2], `- ${CODE_LINE_WORDING.STOLEN.copart}`);
  assert.ok(rf.includes('- Windscreen is starred/cracked — replacement likely.') && rf.includes('- Run condition is engine-start only; drivetrain unknown.'), 'no model line dropped');
  assert.match(a['WhatsApp Inspection Checklist'], /^2\. Copart declare the high-voltage pyro fuses/m);
  assert.match(a['WhatsApp Inspection Checklist'], /^3\. Copart record this vehicle as stolen and recovered/m);
  assert.deepEqual(a._copartNotes.source, 'paste');
  const snap = JSON.stringify(a);
  stampCopartNotes(a, { rawCopartPaste: STOLEN + '\nPYRO FUSES BYPASSED' }, { catABStopLine: stop });
  assert.equal(JSON.stringify(a), snap, 'a second pass changes nothing');
});

test('stamp with no notes: _copartNotes { none, [] }; Red Flags and checklist untouched', () => {
  const a = { 'Red Flags': '- x', 'WhatsApp Inspection Checklist': '1. y' };
  stampCopartNotes(a, { auctionSource: 'copart', rawCopartPaste: VAT });
  assert.deepEqual(a, { 'Red Flags': '- x', 'WhatsApp Inspection Checklist': '1. y', _copartNotes: { source: 'none', lines: [] } });
});

test('re-run: an empty / whitespace box keeps the stored notes; new text replaces them', () => {
  assert.equal(carryForwardNotes('OLD', ''), 'OLD');
  assert.equal(carryForwardNotes('OLD', '   \n'), 'OLD');
  assert.equal(carryForwardNotes('OLD', undefined), 'OLD');
  assert.equal(carryForwardNotes('OLD', 'NEW'), 'NEW');
  assert.equal(carryForwardNotes(undefined, ''), null);
});

test('keys row from the notes', () => {
  assert.deepEqual(keysFromNotes(CX3_LINES), { count: 1, secondSet: true });
  assert.equal(keysDetailText('Yes', keysFromNotes(CX3_LINES)), 'Yes - 1 key, second set available');
  assert.equal(keysDetailText('Yes', keysFromNotes([])), 'Yes');
});

test('wording owners', () => {
  assert.equal(NOTES_HEADING.toUpperCase(), 'NOTES — AS WRITTEN');
  assert.deepEqual(NOTES_SOURCE_LINE, { box: 'From the notes you added.', paste: 'From the Copart page you pasted.' });
  assert.equal(NOTES_NOT_COSTED, 'These notes are not costed unless they appear in the repair breakdown.');
});

test('source pins: the route only stamps (no prompt, no ledger); both surfaces read the stamp; a stored row without it shows nothing', () => {
  const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
  const uses = route.split('\n').filter(l => /copartNotes|CopartNotes/.test(l) && !l.trim().startsWith('//'));
  assert.equal(uses.length, 2, uses.join('\n'));
  assert.ok(uses[0].trim().startsWith("import { stampCopartNotes } from '@/lib/copartNotes.mjs';"), uses[0]);
  assert.ok(uses[1].trim().startsWith('const _notes = stampCopartNotes(assessment, enrichedVd, '), uses[1]);
  const ctx = route.slice(route.indexOf('const contextLines = ['), route.indexOf('const contextLines = [') + 6000);
  assert.ok(!/copartNotes|_copartNotes/.test(ctx), 'notes never in the prompt context');
  const pdf = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/salvage/success/page.js', import.meta.url), 'utf8');
  for (const [n, src] of [['pdf', pdf], ['screen', page]]) {
    assert.ok(/assessment\._copartNotes\?\.lines\?\.length > 0/.test(src), `${n} gates on the stamp`);
    assert.ok(!/copartPasteNoteLines|copartNotes\(/.test(src), `${n} never re-derives from the paste`);
  }
});

test('damage fields (batch 199, kept): every value line up to the next Label: line; boilerplate per value', () => {
  const vd = normaliseLot({ auctionSource: 'copart', rawCopartPaste: CX3 });
  assert.equal(vd.primaryDamage, 'Front End');
  assert.equal(vd.secondaryDamage, 'Mechanical');
  assert.equal(vd.additionalDamage, 'Side; Undercarriage');
  assert.equal(normaliseLot({ auctionSource: 'copart', rawCopartPaste: 'Additional damage:\nMinor Dents/scratches\nSide\nEstimated retail value:\n£1' }).additionalDamage, 'Side');
  assert.equal(normaliseLot({ auctionSource: 'copart', rawCopartPaste: 'Secondary damage:\nMinor Dents/scratches\n\nFuel:\nPetrol' }).secondaryDamage, null);
  assert.ok(!/TRANSMISSION FAULT/.test(vd.damageDescription), 'the cleaned blob is still cut at the VAT line');
  assert.equal(normaliseLot({ auctionSource: 'copart', rawCopartPaste: CX3, copartNotes: 'box' }).copartNotes, 'box', 'the box passes through the normaliser');
});
