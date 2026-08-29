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
import { applyEdits, rowKeyFor, figureOf, ledgerHash } from '../lib/ledgerEdits.mjs';

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

// CAT A/B — not editable, edits refused.
{
  const catAB = { ...synth, _catAB: true };
  const r = applyEdits(catAB, { stamp: H, strikes: ['REAR_BUMPER#0'], adds: [{ id: 'a', text: 'x', amount: 500 }] });
  ok('Cat A/B: notEditable, edits refused, parts_sum unchanged', r.notEditable === true && r.partsSum === 1000 && r.delta === 0);
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

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
