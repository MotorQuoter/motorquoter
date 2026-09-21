// validate-batch172.mjs — batch 172: wording and binder fixes left over from batch 171. £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch172.mjs
import { readFileSync, existsSync } from 'fs';
import { attribFlagWording, ATTRIB_MINOR_COSMETIC_WORDING } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const RUN2_PATH = new URL('../_cc/scratch/b170/row-f75db268.json', import.meta.url);
const RUN2 = existsSync(RUN2_PATH) ? JSON.parse(readFileSync(RUN2_PATH, 'utf8')).assessment : null;

// ── P1 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P1: a probe-floored panel\'s flag says what the probe saw --');
{
  if (RUN2) {
    const p = RUN2._attributionProbe.panels.find((x) => x.panelId === 'FRONT_BUMPER');
    ok('(fixture) run 2: FRONT_BUMPER probe verdict minor-cosmetic, floored', p?.verdict === 'minor-cosmetic' && p?.action === 'floored');
    ok('(fixture) run 2 showed the old wording', RUN2._flaggedParts.some((f) => f.panelId === 'FRONT_BUMPER' && /^Serious damage to the Front bumper was recorded/.test(f.reason)));
  }
  const w = attribFlagWording('Front bumper', 'SEVERE', false, 'minor-cosmetic');
  ok('run 2 front bumper (SEVERE grade, minor-cosmetic) → the light-marking wording, verbatim',
    w === 'The photos show at most light marking on the Front bumper — not included in the repair total; check it on inspection.');
  ok('…never "Serious damage" or "could not be photographically confirmed"', !/Serious damage|photographically confirmed/.test(w));
  ok('another verdict keeps today\'s wording (SEVERE)', attribFlagWording('Front wing', 'SEVERE', false, 'no-damage-visible').startsWith('Serious damage to the Front wing was recorded during assessment'));
  ok('another verdict keeps today\'s wording (MODERATE)', attribFlagWording('Front wing', 'MODERATE', false, 'panel-not-visible').startsWith('Damage to the Front wing was recorded'));
  ok('the missing-claim wording is unchanged for other verdicts', /recorded as missing during assessment/.test(attribFlagWording('Rear bumper', 'SEVERE', true, 'present-undamaged')));
  ok('no verdict passed (older callers) → today\'s wording', attribFlagWording('Bonnet', 'SEVERE', false).startsWith('Serious damage to the Bonnet'));
  ok('the one wording owner is used for minor-cosmetic', ATTRIB_MINOR_COSMETIC_WORDING('X') === attribFlagWording('X', 'MINOR', false, 'minor-cosmetic'));
  ok('route passes the probe verdict into the wording', route.includes('attribFlagWording(PANEL_DISPLAY[cp.panelId], grade, missing, r?.verdict ?? null)'));
}

console.log(`\nbatch172: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
