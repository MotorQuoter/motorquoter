// validate-batch190.mjs — batch 190 (Vincent, 25 Sep). £0, pure, no model calls.
//   The Copart ERV printed "£13,250.00GBP" (PDF and web report): Copart glues the currency code to the figure, and the
//   PDF's str() GBP rule (/\bGBP\b/) never fired on it because "0G" has no word boundary. One display owner,
//   lib/copartErv.mjs fmtCopartErv(), is used by both surfaces; str() also catches a code glued to a number.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch190.mjs
import { readFileSync } from 'fs';
import { fmtCopartErv } from '@/lib/copartErv.mjs';
import { buildAssessmentPdf } from '@/app/api/salvage/pdf/route.js';
import { pdfLayout } from './lib/pdfLayout.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

console.log('\n-- the formatter --');
for (const [input, want] of [
  ['£13,250.00GBP', '£13,250'],     // SV24YCN stored row
  ['£12,667.00GBP', '£12,667'],
  ['£6,953.33GBP', '£6,953.33'],    // non-zero pence kept as Copart wrote them
  ['GBP 8,120.50', '£8,120.50'],    // code before the number (CLAUDE.md known issue)
  ['£13,250 GBP', '£13,250'],
  ['13,250.00 gbp', '£13,250'],     // any case, with a space
  ['GBP£13,250', '£13,250'],        // never "££"
  ['13250', '£13,250'],
  ['Not provided', 'Not provided'], // not money → unchanged, never blank
  ['£13,250 approx', '£13,250 approx'],
]) ok(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, fmtCopartErv(input) === want);
ok('null → nothing printed', fmtCopartErv(null) === '' && fmtCopartErv(undefined) === '');

console.log('\n-- wiring: the PDF and the web report both print through the one owner --');
{
  const pdf = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  const web = readFileSync(new URL('../app/salvage/success/page.js', import.meta.url), 'utf8');
  ok('PDF imports fmtCopartErv from lib/copartErv.mjs', /import \{ fmtCopartErv \} from '@\/lib\/copartErv\.mjs'/.test(pdf));
  ok('PDF prints the ERV as str(fmtCopartErv(vd.estimatedRetail))', pdf.includes('Copart ERV: ${str(fmtCopartErv(vd.estimatedRetail))}'));
  ok('PDF prints vd.estimatedRetail nowhere else', (pdf.match(/vd\.estimatedRetail/g) || []).length === 2);   // the guard + the owner call
  ok('web report imports fmtCopartErv from lib/copartErv.mjs', /import \{ fmtCopartErv \} from '@\/lib\/copartErv\.mjs'/.test(web));
  ok('web report prints {fmtCopartErv(vehicleDetails.estimatedRetail)}', web.includes('{fmtCopartErv(vehicleDetails.estimatedRetail)}'));
  ok('web report prints vehicleDetails.estimatedRetail nowhere else', (web.match(/vehicleDetails\??\.estimatedRetail/g) || []).length === 2);
}

console.log('\n-- real render: the ERV line and str() on glued codes --');
{
  const vd = { vrm: 'SV24YCN', make: 'VAUXHALL', model: 'CROSSLAND', year: 2024, category: 'S', odometer: '14968', estimatedRetail: '£13,250.00GBP' };
  const brego = { retail_low_valuation: 15177, retail_average_valuation: 15933, retail_high_valuation: 16725, trade_low_valuation: 12472, trade_average_valuation: 13213, trade_high_valuation: 14003, _mileageSource: 'copart_listed', _mileageUsed: 14968 };
  const a = {
    'Visible Damage Summary': 'Front-corner impact.',
    'Red Flags': ['- Retail was 8,120.00GBP at listing.', '- Seller quoted GBP8,120.50 for the pair.', '- Listed at £ GBP 500 reserve.', '- Priced in GBP only.'].join('\n'),
  };
  const { items } = pdfLayout(buildAssessmentPdf(a, vd, 'GB', 'SV24YCN', '25/09/2026', brego, null));
  const text = items.map((i) => i.text).join('\n');
  const erv = items.find((i) => i.text.startsWith('Copart ERV:'))?.text;
  ok(`the ERV line prints "Copart ERV: £13,250 — …" (got ${JSON.stringify(erv)})`, erv === 'Copart ERV: £13,250 — vendor-type interpretation in assessment');
  ok('str() on "…00GBP" → "£8,120.00"', text.includes('Retail was £8,120.00 at listing.'));
  ok('str() on "GBP8,120.50" → "£8,120.50"', text.includes('Seller quoted £8,120.50 for the pair.'));
  ok('str() on "£ GBP 500" → "£500" (never "££")', text.includes('Listed at £500 reserve.'));
  ok('str() on a bare "GBP" → "£", keeping the space after it (was "Priced in £only.")', text.includes('Priced in £ only.'));
  ok('no "GBP" anywhere in the render', !/GBP/i.test(text));
  ok('no "££" anywhere in the render', !/£\s*£/.test(text));
}

console.log(`\nbatch190: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
