// validate-trim-items.mjs — batch 156 T1/T2/TASK-0. £0, pure, no model calls.
//
// Vincent's ruling (18 Sep, MotorQuoter_RULING_TrimItems_18Sep2026): trim is named as trim, never as the
// panel behind it. Three trim items exist — WHEEL_ARCH_MOULDING (batch 75), and WHEEL_ARCH_LINER +
// REAR_LIGHT_STRIP (new here). Badges and clips are OUT.
//
// This locks:
//   T1  the two new price bands — Vincent gave ONE OEM figure each (liner £75, light strip £100) as the
//       UPPER_EXEC anchor; the moulding precedent (batch 75 §3) supplies the rest. The test RE-DERIVES
//       every figure from the anchor rather than restating the table.
//   T2  enum class and display, the vocabulary in both definition lists, the TRIM BEFORE PANEL rule,
//       trim-labour = none ("minutes, absorbed"), and the trim/panel overlap REPORTER (no merge rule).
//   TASK-0  the body-class strip defect: all three trim items are eligible on every body class.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-trim-items.mjs
import { readFileSync } from 'fs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS, PANEL_DISPLAY } from '../lib/panelEnum.mjs';
import { PANEL_PRICE_TABLE, BAND_KEYS } from '../lib/priceBand.mjs';
import { BODY_PANEL_LABOUR } from '../lib/labour.mjs';
import { trimPanelOverlaps, TRIM_BEHIND } from '../lib/parts.mjs';
import { ELIGIBLE_PANELS } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route  = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../config/assessmentEngine.js', import.meta.url), 'utf8');

const TRIM = ['WHEEL_ARCH_MOULDING', 'WHEEL_ARCH_LINER', 'REAR_LIGHT_STRIP'];
const NEW  = ['WHEEL_ARCH_LINER', 'REAR_LIGHT_STRIP'];

// ── T2: the enum ────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- T2: the two new trim items are COST panels --');
ok('WHEEL_ARCH_LINER exists in PANEL', PANEL.WHEEL_ARCH_LINER === 'WHEEL_ARCH_LINER');
ok('REAR_LIGHT_STRIP exists in PANEL', PANEL.REAR_LIGHT_STRIP === 'REAR_LIGHT_STRIP');
for (const p of NEW) ok(`${p} → PANEL_CLASS.COST`, PANEL_BEHAVIOUR[p] === PANEL_CLASS.COST);
ok('WHEEL_ARCH_LINER display name', PANEL_DISPLAY.WHEEL_ARCH_LINER === 'Wheel arch liner');
ok('REAR_LIGHT_STRIP display name', PANEL_DISPLAY.REAR_LIGHT_STRIP === 'Rear light strip / tailgate garnish');

// ── T1: the prices, re-derived from Vincent's single figure ─────────────────────────────────────────
console.log("\n-- T1: every band re-derived from Vincent's UPPER_EXEC OEM anchor --");
// The moulding's own progression, read off its table rather than assumed.
const M = PANEL_PRICE_TABLE.WHEEL_ARCH_MOULDING;
const BANDS = [BAND_KEYS.ECONOMY, BAND_KEYS.MID_RANGE, BAND_KEYS.EXECUTIVE, BAND_KEYS.UPPER_EXEC,
  BAND_KEYS.PRESTIGE, BAND_KEYS.LUXURY, BAND_KEYS.SUPER_LUX];
const RATIOS = BANDS.map((b) => M[b].oem / M[BAND_KEYS.UPPER_EXEC].oem);
ok('the moulding progression is ×0.5 / ×2⁄3 / ×5⁄6 / ×1 / ×1.25 / ×1.5 / ×2',
  RATIOS.map((r) => r.toFixed(3)).join(',') === [0.5, 2 / 3, 5 / 6, 1, 1.25, 1.5, 2].map((r) => r.toFixed(3)).join(','));
const round5 = (n) => Math.round(n / 5) * 5;   // .5 rounds up
for (const [pid, anchor] of [['WHEEL_ARCH_LINER', 75], ['REAR_LIGHT_STRIP', 100]]) {
  const t = PANEL_PRICE_TABLE[pid];
  ok(`${pid}: priced in all seven bands`, !!t && BANDS.every((b) => t[b] && typeof t[b].oem === 'number' && typeof t[b].used === 'number'));
  ok(`${pid}: UPPER_EXEC OEM = £${anchor} (Vincent's figure, unchanged)`, t[BAND_KEYS.UPPER_EXEC].oem === anchor);
  const derived = BANDS.map((b, i) => { const oem = round5(anchor * RATIOS[i]); return { b, oem, used: round5(oem / 2) }; });
  ok(`${pid}: every OEM figure = anchor × the moulding ratio, £5-rounded`, derived.every((d) => t[d.b].oem === d.oem));
  ok(`${pid}: every S/H figure = 50% of its own OEM, £5-rounded`, derived.every((d) => t[d.b].used === d.used));
  ok(`${pid}: no S/H figure exceeds its OEM`, BANDS.every((b) => t[b].used <= t[b].oem));
  ok(`${pid}: every figure is £5-rounded`, BANDS.every((b) => t[b].oem % 5 === 0 && t[b].used % 5 === 0));
}

// ── T2: labour — trim is "minutes, absorbed" ────────────────────────────────────────────────────────
console.log('\n-- T2: trim carries no panel labour --');
for (const p of TRIM) ok(`${p} is NOT a BODY_PANEL_LABOUR panel (LABOUR_SPEC_v1 §411)`, !BODY_PANEL_LABOUR.has(p));

// ── TASK-0: the body-class strip defect ─────────────────────────────────────────────────────────────
console.log('\n-- TASK-0: a trim item survives the body-class strip on every class --');
for (const cls of Object.keys(ELIGIBLE_PANELS)) {
  for (const p of TRIM) ok(`${cls}: ${p} is eligible`, ELIGIBLE_PANELS[cls].has(p));
}
ok('the fix is in the single owner (_ELIGIBLE_UNIVERSAL), not a per-class patch',
  /_ELIGIBLE_UNIVERSAL = \[[\s\S]*?PANEL\.WHEEL_ARCH_MOULDING, PANEL\.WHEEL_ARCH_LINER, PANEL\.REAR_LIGHT_STRIP,[\s\S]*?\];/.test(route));

// ── T2: the vocabulary and the TRIM BEFORE PANEL rule ───────────────────────────────────────────────
console.log('\n-- T2: both definition lists carry the items and the rule --');
for (const [name, src] of [['route.js', route], ['config/assessmentEngine.js', engine]]) {
  ok(`${name}: WHEEL_ARCH_LINER defined as the liner INSIDE the arch, not the panel`,
    /WHEEL_ARCH_LINER\s+wheel arch liner[^\n]*INSIDE the wheel arch[^\n]*NOT the wing or quarter/.test(src));
  ok(`${name}: REAR_LIGHT_STRIP defined as the strip across the tailgate, not the tailgate`,
    /REAR_LIGHT_STRIP\s+rear light strip[^\n]*between the rear lamps[^\n]*NOT the boot lid or tailgate/.test(src));
  ok(`${name}: the TRIM BEFORE PANEL rule is stated`, /TRIM BEFORE PANEL/.test(src));
  ok(`${name}: the rule names the three panels it displaces`,
    /FRONT_WING, REAR_QUARTER and BOOT_LID are\n\s+for damage to the PANEL/.test(src));
  ok(`${name}: both damaged → both lines (no silent merge)`, /write BOTH lines, one for each/.test(src));
}

// ── T2: the trim/panel overlap is REPORTED, never merged ────────────────────────────────────────────
console.log('\n-- T2: trim + the panel behind it is reported, not merged --');
const row = (panelId, views) => ({ panelId, partName: panelId, _probeViews: views });
ok('the map is trim → the panel(s) behind it',
  TRIM_BEHIND.WHEEL_ARCH_MOULDING.join() === 'FRONT_WING,REAR_QUARTER'
  && TRIM_BEHIND.WHEEL_ARCH_LINER.join() === 'FRONT_WING,REAR_QUARTER'
  && TRIM_BEHIND.REAR_LIGHT_STRIP.join() === 'BOOT_LID');
const same = trimPanelOverlaps([row('WHEEL_ARCH_MOULDING', [14, 17]), row('FRONT_WING', [0, 14, 15])]);
ok('a trim and its panel read in a shared frame is reported (frame 14)',
  same.length === 1 && same[0].trim === 'WHEEL_ARCH_MOULDING' && same[0].panel === 'FRONT_WING' && same[0].frames.join() === '14');
ok('no shared frame → not reported', trimPanelOverlaps([row('WHEEL_ARCH_LINER', [1]), row('REAR_QUARTER', [2, 3])]).length === 0);
ok('the light strip pairs with the boot lid',
  trimPanelOverlaps([row('REAR_LIGHT_STRIP', [2, 3]), row('BOOT_LID', [3, 8])])[0]?.panel === 'BOOT_LID');
ok('an unrelated panel is never paired', trimPanelOverlaps([row('REAR_LIGHT_STRIP', [2]), row('FRONT_BUMPER', [2])]).length === 0);
ok('no trim row → nothing reported', trimPanelOverlaps([row('FRONT_WING', [1]), row('BOOT_LID', [1])]).length === 0);
ok('empty / missing input is safe', trimPanelOverlaps([]).length === 0 && trimPanelOverlaps(undefined).length === 0);
ok('route.js reports it and does not strike or merge a row',
  route.includes('[TRIM/PANEL]') && route.includes('assessment._trimPanelOverlap = _trimOverlap;')
  && !/_trimOverlap[\s\S]{0,400}gatedParts\.splice/.test(route));

// ── T2: not visible → flagged, never charged (batch 151 V2 still holds for the new items) ───────────
console.log('\n-- T2: a trim item no photo shows is flagged, not charged --');
ok('no family-B not-visible costing path exists for ANY panel', !route.includes("_zeroRule: 'B'"));
ok('the not-visible branch still only continues', /f\._amalgNotVisible\) \{[\s\S]{0,400}?continue;/.test(route));
ok('neither new item is a paired/seeded panel (costed only when seen)',
  !/PAIRS[\s\S]{0,200}WHEEL_ARCH_LINER/.test(route) && !/PAIRS[\s\S]{0,200}REAR_LIGHT_STRIP/.test(route));

// ── T3: the sheets and the scorer ───────────────────────────────────────────────────────────────────
console.log('\n-- T3: the labelling sheets and the scorer --');
const sheets = readFileSync(new URL('./build-labelling-sheets.mjs', import.meta.url), 'utf8');
const scorer = readFileSync(new URL('./score-accuracy.mjs', import.meta.url), 'utf8');
ok('the trim-only sheet shows exactly the three trim items',
  sheets.includes("const TRIM_ONLY = ['WHEEL_ARCH_MOULDING', 'WHEEL_ARCH_LINER', 'REAR_LIGHT_STRIP'];"));
ok('a subset sheet still SAVES A WHOLE FILE (it cannot delete an unshown label)',
  sheets.includes('const panels = SUBSET ? JSON.parse(JSON.stringify(SEEDED)) : {};'));
ok('the trim rows reach the sheets through the eligibility set, not a second hard-coded list',
  sheets.includes('info.panels.filter((p) => opts.only.includes(p))'));
// The scorer walks the LABELS, never the vocabulary: a row nobody has labelled is never scored and never
// counted as clean. It is listed apart as an unlabelled costed panel.
ok('score-accuracy scores only labelled panels (unlabelled ≠ clean)',
  scorer.includes('for (const [pid, lab] of Object.entries(labels))'));
ok('an unlabelled costed panel is reported apart, not scored',
  scorer.includes('!labels[panelOf(r)]') && scorer.includes('unlabelledCosted: unlabelled'));
ok('coverage counts the trim rows as vocabulary (so they read as unlabelled, not clean)',
  scorer.includes('const vocab = info.panels.length;'));

console.log(`\ntrim-items: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
