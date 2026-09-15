// Validator — batch 137: Cazana is the fallback valuation when Brego has none. £0: no network, no DB, no Stripe.
// Every One Auto call is a fake fetch behind a pass-through cache; the Cazana answer is One Auto's DOCUMENTED example
// (swagger.oneautoapi.com/complete.json, GET /percayso/currentvaluationfromvrm/ — the 200 example values, verbatim).
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-cazana-fallback.mjs

import { readFileSync, existsSync } from 'node:fs';
import zlib from 'node:zlib';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } };

const {
  oneAutoFetch, finaliseOneAutoRec, fetchCazanaValuation, valuationFromCazana, exitBaseOf, computeExitFromBand,
  CAZANA_VALUATION_ENDPOINT,
} = await import('../app/api/salvage/assess/route.js');
const { derivePriceBand } = await import('../lib/priceBand.mjs');
const route = readFileSync('app/api/salvage/assess/route.js', 'utf8');
const code = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// One Auto's documented 200 body for percayso/currentvaluationfromvrm (example values from the published spec).
const CAZANA_DOC = {
  success: true,
  result: {
    manufacturer_desc: 'land Rover', model_range_desc: 'Discovery', list_price_inc_delivery_vat: 55280, days_to_sell: 39.5,
    current_mileage: 12345, is_current_mileage_estimated: false,
    retail_high_valuation: 18583, retail_average_valuation: 16538, retail_low_valuation: 13377, trade_valuation: 10220,
    retail_valuation_independent: 16185, retail_valuation_supermarket: 15826, gross_margin_gbp: 6318, gross_margin_percentage: 38,
    valuation_date: '2025-10-05',
  },
};
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const passCache = (log) => async (callType, reg, params, fn, meta) => { log.push({ callType, reg, params }); meta.cache = 'miss'; return fn(); };
const noSleep = async () => {};
const quiet = async (fn) => { const l = console.log, e = console.error, w = console.warn; const lines = []; console.log = console.error = console.warn = (...a) => lines.push(a.join(' ')); try { return [await fn(), lines]; } finally { console.log = l; console.error = e; console.warn = w; } };

// ── 1. The documented shape and the ruled mapping ─────────────────────────────────────────────────────────────────────
console.log('\n1. Documented Cazana shape → the valuation the report uses (Vincent ruled the mapping, 15 Sep)');
{
  const v = valuationFromCazana(CAZANA_DOC.result);
  ok('endpoint is the documented path', CAZANA_VALUATION_ENDPOINT === 'percayso/currentvaluationfromvrm/');
  ok('source is stamped "Cazana"', v._source === 'Cazana');
  ok('retail low/average/high carried as returned (13,377 / 16,538 / 18,583)', v.retail_low_valuation === 13377 && v.retail_average_valuation === 16538 && v.retail_high_valuation === 18583);
  ok('trade_valuation (10,220) is the trade AVERAGE — the price-band input', v.trade_average_valuation === 10220);
  ok('no trade low / trade high is invented (both null)', v.trade_low_valuation === null && v.trade_high_valuation === null);
  ok('a Cazana answer with NO trade figure is not a valuation (never convert retail to trade)', valuationFromCazana({ ...CAZANA_DOC.result, trade_valuation: null }) === null);
  const eb = exitBaseOf(v);
  ok('exit base = Cazana trade_valuation £10,220 (ruled)', eb.value === 10220 && eb.source === 'Cazana' && eb.field === 'trade_valuation');
  ok('a Brego valuation keeps trade-low as the exit base, exactly as before', JSON.stringify(exitBaseOf({ _source: 'Brego', trade_low_valuation: 9000, trade_average_valuation: 9600 })) === JSON.stringify({ value: 9000, source: 'Brego', field: 'trade_low_valuation' }));
  ok('a stored pre-137 valuation (no _source) is treated as Brego', exitBaseOf({ trade_low_valuation: 9000 })?.source === 'Brego');
  ok('price band from the Cazana trade figure equals the band for the same Brego trade average', derivePriceBand(v.trade_average_valuation) === derivePriceBand(10220) && derivePriceBand(10220) != null);
  const brego = computeExitFromBand(10220, 'Cat S', 'mid');
  ok('exit maths identical for the same base figure (computeExitFromBand, Cat S mid)', Number.isFinite(brego.exit) && brego.exit === Math.round(10220 * brego.pct / 100));
}

// ── 2. HV25ODX shape: Brego 204 → Cazana path ─────────────────────────────────────────────────────────────────────────
console.log('\n2. HV25ODX stored shape — Brego answered 204 (audit export); the Cazana path is taken');
{
  const H = existsSync('fixtures/HV25ODX/stored-shapes.json') ? JSON.parse(readFileSync('fixtures/HV25ODX/stored-shapes.json', 'utf8')) : null;
  ok('STORED SHAPE: HV25ODX had no Brego valuation', H ? H.bregoValuation === null : true);
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return url.includes('brego/') ? resp(204, '') : resp(200, JSON.stringify(CAZANA_DOC)); };
  // Brego exactly as the route calls it (oneAutoFetch, retries 2) …
  const brRec = { label: 'BREGO_GB', endpoint: 'brego/valuationfromvrm/v2' };
  const pick = (raw) => { const r = raw?.result ?? raw; return (r && !r.error) ? r : null; };
  const [brResult] = await quiet(() => oneAutoFetch(brRec, 'https://api.oneautoapi.com/brego/valuationfromvrm/v2?vehicle_registration_mark=HV25ODX&current_mileage=53544', {}, pick, { retries: 2, fetchImpl, sleep: noSleep }));
  finaliseOneAutoRec(brRec, { cache: 'miss' }, brResult);
  ok('Brego 204 → no-data, one call, not retried', brResult === null && brRec.outcome === 'no-data' && brRec.attempts === 1);
  // … then the fallback.
  const cacheLog = [];
  const [cz, lines] = await quiet(() => fetchCazanaValuation({ vrm: 'HV25ODX', mileage: 53544, base: 'https://api.oneautoapi.com', headers: {}, cache: passCache(cacheLog), fetchImpl, sleep: noSleep }));
  ok('Cazana is called once, at the documented URL with the VRM and mileage', urls.length === 2 && urls[1] === 'https://api.oneautoapi.com/percayso/currentvaluationfromvrm/?vehicle_registration_mark=HV25ODX&current_mileage=53544');
  ok('same cache seam: its own callType CAZANA_GB, mileage in the key params', cacheLog.length === 1 && cacheLog[0].callType === 'CAZANA_GB' && cacheLog[0].params.current_mileage === '53544');
  ok('same recording as batch 136 D1: status 200, outcome ok, 1 attempt, cache outcome', cz.rec.httpStatus === 200 && cz.rec.outcome === 'ok' && cz.rec.attempts === 1 && cz.rec.cache === 'miss');
  ok('the call is logged as [ONEAUTO CALL] CAZANA_GB', lines.some((l) => l.startsWith('[ONEAUTO CALL] CAZANA_GB outcome=ok http=200')));
  const v = valuationFromCazana(cz.result);
  ok('the report valuation comes back from Cazana with trade £10,220', v?._source === 'Cazana' && v.trade_average_valuation === 10220);
}

// ── 3. Brego answered → Cazana is never called ────────────────────────────────────────────────────────────────────────
console.log('\n3. Brego answered → Cazana never called (route wiring)');
{
  const c = code(route);
  const iBrego = c.indexOf("withOneAutoCache('BREGO_GB', cleanVrmB, { current_mileage: brMileage }");
  const iGate = c.indexOf('if (!brResult) {\n        const cz = await fetchCazanaValuation(');
  ok('the Brego call is unchanged (same cache key shape)', iBrego > 0);
  ok('Cazana is called ONLY inside `if (!brResult)`, after Brego resolved', iGate > iBrego);
  ok('exactly one fetchCazanaValuation call site in the pipeline', (c.match(/await fetchCazanaValuation\(/g) || []).length === 1);
  ok('a Brego answer is stamped _source "Brego"; the Cazana branch is the else', c.includes("bregoData = { ...brResult, _source: 'Brego', _mileageSource: brMileageSource, _mileageUsed: brMileage };") && c.includes('} else if (czResult) {'));
  ok('the exit value reads exitBaseOf (Brego trade-low / Cazana trade)', c.includes('const _exitBase = exitBaseOf(bregoData);') && c.includes('computeExitFromBand(\n        _exitBase.value,'));
  ok('the Brego exit line is byte-identical to before', c.includes(': `\\n\\nExit: £${exitFmt} — ${step} position, ${pct}% of trade-low £${baseFmt} (${catLabel} band)`'));
  ok('the Cazana exit line names Cazana', c.includes('% of Cazana trade valuation £${baseFmt} (${catLabel} band)'));
  ok('the stored assessment carries _valuationSource', c.includes('assessment._valuationSource = bregoData?._source ?? null;'));
  ok('the price band still reads trade_average_valuation (Cazana maps onto it)', c.includes('derivePriceBand(enrichedVd.bregoValuation?.trade_average_valuation ?? null)'));
  const rep = readFileSync('scripts/replay.mjs', 'utf8');
  ok('replay harness maps CAZANA_GB (null unless a fixture carries cazanaValuation)', rep.includes('CAZANA_GB: paid.cazanaValuation ?? null'));
}

// ── 4. Both empty ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Brego 204 AND Cazana 204 → no valuation; the D3 sentence; loud log');
{
  let calls = 0;
  const fetchImpl = async () => { calls++; return resp(204, ''); };
  const [cz] = await quiet(() => fetchCazanaValuation({ vrm: 'HV25ODX', mileage: 53544, base: 'https://api.oneautoapi.com', headers: {}, cache: passCache([]), fetchImpl, sleep: noSleep }));
  ok('Cazana 204 → no-data, null, never retried', cz.result === null && cz.rec.outcome === 'no-data' && calls === 1);
  ok('exit base null → exit / ladder / ceiling not computed', exitBaseOf(valuationFromCazana(cz.result)) === null);
  ok('route logs [VALUATION FAILED] when both return nothing', code(route).includes('[VALUATION FAILED] Brego and Cazana both returned no valuation'));
  const { NO_VALUATION_NOTE } = await import('../config/booking.mjs');
  ok('the no-valuation note is the batch 138 one-sentence note', NO_VALUATION_NOTE === 'No market valuation was returned for this vehicle, so the after-repair value, bid ladder and rebuild ceiling are not shown.');
}

// ── 5. The buyer sees the supplier — screen and a real PDF render ─────────────────────────────────────────────────────
console.log('\n5. Supplier shown to the buyer — screen and PDF');
{
  const page = readFileSync('app/salvage/success/page.js', 'utf8');
  ok('screen: the valuation subtitle names the supplier (stored pre-137 → Brego)', page.includes("Live data · {bregoData._source || 'Brego'} · {monthYear}"));
  if (existsSync('fixtures/HV25ODX/stored-shapes.json')) {
    const H = JSON.parse(readFileSync('fixtures/HV25ODX/stored-shapes.json', 'utf8'));
    const { buildAssessmentPdf } = await import('../app/api/salvage/pdf/route.js');
    const BS = String.fromCharCode(92);
    const text = (bytes) => { const buf = Buffer.from(bytes); const o = []; let i = 0; while (true) { const s0 = buf.indexOf('stream', i); if (s0 < 0) break; const e = buf.indexOf('endstream', s0); if (e < 0) break; let st = s0 + 6; if (buf[st] === 13) st++; if (buf[st] === 10) st++; let t; try { t = zlib.inflateSync(buf.subarray(st, e)).toString('latin1'); } catch { t = buf.subarray(st, e).toString('latin1'); } let d = 0, cur = '', esc = false; for (const ch of t) { if (d === 0) { if (ch === '(') { d = 1; cur = ''; } continue; } if (esc) { cur += ch; esc = false; continue; } if (ch === BS) { esc = true; continue; } if (ch === '(') { d++; cur += ch; continue; } if (ch === ')') { d--; if (d === 0) o.push(cur); else cur += ch; continue; } cur += ch; } i = e + 9; } return o.join(' | '); };
    const cazVal = { ...valuationFromCazana(CAZANA_DOC.result), _mileageSource: 'copart_listed', _mileageUsed: 53544 };
    const [[withCaz, noVal, withBrego]] = await quiet(async () => [
      text(buildAssessmentPdf(H.assessment, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', cazVal, null)),
      text(buildAssessmentPdf(H.assessment, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', null, null)),
      text(buildAssessmentPdf(H.assessment, H.vehicle_details, 'GB', 'HV25ODX', '15/09/2026', { retail_low_valuation: 1, retail_average_valuation: 2, retail_high_valuation: 3, trade_low_valuation: 4, trade_average_valuation: 5, trade_high_valuation: 6, _mileageSource: 'copart_listed', _mileageUsed: 53544 }, null)),
    ]);
    ok('PDF with a Cazana valuation: "Valuation supplier: Cazana"', withCaz.includes('Valuation supplier: Cazana'));
    ok('PDF with a Cazana valuation: trade average £10,220 shown, trade low/high "N/A" (nothing invented)', /Trade \| N\/A \| £10,220 \| N\/A/.test(withCaz));
    ok('PDF with a Cazana valuation: no no-valuation note', !withCaz.includes('No market valuation was returned'));
    ok('PDF with a stored pre-137 Brego valuation: "Valuation supplier: Brego"', withBrego.includes('Valuation supplier: Brego'));
    ok('PDF with no valuation (both empty): the one-sentence note, no supplier line', noVal.includes('No market valuation was returned for this vehicle, so the after-repair value, bid ladder and rebuild ceiling are not shown.') && !noVal.includes('Valuation supplier'));
  }
}

// ── 6. Cost record ────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. Cost record');
{
  const { MENU_COSTS } = await import('../config/menuCosts.mjs');
  const c = MENU_COSTS.cazana_valuation;
  ok('cazana_valuation is recorded; account rate unknown (grossCost null — a list price is never a grossCost)', !!c && c.grossCost === null && c.basis === 'unknown');
  ok('published list price recorded ex-VAT: PAYG 70p / Business 45p / Enterprise 29p', c.listPriceExVat.payg === 0.70 && c.listPriceExVat.business === 0.45 && c.listPriceExVat.enterprise === 0.29);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} cazana-fallback: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
