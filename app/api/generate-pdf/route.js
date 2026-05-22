import { jsPDF } from 'jspdf';

const MARGIN = 12;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 64;

function buildPdf(result, vrm, checks, checkDate) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  const has = (key) => checks.includes(key);
  const isIE = result.market === 'IE';

  const ac  = (isIE ? result.hpi : result.autocheck) || {};
  const val = result.valuation || {};
  const motHistory = result.motHistory || [];
  const cazAdv = result.cazanaAdverts || {};
  const cazAdverts = cazAdv.result || [];
  const cazDem = result.cazanaDemand || {};
  const svcHistory  = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;

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
  const str  = (v) => (v == null ? '-' : String(v));
  const clip = (s, max) => s && s.length > max ? s.slice(0, max - 1) + '...' : (s || '-');

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
    checkPage(9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    doc.text(str(label), MARGIN, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    if (tone === 'bad')       doc.setTextColor(170, 0, 0);
    else if (tone === 'good') doc.setTextColor(0, 120, 0);
    else                      doc.setTextColor(20, 20, 20);
    doc.text(str(value), MARGIN + LABEL_W, y);
    y += 5;
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
  if (result.motStatus)                row(isIE ? 'NCT Status' : 'MOT Status', result.motStatus, result.motStatus !== 'Valid' ? 'bad' : undefined);
  if (result.monthOfFirstRegistration) row('First Registered', dt(result.monthOfFirstRegistration));
  if (result.dateOfLastV5CIssued)      row('Last V5C Issued', dt(result.dateOfLastV5CIssued));
  if (result.nctExpiryDate)            row('NCT Expiry',    dt(result.nctExpiryDate));

  // ── Valuation ────────────────────────────────────────────────────────────────
  if (has('valuation') && val.retail_low_valuation != null) {
    sectionTitle('Valuation');
    row('Retail Value', `${money(val.retail_low_valuation)} - ${money(val.retail_high_valuation)}`);
    row('Trade Value',  `${money(val.trade_low_valuation)} - ${money(val.trade_high_valuation)}`);
    if (val.private_low_valuation != null) row('Private Sale', `${money(val.private_low_valuation)} - ${money(val.private_high_valuation)}`);
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
  if (isIE && has('ie_valuation') && result.bregoRoi) {
    const brego = result.bregoRoi;
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

  // ── Write-off ────────────────────────────────────────────────────────────────
  if (has('writeoff')) {
    const hasWriteOff = ac.condition_data_qty > 0;
    const writeOffItem = ac.condition_data_items?.[0];
    const wSrc = writeOffItem?.recovered_category_desc || writeOffItem?.vehicle_status || '';
    const wMatch = wSrc.match(/\bCAT\s*([A-Z])\b/i);
    const wLabel = hasWriteOff ? (wMatch ? `Cat ${wMatch[1]}` : (wSrc || 'Write-off recorded')) : null;
    sectionTitle('Write-off / Cat S·N Check', 'Data provided by Experian');
    row('Write-off Status', hasWriteOff ? `[!] ${wLabel}` : '[OK] No write-off recorded', hasWriteOff ? 'bad' : 'good');
    if (writeOffItem?.total_loss_date) row('Total Loss Date', dt(writeOffItem.total_loss_date));
  }

  // ── Finance ───────────────────────────────────────────────────────────────────
  if (has('finance')) {
    const hasFinance = ac.finance_data_qty > 0;
    sectionTitle('Finance Check', 'Data provided by Experian');
    row('Outstanding Finance', hasFinance ? '[!] Finance outstanding' : '[OK] No finance recorded', hasFinance ? 'bad' : 'good');
    const items = ac.finance_data_items || [];
    for (const f of items) {
      if (f.finance_company) row('Finance Company', f.finance_company);
      if (f.agreement_type)  row('Agreement Type', f.agreement_type);
    }
  }

  // ── Stolen ────────────────────────────────────────────────────────────────────
  if (has('stolen')) {
    const hasStolen = ac.stolen_vehicle_data_qty > 0;
    sectionTitle('Stolen Check', 'Data provided by Experian');
    row(isIE ? 'Stolen Register' : 'Police Database', hasStolen ? '[!] Recorded as stolen' : '[OK] Not recorded stolen', hasStolen ? 'bad' : 'good');
    if (isIE) {
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

  // ── Salvage History ───────────────────────────────────────────────────────────
  if (result.salvageHistory != null && !isIE) {
    const sh = result.salvageHistory;
    const found = sh?.salvage_auction_record_found === true;
    const shRecords = sh?.salvage_auction_records || [];
    sectionTitle('Salvage History Check');
    if (!sh || !found) {
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
      const nct = result.nctHistory;
      const tests = Array.isArray(nct) ? nct : (nct?.tests ?? nct?.nct_tests ?? []);
      sectionTitle('NCT History');
      if (tests.length > 0) {
        for (const test of tests.slice(0, 15)) {
          checkPage(8);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(20, 20, 20);
          const testDate = dt(test.test_date || test.date);
          doc.text(testDate || '-', MARGIN + 1, y);
          const res = test.result || test.test_result || '-';
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(res === 'PASS' ? 0 : 170, res === 'PASS' ? 120 : 0, 0);
          doc.text(res, MARGIN + 30, y);
          y += 5;
          doc.setDrawColor(215, 215, 215);
          doc.setLineWidth(0.15);
          doc.line(MARGIN, y, PAGE_W - MARGIN, y);
          y += 2;
        }
      } else {
        checkPage(8);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
        doc.text('No NCT history on record', MARGIN, y); y += 8;
      }
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
          const fails = test.rfrAndComments?.filter(r => ['MAJOR', 'MINOR', 'DANGEROUS'].includes(r.type)) || [];
          const advs  = test.rfrAndComments?.filter(r => r.type === 'ADVISORY') || [];
          checkPage(7 + (fails.length + advs.length) * 4);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
          doc.text(str(test.completedDate || '-'), MARGIN + 1, y);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(test.testResult === 'PASSED' ? 0 : 170, test.testResult === 'PASSED' ? 120 : 0, 0);
          doc.text(str(test.testResult || '-'), MARGIN + 27, y);
          doc.setFont('helvetica', 'normal'); doc.setTextColor(20, 20, 20);
          doc.text(test.odometerValue ? `${num(test.odometerValue)} mi` : '-', MARGIN + 52, y);
          doc.text(str(test.expiryDate || '-'), MARGIN + 90, y);
          y += 5;
          for (const f of fails) { checkPage(5); doc.setFontSize(7.5); doc.setTextColor(170, 0, 0); doc.text(`[${f.type}] ${clip(f.text, 86)}`, MARGIN + 4, y); y += 4; }
          for (const a of advs)  { checkPage(5); doc.setFontSize(7.5); doc.setTextColor(140, 90, 0); doc.text(`[A] ${clip(a.text, 90)}`, MARGIN + 4, y); y += 4; }
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
  if (has('service_history')) {
    const svcCoverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || '';
    sectionTitle(`Service History${svcCoverageLabel ? ` - ${svcCoverageLabel}` : ''}`);
    if (svcHistory?.service_records?.length > 0) {
      for (const rec of svcHistory.service_records) {
        checkPage(12);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
        doc.text(dt(rec.date) || '-', MARGIN, y);
        if (rec.mileage != null) { doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100); doc.text(`${num(rec.mileage)} mi`, MARGIN + 28, y); }
        if (rec.service_type)    { doc.setFont('helvetica', 'normal'); doc.setTextColor(40, 40, 40); doc.text(clip(rec.service_type, 50), MARGIN + 58, y); }
        y += 5;
        if (rec.dealer) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120); doc.text(clip(rec.dealer, 60), MARGIN, y); y += 4; }
        doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
      }
    } else {
      checkPage(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 100, 100);
      if (svcHistory === null && svcCoverage) {
        doc.text('Service history could not be retrieved at this time.', MARGIN, y); y += 5;
        doc.text('Please contact info@motorquoter.app for a service history fee refund.', MARGIN, y); y += 8;
      } else {
        doc.text('No digital service history on record', MARGIN, y); y += 8;
      }
    }
  }

  // ── Previous Adverts ──────────────────────────────────────────────────────────
  if (has('previous_adverts') && cazAdverts.length > 0) {
    sectionTitle('Previous Listings');
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
      doc.text(clip(ad.seller_name || ad.dealer_type || '-', 35), MARGIN + 95, y);
      y += 5;
      doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 2;
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
