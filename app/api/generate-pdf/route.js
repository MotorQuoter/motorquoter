import { jsPDF } from 'jspdf';
import { PRICING, IE_MENU } from '@/config/pricing';
import { experianVerdict } from '@/lib/experianHistory';
import { formatOdometer } from '@/lib/odometerDisplay';
import { motStatusPresentation } from '@/lib/motTone';

const MARGIN = 12;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 64;

// Exported so the report can be built server-side (BUILD_StoredReports §4b — the purchase email
// attaches this exact PDF). Pure function of its arguments: no request, no I/O. Callers must NOT
// self-POST /api/generate-pdf to obtain a PDF server-side; import and call this directly.
export function buildPdf(result, vrm, checks, checkDate) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  const has = (key) => checks.includes(key);
  const isIE = result.market === 'IE';

  // Finding 1: a failed/empty Experian call yields NULL. Keep the raw block to tell "checked, clear"
  // (qty 0) from "never ran" (null) — the verdict decision lives in experianVerdict(). `ac` (|| {}) is
  // ONLY for reading detail fields, and only ever under `!v.missing`.
  const acRaw = isIE ? result.hpi : result.autocheck;
  const ac  = acRaw || {};
  // C§5 — when a block is missing because the PROVIDER FAILED (error/empty), say so honestly instead
  // of "…not available for this vehicle" (a false statement about the car). Only overrides the
  // missing-text; a genuine qty:0 clean result is untouched.
  const providerFailed = (block) => {
    const o = result?._checkOutcomes?.[block];
    return o === 'error' || o === 'empty';
  };
  const PDF_PROVIDER_FAILED = 'Check could not be completed - provider did not respond; contact support to re-run or refund.';
  const PDF_BLOCK_TO_ITEM = { autocheck: 'full_history', valuation: 'valuation', salvagehistory: 'salvagehistory', market_demand: 'market_demand', ie_valuation: 'ie_valuation' };
  const verdictValue = (v, block) => {
    if (!(v.missing && providerFailed(block))) return v.value;
    const r = result?._refunds?.[PDF_BLOCK_TO_ITEM[block]];
    if (r?.refunded) {
      const amt = r.refund && typeof r.refund.amount === 'number'
        ? ` (${r.refund.currency === 'eur' ? '€' : '£'}${(r.refund.amount / 100).toFixed(2)})`
        : '';
      return `Could not be completed - refunded${amt}.`;
    }
    return PDF_PROVIDER_FAILED;
  };
  const acBlock = isIE ? 'hpi' : 'autocheck'; // the outcome key for the six Experian/HPI blocks
  const val = result.valuation || {};
  const motHistory = result.motHistory || [];
  const cazAdv = result.cazanaAdverts || {};
  const cazAdverts = cazAdv.result || [];
  const cazDem = result.cazanaDemand || {};
  const svcCoverage = result.serviceHistoryCoverage;
  // Server-normalised events — same array the refund decision was made on. No raw-key fallback:
  // the raw shape uses date_of_service_event / mileage_observed and would render blank rows here.
  const svcRecords  = result.serviceHistoryRecords ?? null;
  const serviceHistoryUnavailable = result.serviceHistoryStatus === 'error' || result.serviceHistoryStatus === 'pending';
  const serviceHistoryNotAsked = {
    make_not_covered: 'This manufacturer is not covered by the OE service-history service',
    pre_2012: 'OE service-history coverage starts at 2012 models - this vehicle predates it',
    no_vin: 'No VIN available for this vehicle, so the records could not be looked up',
  }[result.serviceHistoryNotAttempted] || null;
  const serviceHistoryRefunded = result.serviceHistoryRefunded ?? false;
  const serviceHistoryRefundFailed = result.serviceHistoryRefundFailed ?? false;
  // Charged-currency refund label (charge-derived from the server); config GBP fallback by market.
  const serviceHistoryRefundLabel = (() => {
    const r = result.serviceHistoryRefund;
    if (r && typeof r.amount === 'number') return `${r.currency === 'eur' ? '€' : '£'}${(r.amount / 100).toFixed(2)}`;
    // Legacy-row fallback only; real refund is charge-derived server-side. Read from config, not a
    // hardcoded second path (the £3.49 removed 20 Aug — service_history is now £4.99).
    const cfgPrice = isIE
      ? IE_MENU.find(i => i.key === 'ie_service_history')?.price
      : PRICING.menu.find(i => i.key === 'service_history')?.price;
    return typeof cfgPrice === 'number' ? `£${cfgPrice.toFixed(2)}` : '';
  })();

  const money = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '-';
  const num   = (v) => v != null ? Number(v).toLocaleString('en-GB') : '-';
  const dt    = (s) => {
    if (!s) return '-';
    const parts = s.split(/[ T]/)[0].split(/[-./]/);
    if (parts.length !== 3) return s;
    const [a, b, c] = parts;
    if (a.length === 4) return `${c}/${b}/${a}`;  // YYYY-MM-DD → DD/MM/YYYY
    if (c.length === 4) return `${b}/${a}/${c}`;  // MM/DD/YYYY → DD/MM/YYYY
    return s;
  };
  const fmtFirstReg = (s) => {
    if (!s) return '-';
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const ym = s.match(/^(\d{4})-(\d{2})$/);
    if (ym) { const m = MONTHS[parseInt(ym[2], 10) - 1]; return m ? `${m} ${ym[1]}` : s; }
    return dt(s);
  };
  const str  = (v) => (v == null ? '-' : String(v));
  const clip = (s, max) => s && s.length > max ? s.slice(0, max - 1) + '...' : (s || '-');
  // Make a string safe for the base PDF font: drop emoji / symbols it renders as artefacts (the "þ"
  // where the screen shows ⚠️), and downgrade smart punctuation to ASCII. Use for any model/verdict
  // text before splitTextToSize — never clip a verdict, always wrap it.
  // Keep ASCII + the two currency symbols the report legitimately prints (£, €); downgrade smart
  // punctuation and the middle dot to ASCII; drop anything else the base font renders as an artefact.
  const pdfText = (s) => String(s == null ? '' : s).replace(/[^\x00-\x7F£€]/g, (c) => ({ '—': '-', '–': '-', '·': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...' }[c] ?? '')).replace(/\s+/g, ' ').trim();

  function checkPage(needed = 10) {
    if (y + needed > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
  }

  function sectionTitle(title, subtext) {
    checkPage(16);
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 90, 90);
    doc.text(title.toUpperCase(), MARGIN, y);
    if (subtext) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(150, 150, 150);
      doc.text(subtext, PAGE_W - MARGIN, y, { align: 'right' });
    }
    y += 3;
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 5;
  }

  function row(label, value, tone) {
    // Finding 9a/9c: sanitise glyphs and WRAP the value into its column (198mm − 76mm ≈ 122mm) so no
    // caller can run off the page. Replaces the old single unbounded doc.text — the mileage-anomaly
    // note (~158mm) lost its tail, and the road-tax basis was clip()'d mid-explanation. Give every
    // caller a wrapping value column; never clip a value again.
    const valueLines = doc.splitTextToSize(pdfText(str(value)) || '-', CONTENT_W - LABEL_W);
    checkPage(4 + valueLines.length * 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    doc.text(str(label), MARGIN, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    if (tone === 'bad')       doc.setTextColor(170, 0, 0);
    else if (tone === 'good') doc.setTextColor(0, 120, 0);
    else                      doc.setTextColor(20, 20, 20);
    doc.text(valueLines, MARGIN + LABEL_W, y);
    y += valueLines.length * 5;
    doc.setDrawColor(215, 215, 215);
    doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 2;
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(0, 0, 0);
  doc.text('MOTORQUOTER', MARGIN, y + 7);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Vehicle Intelligence Report', MARGIN, y + 12);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text(str(vrm), PAGE_W - MARGIN, y + 7, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  const makeYear = `${result.make || ''} ${result.yearOfManufacture || ''}`.trim();
  if (makeYear) doc.text(makeYear, PAGE_W - MARGIN, y + 12, { align: 'right' });
  doc.text(`${isIE ? 'IE' : 'GB'} Report - ${checkDate}`, PAGE_W - MARGIN, y + 16, { align: 'right' });

  y += 19;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 4;

  // ── Vehicle Identity ─────────────────────────────────────────────────────────
  sectionTitle('Vehicle Identity');
  if (result.make)                     row('Make',          result.make);
  if (result.model)                    row('Model',         result.model);
  if (result.yearOfManufacture)        row('Year',          result.yearOfManufacture);
  if (result.colour)                   row('Colour',        result.colour);
  if (result.engineSize)               row('Engine',        result.engineSize);
  if (result.fuelType)                 row('Fuel Type',     result.fuelType);
  if (result.co2Emissions)             row('CO2 Emissions', `${result.co2Emissions} g/km`);
  if (result.taxStatus)                row('Tax Status',    result.taxStatus,  result.taxStatus !== 'Taxed' ? 'bad' : undefined);
  // MOT/NCT status. A 40-year-old GB vehicle with no current MOT is age-eligible for exemption, not
  // neglected — motStatusPresentation renders it NEUTRAL (never red, never a green all-clear) and
  // forces the row to appear even when motStatus is absent (a hidden row is its own rule-10 failure).
  const motPres = motStatusPresentation({ motStatus: result.motStatus, yearOfManufacture: result.yearOfManufacture, firstRegistration: result.monthOfFirstRegistration, market: isIE ? 'IE' : 'GB' });
  if (result.motStatus || motPres.exempt) {
    // Non-exempt unchanged: Valid was already neutral here (only non-Valid was red). exempt → neutral too.
    const motTone = motPres.tone === 'alert' ? 'bad' : undefined;
    row(isIE ? 'NCT Status' : 'MOT Status', motPres.label, motTone);
  }
  if (result.monthOfFirstRegistration) row('First Registered', fmtFirstReg(result.monthOfFirstRegistration));
  if (result.dateOfLastV5CIssued)      row('Last V5C Issued', dt(result.dateOfLastV5CIssued));
  if (result.nctExpiryDate)            row('NCT Expiry',    dt(result.nctExpiryDate));
  // Exemption wording — both facts, no verdict (batch 47 §2). Neutral grey, not the road-tax orange.
  if (motPres.exempt) {
    checkPage(12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
    for (const line of doc.splitTextToSize(pdfText(motPres.note), CONTENT_W)) { doc.text(line, MARGIN, y); y += 3.8; }
    y += 2;
  }

  // ── Outstanding Safety Recall ─────────────────────────────────────────────────
  // Finding 8: a live safety warning was screen-only (no hasOutstandingRecall anywhere in the PDF).
  // Free, DVSA-derived; shown whenever present, gated on the data (a warning, not a paid section).
  if (result.hasOutstandingRecall === true) {
    sectionTitle('Safety Recall');
    row('Outstanding Recall', '[!] This vehicle has an outstanding safety recall - check with the manufacturer before driving.', 'bad');
  }

  // ── Valuation ────────────────────────────────────────────────────────────────
  // Finding 8: gate on the PURCHASE (has), never on data presence — the old `&& retail_low != null`
  // dropped the WHOLE section (losing the trade + private bands the screen still showed) whenever
  // retail-low was null. Handle absent bands INSIDE the section, honestly (C§5/§6 wording).
  if (has('valuation')) {
    sectionTitle('Valuation');
    const anyBand = val.retail_low_valuation != null || val.trade_low_valuation != null || val.private_low_valuation != null;
    if (val.retail_low_valuation != null)  row('Retail Value', `${money(val.retail_low_valuation)} - ${money(val.retail_high_valuation)}`);
    if (val.trade_low_valuation != null)   row('Trade Value',  `${money(val.trade_low_valuation)} - ${money(val.trade_high_valuation)}`);
    if (val.private_low_valuation != null) row('Private Sale', `${money(val.private_low_valuation)} - ${money(val.private_high_valuation)}`);
    if (!anyBand) row('Valuation', verdictValue({ missing: true, value: 'Valuation data not available for this vehicle' }, 'valuation'));
  }

  // ── ROI Tier Sections ─────────────────────────────────────────────────────────
  if (isIE && result.roiTier) {
    // Cartell Price Guide roiValuation — commented out; Brego is sole ROI valuation provider
    // const roiVal = result.roiValuation;
    // if (roiVal) {
    //   const fmtEur = v => `€${Number(v).toLocaleString('en-IE')}`;
    //   const retail = roiVal.retail ?? null;
    //   const trade  = roiVal.trade  ?? null;
    //   if (retail != null || trade != null) {
    //     sectionTitle('Market Valuation');
    //     if (retail != null) row('Current Retail', fmtEur(retail));
    //     if (trade  != null) row('Trade Value',    fmtEur(trade));
    //   }
    // }

    const roiDem = result.roiMarketDemand;
    if (roiDem) {
      const score   = roiDem.market_demand_score ?? roiDem.demand_score ?? null;
      const days    = roiDem.average_days_to_sell ?? roiDem.days_to_sell ?? null;
      const similar = roiDem.similar_adverts_count ?? roiDem.total_similar ?? null;
      if (score != null || days != null || similar != null) {
        sectionTitle('Market Demand');
        if (score   != null) row('Demand Score',     `${score} / 100`);
        if (days    != null) row('Avg Days to Sell', str(days));
        if (similar != null) row('Similar Listed',   str(similar));
      }
    }

    const pg = result.roiPriceGuide;
    if (pg && ['roi_pro', 'roi_history'].includes(result.roiTier)) {
      const pgRetail = pg.retail  ?? pg.retail_price  ?? pg.dealer_price  ?? null;
      const pgTrade  = pg.trade   ?? pg.trade_price   ?? pg.auction_price ?? null;
      const pgPriv   = pg.private ?? pg.private_price ?? null;
      if (pgRetail != null || pgTrade != null || pgPriv != null) {
        sectionTitle('Price Guide');
        if (pgRetail != null) row('Retail',  `EUR ${Number(pgRetail).toLocaleString('en-GB')}`);
        if (pgTrade  != null) row('Trade',   `EUR ${Number(pgTrade).toLocaleString('en-GB')}`);
        if (pgPriv   != null) row('Private', `EUR ${Number(pgPriv).toLocaleString('en-GB')}`);
      }
    }

    if (result.roiTier === 'roi_history') {
      const hpi = result.hpi || {};

      const hasFinance = hpi.finance_data_qty > 0;
      sectionTitle('Finance Check');
      row('Outstanding Finance', hasFinance ? '[!] Finance outstanding' : '[OK] No finance recorded', hasFinance ? 'bad' : 'good');
      for (const f of (hpi.finance_data_items || [])) {
        if (f.finance_company) row('Finance Company', f.finance_company);
        if (f.agreement_type)  row('Agreement Type',  f.agreement_type);
      }

      const hasStolen = hpi.stolen_vehicle_data_qty > 0;
      sectionTitle('Stolen Check');
      row('Stolen Register', hasStolen ? '[!] Recorded as stolen' : '[OK] Not recorded stolen', hasStolen ? 'bad' : 'good');
      checkPage(10);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
      const gardaNote2 = 'Irish stolen data is based on a private register. An Garda Síochána do not share stolen vehicle data with third parties.';
      for (const line of doc.splitTextToSize(gardaNote2, CONTENT_W)) { doc.text(line, MARGIN, y); y += 3.8; }
      y += 2;

      const nctRaw   = result.nctHistory;
      const nctTests = Array.isArray(nctRaw) ? nctRaw : (nctRaw?.tests ?? nctRaw?.nct_tests ?? []);
      sectionTitle('NCT History');
      if (nctTests.length > 0) {
        for (const test of nctTests.slice(0, 15)) {
          checkPage(8);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
          doc.text(dt(test.test_date || test.date) || '-', MARGIN + 1, y);
          const res = test.result || test.test_result || '-';
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(res === 'PASS' ? 0 : 170, res === 'PASS' ? 120 : 0, 0);
          doc.text(res, MARGIN + 30, y);
          y += 5;
          doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
          doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
        }
      } else {
        checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
        doc.text('No NCT history on record', MARGIN, y); y += 8;
      }
    }
  }

  // ── IE Brego Valuation (checks path) ─────────────────────────────────────────
  // batch 48 §8: gate on the PURCHASE, not on bregoRoi presence — a provider failure must say so (and
  // show the refund) instead of the whole section disappearing after the customer paid.
  if (isIE && has('ie_valuation')) {
    const brego = result.bregoRoi;
    const hasBands = brego && (brego.retailHigh != null || brego.tradeLow != null);
    if (!hasBands) {
      sectionTitle('Valuation');
      row('Valuation', verdictValue({ missing: true, value: 'Valuation data not available for this vehicle' }, 'ie_valuation'));
    } else {
    const fmtEur = v => v != null ? `€${Number(v).toLocaleString('en-IE')}` : '-';
    sectionTitle('Valuation');
    checkPage(12);
    doc.setFillColor(245, 245, 245);
    doc.rect(MARGIN, y - 3, CONTENT_W, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
    doc.text('Condition', MARGIN + 1, y + 1);
    doc.text('Retail', MARGIN + 110, y + 1, { align: 'right' });
    doc.text('Trade', PAGE_W - MARGIN, y + 1, { align: 'right' });
    y += 8;
    const bregoRows = [
      { label: 'High',    retail: brego.retailHigh, trade: brego.tradeHigh },
      { label: 'Average', retail: brego.retailAvg,  trade: brego.tradeAvg  },
      { label: 'Low',     retail: brego.retailLow,  trade: brego.tradeLow  },
    ];
    for (const r of bregoRows) {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(80, 80, 80);
      doc.text(r.label, MARGIN + 1, y);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 20, 20);
      doc.text(fmtEur(r.retail), MARGIN + 110, y, { align: 'right' });
      doc.text(fmtEur(r.trade), PAGE_W - MARGIN, y, { align: 'right' });
      y += 5;
      doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
    }
    }
  }

  // Full History bundle renders all six AutoCheck blocks; the legacy writeoff/finance/stolen keys
  // still render their own block for already-paid historical reports (removed from sale 20 Aug).
  const hasFullHistory = has('full_history');

  // ── Write-off ────────────────────────────────────────────────────────────────
  if (has('writeoff') || hasFullHistory) {
    sectionTitle('Write-off / Cat S·N Check', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'writeoff');
    row('Write-off Status', verdictValue(v, acBlock), v.tone);
    if (!v.missing) {
      const writeOffItem = ac.condition_data_items?.[0];
      if (writeOffItem?.total_loss_date) row('Total Loss Date', dt(writeOffItem.total_loss_date));
    }
  }

  // ── Finance ───────────────────────────────────────────────────────────────────
  if (has('finance') || hasFullHistory) {
    sectionTitle('Finance Check', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'finance');
    row('Outstanding Finance', verdictValue(v, acBlock), v.tone);
    if (!v.missing) {
      for (const f of (ac.finance_data_items || [])) {
        if (f.finance_company) row('Finance Company', f.finance_company);
        if (f.agreement_type)  row('Agreement Type', f.agreement_type);
      }
    }
  }

  // ── Stolen ────────────────────────────────────────────────────────────────────
  if (has('stolen') || hasFullHistory) {
    sectionTitle('Stolen Check', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'stolen');
    row(isIE ? 'Stolen Register' : 'Police Database', verdictValue(v, acBlock), v.tone);
    if (!v.missing && isIE) {
      checkPage(10);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(130, 130, 130);
      const gardaNote = 'Irish stolen data is based on a private register. An Garda Síochána do not share stolen vehicle data with third parties.';
      const noteLines = doc.splitTextToSize(gardaNote, CONTENT_W);
      for (const line of noteLines) { doc.text(line, MARGIN, y); y += 3.8; }
      y += 2;
    }
  }

  // ── High-Risk Markers (Full History bundle) ─────────────────────────────────────
  if (hasFullHistory) {
    sectionTitle('High-Risk Markers', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'high_risk');
    row('High-Risk Markers', verdictValue(v, acBlock), v.tone);
    if (!v.missing) {
      const items = Array.isArray(ac.high_risk_data_items) ? ac.high_risk_data_items : [];
      for (const it of items) {
        const type = it?.high_risk_type || it?.type || it?.description || it?.marker || 'Marker recorded';
        row('Marker', str(type));
        const party = it?.registered_to || it?.company || it?.organisation || it?.interested_party || null;
        if (party) row('Recorded By', str(party));
      }
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
      const hrNote = doc.splitTextToSize('High-risk markers are recorded by third parties (e.g. ex-rental / ex-fleet use, or a registered interest). This shows what is on record; it does not clear a vehicle.', CONTENT_W);
      for (const line of hrNote) { doc.text(line, MARGIN, y); y += 3.8; }
      y += 2;
    }
  }

  // ── Plate Changes (Full History bundle) ─────────────────────────────────────────
  if (hasFullHistory) {
    sectionTitle('Plate Changes', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'plate');
    row('Registration Changes', verdictValue(v, acBlock), v.tone);
    if (!v.missing) {
      const items = Array.isArray(ac.cherished_data_items) ? ac.cherished_data_items : [];
      for (const it of items) {
        const plate = it?.previous_vehicle_registration_mark || it?.previous_vrm || it?.registration_mark || null;
        const date  = it?.cherished_plate_transfer_date || it?.date_of_receipt || it?.date_of_change || it?.date || null;
        if (plate) row('Previous Plate', str(plate));
        if (date)  row('Change Date', dt(date));
      }
    }
  }

  // ── Previous Searches (Full History bundle) ─────────────────────────────────────
  if (hasFullHistory) {
    sectionTitle('Previous Searches', 'Data provided by Experian');
    const v = experianVerdict(acRaw, 'searches');
    row('Recent Checks', verdictValue(v, acBlock), v.tone);
    if (!v.missing) {
      const items = Array.isArray(ac.previous_search_items) ? ac.previous_search_items : [];
      for (const it of items.slice(0, 12)) {
        const who  = it?.business_type_searching || null;
        const date = it?.date_of_search || null;
        if (who || date) row(who ? str(who) : 'Search', date ? dt(date) : '-');
      }
      checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
      const psNote = doc.splitTextToSize('How many trade searches have been recorded against this vehicle recently. A high number close together can indicate a vehicle being shopped around. Includes checks run through MotorQuoter.', CONTENT_W);
      for (const line of psNote) { doc.text(line, MARGIN, y); y += 3.8; }
      y += 2;
    }
  }

  // ── Road Tax (computed, £0) ──────────────────────────────────────────────────────
  if (has('road_tax') && result.roadTax) {
    const rt = result.roadTax;
    sectionTitle('Road Tax');
    row('Annual Road Tax', rt.annual != null ? `£${rt.annual}/year` : 'See gov.uk/vehicle-tax-rate-tables', rt.annual != null ? 'good' : undefined);
    if (rt.basis) row('Basis', str(rt.basis)); // 9b: row() wraps now — never clip the basis mid-explanation
    if (result.taxStatus) row('Current Status', str(result.taxStatus), result.taxStatus === 'Taxed' ? 'good' : undefined);
    // Historic (40-year) exemption — the qualifying-on-age fact ALONGSIDE the rate above (never
    // instead of it: the £0 depends on the keeper having applied, which no data we hold can confirm).
    if (rt.historic?.eligible) {
      checkPage(12);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(170, 90, 0);
      for (const line of doc.splitTextToSize(pdfText(`Historic vehicle (40+ years): ${rt.historic.note}`), CONTENT_W)) { doc.text(line, MARGIN, y); y += 3.8; }
      y += 1;
    }
    checkPage(10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
    const rtText = pdfText(`${rt.supplement ? rt.supplement.note + ' ' : ''}${rt.note} Guide only - confirm the exact amount at gov.uk/vehicle-tax-rate-tables.`);
    const rtNote = doc.splitTextToSize(rtText, CONTENT_W);
    for (const line of rtNote) { doc.text(line, MARGIN, y); y += 3.8; }
    y += 2;
  }

  // ── Salvage History ───────────────────────────────────────────────────────────
  // Finding 8: gate on the PURCHASE (has), never on data presence — a paid-but-empty salvage check
  // used to VANISH, and an unpaid-but-present one used to print. A null result is a provider failure,
  // not a clean "no records", so it must NOT render the green [OK] (that is finding 1 again).
  if (has('salvagehistory') && !isIE) {
    const sh = result.salvageHistory;
    const found = sh?.salvage_auction_record_found === true;
    const shRecords = sh?.salvage_auction_records || [];
    sectionTitle('Salvage History Check');
    if (sh == null) {
      row('Salvage History', verdictValue({ missing: true, value: 'Salvage history data not available for this vehicle' }, 'salvagehistory'));
    } else if (!found) {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 120, 0);
      doc.text('[OK] No previous salvage auction records found', MARGIN, y); y += 8;
    } else {
      if (shRecords.length > 1) {
        row('Salvage Auctions', `[!] This vehicle has been through salvage auction ${shRecords.length} times`, 'bad');
      }
      for (const rec of shRecords) {
        checkPage(28);
        if (rec.salvage_auction_lot_date) row('Lot Date',        dt(rec.salvage_auction_lot_date));
        if (rec.salvage_auction_lot_desc) row('Category',        rec.salvage_auction_lot_desc, 'bad');
        if (rec.mileage != null)          row('Mileage at Sale', `${num(rec.mileage)} miles`);
        if (rec.primary_damage_desc)      row('Primary Damage',  rec.primary_damage_desc);
        if (rec.secondary_damage_desc)    row('Secondary Damage',rec.secondary_damage_desc);
        if (rec.salvage_auction_location) row('Auction Location',rec.salvage_auction_location);
        const imgCount = rec.external_image_urls?.length || 0;
        if (imgCount > 0) row('Photos on Record', `${imgCount} image${imgCount !== 1 ? 's' : ''} available`);
        y += 2;
      }
    }
  }

  // ── Market Demand ─────────────────────────────────────────────────────────────
  if (has('market_demand') && cazDem) {
    const demandScore = cazDem.market_demand_score;
    const daysToSell  = cazDem.average_days_to_sell ?? cazDem.days_to_sell;
    const similar     = cazDem.similar_adverts_count ?? cazDem.total_similar;
    sectionTitle('Market Demand');
    if (demandScore != null) row('Demand Score',    `${demandScore} / 100`);
    if (daysToSell  != null) row('Avg Days to Sell', str(daysToSell));
    if (similar     != null) row('Similar Listed',   str(similar));
  }

  // ── MOT / NCT History ─────────────────────────────────────────────────────────
  if (has('mot')) {
    if (isIE) {
      // NCT STATUS only (batch 38): due date + Valid/Expired from cartell/vehicleidentity. There is no
      // NCT test-history product (cartell/ncthistory/v1 404s), so no history is claimed.
      sectionTitle('NCT Status');
      row('NCT Status', result.motStatus || '-', result.motStatus === 'Valid' ? 'good' : result.motStatus === 'Expired' ? 'bad' : undefined);
      if (result.nctExpiryDate) row('NCT Due', dt(result.nctExpiryDate));
    } else {
      sectionTitle('MOT History');
      if (motHistory.length > 0) {
        checkPage(12);
        doc.setFillColor(242, 242, 242);
        doc.rect(MARGIN, y - 3, CONTENT_W, 7, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(70, 70, 70);
        doc.text('Date', MARGIN + 1, y + 1); doc.text('Result', MARGIN + 27, y + 1);
        doc.text('Mileage', MARGIN + 52, y + 1); doc.text('Expiry', MARGIN + 90, y + 1);
        y += 8;
        for (const test of motHistory.slice(0, 15)) {
          const fails = test.defects?.filter(r => ['MAJOR', 'MINOR', 'DANGEROUS'].includes(r.type)) || [];
          const advs  = test.defects?.filter(r => r.type === 'ADVISORY') || [];
          checkPage(7 + (fails.length + advs.length) * 4);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
          doc.text(str(test.completedDate || '-'), MARGIN + 1, y);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(test.testResult === 'PASSED' ? 0 : 170, test.testResult === 'PASSED' ? 120 : 0, 0);
          doc.text(str(test.testResult || '-'), MARGIN + 27, y);
          doc.setFont('helvetica', 'normal'); doc.setTextColor(20, 20, 20);
          // Mileage — normalised to miles. This table previously hardcoded " mi" and printed a km
          // reading as "104,471 mi", which let a reader do the subtraction and read a phantom rollback
          // (the false clocking allegation Vincent saw). Prefer the boundary field; fall back to
          // computing it for rows cached before this change. For a km reading, annotate with the
          // recorded value — inline when it fits the column, otherwise on a sub-line so the annotation
          // is never clipped (a truncated unit note is worse than none).
          const odo = formatOdometer(test);
          let kmSubline = null;
          if (odo.miles == null) {
            doc.text('-', MARGIN + 52, y);
          } else if (odo.isKm) {
            if (doc.getTextWidth(odo.label) <= (90 - 52 - 2)) {   // fits before the Expiry column at MARGIN+90
              doc.text(odo.label, MARGIN + 52, y);
            } else {
              doc.text(`${num(odo.miles)} mi`, MARGIN + 52, y);
              kmSubline = `Odometer recorded in km: ${num(odo.recordedValue)} km = ${num(odo.miles)} mi`;
            }
          } else {
            doc.text(odo.label, MARGIN + 52, y);
          }
          doc.text(str(test.expiryDate || '-'), MARGIN + 90, y);
          y += 5;
          if (kmSubline) { checkPage(5); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120); doc.text(kmSubline, MARGIN + 4, y); y += 4; doc.setFontSize(8.5); doc.setTextColor(20, 20, 20); }
          for (const f of fails) { checkPage(5); doc.setFontSize(7.5); doc.setTextColor(170, 0, 0); doc.text(`[${f.type}] ${clip(pdfText(f.text), 86)}`, MARGIN + 4, y); y += 4; }
          for (const a of advs)  { checkPage(5); doc.setFontSize(7.5); doc.setTextColor(140, 90, 0); doc.text(`[A] ${clip(pdfText(a.text), 90)}`, MARGIN + 4, y); y += 4; }
          doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
          doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
        }
      } else {
        checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
        doc.text('No MOT history on record', MARGIN, y); y += 8;
      }
    }
  }

  // ── Service History ───────────────────────────────────────────────────────────
  // Finding 8: an IE basket buys `ie_service_history` (€5.99) — gating on `service_history` alone gave
  // it NO PDF section at all. Both keys drive the same section.
  if (has('service_history') || has('ie_service_history')) {
    const svcCoverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || '';
    sectionTitle(`Service History${svcCoverageLabel ? ` - ${svcCoverageLabel}` : ''}`);
    if (svcRecords?.length > 0) {
      for (const rec of svcRecords) {
        checkPage(12);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
        doc.text(dt(rec.date) || '-', MARGIN, y);
        if (rec.mileage != null) { doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100); doc.text(`${num(rec.mileage)} ${rec.mileageUnit || 'mi'}`, MARGIN + 28, y); }
        if (rec.serviceType)     { doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40); doc.text(clip(pdfText(rec.serviceType), 50), MARGIN + 58, y); }
        y += 5;
        if (rec.dealer) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120); doc.text(clip(pdfText(rec.dealer), 60), MARGIN, y); y += 4; }
        doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
      }
    } else {
      checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
      if (serviceHistoryUnavailable) {
        doc.text('Service history could not be checked - the records provider did not respond.', MARGIN, y); y += 5;
        doc.text('This is not a result for your vehicle: the check did not complete. Contact support', MARGIN, y); y += 5;
        doc.text('and we will re-run it or refund this item.', MARGIN, y); y += 8;
      } else if (serviceHistoryNotAsked) {
        doc.text(`${serviceHistoryNotAsked}${serviceHistoryRefunded ? ` - ${serviceHistoryRefundLabel} refunded automatically` : ''}`, MARGIN, y); y += 8;
      } else if (serviceHistoryRefunded) {
        doc.text(`No service history records found — ${serviceHistoryRefundLabel} refunded automatically`, MARGIN, y); y += 8;
      } else if (serviceHistoryRefundFailed) {
        doc.text('No service history records found. Refund could not be processed automatically — contact support for a manual refund.', MARGIN, y); y += 8;
      } else {
        doc.text('No service history records found', MARGIN, y); y += 8;
      }
    }
  }

  // ── Mileage / Clocking Check (paid) ─────────────────────────────────────────────
  // Was ABSENT from the PDF while present on screen (Defect 3, 20 Aug). Mirrors the screen block.
  if (has('mileage_detail') && result.mileageDetail) {
    const md = result.mileageDetail;
    sectionTitle('Mileage / Clocking Check');
    // The verdict WRAPS across lines — never truncated mid-sentence (Defect 5). Strip emoji / smart
    // punctuation the base PDF font can't draw (the "þ" artefact). Colour by outcome: clocking
    // ('discrepancy') red, confirm-the-figure ('query') amber, consistent green (batch 19).
    checkPage(10);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    if (md.status === 'discrepancy') doc.setTextColor(170, 0, 0);
    else if (md.status === 'query') doc.setTextColor(150, 110, 0);
    else doc.setTextColor(0, 120, 0);
    for (const line of doc.splitTextToSize(pdfText(md.verdict), CONTENT_W)) { checkPage(5); doc.text(line, MARGIN, y); y += 4.5; }
    y += 2;
    const anomalies = Array.isArray(md.anomalies) ? md.anomalies : [];
    for (const a of anomalies) {
      if (a._userEntered || a.toDate === 'entered') {
        // The user's own entered figure — neutral note, no failure marker (Defect 6 / batch 19).
        const note = a._enteredAbove
          ? `Entered mileage implies about ${num(a.impliedPerMonth)} mi/month since the last MOT reading (${num(a.fromMiles)} mi, ${a.fromDate})`
          : `Entered mileage is ${num(a.dropMiles)} mi below the last MOT reading (${num(a.fromMiles)} mi, ${a.fromDate})`;
        row('Note', note);
      } else {
        row('Rollback', `dropped ${num(a.dropMiles)} mi: ${num(a.fromMiles)} mi (${a.fromDate}) -> ${num(a.toMiles)} mi (${a.toDate})`, 'bad');
      }
    }
    const readings = Array.isArray(md.readings) ? md.readings : [];
    for (const r of readings.slice(0, 20)) {
      row(str(r.date), r.miles == null ? 'N/A (no reading recorded)' : `${num(r.miles)} mi${r.unit === 'km' ? ` (${num(r.raw)} km recorded)` : ''}`);
    }
    if (md.mixedUnits) {
      checkPage(6); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130, 130, 130);
      doc.text('Readings in mixed units (mi & km) were normalised to miles before comparison.', MARGIN, y); y += 6;
    }
  }

  // ── Owner / Keeper History (paid) ───────────────────────────────────────────────
  // Was ABSENT from the PDF while present on screen (Defect 3, 20 Aug). Mirrors the screen block.
  if (has('owner_history')) {
    const oh = result.ownerHistory;
    sectionTitle('Owner / Keeper History');
    if (!oh || oh.status !== 'ok') {
      checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
      doc.text('No keeper-change history on record', MARGIN, y); y += 8;
    } else {
      row('Total Keepers', str(oh.totalKeepers ?? '-'));
      row('Recorded Changes', str(oh.keeperChanges));
      if (oh.latestChangeDate) row('Last Change', str(oh.latestChangeDate));
      for (const c of (Array.isArray(oh.changes) ? oh.changes : [])) {
        row(str(c.date || '-'), c.previousKeepers != null ? `after ${c.previousKeepers} previous keeper${c.previousKeepers === 1 ? '' : 's'}` : '-');
      }
      if (oh.plateChanges?.status === 'ok' && oh.plateChanges.plates.length > 0) {
        for (const p of oh.plateChanges.plates) row('Previous Plate', `${p.plate}${p.date ? ` (removed ${p.date})` : ''}`);
      }
    }
  }

  // ── Previous Adverts ──────────────────────────────────────────────────────────
  if (has('previous_adverts')) {
    sectionTitle('Previous Adverts');
    if (cazAdverts.length > 0) {
      checkPage(12);
      doc.setFillColor(242, 242, 242);
      doc.rect(MARGIN, y - 3, CONTENT_W, 7, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(70, 70, 70);
      doc.text('Last Seen', MARGIN + 1, y + 1); doc.text('Price', MARGIN + 32, y + 1);
      doc.text('Mileage', MARGIN + 62, y + 1); doc.text('Seller', MARGIN + 95, y + 1);
      y += 8;
      for (const ad of cazAdverts.slice(0, 10)) {
        checkPage(8);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
        doc.text(dt(ad.last_seen_date) || '-', MARGIN + 1, y);
        doc.setFont('helvetica', 'bold');
        doc.text(ad.advertised_price_gbp != null ? money(ad.advertised_price_gbp) : '-', MARGIN + 32, y);
        doc.setFont('helvetica', 'normal');
        doc.text(ad.mileage_observed != null ? `${num(ad.mileage_observed)} mi` : '-', MARGIN + 62, y);
        doc.setTextColor(100, 100, 100);
        doc.text(clip(pdfText(ad.seller_name || ad.dealer_type || '-'), 35), MARGIN + 95, y);
        y += 5;
        doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
      }
    } else {
      checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
      doc.text('No previous adverts found for this vehicle', MARGIN, y); y += 8;
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────────
  checkPage(14);
  y += 6;
  doc.setDrawColor(180, 180, 180); doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(150, 150, 150);
  const footerExtra = isIE ? '' : ' - Data provided by Experian';
  doc.text(
    `Generated by MotorQuoter - motorquoter.app - ${checkDate}${footerExtra}`,
    PAGE_W / 2, y, { align: 'center' }
  );

  return doc.output('arraybuffer');
}

export async function POST(request) {
  try {
    const { result, vrm, checks } = await request.json();
    if (!result || !vrm) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const checksArr = Array.isArray(checks) ? checks : (checks || '').split(',').filter(Boolean);

    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
    const filename = `${vrm}_${datePart}.pdf`;
    const today = now.toLocaleDateString('en-GB');

    const pdfBuffer = buildPdf(result, vrm, checksArr, today);

    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.byteLength),
      },
    });
  } catch (err) {
    console.error('PDF generation error:', err);
    return Response.json({ error: 'PDF generation failed' }, { status: 500 });
  }
}
