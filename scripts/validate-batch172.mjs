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

// ── P2 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P2: the claim binder\'s two wrong drops --');
{
  const { bindClaimClasses } = await import('../lib/parts.mjs');
  // CK75ONW run 2 _narrativeBindings: both sentences were dropped (batch 170 T1.7, batch 171 P4 report).
  const RF = 'Rear chassis-leg/boot-floor structure cannot be confirmed from the photos behind the torn-away rear bumper — if the rear longitudinals or closing panel are deformed the repair carries structural work not itemised here; inspect before bidding.';
  const EX = 'The live retail figures (average ~£31k) frame a genuinely valuable donor/repair prospect, but the structural and battery uncertainty holds this off the upper steps.';
  if (RUN2) {
    ok('(fixture) run 2 dropped the Red Flags sentence as action', RUN2._narrativeBindings.some((b) => b.claimClass === 'action' && b.droppedSentence === RF));
    ok('(fixture) run 2 dropped the ~£31k sentence as figure', RUN2._narrativeBindings.some((b) => b.claimClass === 'figure' && b.droppedSentence === EX));
  }
  const ctx = { lampType: 'led', allowedFigures: [5625], partActions: [['Rear bumper', 'replace']], demoted: [], evVerdict: null };
  ok('action: "the repair carries structural work" (whole job) is no longer read as the rear bumper\'s action → kept',
    bindClaimClasses(`${RF} Second line.`, ctx, 'redflags').dropped.length === 0);
  ok('figure: the retail "~£31k" is a market figure → kept', bindClaimClasses(`${EX} Second line.`, ctx, 'speculation').dropped.length === 0);
  const d1 = bindClaimClasses('The rear bumper needs a repair. Second line.', ctx, 'redflags').dropped;
  ok('still caught: an action word bound to the part in the same clause', d1.length === 1 && d1[0].class === 'action');
  const d2 = bindClaimClasses('The rear bumper repair costs £2k. Second line.', ctx, 'speculation').dropped;
  ok('"£2k" reads as £2,000 (still caught — not in the ledger)', d2.length === 1 && /£2000 not in/.test(d2[0].reason));
  ok('"£5.6k" matches a £5,625 ledger figure? no — £5,600 is not within £1 → caught', bindClaimClasses('The repair costs £5.6k. Second line.', ctx, 'speculation').dropped.length === 1);
  ok('a figure the ledger carries is kept', bindClaimClasses('The repair costs £5,625. Second line.', ctx, 'speculation').dropped.length === 0);
  const d3 = bindClaimClasses('Budget diagnostic time (£100–£300 per fault code area) before bidding. Second line.', ctx, 'redflags').dropped;
  ok('a budget is a cost context — an off-ledger diagnostic figure is still dropped (SA26KVT Red Flags)', d3.length === 1 && d3[0].class === 'figure');
  ok('trade / valuation / average figures are never checked', bindClaimClasses('The trade valuation averages £9,000 against repair costs. Second line.', ctx, 'speculation').dropped.length === 0);
}

console.log(`\nbatch172: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
