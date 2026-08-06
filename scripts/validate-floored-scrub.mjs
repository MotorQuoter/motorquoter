// Unit tests for lib/flooredProseScrub.mjs — deterministic, £0 (no vision, no I/O).
// Cases drawn from real over-assertions in the harness dumps (_cc/a2runs). Run:
//   node scripts/validate-floored-scrub.mjs
import { scrubKCD, neutraliseVDS, scrubFlooredProse, panelKeywords } from '../lib/flooredProseScrub.mjs';

let passed = 0, failed = 0;
const ok = (label, cond) => { if (cond) { console.log(`  PASS  ${label}`); passed++; } else { console.error(`  FAIL  ${label}`); failed++; } };

// Real DMZ4614_3 sets: Sill/structures/bumper/radiator FLOORED; doors/wing/skirt/quarter COSTED.
const floored = ['Sill', 'Front bumper', 'Side structure', 'Front structure', 'Radiator pack', 'SRS airbag (deployed)'];
const costed = ['Side skirt', 'Front wing', 'Front door', 'Rear door', 'Rear quarter panel'];

// ---- KCD line-drop ----
const kcd = [
  '- Front and rear doors: both door skins are creased and dented along the impact line — two doors plus paint is the largest single cost.',
  '- Structural sill: the outer sill/rocker is crushed along its length, requiring straightening and structural repair.',
].join('\n');
const rk = scrubKCD(kcd, floored, costed);
ok('KCD drops the floored SILL driver line', !/Structural sill/.test(rk.text) && rk.dropped.length === 1);
ok('KCD keeps the costed doors line (even though it says "creased")', /Front and rear doors/.test(rk.text));
ok('KCD reports what it dropped', /sill/i.test(rk.dropped[0] || ''));

// Multi-panel line naming a COSTED panel must be kept (no over-scrub).
const kcd2 = '- Front wing and slam panel: wing deformation plus tie-bar work drives cost.';
ok('KCD keeps a line that names a costed panel (Front wing) alongside a floored one',
  scrubKCD(kcd2, ['Slam panel'], ['Front wing']).text.includes('Front wing and slam panel'));

// A genuinely floored-only driver with a different lead noun.
ok('KCD drops a floored "Radiator pack" driver',
  scrubKCD('- Radiator pack: rad and condenser crushed, full front-end replacement.', floored, costed).dropped.length === 1);

// Non-bullet lines and empty input pass through untouched.
ok('KCD leaves header/format lines untouched', scrubKCD('Format:\n- Structural sill: crushed.', floored, costed).text.startsWith('Format:'));
ok('KCD handles empty input', scrubKCD('', floored, costed).text === '');

// ---- VDS neutralise ----
const vds1 = 'The deciding unseeable risk is inner-sill integrity behind the crushed outer sill and the intact doors.';
const rv1 = neutraliseVDS(vds1, floored, costed);
ok('VDS strips "crushed" qualifying the floored sill', !/crushed/.test(rv1.text) && /outer sill/.test(rv1.text));
ok('VDS records the change', rv1.changes.length >= 1);

// Costed panel adjective must be LEFT ALONE (front door is costed here).
const vds2 = 'A full-flank impact with the front door creased and the rear quarter folded.';
ok('VDS leaves a costed panel\'s adjective untouched (front door "creased")',
  /front door creased/.test(neutraliseVDS(vds2, floored, costed).text));

// Floored front wing (per some runs) SHOULD be neutralised.
const vds3 = 'headlamp displaced at one corner, front wing crushed back, running down the flank.';
ok('VDS strips "crushed" after a floored front wing',
  !/crushed/.test(neutraliseVDS(vds3, ['Front wing', 'Sill'], ['Front door']).text));

// No floored panels → no change at all.
ok('VDS no-ops when nothing is floored', neutraliseVDS(vds1, [], costed).text === vds1);

// Synonym: "rocker" is the sill — a floored SILL described "folded rocker" must be caught.
ok('VDS catches "folded rocker" for a floored Sill (synonym)',
  !/folded/.test(neutraliseVDS('structure beneath the folded rocker cannot be confirmed.', ['Sill'], costed).text));
ok('panelKeywords expands sill→rocker', panelKeywords('Sill').includes('rocker'));

// ---- panelKeywords sanity ----
ok('panelKeywords strips qualifiers/generics', JSON.stringify(panelKeywords('Front structure')) === JSON.stringify(['structure']));
ok('panelKeywords drops parenthetical', !panelKeywords('SRS airbag (deployed)').includes('deployed'));

// ---- end-to-end on an assessment object ----
const assess = {
  _damageCards: [
    { part: 'Front door', action: 'replace', cost: 330 },
    { part: 'Sill', action: 'inspect', cost: 0 },
  ],
  'Key Cost Drivers': '- Front door: replacement panel.\n- Structural sill: outer sill crushed along its length.',
  'Visible Damage Summary': 'Side impact with structure behind the crushed outer sill unconfirmed.',
};
const res = scrubFlooredProse(assess);
ok('end-to-end drops floored sill KCD line', !/Structural sill/.test(assess['Key Cost Drivers']));
ok('end-to-end keeps costed door KCD line', /Front door/.test(assess['Key Cost Drivers']));
ok('end-to-end neutralises VDS crushed-sill', !/crushed/.test(assess['Visible Damage Summary']));
ok('end-to-end reports actions', res.kcdDropped.length === 1 && res.vdsChanges.length === 1);

console.log(`\n${failed === 0 ? '✅' : '❌'} floored-scrub: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
