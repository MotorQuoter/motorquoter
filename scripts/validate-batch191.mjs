// validate-batch191.mjs — batch 191 (Vincent, 25 Sep). £0, pure, no model calls.
//   P1 — the claim binder's action class reads a repair/replace word as a part's action only when it is BOUND to the part;
//        "repair" as the name of the whole job ("the panel repair itself (bumper, wheel, …)") asserts no part's action.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch191.mjs
import { readFileSync } from 'fs';
import { bindClaimClasses, actionBoundToPartForTest as bound } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

console.log('\n-- P1: the rule, word by word --');
for (const [clause, name, kind, want] of [
  // the name of the whole job → not bound (keep)
  ['the panel repair itself (bumper, wheel, tyre, arch trim, refinish) is light-to-moderate', 'Wheel', 'repair', false],
  ['a moderate front-corner repair whose cost drivers are the LED headlamp, cooling pack, bonnet and slam panel.', 'Bonnet', 'repair', false],
  ['The repair is a moderate front-end rebuild (bumper, grille, lamp, wing, slam panel, radiator pack, refinish) plus flank cosmetic work', 'Grille', 'repair', false],
  ['the repair cost covers the bonnet and grille', 'Bonnet', 'repair', false],
  ['the replacement (bonnet, grille) is modest', 'Bonnet', 'replace', false],
  // bound to the part → contradiction stands (drop)
  ['the bumper is repaired', 'Front bumper', 'repair', true],
  ['the front bumper is repaired', 'Front bumper', 'repair', true],
  ['repair the bonnet', 'Bonnet', 'repair', true],
  ['bonnet (repair)', 'Bonnet', 'repair', true],
  ['a repaired front wing', 'Front wing', 'repair', true],
  ['the bonnet repair is light', 'Bonnet', 'repair', true],
  ['the repair of the bonnet is light', 'Bonnet', 'repair', true],
  ['the front wing needs repair', 'Front wing', 'repair', true],
  ['the bonnet is replaced', 'Bonnet', 'replace', true],
  ['replace the bonnet', 'Bonnet', 'replace', true],
  ['the bonnet replacement', 'Bonnet', 'replace', true],
]) ok(`${want ? 'bound  ' : 'job-noun'} ${kind}: ${JSON.stringify(clause)} / ${name}`, bound(clause, name, kind) === want);

console.log('\n-- P1: through the binder (both directions) --');
const ctx = (partActions) => ({ lampType: null, allowedFigures: [], partActions, evVerdict: null });
const KT = 'The band position reflects a desirable, low-mileage current-generation prestige coupé with contained front-corner damage — the panel repair itself (bumper, wheel, tyre, arch trim, refinish) is light-to-moderate per the Parts Breakdown.';
{
  // not alone in the field: the binder never blanks a field (batch 136 C2), so a lone sentence would be kept whole anyway
  const field = `${KT} The margin picture is positive.`;
  const r = bindClaimClasses(field, ctx([['Front bumper', 'replace'], ['Wheel', 'replace'], ['Front wing', 'replace'], ['Front structure', 'inspect']]), 'speculation');
  ok('(KT73YAJ, its replay ledger) the band-position sentence is KEPT (Wheel row = replace)', r.dropped.length === 0 && r.text === field);
}
{
  const SV = 'The band position reflects a desirable, near-delivery-age, low-mileage vehicle offset by a moderate front-corner repair whose cost drivers are the LED headlamp, cooling pack, bonnet and slam panel.';
  ok('(SV24YCN raw) "a moderate front-corner repair whose cost drivers are … bonnet" is KEPT (Bonnet row = replace)', bindClaimClasses(`${SV} The margin picture is positive.`, ctx([['Bonnet', 'replace']]), 'speculation').dropped.length === 0);
}
const drops = (s, pa) => bindClaimClasses(`Opening sentence stays. ${s}`, ctx(pa), 'redflags').dropped.filter((d) => d.class === 'action');
ok('"The bumper is repaired." with a replace row still DROPS', drops('The front bumper is repaired.', [['Front bumper', 'replace']]).length === 1);
ok('"Repair the bonnet." with a replace row still DROPS', drops('Repair the bonnet.', [['Bonnet', 'replace']]).length === 1);
ok('"The bonnet is replaced." with a repair row still DROPS', drops('The bonnet is replaced.', [['Bonnet', 'repair']]).length === 1);
ok('"The repair of the bonnet is light." with a replace row still DROPS', drops('The repair of the bonnet is light.', [['Bonnet', 'replace']]).length === 1);
ok('"The replacement (bonnet, grille) is modest." with a repair row is KEPT', drops('The replacement (bonnet, grille) is modest.', [['Bonnet', 'repair']]).length === 0);
ok('"The repair cost is modest (bonnet, grille)." with a replace row is KEPT', drops('The repair cost is modest (bonnet, grille).', [['Bonnet', 'replace']]).length === 0);

console.log('\n-- P1: no registration / field / lot keying --');
{
  const src = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function _actionBoundToPart'), src.indexOf('export { _actionBoundToPart'));
  ok('_actionBoundToPart names no registration', !/\b[A-Z]{2}\d{2}[A-Z]{3}\b|\b[A-Z]{3}\d{3,4}\b/.test(fn));
  ok('_actionBoundToPart reads no field name', !/Margin|Exit|Red Flags|Visible Damage|Bidder|Key Cost/.test(fn));
}

console.log('\n-- P2: a label never ends a page (real renders, the flag list moved down 4 mm at a time) --');
{
  const { buildAssessmentPdf } = await import('@/app/api/salvage/pdf/route.js');
  const { pdfLayout, labelsLastOnPage } = await import('./lib/pdfLayout.mjs');
  const REASON = 'Airbags deployed - replacement from £500 (kit and fitting), depending on the number and location of the bags. Seatbelt pretensioners and the SRS control unit are commonly replaced with the bags. This must be checked before bidding.';
  const vd = { vrm: 'SV24YCN', make: 'VAUXHALL', model: 'CROSSLAND', year: 2024 };
  const mk = (filler, reason = REASON) => ({
    'Visible Damage Summary': 'Front-corner impact.',
    _slots: { flags: [], allClear: [], groups: [{ id: 'identity', label: 'Identity & Provenance', slots: Array.from({ length: filler }, (_, i) => ({ id: `f${i}`, label: `Filler ${i}`, verdict: 'unconfirmed', detail: 'x' })) }] },
    _flaggedParts: [0, 1, 2, 3, 4].map((i) => ({ panelId: `P${i}`, partName: i ? `Flag ${i}` : 'SRS airbag (deployed)', weight: 'high', reason: i ? reason : REASON, _keep: true })),
  });
  let labelLast = [], apart = [], renders = 0, found = 0;
  for (let n = 0; n <= 70; n++) {
    const lay = pdfLayout(buildAssessmentPdf(mk(n), vd, 'GB', 'SV24YCN', '25/09/2026', null, null));
    renders++;
    labelLast.push(...labelsLastOnPage(lay).map((h) => `n=${n} p${h.page} "${h.text}"`));
    const lab = lay.items.find((i) => i.text === 'SRS airbag (deployed)');
    const rsn = lay.items.find((i) => /^Airbags deployed/.test(i.text) && lab && i.y > lab.y - 300);
    if (lab && rsn) found++;
    if (lab && rsn && lab.page !== rsn.page) apart.push(`n=${n}`);
  }
  ok(`no flag label / block label is the last line on a page over ${renders} variants${labelLast.length ? ' — ' + labelLast.slice(0, 3).join(' | ') : ''}`, labelLast.length === 0);
  ok(`the SRS flag label and its reason render in every variant (${found}/${renders})`, found === renders);
  ok(`"SRS airbag (deployed)" and "Airbags deployed – replacement from £500…" on the same page in every variant${apart.length ? ' — apart at ' + apart.join(',') : ''}`, apart.length === 0);
  // a reason taller than a page: the label keeps at least its first 2 lines, the rest breaks line by line
  const LONG = Array.from({ length: 90 }, (_, i) => `Line ${i} of a very long flag reason that must wrap.`).join(' ');
  const tall = pdfLayout(buildAssessmentPdf({ ...mk(10), _flaggedParts: [{ panelId: 'X', partName: 'Tall flag', weight: 'high', reason: LONG, _keep: true }] }, vd, 'GB', 'SV24YCN', '25/09/2026', null, null));
  const tl = tall.items.find((i) => i.text === 'Tall flag');
  const after = tall.items.filter((i) => tl && i.page === tl.page && i.y > tl.y && /^Line \d/.test(i.text));
  ok(`a reason taller than a page: the label keeps at least 2 reason lines on its page (${after.length})`, after.length >= 2);
  ok('…and nothing of the tall reason is lost (Line 89 prints)', tall.items.some((i) => /Line 89 of/.test(i.text)));
  const src = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  ok('the flag loop measures the reason before printing the label (keepLabelWithBody)', /keepLabelWithBody\(4, reasonLines\.length, 4, 3\)/.test(src) && !/checkPage\(reasonLines\.length \* 4 \+ 3\)/.test(src));
}

console.log(`\nbatch191: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
