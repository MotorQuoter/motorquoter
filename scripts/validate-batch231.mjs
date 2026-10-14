// batch 231 — a real report shown on the free-report page. batch 233 — swapped to the Crossland (SV24YCN).
// Checks the example constant against the stored report it was copied from (snapshot below, read in batch 233 from
// salvage_sessions 4bdffc9c-6752-4b6c-9eb9-77cc56e92c96 by a read-only select), formatted with the report's own
// formatters; then the page source: the card renders once, above the form; no literal price; the form and its POST
// body are unchanged; a floor row never shows a bare £500.
// £0 — no DB, no model call, no email.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch231.mjs
import { readFileSync } from 'node:fs';
import { FREE_REPORT_EXAMPLE as EX, exampleRows, truncateCheck, EXAMPLE_CHECK_CHARS } from '../config/freeReportExample.mjs';
import { partsTableCells } from '../lib/labour.mjs';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };

// ── stored values, verbatim from the row (batch 233 select) ──────────────────────────────────────────
const STORED = {
  id: '4bdffc9c-6752-4b6c-9eb9-77cc56e92c96',
  created_at: '2026-09-24T13:48:57.465389+00:00',
  vehicle_details: { year: '2024', make: 'VAUXHALL', model: 'CROSSLAND ULTIMATE TURBO AUTO', primaryDamage: 'Front End', secondaryDamage: 'Undercarriage', vrm: 'SV24YCN', lotNumber: '61691896' },
  _reconciledParts: [
    { name: 'Front bumper', action: 'replace', oem: 365, used: 200 },
    { name: 'Grille', action: 'replace', oem: 260, used: 90 },
    { name: 'Bonnet', action: 'replace', oem: 300, used: 165 },
    { name: 'Slam panel', action: 'replace', oem: 95, used: 50 },
    { name: 'Front wing', action: 'replace', oem: 235, used: 130 },
    { name: 'Headlamp', action: 'replace', oem: null, used: 350 },
    { name: 'Radiator pack', action: 'replace', oem: 545, used: 300 },
    { name: 'Wheel arch liner', action: 'replace', oem: 65, used: 35 },
    { name: 'Front structure', action: 'inspect', oem: null, used: 500, _structFloor: true },
    { name: 'SRS airbag kit (deployed)', action: 'replace', oem: null, used: 500, _srsFloor: true },
    { name: 'Front fog lamp', action: 'replace', oem: null, used: 50 },
    { name: 'Labour & paint (new & painted)', action: '—', oem: 1500, used: null, _codeLabour: true },
  ],
  parts_sum: 3870,
  afterRepairValue: 9666,
  marginScenarios: [[1000, 412.8], [1700, 514.8], [2500, 634.8], [3300, 676.8], [4100, 790.8], [4800, 820.8]],
  rebuild: { value: 4968, assumption: 'Break-even hammer — the most you can bid, rebuild, and exit at the after-repair value with zero margin.' },
  checklist: "1. Show the front chassis leg/rail behind the damaged front corner from below, and the inner wing, for any deformation, folding or buckling — this is the key structural question.\n2. Show the damaged-side front wheel and suspension close up (hub carrier, lower arm, subframe mount) and confirm whether the wheel sits straight in the arch.\n3. Confirm frontal airbag deployment — show the steering wheel centre and passenger fascia (interior shots suggest deployed bag material is present in the cabin).\n4. Attempt to establish why the vehicle does not run — show the front wiring loom, cooling/battery area and any obvious severed connectors; note whether the engine will attempt to crank with keys.",
};
// the report's formatters (app/salvage/success/page.js): fmtP for ledger/investment, 2dp fmtGbp for the margin table
const fmtP = (v) => `£${Number(v).toLocaleString('en-GB')}`;
const fmt2 = (v) => '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseChecklist = (t) => t.split('\n').map(l => l.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
// a row's charged figure as the report prints it: partsTableCells places it; a floor row prints "from £X"
const printed = (p) => { const c = partsTableCells(p); return (c.from ? 'from ' : '') + fmtP(c.repair ?? c.sh ?? c.oem); };
const pounds = (s) => Number(String(s).replace(/[^0-9.]/g, ''));

console.log('\n[1] every figure equals the stored report');
check('session id', EX.sessionId === STORED.id);
const vd = STORED.vehicle_details;
check('vehicle line = year make model', EX.vehicle === [vd.year, vd.make, vd.model].join(' '));
check('damage = primaryDamage / secondaryDamage', EX.damage === `${vd.primaryDamage} / ${vd.secondaryDamage}`);
check('all 12 stored rows, same order', EX.rows.length === 12 && STORED._reconciledParts.length === 12);
STORED._reconciledParts.forEach((p, i) => {
  const name = p._codeLabour ? p.name : `${p.name} (${p.action})`;
  check(`row ${i + 1} ${name} = ${printed(p)}`, EX.rows[i]?.name === name && EX.rows[i]?.figure === printed(p));
});
const rowSum = STORED._reconciledParts.reduce((a, p) => a + (p.used ?? p.oem), 0);
check('rows sum to parts_sum', rowSum === STORED.parts_sum);
check('repair total = parts_sum (Bid S/H)', EX.repairTotal === fmtP(STORED.parts_sum));
check('worth repaired = afterRepairValue', EX.worthRepaired === fmtP(STORED.afterRepairValue));
const below = STORED.marginScenarios.filter(([h]) => h <= STORED.rebuild.value).sort((x, y) => y[0] - x[0])[0];
check('fee rung = stored rung nearest below break-even (£4,800)', below[0] === 4800 && EX.feesHammer === fmt2(below[0]));
check('fees = stored totalIncVat at that rung', EX.fees === fmt2(below[1]));
check('break-even = bidCeilings.rebuild', EX.breakEven === fmtP(STORED.rebuild.value));
check('report labels that ceiling break-even', /^Break-even hammer/.test(STORED.rebuild.assumption));
const items = parseChecklist(STORED.checklist);
check('checklist = first three stored items verbatim', EX.checklist.length === 3 && EX.checklist.every((c, i) => c === items[i]));

console.log('\n[1b] a floor row never shows a bare £500');
const floors = EX.rows.filter((r) => pounds(r.figure) === 500);
check('two floor rows, both "from £500"', floors.length === 2 && floors.every((r) => r.figure === 'from £500'));
const exAll = JSON.stringify(EX);
check('every £500 in the constant is preceded by "from "', (exAll.match(/£500/g) || []).length === (exAll.match(/from £500/g) || []).length);

console.log('\n[2] shortening only truncates; the row rule');
for (const c of EX.checklist) {
  const t = truncateCheck(c);
  check(`"${t.slice(0, 30)}…" is a prefix + ellipsis, ≤ ${EXAMPLE_CHECK_CHARS + 1} chars`,
    t === c || (t.endsWith('…') && c.startsWith(t.slice(0, -1)) && t.length <= EXAMPLE_CHECK_CHARS + 1));
}
check('short text untouched', truncateCheck('Show the wheels.') === 'Show the wheels.');
const shown = exampleRows();
const sorted = EX.rows.map((r) => pounds(r.figure)).sort((x, y) => y - x);
check('12 rows → 4 shown + "+ 8 more lines"', shown.rows.length === 4 && shown.more === 8);
check('the 4 shown are the 4 largest', shown.rows.map((r) => pounds(r.figure)).join() === sorted.slice(0, 4).join());
check('shown: Labour £1,500, both from £500 floors, Headlamp £350',
  shown.rows.map((r) => r.figure).join('|') === '£1,500|from £500|from £500|£350');
check('every £500 shown on the card is "from £500"', shown.rows.filter((r) => pounds(r.figure) === 500).every((r) => r.figure.startsWith('from ')));
const seven = Array.from({ length: 7 }, (_, i) => ({ name: `r${i}`, figure: `£${(i + 1) * 100}` }));
const cut = exampleRows(seven);
check('7 rows → 4 largest + 3 more', cut.rows.length === 4 && cut.more === 3 && cut.rows[0].figure === '£700' && cut.rows[3].figure === '£400');
check('5 rows → all 5', exampleRows(seven.slice(0, 5)).rows.length === 5);

console.log('\n[3] page source');
const page = readFileSync(new URL('../app/salvage/free-report/page.js', import.meta.url), 'utf8');
const uses = page.match(/<ExampleReport \/>/g) || [];
check('card rendered once', uses.length === 1);
check('estimate note in the constant', EX.note === "The report's estimate from the auction photos. You can strike or add any line.");
check('note rendered once, directly under the vehicle line', (page.match(/\{EX\.note\}/g) || []).length === 1
  && page.indexOf('{EX.note}') > page.indexOf('{EX.damage}') && page.indexOf('{EX.note}') < page.indexOf('{rows.map('));
check('card sits after the intro sentence', page.indexOf('<ExampleReport />') > page.indexOf('{FREE_REPORT_STRINGS.requestForm}'));
check('card sits above the form', page.indexOf('<ExampleReport />') < page.indexOf('<form onSubmit={submit}>'));
check('no literal £ price in the page', !/£\s?\d/.test(page));
check('paid price still from PRICING', page.includes('PRICING.salvageAssessment.price'));
check('no verdict words in card', !/good buy|recommend|bargain|profit/i.test(page + JSON.stringify(EX)));
check('POST body unchanged (UTM still sent)', page.includes("body: JSON.stringify({ email, marketingOptIn: optIn, ...utm }),"));
check('posts to the same route', page.includes("fetch('/api/salvage/free-report/request'"));
check('consent tick unticked by default', page.includes('useState(false); // ruling: UNTICKED by default'));
check('UTM read unchanged', page.includes('const utm = readStoredUtm(storage);'));
check('headline draft', page.includes('See what you&apos;re bidding on. Your first report&apos;s free.'));
check('page never queries the database', !/supabase|fetch\([^)]*salvage_sessions/i.test(page));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
