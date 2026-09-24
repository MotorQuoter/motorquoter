// validate-batch189.mjs — batch 189 (Vincent, 24 Sep). £0, pure, no model calls.
//   P1 — PDF print faults: one character owner (lib/pdfText.mjs), one wrap path, header inside the band, no heading
//        stranded at a page foot. REAL renders through buildAssessmentPdf, read back with scripts/lib/pdfLayout.mjs.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch189.mjs
import { readFileSync } from 'fs';
import { PDF_CHAR_MAP, pdfSafe, isWinAnsi } from '@/lib/pdfText.mjs';
import { buildAssessmentPdf } from '@/app/api/salvage/pdf/route.js';
import { pdfLayout, isSectionHeading } from './lib/pdfLayout.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const RIGHT = 210 - 20;

console.log('\n-- P1 (a)/(b): the character map --');
for (const [ch, to] of Object.entries(PDF_CHAR_MAP)) {
  ok(`${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase()} → ${JSON.stringify(to)}, printable in WinAnsi`, pdfSafe(ch) === to && [...to].every(isWinAnsi));
}
ok('Windows-1252 characters pass through (not deleted): don’t “x” … € — – • £ ×', pdfSafe('don’t “x” … € — – • £ ×') === 'don’t “x” … € — – • £ ×');
ok('"≈ £2774" → "approx. £2774" (no double space where the symbol was)', pdfSafe('salvage ≈ £2774') === 'salvage approx. £2774');
ok('"−40°C" keeps its sign', pdfSafe('−40°C') === '-40°C');
ok('an unknown non-WinAnsi accented letter decomposes to its base letter (Erdős → Erdos)', pdfSafe('Erdős') === 'Erdos');
ok('a character with no printable form becomes "?", never vanishes (☃)', pdfSafe('a☃b') === 'a?b');

// A synthetic lot that exercises every fault seen on SV24YCN (be3ce53 preview, 24 Sep).
const vd = { vrm: 'SV24YCN', make: 'VAUXHALL', model: 'CROSSLAND', year: 2024, category: 'S', odometer: '14968' };
const brego = { retail_low_valuation: 15177, retail_average_valuation: 15933, retail_high_valuation: 16725, trade_low_valuation: 12472, trade_average_valuation: 13213, trade_high_valuation: 14003, _mileageSource: 'copart_listed', _mileageUsed: 14968 };
const row = { panelId: 'FRONT_BUMPER', name: 'Front bumper', action: 'replace', used: 200, oem: 365 };
const mk = (filler) => ({
  'Visible Damage Summary': 'This is a near-new (2024) current-generation Vauxhall Crossland Ultimate Turbo auto with genuinely low mileage (dash reads ~14,968), showing a single-event front-corner impact concentrated on one side — front bumper and grille torn away, bonnet buckled, slam panel and cooling pack disturbed, the front wing folded and the impact tracking rearward into the front door on that flank.',
  'Red Flags': ['- MOT ladder runs cleanly upward — 12,769 → 15,100 → 29,693 miles.', '- Dashboard shows −40°C ambient; don’t trust the sensor.', ...Array.from({ length: filler }, (_, i) => `- Filler line ${i} to move the section headings down the page so one of them lands at a page foot in some variant.`)].join('\n'),
  'Realistic Exit Value': 'Mid-high: ≈ £9,666 exit.',
  _slots: { flags: [], allClear: ['a', 'b', 'c', 'd'], groups: [{ id: 'g', label: 'Identity & Provenance', slots: [
    { id: 'a', label: 'Body style', verdict: 'confirmed', detail: 'x' }, { id: 'b', label: 'Salvage category recorded', verdict: 'confirmed', detail: 'x' },
    { id: 'c', label: 'Vendor type (windscreen sticker suffix X)', verdict: 'confirmed', detail: 'x' }, { id: 'd', label: 'Prior salvage auction history', verdict: 'confirmed', detail: 'x' },
    { id: 'e', label: 'Mileage corroborated against other sources', verdict: 'unconfirmed', detail: '14,968 miles — the listing and the dashboard photo agree; no MOT record exists yet (car under 3 years) ✓ ⚠️' },
    // filler slots sit ABOVE "Live Market Valuation", so each variant moves that heading 4 mm further down page 1
    ...Array.from({ length: filler }, (_, i) => ({ id: `f${i}`, label: `Filler check ${i}`, verdict: 'unconfirmed', detail: 'moves the next heading down' })),
  ] }] },
  _reconciledParts: [row],
  _partsReconciliation: { parts_sum: 200 },
  _partsSourcing: { disclosure: 'Affiliate links — we may earn a commission.', links: [0, 1, 2].map((i) => ({ url: `https://www.ebay.co.uk/sch/i.html?_nkw=part${i}`, cost: 200, feed: 'ebay', part: `Front bumper ${i}`, action: 'replace', tracked: true, _rowKeys: ['FRONT_BUMPER#0'], feedLabel: 'eBay UK · used / breakers' })) },
});

console.log('\n-- P1: real renders, read back (31 variants, headings moved down the page one filler line at a time) --');
let junk = 0, over = [], stranded = [], sourcingLabel = 0, approx = 0, pages = new Set(), headingsSeen = 0;
let hdr = null;
for (let n = 0; n <= 30; n++) {
  const { pages: P, items } = pdfLayout(buildAssessmentPdf(mk(n), vd, 'GB', 'SV24YCN', '24/09/2026', brego, null));
  pages.add(P);
  if (n === 0) hdr = items.filter((i) => i.page === 1 && i.y < 30);
  for (const it of items) {
    if (it.junk) junk++;
    if (!it.junk && it.x + it.w > RIGHT + 0.05) over.push(`v${n} p${it.page} ${it.text.slice(0, 40)} → ${(it.x + it.w).toFixed(1)}`);
    if (it.text === 'Find on eBay ->') sourcingLabel++;
    if (/approx\. £9,666/.test(it.text)) approx++;
    if (isSectionHeading(it)) headingsSeen++;
  }
  for (let p = 1; p < P; p++) { const last = items.filter((i) => i.page === p).at(-1); if (last && isSectionHeading(last)) stranded.push(`v${n} p${p} "${last.text}"`); }
}
ok('no string is written as UTF-16 junk in any variant (the eBay label printed "!\'")', junk === 0);
ok('"Find on eBay ->" is the printed link label (3 per render × 31)', sourcingLabel === 93);
ok('"≈ £9,666" prints "approx. £9,666"', approx === 31);
ok(`no text runs past the right margin (x + width ≤ ${RIGHT} mm)${over.length ? ' — ' + over.slice(0, 3).join(' | ') : ''}`, over.length === 0);
ok(`a section heading is never the last text on a page (${headingsSeen} headings over ${pages.size} page counts)${stranded.length ? ' — ' + stranded.join(' | ') : ''}`, stranded.length === 0 && pages.size > 1);
const inBand = (t) => { const it = hdr.find((i) => i.text === t); return it && it.y <= 28 && it.y - it.size * 0.72 / (72 / 25.4) >= 0; };
ok('header: "MOTORQUOTER", "Damage Assessment Report", the registration and the market line all sit inside the 28 mm band',
  ['MOTORQUOTER', 'Damage Assessment Report', 'SV24YCN', 'GB Market - 24/09/2026'].every(inBand));

console.log('\n-- P1: wiring --');
{
  const src = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  ok('str() maps through pdfSafe (no longer deletes every character above U+00FF)', src.includes('const str = (v) => pdfSafe(') && !src.includes(".replace(/[^\\x00-\\xFF]/g, '')"));
  ok('every doc text / measure call goes through pdfSafe', /for \(const m of \['text', 'textWithLink', 'splitTextToSize', 'getTextWidth'\]\)/.test(src));
  ok('the eight wrap sites measure in their drawing font (wrapIn), none left measuring first', (src.match(/wrapIn\(/g) || []).length >= 9);
}

console.log('\n-- P2: the Margin driver sentence runs before the claim binder; shape A takes "whose cost drivers are" --');
{
  const { codeOwnDriverSentence, bindClaimClasses } = await import('@/lib/parts.mjs');
  // SV24YCN's charged ledger (stored row 4bdffc9c, be3ce53 preview) and the model's raw Margin, verbatim
  const R = (panelId, name, action, used, extra = {}) => ({ panelId, name, action, used, oem: null, ...extra });
  const SV = [R('FRONT_BUMPER', 'Front bumper', 'replace', 200), R('GRILLE', 'Grille', 'replace', 90), R('BONNET', 'Bonnet', 'replace', 165),
    R('SLAM_PANEL', 'Slam panel', 'replace', 50), R('FRONT_WING', 'Front wing', 'replace', 130), R('HEADLAMP', 'Headlamp', 'replace', 350),
    R('RADIATOR_PACK', 'Radiator pack', 'replace', 300), R('WHEEL_ARCH_LINER', 'Wheel arch liner', 'replace', 35),
    R('FRONT_STRUCTURE', 'Front structure', 'inspect', 500, { _structFloor: true }), R('SRS_AIRBAG', 'SRS airbag kit (deployed)', 'replace', 500),
    R('FOG_LAMP', 'Front fog lamp', 'replace', 50), { name: 'Labour & paint (new & painted)', action: '—', used: null, oem: 1500, _codeLabour: true }];
  const RAW = 'The band position reflects a desirable, near-delivery-age, low-mileage vehicle offset by a moderate front-corner repair whose cost drivers are the LED headlamp, cooling pack, bonnet and slam panel. The repair is a substantial front-end rebuild rather than light cosmetic work, and the front-structure and non-runner unknowns could add materially if the rails are deformed. If the chassis is straight, the itemised panel repair stands as costed; if the front rails are folded, structural work must be added on top. The margin picture depends heavily on resolving those two unknowns before committing to a bid.';
  const r = codeOwnDriverSentence(RAW, SV);
  const WANT = 'The band position reflects a desirable, near-delivery-age, low-mileage vehicle offset by a moderate front-corner repair. The repair total is made up of: the front structure allowance, the SRS airbag kit (replace), the headlamp (replace), the radiator pack (replace), 7 other lines and labour & paint.';
  ok('shape A takes "whose cost drivers are" (SV24YCN)', r.stamp?.shape === 'A' && r.stamp.after === WANT);
  ok('shape A takes "whose cost driver is" (singular)', codeOwnDriverSentence('The band position is mid, offset by a repair whose cost driver is the bonnet.', SV).stamp?.shape === 'A');
  ok('(SV24YCN) the Margin, verbatim', r.text === `${WANT} The repair is a substantial front-end rebuild rather than light cosmetic work, and the front-structure and non-runner unknowns could add materially if the rails are deformed. If the chassis is straight, the itemised panel repair stands as costed; if the front rails are folded, structural work must be added on top. The margin picture depends heavily on resolving those two unknowns before committing to a bid.`);
  const ctx = { lampType: null, allowedFigures: [], partActions: SV.filter((g) => !/labour/i.test(g.name)).map((g) => [g.name, g.action]), evVerdict: null };
  ok('(SV24YCN) the binder then keeps the whole field — nothing of it is dropped', bindClaimClasses(r.text, ctx, 'speculation').dropped.length === 0);
  ok('(SV24YCN) the binder on the RAW sentence alone still drops it (the order is what saves it)', bindClaimClasses(RAW, ctx, 'speculation').dropped.some((d) => d.class === 'action'));
  const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
  const loop = route.slice(route.indexOf("['Key Cost Drivers', 'redflags'], ['Red Flags', 'redflags'],"), route.indexOf('assessment._proseDamageUncosted = addProseDamageInspection('));
  const iDriver = loop.indexOf('codeOwnDriverSentence(assessment[field], _chargedRows)'), iBind = loop.indexOf('bindClaimClasses(assessment[field], _claimCtx, mode)');
  ok('route: in the per-field loop, the driver step comes BEFORE the claim binder', iDriver > 0 && iBind > 0 && iDriver < iBind);
  ok('route: the driver step is called once', (route.match(/codeOwnDriverSentence\(assessment\[field\], _chargedRows\)/g) || []).length === 1);
  ok('route: a replaced sentence is still read by the 183 P3 check (its panels keep their inspection record)', loop.includes('unbindUnchargedCostClaims(_dr.stamp.before, _chargedIds)'));
}

console.log(`\nbatch189: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
