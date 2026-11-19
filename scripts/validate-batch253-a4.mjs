// Validator — batch 253 A4: the prose-damage check never matches the word "other" (OTHER is left out of its panel list). £0.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch253-a4.mjs
import { findProseDamageUncosted } from '../lib/parts.mjs';
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const panels = [{ panelId: 'OTHER', name: 'Other' }, { panelId: 'BONNET', name: 'Bonnet' }];
// the two corpus sentences that used to raise "The report describes damage to the Other …"
const SD = 'Damage severity pulls the other way.';
const GF = 'Labour and paint: a full front rebuild — bumper, bonnet (torn at the vent and creased at the opposite front corner) and both wings (one crushed back to the door edge, the other folded at its front tip) — on a black finish that needs blending.';
ok('SD75YGC sentence: no OTHER hit', !findProseDamageUncosted(SD, panels).some(h => h.panelId === 'OTHER'));
ok('GF25WHJ sentence: no OTHER hit', !findProseDamageUncosted(GF, panels).some(h => h.panelId === 'OTHER'));
ok('a named panel in the same text is still found (bonnet torn)', findProseDamageUncosted(GF, panels).some(h => h.panelId === 'BONNET'));
ok('OTHER is never matched, whatever its name says', findProseDamageUncosted('The underside is badly damaged.', [{ panelId: 'OTHER', name: 'Underside' }]).length === 0);
console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
