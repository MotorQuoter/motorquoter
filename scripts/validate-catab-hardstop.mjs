// Validator — Cat A / Cat B hard stop (batch 71 FIX 1). £0: no supplier call, no vision.
//
// Category A (scrap/crush) and Category B (break/dismantle) can never return to the road. The prompt
// (assessmentEngine.js §241/243) tells the MODEL to refuse a repair estimate + whole-vehicle exit
// valuation — but that is the model obeying a prompt, and computeExitFromBand treats an unknown band
// (INCLUDING A/B) as Cat S, so absent a code gate the engine WOULD price one. This validator proves:
//   (A) BEHAVIOURAL — extracts the real catLetter + catABHardStopLetter from route.js and proves A/B
//       fire the stop while S/N/U/null never do (no over-firing, no null-category misfire).
//   (B) STRUCTURAL — the gate is wired: it nulls the whole-vehicle money outputs and the exit,
//       margin, SalvageGuide and investment blocks are all guarded on !_catAB.
//
// Run: node scripts/validate-catab-hardstop.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const src = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');

// ── Extract the real pure functions (catLetter + catABHardStopLetter) from the shipped source ──────
const catLetterSrc = src.match(/function catLetter\(s\) \{[\s\S]*?\n\}/);
const stopSrc      = src.match(/function catABHardStopLetter\(categoryStr\) \{[\s\S]*?\n\}/);
if (!catLetterSrc || !stopSrc) { console.log('  FAIL — could not extract catLetter / catABHardStopLetter'); process.exit(1); }
const catABHardStopLetter = new Function(`${catLetterSrc[0]}\n${stopSrc[0]}\nreturn catABHardStopLetter;`)();

// ── (A) BEHAVIOURAL ─────────────────────────────────────────────────────────────────────────────
console.log('\n(A) catABHardStopLetter fires on A/B only');
ok("'A' → a",                         catABHardStopLetter('A') === 'a');
ok("'B' → b",                         catABHardStopLetter('B') === 'b');
ok("'Category A' → a",                catABHardStopLetter('Category A') === 'a');
ok("'Cat B' → b",                     catABHardStopLetter('Cat B') === 'b');
ok("'A REPAIRABLE...' → a (letter form)", catABHardStopLetter('A repairable') === 'a');
ok("'S REPAIRABLE STRUCTURAL' → null", catABHardStopLetter('S REPAIRABLE STRUCTURAL') === null);
ok("'Cat S' → null",                  catABHardStopLetter('Cat S') === null);
ok("'N' → null",                      catABHardStopLetter('N') === null);
ok("'U - Used Unrecorded' → null",    catABHardStopLetter('U - Used Unrecorded') === null);
ok('null category → null (never misfires)', catABHardStopLetter(null) === null);
ok("'' → null",                       catABHardStopLetter('') === null);

// ── (B) STRUCTURAL — the gate is wired and the money blocks are guarded ────────────────────────────
console.log('\n(B) the hard stop is wired on every whole-vehicle money output');
ok('CAT_AB_STOP has an A message naming crushed/scrap',       /CAT_AB_STOP\s*=\s*\{[\s\S]*?a:\s*'Category A[\s\S]*?crushed/.test(src));
ok('CAT_AB_STOP has a B message naming licensed dismantlers', /b:\s*'Category B[\s\S]*?licensed dismantlers/.test(src));
ok('gate computes _catAB from the recorded category',         /const _catAB = catABHardStopLetter\(enrichedVd\.category\)/.test(src));
ok('gate nulls the whole-vehicle exit value',                 /if \(_catAB\)[\s\S]{0,600}assessment\._exitValue\s*=\s*null/.test(src));
ok('gate nulls the margin ladder',                            /if \(_catAB\)[\s\S]{0,600}assessment\._marginScenarios\s*=\s*null/.test(src));
ok('gate states the stop in Realistic Exit Value',            /if \(_catAB\)[\s\S]{0,400}assessment\['Realistic Exit Value'\]\s*=\s*_stop/.test(src));
ok('exit-band computation is guarded on !_catAB',             /if \(!_catAB && bregoData\?\.trade_low_valuation\)/.test(src));
ok('margin computation is guarded on !_catAB',                /if \(!_catAB && feeStackFn && parts_sum > 0 && exitValue != null\)/.test(src));
ok('SalvageGuide cross-check is guarded on !_catAB',          /if \(!_catAB && enrichedVd\.salvageGuide\)/.test(src));
ok('investment block is guarded on !_catAB',                  /batch 71 FIX 1[\s\S]{0,120}if \(!_catAB\) try \{/.test(src));
// The reason the gate is needed: the band maps unknown (incl. A/B) to Cat S.
ok('computeExitFromBand maps unknown band to Cat S (why the gate exists)', /const band = cat === 'n' \? 'n' : 's';/.test(src));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
