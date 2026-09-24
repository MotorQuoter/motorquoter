// validate-batch187.mjs — batch 187 P1: a full stop inside a number or an abbreviation is not a sentence end, and the
// claim binder cuts dropped sentences out of the original text instead of re-joining pieces. £0, pure, no model calls.
// (P2 is a read-only recon: nothing built.)
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch187.mjs
import { readFileSync } from 'fs';
import { splitSentencesForTest as split, bindClaimClasses } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const J = JSON.stringify;
// a ctx that contradicts nothing, and one whose only allowed repair figure is £100 (so a £999 repair claim is dropped)
const NONE = { lampType: null, allowedFigures: [], partActions: [], evVerdict: null };
const FIG = { ...NONE, allowedFigures: [100] };
const BAD = 'The repair costs £999 in total.';

console.log('\n-- the split rule --');
for (const s of ['2.2', '1.0', 'ID.4', 'ID. 4', 'c. 41,700', 'c.41,700']) {
  const t = `The car is a ${s} model today.`;
  ok(`"${s}" is not split`, J(split(t)) === J([t]));
}
ok('"Rear bumper torn. The quarter is clean." splits in two', J(split('Rear bumper torn. The quarter is clean.')) === J(['Rear bumper torn.', 'The quarter is clean.']));
ok('stated: "e.g. The" DOES split (an uppercase letter follows the stop) — as before batch 187', J(split('Parts e.g. The bumper.')) === J(['Parts e.g.', 'The bumper.']));
ok('a stop before a line break ends the sentence', J(split('Bumper torn.\nand more')) === J(['Bumper torn.', 'and more']));
ok('a stop followed by a closing bracket, then a capital', J(split('Bumper (torn.) The quarter.')) === J(['Bumper (torn.)', 'The quarter.']));
ok('"!" and "?" still end a sentence before a capital', J(split('Torn! Is it? Yes.')) === J(['Torn!', 'Is it?', 'Yes.']));
ok('end of text with no stop is a sentence', J(split('No stop here')) === J(['No stop here']));

console.log('\n-- the binder keeps the original text --');
{
  const t = 'This is a 2017 Hyundai Santa Fe 2.2 CRDi (c. 41,700 miles).  Two spaces kept.\n\n- Bullet one: fine.\n- Bullet two: fine.';
  ok('nothing dropped → the text comes back byte-identical (double space, blank line, bullets)', bindClaimClasses(t, NONE, 'redflags').text === t);
  const p = `First sentence 2.2 here.  ${BAD}  Third sentence ID.4 here.\n- Bullet kept.\n\n- Other bullet.`;
  const r = bindClaimClasses(p, FIG, 'redflags');
  ok('a dropped middle sentence is cut; the gap before the next sentence and every other line are untouched',
    r.text === 'First sentence 2.2 here.  Third sentence ID.4 here.\n- Bullet kept.\n\n- Other bullet.' && r.dropped.length === 1);
  const q = `Kept one. ${BAD}`;
  ok('a dropped last sentence takes the gap before it', bindClaimClasses(q, FIG, 'redflags').text === 'Kept one.');
  const q2 = `Kept one. ${BAD} ${BAD}`;
  ok('two dropped sentences in a row at the end of a line', bindClaimClasses(q2, FIG, 'redflags').text === 'Kept one.');
  const b = `Intro line.\n- Bullet one: fine.\n- Bullet two: ${BAD} Factor it in.\n- Bullet three: fine.`;
  ok('a bullet losing its claim sentence goes whole (C4); the other bullets and markers are byte-identical',
    bindClaimClasses(b, FIG, 'redflags').text === 'Intro line.\n- Bullet one: fine.\n- Bullet three: fine.');
  const w = `Line one.\n\n${BAD}\n\nLine three.`;
  ok('a dropped whole line between blank lines leaves one blank line', bindClaimClasses(w, FIG, 'redflags').text === 'Line one.\n\nLine three.');
  ok('every sentence dropped → kept whole (batch 136 C2, unchanged)', bindClaimClasses(BAD, FIG, 'redflags').keptWhole?.length === 1);
}

console.log('\n-- the three lots, VDS verbatim (the model\'s text, from the cassette) --');
{
  const EA = 'This is a 2017 Hyundai Santa Fe 2.2 CRDi diesel automatic 7-seat estate on very high mileage (~156k), presenting a single front-corner impact — front bumper displaced and the slam-panel/bumper support disturbed, exposing the front-corner recess — with separate light body-side scuffing rearward and a broken-off door mirror cap on the same flank. The headlamp at the struck corner reads intact and undisturbed in the close photos; the biggest unseeable cost risk is the condition of the cooling pack, mirror unit internals and any structural support behind the displaced bumper, none of which can be confirmed from the photographs.';
  const SF = 'This is a 2019 Honda Civic 1.0 VTEC Turbo Sport Line 5-door manual, low-mileage for age (c.41,700) and a desirable current-generation hatch, carrying two separate impacts — a full-width front hit that displaced the front bumper and grille and exposed the radiator/slam-panel area, and a distinct rear-corner impact that displaced the rear bumper and exposed the mounting recess. The biggest unseeable risk is the front structural integrity behind the slam panel and radiator support, and front headlamp serviceability cannot be confirmed from the photos — the bumper is displaced with the lamp apertures exposed, so both front lamps default to inclusion.';
  const YH = 'A near-new 2023 VW ID.4 Pure (52kWh) BEV at just 14,641 miles, presenting with a single full-width frontal impact: the front bumper, grille and fog lamp are stripped from the car, a front wing is creased and the front-end structure behind the bumper is exposed. The biggest unseeable risk is HV battery/inverter and front-structure integrity behind the slam panel on this front-struck EV — and one front headlamp\'s serviceability cannot be confirmed from the photos (bumper displaced, aperture exposed), so it is carried as an allowance rather than confirmed intact.';
  for (const [lot, t] of [['EA17HDN', EA], ['SF69YBB', SF], ['YH23NVW', YH]]) {
    ok(`(${lot}) VDS through the binder comes back exactly as written`, bindClaimClasses(t, NONE, 'redflags').text === t);
    ok(`(${lot}) two sentences`, split(t).length === 2);
  }
}

console.log('\n-- wiring --');
{
  const parts = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');
  const bind = parts.slice(parts.indexOf('export function bindClaimClasses'), parts.indexOf('// Builds the buyer-facing Inspection Flags list'));
  ok('bindClaimClasses no longer re-joins kept sentences with " "', !/kept\.join\(' '\)/.test(bind));
  ok('bindClaimClasses returns the given text when nothing was dropped', bind.includes('if (!edited) return { text, dropped };'));
}

console.log(`\nbatch187: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
