// Validator — buyer ledger edits recompute (batch 82). £0: pure, no network, no DB.
// Run: node scripts/validate-ledger-edits.mjs
//
// The anchor is the NO-EDIT PARITY test: applyEdits(assessment, empty-layer) must reproduce the
// engine's OWN stored figures (parts_sum, every margin, break-even/rebuild ceiling, divergence) exactly.
// That proves the reimplemented maths matches the shipped engine. Edits then shift from that verified
// baseline: strike/add move parts_sum by the delta and every margin by −delta uniformly; the version
// stamp scopes edits to the assessment they were made against; Cat A/B refuses; strike-all is defined.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyEdits, rowKeyFor, figureOf, ledgerHash,
  isLampType, lampRepricedKeys, repriceStoredEntry, withoutAnsweredLampDisclosure,
  amendableRow, isAmendAction,
} from '../lib/ledgerEdits.mjs';
import { partsTableCells, computeLabour } from '../lib/labour.mjs';
import { PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const approx = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) <= eps;

// ── (A) SYNTHETIC — deterministic, portable (no fixtures needed) ───────────────────────────────────
console.log('\n(A) SYNTHETIC — recompute maths');

// A margin ladder that CROSSES zero so break-even is in-range and testable.
const synth = {
  _partsReconciliation: { parts_sum: 1000 },
  _exitValue: 5000,
  _reconciledParts: [
    { panelId: 'REAR_BUMPER', name: 'Rear bumper', used: 400, action: 'replace' },
    { panelId: 'FOG_LAMP', name: 'Rear fog lamp', used: 65, action: 'replace' },
    { panelId: 'FOG_LAMP', name: 'Rear fog lamp', used: 65, action: 'replace' },
    { name: 'Labour & paint', oem: 470, action: '—' },
  ],
  _marginScenarios: [
    { hammer: 500,  margin: 1500, repair: 1000, exit_value: 5000 },
    { hammer: 1500, margin: 500,  repair: 1000, exit_value: 5000 },
    { hammer: 2500, margin: -500, repair: 1000, exit_value: 5000 },
    { hammer: 3500, margin: -1500, repair: 1000, exit_value: 5000 },
  ],
  _investmentBlock: {
    asIsClean: { mid: 4000 }, afterRepairValue: 5000,
    bidCeilings: {
      rebuild: { value: 2000, assumption: 'Break-even hammer …' },
      partsOut: { value: 800, assumption: 'parts recovery …' },
      flip: null,
    },
    asIsSalvage: null,
  },
  _salvageGuide: { bidLow: 1800, bidHigh: 2600, breakEven: 2000, divergence: false },
};
const H = ledgerHash(synth._reconciledParts);   // the stamp a fresh edit layer for `synth` carries

// Row keys: two identical fog rows must get distinct, stable keys; labour keyed by name.
{
  const keys = rowKeyFor(synth._reconciledParts);
  ok('row keys distinct for identical fog rows (FOG_LAMP#0 / FOG_LAMP#1)',
     keys[1] === 'FOG_LAMP#0' && keys[2] === 'FOG_LAMP#1' && keys[1] !== keys[2]);
  ok('panelless labour row gets a stable name-based key', /^name:/.test(keys[3]));
}

// NO-EDIT PARITY — empty layer reproduces the engine's stored figures exactly.
{
  const r = applyEdits(synth, { stamp: H, strikes: [], adds: [] });
  ok('no-edit: parts_sum unchanged', r.partsSum === 1000 && r.delta === 0);
  ok('no-edit: every margin identical to stored',
     r.marginScenarios.every((s, i) => approx(s.margin, synth._marginScenarios[i].margin)));
  ok('no-edit: break-even reproduces engine crossing (1500→2500 at 0) = 2000', r.breakEven === 2000);
  ok('no-edit: rebuild ceiling unchanged (2000)', r.investmentBlock.bidCeilings.rebuild.value === 2000);
  ok('no-edit: divergence unchanged (false)', r.salvageGuide.divergence === false);
  ok('no-edit: applied=false', r.applied === false);
}

// STRIKE one identical fog (£65): parts_sum 1000→935, every margin +65, break-even moves up.
{
  const r = applyEdits(synth, { stamp: H, strikes: ['FOG_LAMP#1'], adds: [] });
  ok('strike one fog: only that row marked struck (not both)',
     r.rows.filter((x) => x._struck).length === 1 && r.rows[2]._struck === true && r.rows[1]._struck === false);
  ok('strike £65: parts_sum 1000→935, delta −65', r.partsSum === 935 && r.delta === -65);
  ok('strike £65: every margin rose by exactly 65',
     r.marginScenarios.every((s, i) => approx(s.margin, synth._marginScenarios[i].margin + 65)));
  ok('strike: margin repair field updated to 935', r.marginScenarios.every((s) => s.repair === 935));
  ok('strike: applied=true', r.applied === true);
}

// ADD a buyer line (£300): parts_sum 1000→1300, every margin −300.
{
  const r = applyEdits(synth, { stamp: H, strikes: [], adds: [{ id: 'a1', text: 'Rear crossmember (my bodyshop)', amount: 300 }] });
  ok('add £300: parts_sum 1000→1300, delta +300', r.partsSum === 1300 && r.delta === 300);
  ok('add £300: every margin fell by exactly 300',
     r.marginScenarios.every((s, i) => approx(s.margin, synth._marginScenarios[i].margin - 300)));
  ok('add: the buyer line is returned', r.addedRows.length === 1 && r.addedRows[0].amount === 300);
}

// STRIKE + ADD together: delta = added − struck.
{
  const r = applyEdits(synth, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [{ id: 'a1', text: 'x', amount: 100 }] });
  ok('strike £400 + add £100: delta −300, parts_sum 700', r.delta === -300 && r.partsSum === 700);
}

// VERSION STAMP — a stamp made against a DIFFERENT ledger applies NONE (the blocker: rerun /
// patch-body-type rewrote _reconciledParts on the same row → the ledgerHash changed).
{
  const r = applyEdits(synth, { stamp: 'L4-deadbeef', strikes: ['REAR_BUMPER#0'], adds: [{ id: 'a1', text: 'x', amount: 999 }] });
  ok('stamp mismatch → applied NONE, parts_sum unchanged', r.stampMismatch === true && r.partsSum === 1000 && r.delta === 0);
  ok('stamp mismatch → no row struck, no added rows', r.rows.every((x) => !x._struck) && r.addedRows.length === 0);
  const r2 = applyEdits(synth, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [] });
  ok('stamp match → applied', r2.stampMismatch === false && r2.partsSum === 600);
  // Simulate patch-body-type: same row, ledger changed (a fog removed) → old stamp no longer matches.
  const changed = { ...synth, _reconciledParts: synth._reconciledParts.slice(0, 3) };
  const r3 = applyEdits(changed, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [] });
  ok('ledger changed under same row (patch-body-type case) → old stamp mismatches → applied none',
     r3.stampMismatch === true && r3.delta === 0);
}

// CAT A/B — not editable, edits refused. The engine stores the hard stop as `_catABHardStop` (a
// letter), NOT `_catAB` — the gate must fire on the REAL field (dead-gate fixed batch 105).
{
  const catAB = { ...synth, _catABHardStop: 'B' };
  const r = applyEdits(catAB, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [{ id: 'a', text: 'x', amount: 500 }] });
  ok('Cat A/B (_catABHardStop): notEditable, edits refused, parts_sum unchanged', r.notEditable === true && r.partsSum === 1000 && r.delta === 0);
  // Guard against a regression to the dead field: an assessment with ONLY the old inert name must
  // still be caught by the defensive alias, but the real field is what the engine actually writes.
  ok('Cat A/B: _catABHardStop alone is enough to refuse (does not depend on the dead _catAB)',
     applyEdits({ ...synth, _catABHardStop: 'A' }, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [] }).notEditable === true);
}

// POSITIONAL-KEY CORRECTNESS (batch 105) — the render drops blank-name rows (the success `_named`
// guard and the PDF `_pdfNamed` guard). Keys MUST come from applyEdits().rows (derived over the FULL
// _reconciledParts) and only THEN be filtered — re-deriving keys over the filtered array shifts the
// ordinal of any paired panel and would silently strike the wrong line. This is the correctness
// condition for wiring the edit layer into the screen and the PDF.
{
  const withBlank = {
    _partsReconciliation: { parts_sum: 100 },
    _reconciledParts: [
      { panelId: 'FOG_LAMP', name: 'Fog lamp L', used: 50, action: 'replace' },
      { panelId: 'FOG_LAMP', name: '',           used: 0,  action: 'replace' }, // blank → render drops it
      { panelId: 'FOG_LAMP', name: 'Fog lamp R', used: 50, action: 'replace' },
    ],
    _marginScenarios: null, _investmentBlock: null, _salvageGuide: null,
  };
  const HB = ledgerHash(withBlank._reconciledParts);
  const r = applyEdits(withBlank, { stamp: HB, strikes: [], adds: [] });
  const visible = r.rows.filter((x) => (x.name ?? '').trim() !== '');   // what the render shows
  ok('surviving 2nd fog keeps its FULL-ledger key (FOG_LAMP#2), not a re-indexed one',
     visible.length === 2 && visible[1]._rowKey === 'FOG_LAMP#2');
  const rederived = rowKeyFor(visible);   // the WRONG way — over the filtered array
  ok('re-deriving keys over the filtered array corrupts it to FOG_LAMP#1 (the trap)',
     rederived[1] === 'FOG_LAMP#1');
  ok('the two differ → render/PDF MUST use edited.rows keys, never rowKeyFor(filtered)',
     visible[1]._rowKey !== rederived[1]);
  // And a strike stored against the full-ledger key removes the RIGHT £50, leaving the other fog.
  const rs = applyEdits(withBlank, { stamp: HB, strikes: ['FOG_LAMP#2'], adds: [] });
  ok('strike FOG_LAMP#2 removes exactly £50 (the visible right fog), parts_sum 100→50', rs.partsSum === 50);
}

// STRIKE ALL — defined behaviour: parts_sum 0, margins assume no repair, flagged allStruck.
{
  const allKeys = rowKeyFor(synth._reconciledParts);
  const r = applyEdits(synth, { stamp: H, strikes: allKeys, adds: [] });
  const totalStruckable = synth._reconciledParts.reduce((a, p) => a + figureOf(p), 0);
  ok('strike-all: parts_sum 0', r.partsSum === 0);
  ok('strike-all: allStruck flagged', r.allStruck === true);
  ok('strike-all: every margin rose by the full repair total (no-repair scenario)',
     r.marginScenarios.every((s, i) => approx(s.margin, synth._marginScenarios[i].margin + totalStruckable)));
}

// SOFT WARNING — an implausible added amount warns but is NOT blocked or clamped.
{
  const r = applyEdits(synth, { stamp: H, strikes: [], adds: [{ id: 'a', text: 'engine swap', amount: 9999 }] });
  ok('implausible add (> exit): warned, still applied, not clamped', r.warnings.length >= 1 && r.partsSum === 10999);
}

// ── (B) FIXTURE PARITY — real engine output (DL72FVX), no-edit must reproduce it exactly ───────────
console.log('\n(B) FIXTURE PARITY — DL72FVX baseline (gitignored; SKIP if absent)');
const FX = join(ROOT, 'fixtures', 'DL72FVX', 'baseline-assessment.json');
if (!existsSync(FX)) {
  console.log('  SKIP — DL72FVX baseline not present; synthetic parity stands.');
} else {
  const a = JSON.parse(readFileSync(FX, 'utf8'));
  const HA = ledgerHash(a._reconciledParts);
  const r = applyEdits(a, { stamp: HA, strikes: [], adds: [] });
  ok('DL72FVX no-edit: parts_sum reproduces engine (650)', r.partsSum === (a._partsReconciliation?.parts_sum ?? -1));
  ok('DL72FVX no-edit: every margin reproduces engine exactly',
     r.marginScenarios.every((s, i) => approx(s.margin, a._marginScenarios[i].margin)));
  ok('DL72FVX no-edit: rebuild ceiling reproduces engine (8842, extrapolated break-even)',
     r.investmentBlock.bidCeilings.rebuild.value === a._investmentBlock.bidCeilings.rebuild.value);
  ok('DL72FVX no-edit: partsOut ceiling untouched (parts_sum-independent)',
     r.investmentBlock.bidCeilings.partsOut.value === a._investmentBlock.bidCeilings.partsOut.value);
  // A real strike: remove one phantom fog (£65). Every margin +65; rebuild ceiling moves.
  const keys = rowKeyFor(a._reconciledParts);
  const fogKey = keys.find((k) => k.startsWith('FOG_LAMP#'));
  if (fogKey) {
    const rs = applyEdits(a, { stamp: HA, strikes: [fogKey], adds: [] });
    ok('DL72FVX strike one fog (£65): parts_sum 650→585',
       rs.partsSum === (a._partsReconciliation.parts_sum - 65));
    ok('DL72FVX strike: every margin rose by exactly 65',
       rs.marginScenarios.every((s, i) => approx(s.margin, a._marginScenarios[i].margin + 65)));
    ok('DL72FVX strike: rebuild ceiling recomputed (moved from engine value)',
       rs.investmentBlock.bidCeilings.rebuild.value !== a._investmentBlock.bidCeilings.rebuild.value);
  }
}

// -- LABOUR FOLLOWS THE LEDGER (Vincent's ruling, 8 Sep) -----------------------------------------
// Striking a panel used to remove its PART cost and leave its LABOUR in the total. A welded quarter is
// £800 all-in per LABOUR_SPEC_v1, so a buyer striking £175 was clearing £175 of a ~£975 phantom.
// applyEdits now re-runs lib/labour.computeLabour over the SURVIVING body panels.
{
  const mk = () => ({
    _reconciledParts: [
      { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 365, used: 200 },
      { panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'replace', oem: 320, used: 175 },
      { panelId: 'GRILLE', name: 'Grille', action: 'replace', oem: 180, used: 90 },
      { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', oem: null, used: 500, _zeroRule: 'A', _structFloor: true },
      { name: 'Labour & paint (new & painted)', action: 'x', oem: 1750, used: null, _codeLabour: true },
    ],
    _partsReconciliation: { parts_sum: 2715 },
    _labourBodyPanels: [
      { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'repair' },
      { panelId: 'REAR_QUARTER', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
    ],
    _labourTellCount: 1,
  });

  const a = mk();
  const H = ledgerHash(a._reconciledParts);
  const k = rowKeyFor(a._reconciledParts);
  const qKey = k[1], grilleKey = k[2];

  const none = applyEdits(a, { stamp: H, strikes: [], adds: [] });
  ok('labour: NO-EDIT PARITY - labour untouched and labourDelta is 0',
     none.labourDelta === 0 && none.partsSum === a._partsReconciliation.parts_sum
     && none.rows.find((r) => r._codeLabour).oem === 1750);

  const sq = applyEdits(a, { stamp: H, strikes: [qKey], adds: [] });
  const lrow = sq.rows.find((r) => r._codeLabour);
  ok('labour: striking a BODY panel recomputes the labour row DOWN',
     lrow._labourRecomputed === true && lrow.oem < 1750);
  ok('labour: the strike removes the part AND its labour from parts_sum',
     sq.partsSum === a._partsReconciliation.parts_sum - 175 + sq.labourDelta && sq.labourDelta < 0);
  ok('labour: _labourWas records the engine figure it replaced', lrow._labourWas === 1750);

  const sg = applyEdits(a, { stamp: H, strikes: [grilleKey], adds: [] });
  ok('labour: striking a NON-body panel (grille) leaves labour alone',
     sg.labourDelta === 0 && sg.rows.find((r) => r._codeLabour).oem === 1750);

  const ad = applyEdits(a, { stamp: H, strikes: [], adds: [{ id: 'x', text: 'my line', amount: 400 }] });
  ok('labour: a buyer-ADDED line earns NO labour (he priced his own line)',
     ad.labourDelta === 0 && ad.partsSum === a._partsReconciliation.parts_sum + 400);

  const stale = applyEdits(a, { stamp: 'L9-stale', strikes: [qKey], adds: [] });
  ok('labour: a suppressed / stampMismatch layer recomputes NOTHING',
     stale.stampMismatch === true && stale.labourDelta === 0
     && stale.rows.find((r) => r._codeLabour).oem === 1750);

  ok('labour: _zeroRule rows earn no panel-work labour (absent from the engine input list)',
     !a._labourBodyPanels.some((bp) => bp.panelId === 'FRONT_STRUCTURE'));

  const noPanels = applyEdits({ ...a, _labourBodyPanels: undefined }, { stamp: H, strikes: [qKey], adds: [] });
  ok('labour: an older assessment with no _labourBodyPanels degrades safely (no recompute, no crash)',
     noPanels.labourDelta === 0 && noPanels.partsSum === a._partsReconciliation.parts_sum - 175);
}


// ── (L) LAMP-TYPE CORRECTION — batch 114 (Vincent, 11 Sep: "Let the photo set the band with the user having
// the option to correct it"). A lot-level edit_layer.lampType re-prices every in-money code-owned lamp row.
console.log('\n(L) LAMP-TYPE CORRECTION — batch 114');
{
  const lampAsmt = {
    _partsReconciliation: { parts_sum: 1700 },
    _exitValue: 5000,
    _reconciledParts: [
      { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', oem: null, used: 350, _lampMandated: true, _band: 350, _lampPair: true },
      { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', oem: null, used: 350, _lampMandated: true, _band: 350, _lampPair: true },
      { panelId: 'BONNET', name: 'Bonnet', action: 'replace', used: 400 },
      { name: 'Labour & paint', oem: 600, action: '—' },
    ],
    _marginScenarios: [
      { hammer: 500,  margin: 1500, repair: 1700, exit_value: 5000 },
      { hammer: 1500, margin: 500,  repair: 1700, exit_value: 5000 },
      { hammer: 2500, margin: -500, repair: 1700, exit_value: 5000 },
    ],
  };
  const snapshot = JSON.stringify(lampAsmt);
  const LH = ledgerHash(lampAsmt._reconciledParts);
  const L = (extra) => ({ stamp: LH, strikes: [], adds: [], ...extra });

  const none = applyEdits(lampAsmt, null);
  ok('no-edit parity: no layer → the engine figure, no correction', none.partsSum === 1700 && none.lampTypeCorrection === null);

  const hal = applyEdits(lampAsmt, L({ lampType: 'halogen' }));
  ok('re-price: halogen moves the total by exactly 2 × (150 − 350) = −£400', hal.partsSum === 1300 && hal.delta === -400);
  ok('re-price: both in-money lamp rows now £150, each marked {from:350,to:150}',
     hal.rows.filter((r) => r._lampMandated).every((r) => r.used === 150 && r._lampTypeCorrected?.from === 350 && r._lampTypeCorrected?.to === 150));
  ok('re-price: non-lamp rows untouched', hal.rows.find((r) => r.panelId === 'BONNET').used === 400);
  ok('re-price: every margin shifts by +400 (total fell by 400)', hal.marginScenarios.every((s, i) => s.margin === lampAsmt._marginScenarios[i].margin + 400));
  ok('re-price: lampTypeCorrection reports type, band, rows and delta',
     hal.lampTypeCorrection?.type === 'halogen' && hal.lampTypeCorrection.band === 150
     && hal.lampTypeCorrection.rowsRepriced === 2 && hal.lampTypeCorrection.delta === -400);
  ok('re-price: the rendered line is the ruled sentence',
     hal.lampTypeCorrection.line === 'Headlamp type corrected by the buyer to halogen (£150 per unit).');
  ok('hid is rendered upper-case in the line', applyEdits(lampAsmt, L({ lampType: 'hid' })).lampTypeCorrection.line === 'Headlamp type corrected by the buyer to HID (£250 per unit).');

  ok('STAMP UNCHANGED: the correction never touches _reconciledParts — its ledgerHash is still the stamp',
     hal.stamp === LH && ledgerHash(lampAsmt._reconciledParts) === LH);
  ok('IMMUTABLE: the stored engine assessment is byte-identical after applyEdits', JSON.stringify(lampAsmt) === snapshot);

  const same = applyEdits(lampAsmt, L({ lampType: 'led' }));
  ok('SAME TYPE is a no-op on the money (LED → LED): £1,700, delta 0, 0 rows re-priced',
     same.partsSum === 1700 && same.delta === 0 && same.lampTypeCorrection.rowsRepriced === 0);
  ok('…but it is still recorded as the buyer\'s confirmed type (drives the flag removal)', same.lampTypeCorrection?.type === 'led');

  const strike = applyEdits(lampAsmt, L({ strikes: ['HEADLAMP#0'], lampType: 'halogen' }));
  ok('STRIKE WINS: a struck lamp stays struck and is not re-priced; the other goes to £150 (1700 − 350 − 200 = £1,150)',
     strike.partsSum === 1150 && strike.rows[0]._struck === true && strike.rows[0].used === 350 && strike.rows[1].used === 150);

  const mixed = applyEdits(lampAsmt, L({ strikes: ['BONNET#0'], adds: [{ id: 'a1', text: 'Headlamp bracket', amount: 40 }], lampType: 'hid' }));
  ok('existing strikes and adds keep applying alongside a correction (1700 − 400 + 40 − 200 = £1,140)', mixed.partsSum === 1140);

  const shelved = {
    _partsReconciliation: { parts_sum: 1000 },
    _reconciledParts: [{ panelId: 'BONNET', name: 'Bonnet', action: 'replace', used: 1000 }],
    _allowanceParts: [{ name: 'Headlamp', action: 'replace', used: 350, _allowance: true }],
  };
  const sh = applyEdits(shelved, { stamp: ledgerHash(shelved._reconciledParts), strikes: [], adds: [], lampType: 'halogen' });
  ok('A1-SHELVED lamps stay out: an allowance-only lamp is never re-priced into the total', sh.partsSum === 1000 && sh.delta === 0);

  ok('closed enum: an off-enum type is ignored entirely', applyEdits(lampAsmt, L({ lampType: 'xenon' })).lampTypeCorrection === null
     && applyEdits(lampAsmt, L({ lampType: 'xenon' })).partsSum === 1700);
  ok('isLampType is exactly halogen / hid / led', ['halogen', 'hid', 'led'].every(isLampType) && !isLampType('LED') && !isLampType(null));

  const stale = applyEdits(lampAsmt, { stamp: 'L4-stale', strikes: [], adds: [], lampType: 'halogen' });
  ok('RE-RUN: a stale stamp suppresses the correction with the rest of the layer (nothing applied, flagged as a mismatch)',
     stale.stampMismatch === true && stale.applied === false && stale.partsSum === 1700 && stale.lampTypeCorrection === null);

  ok('a layer carrying ONLY lampType (no strikes/adds arrays) still applies — and a stale one still reports the mismatch',
     applyEdits(lampAsmt, { stamp: LH, lampType: 'halogen' }).partsSum === 1300
     && applyEdits(lampAsmt, { stamp: 'L4-stale', lampType: 'halogen' }).stampMismatch === true);

  ok('Cat A/B: a hard-stopped report is never re-priced',
     applyEdits({ ...lampAsmt, _catABHardStop: 'A' }, L({ lampType: 'halogen' })).partsSum === 1700);

  // Stored code-assembled surfaces — re-priced at render from the rows the correction moved.
  const rp = lampRepricedKeys(hal);
  ok('lampRepricedKeys maps each re-priced row key to {from,to}', rp.get('HEADLAMP#0')?.to === 150 && rp.get('HEADLAMP#1')?.to === 150 && !rp.has('BONNET#0'));
  const kcd = repriceStoredEntry({ partName: 'Headlamp', figure: 350, prose: 'Headlamp — replace: £350', _rowKey: 'HEADLAMP#0' }, rp.get('HEADLAMP#0'));
  ok('KCD driver re-priced: figure and prose', kcd.figure === 150 && kcd.prose === 'Headlamp — replace: £150');
  const card = repriceStoredEntry({ part: 'Headlamp', cost: 350, note: 'Full-width frontal impact — both headlamps are costed at £350 each and included in the repair total; confirm serviceability on inspection.' }, rp.get('HEADLAMP#0'));
  ok('Damage card re-priced: cost and the code-owned "£350 each" note', card.cost === 150 && /costed at £150 each/.test(card.note) && !/£350/.test(card.note));
  ok('an entry with no re-priced row is returned untouched', repriceStoredEntry(kcd, undefined) === kcd);

  const flags = [
    { partName: 'Headlamp', reason: 'Lamp type could not be confirmed …', _tier2LampDisclosure: true },
    { partName: 'Headlamp', reason: 'orphan', _orphanLampDisclosure: true },
    { partName: 'Bonnet', reason: 'keep me' },
  ];
  ok('FLAG: the "type assumed" disclosure goes once the buyer has corrected / confirmed the type',
     withoutAnsweredLampDisclosure(flags, hal).map((f) => f.partName).join() === 'Bonnet'
     && withoutAnsweredLampDisclosure(flags, same).length === 1);
  ok('FLAG: with no correction every flag stays', withoutAnsweredLampDisclosure(flags, none).length === 3);
}

// (L2) REAL stored lot — SA26KVT's stored ledger (one mandated LED lamp in its money)
{
  const p = join(ROOT, 'fixtures/SA26KVT/baseline-assessment.json');
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const a = raw.assessment || raw;
    const S = ledgerHash(a._reconciledParts);
    const base = applyEdits(a, null);
    const hal = applyEdits(a, { stamp: S, strikes: [], adds: [], lampType: 'halogen' });
    const lamps = a._reconciledParts.filter((r) => r._lampMandated).length;
    ok(`SA26KVT: no-edit parity holds (£${a._partsReconciliation.parts_sum})`, base.partsSum === a._partsReconciliation.parts_sum);
    ok(`SA26KVT: halogen moves the edited view by ${lamps} × (150 − 350); the engine parts_sum is untouched`,
       hal.partsSum === a._partsReconciliation.parts_sum + lamps * (150 - 350) && a._partsReconciliation.parts_sum === base.partsSum);
  }
}


// ── batch 149 Y3 — A BUYER STRIKE RE-CHECKS THE STRUCTURE FLOOR ───────────────────────────────────
// Batch 147 X2: no structure charge when the only damage at an end is the bumper. The ENGINE applied
// that when it built the ledger, but a strike can make a zone bumper-only AFTER the fact and the £500
// floor stayed. The edit layer now re-runs the engine's OWN rule (lib/structureFloor.mjs — one owner,
// imported by both) over the surviving costed rows.
console.log('\n(Y3) STRUCTURE FLOOR FOLLOWS A STRIKE');
{
  // SF69YBB's ledger exactly as the £0 replay produces it at HEAD (parts_sum £5,525).
  const SF_ROWS = [
    { panelId: 'FRONT_BUMPER',   name: 'Front bumper',       used: 200, oem: 365 },
    { panelId: 'GRILLE',         name: 'Grille',             used: 70,  oem: 160 },
    { panelId: 'SLAM_PANEL',     name: 'Slam panel',         used: 50,  oem: 95 },
    { panelId: 'RADIATOR_PACK',  name: 'Radiator pack',      used: 300, oem: 545 },
    { panelId: 'HEADLAMP',       name: 'Headlamp',           used: 350, oem: null },
    { panelId: 'HEADLAMP',       name: 'Headlamp',           used: 350, oem: null },
    { panelId: 'REAR_BUMPER',    name: 'Rear bumper',        used: 185, oem: 335 },
    { panelId: 'REAR_QUARTER',   name: 'Rear quarter panel', used: null, oem: 320 },
    { panelId: 'FRONT_STRUCTURE', name: 'Front structure',   used: 500, oem: null, _structFloor: true, _zeroRule: 'A' },
    { panelId: 'WHEEL',          name: 'Wheel',              used: 200, oem: null },
    { panelId: 'REAR_STRUCTURE', name: 'Rear structure',     used: 500, oem: null, _structFloor: true, _zeroRule: 'A' },
    { name: 'Labour & paint (new & painted)', used: null, oem: 2500, _codeLabour: true },
  ];
  const SF_BODY = [
    { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'replace' },
    { panelId: 'REAR_BUMPER',  zone: 'rear',  severity: 'SEVERE', action: 'replace' },
    { panelId: 'REAR_QUARTER', zone: 'rear',  severity: 'SEVERE', action: 'replace' },
  ];
  const sf = {
    _reconciledParts: SF_ROWS,
    _partsReconciliation: { parts_sum: 5525 },
    _labourBodyPanels: SF_BODY,
    _labourTellCount: 0,
    _marginScenarios: null, _investmentBlock: null, _salvageGuide: null,
  };
  const sfKeys = rowKeyFor(SF_ROWS);
  const sfStamp = ledgerHash(SF_ROWS);
  const qKey = sfKeys[SF_ROWS.findIndex((r) => r.panelId === 'REAR_QUARTER')];
  const rearFloorKey = sfKeys[SF_ROWS.findIndex((r) => r.panelId === 'REAR_STRUCTURE')];

  // NO-EDIT PARITY first — nothing runs when there is no layer.
  const sfNone = applyEdits(sf, null);
  ok('Y3: SF69YBB no-edit parity — £5,525, delta 0, no floor dropped',
     sfNone.partsSum === 5525 && sfNone.delta === 0 && sfNone.structFloorsDropped.length === 0);

  // THE CASE: strike the rear quarter → rear zone is bumper-only → the rear floor drops too.
  const sfStruck = applyEdits(sf, { stamp: sfStamp, strikes: [qKey], adds: [] });
  ok('Y3: SF69YBB strike the quarter → £3,705', sfStruck.partsSum === 3705);
  ok('Y3: and that is £320 part + £1,000 labour + £500 floor',
     sfStruck.delta === -1820 && sfStruck.labourDelta === -1000 && sfStruck.structFloorDelta === -500);
  ok('Y3: exactly one floor dropped, and it is the REAR one',
     sfStruck.structFloorsDropped.length === 1 && sfStruck.structFloorsDropped[0].panelId === 'REAR_STRUCTURE');
  ok('Y3: the FRONT floor survives — the front zone still has grille, slam panel, rad pack, lamps',
     sfStruck.rows.some((r) => r.panelId === 'FRONT_STRUCTURE' && !r._struck));
  const dropped = sfStruck.rows.find((r) => r.panelId === 'REAR_STRUCTURE');
  ok('Y3: the dropped floor row is shown STRUCK, marked, with a plain reason',
     dropped._struck === true && dropped._structFloorDropped === true
     && /no longer charged/.test(dropped._structFloorReason) && /bumper/.test(dropped._structFloorReason));
  ok('Y3: the reason does not claim the structure is sound',
     /inspection flags/i.test(dropped._structFloorReason) && !/undamaged|sound|no damage/i.test(dropped._structFloorReason));

  // UN-STRIKE — the floor comes back. Nothing is persisted; it is recomputed from the layer every read.
  const sfBack = applyEdits(sf, { stamp: sfStamp, strikes: [], adds: [] });
  ok('Y3: un-strike → £5,525 and the floor returns',
     sfBack.partsSum === 5525 && sfBack.structFloorsDropped.length === 0
     && sfBack.rows.every((r) => !r._structFloorDropped));

  // A buyer can still strike a structure floor DIRECTLY, and it is not double-counted.
  const sfDirect = applyEdits(sf, { stamp: sfStamp, strikes: [rearFloorKey], adds: [] });
  ok('Y3: striking the floor row directly still works — £5,025, counted once',
     sfDirect.partsSum === 5025 && sfDirect.structFloorDelta === 0);

  // A buyer-ADDED line is not a detection of damage and cannot hold a floor up.
  const sfAdd = applyEdits(sf, { stamp: sfStamp, strikes: [qKey], adds: [{ id: 'a', text: 'rear repair', amount: 400 }] });
  ok('Y3: a buyer-added line does not keep the floor alive',
     sfAdd.structFloorDelta === -500 && sfAdd.partsSum === 4105);

  // FRONT-ZONE CASE: strike every front member except the bumper → the front floor drops.
  const frontMembers = ['GRILLE', 'SLAM_PANEL', 'RADIATOR_PACK', 'HEADLAMP'];
  const frontKeys = SF_ROWS.map((r, i) => (frontMembers.includes(r.panelId) ? sfKeys[i] : null)).filter(Boolean);
  const sfFront = applyEdits(sf, { stamp: sfStamp, strikes: frontKeys, adds: [] });
  ok('Y3: strike every front member but the bumper → the FRONT floor drops',
     sfFront.structFloorsDropped.some((d) => d.panelId === 'FRONT_STRUCTURE'));
  ok('Y3: and the REAR floor still stands (the quarter is untouched)',
     sfFront.rows.some((r) => r.panelId === 'REAR_STRUCTURE' && !r._struck));

  // Cat A/B still refuses every edit, floors included.
  const sfCatAB = applyEdits({ ...sf, _catABHardStop: 'B' }, { stamp: sfStamp, strikes: [qKey], adds: [] });
  ok('Y3: Cat A/B still refuses — nothing struck, no floor dropped, total unmoved',
     sfCatAB.notEditable === true && sfCatAB.partsSum === 5525
     && sfCatAB.delta === 0 && sfCatAB.structFloorDelta === 0 && sfCatAB.structFloorsDropped.length === 0);

  // A stale layer applies nothing either.
  const sfStale = applyEdits(sf, { stamp: 'not-the-stamp', strikes: [qKey], adds: [] });
  ok('Y3: a stale edit layer drops no floor and moves nothing',
     sfStale.stampMismatch === true && sfStale.partsSum === 5525 && sfStale.structFloorDelta === 0);

  // ONE OWNER — the edit layer must not carry its own copy of the rule.
  const editSrc = readFileSync(join(ROOT, 'lib/ledgerEdits.mjs'), 'utf8');
  const routeSrc = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');
  ok('Y3: the edit layer IMPORTS the rule, it does not re-implement it',
     editSrc.includes("from './structureFloor.mjs'") && !editSrc.includes('STRUCT_FLOOR_ZONE = '));
  ok('Y3: the engine imports the same owner',
     routeSrc.includes("from '@/lib/structureFloor.mjs'") && !routeSrc.includes('export const STRUCT_FLOOR_ZONE = Object.freeze'));
}

// ── batch 158 A2 — THE BUYER EDITS A LINE, NOT ONLY STRIKES OR ADDS IT ───────────────────────────
console.log('\n(E) batch 158 A2 — per-row amends');
{
  const band = 'Luxury';
  const q = PANEL_PRICE_TABLE.REAR_QUARTER[band];
  const amendable = {
    _partsReconciliation: { parts_sum: 1000 },
    _priceBandKey: band,
    _exitValue: 9000,
    _labourBodyPanels: [{ panelId: 'REAR_QUARTER', zone: 'rear', severity: 'SEVERE', action: 'replace' }],
    _labourTellCount: 0,
    _reconciledParts: [
      { panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'replace', oem: q.oem, used: q.used },
      { panelId: 'WINDSCREEN', name: 'Windscreen', action: 'replace', oem: 480, used: 265 },
    ],
  };
  const keys = rowKeyFor(amendable._reconciledParts);
  const stamp = ledgerHash(amendable._reconciledParts);
  const layer = (amends) => ({ stamp, strikes: [], adds: [], amends });
  const base = applyEdits(amendable, null);

  ok('A2: no amends = no-edit parity', base.partsSum === 1000 && applyEdits(amendable, layer([])).partsSum === 1000);

  // (1) repair ↔ replace, re-priced from the code-owned grid.
  const cap = amendableRow(amendable._reconciledParts[0], band);
  ok('A2: a priced BODY panel may switch repair/replace', cap.action.join() === 'repair,replace' && cap.replaceFigure === q.used);
  ok('A2: glass is priced but has no repair path, so only the amount override is offered',
     amendableRow(amendable._reconciledParts[1], band).action.length === 0);
  ok('A2: with no stored band the grid cannot be consulted — amount only',
     amendableRow(amendable._reconciledParts[0], null).action.length === 0);
  const toRepair = applyEdits(amendable, layer([{ rowKey: keys[0], action: 'repair' }]));
  ok('A2: replace → repair removes the part from the total', toRepair.partsSum === 1000 - q.used);
  ok('A2: and leaves the engine own repair shape (£0 part, panel work carries it)',
     toRepair.rows[0]._repairNoPart === true && toRepair.rows[0].used === null && toRepair.rows[0].action === 'repair');
  ok('A2: the row records what it was, so the revert can restore it',
     toRepair.rows[0]._amended.kind === 'action' && toRepair.rows[0]._amended.from === q.used);
  ok('A2: both surfaces render it exactly as an engine-native repair row does',
     JSON.stringify(partsTableCells(toRepair.rows[0])) === JSON.stringify(partsTableCells({ action: 'repair', oem: null, used: null, _repairNoPart: true })));
  ok('A2: a no-op flip is not an edit', applyEdits(amendable, layer([{ rowKey: keys[0], action: 'replace' }])).partsSum === 1000);

  // (2) the buyer's own figure.
  const toAmount = applyEdits(amendable, layer([{ rowKey: keys[0], amount: 250 }]));
  ok('A2: an amount override moves the total by the difference', toAmount.partsSum === 1000 - q.used + 250);
  ok('A2: the engine figure is kept beside it, never overwritten',
     toAmount.rows[0]._amended.kind === 'amount' && toAmount.rows[0]._amended.from === q.used && amendable._reconciledParts[0].used === q.used);
  ok('A2: zero is a legitimate figure', applyEdits(amendable, layer([{ rowKey: keys[0], amount: 0 }])).partsSum === 1000 - q.used);
  ok('A2: a negative figure cannot pull a line below zero',
     applyEdits(amendable, layer([{ rowKey: keys[0], amount: -500 }])).partsSum === 1000 - q.used);

  // (3) everything downstream follows, exactly as it does for a strike.
  ok('A2: margins, break-even and ceilings all move with an amend',
     toAmount.delta === 250 - q.used && (toAmount.marginScenarios || []).every(m => m.repair === toAmount.partsSum));

  // (4) labour re-derives through the ONE owner. Batch 81 locked labour to SEVERITY, not action, so an
  //     action flip correctly leaves it UNCHANGED — the recompute runs, the answer is the same.
  const asReplace = computeLabour({ bodyPanels: [{ panelId: 'REAR_QUARTER', zone: 'rear', severity: 'SEVERE', action: 'replace' }] });
  const asRepair = computeLabour({ bodyPanels: [{ panelId: 'REAR_QUARTER', zone: 'rear', severity: 'SEVERE', action: 'repair' }] });
  ok('A2: labour is severity-driven, so an action flip must not move it', asReplace.panelWorkMoney === asRepair.panelWorkMoney);
  const editSrcA2 = readFileSync(join(ROOT, 'lib/ledgerEdits.mjs'), 'utf8');
  ok('A2: the amend feeds the SAME labour owner a strike does (no second implementation)',
     editSrcA2.includes('amendedActions.has(bp?.panelId)') && (editSrcA2.match(/computeLabour\(\{/g) || []).length === 1);

  // (5) the stamp and the Cat A/B stop apply to an amend exactly as to a strike.
  ok('A2: a stale stamp applies NO amend', applyEdits(amendable, { ...layer([{ rowKey: keys[0], amount: 250 }]), stamp: 'nope' }).partsSum === 1000);
  ok('A2: a Cat A/B report refuses an amend',
     applyEdits({ ...amendable, _catABHardStop: 'A' }, layer([{ rowKey: keys[0], amount: 250 }])).partsSum === 1000);
  ok('A2: a struck row ignores an amend (strike wins, as it does for the lamp correction)',
     applyEdits(amendable, { stamp, strikes: [keys[0]], adds: [], amends: [{ rowKey: keys[0], amount: 5000 }] }).partsSum === 1000 - q.used);
  ok('A2: an unknown rowKey is ignored', applyEdits(amendable, layer([{ rowKey: 'NOPE#9', amount: 999 }])).partsSum === 1000);
  ok('A2: the action enum is closed', isAmendAction('repair') && isAmendAction('replace') && !isAmendAction('scrap') && !isAmendAction(null));

  // (6) a welded panel the engine priced at NEW keeps that treatment when flipped back.
  const weldedAsm = { ...amendable, _reconciledParts: [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', oem: null, used: null, _repairNoPart: true, _weldedAtNew: { used: q.used } }] };
  const wk = rowKeyFor(weldedAsm._reconciledParts);
  const backToReplace = applyEdits(weldedAsm, { stamp: ledgerHash(weldedAsm._reconciledParts), strikes: [], adds: [], amends: [{ rowKey: wk[0], action: 'replace' }] });
  ok('A2: a welded panel returns to the engine NEW price, not the grid second-hand figure',
     backToReplace.rows[0].oem === q.oem && backToReplace.rows[0].used === null && backToReplace.rows[0]._amended.welded === true);

  // (7) the API stores it, and the PDF counts it as an edit.
  const apiSrc = readFileSync(join(ROOT, 'app/api/salvage/edits/route.js'), 'utf8');
  ok('A2: the API sanitises and persists amends', apiSrc.includes('function sanitizeAmends') && apiSrc.includes('amends: cleanAmends'));
  ok('A2: the API never accepts a price for a panel, only the buyer own amount',
     !/sanitizeAmends[\s\S]*?PANEL_PRICE_TABLE/.test(apiSrc));
  const pdfSrc = readFileSync(join(ROOT, 'app/api/salvage/pdf/route.js'), 'utf8');
  ok('A2: the PDF renders edited.rows, so an amend prints with the same parity as a strike',
     pdfSrc.includes('hasStructured ? edited.rows') && pdfSrc.includes('editLayer?.amends?.length'));
  const pageSrc = readFileSync(join(ROOT, 'app/salvage/success/page.js'), 'utf8');
  ok('A2: the screen sends amends and counts them as unsaved work',
     pageSrc.includes('amends: editAmends') && pageSrc.includes('editsKeyOf(editStrikes, editAdds, editLampType, editAmends)'));
  ok('A2: the amount input is at least 16px so mobile does not zoom the 480px layout',
     /placeholder="your figure £"[\s\S]{0,240}fontSize: 16/.test(pageSrc));
  ok('A2: the revert control is offered on every amended row', pageSrc.includes('clearAmend(p._rowKey)'));
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
