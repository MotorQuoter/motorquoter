// Validator — batch 254 item 1: the bumper reinforcement is charged only when the front bumper is off / missing / torn open
// (Vincent R2, 19 Nov; batch 255 R1: bumper charged AND the beam's probe confirmed it); a charged undertray always carries its strike note. £0, no live call.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch254-beam.mjs
import { readFileSync } from 'node:fs';
import { enforceBeamSeenOnly, frontBumperCharged, beamProbeConfirmed, seedChecklistFromFlags, rewordDisputedFlags, buildBuyerFlags,
  BEAM_NOT_SEEN_REASON, UNDERTRAY_STRIKE_REASON } from '../lib/parts.mjs';
import { buildDamageCards } from '../lib/damageCards.mjs';
import { isChargedRow } from '../lib/ledgerEdits.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const beam = () => ({ panelId: 'FRONT_BUMPER_REINFORCEMENT', name: 'Bumper reinforcement', action: 'replace', oem: 180, used: 90 });
const tray = () => ({ panelId: 'UNDERTRAY', name: 'Undertray', action: 'replace', oem: 80, used: 40 });
const fb = (action, extra = {}) => ({ panelId: 'FRONT_BUMPER', name: 'Front bumper', action, oem: 400, used: 200, ...extra });

console.log('\n1. The wording (Vincent / Cowork, verbatim)');
ok('beam line', BEAM_NOT_SEEN_REASON === 'The bumper reinforcement cannot be seen behind the bumper. It is not in the repair total. Check it on inspection.');
ok('undertray line', UNDERTRAY_STRIKE_REASON === "Costed on the photographs. A hanging lower strip can be the bumper's own lower section, so strike the line if the undertray is sound on inspection.");

console.log('\n2. The signal (batch 255 R1): bumper charged replace / missing AND the beam probe confirmed it');
const P = (verdict, action) => [{ panelId: 'FRONT_BUMPER_REINFORCEMENT', verdict, action }];
ok('bumper charged replace → (a) holds', frontBumperCharged([fb('replace')]).ok === true);
ok('bumper charged missing (_amalgMissing) → (a) holds', frontBumperCharged([fb('replace', { _amalgMissing: true })]).ok === true);
ok('bumper repaired → (a) fails', frontBumperCharged([fb('repair', { used: null, oem: null, _repairNoPart: true })]).ok === false);
ok('no bumper row → (a) fails (a missing vote no longer counts)', frontBumperCharged([]).ok === false);
ok('probe consistent-with-claim (kept) → (b) holds', beamProbeConfirmed(P('consistent-with-claim', 'kept')).ok === true);
ok('probe cannot-determine (unconfirmed-kept) → (b) fails', beamProbeConfirmed(P('cannot-determine', 'unconfirmed-kept')).ok === false);
ok('probe floored → (b) fails', beamProbeConfirmed(P('no-damage-visible', 'floored')).ok === false);
ok('no probe record for the beam (failed / not run) → (b) fails', beamProbeConfirmed(null).ok === false && beamProbeConfirmed([{ panelId: 'FRONT_BUMPER', verdict: 'consistent-with-claim', action: 'kept' }]).ok === false);

console.log('\n3. Enforcement');
const KEPT = P('consistent-with-claim', 'kept');
for (const [label, rows, probe] of [
  ['bumper repaired, probe kept', [fb('repair', { used: null, oem: null, _repairNoPart: true }), beam()], KEPT],
  ['no bumper row (CK75ONW), probe kept', [beam()], KEPT],
  ['bumper replace, probe cannot-determine (KT73YAJ)', [fb('replace'), beam()], P('cannot-determine', 'unconfirmed-kept')],
  ['bumper replace, no probe record', [fb('replace'), beam()], null],
]) {
  const flags = [{ panelId: 'FRONT_BUMPER_REINFORCEMENT', partName: 'Bumper reinforcement', reason: 'second check could not confirm', _attribUnconfirmed: true }], core = [];
  const r = enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags, core], probePanels: probe });
  ok(`${label} → the beam leaves the ledger and is ONE flag with the line (older beam flag replaced)`, !rows.some(x => x.panelId === 'FRONT_BUMPER_REINFORCEMENT' && isChargedRow(x)) && r.uncosted.length === 1
    && flags.length === 1 && core.length === 1 && flags[0].reason === BEAM_NOT_SEEN_REASON && flags[0]._beamNotSeen && flags[0].partName === 'Bumper reinforcement');
}
{
  const rows = [beam()], flags = [], core = [];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags, core], probePanels: KEPT });
  ok('the checklist carries the line', seedChecklistFromFlags('1. x', flags, {}).includes(`2. ${BEAM_NOT_SEEN_REASON}`));
  ok('the card is a £0 Related card with the line', buildDamageCards({ gatedParts: rows, flaggedParts: core }).some(c => c.part === 'Bumper reinforcement' && c.origin === 'Related' && c.cost === 0 && c.note === BEAM_NOT_SEEN_REASON));
  ok('rewordDisputedFlags leaves it alone', rewordDisputedFlags([[{ ...flags[0], _amalgDisagree: true }]]).length === 0);
}
{
  const rows = [fb('replace'), beam()], flags = [];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags], probePanels: KEPT });
  ok('bumper charged replace AND probe kept (URZ7545 / the six labelled damaged) → the beam stays charged, no flag', rows.some(x => x.panelId === 'FRONT_BUMPER_REINFORCEMENT' && isChargedRow(x)) && flags.length === 0);
}
{
  const rows = [fb('replace'), tray()];
  const flags = [{ panelId: 'UNDERTRAY', partName: 'Undertray', reason: 'old', _amalgDisagree: true }], core = [];
  const r = enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags, core], probePanels: null });
  ok('a charged undertray keeps its money', rows.some(x => x.panelId === 'UNDERTRAY' && isChargedRow(x)) && r.undertrayNoted);
  ok('…and carries ONE strike note (any older undertray flag replaced)', flags.length === 1 && flags[0].reason === UNDERTRAY_STRIKE_REASON && flags[0]._costedLimit);
  ok('the Visible undertray card carries the note', buildDamageCards({ gatedParts: rows, flaggedParts: core }).some(c => c.part === 'Undertray' && c.origin === 'Visible' && c.note === UNDERTRAY_STRIKE_REASON));
  ok('the checklist carries the note', seedChecklistFromFlags('1. x', flags, {}).includes(`2. ${UNDERTRAY_STRIKE_REASON}`));
  ok('Inspection Flags show it', buildBuyerFlags({ _flaggedParts: flags, _reconciledParts: rows }).some(f => f.panelId === 'UNDERTRAY' && f.reason === UNDERTRAY_STRIKE_REASON));
}
{
  const rows = [fb('replace')], flags = [];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags], probePanels: null });
  ok('no undertray / no beam → nothing happens', flags.length === 0 && rows.length === 1);
}

console.log('\n4. The route');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const at = route.indexOf('enforceBeamSeenOnly({ gatedParts');
ok('runs after the attribution probes (their record is an input), labour and the §4 note, before the VDS, parts_sum and the ledger', at > route.indexOf('assessment._attributionProbe = { ok: true, panels: [] }') && at > route.indexOf('[ATTRIB PROBE] ${cp.panelId}') && at > route.indexOf('[BUMPER-OFF §4]') && at > route.indexOf('[LABOUR CODE]')
  && at < route.indexOf('assessment._vdsParts = assembleVdsParts') && at < route.indexOf('const parts_sum = sumPartsRealistic(gatedParts)'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
