// batch 247 B3 (Vincent, 16 Nov) — "Not present in the listing photos" only when NO view voted the part damaged.
// Otherwise "Damaged or torn off". The money is unchanged. £0: stored shapes only (fixtures/b247/missing-wording.json —
// RV26YLN from its stored row, the rest from --vision-fixture replays of the Fable cassettes).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch247-b3.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { assembleVdsParts } from '@/lib/parts.mjs';
import { buildDamageCards } from '@/lib/damageCards.mjs';
import { damagedVotesFor, missingLead, NOT_PRESENT_LEAD, TORN_OFF_LEAD } from '@/lib/missingWording.mjs';

// The fixture holds data read from production rows, so it lives in the gitignored fixtures/ tree (batch 247 B2 ruling 4).
// On a fresh clone it is absent: the fixture tests skip with this message; the rest still run.
const FIX_PATH = 'fixtures/b247/missing-wording.json';
const FIX = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = FIX ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture tests skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);
const money = n => `£${Number(n).toLocaleString('en-GB')}`;

for (const c of FIX?.cases ?? []) {
  const lead = c.expect === 'torn' ? TORN_OFF_LEAD : NOT_PRESENT_LEAD;
  const fig = money(c.row.used ?? c.row.oem);
  test(`${c.lot} ${c.panelId} (${JSON.stringify(Object.values(c.pvVotes).map(v => `d${v.damaged}/m${v.notVisible}`))}) → "${lead}"`, () => {
    const ledger = [{ panelId: c.panelId, _amalgMissing: true }];
    const vds = assembleVdsParts(ledger, [c.row], c.pvVotes).find(b => b.panelId === c.panelId);
    assert.equal(vds.prose, `${lead} — replace, ${fig}.`);
    // the card says the same thing
    const card = buildDamageCards({ gatedParts: [{ ...c.row, _amalgMissing: true }], costedParts: ledger, pvVotes: c.pvVotes })
      .find(k => k.panelId === c.panelId);
    assert.equal(card.note, `${lead} — replacement costed.`);
    // money unchanged: the figure on the line is the stored ledger figure
    assert.ok(c.storedVds.endsWith(`replace, ${fig}.`), c.storedVds);
  });
}

test('RV26YLN mirror (d1/m1) was "Not present" before batch 247 and is "Damaged or torn off" now', { skip: SKIP }, () => {
  const c = FIX.cases.find(x => x.lot === 'RV26YLN');
  assert.match(c.storedVds, /^Not present in the listing photos/);
  assert.equal(missingLead({ amalgMissing: true, panelId: 'DOOR_MIRROR', pvVotes: c.pvVotes }), TORN_OFF_LEAD);
});

test('pooled count: a G-split panel sums PANEL and PANEL#n', () => {
  const pv = { FRONT_DOOR: { damaged: 0 }, 'FRONT_DOOR#2': { damaged: 2 }, FRONT_DOOR_X: { damaged: 9 } };
  assert.equal(damagedVotesFor(pv, 'FRONT_DOOR'), 2);
  assert.equal(missingLead({ amalgMissing: true, panelId: 'FRONT_DOOR', pvVotes: pv }), TORN_OFF_LEAD);
});

test('unchanged: a code-inserted lamp row keeps "Not present"; no vote record keeps "Not present"', () => {
  assert.equal(missingLead({ inserted: true, panelId: 'HEADLAMP', pvVotes: { HEADLAMP: { damaged: 3 } } }), NOT_PRESENT_LEAD);
  assert.equal(missingLead({ amalgMissing: true, panelId: 'GRILLE', pvVotes: null }), NOT_PRESENT_LEAD);
  const out = assembleVdsParts([{ panelId: 'GRILLE', _amalgMissing: true }], [{ panelId: 'GRILLE', name: 'Grille', action: 'replace', used: 70 }]);
  assert.equal(out[0].prose, 'Not present in the listing photos — replace, £70.');
});

test('one owner: no other file spells the two leads', () => {
  for (const f of ['lib/parts.mjs', 'lib/damageCards.mjs', 'app/api/salvage/assess/route.js']) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/['`]Not present in the listing photos —/.test(src), `${f} still spells the Not-present wording`);
    assert.ok(!/Damaged or torn off/.test(src), `${f} spells the torn-off wording`);
  }
});
