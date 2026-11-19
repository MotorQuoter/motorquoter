// Validator — batch 253 Part B, B1: three named parts for what the engine called OTHER, and OTHER discipline. £0, no live call.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch253-b1.mjs
import { readFileSync } from 'node:fs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS, PANEL_DISPLAY, resolvePanelToken } from '../lib/panelEnum.mjs';
import { PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';
import { applyVisibilityGate, nameOtherFlags, otherNames, seedChecklistFromFlags, FRONT_SENSORS_REASON, OTHER_FALLBACK_NAME } from '../lib/parts.mjs';
import { isChargedRow } from '../lib/ledgerEdits.mjs';
import { BODY_PANEL_LABOUR } from '../lib/labour.mjs';
import { CONFIRM_ACTION } from '../lib/notesConfirm.mjs';
import { STRUCT_FLOOR_ZONE } from '../lib/structureFloor.mjs';
import { parseParts, amalgamate, END_SPECIFIC_PANELS, ELIGIBLE_PANELS } from '../app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const _log = console.log; const silently = (fn) => { console.log = () => {}; console.warn = () => {}; try { return fn(); } finally { console.log = _log; } };

console.log('\n1. The panels');
ok('FRONT_BUMPER_REINFORCEMENT: COST, "Bumper reinforcement"', PANEL_BEHAVIOUR.FRONT_BUMPER_REINFORCEMENT === PANEL_CLASS.COST && PANEL_DISPLAY.FRONT_BUMPER_REINFORCEMENT === 'Bumper reinforcement');
ok('UNDERTRAY: COST, "Undertray"', PANEL_BEHAVIOUR.UNDERTRAY === PANEL_CLASS.COST && PANEL_DISPLAY.UNDERTRAY === 'Undertray');
ok('FRONT_SENSORS: flag only (VISIBLE_FLAG), "Front radar / parking sensors", no price row', PANEL_BEHAVIOUR.FRONT_SENSORS === PANEL_CLASS.VISIBLE_FLAG && PANEL_DISPLAY.FRONT_SENSORS === 'Front radar / parking sensors' && !PANEL_PRICE_TABLE.FRONT_SENSORS);
ok('the sensors line, verbatim', FRONT_SENSORS_REASON === 'Front radar or parking sensors may need replacing and calibrating. This is not in the repair total. Check on inspection.');
const ROW = (t) => ['ECONOMY', 'MID_RANGE', 'EXECUTIVE', 'UPPER_EXEC', 'PRESTIGE', 'LUXURY', 'SUPER_LUX'].map(k => [t[Object.keys(t).find(x => x.toUpperCase().replace(/[^A-Z]/g, '') === k.replace(/_/g, ''))]?.oem, t[Object.keys(t).find(x => x.toUpperCase().replace(/[^A-Z]/g, '') === k.replace(/_/g, ''))]?.used]);
ok('bumper reinforcement band row (UPPER_EXEC £180/£90 anchor, batch-156 method)', eq(Object.values(PANEL_PRICE_TABLE.FRONT_BUMPER_REINFORCEMENT).map(e => [e.oem, e.used]), [[90, 45], [120, 60], [150, 75], [180, 90], [225, 115], [270, 135], [360, 180]]));
ok('undertray band row (UPPER_EXEC £80/£40 anchor)', eq(Object.values(PANEL_PRICE_TABLE.UNDERTRAY).map(e => [e.oem, e.used]), [[40, 20], [55, 30], [65, 35], [80, 40], [100, 50], [120, 60], [160, 80]]));
ok('no labour row of their own (not body panels: beam ABSORBED, undertray trim — spec §10)', !BODY_PANEL_LABOUR.has('FRONT_BUMPER_REINFORCEMENT') && !BODY_PANEL_LABOUR.has('UNDERTRAY'));
ok('seen-only: in no structure-floor zone (never assumed from an impact)', !Object.values(STRUCT_FLOOR_ZONE).some(z => z.members.includes('FRONT_BUMPER_REINFORCEMENT') || z.members.includes('UNDERTRAY')));
ok('every body class may carry them; front-end tagged', ['FRONT_BUMPER_REINFORCEMENT', 'UNDERTRAY', 'FRONT_SENSORS'].every(p => Object.values(ELIGIBLE_PANELS).every(s => s.has(p)) && END_SPECIFIC_PANELS.front.has(p)));
ok('notes-confirm: both costed parts are "replace" (never repaired)', CONFIRM_ACTION.FRONT_BUMPER_REINFORCEMENT === 'replace' && CONFIRM_ACTION.UNDERTRAY === 'replace' && CONFIRM_ACTION.FRONT_SENSORS === undefined);
ok('a costed reinforcement row is a charged row (isChargedRow)', isChargedRow({ panelId: 'FRONT_BUMPER_REINFORCEMENT', action: 'replace', used: 90, oem: 180 }));

console.log('\n2. Vocabulary lines (per-view prompt + Call 1 copy)');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8'), engine = readFileSync('config/assessmentEngine.js', 'utf8');
for (const [n, t] of [['per-view', route], ['Call 1', engine]]) {
  ok(`${n}: FRONT_BUMPER_REINFORCEMENT line says crush cans / chassis legs are FRONT_STRUCTURE`, /FRONT_BUMPER_REINFORCEMENT\s+front bumper reinforcement[^\n]*NOT the crush cans or chassis legs it bolts to: those are FRONT_STRUCTURE/.test(t));
  ok(`${n}: FRONT_STRUCTURE line names the crush cans and the boundary`, /FRONT_STRUCTURE\s+chassis leg \/ crush cans[^\n]*never FRONT_BUMPER_REINFORCEMENT/.test(t));
  ok(`${n}: UNDERTRAY and FRONT_SENSORS lines`, /\n  UNDERTRAY\s+engine undertray/.test(t) && /\n  FRONT_SENSORS\s+front radar unit[^\n]*flag only, never priced/.test(t));
  ok(`${n}: OTHER(<one or two words>), never iv:false / iv:na`, t.includes('OTHER(<one or two words>)') && t.includes('never write an OTHER line with iv:false or iv:na'));
}

console.log('\n3. OTHER discipline');
ok('resolvePanelToken: bracketed / named OTHER → OTHER with its name', eq(resolvePanelToken('OTHER (front bumper reinforcement beam)'), { panelId: 'OTHER', freeName: 'front bumper reinforcement beam' })
  && eq(resolvePanelToken('OTHER(door handle)'), { panelId: 'OTHER', freeName: 'door handle' }) && eq(resolvePanelToken('OTHER'), { panelId: 'OTHER', freeName: null }));
ok('resolvePanelToken: a known id with trailing words is that id; free text is no panel', resolvePanelToken('FRONT_BUMPER (lower)').panelId === 'FRONT_BUMPER' && resolvePanelToken('Labour & paint').panelId === null && resolvePanelToken('FOO_BAR').panelId === null);
{
  // AMZ3790's recorded Call 1 parts text (fixtures/AMZ3790/model-cassette.json) — the £120 row that used to be charged
  const c = JSON.parse(readFileSync('fixtures/AMZ3790/model-cassette.json', 'utf8'));
  let text = null;
  for (const arr of Object.values(c)) for (const s of [].concat(arr)) if (!text && s.includes('OTHER (front bumper reinforcement beam)')) {
    const j = JSON.parse(s); text = (j.content || []).map(b => b.text || '').join('\n');
  }
  ok('the recorded AMZ3790 Call 1 text is on disk', !!text);
  // the route parses only the numbered parts block (before "Part Verdicts:"), and the gate runs only with verdicts present
  const block = text.slice(0, text.indexOf('Part Verdicts:')).split('\n').filter(l => /^\d+\.\s/.test(l.trim())).join('\n');
  const rows = silently(() => parseParts(block));
  const other = rows.find(r => /front bumper reinforcement beam/.test(r.name) || r._freeName === 'front bumper reinforcement beam');
  ok('parseParts: the row resolves to PANEL.OTHER with its name (was panelId undefined)', other?.panelId === 'OTHER' && other._freeName === 'front bumper reinforcement beam');
  const flags = [];
  const out = silently(() => applyVisibilityGate(rows.map(r => ({ ...r })), [{ panelId: 'FRONT_BUMPER', partName: 'Front bumper', independentlyVisible: true }], flags, null));
  const gated = out.gatedParts || out.parts || out;
  ok('the gate: the OTHER row is NOT charged (flag-only), the buyer sees it named', !(Array.isArray(gated) ? gated : []).some(r => r.panelId === 'OTHER' && isChargedRow(r))
    && flags.some(f => f.panelId === 'OTHER' && f._otherNotCosted && /front bumper reinforcement beam/i.test(f.partName)));
}
{
  // amalgamate over member lines: an OTHER group of damaged reads → one flag, no "photos disagree"
  const g = [{ panelId: 'OTHER', members: ['[view:12] PART: OTHER | iv:true | sev:MODERATE | z:front', '[view:22] PART: OTHER | iv:true | sev:SEVERE | z:underside'] }];
  const r = silently(() => amalgamate(g, new Map()));
  ok('an OTHER group is never a "photos disagree" verdict and never costed', !r.flaggedParts.some(f => f._amalgDisagree) && !r.costedParts.some(c => c.panelId === 'OTHER' && c.independentlyVisible === true));
  ok('the route drops a clean / unreadable OTHER read before grouping (not a damaged part)', /if \(cp\.independentlyVisible !== true && cp\.independentlyVisible !== 'missing'\) \{[\s\S]{0,260}return null;/.test(route));
}
{
  const flags = [{ panelId: 'OTHER', partName: 'Other', reason: 'r', weight: 'medium', zone: 'front' }];
  const pv = [{ costedParts: [{ panelId: 'OTHER', _freeName: 'door handle' }], instanceParts: [{ panelId: 'OTHER', _freeName: 'seat trim' }, { panelId: 'OTHER', _freeName: 'DOOR_HANDLE' }] }];
  nameOtherFlags(flags, pv);
  ok('nameOtherFlags: one line per distinct name, never joined', eq(flags.map(f => f.partName), ['Door handle', 'Seat trim']));
  ok('no name at all → the unnamed-part name', eq(otherNames([]), [OTHER_FALLBACK_NAME]));
}

console.log('\n4. The sensors line reaches the flags and the checklist');
{
  const g = [{ panelId: 'FRONT_SENSORS', members: ['[view:3] PART: FRONT_SENSORS | iv:true | sev:MODERATE | z:front'] }];
  const r = silently(() => amalgamate(g, new Map()));
  const f = r.flaggedParts.find(x => x.panelId === 'FRONT_SENSORS');
  ok('a damaged sensors read → a flag with the line, never a costed entry', f?.reason === FRONT_SENSORS_REASON && !r.costedParts.some(c => c.panelId === 'FRONT_SENSORS' && c.independentlyVisible === true));
  const cl = silently(() => seedChecklistFromFlags('1. x', [{ ...f, partName: 'Front radar / parking sensors' }], {}));
  ok('the checklist carries the same line', cl.includes(`2. ${FRONT_SENSORS_REASON}`));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
