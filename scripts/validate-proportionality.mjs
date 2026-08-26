// Validator — category-vs-damage proportionality (batch 71 FIX 2). £0: no supplier call, no vision.
//
// buildProvenanceContradictionSlot certifies '"Why is it here?" — story holds together'. Before this
// fix its three non-pass paths (too-clean pattern / non-insurer C-Q on Cat U-S / model prose) never
// compared the recorded category's SEVERITY against the costed visible damage, so a Cat S structural
// write-off with trim-only damage (EN23NJX) fell straight through to verdict:'confirmed'. The line-253
// proportionality test lived ONLY in model prose and was never enforced by anything. This adds a
// fourth CODE path. The function is not exported and depends on buildSlot/qc helpers/constants, so the
// assertions are structural against the shipped source.
//
// Run: node scripts/validate-proportionality.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const src = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');

// Isolate the buildProvenanceContradictionSlot function body for path-order assertions.
const fn = (src.match(/function buildProvenanceContradictionSlot\([\s\S]*?\n\}\n/) || [''])[0];
const has = (re) => re.test(src);
const inFn = (re) => re.test(fn);

console.log('\nproportionality — the fourth code path exists and is ordered right');
ok('threshold constant PROVENANCE_STRUCTURAL_MIN_COSTED is defined', /const PROVENANCE_STRUCTURAL_MIN_COSTED = \d+;/.test(src));
ok('slot function accepts a costedDamageSum parameter', /function buildProvenanceContradictionSlot\([^)]*costedDamageSum/.test(src));
ok('the fourth path tests a STRUCTURAL category (S or B)', inFn(/\['s', 'b'\]\.includes\(catLetter\(enrichedVd\.category/));
ok('it gates on costed damage <= the threshold', inFn(/costedDamageSum <= PROVENANCE_STRUCTURAL_MIN_COSTED/));
ok('a null costedDamageSum does not fire it (guarded)', inFn(/costedDamageSum != null && costedDamageSum <= PROVENANCE_STRUCTURAL_MIN_COSTED/));
ok('the fourth path returns a discrepancy, NOT confirmed', inFn(/category not explained by visible damage[\s\S]{0,160}verdict: 'discrepancy'/));
// The line-253 wording, verbatim (the whole point — it is finally enforced).
ok('carries the verbatim line-253 wording', src.includes('The visible damage does not fully explain this write-off — structural or other components not visible in these photos should be inspected before bidding.'));
ok('the verbatim wording is also in assessmentEngine.js:253 (source of truth)',
  readFileSync(join(ROOT, 'config/assessmentEngine.js'), 'utf8').includes('The visible damage does not fully explain this write-off'));
// Ordering: the proportionality path must sit BEFORE the final 'story holds together' confirmed return.
// Both marker strings are unique in the file, so order in `src` is order in the function.
ok('proportionality path precedes the confirmed "story holds together" return',
  src.indexOf('category not explained by visible damage') > 0 &&
  src.indexOf('category not explained by visible damage') < src.indexOf("— story holds together',"));
// The costed total is actually threaded in from the reconciled parts sum.
ok('parts_sum is threaded through buildIdentityGroup', /buildIdentityGroup\(enrichedVd, coreObs, brMileage, brAgeYears, proseFlags, parts_sum\)/.test(src));
ok('buildIdentityGroup forwards it to the slot', /buildProvenanceContradictionSlot\(enrichedVd, vendorSuffix, brMileage, brAgeYears, proseFlags, costedDamageSum\)/.test(src));
// Guard against regression: the pre-fix "confirmed" fall-through still exists for the proportionate case.
ok('the confirmed "story holds together" path is retained for proportionate lots', has(/story holds together'[\s\S]{0,120}verdict: 'confirmed'/));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
