// Unit tests for lib/flooredProseScrub.mjs — deterministic, £0 (no vision, no I/O).
// Cases drawn from real over-assertions in the harness dumps (_cc/a2runs). Run:
//   node scripts/validate-floored-scrub.mjs
import { scrubKCD, scrubFlooredProse, panelKeywords } from '../lib/flooredProseScrub.mjs';

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

// ---- VDS: the neutraliser was removed in batch 188 (Vincent, 24 Sep) — its tests are deleted ----
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
ok('end-to-end: the VDS passes through unchanged (batch 188)', assess['Visible Damage Summary'] === 'Side impact with structure behind the crushed outer sill unconfirmed.');
ok('end-to-end reports the dropped bullet', res.kcdDropped.length === 1);

// ── batch 158 A4 — THE DRIVERS ARE BUILT ONLY FROM COSTED LEDGER ROWS ─────────────────────
// Two sources feed the report's Key Cost Drivers: the code-owned _kcdParts (assembleKcdParts — costed
// rows only, by construction) and the MODEL's free text, rendered as judgement colour on both surfaces.
// Only the second can contradict the ledger, and it was only checked against panels that had a damage
// CARD. A panel with no card was in neither set, and on a lot with no inspection-only card the scrub did
// not run at all.
{
  const withLedger = {
    _reconciledParts: [
      { panelId: 'REAR_BUMPER', name: 'Rear bumper', action: 'replace', oem: 655, used: 360 },
      { panelId: 'BOOT_LID', name: 'Tailgate', action: 'repair', oem: null, used: null, _repairNoPart: true },
    ],
    'Key Cost Drivers': [
      '- Rear bumper: torn away at the corner, replacement.',
      '- Front bumper: displaced upper section requiring replacement.',
      '- Boot lid: creased at the rear edge, straighten and refinish.',
    ].join('\n'),
    'Visible Damage Summary': 'Rear corner impact.',
  };
  const r158 = scrubFlooredProse(withLedger);
  ok('A4: a driver naming a panel the ledger does not cost is dropped',
     !/Front bumper/.test(withLedger['Key Cost Drivers']) && r158.kcdDropped.length === 1);
  ok('A4: a driver naming a costed panel is kept', /Rear bumper/.test(withLedger['Key Cost Drivers']));
  ok('A4: a panel costed as a £0 repair counts as costed', /Boot lid/.test(withLedger['Key Cost Drivers']));
  ok('A4: it runs even with no inspection-only damage card at all', r158.kcdDropped.length > 0);

  const both = { _reconciledParts: withLedger._reconciledParts,
    'Key Cost Drivers': '- Rear bumper and front bumper: both ends struck.', 'Visible Damage Summary': '' };
  scrubFlooredProse(both);
  ok('A4: a line naming a costed panel too is never dropped', /front bumper/i.test(both['Key Cost Drivers']));

  const noLedger = { 'Key Cost Drivers': '- Front bumper: replacement.', 'Visible Damage Summary': '' };
  scrubFlooredProse(noLedger);
  ok('A4: with no ledger to judge against, nothing is scrubbed', /Front bumper/.test(noLedger['Key Cost Drivers']));
}

console.log(`\n${failed === 0 ? '✅' : '❌'} floored-scrub: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
