// Validator — branch D (pdf-parity): findings 8 (gate on has(key), not data presence), 9 (row wrap /
// no clip / glyph sanitise), 10 (mileage_detail offerability). £0: pure offerability + structural
// checks on the PDF source (the PDF renders through jsPDF, not unit-testable here without the alias).
//
// Run: node scripts/validate-pdf-parity.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { notOfferableForVehicle, hasVehicleGatedKey, genuineMotReadingCount } from '../lib/offerability.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const mot = (n) => Array.from({ length: n }, (_, i) => ({ odometerValue: 1000 * (i + 1), odometerUnit: 'mi', testResult: 'PASS', completedDate: `20${10 + i}-01-01` }));

// ── 10. mileage_detail offerability (pure — knowable free, before payment) ────────────────────────
console.log('\n10. mileage_detail offerability predicate');
assert('0 genuine readings → count 0', genuineMotReadingCount([]), 0);
assert('2 genuine readings → count 2', genuineMotReadingCount(mot(2)), 2);
ok('mileage_detail is a vehicle-gated key now', hasVehicleGatedKey(['mileage_detail']));
ok('<2 readings (present) → NOT offerable (rejected)', notOfferableForVehicle(['mileage_detail'], { motTests: mot(1) }).length === 1);
ok('0 readings (present) → NOT offerable', notOfferableForVehicle(['mileage_detail'], { motTests: [] }).length === 1);
ok('>=2 readings → offerable', notOfferableForVehicle(['mileage_detail'], { motTests: mot(2) }).length === 0);
ok('MOT payload absent (fetch failed) → offerable (never block on an outage)', notOfferableForVehicle(['mileage_detail'], { motTests: null }).length === 0);
ok('service_history still gated independently', hasVehicleGatedKey(['service_history']));

// ── 8. PDF gates on the PURCHASE, never on data presence ──────────────────────────────────────────
console.log('\n8. PDF paid-section gating (has(key), not data presence)');
{
  const pdf = read('app/api/generate-pdf/route.js');
  ok('valuation section gates on has(valuation) only (not retail_low presence)',
     pdf.includes("if (has('valuation')) {") && !pdf.includes("has('valuation') && val.retail_low_valuation"));
  ok('a valuation with no bands still renders an honest note (not a dropped section)',
     pdf.includes("if (!anyBand) row('Valuation', verdictValue"));
  ok('salvage section gates on has(salvagehistory), not salvageHistory != null',
     pdf.includes("if (has('salvagehistory') && !isIE)") && !pdf.includes('result.salvageHistory != null && !isIE'));
  ok('a null salvage result is honest, NOT a false green [OK]', /if \(sh == null\)\s*\{\s*row\('Salvage History', verdictValue/.test(pdf));
  ok('service-history section also fires for an IE basket (ie_service_history)',
     pdf.includes("has('service_history') || has('ie_service_history')"));
  ok('an outstanding safety recall now renders in the PDF', pdf.includes('result.hasOutstandingRecall === true') && pdf.includes('Safety Recall'));
}

// ── 9. row() wraps, road-tax basis is not clipped, glyphs are sanitised ──────────────────────────
console.log('\n9. PDF wrapping / clip removal / glyph safety');
{
  const pdf = read('app/api/generate-pdf/route.js');
  ok('9a: row() wraps its value via splitTextToSize', pdf.includes('const valueLines = doc.splitTextToSize(pdfText(str(value))'));
  ok('9a: row() renders the wrapped lines and advances by their count', pdf.includes('doc.text(valueLines, MARGIN + LABEL_W, y)') && pdf.includes('y += valueLines.length * 5'));
  ok('9b: the road-tax basis is no longer clip()d', pdf.includes("row('Basis', str(rt.basis))") && !pdf.includes('clip(str(rt.basis)'));
  ok('9c: pdfText preserves BOTH currency symbols (£ and €)', pdf.includes('[^\\x00-\\x7F£€]'));
  ok('9c: the middle dot is downgraded, not dropped', pdf.includes("'·': '-'"));
  ok('9c: MOT defect text is sanitised through pdfText', pdf.includes('clip(pdfText(f.text)') && pdf.includes('clip(pdfText(a.text)'));
  ok('9c: advert seller text is sanitised', pdf.includes('clip(pdfText(ad.seller_name'));
}

// ── Client parity — the menu greys mileage_detail out too ─────────────────────────────────────────
console.log('\nClient parity');
{
  const page = read('app/page.js');
  ok('the report builder gates mileage_detail on genuine MOT readings', page.includes("key === 'mileage_detail'") && page.includes('genuineMotReadingCount(result.motHistory'));
  const checkout = read('app/api/stripe/checkout/route.js');
  ok('checkout fetches DVSA MOT to evaluate mileage_detail offerability', checkout.includes("checks.includes('mileage_detail')") && checkout.includes('getDvsaMotHistory'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
