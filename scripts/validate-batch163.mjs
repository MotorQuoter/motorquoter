// validate-batch163.mjs — batch 163 T1 (R2), T2 (one charged check), T3 (the standing rule). £0, pure.
//
//   T1  the attribution probe may not zero a panel that ≥2 views graded SEVERE and none graded clean.
//       iv:na and iv:missing are NEUTRAL (Vincent, 20 Sep). No stamp → today's behaviour, unchanged.
//   T2  ONE `isChargedRow`, in lib/ledgerEdits.mjs, replacing eight hand-written copies of the same rule.
//   T3  the standing rule is in CLAUDE.md, verbatim.
//
// ⛔ The T2 grep assertion is the point of this file, not decoration. The rule was written out eight
// times and they happened to agree; the ninth need not. If this fails, someone has re-spelled
// "is this panel charged?" outside its owner — fix the copy, do not re-baseline the test.
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch163.mjs
import { readFileSync } from 'fs';
import { isChargedRow, figureOf } from '../lib/ledgerEdits.mjs';
import { r2SevereKeep } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const route = read('app/api/salvage/assess/route.js');

const G = (view, iv, sev = null) => ({ view, iv, sev });

// ── T1 — R2 ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- T1: R2 fires on >=2 SEVERE with no clean view --');
ok('two SEVERE views, nothing else → keep', r2SevereKeep([G(1, 'true', 'SEVERE'), G(8, 'true', 'SEVERE')]) === true);
ok('three SEVERE views → keep', r2SevereKeep([G(1, 'true', 'SEVERE'), G(2, 'true', 'SEVERE'), G(3, 'true', 'SEVERE')]) === true);
ok('two SEVERE plus MODERATE and MINOR views → keep (the rule is not "every view SEVERE")',
  r2SevereKeep([G(0, 'true', 'MODERATE'), G(1, 'true', 'SEVERE'), G(8, 'true', 'SEVERE'), G(9, 'true', 'MINOR')]) === true);

console.log('\n-- T1: and does NOT fire otherwise --');
ok('ONE SEVERE view → floor as today (a single-view SEVERE is not covered)',
  r2SevereKeep([G(1, 'true', 'SEVERE'), G(2, 'true', 'MODERATE')]) === false);
ok('zero SEVERE views → floor as today', r2SevereKeep([G(1, 'true', 'MODERATE'), G(2, 'true', 'MODERATE')]) === false);
ok('two SEVERE but ONE CLEAN view → floor. A positive clean read breaks the run',
  r2SevereKeep([G(1, 'true', 'SEVERE'), G(8, 'true', 'SEVERE'), G(9, 'false')]) === false);
ok('a clean view breaks it however many SEVERE views there are',
  r2SevereKeep([G(1, 'true', 'SEVERE'), G(2, 'true', 'SEVERE'), G(3, 'true', 'SEVERE'), G(9, 'false')]) === false);

console.log('\n-- T1: iv:na and iv:missing are NEUTRAL (Vincent, 20 Sep) --');
ok('na views neither count nor break', r2SevereKeep([G(1, 'true', 'SEVERE'), G(6, 'na'), G(8, 'true', 'SEVERE'), G(9, 'na')]) === true);
ok('missing views neither count nor break', r2SevereKeep([G(0, 'missing'), G(1, 'true', 'SEVERE'), G(8, 'true', 'SEVERE')]) === true);
ok('na/missing alone never reach the threshold', r2SevereKeep([G(0, 'missing'), G(6, 'na'), G(7, 'na')]) === false);
ok('SD75YGC GRILLE\'s real shape (missing + 2 SEVERE + na + MODERATE) keeps',
  r2SevereKeep([G(0, 'missing'), G(1, 'true', 'SEVERE'), G(6, 'na'), G(8, 'true', 'SEVERE'), G(22, 'true', 'MODERATE')]) === true);
ok('SD75YGC WINDSCREEN\'s real shape (3 SEVERE but TWO clean) still floors',
  r2SevereKeep([G(0, 'false'), G(1, 'true', 'MINOR'), G(6, 'na'), G(8, 'false'), G(13, 'true', 'SEVERE'), G(21, 'true', 'SEVERE'), G(22, 'na'), G(24, 'true', 'SEVERE')]) === false);

console.log('\n-- T1: no stamp = exactly today\'s behaviour (direction of error) --');
ok('no stamp → false', r2SevereKeep(undefined) === false && r2SevereKeep(null) === false);
ok('empty stamp → false', r2SevereKeep([]) === false);
ok('not an array → false', r2SevereKeep({ view: 1, iv: 'true', sev: 'SEVERE' }) === false);
ok('malformed entries → false, never a throw', r2SevereKeep([null, undefined, {}, { iv: 'true' }]) === false);

console.log('\n-- T1: where it sits in the probe --');
ok('it is a branch of the probe chain, BEFORE the floor branch',
  route.indexOf('} else if (r2SevereKeep(cp._perViewGrades)) {') > 0
  && route.indexOf('} else if (r2SevereKeep(cp._perViewGrades)) {') < route.indexOf('// FLOOR — only a verdict that POSITIVELY contradicts'));
ok('it reads the batch 160 C stamp and nothing else', /r2SevereKeep\(cp\._perViewGrades\)/.test(route));
ok('it is a KEEP: iv is not touched and no flag is pushed in that branch',
  !/r2SevereKeep[\s\S]{0,700}?independentlyVisible = false/.test(route.slice(route.indexOf('} else if (r2SevereKeep'), route.indexOf('} else if (r2SevereKeep') + 700)));
ok('the action enum records it', /action = 'r2-severe-kept';/.test(route) && /r2-severe-kept/.test(route.slice(route.indexOf('// Action enum'), route.indexOf('// Action enum') + 400)));
ok('the log line is Vincent\'s, with the severe views and the neutrality named',
  /\[PROBE\]\[R2\] \$\{cp\.panelId\} kept — severe views:\[\$\{g\.filter\(x => x\.sev === 'SEVERE'\)\.map\(x => x\.view\)\.join\(','\)\}\] clean:none \(na\/missing neutral\)/.test(route));

// ── T2 — one charged check ──────────────────────────────────────────────────────────────────────────
console.log('\n-- T2: the one "is this panel charged?" check --');
ok('a row with a second-hand figure is charged', isChargedRow({ used: 350, oem: 600 }) === true);
ok('a row with only an OEM figure is charged', isChargedRow({ used: null, oem: 600 }) === true);
ok('a REPAIRED panel is charged at £0 on its own row — the whole point', isChargedRow({ used: null, oem: null, _repairNoPart: true }) === true);
ok('an uncosted row is not charged', isChargedRow({ used: null, oem: null }) === false);
ok('an explicit £0 part is not charged', isChargedRow({ used: 0, oem: 500 }) === false);
ok('null / undefined never throw', isChargedRow(null) === false && isChargedRow(undefined) === false);
ok('_repairNoPart is tested strictly — a truthy non-true value is a bug, not a charge', isChargedRow({ _repairNoPart: 1 }) === false);
ok('it agrees with figureOf on every figure shape',
  [{ used: 350 }, { oem: 600 }, { used: null, oem: null }, { used: 0, oem: 500 }, { used: '350' }, { used: NaN }, { used: '' }]
    .every((r) => isChargedRow(r) === (figureOf(r) > 0)));

console.log('\n-- T2: every former copy now calls it, and nobody re-defines it --');
const FILES = ['app/api/salvage/assess/route.js', 'lib/parts.mjs', 'lib/ledgerEdits.mjs',
  'lib/flooredProseScrub.mjs', 'scripts/score-accuracy.mjs'];
for (const f of FILES) ok(`${f} imports or defines isChargedRow`, /isChargedRow/.test(read(f)));
ok('route.js: all four copies are gone', !/\(p\.used \?\? p\.oem \?\? 0\) > 0 \|\| p\._repairNoPart/.test(route));
ok('parts.mjs: inMoney is now the shared function', /const inMoney = isChargedRow;/.test(read('lib/parts.mjs')));
ok('score-accuracy.mjs: isCosted is now the shared function', /const isCosted = isChargedRow;/.test(read('scripts/score-accuracy.mjs')));
ok('flooredProseScrub.mjs: the inline filter is now the shared function', /\.filter\(isChargedRow\)/.test(read('lib/flooredProseScrub.mjs')));
ok('ledgerEdits.mjs: the structure-floor survivor set uses it', /!isStructureFloorRow\(r\)\s*\n\s*&& isChargedRow\(r\)/.test(read('lib/ledgerEdits.mjs')));

// THE guard: nobody outside the owner re-spells the rule. Comments stripped so the prose above,
// which necessarily quotes the old spelling, does not trip it.
{
  const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const RESPELL = /\(\s*\w+\??\.\w*used[\s\S]{0,40}?\)\s*>\s*0\s*\|\|\s*\w+\??\._repairNoPart|figureOf\([^)]*\)\s*>\s*0\s*\|\|\s*\w+\??\._repairNoPart/;
  const offenders = [];
  for (const f of ['app/api/salvage/assess/route.js', 'lib/parts.mjs', 'lib/flooredProseScrub.mjs',
    'lib/labour.mjs', 'lib/damageCards.mjs', 'lib/structureFloor.mjs', 'lib/bidCeiling.mjs',
    'app/api/salvage/pdf/route.js', 'app/salvage/success/page.js', 'scripts/score-accuracy.mjs']) {
    if (RESPELL.test(stripComments(read(f)))) offenders.push(f);
  }
  ok(`no file outside lib/ledgerEdits.mjs re-defines the rule${offenders.length ? ` — found in ${offenders.join(', ')}` : ''}`, offenders.length === 0);
  ok('the owner still defines it exactly once',
    (stripComments(read('lib/ledgerEdits.mjs')).match(/export function isChargedRow/g) || []).length === 1);
}

// ── T3 — the standing rule ──────────────────────────────────────────────────────────────────────────
console.log('\n-- T3: the standing rule is in CLAUDE.md --');
{
  const md = read('CLAUDE.md');
  ok('rule 7 exists, under WORKING RULES, after rule 6',
    md.includes('## 7. Whether a panel is charged — one check, never a £ scan')
    && md.indexOf('## 6. ⚠️ The Project Overview above is STALE') < md.indexOf('## 7. Whether a panel is charged'));
  ok('it names _repairNoPart as the reason a £ scan lies', /A repaired panel carries no £ on its own row: its cost is inside the Labour & paint line\n\(`_repairNoPart`\)\./.test(md));
  ok('it names the function and its home', /Always use `isChargedRow\(\)` from `lib\/ledgerEdits\.mjs`/.test(md));
  ok('it binds one-off analysis scripts too, not just app code', /in app code, validators, scorecards, and\none-off analysis scripts alike/.test(md));
  ok('it requires the prose to agree with the table', /the prose must agree with the table it summarises/.test(md));
  ok('it records why it exists', /after batch 160 §3's summary called a repair-row HIT "not charged"/.test(md));
}

console.log(`\nbatch163: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
