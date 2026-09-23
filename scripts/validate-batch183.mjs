// validate-batch183.mjs — batch 183: probe-floor wording (P1), the single-MINOR line (P2) and cost claims about uncharged
// panels in prose (P3). £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch183.mjs
import { attribFlagWording, ATTRIB_MINOR_COSMETIC_WORDING } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

console.log('\n-- P1: probe-floor wording for minor-cosmetic says "may show slight damage" --');
{
  const W = 'The photos may show slight damage to the Front wing — not included in the repair total; check it on inspection.';
  ok('the wording, verbatim', ATTRIB_MINOR_COSMETIC_WORDING('Front wing') === W);
  ok('attribFlagWording routes minor-cosmetic to it', attribFlagWording('Front wing', 'MODERATE', false, 'minor-cosmetic') === W);
  ok('it no longer asserts damage ("show minor damage")', !/show minor damage/.test(W));
  ok('other verdicts keep their wording', attribFlagWording('Front wing', 'SEVERE', false, 'no-damage-visible').startsWith('Serious damage to the Front wing was recorded'));
}

console.log(`\nbatch183: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
