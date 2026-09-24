// validate-batch184.mjs — batch 184 P2: the Margin "driven by" sentence is code-owned, built from the charged ledger rows.
// £0, pure, no model calls. (P1 — the two labels — is not built: see the batch 184 handoff. P3 is report only.)
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch184.mjs
import { readFileSync } from 'fs';
import { DRIVER_SENTENCE, isDriverSentence, codeOwnDriverSentence } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const LAB = (oem) => ({ name: 'Labour & paint (new & painted)', action: '—', used: null, oem, _codeLabour: true });

console.log('\n-- P2: the sentence, from the charged rows --');
{
  // EN23NJX's charged ledger (bbd4fa4 replay)
  const EN = [
    { panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', used: null, oem: null, _repairNoPart: true },
    { panelId: 'WHEEL_ARCH_MOULDING', name: 'Wheel arch moulding', action: 'replace', used: 50, oem: 100 },
    LAB(1000),
  ];
  ok('(EN23NJX) verbatim: largest first, actions, labour last', DRIVER_SENTENCE(EN) === 'The repair total is made up of: the wheel arch moulding (replace), the rear quarter panel (repair) and labour & paint.');
  ok('no £ figure in the sentence', !/£|\d{2,}/.test(DRIVER_SENTENCE(EN)));
  // DL72FVX: one row, labour £0 → not named
  const DL = [{ panelId: 'WHEEL_ARCH_MOULDING', name: 'Wheel arch moulding', action: 'replace', used: 60, oem: 120 }];
  ok('(DL72FVX) labour & paint left out when its line is £0 (the £0 row is not charged)', DRIVER_SENTENCE(DL) === 'The repair total is made up of: the wheel arch moulding (replace).');
  ok('no charged rows → "The repair total has no itemised lines."', DRIVER_SENTENCE([]) === 'The repair total has no itemised lines.');
  // over 4: the 4 largest by figure, merged pairs, a floor as an allowance, then "N other lines"
  const SD = [
    { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', used: 360 },
    { panelId: 'GRILLE', name: 'Grille', action: 'replace', used: 120 },
    { panelId: 'RADIATOR_PACK', name: 'Radiator pack', action: 'replace', used: 580 },
    { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', used: 350 },
    { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', used: 350 },
    { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', used: null, oem: 500, _structFloor: true },
    { panelId: 'SRS_AIRBAG', name: 'SRS airbag kit (deployed)', action: 'replace', used: 500 },
    LAB(1500),
  ];
  ok('over 4 items: 4 largest, pair merged ×2, floor = allowance, trailing "(deployed)" dropped, then N other lines',
    DRIVER_SENTENCE(SD) === 'The repair total is made up of: the headlamp ×2 (replace), the radiator pack (replace), the front structure allowance, the SRS airbag kit (replace), 2 other lines and labour & paint.');
  ok('one other line is singular', DRIVER_SENTENCE([...SD.slice(0, 1), ...SD.slice(2, 7)]).endsWith(' and 1 other line.'));
}

console.log('\n-- P2: which sentences are driver sentences --');
{
  const drivers = [
    'The repair is driven by the rear quarter blend, the rear bumper replacement and the sill work.',                          // EN23NJX
    'The repair is a moderate rear-end job driven by the absent bumper, the quarter blend and the lamp cluster.',             // FE68AOP
    'The cost drivers are the radiator pack, both front LED headlamps, and the second paint operation at the rear.',          // SF69YBB
    'The itemised repair is light — front bumper replacement and refinish plus an arch trim item.',                           // DL72FVX
    'The repair is moderate-to-heavy: a defined set of front-end replacement panels and refinish, plus code-owned SRS.',      // SD75YGC
    'The repair is a front-end panel/lighting/cooling rebuild with a paint element — moderate in nature, with the radiator pack, wing and headlamp allowance as the main drivers.', // YH23NVW
  ];
  for (const s of drivers) ok(`driver: "${s.slice(0, 60)}…"`, isDriverSentence(s) === 'driver');
  const mixed = [
    'The band position is mid: the lot has strong desirability signals offset by a moderate-to-heavy single-flank repair whose cost is dominated by two door shells, paint labour, and the sill zone.', // DMZ4614
    'The repair is a moderate front-corner rebuild — bumper, support and mirror with paint — with the genuine cost swing sitting in the unconfirmed radiator pack and front inner structure.',         // EA17HDN
  ];
  for (const s of mixed) ok(`mixed → held: "${s.slice(0, 60)}…"`, isDriverSentence(s) === 'mixed');
  const none = [
    'The band position is mid-low, driven by heavy full-width frontal damage and the unresolved high-voltage risks.',        // AMZ3790 — no repair/cost before "driven by"
    'The two cost drivers that sit outside the itemised total — front chassis alignment and HV integrity — decide the margin.', // SD75YGC
    'If those are clean, the itemised repair stands as costed; if the cooling pack is compromised, add to it.',               // EA17HDN
    'The repair is moderate in the outer-panel scope but carries meaningful upside risk if the inner sill or B-pillar base is deformed — that would convert it.', // DMZ4614
  ];
  for (const s of none) ok(`not a driver sentence: "${s.slice(0, 60)}…"`, isDriverSentence(s) === null);
}

console.log('\n-- P2: the replacement in the Margin text --');
{
  const rows = [{ panelId: 'WHEEL_ARCH_MOULDING', name: 'Wheel arch moulding', action: 'replace', used: 50, oem: 100 }, LAB(1000)];
  const IN = 'I chose mid-high. The repair is driven by the rear quarter blend, the rear bumper replacement and the sill work. Not in the repair total: the rear bumper and the sill — check them on inspection. The margin picture depends on the sill.';
  const r = codeOwnDriverSentence(IN, rows);
  ok('the sentence AND its batch 183 P3 tail are replaced by one code-owned sentence',
    r.text === 'I chose mid-high. The repair total is made up of: the wheel arch moulding (replace) and labour & paint. The margin picture depends on the sill.');
  ok('stamp carries before (with the tail), after and the rows', r.stamp.before.endsWith('check them on inspection.') && r.stamp.after.startsWith('The repair total is made up of') && r.stamp.rows.length === 2);
  const two = 'The repair is driven by the bonnet. The cost drivers are the grille.';
  ok('only the first driver sentence is replaced', codeOwnDriverSentence(two, rows).text.endsWith('The cost drivers are the grille.'));
  // batch 185: the old example ('The band position is mid, offset by a repair whose cost is dominated by two door shells.') is
  // now shape A and is replaced by rule; a mixed sentence matching neither shape is still left as written and reported.
  const mix = 'The repair is a moderate rebuild — bumper and mirror — with the swing depending on the radiator pack.';
  const m = codeOwnDriverSentence(mix, rows);
  ok('a mixed sentence matching neither batch 185 shape is left as written and reported', m.text === mix && m.stamp === null && m.held.length === 1);
  ok('no driver sentence → untouched, stamp null', codeOwnDriverSentence('Nothing here.', rows).stamp === null);

  const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
  ok('route: Margin only, from the one charged-row set, after 183 P3', /if \(field === 'Margin Calculation'\) \{\s*const _dr = codeOwnDriverSentence\(assessment\[field\], _chargedRows\);/.test(route)
    && route.indexOf('codeOwnDriverSentence(assessment[field], _chargedRows)') > route.indexOf('assessment[field] = _cc.text;'));
  ok('route: stamp always (null when nothing replaced)', route.includes('assessment._driverSentence = null;'));
}

console.log(`\nbatch184: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
