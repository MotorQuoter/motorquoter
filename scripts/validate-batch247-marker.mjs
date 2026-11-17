// batch 247 B2 ruling 2 (Vincent, 17 Nov) — the code-owned V5 / category marker line in Red Flags.
// From the recorded category (catLetter) and the listing's V5 field only; Cat S/N only; one owner (lib/categoryMarker.mjs);
// added after the category filter and after the provenance dedup. £0, synthetic inputs only (no production data).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch247-marker.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { categoryMarkerLine, v5State } from '@/lib/categoryMarker.mjs';
import { buildAssessmentPdf } from '../app/api/salvage/pdf/route.js';

const ABSENT_S = 'No V5 is present, so the buyer must apply to DVLA for one. This car is recorded as Category S, and the new V5 will carry that marker permanently; it also shows on future history checks.';
const PRESENT_N = 'This car is recorded as Category N. The V5 carries that marker permanently and it shows on future history checks.';

test('the two wordings, exactly as ruled', () => {
  assert.equal(categoryMarkerLine('s', 'No'), ABSENT_S);
  assert.equal(categoryMarkerLine('n', 'Physical V5 Available'), PRESENT_N);
  assert.equal(categoryMarkerLine('n', 'No'), ABSENT_S.replace('Category S', 'Category N'));
  assert.equal(categoryMarkerLine('s', 'V5C Present'), PRESENT_N.replace('Category N', 'Category S'));
});

test('the V5 field values seen in the corpus (Copart + IAA normaliser)', () => {
  for (const v of ['No', 'no', 'None', 'Not available']) assert.equal(v5State(v), 'absent', v);
  for (const v of ['Yes', 'Physical V5 Available', 'V5C Present', 'V5 Available', 'Available']) assert.equal(v5State(v), 'present', v);
  for (const v of ['Partial V5 Available', '', null, undefined, 'Applied for']) assert.equal(v5State(v), null, String(v));
});

test('no line: any other category, no category, or a V5 state that is not plain', () => {
  for (const c of ['a', 'b', 'c', 'd', 'u', null, undefined, '']) {
    assert.equal(categoryMarkerLine(c, 'No'), null, `cat ${c}`);
    assert.equal(categoryMarkerLine(c, 'Physical V5 Available'), null, `cat ${c}`);
  }
  assert.equal(categoryMarkerLine('s', 'Partial V5 Available'), null);
  assert.equal(categoryMarkerLine('s', null), null);
});

test('route order: the line is added after the category filter and after the provenance dedup, from catLetter + v5Status', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  const filter = src.indexOf('dropCategorySentences(was');
  const dedup = src.indexOf('const _provDedupRx');
  const marker = src.indexOf('categoryMarkerLine(catLetter(enrichedVd.category), enrichedVd.v5Status)');
  assert.ok(filter > 0 && dedup > 0 && marker > 0, 'all three found');
  assert.ok(marker > filter, 'after the filter');
  assert.ok(marker > dedup && marker > src.indexOf('[PROVENANCE INJECT] red-flag line injected'), 'after the provenance block');
  // belt and braces: the line would not trip the provenance dedup even if the order changed
  const rx = new RegExp(src.match(/const _provDedupRx = \/(.+)\/i;/)[1], 'i');
  assert.ok(!rx.test(ABSENT_S) && !rx.test(PRESENT_N));
});

test('one owner: no other source file spells the marker wording', () => {
  for (const f of ['app/api/salvage/assess/route.js', 'lib/parts.mjs', 'lib/copartNotes.mjs', 'app/api/salvage/pdf/route.js', 'app/salvage/success/page.js', 'config/assessmentEngine.js']) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!/carry that marker permanently|carries that marker permanently/.test(s), f);
  }
});

function pdfText(bytes) {
  const buf = Buffer.from(bytes); const out = []; let i = 0;
  while (true) {
    const s = buf.indexOf('stream', i); if (s < 0) break;
    const e = buf.indexOf('endstream', s); if (e < 0) break;
    let start = s + 6; if (buf[start] === 13) start++; if (buf[start] === 10) start++;
    let txt; try { txt = zlib.inflateSync(buf.subarray(start, e)).toString('latin1'); } catch { txt = buf.subarray(start, e).toString('latin1'); }
    let depth = 0, cur = '', esc = false;
    for (const ch of txt) {
      if (depth === 0) { if (ch === '(') { depth = 1; cur = ''; } continue; }
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === String.fromCharCode(92)) { esc = true; continue; }
      if (ch === '(') { depth++; cur += ch; continue; }
      if (ch === ')') { depth--; if (depth === 0) out.push(cur); else cur += ch; continue; }
      cur += ch;
    }
    i = e + 9;
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

test('PDF: a real render prints the line in Red Flags', () => {
  const a = { 'Red Flags': `- The bonnet is creased.\n- ${ABSENT_S}`, 'Recommended Action': 'Inspect.', _reconciledParts: [], _partsReconciliation: { parts_sum: 0 } };
  const txt = pdfText(buildAssessmentPdf(a, { vrm: 'TEST247', category: 'S REPAIRABLE STRUCTURAL', v5Status: 'No' }, 'GB', 'TEST247', '17/11/2026', null, null));
  for (const w of ['must apply to DVLA', 'recorded as Category S', 'future history checks']) assert.ok(txt.includes(w), `PDF lacks "${w}"`);
});
