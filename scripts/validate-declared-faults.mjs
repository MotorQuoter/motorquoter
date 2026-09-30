// batch 199 — Copart-declared faults: flag, never cost (lib/declaredFaults.mjs) + multi-value damage fields
// (lib/normaliseLot.js). Deterministic, no network, £0. The pastes below copy the SHAPE of real stored pastes (CX-3
// 592b6f2e, Tucson 08b1a0b0, AMZ3790 e65674f0, CK75ONW f75db268) — the name/email line is a stand-in, not real data.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-declared-faults.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeclaredNotes, applyDeclaredFaults, modelLineIsSameFault, DECLARED_FAULTS, keysDetailText } from '../lib/declaredFaults.mjs';
import { belowVatLine, normaliseLot } from '../lib/normaliseLot.js';
import { isChargedRow } from '../lib/ledgerEdits.mjs';

const ABOVE = 'Primary damage:\nFront End\nSecondary damage:\nMechanical\nAdditional damage:\nSide\nUndercarriage\nEstimated retail value:\n£11,401.00GBP\n\nFuel:\nPetrol\nVAT to be added to final price:\nNo\n';
const CX3 = ABOVE + 'Highlights:\nAdditional Info\n\nEngine Start Program\n\nVehicle Report\n\nAdditional information:\nView Notes\nReports and services\nVehicle reportNUMBER OF KEYS 1\nVIEW FULL VEHICLE MILEAGE HISTORY VIA VEHICLE REPORT\nUNDIAGNOSED NOISE FROM ENGINE BAY\nTRANSMISSION FAULT\nUNDERCARRIAGE DAMAGE\n2ND SET OF KEYS AVAILABLE';
const TUCSON = 'VAT to be added to final price:\nNo\nHighlights:\nAdditional Info\n\nRun and Drive\nVehicle Report\n\nAdditional information:NUMBER OF KEYS 1\nENGINE MANAGEMENT LIGHT ILLUMINATED\nENGINE MANAGEMENT LIGHT IS ON\nView Notes';
const WITH_PII = 'VAT to be added to final price:\nNo\nAdditional information:\nView Notes\nGet alerts on similar vehicles\njane example\njane@example.com\nSTOLEN RECOVERED VEHICLE\nJANE EXAMPLE TRANSMISSION NOTE\nNUMBER OF KEYS 2';
const silent = () => {};
const keysOf = r => r.faults.map(f => f.key);

test('only the text BELOW the VAT line is read; no VAT line → nothing', () => {
  assert.equal(belowVatLine('TRANSMISSION FAULT\nno vat here'), '');
  assert.deepEqual(keysOf(readDeclaredNotes('TRANSMISSION FAULT\nVAT to be added to final price:\nNo\n', silent)), []);
  assert.deepEqual(keysOf(readDeclaredNotes('VAT to be added to final price:\nNo\nTRANSMISSION FAULT', silent)), ['TRANSMISSION_FAULT']);
});

test('CX-3: transmission, engine-bay noise, undercarriage — keys 1 + second set; glued first note still read', () => {
  const r = readDeclaredNotes(CX3, silent);
  assert.deepEqual(keysOf(r), ['TRANSMISSION_FAULT', 'ENGINE_BAY_NOISE', 'UNDERCARRIAGE']);
  assert.deepEqual(r.keys, { count: 1, secondSet: true });
  assert.equal(keysDetailText('Yes', r.keys), 'Yes - 1 key, second set available');
});

test('Tucson: EML twice (two wordings) → ONE flag', () => {
  assert.deepEqual(keysOf(readDeclaredNotes(TUCSON, silent)), ['EML_ON']);
});

test('upper case only: page chrome and lower-case text never match', () => {
  assert.deepEqual(keysOf(readDeclaredNotes('VAT to be added to final price:\nNo\nThe transmission fault light and low battery', silent)), []);
});

test('the paste is read, never passed on: no raw line (or the name/email) reaches any output', () => {
  const logs = [];
  const a = { 'Red Flags': '- model line', 'WhatsApp Inspection Checklist': '1. item', _reconciledParts: [] };
  applyDeclaredFaults(a, WITH_PII, { isChargedRow, log: m => logs.push(m) });
  const out = JSON.stringify(a);
  for (const raw of ['jane example', 'jane@example.com', 'STOLEN RECOVERED VEHICLE', 'JANE EXAMPLE TRANSMISSION NOTE', 'Get alerts', 'View Notes']) {
    assert.ok(!out.includes(raw), `output carries raw line ${raw}`);
  }
  assert.ok(!logs.join('\n').includes('jane@example.com') && !logs.join('\n').includes('jane example'), 'the name/email never reaches the log');
  assert.ok(logs.some(m => m.includes('unmatched') && m.includes('JANE EXAMPLE TRANSMISSION NOTE')), 'an unknown upper-case line is logged, not shown');
  assert.deepEqual(a._declaredFaults.faults.map(f => f.key), ['STOLEN_RECOVERED']);
});

test('flag only: the ledger and parts_sum are never written; Red Flags + checklist + exclusion carry the fixed words', () => {
  const ledger = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'replace', used: 95 }];
  const recon = { parts_sum: 95 };
  const a = { 'Red Flags': '- Front wing crumpled.', 'WhatsApp Inspection Checklist': '1. Show the wing.', _reconciledParts: ledger, _partsReconciliation: recon };
  const before = JSON.stringify({ ledger, recon });
  applyDeclaredFaults(a, CX3, { isChargedRow, log: silent });
  assert.equal(JSON.stringify({ ledger: a._reconciledParts, recon: a._partsReconciliation }), before);
  assert.match(a['Red Flags'], /^- Copart declare a transmission fault\. Not costed — the repair figure excludes it\. Get it diagnosed or price it yourself before bidding\./);
  assert.equal((a['Red Flags'].match(/Copart declare/g) || []).length, 3);
  assert.equal((a['WhatsApp Inspection Checklist'].match(/^\d+\. Copart declare/mg) || []).length, 3);
  assert.match(a['WhatsApp Inspection Checklist'], /^2\. Copart declare a transmission fault/m);
  assert.equal(a._declaredFaults.exclusion, 'Excludes Copart-declared faults: transmission fault, undiagnosed engine-bay noise, undercarriage damage.');
  // run twice → nothing doubles
  applyDeclaredFaults(a, CX3, { isChargedRow, log: silent });
  assert.equal((a['Red Flags'].match(/Copart declare/g) || []).length, 3);
  assert.equal((a['WhatsApp Inspection Checklist'].match(/Copart declare/g) || []).length, 3);
});

test('a declared fault the photos already cost is NOT called "not costed" (HV25ODX windscreen)', () => {
  const paste = 'VAT to be added to final price:\nYes\nView NotesWINDSCREEN DAMAGED\nNUMBER OF KEYS 1';
  const charged = { 'Red Flags': '', _reconciledParts: [{ panelId: 'WINDSCREEN', name: 'Windscreen', action: 'replace', used: 165 }] };
  applyDeclaredFaults(charged, paste, { isChargedRow, log: silent });
  assert.deepEqual(charged._declaredFaults.faults, []);
  assert.deepEqual(charged._declaredFaults.costed.map(f => f.key), ['WINDSCREEN']);
  assert.equal(charged._declaredFaults.exclusion, '');
  assert.equal(charged['Red Flags'], '');
  const uncharged = { 'Red Flags': '', _reconciledParts: [] };
  applyDeclaredFaults(uncharged, paste, { isChargedRow, log: silent });
  assert.deepEqual(uncharged._declaredFaults.faults.map(f => f.key), ['WINDSCREEN']);
});

test('dedupe: a model line whose SUBJECT is the fault is dropped; a mention or a denial stays; transmission anywhere', () => {
  const ws = DECLARED_FAULTS.find(f => f.key === 'WINDSCREEN'), tx = DECLARED_FAULTS.find(f => f.key === 'TRANSMISSION_FAULT');
  assert.equal(modelLineIsSameFault(ws, '- Windscreen is starred/cracked, consistent with the curtain deployment — replacement likely.'), true);
  assert.equal(modelLineIsSameFault(ws, "- Driver's frontal airbag deployed and windscreen fractured — collateral behind the dashboard."), false);
  assert.equal(modelLineIsSameFault(ws, '- Windscreen shows only chalk annotation; no glass fracture attributable to impact is confirmed.'), false);
  assert.equal(modelLineIsSameFault(tx, '- Run condition is engine-start only; drive was not verified. drivetrain engagement is an inspection-class unknown.'), true);
});

test('Cat A/B stop line stays first; declared lines follow it', () => {
  const stop = 'Cat B — break for parts only.';
  const a = { 'Red Flags': `- ${stop}\n- model line`, _reconciledParts: [] };
  applyDeclaredFaults(a, TUCSON, { isChargedRow, catABStopLine: stop, log: silent });
  const l = a['Red Flags'].split('\n');
  assert.equal(l[0], `- ${stop}`);
  assert.match(l[1], /^- Copart declare that the engine management light is on\./);
});

test('damage fields: every value line up to the next Label: line; single values unchanged; boilerplate per value', () => {
  const vd = normaliseLot({ auctionSource: 'copart', rawCopartPaste: CX3 });
  assert.equal(vd.primaryDamage, 'Front End');
  assert.equal(vd.secondaryDamage, 'Mechanical');
  assert.equal(vd.additionalDamage, 'Side; Undercarriage');
  const bp = normaliseLot({ auctionSource: 'copart', rawCopartPaste: 'Additional damage:\nMinor Dents/scratches\nSide\nEstimated retail value:\n£1' });
  assert.equal(bp.additionalDamage, 'Side');
  const only = normaliseLot({ auctionSource: 'copart', rawCopartPaste: 'Secondary damage:\nMinor Dents/scratches\n\nFuel:\nPetrol' });
  assert.equal(only.secondaryDamage, null);
  const notes = normaliseLot({ auctionSource: 'copart', rawCopartPaste: CX3 });
  assert.ok(!/TRANSMISSION FAULT/.test(notes.damageDescription), 'the cleaned blob is still cut at the VAT line');
});
