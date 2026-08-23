// Validator — historic (40-year) vehicle tax exemption (batch 44). £0: pure roadTax + structural.
//
// The live defect: a 1980 Escort was quoted £230/yr, a 1972 MGB £375/yr — both £0-eligible, wrong by
// the entire amount, because lib/roadTax.mjs had no historic handling. The fix must (a) DERIVE the
// cutoff from the tax year in force (not hardcode 1986, which breaks on 1 April 2027), and (b) render
// the qualifying-on-age fact ALONGSIDE the normal rate — never "£0" alone (the exemption is not
// automatic; the keeper must apply, which no data we hold can confirm).
//
// Run: node scripts/validate-road-tax.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { estimateRoadTax, historicEligibility } from '../lib/roadTax.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function assert(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS — ${label}`); pass++; }
  else { console.log(`  FAIL — ${label}\n         expected ${e}\n         actual   ${a}`); fail++; }
}
function ok(label, cond) { assert(label, !!cond, true); }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const AUG_2026 = Date.UTC(2026, 7, 15);  // 2026/27 VED year
const FEB_2027 = Date.UTC(2027, 1, 15);  // still 2026/27 (before 1 April)
const MAY_2027 = Date.UTC(2027, 4, 15);  // 2027/28 VED year (after 1 April)

// ── 1. The derivation ROLLS — 1986 this year, 1987 next (never hardcoded) ─────────────────────────
console.log('\n1. Cutoff derived from the VED year in force (not hardcoded 1986)');
assert('2026/27 → built-before 1 January 1986', historicEligibility({ yearOfManufacture: 1980, nowMs: AUG_2026 }).cutoffYear, 1986);
assert('Feb 2027 is still 2026/27 (VED year starts 1 April) → 1986', historicEligibility({ yearOfManufacture: 1980, nowMs: FEB_2027 }).cutoffYear, 1986);
assert('2027/28 (after 1 April 2027) → 1987 — the roll a hardcoded 1986 would miss', historicEligibility({ yearOfManufacture: 1980, nowMs: MAY_2027 }).cutoffYear, 1987);

// ── 2. The defect cases — eligible AND still show the normal rate ──────────────────────────────────
console.log('\n2. The reported defect: eligible on age, normal rate still shown');
{
  const escort = estimateRoadTax({ firstRegistration: '1980-06', engineCC: 1300, nowMs: AUG_2026 });
  assert('1980 Escort still quotes its normal £230 (not £0)', escort.annual, 230);
  ok('1980 Escort flagged historic-eligible', escort.historic?.eligible === true);
  const mgb = estimateRoadTax({ firstRegistration: '1972-04', engineCC: 1800, nowMs: AUG_2026 });
  assert('1972 MGB still quotes its normal £375', mgb.annual, 375);
  ok('1972 MGB flagged historic-eligible', mgb.historic?.eligible === true);
  ok('NEVER "£0" alone — annual is the normal rate, historic is a conditional beside it', escort.annual !== 0 && !!escort.historic);
}

// ── 3. Eligibility boundaries — build year, 8-January reg offset ───────────────────────────────────
console.log('\n3. Eligibility boundaries');
ok('built 1985 → eligible (built before 1 Jan 1986)', historicEligibility({ yearOfManufacture: 1985, nowMs: AUG_2026 }).eligible);
ok('built 1986 → NOT eligible in 2026/27', !historicEligibility({ yearOfManufacture: 1986, nowMs: AUG_2026 }).eligible);
ok('first registered 1986-01 (=1 Jan, before 8 Jan) → eligible', historicEligibility({ firstRegistration: '1986-01', nowMs: AUG_2026 }).eligible);
ok('first registered 1986-02 → NOT eligible', !historicEligibility({ firstRegistration: '1986-02', nowMs: AUG_2026 }).eligible);
ok('a 1990 car is untouched (not eligible, normal rate)', estimateRoadTax({ firstRegistration: '1990-01', engineCC: 1400, nowMs: AUG_2026 }).historic == null);
ok('in 2027/28 a 1986 car BECOMES eligible (the roll)', historicEligibility({ yearOfManufacture: 1986, nowMs: MAY_2027 }).eligible);

// ── 4. The conditional wording — not automatic, must apply, exclusions ────────────────────────────
console.log('\n4. Honest conditional wording (never a bare £0)');
{
  const note = estimateRoadTax({ firstRegistration: '1980-06', engineCC: 1300, nowMs: AUG_2026 }).historic.note;
  ok('says qualifies on age', /qualifies on age/i.test(note));
  ok('says NOT automatic / must apply', /not automatic/i.test(note) && /must apply/i.test(note));
  ok('says the rate above still applies until then', /still applies/i.test(note));
  ok('carries the exclusions (hire or reward / commercially)', /hire or reward/i.test(note) && /commercial/i.test(note));
  ok('names the derived £0 historic-class figure', note.includes('£0') && note.includes('1986'));
}

// ── 5. STRUCTURAL — both surfaces render the conditional + still show the rate ────────────────────
console.log('\n5. Render surfaces');
{
  const web = read('app/payment-success/page.js');
  ok('web renders the historic conditional', web.includes('rt.historic?.eligible') && web.includes('rt.historic.note'));
  ok('web still shows the normal Annual Road Tax row (rate not replaced)', web.includes('label="Annual Road Tax"'));
  const pdf = read('app/api/generate-pdf/route.js');
  ok('PDF renders the historic conditional', pdf.includes('rt.historic?.eligible') && pdf.includes('rt.historic.note'));
  const lib = read('lib/roadTax.mjs');
  ok('the cutoff is DERIVED from the VED year, not a hardcoded 1986 literal', lib.includes('vedYearInForce') && !/const\s+\w*1986/.test(lib) && !/=== 1986|> 1986|< 1986/.test(lib));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
