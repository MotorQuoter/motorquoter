// Validator — batch 106 §5: the PDF must say when a buyer's stored edits were DISCARDED.
//
// Why this one renders a real PDF instead of grepping the route source: pdf-parity is 23/0 and no human
// has opened a page. A source assertion proves the branch is written; it does not prove the sentence
// reaches paper. This builds actual PDFs through jsPDF and reads the text back out of the file, so the
// three states are checked the way a buyer meets them.
//
// Three states, and the third is the one that matters most — a clean report must stay clean:
//   1. layer present, stamp MISMATCH  → the discarded sentence IS on the page, "Adjusted by you" is NOT
//   2. layer present, stamp MATCHES   → "Adjusted by you" IS on the page, the discarded sentence is NOT
//   3. no layer at all                → NEITHER string appears
//
// £0 — no network, no provider, no model. Run:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-pdf-edit-notice.mjs

import zlib from 'node:zlib';
import { buildAssessmentPdf } from '../app/api/salvage/pdf/route.js';
import { ledgerHash, EDITS_DISCARDED_NOTICE, EDITS_DISCARDED_PDF } from '../lib/ledgerEdits.mjs';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}`); fail++; }
};

// ── Read the text back out of a rendered PDF ──────────────────────────────────────────────────────
// jsPDF emits Flate-compressed content streams; pull every parenthesised string literal out of them.
function pdfText(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  let i = 0;
  while (true) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    let start = s + 6;
    if (buf[start] === 13) start++;
    if (buf[start] === 10) start++;
    const raw = buf.subarray(start, e);
    let txt;
    try { txt = zlib.inflateSync(raw).toString('latin1'); } catch { txt = raw.toString('latin1'); }
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
  // The banner sentence is wrapped by splitTextToSize, so join and collapse whitespace before matching.
  return out.join(' ').replace(/\s+/g, ' ');
}

// ── A minimal but REAL assessment: two costed rows, so a strike has something to bite on ──────────
const reconciled = [
  { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 290, used: 160 },
  { panelId: 'FOG_LAMP', name: 'Fog lamp', action: 'replace', oem: 70, used: 40 },
];
const assessment = {
  'Parts Breakdown': 'Front bumper - replace: £160\nFog lamp - replace: £40',
  'Recommended Action': 'Bid to the ceiling.',
  _reconciledParts: reconciled,
  _partsReconciliation: { parts_sum: 200 },
};
const vd = { vrm: 'TEST123', make: 'FORD', model: 'KUGA', year: 2023, category: 'S' };
// buildAssessmentPdf already returns doc.output('arraybuffer') — the finished bytes.
const render = (layer) => pdfText(
  buildAssessmentPdf(assessment, vd, 'GB', 'TEST123', '08/09/2026', null, layer),
);

const CURRENT_STAMP = ledgerHash(reconciled);
const layer = (stamp) => ({ stamp, strikes: ['FOG_LAMP#0'], adds: [], updatedAt: '2026-09-04T13:06:49.968Z' });
const ADJUSTED = 'Adjusted by you';

console.log('\n1. layer present, stamp MISMATCH — the edits are suppressed, and the page must SAY SO');
{
  const t = render(layer('L99-staleaaa'));
  ok('the discarded-edits sentence is on the page', t.includes(EDITS_DISCARDED_PDF));
  ok('"Adjusted by you" is NOT on the page (nothing was applied)', !t.includes(ADJUSTED));
  ok('the engine figure is shown unchanged (£200 — no money moves)', t.includes('200'));
  ok('the sentence uses hyphens, not em-dashes (PDF suppressor constraint)', !t.includes(EDITS_DISCARDED_NOTICE));
}

console.log('\n2. layer present, stamp MATCHES — the edits apply, the old banner is unchanged');
{
  const t = render(layer(CURRENT_STAMP));
  ok('"Adjusted by you - engine estimate" is on the page', t.includes(ADJUSTED));
  ok('the discarded-edits sentence is NOT on the page', !t.includes(EDITS_DISCARDED_PDF));
}

console.log('\n3. no layer at all — a clean report shows NEITHER string');
for (const [label, l] of [['null', null], ['undefined', undefined], ['empty object', {}]]) {
  const t = render(l);
  ok(`no layer (${label}): discarded sentence absent`, !t.includes(EDITS_DISCARDED_PDF));
  ok(`no layer (${label}): "Adjusted by you" absent`, !t.includes(ADJUSTED));
}

console.log('\n4. a layer that is PRESENT but holds no edits must not fire the notice either');
{
  // The stamp is stale, so applyEdits reports stampMismatch — but the buyer struck and added nothing,
  // so there is nothing to tell him was discarded. Mirrors the screen's own guard.
  const t = render({ stamp: 'L99-staleaaa', strikes: [], adds: [] });
  ok('empty-but-present layer: discarded sentence absent', !t.includes(EDITS_DISCARDED_PDF));
  ok('empty-but-present layer: "Adjusted by you" absent', !t.includes(ADJUSTED));
}

console.log('\n5. EO-04 — a STRUCK line is PRESENT on the page, not silently dropped');
{
  // The open question EO-04 could not answer from live data: no stored report currently has an
  // APPLICABLE edit layer, so a struck line had never been seen on paper. Here it is, on a real one.
  // (The strike-through itself is a graphics op, not text — the route draws a rule across the row and
  // greys the text to 150 — so what is asserted here is that the row SURVIVES and the totals move.)
  const t = render(layer(CURRENT_STAMP));
  ok('the struck row is still printed (the buyer sees what he removed)', t.includes('Fog lamp'));
  ok('the unstruck row is printed', t.includes('Front bumper'));
  ok('the banner shows the adjusted figure 160, not the engine 200', t.includes('160'));
}

console.log('\n6. the two surfaces share ONE sentence — they cannot drift');
{
  ok('the PDF string is the screen string with the em-dash swapped for a hyphen',
    EDITS_DISCARDED_PDF === EDITS_DISCARDED_NOTICE.replace(/—/g, '-'));
  ok('the screen string still carries the em-dash', EDITS_DISCARDED_NOTICE.includes('—'));
  ok('the PDF string carries no em-dash', !EDITS_DISCARDED_PDF.includes('—'));
}


console.log('\n7. batch 114 — the buyer\'s lamp-type correction survives the PDF download');
{
  const lampRows = [
    { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', oem: null, used: 350, _lampMandated: true, _band: 350, _lampPair: true },
    { panelId: 'HEADLAMP', name: 'Headlamp', action: 'replace', oem: null, used: 350, _lampMandated: true, _band: 350, _lampPair: true },
    { panelId: 'BONNET', name: 'Bonnet', action: 'replace', oem: 500, used: 280 },
  ];
  const keys = ['HEADLAMP#0', 'HEADLAMP#1', 'BONNET#0'];
  const lampAsmt = {
    'Parts Breakdown': 'Headlamp - replace: £350\nHeadlamp - replace: £350\nBonnet - replace: £280',
    'Recommended Action': 'Bid to the ceiling.',
    _reconciledParts: lampRows,
    _partsReconciliation: { parts_sum: 980 },
    _kcdParts: [
      { partName: 'Headlamp', action: 'replace', figure: 350, prose: 'Headlamp — replace: £350', _rowKey: keys[0] },
      { partName: 'Headlamp', action: 'replace', figure: 350, prose: 'Headlamp — replace: £350', _rowKey: keys[1] },
      { partName: 'Bonnet', action: 'replace', figure: 280, prose: 'Bonnet — replace: £280', _rowKey: keys[2] },
    ],
    _damageCards: [
      { part: 'Headlamp', origin: 'Visible', action: 'replace', cost: 350, note: 'Full-width frontal impact — both headlamps are costed at £350 each and included in the repair total; confirm serviceability on inspection.', _rowKey: keys[0] },
    ],
    _flaggedParts: [
      { partName: 'Headlamp', zone: 'front', weight: 'medium', reason: 'Lamp type could not be confirmed from the vehicle spec or the listing photographs, so the higher LED/adaptive band has been used.', _tier2LampDisclosure: true, _gateGenerated: true },
    ],
  };
  const renderL = (l) => pdfText(buildAssessmentPdf(lampAsmt, vd, 'GB', 'TEST123', '11/09/2026', null, l));
  const LS = ledgerHash(lampRows);

  const before = renderL(null);
  ok('no correction: the assumed-type flag is on the PDF', before.includes('Lamp type could not be confirmed'));
  ok('no correction: no correction line', !before.includes('Headlamp type corrected by the buyer'));

  const t = renderL({ stamp: LS, strikes: [], adds: [], lampType: 'halogen' });
  ok('correction: the ruled line is printed', t.includes('Headlamp type corrected by the buyer to halogen (£150 per unit).'));
  ok('correction: the banner shows the edited total £580 (980 − 2 × 200)', t.includes('580'));
  ok('correction: "Adjusted by you" is shown', t.includes(ADJUSTED));
  ok('correction: Key Cost Drivers re-priced — "Headlamp - replace: £150"', t.includes('Headlamp - replace: £150'));
  ok('correction: no Key Cost Driver still says £350', !t.includes('Headlamp - replace: £350'));
  ok('correction: the damage card note is re-priced to "£150 each"', t.includes('costed at £150 each'));
  ok('correction: the answered "type could not be confirmed" flag is gone', !t.includes('Lamp type could not be confirmed'));

  const stale = renderL({ stamp: 'L3-stale', strikes: [], adds: [], lampType: 'halogen' });
  ok('RE-RUN: a correction made against an earlier ledger is discarded AND the buyer is told',
     stale.includes(EDITS_DISCARDED_PDF) && !stale.includes('Headlamp type corrected by the buyer'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
