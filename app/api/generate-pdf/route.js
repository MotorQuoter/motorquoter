import { jsPDF } from 'jspdf';

const MARGIN = 12;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 64;

function buildPdf(result, vrm, tierLabel, checkDate) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  const ac = result.autocheck || {};
  const val = result.valuation || {};
  const motHistory = result.motHistory || [];
  const cazAdv = result.cazanaAdverts || {};
  const cazAdverts = cazAdv.result || [];
  const cazDem = result.cazanaDemand || {};
  const svcHistory = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;

  const money = (v) => v != null ? `GBP ${Number(v).toLocaleString('en-GB')}` : '-';
  const num   = (v) => v != null ? Number(v).toLocaleString('en-GB') : '-';
  const dt    = (s) => {
    if (!s) return '-';
    const parts = s.split(/[ T]/)[0].split(/[-./]/);
    return parts[2] ? `${parts[2]}/${parts[1]}/${parts[0]}` : s;
  };
  const str = (v) => (v == null ? '-' : String(v));
  const clip = (s, max) => s && s.length > max ? s.slice(0, max - 1) + '...' : (s || '-');

  function checkPage(needed = 10) {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  }

  function sectionTitle(title) {
    checkPage(16);
    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 90, 90);
    doc.text(title.toUpperCase(), MARGIN, y);
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
  doc.text(`${tierLabel} Check - ${checkDate}`, PAGE_W - MARGIN, y + 16, { align: 'right' });

  y += 19;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 4;

  // ── Vehicle Details ──────────────────────────────────────────────────────────
  const hasWriteOff = ac.condition_data_qty > 0;
  const writeOffItem = ac.condition_data_items?.[0];
  const wSrc = writeOffItem?.recovered_category_desc || writeOffItem?.vehicle_status || '';
  const wMatch = wSrc.match(/\bCAT\s*([A-Z])\b/i);
  const writeOffLabel = hasWriteOff ? (wMatch ? `Cat ${wMatch[1]}` : (wSrc || 'Write-off recorded')) : null;

  sectionTitle('Vehicle Details');
  if (result.make)                       row('Make',                result.make);
  if (result.yearOfManufacture)          row('Year',                result.yearOfManufacture);
  if (result.colour)                     row('Colour',              result.colour);
  if (result.engineSize)                 row('Engine',              result.engineSize);
  if (result.fuelType)                   row('Fuel Type',           result.fuelType);
  if (result.co2Emissions)              row('CO2 Emissions',        `${result.co2Emissions} g/km`);
  if (result.taxStatus)                  row('Tax Status',          result.taxStatus,  result.taxStatus !== 'Taxed' ? 'bad' : undefined);
  if (result.motStatus)                  row('MOT Status',          result.motStatus,  result.motStatus !== 'Valid' ? 'bad' : undefined);
  if (result.monthOfFirstRegistration)   row('First Registered',    result.monthOfFirstRegistration);
  if (result.dateOfLastV5CIssued)        row('Last V5C Issued',     dt(result.dateOfLastV5CIssued));

  if (result.tier === 'pro') {
    // ── Pro: Risk Flags ────────────────────────────────────────────────────────
    const keeperCount = ac.keeper_data_items?.[0]?.number_previous_keepers ?? ac.keeper_changes_qty ?? null;
    const vehicleAge = result.yearOfManufacture ? (new Date().getFullYear() - result.yearOfManufacture) : null;
    const keeperHigh = keeperCount != null && vehicleAge != null && keeperCount > vehicleAge;
    const exported = (ac.is_exported != null || ac.was_exported != null) ? (ac.is_exported || ac.was_exported) : null;
    const mileageAnomaly = ac.mileage_anomaly ?? ac.mileage_discrepancy ?? null;

    sectionTitle('Risk Flags');
    row('Write-off',  hasWriteOff ? `[!] ${writeOffLabel}` : '[OK] Clean',                     hasWriteOff ? 'bad' : 'good');
    row('Finance',    ac.finance_data_qty === 0 ? '[OK] No finance'   : '[!] Outstanding finance', ac.finance_data_qty > 0   ? 'bad' : 'good');
    row('Stolen',     ac.stolen_vehicle_data_qty === 0 ? '[OK] Not stolen' : '[!] Recorded stolen',  ac.stolen_vehicle_data_qty > 0 ? 'bad' : 'good');
    if (keeperCount != null) row(`Keepers (${keeperCount})`, keeperHigh ? '[!] High for age' : '[OK] Normal', keeperHigh ? 'bad' : 'good');
    if (mileageAnomaly != null) row('Mileage', mileageAnomaly ? '[!] Anomaly detected' : '[OK] Consistent', mileageAnomaly ? 'bad' : 'good');
    if (exported != null) row('Exported / Reimported', exported ? '[!] Yes' : '[OK] No', exported ? 'bad' : 'good');

    // ── Pro: Bid Intelligence ──────────────────────────────────────────────────
    const lastAskingPrice = cazAdverts[0]?.advertised_price_gbp ?? null;
    const advertCount = cazAdverts.length || null;
    const demandScore = cazDem.market_demand_score;
    const predictedHammer = result.salvage?.predicted_hammer_price ?? result.salvage?.hammer_price ?? result.salvage?.bid_predictor?.predicted_price ?? null;

    if (predictedHammer != null || val.retail_low_valuation != null || lastAskingPrice != null || demandScore != null) {
      sectionTitle('Bid Intelligence');
      if (predictedHammer != null)        row('Predicted Hammer Price', money(predictedHammer));
      if (val.retail_low_valuation != null) row('Retail Value (Repaired)', `${money(val.retail_low_valuation)} - ${money(val.retail_high_valuation)}`);
      if (val.trade_low_valuation  != null) row('Trade Value',             `${money(val.trade_low_valuation)} - ${money(val.trade_high_valuation)}`);
      if (lastAskingPrice != null)        row(`Last Asking Price${advertCount ? ` (${advertCount} ads)` : ''}`, money(lastAskingPrice));
      if (demandScore != null)            row('Market Demand Score', `${demandScore} / 100`);
    }

    // ── Pro: Service History ───────────────────────────────────────────────────
    const svcCoverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || null;
    sectionTitle(`Service History${svcCoverageLabel ? ` - ${svcCoverageLabel}` : ''}`);

    if (svcHistory === null && svcCoverage) {
      checkPage(8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(150, 100, 0);
      doc.text('Service history unavailable - please try again', MARGIN, y);
      y += 8;
    } else if (svcHistory?.service_records?.length > 0) {
      for (const rec of svcHistory.service_records) {
        checkPage(12);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(20, 20, 20);
        doc.text(dt(rec.date) || '-', MARGIN, y);
        if (rec.mileage != null) {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(100, 100, 100);
          doc.text(`${num(rec.mileage)} mi`, MARGIN + 28, y);
        }
        if (rec.service_type) {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(40, 40, 40);
          doc.text(clip(rec.service_type, 50), MARGIN + 58, y);
        }
        y += 5;
        if (rec.dealer) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.5);
          doc.setTextColor(120, 120, 120);
          doc.text(clip(rec.dealer, 60), MARGIN, y);
          y += 4;
        }
        doc.setDrawColor(215, 215, 215);
        doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y);
        y += 2;
      }
    } else {
      checkPage(8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 100, 100);
      doc.text('No digital service history on record', MARGIN, y);
      y += 8;
    }

    // ── Pro: MOT History ───────────────────────────────────────────────────────
    sectionTitle('MOT History');
    if (motHistory.length > 0) {
      checkPage(12);
      doc.setFillColor(242, 242, 242);
      doc.rect(MARGIN, y - 3, CONTENT_W, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(70, 70, 70);
      doc.text('Date',    MARGIN + 1,  y + 1);
      doc.text('Result',  MARGIN + 27, y + 1);
      doc.text('Mileage', MARGIN + 52, y + 1);
      doc.text('Expiry',  MARGIN + 90, y + 1);
      y += 8;

      for (const test of motHistory.slice(0, 15)) {
        const fails = test.rfrAndComments?.filter(r => r.type === 'FAIL') || [];
        const advs  = test.rfrAndComments?.filter(r => r.type === 'ADVISORY') || [];
        checkPage(7 + (fails.length + advs.length) * 4);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(20, 20, 20);
        doc.text(str(test.completedDate || '-'), MARGIN + 1, y);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(test.testResult === 'PASSED' ? 0 : 170, test.testResult === 'PASSED' ? 120 : 0, 0);
        doc.text(str(test.testResult || '-'), MARGIN + 27, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(20, 20, 20);
        doc.text(test.odometerValue ? `${num(test.odometerValue)} mi` : '-', MARGIN + 52, y);
        doc.text(str(test.expiryDate || '-'), MARGIN + 90, y);
        y += 5;

        for (const f of fails) {
          checkPage(5);
          doc.setFontSize(7.5);
          doc.setTextColor(170, 0, 0);
          doc.text(`[F] ${clip(f.text, 90)}`, MARGIN + 4, y);
          y += 4;
        }
        for (const a of advs) {
          checkPage(5);
          doc.setFontSize(7.5);
          doc.setTextColor(140, 90, 0);
          doc.text(`[A] ${clip(a.text, 90)}`, MARGIN + 4, y);
          y += 4;
        }

        doc.setDrawColor(215, 215, 215);
        doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y);
        y += 2;
      }
    } else {
      checkPage(8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 100, 100);
      doc.text('No MOT history on record', MARGIN, y);
      y += 8;
    }

    // ── Pro: Previous Listings ─────────────────────────────────────────────────
    if (cazAdverts.length > 0) {
      sectionTitle('Previous Listings');
      checkPage(12);
      doc.setFillColor(242, 242, 242);
      doc.rect(MARGIN, y - 3, CONTENT_W, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(70, 70, 70);
      doc.text('Last Seen', MARGIN + 1,  y + 1);
      doc.text('Price',     MARGIN + 32, y + 1);
      doc.text('Mileage',   MARGIN + 62, y + 1);
      doc.text('Seller',    MARGIN + 95, y + 1);
      y += 8;

      for (const ad of cazAdverts.slice(0, 10)) {
        checkPage(8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(20, 20, 20);
        doc.text(dt(ad.last_seen_date) || '-', MARGIN + 1, y);
        doc.setFont('helvetica', 'bold');
        doc.text(ad.advertised_price_gbp != null ? money(ad.advertised_price_gbp) : '-', MARGIN + 32, y);
        doc.setFont('helvetica', 'normal');
        doc.text(ad.mileage_observed != null ? `${num(ad.mileage_observed)} mi` : '-', MARGIN + 62, y);
        doc.setTextColor(100, 100, 100);
        doc.text(clip(ad.seller_name || ad.dealer_type || '-', 35), MARGIN + 95, y);
        y += 5;
        doc.setDrawColor(215, 215, 215);
        doc.setLineWidth(0.15);
        doc.line(MARGIN, y, PAGE_W - MARGIN, y);
        y += 2;
      }
    }

  } else {
    // ── Standard: Valuation ────────────────────────────────────────────────────
    if (val.retail_low_valuation != null) {
      sectionTitle('Valuation');
      row('Retail Value', `${money(val.retail_low_valuation)} - ${money(val.retail_high_valuation)}`);
      row('Trade Value',  `${money(val.trade_low_valuation)} - ${money(val.trade_high_valuation)}`);
    }

    // ── Standard: Risk Checks ──────────────────────────────────────────────────
    sectionTitle('Risk Checks');
    row('Finance',  ac.finance_data_qty === 0 ? '[OK] No finance recorded' : '[!] Outstanding finance recorded', ac.finance_data_qty > 0 ? 'bad' : 'good');
    row('Stolen',   ac.stolen_vehicle_data_qty === 0 ? '[OK] Not recorded stolen' : '[!] Recorded as stolen',       ac.stolen_vehicle_data_qty > 0 ? 'bad' : 'good');
    row('Write-off', hasWriteOff ? `[!] ${writeOffLabel}` : '[OK] No write-off recorded',                           hasWriteOff ? 'bad' : 'good');
    if (result.motExpiryDate) row('MOT Expiry',          result.motExpiryDate);
    if (result.motMileage)    row('Mileage at Last MOT', `${num(result.motMileage)} miles`);
  }

  // ── Footer ────────────────────────────────────────────────────────────────────
  checkPage(14);
  y += 6;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text(
    `Generated by MotorQuoter - motorquoter.vercel.app - ${checkDate} - Data sourced from DVLA, Experian AutoCheck, DVSA and Cazana`,
    PAGE_W / 2, y, { align: 'center' }
  );

  return doc.output('arraybuffer');
}

export async function POST(request) {
  try {
    const { result, vrm, tier } = await request.json();
    if (!result || !vrm) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
    const filename = `${vrm}_${datePart}.pdf`;
    const today = now.toLocaleDateString('en-GB');
    const tierLabel = tier === 'pro' ? 'Pro' : 'Standard';

    const pdfBuffer = buildPdf(result, vrm, tierLabel, today);

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
