// batch 247 B3 ruling 1 (Vincent, 17 Nov) — code is the only voice on the V5. lib/v5Prose.mjs drops every model sentence
// about whether a V5 / V5C / logbook / registration document is present, absent or must be applied for; same engine and
// rules as the category filter. £0. Synthetic sentences are modelled on the Fable output; the fixture tests (production-row
// and cassette text, gitignored) skip cleanly when fixtures/b247/category-fields.json is absent.
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch247-v5.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dropV5Sentences, mentionsV5 } from '@/lib/v5Prose.mjs';
import { dropCategorySentences } from '@/lib/categoryProse.mjs';
import { categoryMarkerLine } from '@/lib/categoryMarker.mjs';

const run = (t, o) => dropV5Sentences(t, o);

test('the V5 bullets Fable writes go whole (label included)', () => {
  for (const s of [
    '- V5: the listing shows no V5, so a replacement must be applied for through DVLA.',
    '- No V5: no V5 comes with the lot, so allow for a replacement application.',
    '- V5: not present, so the new keeper will need to apply for a logbook.',
    '- V5: no V5 is present with the lot.',
    '- V5: the listing shows no V5. A replacement must be applied for through DVLA before the car can be re-registered to a new keeper.',
    '- Documents: no V5 is supplied with the lot, so a replacement must be applied for through DVLA.',
  ]) assert.equal(run(s).text, '', s);
});

test('a bullet keeps its other sentences (EA17HDN keeps the MOT sentence)', () => {
  const r = run('- Paperwork: no V5 is present, so a replacement logbook must be applied for through DVLA. MOT status shows not valid, so a fresh test is needed after repair.');
  assert.equal(r.text, '- MOT status shows not valid, so a fresh test is needed after repair.');
  assert.equal(r.dropped.length, 1);
});

test('a V5 clause is cut from a list where that keeps the rest true, and the list still reads as English', () => {
  assert.equal(run('This is offset by the unconfirmed mileage, the probable ex-fleet background and the absent V5.').text,
    'This is offset by the unconfirmed mileage and the probable ex-fleet background.');
  assert.equal(run('Those positives are offset by the multi-zone repair, the sill involvement and the missing V5, which a retail buyer will weigh once the auction history is discovered.').text,
    'Those positives are offset by the multi-zone repair and the sill involvement, which a retail buyer will weigh once the auction history is discovered.');
  assert.equal(run('Re-documenting the car without a V5 and any driver-assistance sensor calibration are further items outside the panel lines.').text,
    'Re-documenting the car and any driver-assistance sensor calibration are further items outside the panel lines.');
  assert.equal(run('… can be confirmed straight from the photos, and the lot is a non-insurer entry with no V5 present.').text,
    '… can be confirmed straight from the photos, and the lot is a non-insurer entry.');
  // never a dangling connective
  assert.equal(run('However, the listing states the V5 is not present, which leaves the documentation trail open.').text, '');
});

test('a sentence pointing back at a dropped V5 sentence goes with it; an unrelated one stays', () => {
  const r = run('- No V5 is supplied. Confirm it with Copart before bidding. The bonnet is creased.');
  assert.equal(r.text, '- The bonnet is creased.');
  assert.ok(r.dropped.some((d) => d.orphan));
});

test('code lines and text with no V5 claim come back byte-identical', () => {
  const notes = '- The auction notes say: "NO V5". Auction notes can understate the problem — check before bidding.\n- Copart\'s notes say: "V5 MISSING".';
  assert.equal(run(notes).text, notes);
  const plain = '- The bonnet is creased.\n- VAT applies to this sale.\n- The MOT expired in May.';
  assert.equal(run(plain).text, plain);
  const stop = 'Category A — scrap only. … no V5C is reissued.';
  assert.equal(run(`- ${stop}`, { protect: [stop] }).text, `- ${stop}`);
});

test('the marker line itself would be read as a V5 claim — so it must be added after the filter (route order pinned)', () => {
  assert.ok(mentionsV5(categoryMarkerLine('s', 'No')));
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const v5 = src.indexOf('dropV5Sentences(cat.text');
  const cat = src.indexOf('dropCategorySentences(was');
  const marker = src.indexOf('categoryMarkerLine(catLetter(enrichedVd.category), enrichedVd.v5Status)');
  const notes = src.indexOf('stampCopartNotes(assessment, enrichedVd');
  assert.ok(cat > 0 && v5 > cat, 'V5 filter runs right after the category filter, on its output');
  assert.ok(marker > v5, 'marker line added after the V5 filter');
  assert.ok(notes > v5, 'the notes code lines (incl. stolen-recovered "apply for the V5C") are stamped after the V5 filter');
  assert.ok(/claimClass: d\.orphan \? 'v5-orphan' : 'v5'/.test(src), "each drop recorded in _narrativeBindings as claimClass 'v5'");
});

test('category then V5 on one field (RV26YLN shape): both bullets go, one code line is due', () => {
  const rf = '- VAT: VAT applies.\n- V5: not present, so a replacement application is needed.\n- Category: the salvage category is not stated in the listing data supplied. If it is Category S, the buyer must apply to DVLA for a V5 that will be permanently marked Cat S.\n- Mileage: matches.';
  const out = dropV5Sentences(dropCategorySentences(rf).text).text;
  assert.equal(out, '- VAT: VAT applies.\n- Mileage: matches.');
});

// ── fixture tests (gitignored production-row + cassette text) ──
const FIX_PATH = 'fixtures/b247/category-fields.json';
const FIX = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = FIX ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture tests skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);

test('every fixture field: no model V5 sentence survives the two filters (code notes lines excepted)', { skip: SKIP }, () => {
  for (const [lot, fields] of Object.entries(FIX.lots)) for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    const out = dropV5Sentences(dropCategorySentences(v).text).text;
    for (const line of out.split('\n')) {
      if (/^\s*-?\s*(?:Copart's notes say:|The auction notes say:)/.test(line)) continue;
      assert.ok(!mentionsV5(line), `${lot} ${k} still says: ${line}`);
    }
  }
});
