// Validator — batch 107: the §4 bumper-off LIMIT NOTE must fire on EITHER derivation, and a panel
// carrying it must not be offered for sale.
//
// The defect: batch 103 §4 states the limit plainly ("the bumper is torn away … strike the line if the
// inspection shows it sound") but was gated on the MONEY-path read. On SF69YBB that read says the rear
// bumper is PRESENT when it is torn from the body, so the note never fired — and the buyer got
// "seriously impact-damaged … requiring replacement" asserted as fact, plus an eBay link, on a panel
// the ground truth says is UNDAMAGED. A phantom is only cheap when the buyer is told it might be one.
//
// The fix keeps the presence read on the money (it wins the accuracy count 3/4) and fires the NOTE when
// EITHER derivation says the bumper is off. The note costs nothing, deletes nothing and demotes nothing,
// so a false positive is mild noise while a false negative is a confident phantom with a shopping link.
//
// £0 — source-wiring assertions always run; the fixture assertions replay nothing and are SKIPPED when
// the dumps are absent (they are gitignored, like the ledger-edits baseline).
//
// Run: node scripts/validate-bumper-limit-note.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}`); fail++; }
};

const route = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');

console.log('\nA. WIRING — the note reads the note-only signal, and legacy never reaches the money');
ok('the §4 loop is gated on _frontBumperOffAny / _rearBumperOffAny',
   route.includes('[assessment._frontBumperOffAny, PANEL.FRONT_WING')
   && route.includes('[assessment._rearBumperOffAny,  PANEL.REAR_QUARTER'));
ok('the note-only signal is the OR of both derivations',
   route.includes('assessment._frontBumperOffAny = _frontOffNew || _frontOffLegacy')
   && route.includes('assessment._rearBumperOffAny  = _rearOffNew  || _rearOffLegacy'));
ok('the MONEY path still uses the presence read (legacy only under the dev A/B toggle)',
   route.includes('const frontBumperOff = _bumperLegacy ? _frontOffLegacy : _frontOffNew;')
   && route.includes('const rearBumperOff  = _bumperLegacy ? _rearOffLegacy  : _rearOffNew;'));
{
  // The legacy values must appear ONLY where they are defined, in the dev toggle, and in the note-only
  // OR. Any other use is legacy touching something it must not.
  const uses = (route.match(/_frontOffLegacy|_rearOffLegacy/g) || []).length;
  ok(`legacy derivation is referenced exactly 6 times (2 definitions, 2 toggle, 2 note-only) — got ${uses}`,
     uses === 6);
}
ok('a panel carrying the §4 limit note is excluded from Parts Sourcing',
   route.includes('!_bumperOffLimitPanels.has(p.panelId)'));
ok('the excluded set is built from the _bumperOffLimit flags',
   route.includes("(assessment._flaggedParts || []).filter(f => f._bumperOffLimit && f.panelId)"));

// ── Fixture assertions (dumps gitignored; SKIP if absent) ─────────────────────────────────────────
const DUMPS = join(ROOT, '_cc/sweep/v107');
const load = (vrm) => {
  const p = join(DUMPS, `v107_${vrm}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const noteFor = (a, zone) => (a._flaggedParts || []).some((f) => f._bumperOffLimit && f.zone === zone);
const linked  = (a, name) => ((a._partsSourcing && a._partsSourcing.links) || [])
  .some((l) => String(l.name || l.part || '').toLowerCase() === name.toLowerCase());

console.log('\nB. FIXTURE BEHAVIOUR (£0 replay dumps; SKIP if absent)');
const ak = load('AK75RDX'), amz = load('AMZ3790'), dl = load('DL72FVX');
if (!ak || !amz || !dl) {
  console.log('  SKIP — dumps absent; run the three £0 cassette replays with --dump into _cc/sweep/v107/');
} else {
  // 1. THE REGRESSION TEST. AK75RDX front: legacy says OFF, the presence read says ON, wing costed.
  ok('AK75RDX: presence read says the front bumper is ON (money path unchanged)',
     ak._frontBumperOff === false);
  ok('AK75RDX: the note-only signal still says OFF (legacy limb)', ak._frontBumperOffAny === true);
  ok('AK75RDX: the limit note IS present on the front despite the money read saying ON',
     noteFor(ak, 'front'));
  ok('AK75RDX: the front wing STAYS COSTED (the note removes no money)',
     (ak._reconciledParts || []).some((p) => p.panelId === 'FRONT_WING' && (p.used ?? p.oem ?? 0) > 0));
  ok('AK75RDX: no eBay link on the limited front wing', !linked(ak, 'Front wing'));

  // 2. Both derivations agree the bumper is off — unchanged behaviour.
  ok('AMZ3790: both derivations say the front bumper is off',
     amz._frontBumperOff === true && amz._frontBumperOffAny === true);
  ok('AMZ3790: limit note present, front wing costed, no eBay link',
     noteFor(amz, 'front')
     && (amz._reconciledParts || []).some((p) => p.panelId === 'FRONT_WING' && (p.used ?? p.oem ?? 0) > 0)
     && !linked(amz, 'Front wing'));

  // 3/4. Both say ON at an end → NO note at that end. Stops it firing on every car.
  ok('AK75RDX: both derivations say the REAR bumper is on → no rear note',
     ak._rearBumperOffAny === false && !noteFor(ak, 'rear'));
  ok('DL72FVX: both derivations say the FRONT bumper is on → no front note',
     dl._frontBumperOffAny === false && !noteFor(dl, 'front'));

  // THE LOT IT WAS ALL WRITTEN FOR. SF69YBB's rear bumper is torn from the body; the presence read says
  // PRESENT, so the money path is wrong AND the note used to be suppressed with it. Ground truth says the
  // quarter behind it is UNDAMAGED, so this is the exact shape that must never ship again: costed, but
  // stated as unconfirmed and strikeable, and never offered for sale.
  const sf = load('SF69YBB');
  if (!sf) {
    console.log('  SKIP — SF69YBB dump absent (its cassette is overwritten by whichever tree ran last)');
  } else {
    ok('SF69YBB: the presence read still says the rear bumper is ON (money path untouched)',
       sf._rearBumperOff === false);
    ok('SF69YBB: the note-only signal catches it via the legacy limb', sf._rearBumperOffAny === true);
    ok('SF69YBB: the limit note IS present on the rear quarter', noteFor(sf, 'rear'));
    ok('SF69YBB: the quarter STAYS COSTED — Vincent ruled it stays and the buyer strikes it',
       (sf._reconciledParts || []).some((p) => p.panelId === 'REAR_QUARTER' && (p.used ?? p.oem ?? 0) > 0));
    ok('SF69YBB: NO eBay link on the quarter we have just said we cannot confirm',
       !linked(sf, 'Rear quarter panel'));
    ok('SF69YBB: the Damage Breakdown card carries the limit, not a bare "Severe / replace"',
       (sf._damageCards || []).some((c) => /quarter/i.test(c.part || '') && /torn away/.test(c.note || '')));
  }

  // 5. Legacy must not alter a money figure. These are the engine's own totals from the same
  //    cassettes before and after the change; they are asserted as the exact known values.
  ok('money unmoved by the note: AK75RDX 8015 · AMZ3790 4900 · DL72FVX 2070',
     ak._partsReconciliation.parts_sum === 8015
     && amz._partsReconciliation.parts_sum === 4900
     && dl._partsReconciliation.parts_sum === 2070);
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
