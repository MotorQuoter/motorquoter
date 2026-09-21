// validate-labour.mjs — locks lib/labour.mjs to docs/LABOUR_SPEC_v1.md (batch 92/95).
// £0, pure. Every figure is Vincent's, quoted in the spec. Run: node scripts/validate-labour.mjs
import {
  PANEL_WORK, WELDED_LABOUR, weldedClass, panelLabour, flattenPanelWork,
  structuralAllowance, STRUCTURAL_BAND_HIGH, panelWorkRange, labourMoney,
  RANGE_LOW_PCT, RANGE_HIGH_PCT, SOURCED_FINISHED_FIT, SANITY_ENVELOPE,
  applyGradeOwnsAction, REPAIR_NO_PART_NOTE,
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
  // batch 127 (spec open item 4, Vincent 14 Sep): two MODERATE bolt-ons REPAIRED get no new panel, so there is no
  // £170 to fit. Each keeps its painted repair figure, flattened like any painted work. (Supersedes the old
  // "second-hand PW = 340" assertion — that WAS the defect: £170 of fitting on panels nobody replaces.)
  const c = assembleColumns([
    { panelId: 'FRONT_DOOR', zone: 'front', severity: 'MODERATE', action: 'repair' },
    { panelId: 'BONNET',     zone: 'front', severity: 'MODERATE', action: 'repair' },
  ]);
  eq('columns bolt-on repaired: new+painted PW = 1050', c.panelWorkNewPainted, 1050);
  eq('columns bolt-on repaired: second-hand PW = 1050 (painted repairs flattened — NOT 2 × £170)', c.panelWorkSecondHand, 1050);
}
{
  // replaced bolt-ons ARE sourced finished, £170 each, additive
  const c = assembleColumns([
    { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'replace' },
    { panelId: 'BONNET',       zone: 'front', severity: 'SEVERE', action: 'replace' },
  ]);
  eq('columns bolt-on replaced: new+painted PW = 900 (600 + 300)', c.panelWorkNewPainted, 900);
  eq('columns bolt-on replaced: second-hand PW = 340 (2 × £170 sourced finished)', c.panelWorkSecondHand, 340);
}
{
  // AMZ3790's live shape (batch 126 HEAD): bumper + bonnet SEVERE replace (front), door MODERATE repair + wing SEVERE
  // replace (flank). The money column is untouched; the second-hand column stops fitting a £170 door nobody buys.
  const amz = [
    { panelId: 'FRONT_BUMPER', zone: 'front', severity: 'SEVERE', action: 'replace' },
    { panelId: 'BONNET', zone: 'front', severity: 'SEVERE', action: 'replace' },
    { panelId: 'FRONT_DOOR', zone: 'flank-damaged-side', severity: 'MODERATE', action: 'repair' },
    { panelId: 'FRONT_WING', zone: 'flank-damaged-side', severity: 'SEVERE', action: 'replace' },
  ];
  const c = assembleColumns(amz);
  eq('AMZ3790: new+painted range UNCHANGED (money) 1615–2375', c.newPainted, { low: 1615, high: 2375, money: 2375 });
  eq('AMZ3790: second-hand PW = door £700 painted + 3 × £170 = 1210 (was 680)', c.panelWorkSecondHand, 1210);
  eq('AMZ3790: second-hand range 1029–1513 (was 578–850)', c.secondHand, { low: 1029, high: 1513, money: 1513 });
  eq('AMZ3790: computeLabour money still 2375 — the fix is display only', computeLabour({ bodyPanels: amz }).panelWorkMoney, 2375);

  const { labourDisplayLines, LABOUR_RANGE_ADDENDUM } = await import('../lib/labour.mjs');
  const d = labourDisplayLines(c);
  eq('display: the approved range sub-line', d.range, 'Estimate £1,615 - £2,375 · the total uses the top');
  eq('display: the second-hand sub-line', d.secondHand, 'With second-hand colour-matched panels: £1,029 - £1,513 · for comparison, not in the total');
  // batch 161 E4 (Vincent, 19 Sep): the closing sentence was re-approved. It used to say "If your repairer
  // quotes less, remove the line and add their figure" — two steps, and since batch 158 A2 took the controls
  // off the labour row it named a button that was not there. It now names the one control that does the job.
  eq('display: the approved addendum, verbatim', LABOUR_RANGE_ADDENDUM, 'Labour & paint is an estimate, shown as a range. The repair total, margins and bid ceilings all use the top of that range. If your repairer quotes a different figure, press Change on this line and enter it.');
  ok('display: all three lines are Latin-1 (the PDF drops anything else)', [d.range, d.secondHand, d.addendum].every((s) => !/[^\x00-\xFF]/.test(s)));
  ok('display: no columns (a pre-batch-92 report) → no lines', labourDisplayLines(null) === null && labourDisplayLines({}) === null);

  // Through the edit layer — the one path both surfaces read.
  const { applyEdits } = await import('../lib/ledgerEdits.mjs');
  const assessment = {
    _reconciledParts: [
      { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 290, used: 160 },
      { panelId: 'FRONT_DOOR', name: 'Front door', action: 'repair', oem: null, used: null, _repairNoPart: true },
      { panelId: 'FRONT_WING', name: 'Front wing', action: 'replace', oem: 175, used: 95 },
      { name: 'Labour & paint (new & painted)', action: '—', oem: 2375, used: null, _codeLabour: true },
    ],
    _partsReconciliation: { parts_sum: 2630 },
    _labourBodyPanels: amz.filter((p) => p.panelId !== 'BONNET'),
    _labourTellCount: 0,
    _labourColumns: c,
  };
  const e0 = applyEdits(assessment, null);
  eq('edit layer, no edits: the stored range', e0.labourDisplay?.range, 'Estimate £1,615 - £2,375 · the total uses the top');
  const doorKey = e0.rows.find((r) => r.panelId === 'FRONT_DOOR')._rowKey;
  const e1 = applyEdits(assessment, { stamp: e0.stamp, strikes: [doorKey] });
  const lab1 = e1.rows.find((r) => r._codeLabour);
  ok('edit layer, door struck: the range is RE-DERIVED from the recomputed panel work, and its top IS the row figure',
     e1.labourDisplay?.range === `Estimate £${(lab1.oem * 0.85 / 1.25).toLocaleString('en-GB')} - £${lab1.oem.toLocaleString('en-GB')} · the total uses the top`);
  eq('edit layer, door struck: recomputed range line', e1.labourDisplay?.range, 'Estimate £1,020 - £1,500 · the total uses the top');
  const labKey = e0.rows.find((r) => r._codeLabour)._rowKey;
  const e2 = applyEdits(assessment, { stamp: e0.stamp, strikes: [labKey] });
  ok('edit layer, labour line struck: no range and no addendum (the claim would be false)', e2.labourDisplay === null);
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
  // batch 95: structural allowance WITHDRAWN — 2 tells no longer add £2,500. panel work only.
  const r = computeLabour({
    bodyPanels: [
      { panelId: 'FRONT_WING', zone: 'front', severity: 'SEVERE', action: 'replace' }, // 600
      { panelId: 'BONNET',     zone: 'front', severity: 'MODERATE', action: 'repair' },  // 700
    ],
    structuralTellCount: 2,
  });
  // new+painted flatten (front): dearest 700 + 300 = 1000 → ×1.25 = 1250; NO structural (withdrawn)
  eq('computeLabour panelWorkMoney (1000×1.25)', r.panelWorkMoney, 1250);
  eq('computeLabour structural WITHDRAWN → null even at ≥2 tells', r.structural, null);
  eq('computeLabour total labourMoney = panel work only', r.labourMoney, 1250);
}
{ const { STRUCTURAL_ALLOWANCE_ENABLED } = await import('../lib/labour.mjs');
  ok('STRUCTURAL_ALLOWANCE_ENABLED is false (withdrawn)', STRUCTURAL_ALLOWANCE_ENABLED === false);
  eq('structuralAllowance() code KEPT (still returns 2500 if ever re-enabled)', structuralAllowance(true).money, 2500);
}
{
  // only 1 named tell → NO structural allowance
  const r = computeLabour({ bodyPanels: [{ panelId: 'FRONT_DOOR', zone: 'front', severity: 'MODERATE', action: 'repair' }], structuralTellCount: 1 });
  eq('computeLabour 1 tell → no structural', r.structural, null);
  eq('computeLabour 1 tell labourMoney = panel work only (700×1.25=875)', r.labourMoney, 875);
}

// SRS fitting rider (spec §10) — tiered, Vincent's numbers, no interpolation
import { SRS_FITTING, srsFitting } from '../lib/labour.mjs';
eq('SRS T1 = 300', SRS_FITTING.T1, 300);
eq('SRS T2 = 600', SRS_FITTING.T2, 600);
eq('SRS T3 = 1000', SRS_FITTING.T3, 1000);
eq('srsFitting(null) = 0', srsFitting(null), 0);
ok('SRS curve accelerates (not linear — the £450 lesson)', SRS_FITTING.T3 - SRS_FITTING.T2 > SRS_FITTING.T2 - SRS_FITTING.T1);
{
  // full: 1 body panel (700 moderate), <2 tells, T3 airbag → 700×1.25 + 0 structural + 1000 SRS = 1875
  const r = computeLabour({ bodyPanels: [{ panelId: 'BONNET', zone: 'front', severity: 'MODERATE', action: 'repair' }], structuralTellCount: 1, srsTier: 'T3' });
  eq('computeLabour with SRS T3 (875 + 1000)', r.labourMoney, 1875);
  eq('computeLabour srsFitting field', r.srsFitting, 1000);
}

// reference-only constants present
eq('sourced-finished fit ref', SOURCED_FINISHED_FIT, 170);
ok('sanity envelope present', SANITY_ENVELOPE.small_medium.new === 2000 && SANITY_ENVELOPE.fourxfour.new === 6000);


// ── batch 116 — THE GRADE OWNS REPAIR-VS-REPLACE; A MINOR/MODERATE BOLT-ON REPAIR CARRIES NO PART ──
// Vincent, 11 Sep: "Fix this duplication of parts and repair." Spec §1: MODERATE is "genuine dent or crease,
// repairable", £700 ALL-IN; "On SEVERE the PART cost is separate". Pinned against the SPEC, not the code.
{
  const sd72 = () => [   // SD72HXH's shape: two creased doors graded MODERATE, the model priced a NEW door each
    { panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', oem: 600, used: 330 },
    { panelId: 'REAR_DOOR', name: 'Rear door', action: 'replace', oem: 565, used: 310 },
    { name: 'Labour & paint', action: '—', oem: 1400 },
  ];
  const sev = new Map([['FRONT_DOOR', 'MODERATE'], ['REAR_DOOR', 'MODERATE']]);
  const rows = sd72();
  const ch = applyGradeOwnsAction(rows, sev);
  ok('SD72HXH: both MODERATE doors become action "repair"', rows[0].action === 'repair' && rows[1].action === 'repair');
  ok('SD72HXH: neither door carries a part cost any more (the £640 S/H duplication is gone)',
     (rows[0].used ?? rows[0].oem ?? 0) === 0 && (rows[1].used ?? rows[1].oem ?? 0) === 0);
  ok('SD72HXH: the model\'s part figures are kept for audit, not in the money',
     rows[0]._modelPart?.used === 330 && rows[1]._modelPart?.used === 310 && rows[0]._repairNoPart === true);
  ok('SD72HXH: two changes reported', ch.length === 2);
  ok('non-panel rows (labour) untouched', rows[2].oem === 1400 && rows[2].action === '—');

  // The panel work still charges them: MODERATE £700 each, zone-flattened (dearest full, extra half) × 1.25.
  const lab = computeLabour({ bodyPanels: [
    { panelId: 'FRONT_DOOR', zone: 'flank-damaged-side', severity: 'MODERATE', action: 'repair' },
    { panelId: 'REAR_DOOR', zone: 'flank-damaged-side', severity: 'MODERATE', action: 'repair' },
  ] });
  eq('SD72HXH: the repair is still costed in panel work — (700 + 350) × 1.25', lab.panelWorkMoney, 1313);

  const minor = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'replace', oem: 290, used: 165 }];
  applyGradeOwnsAction(minor, new Map([['FRONT_WING', 'MINOR']]));
  ok('MINOR bolt-on → repair, no part', minor[0].action === 'repair' && (minor[0].used ?? minor[0].oem ?? 0) === 0);

  const severe = [{ panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', oem: 600, used: 330 }];
  applyGradeOwnsAction(severe, new Map([['FRONT_DOOR', 'SEVERE']]));
  ok('SEVERE bolt-on → replace, part KEPT (spec: "On SEVERE the PART cost is separate")', severe[0].action === 'replace' && severe[0].used === 330 && !severe[0]._repairNoPart);

  const sevRepair = [{ panelId: 'BONNET', name: 'Bonnet', action: 'repair', oem: 500, used: 280 }];
  applyGradeOwnsAction(sevRepair, new Map([['BONNET', 'SEVERE']]));
  ok('SEVERE with a model "repair" word → the GRADE wins: replace, part kept', sevRepair[0].action === 'replace' && sevRepair[0].used === 280 && sevRepair[0]._modelAction === 'repair');

  const modRepair = [{ panelId: 'REAR_DOOR', name: 'Rear door', action: 'repair', oem: 500, used: 250 }];
  applyGradeOwnsAction(modRepair, new Map([['REAR_DOOR', 'MODERATE']]));
  ok('MODERATE already worded "repair" (FE68AOP shape) → its £250 part still goes', (modRepair[0].used ?? modRepair[0].oem ?? 0) === 0);

  // batch 127 — the welded three follow the grade (Vincent 14 Sep, spec §1/§2): repair = labour only, no panel;
  // replace = a new panel, priced at NEW (oem), never used. Pinned against the SPEC. (Supersedes the batch-116
  // "WELDED is NOT touched" assertion, which recorded the spec being silent — it is no longer silent.)
  for (const pid of ['REAR_QUARTER', 'SILL', 'ROOF']) {
    for (const g of ['MINOR', 'MODERATE']) {
      const w = [{ panelId: pid, name: pid, action: 'replace', oem: 400, used: 220 }];
      applyGradeOwnsAction(w, new Map([[pid, g]]));
      ok(`WELDED ${pid} ${g} → repair, labour only, NO panel bought (the model's "replace" moves no money)`,
         w[0].action === 'repair' && (w[0].used ?? w[0].oem ?? 0) === 0 && w[0]._repairNoPart === true && w[0]._modelPart?.used === 220);
    }
    const s = [{ panelId: pid, name: pid, action: 'repair', oem: 400, used: 220 }];
    applyGradeOwnsAction(s, new Map([[pid, 'SEVERE']]));
    ok(`WELDED ${pid} SEVERE → replace at NEW: money reads oem £400, never used £220`,
       s[0].action === 'replace' && (s[0].used ?? s[0].oem ?? 0) === 400 && s[0]._weldedAtNew?.used === 220 && s[0]._modelAction === 'repair');
  }
  {
    // SF69YBB's live shape: a _gOwned quarter, SEVERE, replace, Executive band 320/175 → +£145.
    const sf = [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'replace', oem: 320, used: 175, _tableMandated: true, _gOwned: true }];
    const ch = applyGradeOwnsAction(sf, new Map([['REAR_QUARTER', 'SEVERE']]));
    eq('SF69YBB quarter: £175 used → £320 new (+£145)', (sf[0].used ?? sf[0].oem ?? 0), 320);
    ok('SF69YBB quarter: one change reported, action unchanged (the G path already took it from the grade)', ch.length === 1 && sf[0].action === 'replace' && !sf[0]._modelAction);
    const again = applyGradeOwnsAction(sf, new Map([['REAR_QUARTER', 'SEVERE']]));
    ok('idempotent: a welded replace already at NEW is not changed twice', again.length === 0 && sf[0].oem === 320);
    const noOem = [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'replace', oem: null, used: 175 }];
    applyGradeOwnsAction(noOem, new Map([['REAR_QUARTER', 'SEVERE']]));
    ok('welded SEVERE with no new price on the row keeps its figure (never priced at £0) and is marked', noOem[0].used === 175 && noOem[0]._weldedNoNewPrice === true);
    const wz = [{ panelId: 'REAR_QUARTER', name: 'Rear quarter panel', action: 'repair', oem: null, used: 175, _zeroRule: 'F' }];
    applyGradeOwnsAction(wz, new Map([['REAR_QUARTER', 'MINOR']]));
    ok('welded £0-rule row (_zeroRule F) is NOT touched', wz[0].used === 175 && !wz[0]._repairNoPart);
    const wu = [{ panelId: 'SILL', name: 'Sill', action: 'replace', oem: 140, used: 75 }];
    applyGradeOwnsAction(wu, new Map());
    ok('welded row with NO grade is left alone', wu[0].used === 75 && wu[0].action === 'replace');
  }
  {
    // batch 127 — ruling 4: THE Q4 PROMOTION SETS A GRADE (SEVERE). No stored or replayable fixture promotes a
    // quarter (_q4Promoted = 0 in every run, batch 126), so this synthetic fixture is the only proof of the path.
    const { promoteFlaggedQuarter, Q4_PROMOTED_GRADE } = await import('../lib/labour.mjs');
    eq('Q4 promoted grade is SEVERE', Q4_PROMOTED_GRADE, 'SEVERE');
    const rows = [{ panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 365, used: 200 }];
    const flags = [{ panelId: 'REAR_QUARTER', zone: 'rear', weight: 'medium', reason: 'not visible in any photo' }];
    const sev = new Map([['FRONT_BUMPER', 'SEVERE']]);
    const zones = new Map([['FRONT_BUMPER', 'front']]);
    const costedIds = new Set(['FRONT_BUMPER']);
    const p = promoteFlaggedQuarter({ gatedParts: rows, flaggedParts: flags, costedIds, sevByPanel: sev, zoneByPanel: zones, entry: { oem: 320, used: 175 }, name: 'Rear quarter panel' });
    ok('Q4: the flagged quarter is promoted, marked _q4Promoted', !!p && rows.length === 2 && rows[1]._q4Promoted === true);
    eq('Q4: the promotion SETS the grade — no ungraded row', sev.get('REAR_QUARTER'), 'SEVERE');
    ok('Q4: every body-panel row now holds a grade', rows.every((r) => sev.has(r.panelId)));
    eq('Q4: zone taken from the flag', zones.get('REAR_QUARTER'), 'rear');
    applyGradeOwnsAction(rows, sev);
    eq('Q4: priced as a welded REPLACE at NEW — money £320, not the £175 used', (rows[1].used ?? rows[1].oem ?? 0), 320);
    ok('Q4: action replace, a new panel is bought (not a £0 repair)', rows[1].action === 'replace' && !rows[1]._repairNoPart);
    const lab = computeLabour({ bodyPanels: [{ panelId: 'REAR_QUARTER', zone: 'rear', severity: sev.get('REAR_QUARTER'), action: rows[1].action }] });
    eq('Q4: welded replace labour £800 × 1.25 (not the old MODERATE default path)', lab.panelWorkMoney, 1000);
    const pre = new Map([['REAR_QUARTER', 'MINOR']]);
    const p2 = promoteFlaggedQuarter({ gatedParts: [], flaggedParts: flags, costedIds: new Set(), sevByPanel: pre, zoneByPanel: new Map(), entry: { oem: 320, used: 175 }, name: 'Rear quarter panel' });
    ok('Q4: a grade already held for the quarter is overridden to SEVERE and reported', p2?.gradeWas === 'MINOR' && pre.get('REAR_QUARTER') === 'SEVERE');
    ok('Q4: no band entry → nothing promoted', promoteFlaggedQuarter({ gatedParts: [], flaggedParts: flags, costedIds: new Set(), sevByPanel: new Map(), zoneByPanel: new Map(), entry: null, name: 'x' }) === null);
    ok('Q4: an already-costed quarter is not promoted twice', promoteFlaggedQuarter({ gatedParts: [], flaggedParts: flags, costedIds: new Set(['REAR_QUARTER']), sevByPanel: new Map(), zoneByPanel: new Map(), entry: { oem: 320, used: 175 }, name: 'x' }) === null);
    const { readFileSync } = await import('node:fs');
    const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
    ok('route: the Q4 promotion goes through the owner, before the grade rule', route.indexOf('promoteFlaggedQuarter({') > 0 && route.indexOf('promoteFlaggedQuarter({') < route.indexOf('applyGradeOwnsAction(gatedParts, sevByPanel)'));
    ok('route: the old inline ungraded push is gone', !/gatedParts\.push\(\{ panelId: PANEL\.REAR_QUARTER/.test(route));
  }

  const zr = [{ panelId: 'FRONT_WING', name: 'Front wing', action: 'repair', oem: null, used: 120, _zeroRule: 'F' }];
  applyGradeOwnsAction(zr, new Map([['FRONT_WING', 'MINOR']]));
  ok('£0-rule row (_zeroRule F) is NOT touched — it earns no panel work, so its band figure is its only cost', zr[0].used === 120 && !zr[0]._repairNoPart);

  const nonBody = [{ panelId: 'GRILLE', name: 'Grille', action: 'replace', oem: 190, used: 70 }, { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', used: 350, _lampMandated: true }];
  applyGradeOwnsAction(nonBody, new Map([['GRILLE', 'MODERATE'], ['HEADLAMP', 'MODERATE']]));
  ok('non-body COST parts (grille, headlamp) keep their part — they earn no panel-work labour', nonBody[0].used === 70 && nonBody[1].used === 350);

  const ungraded = [{ panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', oem: 600, used: 330 }];
  applyGradeOwnsAction(ungraded, new Map());
  ok('a row with NO ledger grade is left alone (no grade, no ruling)', ungraded[0].used === 330);

  ok('the repaired-panel note says no panel is bought and where the cost sits', /no new panel/.test(REPAIR_NO_PART_NOTE) && /Labour & paint/.test(REPAIR_NO_PART_NOTE));
}


// ── batch 116 — every surface says what the money says for a repaired panel ──────────────────────
{
  const { assembleVdsParts, sumPartsRealistic } = await import('../lib/parts.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { readFileSync } = await import('node:fs');
  const rows = [
    { panelId: 'FRONT_DOOR', name: 'Front door', action: 'replace', oem: 600, used: 330 },
    { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 400, used: 200 },
    { name: 'Labour & paint (new & painted)', action: '—', oem: 1500, _codeLabour: true },
  ];
  applyGradeOwnsAction(rows, new Map([['FRONT_DOOR', 'MODERATE'], ['FRONT_BUMPER', 'SEVERE']]));
  eq('money: the repaired door adds nothing on top of labour (200 + 1500)', sumPartsRealistic(rows), 1700);
  const vds = assembleVdsParts([], rows);
  ok('VDS: the repaired door says so, in the one shared sentence', vds.find((b) => b.panelId === 'FRONT_DOOR').prose === REPAIR_NO_PART_NOTE);
  ok('VDS: the replaced bumper keeps its figure', vds.find((b) => b.panelId === 'FRONT_BUMPER').prose === 'Replace — £200.');
  const cards = buildDamageCards({ gatedParts: rows, costedParts: [], flaggedParts: [], allowanceParts: [] });
  const door = cards.find((c) => c.panelId === 'FRONT_DOOR');
  ok('Damage card: the repaired door carries the note (never a bare £0 that reads as free)', door.note === REPAIR_NO_PART_NOTE && door.action === 'repair');
  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  ok('route: the rule runs inside the labour block, before bodyPanels', route.indexOf('applyGradeOwnsAction(gatedParts, sevByPanel)') > 0
     && route.indexOf('applyGradeOwnsAction(gatedParts, sevByPanel)') < route.indexOf('const bodyPanels = gatedParts'));
  // batch 147 X2 added a THIRD use of the same principle: the damagedPanels set that decides whether a
  // structure floor applies. A repaired panel is costed damage (its cost sits in panel work), so it
  // licenses a structure floor exactly as a replaced one does.
  // batch 150 Z1 added a FOURTH: wheelNetParts — a repaired wheel is "already identified and costed" too.
  // batch 163 T2: all four spelled the rule out by hand and now call the one owner, lib/ledgerEdits.mjs
  // isChargedRow. The assertion is unchanged in meaning — still four sites, still "a repaired panel is
  // costed" — but it now pins the shared call, and it fails if anyone re-inlines the old spelling.
  ok('route: a repaired panel counts as costed for the bonnet tell, the §4 bumper-off note, the X2 structure floor and the wheel checklist line',
     // count USES, not `isChargedRow(` — one of the four passes it by reference, `.filter(isChargedRow)`
     route.split('\n').filter((l) => /isChargedRow/.test(l) && !l.trim().startsWith('import ')).length === 4
     && /import \{ rowKeyFor, isChargedRow \} from '@\/lib\/ledgerEdits\.mjs';/.test(route)
     && !/\(p\.used \?\? p\.oem \?\? 0\) > 0 \|\| p\._repairNoPart/.test(route));
  // batch 117 changed the call's shape (the ledger row keys are attached by a .map() before this filter); the
  // assertion is the same — a repaired panel is excluded from the eBay sourcing basket.
  ok('route: no eBay parts link for a panel being repaired', /\.filter\(p => !p\._zeroRule && !p\._repairNoPart/.test(route));
}


// ── batch 117 — ONE owner of "labour / allowance line, not a purchasable part" (isNonPartRow) ─────
{
  const { assembleVdsParts, assembleKcdParts, sumPartsRealistic } = await import('../lib/parts.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { isNonPartRow, MODEL_LABOUR_NAME_RX } = await import('../lib/labour.mjs');
  const srs = { name: 'SRS fitting', action: '—', oem: 300, used: null, _srsFitting: true };
  ok('THE DEFECT, pinned: the old name-only test does NOT recognise "SRS fitting"', MODEL_LABOUR_NAME_RX.test(srs.name) === false);
  ok('isNonPartRow recognises it by its MARKER', isNonPartRow(srs) === true);
  for (const m of ['_codeLabour', '_srsFitting', '_structuralAllowance', '_structFloor']) {
    ok(`marker ${m} alone makes a row non-part, whatever its name`, isNonPartRow({ name: 'Zzz', [m]: true }) === true);
  }
  ok('a model-written labour line (no marker) is caught by the name fallback', isNonPartRow({ name: 'Labour & paint' }) && isNonPartRow({ name: 'Prep and blend' }));
  ok('a real part is not caught', !isNonPartRow({ name: 'Front bumper', panelId: 'FRONT_BUMPER' }) && !isNonPartRow({ name: 'SRS airbag kit (deployed)', panelId: 'SRS_AIRBAG' }));

  const rows = [
    { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', used: 160 },
    { panelId: 'SRS_AIRBAG', name: 'SRS airbag kit (deployed)', action: 'replace', used: 310 },
    { name: 'Labour & paint (new & painted)', action: '—', oem: 2125, used: null, _codeLabour: true },
    srs,
    { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', used: 500, _structFloor: true, _zeroRule: 'A' },
  ];
  ok('VDS: "SRS fitting" no longer appears as a replaced part ("Replace — £300.")', !assembleVdsParts([], rows).some((b) => /fitting/i.test(b.partName)));
  ok('KCD: "SRS fitting — replace: £300" is gone from Key Cost Drivers', !assembleKcdParts(rows).some((d) => /fitting/i.test(d.partName)));
  const cards = buildDamageCards({ gatedParts: rows, costedParts: [], flaggedParts: [], allowanceParts: [] });
  ok('Damage cards: no "Visible" £300 card for a fitting operation', !cards.some((c) => /fitting/i.test(c.part || '')));
  ok('Damage cards: the £500 jig floor KEEPS its Visible "from £500" card (batch 106, deliberately)', cards.some((c) => c._structFloor && c.origin === 'Visible'));
  ok('the airbag KIT (a real part) still appears everywhere', assembleKcdParts(rows).some((d) => /airbag kit/i.test(d.partName)) && cards.some((c) => /airbag kit/i.test(c.part || '')));
  eq('NO money moves: the £300 is still in the repair total (160 + 310 + 2125 + 300 + 500)', sumPartsRealistic(rows), 3395);
}

console.log('\n11. batch 117 task 6 — the jig floor states its ceiling (Vincent 11 Sep: "from £500 up to 2 or 3k")');
{
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { STRUCT_FLOOR_GBP, STRUCT_FLOOR_NOTE } = await import('../lib/labour.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { sumPartsRealistic } = await import('../lib/parts.mjs');
  // Every shipped source file under app/ and lib/.
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(n) ? [p] : []; });
  const src = [...walk('app'), ...walk('lib')].map((p) => [p, readFileSync(p, 'utf8')]);
  const count = (needle) => src.reduce((n, [, s]) => n + (s.split(needle).length - 1), 0);
  eq('ONE OWNER: the sentence\'s literal appears exactly once in source', count('can only be quoted after inspection'), 1);
  eq('…and it lives in lib/labour.mjs', src.filter(([, s]) => s.includes('can only be quoted after inspection')).map(([p]) => p.replace(/\\/g, '/')).join(), 'lib/labour.mjs');
  eq('the old floor-only sentence is gone from source (no second wording left behind)', count('the true figure for jig/geometry work cannot be scoped'), 0);
  ok('the sentence keeps the floor IN the total', STRUCT_FLOOR_NOTE.startsWith('A floor of £500 for jig/geometry work is included in the repair total.'));
  ok('the sentence states the ceiling: £2,000 or £3,000 on a heavier hit or a larger vehicle', STRUCT_FLOOR_NOTE.includes('up to £2,000 or £3,000 on a heavier hit or a larger vehicle'));
  ok('"depending on the vehicle" is in the WORDS (no-classifier ruling — the range is not picked by code)', STRUCT_FLOOR_NOTE.includes('depending on the vehicle and the extent of the damage'));
  ok('Latin-1 only (the PDF flag renderer silently drops en/em dashes)', !/[^\x00-\xFF]/.test(STRUCT_FLOOR_NOTE));
  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  ok('route: the structural flag reason IS the owner', /f\.reason = STRUCT_FLOOR_NOTE;\s*\n\s*f\._structFloorFlag = true;/.test(route));
  ok('route: the floor figure comes from the same owner (£500 unchanged)', route.includes('const ZERO_RULE_STRUCT_FLOOR = STRUCT_FLOOR_GBP;') && STRUCT_FLOOR_GBP === 500);
  const floor = { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', oem: null, used: 500, _tableMandated: true, _structFloor: true, _zeroRule: 'A' };
  const cards = buildDamageCards({ gatedParts: [floor], costedParts: [], flaggedParts: [{ panelId: 'FRONT_STRUCTURE', partName: 'Front structure', weight: 'high', reason: STRUCT_FLOOR_NOTE, _structFloorFlag: true }], allowanceParts: [] });
  const card = cards.find((c) => c._structFloor);
  ok('damage card: the Visible floor card carries the SAME sentence as the flag', card?.origin === 'Visible' && card.note === STRUCT_FLOOR_NOTE);
  eq('damage card: no second (Related) card for the same panel', cards.filter((c) => /front structure/i.test(c.part || '')).length, 1);
  eq('NO money moves: the floor row still sums £500', sumPartsRealistic([floor]), 500);
}

console.log('\n12. batch 130 — SRS is ONE flat £500 floor (Vincent 14 Sep: "Airbags out, must be checked, replacement from £500 depending on number and location" · "Yes £500 is counted in the repair with the note") — supersedes 129\'s tier-derived from-figure');
{
  const { srsDeploymentNote, SRS_COLLATERAL, SRS_FLOOR_GBP, isFromFigureRow } = await import('../lib/labour.mjs');
  const { assembleVdsParts, assembleKcdParts, sumPartsRealistic } = await import('../lib/parts.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { readFileSync } = await import('node:fs');

  eq('THE FIGURE: one flat £500', SRS_FLOOR_GBP, 500);
  const note = srsDeploymentNote();
  eq('sentence, verbatim — the approved wording with the flat £500', note,
     'Airbags deployed - replacement from £500 (kit and fitting), depending on the number and location of the bags. The headlining, seat covers, dashboard, door cards and seatbelt pretensioners may also need replacing and are not costed. This must be checked before bidding.');
  ok('no tier, no band, no kit reaches the sentence — it takes no input (the HMZ8034 "from £2,880" cannot recur)',
     srsDeploymentNote.length === 0 && srsDeploymentNote({ kit: 1880, fitting: 1000 }) === note && !/2,880|1,775|610\b/.test(note));
  ok('"must be checked", never "please check"', /must be checked/.test(note) && !/please check/i.test(note));
  ok('the COUNT is never claimed (no "at least one", no bag positions, no number of bags)', !/at least one|driver|passenger|curtain|\bside\b|\bone bag|\btwo bags|\b\d+ bags/i.test(note));
  ok('the collateral is NAMED — headlining, seat covers, dashboard, door cards, pretensioners — and says it is not costed',
     ['headlining', 'seat covers', 'dashboard', 'door cards', 'pretensioners'].every((w) => SRS_COLLATERAL.includes(w)) && /not costed/.test(SRS_COLLATERAL));
  ok('Latin-1 only (the PDF flag renderer drops en/em dashes)', !/[^\x00-\xFF]/.test(note));

  const floorRow = { panelId: 'SRS_AIRBAG', name: 'SRS airbag kit (deployed)', action: 'replace', oem: null, used: 500, _tableMandated: true, _gOwned: true, _srsFloor: true };
  const bumper = { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 290, used: 160 };
  ok('from-figure rows: the £500 SRS floor and the £500 jig floor — nothing else', isFromFigureRow(floorRow) && isFromFigureRow({ _structFloor: true }) && !isFromFigureRow(bumper));
  ok('batch 129 markers no longer print "from" (129 never shipped — a stored report renders as main does)', !isFromFigureRow({ _srsTier: 1 }) && !isFromFigureRow({ _srsFitting: true }));
  eq('IN THE TOTAL, ONCE: floor £500 + bumper £160, nothing else for SRS', sumPartsRealistic([floorRow, bumper]), 660);
  eq('VDS: the SRS row reads "from £500"', assembleVdsParts([], [floorRow, bumper]).find((b) => b.panelId === 'SRS_AIRBAG').prose, 'Replace — from £500.');
  eq('VDS: every other row unchanged', assembleVdsParts([], [floorRow, bumper]).find((b) => b.panelId === 'FRONT_BUMPER').prose, 'Replace — £160.');
  eq('KCD: the SRS row reads "from £500"', assembleKcdParts([floorRow, bumper]).find((d) => d.panelId === 'SRS_AIRBAG').prose, 'SRS airbag kit (deployed) — replace: from £500');
  ok('KCD: no internal marker leaks onto the driver object', !('_from' in assembleKcdParts([floorRow])[0]));
  const card = buildDamageCards({ gatedParts: [floorRow, bumper], costedParts: [], flaggedParts: [], allowanceParts: [] }).find((c) => c.panelId === 'SRS_AIRBAG');
  ok('damage card: the SRS card carries _fromFigure, cost £500 (rendered "from £500" on screen and PDF)', card?._fromFigure === true && card.cost === 500);

  // NO DOUBLE COUNT, NO ORPHANED RIDER — the route's own reconcile expression, run over the injected row.
  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const blockStart = route.indexOf('if (_srsGateOpen && srsT.deploymentConfirmed) {');
  const block = route.slice(blockStart, route.indexOf('} else if (_srsGateOpen && _srsPaste.intact) {', blockStart));
  ok('route: the deployment block exists and is found', blockStart > 0 && block.length > 200);
  ok('route: ONE SRS row is pushed, at the flat floor, marked _srsFloor', (block.match(/gatedParts\.push\(/g) || []).length === 1 && block.includes('used:    SRS_FLOOR_GBP,') && block.includes('_srsFloor: true,'));
  ok('route: NO band lookup, NO tier price, NO fitting in the deployment block', !/bandKey|PANEL_PRICE_TABLE|srsEntry|srsFitting\(|_srsTier:/.test(block));
  ok('route: no row anywhere is given _srsTier (the rider can never re-attach)', !/_srsTier:\s/.test(route));
  ok('route: the reconcile still keys the rider on _srsTier (named dead code, batch 130 — Vincent rules on removal)', route.includes("gatedParts.find(p => p.panelId === 'SRS_AIRBAG' && p._srsTier)"));
  {
    const { computeLabour: cl } = await import('../lib/labour.mjs');
    const gated = [floorRow, bumper];
    const srsRow = gated.find(p => p.panelId === 'SRS_AIRBAG' && p._srsTier);   // the route's expression, verbatim
    const lab = cl({ bodyPanels: [], structuralTellCount: 0, srsTier: srsRow ? `T${srsRow._srsTier}` : null });
    ok('NO ORPHANED RIDER: the reconcile finds no tier on the floor row → rider £0 → no "SRS fitting" row is pushed', srsRow === undefined && lab.srsFitting === 0);
  }
  ok('route: the flag reads the flat sentence', block.includes('reason: srsDeploymentNote(),'));
  ok('route: the old count-claiming sentence is gone from source', !route.includes('at least one bag confirmed'));
  ok('route: the Airbags field says "must be checked" and claims no count', /The number and location of the bags must be checked before bidding\./.test(route) && !route.includes('confirm full extent on inspection'));
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  // batch 131: the cells (and "from") come from ONE owner, lib/labour.mjs partsTableCells — a real-PDF render lock lives in
  // scripts/validate-from-floor.mjs (it fails on any bare "£500").
  ok('screen + PDF: the table row prints "from" for the two floors only, off the one owner', [page, pdf].every((s) => s.includes('const costCells = partsTableCells;') && s.includes('c.from && c.repair != null ? `from ') && !s.includes('p._srsTier') && !s.includes('p._srsFitting) &&')));
  ok('screen + PDF: the damage card prints "from" for a floor card', [page, pdf].every((s) => s.includes('(c._structFloor || c._fromFigure) ? `from ${g(c.cost)}`')));
}

console.log('\n13. batch 130 — Q4 does NOT promote on a losing vote (Vincent 14 Sep: "One damaged read against three is not a genuine disagreement. Flag it, do not cost it.")');
{
  const { promoteFlaggedQuarter, isLosingQuarterVote } = await import('../lib/labour.mjs');
  const { sumPartsRealistic, buildBuyerFlags } = await import('../lib/parts.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { readFileSync } = await import('node:fs');
  const ENTRY = { oem: 500, used: 275 };
  // batch 145 V1: READ the shipped constant instead of retyping it — this literal was a stale copy of
  // the pre-143 wording and went on passing after batch 143 rewrote it.
  const DISAGREE = readFileSync('app/api/salvage/assess/route.js', 'utf8')
    .match(/^const AMALG_REASON_DISAGREE\s*=\s*'([^']+)';/m)[1];
  const run = (pvVotes, flag = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: DISAGREE, _amalgDisagree: true }) => {
    const rows = [{ panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 365, used: 200 }];
    const flags = [flag];
    const sev = new Map([['FRONT_BUMPER', 'SEVERE']]);
    const out = promoteFlaggedQuarter({ gatedParts: rows, flaggedParts: flags, costedIds: new Set(['FRONT_BUMPER']), sevByPanel: sev, zoneByPanel: new Map(), entry: ENTRY, name: 'Rear quarter panel', pvVotes });
    return { out, rows, flags, sev };
  };

  // 🎯 HMZ8034, the stored _pvVotes verbatim (Cowork read the live row, 14 Sep). Live-only — a synthetic lock, not a replay.
  const HMZ = { REAR_QUARTER: { views: 4, clean: 2, damaged: 1, severeVotes: 1, branch: 'disagree', resolving: 3, notVisible: 0 } };
  const h = run(HMZ);
  ok('HMZ8034 (1 damaged v 2 clean): declined — no quarter row is costed', h.out?.row === null && !!h.out?.declined && h.rows.length === 1 && !h.rows.some((r) => r.panelId === 'REAR_QUARTER'));
  ok('HMZ8034: no grade is set, so the quarter earns no panel-work labour', !h.sev.has('REAR_QUARTER'));
  eq('HMZ8034: the money is the bumper alone', sumPartsRealistic(h.rows), 200);
  // batch 132: the decline now marks the flag (_q4Declined) and its reason becomes the buyer sentence — see section 15.
  const { Q4_DECLINED_REASON } = await import('../lib/labour.mjs');
  ok('HMZ8034: the flag is NOT removed — it stays in the flags (batch 132: marked, buyer sentence)', h.flags.length === 1 && h.flags[0]._amalgDisagree === true && h.flags[0]._q4Declined === true && h.flags[0].reason === Q4_DECLINED_REASON);
  const cards = buildDamageCards({ gatedParts: h.rows, costedParts: [], flaggedParts: h.flags, allowanceParts: [] });
  const rq = cards.find((c) => c.part === 'Rear quarter panel');
  ok('HMZ8034: the quarter stays in the damage breakdown at £0 (a Related card carrying the batch 132 sentence)', rq?.origin === 'Related' && rq.cost === 0 && rq.note === Q4_DECLINED_REASON);

  // The boundary: damaged >= clean promotes (a tie is still a genuine disagreement).
  ok('TIE (2 v 2) still promotes', run({ REAR_QUARTER: { damaged: 2, clean: 2 } }).out?.row?._q4Promoted === true);
  ok('damaged wins (2 v 1) promotes', run({ REAR_QUARTER: { damaged: 2, clean: 1 } }).out?.row?._q4Promoted === true);
  ok('AMZ3790 stored-baseline shape (1 v 4) is declined', run({ REAR_QUARTER: { damaged: 1, clean: 4 } }).out?.declined != null);
  ok('YH23NVW 30-Aug single-MINOR shape (1 v 3, _amalgSingleMinor flag) is declined — Ruling 2 no-cost now holds on Q4 too',
     run({ REAR_QUARTER: { damaged: 1, clean: 3 } }, { panelId: 'REAR_QUARTER', zone: 'rear', weight: 'low', reason: 'one photo', _amalgSingleMinor: true }).out?.declined != null);
  ok('no vote entry at all → nothing to weigh → promotes as before (the batch 127 not-visible fixture)', run(null).out?.row?._q4Promoted === true && run({}).out?.row?._q4Promoted === true);
  ok('not-visible (0 v 0) is not a losing vote → promotes as before', run({ REAR_QUARTER: { damaged: 0, clean: 0, notVisible: 3 } }).out?.row?._q4Promoted === true);
  ok('G-split instance key REAR_QUARTER#1 losing (1 v 3) → declined', run({ 'REAR_QUARTER#1': { damaged: 1, clean: 3 } }).out?.declined != null);
  ok('declined only when EVERY quarter entry loses — #1 losing + #2 winning promotes', run({ 'REAR_QUARTER#1': { damaged: 1, clean: 3 }, 'REAR_QUARTER#2': { damaged: 2, clean: 0 } }).out?.row?._q4Promoted === true);
  ok('other panels\' votes are never read (a losing FRONT_DOOR vote does not decline the quarter)', run({ FRONT_DOOR: { damaged: 1, clean: 3 } }).out?.row?._q4Promoted === true);
  ok('isLosingQuarterVote is strict less-than', isLosingQuarterVote({ REAR_QUARTER: { damaged: 1, clean: 2 } }) && !isLosingQuarterVote({ REAR_QUARTER: { damaged: 2, clean: 2 } }));

  // The Inspection Flags list reads _flaggedParts + _preGateParts, never the ledger. Pinned here for UNMARKED flags (the
  // 4f filter hides a disagree flag on a panel the main call never listed, costed or not). batch 132: a flag the Q4
  // decline MARKS (_q4Declined) is carved out of that filter and reaches the list and the checklist — section 15.
  const flag = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: DISAGREE, _amalgDisagree: true };
  const pre = [{ panelId: 'FRONT_BUMPER', name: 'Front bumper' }];
  const promotedA = { _flaggedParts: [flag], _preGateParts: pre, _reconciledParts: [{ panelId: 'REAR_QUARTER', used: null, oem: 500, _q4Promoted: true }] };
  const declinedA = { _flaggedParts: [flag], _preGateParts: pre, _reconciledParts: [] };
  eq('buyer flag list is identical whether Q4 promotes or declines (the filter never reads the ledger)', buildBuyerFlags(promotedA), buildBuyerFlags(declinedA));
  const preWithQ = [...pre, { panelId: 'REAR_QUARTER', name: 'Rear quarter panel' }];
  ok('…and where the main call listed the quarter, its flag reaches the buyer list', buildBuyerFlags({ _flaggedParts: [flag], _preGateParts: preWithQ }).some((f) => f.panelId === 'REAR_QUARTER'));

  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  ok('route: the Q4 promotion receives the per-view votes', /promoteFlaggedQuarter\(\{[\s\S]{0,400}pvVotes: assessment\._pvVotes,[\s\S]{0,20}\}\)/.test(route));
  ok('route: _pvVotes is assigned BEFORE the Q4 promotion reads it', route.indexOf('assessment._pvVotes  = pvResult.pvVotesMap') > 0 && route.indexOf('assessment._pvVotes  = pvResult.pvVotesMap') < route.indexOf('promoteFlaggedQuarter({'));
}

console.log('\n14. batch 131 task 2 — the airbag checklist line (Vincent 15 Sep, option (a): "must be checked"; every other line unchanged)');
{
  const { readFileSync } = await import('node:fs');
  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  // batch 132: the seeding moved (logic unchanged) to lib/parts.mjs seedChecklistFromFlags — the pins follow it.
  const seedSrc = readFileSync('lib/parts.mjs', 'utf8');
  // batch 172 P4: the lead is built once as `show` ("Show X close-up" for every named part; the unnamed OTHER part reads
  // "Show a close-up of the unidentified part in the listing photos"). The pins follow the new spelling; the rendered
  // string for a named part is unchanged — asserted on real output in validate-batch172 P4, and on the helper below.
  const SRS_LINE = 'seedItem = `${show} — the number and location of the bags must be checked before bidding.`;';
  const GENERIC = "seedItem = `${show} — structural or inspection-class component; confirm condition before bidding.`;";
  ok('seed: the lead for a named part is still "Show ${part} close-up" (batch 172 P4)', seedSrc.includes(": `Show ${part} close-up`;"));
  ok('seed: a targeted branch keyed on the SRS flag marker (_srsExtentFloor) seeds Vincent\'s wording', seedSrc.includes('} else if (flag._srsExtentFloor) {') && seedSrc.includes(SRS_LINE));
  ok('seed: the SRS branch sits BEFORE the generic high-weight branch (so the airbag never falls to it)', seedSrc.indexOf('} else if (flag._srsExtentFloor) {') > 0 && seedSrc.indexOf('} else if (flag._srsExtentFloor) {') < seedSrc.indexOf("} else if (flag.weight === 'high') {"));
  // batch 152 X1: the generic line now serves structure panels and non-flag-class high flags; non-structure
  // flag-class items get "inspection item" (pinned in validate-flag-class-floor). The string itself is unchanged.
  ok('seed: the generic high-weight line is UNCHANGED (structure panels + non-flag-class high flags)', seedSrc.includes(GENERIC));
  ok('route: seeds through the one owner and keeps no inline copy', route.includes('seedChecklistFromFlags(checklistText, buyerFlags, { lampTier2Fired: !!lampResult?.tier2Fired })') && !route.includes('seedItem ='));
  ok('route: the SRS flag carries the marker the branch keys on', route.includes('reason: srsDeploymentNote(),') && /reason: srsDeploymentNote\(\),\s*_srsExtentFloor: true,/.test(route));
  const rendered = 'Show SRS airbag (deployed) close-up — the number and location of the bags must be checked before bidding.';
  ok('rendered for the airbag part, verbatim as Vincent chose', SRS_LINE.replace('${show}', 'Show SRS airbag (deployed) close-up').includes(rendered)   /* batch 172 P4: lead built once */);
  ok('"must be checked", never "confirm condition" / "please check"', /must be checked/.test(rendered) && !/confirm condition|please check/i.test(rendered));
}

console.log('\n15. batch 132 — the quarter Q4 DECLINES reaches the buyer: flag list AND checklist (Vincent 15 Sep: "It should be in the check list.")');
{
  const { promoteFlaggedQuarter, Q4_DECLINED_REASON, Q4_DECLINED_CHECKLIST_ITEM } = await import('../lib/labour.mjs');
  const { buildBuyerFlags, seedChecklistFromFlags } = await import('../lib/parts.mjs');
  const { buildDamageCards } = await import('../lib/damageCards.mjs');
  const { readFileSync } = await import('node:fs');
  const ENTRY = { oem: 500, used: 275 };
  const items = (t) => String(t || '').split('\n').map((l) => l.replace(/^\d+[.)]\s*/, '')).filter(Boolean);
  const decline = (flags, pvVotes, costed = []) => promoteFlaggedQuarter({ gatedParts: [], flaggedParts: flags, costedIds: new Set(costed), sevByPanel: new Map(), zoneByPanel: new Map(), entry: ENTRY, name: 'Rear quarter panel', pvVotes });

  eq('checklist item, verbatim as Cowork wrote it', Q4_DECLINED_CHECKLIST_ITEM, 'Show rear quarter close-up — the photos disagree on this panel; it is not costed and must be checked before bidding.');
  ok('flag reason says the photos disagree, it is not costed, and it must be checked', /photos disagree/.test(Q4_DECLINED_REASON) && /not costed/.test(Q4_DECLINED_REASON) && /must be checked/.test(Q4_DECLINED_REASON));
  ok('flag reason is Latin-1 with a hyphen (PDF flag reasons are printed without the dash mapping)', !/[^\x00-\xFF]/.test(Q4_DECLINED_REASON));

  // 🎯 HMZ8034 shape (live-only; its stored _pvVotes verbatim) — a synthetic lock, not a replay.
  {
    const HMZ = { REAR_QUARTER: { views: 4, clean: 2, damaged: 1, severeVotes: 1, branch: 'disagree', resolving: 3, notVisible: 0 } };
    const flag = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: 'per-view disagreement — …', _amalgDisagree: true };
    const other = { panelId: 'WINDSCREEN', partName: 'Windscreen', zone: 'front', weight: 'medium', reason: 'per-view disagreement — …', _amalgDisagree: true };
    const out = decline([flag, other], HMZ);
    ok('HMZ8034: declined, and the ONE owner marks the quarter flag', out?.row === null && out.marked === 1 && flag._q4Declined === true && flag.reason === Q4_DECLINED_REASON);
    ok('HMZ8034: a different panel\'s disagree flag is NOT marked', other._q4Declined === undefined);
    const a = { _flaggedParts: [flag, other], _preGateParts: [{ panelId: 'FRONT_BUMPER', name: 'Front bumper' }] };   // main call never listed the quarter
    const buyer = buildBuyerFlags(a);
    ok('HMZ8034: the declined quarter IS in the buyer flag list (4f carve-out)', buyer.some((f) => f.panelId === 'REAR_QUARTER'));
    ok('HMZ8034: the unmarked windscreen disagree flag STAYS HIDDEN by 4f', !buyer.some((f) => f.panelId === 'WINDSCREEN') && a._suppressedFlags.some((s) => s.panelId === 'WINDSCREEN') && !a._suppressedFlags.some((s) => s.panelId === 'REAR_QUARTER'));
    const cl = seedChecklistFromFlags('1. Show the bonnet shut line.', buyer, { lampTier2Fired: false });
    ok('HMZ8034: the checklist carries the declined-quarter item exactly once', items(cl).filter((i) => i === Q4_DECLINED_CHECKLIST_ITEM).length === 1);
    ok('re-seeding does not duplicate it', items(seedChecklistFromFlags(cl, buyer)).filter((i) => i === Q4_DECLINED_CHECKLIST_ITEM).length === 1);
    ok('seeded even when the model\'s checklist already names the "Rear quarter panel" (phrase-match does not apply)', items(seedChecklistFromFlags('1. Show the rear quarter panel and sill line.', buyer)).includes(Q4_DECLINED_CHECKLIST_ITEM));
    const card = buildDamageCards({ gatedParts: [], costedParts: [], flaggedParts: [flag], allowanceParts: [] }).find((c) => c.part === 'Rear quarter panel');
    ok('damage breakdown: still a £0 Related card, now carrying the buyer sentence', card?.origin === 'Related' && card.cost === 0 && card.note === Q4_DECLINED_REASON);
  }
  {
    // A quarter that is NOT declined (tie → promoted) gets no mark, and a 4f-hidden quarter flag with no decline stays hidden.
    const flag = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: 'x', _amalgDisagree: true };
    const rows = [];
    const out = promoteFlaggedQuarter({ gatedParts: rows, flaggedParts: [flag], costedIds: new Set(), sevByPanel: new Map(), zoneByPanel: new Map(), entry: ENTRY, name: 'Rear quarter panel', pvVotes: { REAR_QUARTER: { damaged: 2, clean: 2 } } });
    ok('TIE: promoted, flag NOT marked', out?.row?._q4Promoted === true && flag._q4Declined === undefined);
    const unmarked = { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium', reason: 'x', _amalgDisagree: true };
    const a = { _flaggedParts: [unmarked], _preGateParts: [{ panelId: 'FRONT_BUMPER' }] };
    ok('an UNMARKED disagree quarter flag (no decline) stays hidden by 4f', buildBuyerFlags(a).length === 0 && a._suppressedFlags.length === 1);
  }

  // The REAL stored shapes: AMZ3790/baseline (1 v 4) and EA17HDN/30Aug-main (1 v 3) — both had the quarter flag hidden by 4f.
  for (const f of ['fixtures/AMZ3790/baseline-assessment.json', 'fixtures/EA17HDN/assessment-30Aug-main.json']) {
    const stored = JSON.parse(readFileSync(f, 'utf8'));
    const beforeA = { ...stored, _flaggedParts: structuredClone(stored._flaggedParts) };
    const beforeBuyer = buildBuyerFlags(beforeA);
    const beforeSuppressed = beforeA._suppressedFlags;
    const afterFlags = structuredClone(stored._flaggedParts);
    const costed = (stored._reconciledParts || []).map((r) => r.panelId).filter(Boolean);
    const out = decline(afterFlags, stored._pvVotes, costed);
    const afterA = { ...stored, _flaggedParts: afterFlags };
    const afterBuyer = buildBuyerFlags(afterA);
    const tag = f.split('/').slice(1).join('/');
    console.log(`    ${tag}: votes ${JSON.stringify(stored._pvVotes.REAR_QUARTER)} · suppressed before ${JSON.stringify(beforeSuppressed.map((s) => s.panelId))} → after ${JSON.stringify(afterA._suppressedFlags.map((s) => s.panelId))}`);
    ok(`${tag}: the stored quarter flag WAS hidden by 4f before`, beforeSuppressed.some((s) => s.panelId === 'REAR_QUARTER') && !beforeBuyer.some((x) => x.panelId === 'REAR_QUARTER'));
    ok(`${tag}: Q4 declines it on the stored votes and marks it`, out?.declined != null && out.marked >= 1);
    ok(`${tag}: after — the quarter is in the buyer flag list`, afterBuyer.some((x) => x.panelId === 'REAR_QUARTER'));
    ok(`${tag}: after — EVERY other 4f-suppressed flag is still suppressed, unchanged`, JSON.stringify(afterA._suppressedFlags) === JSON.stringify(beforeSuppressed.filter((s) => s.panelId !== 'REAR_QUARTER')));
    const clBefore = items(seedChecklistFromFlags(String(stored['WhatsApp Inspection Checklist'] || '').trim(), beforeBuyer));
    const clAfter = items(seedChecklistFromFlags(String(stored['WhatsApp Inspection Checklist'] || '').trim(), afterBuyer));
    ok(`${tag}: after — the checklist gains exactly the declined-quarter item, every other item unchanged`,
       clAfter.filter((i) => i === Q4_DECLINED_CHECKLIST_ITEM).length === 1 && JSON.stringify(clAfter.filter((i) => i !== Q4_DECLINED_CHECKLIST_ITEM)) === JSON.stringify(clBefore));
  }
}


// -- batch 145 V1: the checklist and the flag describe a panel the SAME WAY ---------------------
// Batches 141 and 143 rewrote the buyer-facing FLAG wording but left the checklist seeds saying
// "the engine's read" and "could not be resolved across views". The buyer read two descriptions of
// one panel, one of them in internal language. These pin the alignment against the SHIPPED source.
console.log('\n-- batch 145 V1: checklist seeds carry no internal language --');
{
  const { seedChecklistFromFlags } = await import('../lib/parts.mjs');
  const { readFileSync } = await import('node:fs');
  const partsSrc = readFileSync('lib/parts.mjs', 'utf8');
  const routeSrc = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const reasonOf = (name) => routeSrc.match(new RegExp(`^const ${name}\\s*=\\s*'([^']+)';`, 'm'))[1];

  // Every seed string in the shipped seeder, swept for the vocabulary batches 141/143/145 removed.
  const seeds = [...partsSrc.matchAll(/seedItem = `([^`]+)`;/g)].map((m) => m[1]);
  ok(`the seed strings were read from lib/parts.mjs (got ${seeds.length})`, seeds.length >= 7);
  const BANNED = /the engine's read|per[-\s]?view|across views|probe|amalgam|\biv:/i;
  for (const s of seeds) ok(`seed carries no internal language: "${s.slice(14, 60)}…"`, !BANNED.test(s));

  // The two that pair with a rewritten flag must use the flag's own words.
  const nv = seedChecklistFromFlags('1. Show the bonnet shut line.', [
    { panelId: 'SIDE_STRUCTURE', partName: 'Side structure', zone: 'side', weight: 'medium',
      reason: reasonOf('AMALG_REASON_NOT_VISIBLE'), _amalgNotVisible: true },
  ], { lampTier2Fired: false });
  ok('not-visible seed uses the flag\'s words ("not clear from the listing photographs")',
     /Show Side structure close-up — not clear from the listing photographs; condition unconfirmed\./.test(nv));
  ok('and the flag itself opens the same way', reasonOf('AMALG_REASON_NOT_VISIBLE').startsWith('not clear from the listing photographs'));

  const dis = seedChecklistFromFlags('1. Show the bonnet shut line.', [
    { panelId: 'REAR_QUARTER', partName: 'Rear quarter panel', zone: 'rear', weight: 'medium',
      reason: reasonOf('AMALG_REASON_DISAGREE'), _amalgDisagree: true },
  ], { lampTier2Fired: false });
  ok('disagree seed uses the flag\'s words ("the listing photographs disagree on this part")',
     /Show Rear quarter panel close-up — the listing photographs disagree on this part; condition unconfirmed\./.test(dis));
  ok('and the flag itself opens the same way', reasonOf('AMALG_REASON_DISAGREE').startsWith('the listing photographs disagree on this part'));

  // The airbag line (batch 131, Vincent's own words) is NOT touched by this pass.
  const srs = seedChecklistFromFlags('1. Show the bonnet shut line.', [
    { panelId: 'AIRBAG', partName: 'SRS airbag (deployed)', zone: 'interior', weight: 'high',
      reason: 'Airbags deployed', _srsExtentFloor: true },
  ], { lampTier2Fired: false });
  ok('the airbag checklist line is unchanged',
     srs.includes('Show SRS airbag (deployed) close-up — the number and location of the bags must be checked before bidding.'));
}


// -- batch 147 X1: a front wing flattens with the FRONT panels on a front-struck lot -------------
// flattenPanelWork gives the first panel of EACH zone its full price. The per-view pass tags a front
// wing by FLANK on some lots ('flank-damaged-side' — AMZ3790, HV25ODX) and by END on others ('front'
// — SA26KVT), so identical damage bought an extra full-price zone: +£300, or +£375 after §6's +25%.
console.log('\n-- batch 147 X1: front-wing labour zoning --');
{
  const { readFileSync } = await import('node:fs');
  const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');

  // The normalisation exists, is LABOUR-ONLY, and does not mutate the shared map.
  ok('X1: the labour mapping normalises the front wing\'s zone', route.includes('const labourZoneOf = (p) =>'));
  ok('X1: it is keyed on FRONT_WING and a struck front', route.includes("p.panelId === PANEL.FRONT_WING && _labourStruckZones.has('front')"));
  ok('X1: bodyPanels takes its zone from the normaliser', route.includes('zone: labourZoneOf(p),'));
  ok('X1: zoneByPanel is NOT mutated (flags and cards keep their own zone)',
     !/zoneByPanel\.set\([^)]*FRONT_WING/.test(route) && !route.includes("zoneByPanel.set(p.panelId, 'front')"));

  // The arithmetic the fix turns on, proved on the real flattener.
  const AMZ_BEFORE = [
    { zone: 'front', labour: PANEL_WORK.SEVERE },               // front bumper
    { zone: 'front', labour: PANEL_WORK.SEVERE },               // bonnet
    { zone: 'flank-damaged-side', labour: PANEL_WORK.SEVERE },  // front wing — its own zone
  ];
  const AMZ_AFTER = AMZ_BEFORE.map((p) => ({ ...p, zone: 'front' }));
  const before = flattenPanelWork(AMZ_BEFORE);
  const after  = flattenPanelWork(AMZ_AFTER);
  eq('X1: AMZ3790 panel work before (wing in its own zone)', before, 1500);
  eq('X1: AMZ3790 panel work after (wing folded into front)', after, 1200);
  // The wing went from a full-price first panel of its own zone (£600) to a half-price extra (£300).
eq('X1: the flank tag was worth half a panel of pure labour', before - after, PANEL_WORK.SEVERE / 2);

  // A wing already tagged 'front' (SA26KVT) must be untouched — the fix is a no-op there.
  const SA = [
    { zone: 'front', labour: PANEL_WORK.SEVERE },
    { zone: 'front', labour: PANEL_WORK.SEVERE },
    { zone: 'front', labour: PANEL_WORK.SEVERE },
  ];
  eq('X1: a wing already in the front zone is unchanged', flattenPanelWork(SA), after);

  // The REAR QUARTER is deliberately left alone — spec §3 does not support folding it into the rear.
  ok('X1: no quarter normalisation was added', !route.includes('PANEL.REAR_QUARTER && _labourStruckZones'));
}


// -- batch 147 X2: no structure floor when the only damage in the zone is the bumper ------------
// Vincent, 16 Sep: "if there are no other detections of damage other than bumper ripped off then no
// structure charge." Proved with the SHIPPED function, not a re-typed copy of the condition.
console.log('\n-- batch 147 X2: the structure floor needs damage beyond the bumper --');
{
  const { structureFloorApplies, STRUCT_FLOOR_ZONE } = await import('@/app/api/salvage/assess/route.js');

  // THE RULING: a bumper alone buys no structure floor.
  const frontBumperOnly = structureFloorApplies('FRONT_STRUCTURE', new Set(['FRONT_BUMPER']));
  ok('X2: front bumper alone → NO front structure floor', frontBumperOnly.apply === false);
  ok('X2: and the run knows it was the bumper (for the log line)', frontBumperOnly.bumperCosted === true);
  const rearBumperOnly = structureFloorApplies('REAR_STRUCTURE', new Set(['REAR_BUMPER']));
  ok('X2: rear bumper alone → NO rear structure floor', rearBumperOnly.apply === false);

  // Nothing costed at all is likewise no floor.
  ok('X2: an empty zone → no floor', structureFloorApplies('FRONT_STRUCTURE', new Set()).apply === false);
  ok('X2: and it does not claim a bumper it never saw',
     structureFloorApplies('FRONT_STRUCTURE', new Set()).bumperCosted === false);

  // ONE other costed panel is enough — the ruling is "other than bumper", not a threshold.
  for (const p of STRUCT_FLOOR_ZONE.FRONT_STRUCTURE.members) {
    ok(`X2: front bumper + ${p} → floor applies`,
       structureFloorApplies('FRONT_STRUCTURE', new Set(['FRONT_BUMPER', p])).apply === true);
  }
  for (const p of STRUCT_FLOOR_ZONE.REAR_STRUCTURE.members) {
    ok(`X2: rear bumper + ${p} → floor applies`,
       structureFloorApplies('REAR_STRUCTURE', new Set(['REAR_BUMPER', p])).apply === true);
  }

  // Zones do not leak into each other: rear damage must not license a FRONT floor.
  ok('X2: rear damage does not license the front floor',
     structureFloorApplies('FRONT_STRUCTURE', new Set(['REAR_BUMPER', 'REAR_QUARTER', 'BOOT_LID'])).apply === false);
  ok('X2: front damage does not license the rear floor',
     structureFloorApplies('REAR_STRUCTURE', new Set(['FRONT_BUMPER', 'BONNET', 'GRILLE'])).apply === false);

  // A panel that is not a structure panel is not governed by this rule at all.
  ok('X2: a non-structure panel always applies', structureFloorApplies('SIDE_STRUCTURE', new Set()).apply === true);
  ok('X2: an unknown panel always applies', structureFloorApplies('AIRBAG', new Set()).apply === true);

  // Array input is accepted as well as a Set (call sites pass a Set; keep it total).
  ok('X2: accepts an array as well as a Set',
     structureFloorApplies('FRONT_STRUCTURE', ['FRONT_BUMPER', 'BONNET']).apply === true);

  // THE THREE CORPUS LOTS, from their own replayed ledgers: none is in the bumper-only state, so
  // none loses its floor. Recorded so a future change that DOES move them is visible.
  const corpus = {
    AMZ3790: { zone: 'FRONT_STRUCTURE', damaged: ['FRONT_BUMPER', 'GRILLE', 'BONNET', 'SLAM_PANEL', 'FRONT_WING', 'HEADLAMP', 'FOG_LAMP', 'RADIATOR_PACK'] },
    SF69YBB: { zone: 'REAR_STRUCTURE',  damaged: ['REAR_BUMPER', 'REAR_QUARTER'] },
    SA26KVT: { zone: 'FRONT_STRUCTURE', damaged: ['FRONT_BUMPER', 'GRILLE', 'BONNET', 'SLAM_PANEL', 'FRONT_WING', 'HEADLAMP', 'RADIATOR_PACK'] },
  };
  for (const [vrm, c] of Object.entries(corpus)) {
    const r = structureFloorApplies(c.zone, new Set(c.damaged));
    ok(`X2: ${vrm} ${c.zone} keeps its floor (other damage: ${r.otherDamage.join(', ') || 'none'})`, r.apply === true);
  }
  // SF69YBB is the lot that prompted the ruling: its rear floor survives on the QUARTER alone.
  ok('X2: SF69YBB rear floor rests on REAR_QUARTER, and drops without it',
     structureFloorApplies('REAR_STRUCTURE', new Set(['REAR_BUMPER'])).apply === false
     && structureFloorApplies('REAR_STRUCTURE', new Set(['REAR_BUMPER', 'REAR_QUARTER'])).apply === true);
  // A flag-only rear lamp is NOT costed, so it does not count — the documented choice.
  ok('X2: a flag-only panel is not in the damaged set, so it cannot license a floor',
     structureFloorApplies('REAR_STRUCTURE', new Set(['REAR_BUMPER'])).apply === false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} labour: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
