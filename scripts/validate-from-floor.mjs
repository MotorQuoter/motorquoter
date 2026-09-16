// validate-from-floor — batch 131 task 1. Vincent, 15 Sep: "£500 is the bottom of a range."
//
// Batch 130 printed the SRS floor BARE in the Parts Breakdown: the row is action 'replace', so the per-renderer
// costCells put £500 in the S/H column and the "from" test only looked at the Repair cost column. The 130 validator
// checked the damage-card path and never rendered the table. This one renders a REAL PDF through jsPDF, reads the
// text back, and FAILS on any "£500" not preceded by "from " — and proves the detector bites on the old layout.
//
// Screen: the Parts Breakdown is a JSX table inside a client page that cannot be rendered in Node. Both renderers
// now take their cells from ONE pure owner (lib/labour.mjs partsTableCells); this file drives that owner exactly as
// page.js does and pins page.js (and the PDF route) to it by source.
//
// £0 — no network, no provider, no model. Run:
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-from-floor.mjs
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { buildAssessmentPdf } from '../app/api/salvage/pdf/route.js';
import { partsTableCells, isFromFigureRow, srsDeploymentNote, SRS_FLOOR_GBP } from '../lib/labour.mjs';
import { assembleVdsParts, assembleKcdParts } from '../lib/parts.mjs';
import { buildDamageCards } from '../lib/damageCards.mjs';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

function pdfChunks(bytes) {
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
  return out;
}
// THE DETECTOR: a "£500" (not £5,000 / £500.00 / £5000) that is not immediately preceded by "from ".
const BARE_500 = /(?<!from )£500(?![\d,.])/;
const bareChunks = (chunks) => chunks.filter((c) => BARE_500.test(c));

console.log('\n0. the detector itself');
ok('catches a bare "£500"', BARE_500.test('£500') && BARE_500.test('kit £500 only'));
ok('passes "from £500"', !BARE_500.test('from £500') && !BARE_500.test('Replace - from £500.'));
ok('ignores £5,000 / £5000 / £500.00', !BARE_500.test('£5,000') && !BARE_500.test('£5000') && !BARE_500.test('£500.00'));

console.log('\n1. the ONE owner of the cells (lib/labour.mjs partsTableCells)');
const srsRow = { panelId: 'SRS_AIRBAG', name: 'SRS airbag kit (deployed)', action: 'replace', oem: null, used: SRS_FLOOR_GBP, _tableMandated: true, _gOwned: true, _srsFloor: true };
const jigRow = { panelId: 'FRONT_STRUCTURE', name: 'Front structure', action: 'inspect', oem: null, used: 500, _tableMandated: true, _structFloor: true, _zeroRule: 'A' };
const bumper = { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', oem: 290, used: 160 };
const door   = { panelId: 'FRONT_DOOR', name: 'Front door', action: 'repair', oem: 365, used: 200 };
const labour = { name: 'Labour & paint (new & painted)', action: '—', oem: 1500, used: null, _codeLabour: true };
ok('SRS floor (action replace) → Repair cost column, from:true, S/H empty', JSON.stringify(partsTableCells(srsRow)) === JSON.stringify({ oem: null, sh: null, repair: 500, from: true }));
ok('jig floor → Repair cost column, from:true (unchanged placement)', JSON.stringify(partsTableCells(jigRow)) === JSON.stringify({ oem: null, sh: null, repair: 500, from: true }));
ok('replace row → OEM + S/H, from:false (unchanged)', JSON.stringify(partsTableCells(bumper)) === JSON.stringify({ oem: 290, sh: 160, repair: null, from: false }));
ok('repair row → OEM + Repair cost, from:false (unchanged)', JSON.stringify(partsTableCells(door)) === JSON.stringify({ oem: 365, sh: null, repair: 200, from: false }));
ok('labour row → Repair cost, from:false (unchanged)', JSON.stringify(partsTableCells(labour)) === JSON.stringify({ oem: null, sh: null, repair: 1500, from: false }));
ok('"from" is decided by the one predicate, isFromFigureRow', [srsRow, jigRow, bumper, door, labour].every((r) => partsTableCells(r).from === isFromFigureRow(r)));

console.log('\n2. SCREEN — the page takes its cells from the owner, and prints them as below');
{
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  ok('page.js imports partsTableCells from lib/labour.mjs', page.includes("import { partsTableCells } from '@/lib/labour.mjs';"));
  ok('page.js costCells IS the owner (no local copy)', page.includes('const costCells = partsTableCells;') && !page.includes("if (act === 'replace') return"));
  ok('page.js prints "from" off the owner\'s flag, in the Repair cost cell', page.includes('{c.from && c.repair != null ? `from ${fmtP(c.repair)}` : fmtP(c.repair)}'));
  ok('page.js keeps no second from-predicate beside the owner', !page.includes('p._structFloor || p._srsFloor') && !page.includes('p._srsTier || p._srsFitting'));
  // Drive the owner exactly as the JSX does (fmtP is page.js's own formatter, verbatim).
  const fmtP = v => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
  const cellsText = (p) => { const c = partsTableCells(p); return [fmtP(c.oem), fmtP(c.sh), c.from && c.repair != null ? `from ${fmtP(c.repair)}` : fmtP(c.repair)]; };
  const srsCells = cellsText(srsRow);
  console.log(`    screen SRS row cells: ${JSON.stringify(srsCells)}`);
  ok('screen SRS row prints OEM "—", S/H "—", Repair cost "from £500"', JSON.stringify(srsCells) === JSON.stringify(['—', '—', 'from £500']));
  ok('screen: NO bare £500 in any cell of the SRS or jig floor rows', ![srsRow, jigRow].flatMap(cellsText).some((t) => BARE_500.test(t)));
}

console.log('\n3. PDF — a REAL render, text read back from the file');
const vd = { vrm: 'TEST131', make: 'FORD', model: 'KUGA', year: 2023, category: 'S' };
const flag = { panelId: 'AIRBAG', partName: 'SRS airbag (deployed)', zone: 'interior', weight: 'high', reason: srsDeploymentNote(), _srsExtentFloor: true };
const mk = (rows) => ({
  'Recommended Action': 'Bid to the ceiling.',
  Airbags: 'Airbags deployed - the replacement is shown as a from-figure in the repair breakdown (SRS airbag kit and fitting). The number and location of the bags must be checked before bidding.',
  'WhatsApp Inspection Checklist': '1. Show SRS airbag (deployed) close-up — the number and location of the bags must be checked before bidding.',
  _reconciledParts: rows,
  _partsReconciliation: { parts_sum: rows.reduce((a, r) => a + (r.used ?? r.oem ?? 0), 0) },
  _vdsParts: assembleVdsParts([], rows),
  _kcdParts: assembleKcdParts(rows),
  _damageCards: buildDamageCards({ gatedParts: rows, costedParts: [], flaggedParts: [flag], allowanceParts: [] }),
  _flaggedParts: [flag],
  _preGateParts: [],
});
{
  const chunks = pdfChunks(buildAssessmentPdf(mk([bumper, srsRow, labour]), vd, 'GB', 'TEST131', '15/09/2026', null, null));
  const hits = chunks.filter((c) => c.includes('£500'));
  for (const c of hits) console.log(`    PDF "£500" chunk: ${JSON.stringify(c.slice(0, 120))}`);
  ok('the parts table Repair cost cell reads exactly "from £500"', chunks.includes('from £500'));
  ok('the SRS row reached every surface under test (table, VDS, KCD, damage card, flag)', hits.length >= 5);
  const bare = bareChunks(chunks);
  if (bare.length) for (const c of bare) console.log(`    BARE: ${JSON.stringify(c)}`);
  ok('🔴 NO "£500" anywhere in the PDF that is not preceded by "from"', bare.length === 0);
}
{
  // Negative control — the pre-131 layout: the same £500 in the S/H column of a replace row with no floor marker.
  // If the detector does not fire here, the gate above proves nothing.
  const oldLayout = { ...srsRow }; delete oldLayout._srsFloor;
  const chunks = pdfChunks(buildAssessmentPdf({ ...mk([bumper, labour]), _reconciledParts: [bumper, oldLayout, labour], _partsReconciliation: { parts_sum: 2160 } }, vd, 'GB', 'TEST131', '15/09/2026', null, null));
  ok('NEGATIVE CONTROL: a £500 in the S/H column (the 130 defect shape) IS caught by the detector', bareChunks(chunks).includes('£500'));
}

console.log('\n3b. batch 131 task 2 — the airbag checklist line on the REAL PDF (the em dash must not vanish)');
{
  const chunks = pdfChunks(buildAssessmentPdf(mk([bumper, srsRow, labour]), vd, 'GB', 'TEST131', '15/09/2026', null, null));
  const line = chunks.find((c) => c.includes('the number and location of the bags must be checked before bidding'));
  console.log(`    PDF checklist chunk: ${JSON.stringify(line ?? null)}`);
  ok('the PDF prints the line with a hyphen where the screen has the em dash ("close-up - the number …")', !!line && line.includes('Show SRS airbag (deployed) close-up - the number and location of the bags must be checked before bidding.'));
  ok('no word was lost to the dash ("close-up the number" would mean the dash was dropped)', !!line && !line.includes('close-up the number') && !line.includes('close-up  the number'));
}

console.log('\n4. the PDF route takes its cells from the owner too');
{
  const pdf = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  ok('pdf route imports partsTableCells', pdf.includes("import { partsTableCells } from '@/lib/labour.mjs';"));
  ok('pdf costCells IS the owner (no local copy), "from" off the owner\'s flag', pdf.includes('const costCells = partsTableCells;') && !pdf.includes("if (act === 'replace') return") && pdf.includes('c.from && c.repair != null ? `from ${fmtPP(c.repair)}` : fmtPP(c.repair)'));
}


console.log('\n5. batch 142 R4 — the footer must not claim the from-£500 floors are excluded');
{
  // The old footer said "Items not independently confirmable appear in Inspection Flags ... and are
  // not in this figure." On a lot carrying the structural jig floor AND the SRS airbag floor, both of
  // which ARE in the repair total and ARE shown in Inspection Flags, that told the buyer he was not
  // paying for £1,000 he was paying for. Rendered on a REAL PDF, then read back.
  const chunks = pdfChunks(buildAssessmentPdf(mk([bumper, srsRow, labour]), vd, 'GB', 'TEST142', '16/09/2026', null, null));
  const footer = chunks.filter((c) => /repair figure|this figure|not costed|Inspection Flags/i.test(c)).join(' ');
  console.log(`    PDF footer text: ${JSON.stringify(footer.slice(0, 320))}`);

  ok('the false exclusion claim is GONE from the rendered PDF', !/are not in this figure/i.test(footer));
  ok('the figure is described as parts, labour AND paint (labour was missing before)',
     /itemised parts, labour and paint/i.test(footer));
  ok('the footer says the structural-work and airbag floors ARE included, as from-figures',
     /includes the structural-work and airbag floors shown there, each from £500/i.test(footer));
  ok('and that the OTHER flagged items are not costed', /Other items in the Inspection Flags are not costed/i.test(footer));

  // One owner: neither surface may carry its own copy of the sentence.
  const pdfSrc = readFileSync('app/api/salvage/pdf/route.js', 'utf8');
  const webSrc = readFileSync('app/salvage/success/page.js', 'utf8');
  ok('the PDF takes the sentence from config/reportFooter.mjs',
     pdfSrc.includes("import { REPAIR_FIGURE_FOOTER } from '@/config/reportFooter.mjs';") && pdfSrc.includes('${REPAIR_FIGURE_FOOTER}'));
  ok('the screen takes the SAME sentence from the same owner',
     webSrc.includes("import { REPAIR_FIGURE_FOOTER } from '@/config/reportFooter.mjs';") && webSrc.includes('{REPAIR_FIGURE_FOOTER}'));
  ok('neither surface keeps a local copy of the old claim',
     !/are not in this figure/i.test(pdfSrc) && !/are not in this figure/i.test(webSrc));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} from-floor: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
