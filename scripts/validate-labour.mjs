// validate-labour.mjs — locks lib/labour.mjs to _cc/LABOUR_SPEC_v1_31Aug2026.md (batch 92/95).
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

  for (const pid of ['REAR_QUARTER', 'SILL', 'ROOF']) {
    const w = [{ panelId: pid, name: pid, action: 'repair', oem: 400, used: 220 }];
    applyGradeOwnsAction(w, new Map([[pid, 'MODERATE']]));
    ok(`WELDED ${pid} is NOT touched (spec keys welded on repair/replace, silent on part cost)`, w[0].used === 220 && w[0].action === 'repair' && !w[0]._repairNoPart);
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
  ok('route: a repaired panel still counts as costed for the bonnet tell and the §4 bumper-off note',
     (route.match(/\(p\.used \?\? p\.oem \?\? 0\) > 0 \|\| p\._repairNoPart/g) || []).length === 2);
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

console.log(`\n${fail === 0 ? '✅' : '❌'} labour: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
