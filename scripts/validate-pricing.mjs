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

import { PRICING, IE_MENU } from '../config/pricing.js';
import { rejectedKeys, needsAutocheck, enabledKeySet } from '../lib/menuGate.mjs';
import { serviceHistoryOfferable } from '../config/serviceHistoryCoverage.mjs';
import { estimateRoadTax } from '../lib/roadTax.mjs';

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
// IE frozen — supplier decision pending.
eq('IE frozen: ie_service_history £5.00', menuMap.ie_service_history?.price, 5.00);
eq('IE frozen: ie_history still disabled', menuMap.ie_history?.enabled, false);

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

console.log(`\nvalidate-pricing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
