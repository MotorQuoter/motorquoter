// validate-batch160.mjs — batch 160 rulings C and R1. £0, pure, no model calls.
//
//   C   per-view grades {view, iv, sev} travel ON the costed entry (_perViewGrades), beside _probeViews,
//       so a G-SPLIT instance's own grades are reachable without a pvVotesMap key that the entry does
//       not carry. Consumed by R1.
//   R1  a _gOwned REAR_QUARTER / FRONT_WING instance whose OWN member views include a side-on shot that
//       graded the panel CLEAN is not costed — it goes to Inspection Flags instead.
//
// ⛔ WHY THIS FILE MATTERS MORE THAN USUAL. R1 fires on ZERO of the 16 replay lots (see the batch 160
// report in _cc/handoff.md): every _gOwned quarter/wing in the corpus is a Case-B split, and Case B's
// S2b guard (route.js SAFETY_ABORT=clean-vote-in-damaged-instance) forbids a clean vote inside the
// damaged instance — so "a member view graded it clean" is unreachable on that path BY CONSTRUCTION.
// The corpus therefore cannot exercise the rule at all. These assertions are the only proof that the
// shipped function does what the ruling says, so they run against the LITERAL exported function, never
// a copy. If R1 is ever re-pointed at another bucket, this file is what says what the old rule meant.
//
// R2 IS NOT IN THIS FILE — it was not built. Ruling D made it conditional on `missing` meaning "the
// panel was not in that view"; the per-view prompt defines iv:missing as the part being physically
// ABSENT and says in terms that "I don't see it in this shot" is iv:na. That is the HALT the ruling
// asked for. The assertion below pins the prompt text, so the ruling is re-checkable at £0.
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch160.mjs
import { readFileSync } from 'fs';
import { PANEL } from '../lib/panelEnum.mjs';
import { r1SideOnClearView, R1_SIDE_ON_ZONES } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');

// A frame-zone pass shaped exactly as runFrameZoneId returns it.
const ZONES = (map) => ({ ok: true, frames: Object.entries(map).map(([i, zones]) => ({ i: Number(i), zones, windscreenLabel: false })) });
const G = (view, iv, sev = null) => ({ view, iv, sev });

// ── C: the stamp ────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- C: per-view grades travel on the costed entry --');
ok('_perViewGrades is stamped beside _probeViews, same 1:1 last-entry mechanism',
  /_cp\._probeViews = _probeViews;\s*\n\s*_cp\._perViewGrades = _perViewGrades;/.test(route));
ok('the stamp is built from the SAME member lines as damagedSevs',
  /const _perViewGrades = members\.map\(l => \{/.test(route));
ok('sev mirrors damagedSevs exactly — iv:true with no sev token reads MODERATE, everything else null',
  /sev: iv === 'true' \? \(sm \? sm\[1\]\.toUpperCase\(\) : 'MODERATE'\) : null/.test(route));
ok('views without a [view:N] prefix are dropped, as _probeViews drops them',
  /\}\)\.filter\(g => g\.view >= 0\);/.test(route));

// ── R1: the shipped selector ────────────────────────────────────────────────────────────────────────
console.log('\n-- R1: a side-on MEMBER view that graded the panel clean --');
ok('the side-on zone set is exactly flank / nearside / offside',
  R1_SIDE_ON_ZONES.size === 3 && ['flank', 'nearside', 'offside'].every(z => R1_SIDE_ON_ZONES.has(z)));

ok('a clean member view in a nearside frame fires, and names the view',
  r1SideOnClearView([G(2, 'true', 'SEVERE'), G(5, 'false')], ZONES({ 2: ['rear'], 5: ['nearside'] }))?.view === 5);
ok('a clean member view in an offside frame fires',
  r1SideOnClearView([G(5, 'false')], ZONES({ 5: ['offside'] }))?.view === 5);
ok('a clean member view in a flank frame fires — flank names no side, membership already fixed it',
  r1SideOnClearView([G(5, 'false')], ZONES({ 5: ['flank'] }))?.view === 5);
ok('a three-quarter frame counts — the side zone need not be the only zone',
  r1SideOnClearView([G(5, 'false')], ZONES({ 5: ['front', 'nearside'] }))?.view === 5);

ok('a clean member view that is NOT side-on does not fire',
  r1SideOnClearView([G(5, 'false')], ZONES({ 5: ['rear'] })) === null);
ok('iv:na in a side-on frame does NOT fire — only a POSITIVE clean read counts',
  r1SideOnClearView([G(5, 'na')], ZONES({ 5: ['nearside'] })) === null);
ok('iv:true in a side-on frame does not fire',
  r1SideOnClearView([G(5, 'true', 'SEVERE')], ZONES({ 5: ['nearside'] })) === null);
ok('iv:missing in a side-on frame does not fire',
  r1SideOnClearView([G(5, 'missing')], ZONES({ 5: ['nearside'] })) === null);
ok('a member view with no frame-zone entry does not fire',
  r1SideOnClearView([G(5, 'false')], ZONES({ 2: ['nearside'] })) === null);

// Direction of error: silence keeps the money on. This is the whole safety argument for the rule.
ok('a FAILED frame-zone pass (ok:false) never fires — the panel stays costed',
  r1SideOnClearView([G(5, 'false')], { ok: false, frames: [] }) === null);
ok('a missing frame-zone object never fires',
  r1SideOnClearView([G(5, 'false')], null) === null && r1SideOnClearView([G(5, 'false')], undefined) === null);
ok('an absent stamp never fires (a pre-batch-160 entry, or a group that pushed no costed part)',
  r1SideOnClearView(undefined, ZONES({ 5: ['nearside'] })) === null && r1SideOnClearView([], ZONES({ 5: ['nearside'] })) === null);

// ── R1: the call site ───────────────────────────────────────────────────────────────────────────────
console.log('\n-- R1: where it is applied, and what the buyer gets --');
ok('it is scoped to REAR_QUARTER and FRONT_WING only',
  /if \(e\.panelId === PANEL\.REAR_QUARTER \|\| e\.panelId === PANEL\.FRONT_WING\) \{/.test(route));
ok('it runs BEFORE the band lookup — a band-less lot reaches the same answer',
  route.indexOf('const sideOnClear = r1SideOnClearView(') < route.indexOf('      if (!bandKey) {'));
ok('it runs AFTER the iv=false demotion skip — an already-demoted panel is not flagged twice',
  route.indexOf('[G INJECT] ${e.panelId} skipped — demoted') < route.indexOf('const sideOnClear = r1SideOnClearView('));
ok('it reads the entry stamp and the frame zones, and nothing else',
  /r1SideOnClearView\(e\._perViewGrades, assessment\._frameZones\)/.test(route));
// Ruling A: the model's Parts Breakdown is not an input to this decision. Assert it on the R1 block's
// CODE, with comments stripped — the block's own prose says the word, which is the point of saying it.
const R1_BLOCK = route.slice(route.indexOf('      if (e.panelId === PANEL.REAR_QUARTER'), route.indexOf('      if (!bandKey) {'));
const R1_CODE = R1_BLOCK.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
ok('ruling A honoured: no rawParts read anywhere in the R1 decision',
  R1_BLOCK.length > 200 && !/\brawParts\b/.test(R1_CODE));
ok('the model row is stripped too, so "no £ on the ledger" is literally true',
  /if \(gatedParts\[i\]\.panelId === e\.panelId\) \{ gatedParts\.splice\(i, 1\); r1Stripped\+\+; \}/.test(route));
ok('the entry is demoted (iv:false) so nothing downstream re-costs it',
  /e\.independentlyVisible = false;\s*\n\s*e\._r1SideOnClear = true;/.test(route));
ok('a high-weight Inspection Flags entry is pushed, carrying the marker',
  /coreObs\.flaggedParts\.push\(\{[\s\S]{0,240}_r1SideOnClear: true,/.test(route));
ok('the decision is logged with the view and its zones — never a silent removal',
  /\[G INJECT\]\[R1\] \$\{e\.panelId\} NOT costed — side-on view:/.test(route));

console.log('\n-- R1: the buyer wording, one owner --');
const WORD_REAR = 'Rear quarter: the close-up corner photos suggest damage, but the side-on photo shows the panel straight. Check the metal above the bumper line before bidding.';
const WORD_WING = 'Front wing: the close-up corner photos suggest damage, but the side-on photo shows the panel straight. Check the metal above the bumper line before bidding.';
ok('both strings live in ONE constant keyed by panelId', /const R1_SIDE_CLEAR_WORDING = \{/.test(route)
  && route.includes(`[PANEL.REAR_QUARTER]: '${WORD_REAR}'`) && route.includes(`[PANEL.FRONT_WING]:   '${WORD_WING}'`));
ok('the flag reason is read from that constant, never inlined',
  /reason:   R1_SIDE_CLEAR_WORDING\[e\.panelId\],/.test(route));
ok('the wording carries no £ and makes no claim the panel is sound',
  !/£/.test(WORD_REAR) && !/£/.test(WORD_WING) && /Check the metal above the bumper line before bidding\.$/.test(WORD_REAR));
ok('both panels have wording — a costed panel is never flagged with undefined',
  [PANEL.REAR_QUARTER, PANEL.FRONT_WING].every(p => route.includes(`[PANEL.${p}]`)));

// ── D: the HALT, pinned ─────────────────────────────────────────────────────────────────────────────
console.log('\n-- D: why R2 was NOT built (ruling D HALT condition) --');
ok('iv:missing is defined as the part being physically ABSENT, not out of frame',
  /- iv:missing — the part is ABSENT: torn away, not present where it should be/.test(route));
ok('the prompt says in terms that "not in this shot" is iv:na, NOT iv:missing',
  /"I don't see it\s*\n\s*\/\/?\s*in this shot" is iv:na, not iv:missing\.|in this shot" is iv:na, not iv:missing\./.test(route));
ok('no R2 rule was added — the probe FLOOR branch is untouched',
  !/severeVotes|_perViewGrades/.test(route.slice(route.indexOf('// FLOOR — only a verdict that POSITIVELY contradicts'),
    route.indexOf('// FLOOR — only a verdict that POSITIVELY contradicts') + 900)));

console.log(`\nbatch160: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
