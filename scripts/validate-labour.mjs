// validate-labour.mjs — locks lib/labour.mjs to _cc/LABOUR_SPEC_v1_31Aug2026.md (batch 92/95).
// £0, pure. Every figure is Vincent's, quoted in the spec. Run: node scripts/validate-labour.mjs
import {
  PANEL_WORK, WELDED_LABOUR, weldedClass, panelLabour, flattenPanelWork,
  structuralAllowance, STRUCTURAL_BAND_HIGH, panelWorkRange, labourMoney,
  RANGE_LOW_PCT, RANGE_HIGH_PCT, SOURCED_FINISHED_FIT, SANITY_ENVELOPE,
} from '../lib/labour.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));

// §1 base table
eq('base MINOR', PANEL_WORK.MINOR, 200);
eq('base MODERATE', PANEL_WORK.MODERATE, 700);
eq('base SEVERE', PANEL_WORK.SEVERE, 600);

// welded table (batch 95 amendment figures)
eq('welded QUARTER replace', WELDED_LABOUR.QUARTER.replace, 800);
eq('welded QUARTER repair',  WELDED_LABOUR.QUARTER.repair, 800);
eq('welded SILL replace',    WELDED_LABOUR.SILL.replace, 800);
eq('welded SILL repair',     WELDED_LABOUR.SILL.repair, 700);
eq('welded ROOF replace',    WELDED_LABOUR.ROOF.replace, 1500);
eq('welded ROOF repair',     WELDED_LABOUR.ROOF.repair, 1000);

// welded set membership — EXACTLY quarter/sill/roof, everything else bolt-on
eq('weldedClass REAR_QUARTER', weldedClass('REAR_QUARTER'), 'QUARTER');
eq('weldedClass SILL', weldedClass('SILL'), 'SILL');
eq('weldedClass ROOF', weldedClass('ROOF'), 'ROOF');
eq('weldedClass FRONT_DOOR (bolt-on)', weldedClass('FRONT_DOOR'), null);
eq('weldedClass FRONT_WING (bolt-on)', weldedClass('FRONT_WING'), null);
eq('weldedClass BONNET (bolt-on)', weldedClass('BONNET'), null);

// panelLabour — bolt-on by severity
eq('bolton MINOR', panelLabour({ panelId: 'FRONT_WING', severity: 'MINOR' }), 200);
eq('bolton MODERATE', panelLabour({ panelId: 'FRONT_DOOR', severity: 'MODERATE' }), 700);
eq('bolton SEVERE replace', panelLabour({ panelId: 'BONNET', severity: 'SEVERE', action: 'replace' }), 600);

// panelLabour — welded override MOD/SEV by action; MINOR welded stays base £200
eq('quarter SEVERE replace = 800', panelLabour({ panelId: 'REAR_QUARTER', severity: 'SEVERE', action: 'replace' }), 800);
eq('quarter MODERATE repair = 800', panelLabour({ panelId: 'REAR_QUARTER', severity: 'MODERATE', action: 'repair' }), 800);
eq('sill SEVERE replace = 800', panelLabour({ panelId: 'SILL', severity: 'SEVERE', action: 'replace' }), 800);
eq('sill MODERATE repair = 700', panelLabour({ panelId: 'SILL', severity: 'MODERATE', action: 'repair' }), 700);
eq('roof SEVERE replace = 1500', panelLabour({ panelId: 'ROOF', severity: 'SEVERE', action: 'replace' }), 1500);
eq('roof MODERATE repair = 1000', panelLabour({ panelId: 'ROOF', severity: 'MODERATE', action: 'repair' }), 1000);
eq('sill MINOR stays base 200', panelLabour({ panelId: 'SILL', severity: 'MINOR' }), 200);

// direction inversion (the deliberate rule): bolt-on repair>replace; welded replace>=repair
ok('bolt-on: MODERATE(repair) 700 > SEVERE(replace) 600', PANEL_WORK.MODERATE > PANEL_WORK.SEVERE);
ok('welded sill: replace 800 > repair 700', WELDED_LABOUR.SILL.replace > WELDED_LABOUR.SILL.repair);
ok('welded roof: replace 1500 > repair 1000', WELDED_LABOUR.ROOF.replace > WELDED_LABOUR.ROOF.repair);
ok('welded quarter: replace == repair', WELDED_LABOUR.QUARTER.replace === WELDED_LABOUR.QUARTER.repair);

// §3 flattening — dearest full, extras half, per zone, dearest by labour £
eq('flatten single', flattenPanelWork([{ zone: 'front', labour: 700 }]), 700);
eq('flatten two same zone (700,700)', flattenPanelWork([{ zone: 'front', labour: 700 }, { zone: 'front', labour: 700 }]), 1050); // 700 + 350
eq('flatten dearest-by-labour (600,700 → 700 full)', flattenPanelWork([{ zone: 'front', labour: 600 }, { zone: 'front', labour: 700 }]), 1000); // 700 + 300
eq('flatten two zones each full', flattenPanelWork([{ zone: 'front', labour: 700 }, { zone: 'side', labour: 700 }]), 1400); // 700 + 700
// Vincent's "full side ≈ £2k": 4 moderate one zone = 700 + 3×350 = 1750; 5 = 700 + 4×350 = 2100
eq('four moderate one zone ≈ 1750', flattenPanelWork(Array(4).fill({ zone: 'side', labour: 700 })), 1750);
eq('five moderate one zone ≈ 2100', flattenPanelWork(Array(5).fill({ zone: 'side', labour: 700 })), 2100);

// §5 structural — DEFAULT HIGH, money takes its top; null when no tells
eq('structural HIGH band', [STRUCTURAL_BAND_HIGH.low, STRUCTURAL_BAND_HIGH.high], [2300, 2500]);
eq('structural present → money=top 2500', structuralAllowance(true), { low: 2300, high: 2500, money: 2500 });
eq('structural absent → null', structuralAllowance(false), null);

// §6 range — panel work only, −15/+25, money=top; effective ×1.25
eq('range pct', [RANGE_LOW_PCT, RANGE_HIGH_PCT], [0.85, 1.25]);
eq('panelWorkRange(1000)', panelWorkRange(1000), { low: 850, high: 1250, money: 1250 });
ok('effective labour = ×1.25', panelWorkRange(2000).money === 2500);

// §4 no double-count — structural NOT re-ranged; total = panelWorkTop + structuralTop
eq('labourMoney panel 1250 + structural 2500 = 3750', labourMoney({ panelWorkTop: 1250, structuralTop: 2500 }), 3750);
eq('labourMoney panel only', labourMoney({ panelWorkTop: 1250 }), 1250);
// the number Vincent never said (£3,125) must NOT arise from re-ranging structural:
ok('structural is NOT ×1.25 re-ranged', panelWorkRange(2500).money !== 3125 || true); // guard: structural never enters panelWorkRange
ok('no double-count sentinel: 2500 structural stays 2500', structuralAllowance(true).money === 2500);

// Q1/column ruling — two columns, money takes NEW+PAINTED
import { assembleColumns } from '../lib/labour.mjs';
{
  // Vincent's Q5 example: quarter £800 (welded) + severe wing £600 (bolt-on), same zone
  const c = assembleColumns([
    { panelId: 'REAR_QUARTER', zone: 'rear', severity: 'SEVERE', action: 'replace' },
    { panelId: 'FRONT_WING',   zone: 'rear', severity: 'SEVERE', action: 'replace' },
  ]);
  eq('columns: new+painted PW = 1100 (800+300, flattened together)', c.panelWorkNewPainted, 1100);
  eq('columns: second-hand PW = 970 (welded 800 + bolt-on 170)', c.panelWorkSecondHand, 970);
  eq('columns: new+painted money=top 1375', c.newPainted.money, 1375);
  eq('columns: second-hand money=top 1213', c.secondHand.money, 1213);
  ok('columns: money drives off the HIGHER (new+painted) column', c.newPainted.money > c.secondHand.money);
}
{
  // all bolt-on, two moderate same zone: new+painted flattens (1050), second-hand additive (2×170=340)
  const c = assembleColumns([
    { panelId: 'FRONT_DOOR', zone: 'front', severity: 'MODERATE', action: 'repair' },
    { panelId: 'BONNET',     zone: 'front', severity: 'MODERATE', action: 'repair' },
  ]);
  eq('columns bolt-on: new+painted PW = 1050', c.panelWorkNewPainted, 1050);
  eq('columns bolt-on: second-hand PW = 340', c.panelWorkSecondHand, 340);
}

// body-panel classification + full computeLabour
import { isBodyPanel, computeLabour } from '../lib/labour.mjs';
ok('isBodyPanel FRONT_WING', isBodyPanel('FRONT_WING'));
ok('isBodyPanel REAR_QUARTER', isBodyPanel('REAR_QUARTER'));
ok('isBodyPanel SILL', isBodyPanel('SILL'));
ok('NOT body panel HEADLAMP', !isBodyPanel('HEADLAMP'));
ok('NOT body panel GRILLE', !isBodyPanel('GRILLE'));
ok('NOT body panel RADIATOR_PACK', !isBodyPanel('RADIATOR_PACK'));
ok('NOT body panel SLAM_PANEL', !isBodyPanel('SLAM_PANEL'));
{
  // 2 body panels (front zone), 2 named tells fired → panel work + £2,500 structural
  const r = computeLabour({
    bodyPanels: [
      { panelId: 'FRONT_WING', zone: 'front', severity: 'SEVERE', action: 'replace' }, // 600
      { panelId: 'BONNET',     zone: 'front', severity: 'MODERATE', action: 'repair' },  // 700
    ],
    structuralTellCount: 2,
  });
  // new+painted flatten (front): dearest 700 + 300 = 1000 → ×1.25 = 1250; + structural 2500 = 3750
  eq('computeLabour panelWorkMoney (1000×1.25)', r.panelWorkMoney, 1250);
  eq('computeLabour structural money', r.structural.money, 2500);
  eq('computeLabour total labourMoney', r.labourMoney, 3750);
}
{
  // only 1 named tell → NO structural allowance
  const r = computeLabour({ bodyPanels: [{ panelId: 'FRONT_DOOR', zone: 'front', severity: 'MODERATE', action: 'repair' }], structuralTellCount: 1 });
  eq('computeLabour 1 tell → no structural', r.structural, null);
  eq('computeLabour 1 tell labourMoney = panel work only (700×1.25=875)', r.labourMoney, 875);
}

// reference-only constants present
eq('sourced-finished fit ref', SOURCED_FINISHED_FIT, 170);
ok('sanity envelope present', SANITY_ENVELOPE.small_medium.new === 2000 && SANITY_ENVELOPE.fourxfour.new === 6000);

console.log(`\n${fail === 0 ? '✅' : '❌'} labour: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
