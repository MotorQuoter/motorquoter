// Validator — batch 254 item 1: the bumper reinforcement is charged only when the front bumper is off / missing / torn open
// (Vincent R2, 19 Nov); a charged undertray always carries its strike note. £0, no live call.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch254-beam.mjs
import { readFileSync } from 'node:fs';
import { enforceBeamSeenOnly, frontBumperOpen, seedChecklistFromFlags, rewordDisputedFlags, buildBuyerFlags,
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

console.log('\n2. The signal: bumper charged as replace / missing, or any missing vote');
ok('bumper charged replace → open', frontBumperOpen([fb('replace')], null).open === true);
ok('bumper charged missing (_amalgMissing) → open', frontBumperOpen([fb('replace', { _amalgMissing: true })], null).open === true);
ok('bumper repaired (charged, repair) and no missing vote → not open', frontBumperOpen([fb('repair', { used: null, oem: null, _repairNoPart: true })], { FRONT_BUMPER: { notVisible: 0 } }).open === false);
ok('no bumper row, one missing vote (pooled over FRONT_BUMPER#2) → open', frontBumperOpen([], { 'FRONT_BUMPER#2': { notVisible: 1 } }).open === true);
ok('no bumper row, no votes → not open', frontBumperOpen([], null).open === false);

console.log('\n3. Enforcement');
{
  const rows = [fb('repair', { used: null, oem: null, _repairNoPart: true }), beam()];
  const flags = [], core = [];
  const r = enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags, core], pvVotes: { FRONT_BUMPER: { notVisible: 0, damaged: 3 } } });
  ok('bumper on → the beam leaves the ledger (no charged beam row)', !rows.some(x => x.panelId === 'FRONT_BUMPER_REINFORCEMENT' && isChargedRow(x)) && r.uncosted.length === 1);
  ok('…and becomes one flag with the line, on both flag lists', flags.length === 1 && core.length === 1 && flags[0].reason === BEAM_NOT_SEEN_REASON && flags[0]._beamNotSeen && flags[0].partName === 'Bumper reinforcement');
  const cl = seedChecklistFromFlags('1. x', flags, {});
  ok('the checklist carries the same line', cl.includes(`2. ${BEAM_NOT_SEEN_REASON}`));
  const cards = buildDamageCards({ gatedParts: rows, flaggedParts: core });
  ok('the card is a £0 Related card with the same line', cards.some(c => c.part === 'Bumper reinforcement' && c.origin === 'Related' && c.cost === 0 && c.note === BEAM_NOT_SEEN_REASON));
  ok('rewordDisputedFlags leaves it alone', rewordDisputedFlags([[{ ...flags[0], _amalgDisagree: true }]]).length === 0);
}
{
  const rows = [fb('replace'), beam()];
  const flags = [];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags], pvVotes: null });
  ok('bumper charged replace → the beam stays charged, no flag', rows.some(x => x.panelId === 'FRONT_BUMPER_REINFORCEMENT' && isChargedRow(x)) && flags.length === 0);
}
{
  const rows = [beam()];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [[]], pvVotes: { FRONT_BUMPER: { notVisible: 1 } } });
  ok('no bumper row but a missing vote → the beam stays charged', rows.length === 1);
}
{
  const rows = [fb('replace'), tray()];
  const flags = [{ panelId: 'UNDERTRAY', partName: 'Undertray', reason: 'old', _amalgDisagree: true }], core = [];
  const r = enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags, core], pvVotes: null });
  ok('a charged undertray keeps its money', rows.some(x => x.panelId === 'UNDERTRAY' && isChargedRow(x)) && r.undertrayNoted);
  ok('…and carries ONE strike note (any older undertray flag replaced)', flags.length === 1 && flags[0].reason === UNDERTRAY_STRIKE_REASON && flags[0]._costedLimit);
  const cards = buildDamageCards({ gatedParts: rows, flaggedParts: core });
  ok('the Visible undertray card carries the note', cards.some(c => c.part === 'Undertray' && c.origin === 'Visible' && c.note === UNDERTRAY_STRIKE_REASON));
  ok('the checklist carries the note', seedChecklistFromFlags('1. x', flags, {}).includes(`2. ${UNDERTRAY_STRIKE_REASON}`));
  const bf = buildBuyerFlags({ _flaggedParts: flags, _reconciledParts: rows });
  ok('Inspection Flags show it', bf.some(f => f.panelId === 'UNDERTRAY' && f.reason === UNDERTRAY_STRIKE_REASON));
}
{
  const rows = [fb('replace')];
  const flags = [];
  enforceBeamSeenOnly({ gatedParts: rows, flagLists: [flags], pvVotes: null });
  ok('no undertray / no beam → nothing happens', flags.length === 0 && rows.length === 1);
}

console.log('\n4. The route');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const at = route.indexOf('enforceBeamSeenOnly({ gatedParts');
ok('runs after labour and the §4 note, before the VDS, parts_sum and the ledger', at > route.indexOf('[BUMPER-OFF §4]') && at > route.indexOf('[LABOUR CODE]')
  && at < route.indexOf('assessment._vdsParts = assembleVdsParts') && at < route.indexOf('const parts_sum = sumPartsRealistic(gatedParts)'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
