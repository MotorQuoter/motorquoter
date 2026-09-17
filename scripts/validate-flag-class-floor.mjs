// validate-flag-class-floor.mjs — batch 150 (CK75ONW, 16 Sep). £0, pure.
//   Z1 — the £500 jig/geometry floor belongs to FRONT/REAR/SIDE_STRUCTURE only; every other flag-only class
//        (spare wheel, parcel shelf, displaced wheel, airbag marker) stays a £0 flag with a plain reason, and
//        the wheel checklist line never calls such a row "wheel/tyre damage already identified and costed".
//   Z2 — a panel in the money never carries a flag reason saying it is not.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-flag-class-floor.mjs
//
// RULINGS (Vincent, 17 Sep — batch 152), locked by the tests below:
//   - DISPLACED_WHEEL is FLAG ONLY — no £500 floor, as built in batch 150 ("Z1: DISPLACED_WHEEL → no floor").
//   - AMALG_REASON_INSPECT_CLASS and the Z2 costed variants are APPROVED as built (pinned verbatim below).
//   - Stored reports keep what they were sold with: the edit layer does NOT re-check non-structure floors
//     ("ruling: the edit layer still uses structureFloorApplies only").
//   - X1: the checklist seed for a non-structure flag-class item reads "inspection item" (keyed on
//     lib/structureFloor.mjs isStructureFloorPanel, never a string); structure panels keep their line.
import { readFileSync } from 'fs';
import { STRUCT_FLOOR_PANELS, isStructureFloorPanel, structureFloorApplies, STRUCT_FLOOR_ZONE } from '../lib/structureFloor.mjs';
import {
  reconcileFlagMoneyWording, COSTED_REASON_UNCORROBORATED, COSTED_REASON_RAD_UNCORROBORATED, COSTED_REASON_COSMETIC,
  sumPartsRealistic,
} from '../lib/parts.mjs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS, EV_PANEL_RESOLVED_CLASS } from '../lib/panelEnum.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
const NO_COST = /not included in the repair (cost|total)|carries no cost|excluded from (the )?repair total/i;

// ── Z1 — which panels may carry the floor ───────────────────────────────────────────────────────────
console.log('\n-- Z1: the jig/geometry floor is for the three structure panels only --');
ok('Z1: exactly FRONT/REAR/SIDE_STRUCTURE', JSON.stringify([...STRUCT_FLOOR_PANELS].sort()) === JSON.stringify(['FRONT_STRUCTURE', 'REAR_STRUCTURE', 'SIDE_STRUCTURE']));
for (const p of STRUCT_FLOOR_PANELS) ok(`Z1: ${p} may carry a floor`, isStructureFloorPanel(p) === true);
// Every flag-only class that is NOT a structure panel — derived from the enum, not a hand list.
const flagOnly = Object.keys(PANEL_BEHAVIOUR).filter((p) => {
  const c = PANEL_BEHAVIOUR[p] === PANEL_CLASS.EV_CONDITIONAL ? EV_PANEL_RESOLVED_CLASS[p] : PANEL_BEHAVIOUR[p];
  return c === PANEL_CLASS.STRUCTURAL_FLAG || c === PANEL_CLASS.VISIBLE_FLAG || c === PANEL_CLASS.PRESENCE_CHECK;
});
ok('Z1: the enum still has flag-only classes to test', flagOnly.length >= 8);
for (const p of flagOnly.filter((x) => !STRUCT_FLOOR_PANELS.includes(x))) {
  ok(`Z1: ${p} (flag-only, not structure) never carries a floor`, isStructureFloorPanel(p) === false);
}
for (const p of [PANEL.SPARE_WHEEL, PANEL.PARCEL_SHELF, PANEL.OTHER, PANEL.DISPLACED_WHEEL, PANEL.AIRBAG, PANEL.WHEEL, 'UNKNOWN']) {
  ok(`Z1: ${p} → no floor`, isStructureFloorPanel(p) === false);
}
// The batch 147 X2 zone rule is unchanged, and SIDE_STRUCTURE (no bumper zone) keeps its batch 106 floor.
ok('Z1: SIDE_STRUCTURE positive read still floors (no zone rule)', structureFloorApplies('SIDE_STRUCTURE', new Set()).apply === true);
ok('Z1: X2 zone rule unchanged — front bumper alone → no front floor', structureFloorApplies('FRONT_STRUCTURE', new Set(['FRONT_BUMPER'])).apply === false);
ok('Z1: no zone was added for a non-structure panel', Object.keys(STRUCT_FLOOR_ZONE).every((k) => STRUCT_FLOOR_PANELS.includes(k)));

// Engine wiring — keyed on panelId membership, not the reason substring.
ok('Z1: zero-rule A no longer keys on the reason substring', !route.includes(".includes('structural or inspection-class')"));
ok('Z1: zero-rule A asks isStructureFloorPanel before flooring', /isFlagClassRead && !isStructureFloorPanel\(pid\)[\s\S]{0,600}continue;/.test(route));
ok('Z1: the non-structure branch injects no row', (() => {
  const i = route.indexOf('isFlagClassRead && !isStructureFloorPanel(pid)');
  const block = route.slice(i, route.indexOf('if (isFlagClassRead) {', i));
  return i > 0 && !/gatedParts\.push|injected\s*=/.test(block);
})());
ok('Z1: amalgamate gives structural wording to STRUCTURAL_FLAG only', route.includes('effClass === PANEL_CLASS.STRUCTURAL_FLAG ? AMALG_REASON_FLAG_CLASS : AMALG_REASON_INSPECT_CLASS'));
ok('Z1: all three flag-class pushes carry the marker and the class reason',
  (route.match(/reason: flagClassReason, _flagClassRead: true/g) || []).length === 3
  && !/weight: 'high', reason: AMALG_REASON_FLAG_CLASS \}/.test(route));
const inspectReason = (route.match(/const AMALG_REASON_INSPECT_CLASS\s*=\s*'([^']+)'/) || [])[1] || '';
ok('Z1: the plain reason exists', inspectReason.length > 0);
ok('Z1: the plain reason makes no structural or jig claim', inspectReason && !/structur|jig|geometry|damage/i.test(inspectReason));
ok('Z1: the plain reason says it is not in the repair cost (true — no row)', NO_COST.test(inspectReason));

// CK75ONW, reasoned from the report (no cassette): S/H £7,430 held a Spare wheel "from £500" row.
// Removing that row and nothing else is −£500 → £6,930. Proved with the shipped summer.
{
  const others = { name: 'everything else on the report', used: 6930, oem: 8380 };
  const spare = { panelId: 'SPARE_WHEEL', name: 'Spare wheel', action: 'inspect', oem: null, used: 500, _structFloor: true, _zeroRule: 'A' };
  const before = sumPartsRealistic([others, spare]);
  const after = sumPartsRealistic([others]);
  ok(`Z1: CK75ONW-shaped ledger S/H £${before} → £${after} (want £7,430 → £6,930)`, before === 7430 && after === 6930);
}

// ── Z1 — the wheel checklist line ───────────────────────────────────────────────────────────────────
console.log('\n-- Z1: the wheel checklist line names only costed road wheels/tyres --');
{
  const { wheelNetParts } = await import('@/app/api/salvage/assess/route.js');
  const spareFloor = { panelId: 'SPARE_WHEEL', name: 'Spare wheel', action: 'inspect', oem: null, used: 500, _structFloor: true, _zeroRule: 'A' };
  const dispFloor = { panelId: 'DISPLACED_WHEEL', name: 'Displaced wheel', action: 'inspect', oem: null, used: 500, _structFloor: true, _zeroRule: 'A' };
  const wheel = { panelId: 'WHEEL', name: 'Wheel', action: 'replace', oem: 1125, used: 620 };
  const tyre = { panelId: 'TYRE', name: 'Tyre', action: 'replace', oem: 180, used: 90 };
  const zeroWheel = { panelId: 'WHEEL', name: 'Wheel', action: 'replace', oem: 0, used: 0 };
  const cosmeticWheel = { panelId: 'WHEEL', name: 'Wheel', action: 'repair', oem: null, used: 200, _zeroRule: 'F' };
  const bumper = { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 655, used: 360 };
  ok('Z1: CK75ONW — a spare-wheel floor is NOT "wheel/tyre damage already costed"', wheelNetParts([bumper, spareFloor]).length === 0);
  ok('Z1: DL72FVX — same, spare wheel alone', wheelNetParts([spareFloor]).length === 0);
  ok('Z1: AK75RDX — a displaced-wheel marker is not named, the costed wheel is',
    JSON.stringify(wheelNetParts([wheel, dispFloor]).map((p) => p.name)) === JSON.stringify(['Wheel']));
  ok('Z1: a costed tyre is named', wheelNetParts([tyre]).length === 1);
  ok('Z1: a £0 wheel row is not "costed"', wheelNetParts([zeroWheel]).length === 0);
  ok('Z1: a cosmetic repair wheel in the money is named (it is costed)', wheelNetParts([cosmeticWheel]).length === 1);
  ok('Z1: the checklist reads wheelNetParts', route.includes('const damagedWheelParts = wheelNetParts(gatedParts);'));
}

// ── Z2 — words match the money ──────────────────────────────────────────────────────────────────────
console.log('\n-- Z2: a costed panel never carries a "not included" reason --');
const reasonOf = (name) => (route.match(new RegExp(`const ${name}\\s*=\\s*'([^']+)'`)) || [])[1];
const UNCORROBORATED = reasonOf('AMALG_REASON_UNCORROBORATED');
const RAD = reasonOf('AMALG_REASON_RAD_UNCORROBORATED');
const COSMETIC = reasonOf('AMALG_REASON_COSMETIC');
const SINGLE_MINOR = reasonOf('AMALG_REASON_SINGLE_MINOR');
ok('Z2: the shipped no-cost reasons were read from route.js', [UNCORROBORATED, RAD, COSMETIC, SINGLE_MINOR].every((r) => r && NO_COST.test(r)));
{
  // CK75ONW verbatim: Rear panel costed £360/£200 (LUXURY band — zero-rule C), MEDIUM uncorroborated flag.
  const rows = [{ panelId: 'REAR_PANEL', name: 'Rear panel', action: 'replace', oem: 360, used: 200, _tableMandated: true, _zeroRule: 'C' }];
  const rowsBefore = JSON.stringify(rows);
  const flag = { panelId: 'REAR_PANEL', partName: 'Rear panel', zone: 'rear', weight: 'medium', reason: UNCORROBORATED, _amalgUncorroborated: true };
  const out = reconcileFlagMoneyWording([flag], rows);
  ok('Z2: CK75ONW Rear panel — reason rewritten', out.length === 1 && flag.reason === COSTED_REASON_UNCORROBORATED);
  ok('Z2: CK75ONW Rear panel — no "not included" left', !NO_COST.test(flag.reason));
  ok('Z2: CK75ONW Rear panel — still says it is single-view / uncorroborated', /single-view/.test(flag.reason) && /not corroborated/.test(flag.reason));
  ok('Z2: CK75ONW Rear panel — says it IS in the total and how to strike it', /included in the repair total/.test(flag.reason) && /strike the line/.test(flag.reason));
  ok('Z2: the flag is kept (weight and marker unchanged)', flag.weight === 'medium' && flag._amalgUncorroborated === true);
  ok('Z2: money untouched — rows byte-identical', JSON.stringify(rows) === rowsBefore);
  ok('Z2: idempotent — a second pass changes nothing', reconcileFlagMoneyWording([flag], rows).length === 0);
}
{
  const rows = [
    { panelId: 'RADIATOR_PACK', name: 'Radiator pack', oem: 1055, used: 580, _zeroRule: 'D' },
    { panelId: 'WHEEL', name: 'Wheel', action: 'repair', oem: null, used: 200, _zeroRule: 'F' },
    { panelId: 'REAR_QUARTER', name: 'Rear quarter panel', oem: 400, used: 220, _q4Promoted: true },
    { panelId: 'FRONT_WING', name: 'Front wing', action: 'repair', oem: null, used: 0, _repairNoPart: true },
  ];
  const rad = { panelId: 'RADIATOR_PACK', weight: 'medium', reason: RAD, _radUncorroborated: true };
  const cos = { panelId: 'WHEEL', weight: 'low', reason: COSMETIC, _amalgCosmetic: true };            // SF69YBB sweep dump
  const minor = { panelId: 'REAR_QUARTER', weight: 'low', reason: SINGLE_MINOR, _amalgSingleMinor: true }; // DL72FVX sweep dump
  const wing = { panelId: 'FRONT_WING', weight: 'low', reason: COSMETIC, _amalgCosmetic: true };      // repaired, cost in panel work
  const uncosted = { panelId: 'SILL', weight: 'medium', reason: UNCORROBORATED, _amalgUncorroborated: true };
  const noPanel = { partName: 'Headlamp', weight: 'medium', reason: 'precautionary £350 (LED) inspection allowance, NOT included in the repair total' };
  const out = reconcileFlagMoneyWording([rad, cos, minor, wing, uncosted, noPanel], rows);
  ok('Z2: family D radiator → costed wording', rad.reason === COSTED_REASON_RAD_UNCORROBORATED);
  ok('Z2: family F cosmetic (SF69YBB Wheel) → costed wording', cos.reason === COSTED_REASON_COSMETIC);
  ok('Z2: a repaired panel (£0 part, _repairNoPart) is costed too', wing.reason === COSTED_REASON_COSMETIC);
  ok('Z2: DL72FVX single-MINOR on a Q4-promoted quarter → no-cost clause dropped', !NO_COST.test(minor.reason) && /one photo suggested light damage/.test(minor.reason) && /included in the repair total/.test(minor.reason));
  ok('Z2: an UNCOSTED panel keeps its "not included" reason (it is true)', uncosted.reason === UNCORROBORATED);
  ok('Z2: a panelless allowance flag is left alone', /NOT included/.test(noPanel.reason));
  ok('Z2: four rewrites reported', out.length === 4);
}
{
  // Sweep every AMALG_REASON_* constant that asserts no cost: on a costed panel, NONE may survive the pass.
  const all = [...route.matchAll(/const (AMALG_REASON_\w+)\s*=\s*'([^']+)'/g)].map((m) => ({ name: m[1], reason: m[2] }));
  const noCost = all.filter((r) => NO_COST.test(r.reason));
  console.log(`   no-cost AMALG reasons: ${noCost.map((r) => r.name).join(', ')}`);
  ok('Z2: the sweep found the no-cost reasons', noCost.length >= 5);
  for (const r of noCost) {
    const f = { panelId: 'BONNET', reason: r.reason };
    reconcileFlagMoneyWording([f], [{ panelId: 'BONNET', used: 300 }]);
    ok(`Z2: ${r.name} on a costed panel → no "not included" survives`, !NO_COST.test(f.reason) && f.reason.length > 20);
  }
}
{
  // Wiring: runs after the ledger is final, before the damage cards read the reasons.
  const call = route.indexOf('reconcileFlagMoneyWording([');
  const cards = route.indexOf('const _cards = buildDamageCards(');
  const ledger = route.indexOf('assessment._reconciledParts = gatedParts;');
  ok('Z2: route calls the owner once', call > 0 && route.indexOf('reconcileFlagMoneyWording([', call + 1) === -1);
  ok('Z2: after the ledger is final, before the damage cards', ledger > 0 && ledger < call && call < cards);
  ok('Z2: over BOTH flag lists', /reconcileFlagMoneyWording\(\[\.\.\.\(assessment\._flaggedParts \|\| \[\]\), \.\.\.\(coreObs\.flaggedParts \|\| \[\]\)\], gatedParts\)/.test(route));
}

// ── Rulings pinned (batch 152) ──────────────────────────────────────────────────────────────────────
console.log('\n-- batch 152: rulings pinned --');
ok('ruling: AMALG_REASON_INSPECT_CLASS approved verbatim',
  inspectReason === 'inspection item — flagged for inspection, not included in the repair cost; ask for it on the WhatsApp inspection before bidding');
ok('ruling: Z2 costed uncorroborated wording approved verbatim', COSTED_REASON_UNCORROBORATED ===
  'single-view damage — only one photo flagged this panel; the other photos that show this area did not flag it, so the damage is not corroborated. It has been included in the repair total on the visible evidence — strike the line on the ledger if the inspection shows it sound.');
ok('ruling: Z2 costed cosmetic wording approved verbatim', COSTED_REASON_COSMETIC ===
  'light cosmetic damage — refinish or trim-grade. It has been included in the repair total at the repair figure — strike the line on the ledger if the inspection shows it sound.');
ok('ruling: Z2 costed radiator wording approved verbatim', COSTED_REASON_RAD_UNCORROBORATED ===
  'single-view damage on a part only visible when the front is open; no second view confirmed it and no central front-structure damage corroborates it. It has been included in the repair total on the visible evidence — strike the line on the ledger if the inspection shows it sound.');
{
  const edits = readFileSync(new URL('../lib/ledgerEdits.mjs', import.meta.url), 'utf8');
  ok('ruling: the edit layer still uses structureFloorApplies only (stored non-structure floors kept as sold)',
    edits.includes('structureFloorApplies(r.panelId, survivingDamaged)') && !edits.includes('isStructureFloorPanel'));
}

// ── X1 — the checklist seed line for flag-class items ───────────────────────────────────────────────
console.log('\n-- batch 152 X1: "inspection item" seed for non-structure flag-class items --');
{
  const { seedChecklistFromFlags, isNonStructureFlagClass } = await import('../lib/parts.mjs');
  const partsSrc = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');
  const STRUCT_LINE = (p) => `Show ${p} close-up — structural or inspection-class component; confirm condition before bidding.`;
  const INSPECT_LINE = (p) => `Show ${p} close-up — inspection item; confirm condition before bidding.`;
  const seed = (flags) => seedChecklistFromFlags('1. Show the bonnet shut line.', flags, { lampTier2Fired: false });
  for (const [pid, name] of [['FRONT_STRUCTURE', 'Front structure'], ['REAR_STRUCTURE', 'Rear structure'], ['SIDE_STRUCTURE', 'Side structure']]) {
    const t = seed([{ panelId: pid, partName: name, weight: 'high', reason: 'x' }]);
    ok(`X1: ${pid} keeps the structural line`, t.includes(STRUCT_LINE(name)));
  }
  for (const [pid, name] of [['PARCEL_SHELF', 'Parcel shelf'], ['EV_BATTERY_PRESENCE', 'HV battery'], ['EV_BATTERY_ZONE', 'HV battery pack'], ['AIRBAG', 'Airbag']]) {
    const t = seed([{ panelId: pid, partName: name, weight: 'high', reason: inspectReason }]);
    ok(`X1: ${pid} → "inspection item", never "structural"`, t.includes(INSPECT_LINE(name)) && !/structural/i.test(t));
  }
  // Every flag-only class in the enum, derived — not a hand list.
  for (const p of flagOnly) ok(`X1: ${p} is ${STRUCT_FLOOR_PANELS.includes(p) ? 'structure' : 'an inspection item'}`,
    isNonStructureFlagClass(p) === !STRUCT_FLOOR_PANELS.includes(p));
  for (const p of ['BONNET', 'FRONT_BUMPER', 'OTHER', null, undefined, 'UNKNOWN']) ok(`X1: ${p} is not a flag-class inspection item`, isNonStructureFlagClass(p) === false);
  // A spare wheel / tyre mobility kit never reaches this line: seed Rule 1 (wheel-net) skips any "…wheel…" part.
  const spare = seed([{ panelId: 'SPARE_WHEEL', partName: 'Spare wheel', weight: 'high', reason: inspectReason }]);
  ok('X1: Spare wheel is skipped by the wheel-net rule (no seed line at all)', !/Spare wheel/.test(spare));
  ok('X1: SPARE_WHEEL is still classed an inspection item (for any other name)', isNonStructureFlagClass('SPARE_WHEEL') === true);
  // A high flag that is not flag-class keeps the generic line (out of X1 scope).
  const other = seed([{ panelId: 'FRONT_BUMPER', partName: 'front bumper', weight: 'high', reason: 'bumper read as displaced', _bumperOffContradiction: true }]);
  ok('X1: a non-flag-class high flag keeps the generic line (unchanged)', other.includes(STRUCT_LINE('front bumper')));
  // The airbag SRS line still wins over X1 (its branch sits first).
  const srs = seed([{ panelId: 'AIRBAG', partName: 'SRS airbag (deployed)', weight: 'high', reason: 'x', _srsExtentFloor: true }]);
  ok('X1: the SRS airbag line is unchanged', srs.includes('Show SRS airbag (deployed) close-up — the number and location of the bags must be checked before bidding.'));
  // Keyed on the one owner, not a string.
  ok('X1: keyed on isStructureFloorPanel from lib/structureFloor.mjs', partsSrc.includes("import { isStructureFloorPanel } from './structureFloor.mjs';")
    && /export function isNonStructureFlagClass\(panelId\) \{\s*if \(!panelId \|\| isStructureFloorPanel\(panelId\)\) return false;/.test(partsSrc));
  const iSrs = partsSrc.indexOf('} else if (flag._srsExtentFloor) {');
  const iX1 = partsSrc.indexOf("} else if (flag.weight === 'high' && isNonStructureFlagClass(pid)) {");
  const iGen = partsSrc.indexOf("} else if (flag.weight === 'high') {");
  ok('X1: the inspection-item branch sits after the SRS branch and before the generic one', iSrs > 0 && iSrs < iX1 && iX1 < iGen);
}

console.log(`\nflag-class-floor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
