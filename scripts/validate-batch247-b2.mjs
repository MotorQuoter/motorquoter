// batch 247 B2 (Vincent, 16 Nov) — code is the only voice on the salvage category.
//   (ii) the category filter drops every model sentence about a category from the buyer-facing prose fields;
//   (i)  the model's instructions never mention a salvage category (pinned at the bottom).
// £0: real fields from the Fable cassette replays and RV26YLN's stored row (fixtures/b247/category-fields.json).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch247-b2.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dropCategorySentences, mentionsCategory } from '@/lib/categoryProse.mjs';

const { lots } = JSON.parse(readFileSync('fixtures/b247/category-fields.json', 'utf8'));
const run = (t, o) => dropCategorySentences(t, o);

test('every field on every fixture lot: no model category sentence survives (code exit line excepted)', () => {
  for (const [lot, fields] of Object.entries(lots)) for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    const out = run(v).text;
    for (const line of out.split('\n')) {
      if (/^\s*Exit: £/.test(line) || /^\s*[-*]?\s*(?:Copart's notes say:|The auction notes say:)/.test(line)) continue;   // code lines
      assert.ok(!mentionsCategory(line), `${lot} ${k} still says: ${line}`);
    }
  }
});

test('RV26YLN Red Flags: the Category bullet goes whole; the V5 bullet and every other bullet are untouched', () => {
  const rf = lots.RV26YLN['Red Flags'];
  const r = run(rf);
  assert.equal(r.dropped.length, 2);
  assert.ok(!/Category/.test(r.text));
  assert.ok(r.text.includes('- V5: not present, so a replacement application is needed.'));
  assert.equal(r.text.split('\n').length, rf.split('\n').length - 1, 'exactly one line removed');
});

test('RV26YLN Confidence Level: the category item is cut, the level and the rest are kept', () => {
  const r = run(lots.RV26YLN['Confidence Level']);
  assert.equal(r.text, 'Medium — photo coverage is good and the mileage is dash-confirmed, but the HV system status, the pillar and sill structure and the full restraint deployment count are unresolved.');
});

test('KT73YAJ Paperwork bullet keeps its V5 sentence (the binder would have dropped the whole bullet)', () => {
  const r = run(lots.KT73YAJ['Red Flags']);
  assert.ok(r.text.includes('- Paperwork. No V5 is present, so the buyer will need to apply to DVLA for a registration document.'));
  assert.ok(!/salvage category/.test(r.text));
});

test('list cuts read as English (URZ7545, SA26KVT, HV25ODX, SF69YBB, FE68AOP, EN23NJX)', () => {
  assert.match(run(lots.URZ7545['Confidence Level']).text, /the vehicle does not run, and no photo shows the front structure\.$/);
  assert.match(run(lots.SA26KVT['Confidence Level']).text, /extent are not visible\.$/);
  assert.match(run(lots.HV25ODX['Confidence Level']).text, /the cause of the non-start, and the full restraint deployment are not established\./);
  assert.match(run(lots.SF69YBB['Confidence Level']).text, /the area behind the front bumper is unseen, and the disposal reason is unknown\.$/);
  assert.match(run(lots.FE68AOP['Realistic Exit Value']).text, /an unresolved question over the rear structure\./);
  assert.match(run(lots.EN23NJX['Exit Band Position']).text, /held below upper by the unresolved rear quarter and bumper\.$/);
});

test('code lines are never read: the exit line, the notes lines, the Cat A/B stop text', () => {
  const exit = lots.EN23NJX['Realistic Exit Value'];
  assert.ok(run(exit).text.endsWith('Exit: £10,075 — mid-high position, 77.5% of trade-low £13,000 (Cat S band)'));
  const notes = '- Copart\'s notes say: "HPI CHECK ON 21/7/2026 SHOWS CATEGORY S".\n- The auction notes say: "CAT S".';
  assert.equal(run(notes).text, notes);
  const stop = 'Category A — scrap only. This vehicle must be crushed entirely.';
  assert.equal(run(`- ${stop}\n- Other.`, { protect: [stop] }).text, `- ${stop}\n- Other.`);
});

test('a field with no category mention comes back byte-identical (AMZ3790 controls)', () => {
  for (const v of Object.values(lots.AMZ3790)) if (v && !/Exit: £/.test(v)) assert.equal(run(v).text, v);
  const rf = lots.AMZ3790['Red Flags'];
  assert.equal(run(rf).text, rf);
});

test('a field that was only category prose is emptied (code is the only voice), not kept whole', () => {
  assert.equal(run('The salvage category is not stated in the listing data supplied.').text, '');
  assert.equal(run('- **Salvage category:** it was not supplied in the listing data.').text, '');
});

test('opus-style assumptions are caught too ("Cat band", "Cat-status", "structural-repairable category")', () => {
  assert.equal(run('On balance the desirability supports a mid position within the Cat band.').text, '');
  assert.equal(run('…the biggest unseeable cost risk on this Cat-status front hit.').text, '');
});

// ── (i) the instructions ──────────────────────────────────────────────────────────────────────────────
test('B2(i): the engine prompt never mentions a salvage category or a Cat letter (no line implies one is supplied or defaults one)', async () => {
  const { ASSESSMENT_ENGINE_PROMPT } = await import('@/config/assessmentEngine.js');
  const hits = ASSESSMENT_ENGINE_PROMPT.split('\n').map((l, i) => [i + 2, l]).filter(([, l]) => mentionsCategory(l));
  assert.deepEqual(hits.map(([n, l]) => `${n}: ${l.slice(0, 90)}`), []);
});
