// validate-batch161.mjs — batch 161, ruling E: the Labour & paint row's controls. £0, pure, no model calls.
//
//   E1  the row gets BOTH controls back — ✕ Remove and Change (own figure only; no repair/replace).
//   E2  the buyer's own labour figure STANDS: striking or restoring a body panel must not re-derive or
//       overwrite it. Undo restores our figure and labour follows the ledger again.
//   E3  with an own figure set, OUR range / second-hand / addendum are not shown as if they applied.
//   E4  the addendum names the control that exists.
//   E5  the PDF prints the buyer's figure.
//
// The ledger below is CK75ONW's real shape, taken from a £0 cassette replay on 19 Sep: five body panels,
// two £500 structure floors, a paired fog lamp, and the code labour row at £3,063 in the OEM column with
// `used: null` — the exact shape that made the double-count in E2 possible, since figureOf falls through
// to oem. Hard-coded so this file needs no fixture and no network.
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch161.mjs
import { readFileSync } from 'fs';
import { applyEdits, rowKeyFor, ledgerHash, figureOf, amendableRow } from '../lib/ledgerEdits.mjs';
import { LABOUR_RANGE_ADDENDUM, partsTableCells, labourDisplayLines } from '../lib/labour.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const page = readFileSync(new URL('../app/salvage/success/page.js', import.meta.url), 'utf8');
const edits = readFileSync(new URL('../lib/ledgerEdits.mjs', import.meta.url), 'utf8');

// ── CK75ONW, verbatim shape ─────────────────────────────────────────────────────────────────────────
const PARTS = [
  { name: 'Rear bumper',         panelId: 'REAR_BUMPER',         action: 'replace', oem: 655,  used: 360 },
  { name: 'Rear panel',          panelId: 'REAR_PANEL',          action: 'repair',  oem: 360,  used: 200 },
  { name: 'Rear lamp',           panelId: 'REAR_LAMP',           action: 'replace', oem: 280,  used: 155 },
  { name: 'Tailgate',            panelId: 'BOOT_LID',            action: 'repair',  oem: null, used: null },
  { name: 'Front bumper',        panelId: 'FRONT_BUMPER',        action: 'replace', oem: 655,  used: 360 },
  { name: 'Headlamp',            panelId: 'HEADLAMP',            action: 'replace', oem: null, used: 350 },
  { name: 'Wheel arch moulding', panelId: 'WHEEL_ARCH_MOULDING', action: 'replace', oem: 180,  used: 90 },
  { name: 'Front wing',          panelId: 'FRONT_WING',          action: 'repair',  oem: null, used: null },
  { name: 'Rear quarter panel',  panelId: 'REAR_QUARTER',        action: 'replace', oem: 620,  used: null },
  { name: 'Front structure',     panelId: 'FRONT_STRUCTURE',     action: 'inspect', oem: null, used: 500, _structFloor: true },
  { name: 'Rear structure',      panelId: 'REAR_STRUCTURE',      action: 'inspect', oem: null, used: 500, _structFloor: true },
  { name: 'Rear fog lamp',       panelId: 'FOG_LAMP',            action: 'replace', oem: null, used: 105 },
  { name: 'Rear fog lamp',       panelId: 'FOG_LAMP',            action: 'replace', oem: null, used: 105 },
  { name: 'Labour & paint (new & painted)', action: '—', oem: 3063, used: null, _codeLabour: true },
];
const LABOUR_TOP = 3063;
const partsSum = PARTS.reduce((a, p) => a + figureOf(p), 0);
const ASSESSMENT = {
  _reconciledParts: PARTS,
  _partsReconciliation: { parts_sum: partsSum },
  _labourColumns: { newPainted: { low: 2083, high: 3063, money: 3063 }, secondHand: { low: 1862, high: 2738, money: 2738 },
    panelWorkNewPainted: 2450, panelWorkSecondHand: 2190 },
  _labourBodyPanels: [
    { panelId: 'REAR_BUMPER',  zone: 'rear',  severity: 'SEVERE',   action: 'replace' },
    { panelId: 'BOOT_LID',     zone: 'rear',  severity: 'MODERATE', action: 'repair' },
    { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE',   action: 'replace' },
    { panelId: 'FRONT_WING',   zone: 'front', severity: 'MODERATE', action: 'repair' },
    { panelId: 'REAR_QUARTER', zone: 'rear',  severity: 'SEVERE',   action: 'replace' },
  ],
  _labourTellCount: 2,
  _priceBandKey: 'Luxury',
};
const KEYS = rowKeyFor(PARTS);
const KEY = (name) => KEYS[PARTS.findIndex((p) => p.name === name)];
const LABOUR_KEY = KEY('Labour & paint (new & painted)');
const QUARTER_KEY = KEY('Rear quarter panel');
// The layer's version stamp is the ledgerHash of the _reconciledParts ARRAY (ledgerEdits.mjs:267) and the
// field is `stamp` — a layer whose stamp does not match applies NOTHING, silently, which is exactly what a
// stale edit layer must do. Get it wrong here and every assertion below passes-as-no-op.
const LAYER = (over) => ({ stamp: ledgerHash(PARTS), strikes: [], adds: [], amends: [], ...over });
const run = (over) => applyEdits(ASSESSMENT, LAYER(over));
const labourRow = (r) => r.rows.find((x) => x._codeLabour);

console.log(`\n   ledger: ${PARTS.length} rows, parts_sum £${partsSum}, labour row key "${LABOUR_KEY}" at £${LABOUR_TOP}`);

// ── E1 — the controls render on the labour row ──────────────────────────────────────────────────────
console.log('\n-- E1: Remove and Change on the Labour & paint row --');
ok('page.js no longer excludes the code labour row from the controls block',
  !/\{ledgerEditable && editMode && !p\._codeLabour && \(\(\) => \{/.test(page)
  && /\{ledgerEditable && editMode && \(\(\) => \{/.test(page));
ok('the Remove/Restore control is inside that block, so the labour row gets it',
  /\{struck \? '↺ Restore' : '✕ Remove'\}/.test(page));
ok('the labour row may take an amount override', amendableRow(PARTS.at(-1), 'Luxury').amount === true);
ok('the labour row is offered NO repair/replace toggle — the grid does not price it',
  amendableRow(PARTS.at(-1), 'Luxury').action.length === 0);
ok('a body panel still IS offered the toggle — no other row changed',
  amendableRow(PARTS.find((p) => p.panelId === 'REAR_QUARTER'), 'Luxury').action.join(',') === 'repair,replace');
ok('the Change tooltip drops "repair/replace" where no action is offered',
  /title=\{cap\.action\.length \? 'Change repair\/replace, or enter your own figure' : 'Enter your own figure'\}/.test(page));
ok('every row still carries a _rowKey, including the labour row', typeof LABOUR_KEY === 'string' && LABOUR_KEY.length > 0);

// ── E2 — the own figure stands ──────────────────────────────────────────────────────────────────────
console.log('\n-- E2: an own labour figure of £1,800 --');
const base = run({});
console.log(`   (b) baseline total                       £${base.partsSum}   labour row £${figureOf(labourRow(base))}`);
ok('baseline is the stored ledger, untouched', base.partsSum === partsSum && figureOf(labourRow(base)) === LABOUR_TOP);

const own = run({ amends: [{ rowKey: LABOUR_KEY, amount: 1800 }] });
console.log(`   (b) own figure £1,800                    £${own.partsSum}   labour row £${figureOf(labourRow(own))}`);
ok('(b) the labour row carries £1,800', figureOf(labourRow(own)) === 1800);
ok('(b) the total moves by exactly the difference, once',
  own.partsSum === partsSum - LABOUR_TOP + 1800);
ok('(b) our figure is kept on the row so Undo can restore it', labourRow(own)._amended?.from === LABOUR_TOP);

const ownThenStrike = run({ strikes: [QUARTER_KEY], amends: [{ rowKey: LABOUR_KEY, amount: 1800 }] });
console.log(`   (c) own figure + strike Rear quarter     £${ownThenStrike.partsSum}   labour row £${figureOf(labourRow(ownThenStrike))}`);
ok('(c) striking the Rear quarter leaves the labour row at £1,800',
  figureOf(labourRow(ownThenStrike)) === 1800);
ok('(c) no labour recompute ran — the row is not marked recomputed',
  labourRow(ownThenStrike)._labourRecomputed !== true);
ok('(c) the total dropped by the quarter alone, with no second labour movement',
  ownThenStrike.partsSum === own.partsSum - 620);

const strikeOnly = run({ strikes: [QUARTER_KEY] });
console.log(`   (d) Undo, strike Rear quarter            £${strikeOnly.partsSum}   labour row £${figureOf(labourRow(strikeOnly))}`);
ok('(d) with the amend dropped, our figure returns and follows the ledger',
  labourRow(strikeOnly)._labourRecomputed === true
  && labourRow(strikeOnly)._labourWas === LABOUR_TOP
  && figureOf(labourRow(strikeOnly)) !== LABOUR_TOP);
ok('(d) losing a SEVERE replace panel lowers our labour, it does not raise it',
  figureOf(labourRow(strikeOnly)) < LABOUR_TOP);

const removed = run({ strikes: [LABOUR_KEY] });
console.log(`   (e) Remove the labour row                £${removed.partsSum}   (baseline £${base.partsSum})`);
ok('(e) removing the labour row drops the total by the top figure',
  removed.partsSum === partsSum - LABOUR_TOP);
ok('(e) a struck labour row is not an "own figure" — strike still wins',
  labourRow(removed)._struck === true);

// The bug this guards: amendDelta books the buyer's figure, then a labour recompute books a second
// movement on the same row. If the skip is ever removed, (c) moves twice and this is what says so.
console.log('\n-- E2: the double-count guard --');
ok('the recompute is skipped when the labour row carries an own figure',
  /if \(allBodyPanels && li >= 0 && !labourOwnFigure && \(bodyPanelStruck \|\| bodyPanelAmended\)\) \{/.test(edits));
ok('a STRUCK labour row is excluded from labourOwnFigure', /labourRowIdx >= 0 && !rows\[labourRowIdx\]\._struck/.test(edits));
ok('only an AMOUNT amend counts, not an action amend', /_amended\?\.kind === 'amount'/.test(edits));

// ── E3 — our range is not shown as if it applied ────────────────────────────────────────────────────
console.log('\n-- E3: the range, second-hand and addendum with an own figure set --');
ok('with an own figure, labourDisplay is null — all three lines are HIDDEN', own.labourDisplay === null);
ok('without one, all three still show', base.labourDisplay !== null
  && typeof base.labourDisplay.range === 'string' && typeof base.labourDisplay.addendum === 'string');
ok('the screen guards the per-row range lines on that one field',
  /\{p\._codeLabour && !struck && edited\?\.labourDisplay && \(/.test(page));
ok('the screen guards the addendum on the same field',
  /\{edited\?\.labourDisplay && parts\.some\(p => p\._codeLabour && !p\._struck\) && \(/.test(page));
{
  const pdf = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  ok('the PDF guards both on the same field, so hiding covers both surfaces at once',
    /if \(p\._codeLabour && !struck && edited\.labourDisplay\) \{/.test(pdf)
    && /if \(edited\.labourDisplay && pdfParts\.some\(\(p\) => p\._codeLabour && !p\._struck\)\) \{/.test(pdf));
}
ok('striking the labour row also hides them (unchanged behaviour)', removed.labourDisplay === null);

// ── E4 — the addendum ───────────────────────────────────────────────────────────────────────────────
console.log('\n-- E4: the approved addendum --');
ok('the addendum is Vincent\'s approved text, verbatim', LABOUR_RANGE_ADDENDUM
  === 'Labour & paint is an estimate, shown as a range. The repair total, margins and bid ceilings all use the top of that range. If your repairer quotes a different figure, press Change on this line and enter it.');
ok('it no longer instructs a two-step remove-and-add', !/remove the line and add their figure/.test(LABOUR_RANGE_ADDENDUM));
ok('it names the control that now exists', /press Change on this line and enter it/.test(LABOUR_RANGE_ADDENDUM));
ok('the one owner still serves it to both surfaces', labourDisplayLines(ASSESSMENT._labourColumns).addendum === LABOUR_RANGE_ADDENDUM);

// ── E5 — the PDF prints the buyer's figure ──────────────────────────────────────────────────────────
console.log('\n-- E5: the PDF cell for an amended labour row --');
{
  const cells = partsTableCells(labourRow(own));
  console.log(`   partsTableCells(labour @ own figure) = ${JSON.stringify(cells)}`);
  ok('the buyer\'s figure lands in the Repair cost column', cells.repair === 1800);
  ok('it is not printed as a "from" figure', cells.from === false);
  ok('no OEM or second-hand figure is printed beside it', cells.oem === null && cells.sh === null);
  const baseCells = partsTableCells(labourRow(base));
  console.log(`   partsTableCells(labour @ our figure)  = ${JSON.stringify(baseCells)}`);
  ok('our own figure still prints unchanged when nothing is amended', baseCells.repair === LABOUR_TOP);
}

// ── no other row's controls changed ─────────────────────────────────────────────────────────────────
console.log('\n-- scope: no other row moved --');
{
  const others = (r) => r.rows.filter((x) => !x._codeLabour).map((x) => `${x.name}:${figureOf(x)}:${x._struck ? 'S' : '-'}`).join('|');
  ok('an own labour figure changes no other row', others(own) === others(base));
  ok('the row count is unchanged in every scenario',
    [base, own, ownThenStrike, strikeOnly, removed].every((r) => r.rows.length === PARTS.length));
}

console.log(`\nbatch161: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
