// Validator — pricing defect fix + menu-scope gate (£0: no network, no provider, no Stripe).
//
// Guards three things that must not silently regress:
//   1. THE HOLE — a disabled/unknown key must be REJECTED at checkout and must never trigger the
//      paid AutoCheck. This is the ROI_TIERS-class exploit: setting a key disabled is NOT enough,
//      because metadata/success_url and needsAutocheck were the real leak. Assert on the GATE.
//   2. THE PRICES — writeoff/finance/stolen off the menu; full_history £6.99, road_tax £0.99,
//      service_history £4.99 (no £3.49), Cazana £0.99. IE menu frozen.
//   3. THE COVERAGE + ROAD-TAX derivations both sides rely on.
//
// Run: node scripts/validate-pricing.mjs

import { readFileSync } from 'node:fs';
import { PRICING, IE_MENU } from '../config/pricing.js';
import { rejectedKeys, needsAutocheck, enabledKeySet } from '../lib/menuGate.mjs';
import { serviceHistoryOfferable } from '../config/serviceHistoryCoverage.mjs';
import { notOfferableForVehicle, hasVehicleGatedKey } from '../lib/offerability.mjs';
import { estimateRoadTax } from '../lib/roadTax.mjs';
import { checkMileageTimeline } from '../lib/mileageCheck.mjs';
import { nearest99, derivedIeGbpPrice, IE_MENU_GBP_EUR_RATE } from '../config/ieMenuPricing.mjs';
import { MENU_COSTS, MARKET_OVERHEAD, COST_FLOOR_PCT, worstCaseMargin } from '../config/menuCosts.mjs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.error(`✗ ${label}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
};
const ok = (label, cond) => { if (cond) { pass++; } else { fail++; console.error(`✗ ${label}`); } };

const MENU = [...PRICING.menu, ...IE_MENU];
const menuMap = Object.fromEntries(MENU.map(i => [i.key, i]));

// ── 1. THE HOLE — reject at the gate, never trigger AutoCheck ─────────────────────
// A crafted basket carrying a removed key is rejected (allow-list, not deny-list).
ok('reject: valuation+writeoff → writeoff rejected', rejectedKeys(['valuation', 'writeoff'], MENU).includes('writeoff'));
ok('reject: finance rejected', rejectedKeys(['valuation', 'finance'], MENU).includes('finance'));
ok('reject: stolen rejected', rejectedKeys(['valuation', 'stolen'], MENU).includes('stolen'));
ok('reject: unknown key rejected', rejectedKeys(['totally_made_up'], MENU).includes('totally_made_up'));
eq('accept: an all-enabled basket has zero rejects', rejectedKeys(['valuation', 'full_history', 'mot', 'service_history', 'road_tax'], MENU), []);

// The paid AutoCheck fires ONLY for full_history — the removed singles can never reach it.
ok('autocheck: full_history triggers', needsAutocheck(['full_history']) === true);
ok('autocheck: valuation+writeoff does NOT trigger', needsAutocheck(['valuation', 'writeoff']) === false);
ok('autocheck: crafted writeoff/finance/stolen basket does NOT trigger', needsAutocheck(['writeoff', 'finance', 'stolen']) === false);
ok('autocheck: plain valuation does NOT trigger', needsAutocheck(['valuation']) === false);

// ── 2. THE PRICES ─────────────────────────────────────────────────────────────────
const enabled = enabledKeySet(MENU);
for (const dead of ['writeoff', 'finance', 'stolen']) {
  ok(`menu: ${dead} is NOT an enabled/purchasable key`, !enabled.has(dead));
}
ok('menu: full_history enabled', enabled.has('full_history'));
eq('price: full_history £6.99', menuMap.full_history?.price, 6.99);
ok('menu: road_tax enabled', enabled.has('road_tax'));
eq('price: road_tax £0.99', menuMap.road_tax?.price, 0.99);
eq('price: service_history £4.99 (no £3.49)', menuMap.service_history?.price, 4.99);
ok('price: no menu item is still £3.49', !MENU.some(i => i.price === 3.49));
eq('price: market_demand £0.99', menuMap.market_demand?.price, 0.99);
eq('price: previous_adverts £0.99', menuMap.previous_adverts?.price, 0.99);
// IE sterling-price rule (batch 32): an IE row's `price` is its `priceEUR` ÷ GBP_EUR_RATE, rounded to
// the nearest .99, HELD AS A LITERAL. This round-trip is the gate — a euro reprice that forgets the
// sterling twin turns it red (the exact blind spot behind the £15.00/€24.99 split). Held numbers vs
// derived numbers, one currency to the other, from config/ieMenuPricing.mjs.
for (const row of IE_MENU) {
  if (!row.priceEUR) continue; // zero-priced rows (ie_nct) are out of scope — skip, don't assert 0===0
  eq(`IE rule: ${row.key} £${row.price} === nearest99(€${row.priceEUR} ÷ ${IE_MENU_GBP_EUR_RATE})`,
     row.price, derivedIeGbpPrice(row.priceEUR));
}
eq('IE frozen: ie_history priceEUR €24.99 (not break-even 17.99)', menuMap.ie_history?.priceEUR, 24.99);
eq('IE: ie_history £20.99 (the derived sterling twin)', menuMap.ie_history?.price, 20.99);
eq('IE: ie_service_history moved to £4.99 (LIVE −1p from £5.00)', menuMap.ie_service_history?.price, 4.99);
eq('IE frozen: ie_history still disabled', menuMap.ie_history?.enabled, false);

// ie_nct HONESTY (batch 38): status only — no test-history promise, and the dead ncthistory call gone.
eq('ie_nct label is "NCT Status" (not "NCT History")', menuMap.ie_nct?.label, 'NCT Status');
ok('ie_nct label + description promise no history / records / past tests',
   !/history|records|past\s*test/i.test(`${menuMap.ie_nct?.label ?? ''} ${menuMap.ie_nct?.description ?? ''}`));
// The rule is IE_MENU-only. salvageAssessment is EXCLUDED (its EUR path is retired — SalvageIEDoor);
// pin its £ explicitly so nobody later "completes" the rule by applying it there.
eq('salvageAssessment.price pinned £8.99 (rule does NOT touch it)', PRICING.salvageAssessment.price, 8.99);
// nearest99 itself — the tie rule and the guards the round-trip leans on.
eq('nearest99: €5.99÷1.17 → £4.99', derivedIeGbpPrice(5.99), 4.99);
eq('nearest99: €24.99÷1.17 → £20.99', derivedIeGbpPrice(24.99), 20.99);
eq('nearest99: exact tie 1.49 rounds UP to 1.99', nearest99(1.49), 1.99);
eq('nearest99: 0 / absent → 0 (skipped by callers)', nearest99(0), 0);

// ── 3a. COVERAGE gate (make + year; VIN stays server-side) ────────────────────────
ok('coverage: FORD 2015 offerable', serviceHistoryOfferable({ make: 'FORD', yearOfManufacture: 2015 }).offerable === true);
eq('coverage: FORD 2008 → pre_2012', serviceHistoryOfferable({ make: 'FORD', yearOfManufacture: 2008 }).reason, 'pre_2012');
eq('coverage: TESLA → make_not_covered', serviceHistoryOfferable({ make: 'TESLA', yearOfManufacture: 2020 }).reason, 'make_not_covered');
ok('coverage: FERRARI 2015 (limited tier) still offerable', serviceHistoryOfferable({ make: 'FERRARI', yearOfManufacture: 2015 }).offerable === true);
ok('coverage: case-insensitive make', serviceHistoryOfferable({ make: 'volkswagen', yearOfManufacture: 2014 }).offerable === true);

// ── 3b. ROAD TAX derivations ──────────────────────────────────────────────────────
eq('roadtax: 2015 petrol 120g → band C £35', estimateRoadTax({ firstRegistration: '2015-06', co2: 120, fuelType: 'PETROL', engineCC: 1600 }).annual, 35);
eq('roadtax: 2010 diesel 999g → band M £790', estimateRoadTax({ firstRegistration: '2010-01', co2: 999, fuelType: 'DIESEL', engineCC: 3000 }).annual, 790);
eq('roadtax: 2018 → standard £200', estimateRoadTax({ firstRegistration: '2018-03', co2: 130, fuelType: 'PETROL', engineCC: 1500 }).annual, 200);
ok('roadtax: 2018 carries the conditional expensive-car supplement', !!estimateRoadTax({ firstRegistration: '2018-03', co2: 130, fuelType: 'PETROL' }).supplement);
// Pre-2001 rates supplied by Cowork 20 Aug from V149 April 2026 + gov.uk (agreeing sources).
eq('roadtax: pre-2001 ≤1549cc → £230', estimateRoadTax({ firstRegistration: '1998-05', engineCC: 1400 }).annual, 230);
eq('roadtax: pre-2001 >1549cc → £375', estimateRoadTax({ firstRegistration: '1998-05', engineCC: 1800 }).annual, 375);
ok('roadtax: pre-2001 with unknown engine size → annual null (no guess)', estimateRoadTax({ firstRegistration: '1998-05', engineCC: null }).annual === null);
ok('roadtax: 2005 with no CO2 on record → annual null, not a guess', estimateRoadTax({ firstRegistration: '2005-05', co2: null, fuelType: 'PETROL' }).annual === null);
// EV expensive-car: £50,000 threshold, and zero-emission registered before 1 Apr 2025 is exempt.
ok('roadtax: EV registered before Apr 2025 → NO supplement (exempt)', estimateRoadTax({ firstRegistration: '2022-06', co2: 0, fuelType: 'ELECTRIC' }).supplement === null);
ok('roadtax: EV registered Apr 2025+ → £50,000 threshold line', /£50,000/.test(estimateRoadTax({ firstRegistration: '2025-06', co2: 0, fuelType: 'ELECTRIC' }).supplement?.note || ''));
ok('roadtax: petrol 2018 → £40,000 threshold line', /£40,000/.test(estimateRoadTax({ firstRegistration: '2018-03', co2: 130, fuelType: 'PETROL' }).supplement?.note || ''));
eq('roadtax: regime boundary — 1 Apr 2017 is standard', estimateRoadTax({ firstRegistration: '2017-04', co2: 100, fuelType: 'PETROL' }).regime, 'standard_2017');
eq('roadtax: regime boundary — Mar 2017 is CO2', estimateRoadTax({ firstRegistration: '2017-03', co2: 100, fuelType: 'PETROL' }).regime, 'co2_2001');

// ── 4. PER-VEHICLE OFFERABILITY (Defect 2 — the second axis the allow-list can't see) ─────────────
const MG_2017 = { make: 'MG', yearOfManufacture: 2017 };       // not among the 44 covered makes
ok('offerability: service_history NOT offerable for MG → checkout rejects', notOfferableForVehicle(['valuation', 'service_history'], MG_2017).includes('service_history'));
ok('offerability: FORD 2015 covered → not rejected', notOfferableForVehicle(['service_history'], { make: 'FORD', yearOfManufacture: 2015 }).length === 0);
ok('offerability: FORD 2008 pre-2012 → rejected', notOfferableForVehicle(['service_history'], { make: 'FORD', yearOfManufacture: 2008 }).includes('service_history'));
ok('offerability: non-gated keys never rejected', notOfferableForVehicle(['valuation', 'full_history', 'road_tax'], MG_2017).length === 0);
ok('offerability: hasVehicleGatedKey true for service_history', hasVehicleGatedKey(['service_history']) === true);
ok('offerability: hasVehicleGatedKey false for a plain basket', hasVehicleGatedKey(['valuation', 'full_history']) === false);

// ── 5. MILEAGE — free/paid consistency + naming the source (Defect 4) ──────────────────────────────
const T = (date, odo, unit = 'mi') => ({ completedDate: date, odometerValue: odo, odometerUnit: unit, testResult: 'PASSED' });
const motRun = [T('01/06/2022', '60000'), T('01/06/2023', '70000'), T('01/06/2024', '74438')];
// Entered figure well below the last MOT (gap > 1,000 tolerance): flagged (status discrepancy so BOTH
// surfaces warn) but NOT called clocking.
const entered = checkMileageTimeline(motRun, { currentMileage: 72000 });
ok('mileage: entered-below-MOT is a QUERY, not a discrepancy', entered.status === 'query');
ok('mileage: entered-below-MOT is NOT a rollback', entered.hasRollback === false && entered.enteredBelowMot === true);
ok('mileage: entered query wording asks to confirm, never accuses clocking', /is it right\?/i.test(entered.verdict) && !/clock/i.test(entered.verdict) && !/⚠️/.test(entered.verdict));
// A genuine MOT-vs-MOT rollback still reads as a clocking warning (discrepancy, not query).
const rollback = checkMileageTimeline([T('01/06/2022', '80000'), T('01/06/2023', '50000')]);
ok('mileage: genuine MOT rollback still flags as clocking discrepancy', rollback.status === 'discrepancy' && rollback.hasRollback === true && /dropped from/.test(rollback.verdict));

// ── 6. STRUCTURAL GUARDS — read the source, assert parity (Defect 1 + Defect 3) ────────────────────
const pageSrc = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const psSrc   = readFileSync(new URL('../app/payment-success/page.js', import.meta.url), 'utf8');
const pdfSrc  = readFileSync(new URL('../app/api/generate-pdf/route.js', import.meta.url), 'utf8');

// Defect 1: Select All must filter by offerability, not the raw menu.
ok('guard: Select All selects only offerable enabled keys', pageSrc.includes('setSelectedKeys(enabledItems.filter(i => keyOfferableForVehicle(i.key)).map(i => i.key))'));
ok('guard: page.js no longer selects the whole enabled menu unfiltered', !/setSelectedKeys\(enabledItems\.map\(i => i\.key\)\)/.test(pageSrc));

// Defect 3: every purchasable content key with a screen renderer must have a PDF renderer.
const PDF_TRIGGER = {
  valuation: "has('valuation')", full_history: "has('full_history')",
  salvagehistory: 'result.salvageHistory', market_demand: "has('market_demand')",
  previous_adverts: "has('previous_adverts')", road_tax: "has('road_tax')",
  mot: "has('mot')", mileage_detail: "has('mileage_detail')",
  service_history: "has('service_history')", owner_history: "has('owner_history')",
};
for (const [k, tok] of Object.entries(PDF_TRIGGER)) {
  ok(`parity: '${k}' renders on the payment-success screen`, psSrc.includes(`'${k}'`));
  ok(`parity: '${k}' renders in the PDF`, pdfSrc.includes(tok));
}

// ── 6b. ie_nct honesty structural checks (batch 38) ───────────────────────────────────────────────
const routeSrc   = readFileSync(new URL('../app/api/vehicle/route.js', import.meta.url), 'utf8');
ok('the ie_nct needsNct gate is gone', !routeSrc.includes('needsNct'));
// The ie_nct-serving cartell/ncthistory/v1 fetch is deleted. The ONLY ncthistory left is the dead
// roi_history path (isHistory) — ROI_TIERS territory, owned by the separate ROI_TIERS removal. Pin it
// at ≤1 so the ie_nct one cannot reappear and the roi one cannot multiply.
ok('the ie_nct ncthistory fetch is gone (≤1 actual fetch left, the roi_history dead path)',
   (routeSrc.match(/oneAutoFetch\(`cartell\/ncthistory/g) || []).length <= 1);
ok('the main IE render says "NCT Status", not "NCT History"',
   psSrc.includes('<SectionTitle>NCT Status</SectionTitle>') && !psSrc.includes('<SectionTitle>NCT History</SectionTitle>'));
ok('the main IE PDF section says "NCT Status"', pdfSrc.includes("sectionTitle('NCT Status')"));

// ── 7. MILEAGE VERDICT — one path, PDF wraps, cache is vehicle-scoped (Defects 4/5/6) ──────────────
const mileageSrc  = readFileSync(new URL('../lib/mileageCheck.mjs', import.meta.url), 'utf8');

// One verdict engine only — the human verdict string is produced in exactly one module.
const producers = [pageSrc, psSrc, pdfSrc, routeSrc, mileageSrc].filter((s) => s.includes('Mileage consistent across')).length;
ok('guard: "Mileage consistent across" is produced in exactly one module (mileageCheck)', producers === 1 && mileageSrc.includes('Mileage consistent across'));

// Defect 5 — the PDF verdict WRAPS (splitTextToSize + pdfText), never clip/truncate.
ok('guard: PDF mileage verdict wraps via splitTextToSize(pdfText(md.verdict))', pdfSrc.includes('splitTextToSize(pdfText(md.verdict)'));
ok('guard: PDF mileage verdict is not clipped/truncated', !/clip\(str\(md\.verdict\)/.test(pdfSrc));

// Defect 6 — the entered-vs-MOT itemised line is neutral (no rollback marker) on both surfaces.
ok('guard: screen neutralises the entered-vs-MOT detail line', psSrc.includes("a._userEntered || a.toDate === 'entered'"));
ok('guard: PDF neutralises the entered-vs-MOT detail line', pdfSrc.includes("a._userEntered || a.toDate === 'entered'"));

// Defect 4 — entered mileage (request-scoped) is NOT frozen into a VRM-keyed cache row; both hit-paths
// recompute from the cached MOT substrate, and both store the MOT-only verdict.
ok('guard: free path caches the MOT-only verdict (no entered mileage)', routeSrc.includes('mileageVerdict: buildMileageVerdict(freeMotTests),'));
ok('guard: paid path caches the MOT-only verdict (mileageTimelineBase)', routeSrc.includes('mileageVerdict: mkVerdict(mileageTimelineBase)'));
ok('guard: free cache-hit recomputes verdict from cached substrate', routeSrc.includes('buildMileageVerdict(cached.payload?.motHistory'));
ok('guard: paid cache-hit recomputes verdict from cached substrate', routeSrc.includes('checkMileageTimeline(clean.motHistory'));

// Naming: one product, one name across surfaces.
ok('guard: Previous Adverts title agrees on screen and PDF', psSrc.includes('SectionTitle>Previous Adverts') && pdfSrc.includes("sectionTitle('Previous Adverts')"));
ok('guard: Previous Searches self-check caveat present on screen and PDF', psSrc.includes('Includes checks run through MotorQuoter') && pdfSrc.includes('Includes checks run through MotorQuoter'));

// ── 8. MILEAGE TOLERANCE — asymmetric, one declaration, boundary-tested (Defect batch 18) ──────────
// Entered-vs-MOT = 1,000 mi (a user estimate, rounded); MOT-vs-MOT = 150 mi (a record vs itself).
const lastMot = [T('01/06/2022', '60000'), T('01/06/2024', '74438')];
ok('tolerance: entered 999 mi below last MOT → within tolerance (not flagged)', checkMileageTimeline(lastMot, { currentMileage: 74438 - 999 }).enteredBelowMot === false);
ok('tolerance: entered 1001 mi below last MOT → flagged', checkMileageTimeline(lastMot, { currentMileage: 74438 - 1001 }).enteredBelowMot === true);
ok('tolerance: the real 438-below case (Vincent) now PASSES', checkMileageTimeline(lastMot, { currentMileage: 74000 }).status === 'consistent');
// MOT-vs-MOT stays tight at 150 (unchanged) — boundary either side.
ok('tolerance: MOT-vs-MOT drop of 149 mi → no rollback (within 150)', checkMileageTimeline([T('01/06/2022', '70000'), T('01/06/2023', '69851')]).hasRollback === false);
ok('tolerance: MOT-vs-MOT drop of 151 mi → rollback flagged', checkMileageTimeline([T('01/06/2022', '70000'), T('01/06/2023', '69849')]).hasRollback === true);

// SOFT CEILING — entered ABOVE last MOT is queried on implied RATE, not gap (batch 19). Pin asOf so
// months-since is deterministic: last MOT 60,000 on 01/01/2024, asOf 01/07/2024 ≈ 6 months.
const asOf = Date.UTC(2024, 6, 1);
const above = [T('01/01/2024', '60000')];
ok('ceiling: normal driving above last MOT (3,000 over ≈500/mo) → consistent', checkMileageTimeline(above, { currentMileage: 63000, asOf }).status === 'consistent');
ok('ceiling: 16,000 over ≈2,700/mo (under 3,000) → not queried', checkMileageTimeline(above, { currentMileage: 76000, asOf }).enteredAboveRate === false);
const aboveQuery = checkMileageTimeline(above, { currentMileage: 90000, asOf });
ok('ceiling: 30,000 over ≈5,000/mo (over 3,000) → QUERY', aboveQuery.status === 'query' && aboveQuery.enteredAboveRate === true);
ok('ceiling: transposed digit (60k→160k in 6mo ≈16,700/mo) → QUERY', checkMileageTimeline(above, { currentMileage: 160000, asOf }).enteredAboveRate === true);
ok('ceiling: an above query never reads as clocking', !/clock/i.test(checkMileageTimeline(above, { currentMileage: 160000, asOf }).verdict));

// One declaration, in mileageCheck only — no surface re-declares any mileage threshold.
const tolDeclarers = [routeSrc, pageSrc, psSrc, pdfSrc].filter((s) => /toleranceMiles\s*[=?]|ROLLBACK_TOLERANCE|ENTERED_VS_MOT|IMPLIED_USAGE/.test(s)).length;
ok('guard: mileage thresholds are declared only in mileageCheck (no surface copy)', tolDeclarers === 0);
ok('guard: mileageCheck exports named entered (1000) + rollback (150) + usage (3000) thresholds', mileageSrc.includes('export const ENTERED_VS_MOT_TOLERANCE_MILES = 1000') && mileageSrc.includes('export const MOT_ROLLBACK_TOLERANCE_MILES = 150') && mileageSrc.includes('export const ENTERED_IMPLIED_USAGE_QUERY_PER_MONTH = 3000'));

// ── 8. THE MARGIN GATE (branch E, batch 43) — assert MONEY, not just literals ─────────────────────
// The gate existed because five items lost money bought singly, yet had no cost/margin assertion at
// all — ie_history sat at £15.00 / £14.40 cost (17p) through 105 green checks. Now every enabled item
// clears its gross cost + a floor, worst case (bought ALONE, + its market overhead).
const KNOWN_BASES = new Set(['account-rate', 'free', 'invoiced']);
const marketOf = (key) => IE_MENU.some(i => i.key === key) ? 'IE' : 'GB';

// §1.1 absence ≠ zero: every menu item must have a cost entry.
for (const item of MENU) {
  ok(`cost: '${item.key}' has a grossCost entry (absence is a failure, never £0)`, !!MENU_COSTS[item.key]);
}
// §4 unknown blocks enabled; a known basis permits.
for (const item of MENU.filter(i => i.enabled)) {
  const c = MENU_COSTS[item.key];
  ok(`cost: enabled '${item.key}' has a KNOWN basis (unknown must block enabled:true)`, !!c && c.basis !== 'unknown' && KNOWN_BASES.has(c.basis));
}
// §2/§3/§5 worst-case single-item margin ≥ floor, GBP and (modelled) EUR, market overhead included.
for (const item of MENU.filter(i => i.enabled && i.price > 0)) {
  const mk = marketOf(item.key);
  const m = worstCaseMargin(item.key, item.price, mk);
  ok(`margin: '${item.key}' worst-case £${item.price} alone = ${m ? (m.marginPct * 100).toFixed(1) : '??'}% ≥ ${(COST_FLOOR_PCT * 100)}% (cost £${m?.cost.toFixed(2)})`, !!m && m.marginPct >= COST_FLOOR_PCT);
  if (mk === 'IE' && item.priceEUR > 0) {
    const me = worstCaseMargin(item.key, item.priceEUR / IE_MENU_GBP_EUR_RATE, 'IE'); // MODELLED: GBP Stripe rate, no EUR charge has settled
    ok(`margin: '${item.key}' EUR path €${item.priceEUR} (modelled) = ${me ? (me.marginPct * 100).toFixed(1) : '??'}% ≥ ${(COST_FLOOR_PCT * 100)}%`, !!me && me.marginPct >= COST_FLOOR_PCT);
  }
}
// §6 no second source of cost truth in config/pricing.js.
ok('config/pricing.js carries NO cost field (menuCosts is the single source)', !/^\s*cost:\s*[\d.]/m.test(readFileSync(new URL('../config/pricing.js', import.meta.url), 'utf8')));
// Inverse regression (brief §6.2): sharedWith is IGNORED — an item priced below its STANDALONE cost
// FAILS the floor even though it rides a call it shares (owner_history rides full_history).
{
  const hypo = worstCaseMargin('owner_history', 0.20, 'GB'); // 20p price vs 24p standalone cost
  ok('inverse: an item below its STANDALONE cost fails even when it shares a call', !!hypo && hypo.margin < 0);
}
// §6.3 the £0 items are a VALID asserted state (basis free), distinct from unknown.
ok('free items (mot/mileage_detail/road_tax) are basis "free" £0, NOT "unknown"',
   MENU_COSTS.mot.basis === 'free' && MENU_COSTS.mileage_detail.basis === 'free' && MENU_COSTS.road_tax.basis === 'free' &&
   MENU_COSTS.mot.grossCost === 0);
// IE basket overhead is a real, attributed cost (not folded into items).
ok('IE market overhead is 18p account-rate (once/request); GB is £0', MARKET_OVERHEAD.IE.grossCost === 0.18 && MARKET_OVERHEAD.GB.grossCost === 0);
// ie_history stays disabled (brief §6.4 — its blocker is the render layer, not the margin).
ok('ie_history stays enabled:false regardless of its (passing) margin', menuMap.ie_history?.enabled === false);

console.log(`\nvalidate-pricing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
