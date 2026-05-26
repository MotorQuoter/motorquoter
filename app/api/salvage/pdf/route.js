import { jsPDF } from 'jspdf';

const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;

const ASSESSMENT_FIELDS = [
  'Visible Damage Summary',
  'Estimated Repair Range',
  'Key Cost Drivers',
  'Red Flags',
  'Alternative Damage Scenario',
  'Airbags',
  'Confidence Level',
  'Bidder Note',
  'Recommended Action',
  'Realistic Exit Value',
  'Margin Calculation',
  'WhatsApp Inspection Checklist',
];

function stripMd(text) {
  if (!text) return '';
  return text
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/\*{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function parseFromRaw(rawText) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const clean = rawText
    .replace(/\*{1,3}/g, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '');

  const positions = [];
  for (const field of ASSESSMENT_FIELDS) {
    const patterns = [
      new RegExp('^#{1,6}\\s*' + esc(field) + '\\s*$', 'im'),
      new RegExp(esc(field) + '\\s*:', 'i'),
    ];
    for (const rx of patterns) {
      const m = clean.match(rx);
      if (m !== null) {
        positions.push({ field, start: m.index, afterColon: m.index + m[0].length });
        break;
      }
    }
  }
  positions.sort((a, b) => a.start - b.start);

  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const { field, afterColon } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : clean.length;
    result[field] = clean.slice(afterColon, end).trim();
  }
  return result;
}

function resolveFields(assessment) {
  const hasAllFields = ['Visible Damage Summary', 'Key Cost Drivers', 'Red Flags', 'Airbags', 'Confidence Level', 'Realistic Exit Value']
    .every(f => assessment[f] && String(assessment[f]).trim().length > 2);
  if (hasAllFields) return assessment;
  if (assessment._raw) {
    const parsed = parseFromRaw(assessment._raw);
    const merged = { ...assessment };
    for (const field of ASSESSMENT_FIELDS) {
      if (!merged[field] || String(merged[field]).trim().length < 2) {
        if (parsed[field] && String(parsed[field]).trim().length > 2) {
          merged[field] = parsed[field];
        }
      }
    }
    return merged;
  }
  return assessment;
}

function parseChecklistItems(text) {
  if (!text) return [];
  const parts = text.split(/\n(?=\d+[.)]\s)/);
  return parts
    .map(part => stripMd(part.replace(/^\d+[.)]\s*/, '').trim()))
    .filter(s => s.length > 0);
}

function buildAssessmentPdf(rawAssessment, vehicleDetails, market, identifier, checkDate, bregoData) {
  const assessment = resolveFields(rawAssessment);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  // Helvetica uses WinAnsiEncoding: £ (U+00A3) maps to 0xA3 and renders correctly.
  // Strip only characters outside Latin-1 (> 0xFF) which have no WinAnsi mapping.
  const str = (v) => stripMd(v == null ? '' : String(v))
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/&\s*þ/g, '-')
    .replace(/•/g, '-')
    .replace(/\bGBP\b\s*/g, '£')
    .replace(/[^\x00-\xFF]/g, '');

  // Fix 6: 5mm buffer on page breaks
  function checkPage(needed = 10) {
    if (y + needed > PAGE_H - MARGIN - 5) { doc.addPage(); y = MARGIN; }
  }

  function sectionTitle(title) {
    checkPage(14);
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

  // Fix 3: render "Not available" in grey if value is empty/null
  function fieldBlock(label, value, opts = {}) {
    const clean = str(value);
    const isEmpty = !clean;
    const displayText = isEmpty ? 'Not available' : clean;
    const lines = doc.splitTextToSize(displayText, CONTENT_W);
    checkPage(8 + lines.length * 4.5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text(label.toUpperCase(), MARGIN, y);
    y += 4;
    if (isEmpty) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(160, 160, 160);
    } else {
      doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      doc.setFontSize(opts.large ? 11 : 9);
      if (opts.color) doc.setTextColor(...opts.color);
      else doc.setTextColor(20, 20, 20);
    }
    for (const line of lines) {
      checkPage(5);
      doc.text(line, MARGIN, y);
      y += 4.5;
    }
    y += 2;
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 3;
  }

  // Fix 4 — Section 1: HEADER
  doc.setFillColor(20, 20, 20);
  doc.rect(0, 0, PAGE_W, 28, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text('MOTORQUOTER', MARGIN, y + 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(180, 180, 180);
  doc.text('Damage Assessment Report', MARGIN, y + 15);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(240, 90, 26);
  doc.text(str(identifier) || 'Assessment', PAGE_W - MARGIN, y + 9, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(180, 180, 180);
  doc.text(`${market === 'IE' ? 'IE' : 'GB'} Market - ${checkDate}`, PAGE_W - MARGIN, y + 15, { align: 'right' });

  // Fix 2: set y explicitly — header is always 28mm + 6mm padding
  y = 34;

  // Fix 4 — Section 2: VEHICLE DETAILS
  const vd = vehicleDetails || {};
  const hasDetails = Object.values(vd).some(v => v && String(v).trim());
  if (hasDetails) {
    sectionTitle('Vehicle Details');

    // Two-column table layout
    const COL1_W = 50;
    const COL2_W = CONTENT_W - COL1_W;
    const ROW_H = 7;
    const tableFields = [
      ['Registration', vd.vrm],
      ['Copart Lot', vd.lotNumber],
      ['Year', vd.year],
      ['Make / Model', [vd.make, vd.model].filter(Boolean).join(' ')],
      ['Market', market === 'IE' ? 'Republic of Ireland' : 'Great Britain'],
      ['Category', vd.category],
      ['Run Condition', vd.runCondition],
      ['Odometer', vd.odometer ? `${vd.odometer} miles` : null],
      ['Keys', vd.keys],
      ['Fuel', vd.fuel],
      ['Transmission', vd.transmission],
      ['Primary Damage', vd.primaryDamage],
      ['Secondary Damage', vd.secondaryDamage],
      ['Additional Damage', vd.additionalDamage],
      ['V5 Status', vd.v5Status],
      ['VAT on Sale', vd.vatOnSale],
    ].filter(([, val]) => val && String(val).trim());

    for (const [label, value] of tableFields) {
      checkPage(ROW_H + 2);
      doc.setFillColor(248, 248, 248);
      doc.rect(MARGIN, y - 4, COL1_W, ROW_H, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(90, 90, 90);
      doc.text(label, MARGIN + 2, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(20, 20, 20);
      const valLines = doc.splitTextToSize(str(value), COL2_W - 4);
      doc.text(valLines[0] || '', MARGIN + COL1_W + 2, y);
      y += ROW_H;
      doc.setDrawColor(215, 215, 215);
      doc.setLineWidth(0.15);
      doc.line(MARGIN, y - 3, PAGE_W - MARGIN, y - 3);
    }

    // Seller notes — filtered, only show if genuine risk info present
    const IGNORE_PATTERNS = [
      /engine starts/i, /has keys/i, /keys available/i,
      /cat\s*[a-z]\s*repairable/i, /repairable structural/i,
      /\d{3,6}\s*miles?/i, /v5 reference/i, /v5c/i,
      /copart verified/i, /run condition/i, /there are keys/i,
      /^highlights/i, /^additional info/i,
    ];
    const RISK_PATTERNS = [
      /knock/i, /gearbox/i, /transmission/i, /slipping/i,
      /flood/i, /fire/i, /theft/i, /stolen/i,
      /airbag/i, /deployed/i, /mileage discrepan/i,
      /structural repair/i, /previously repaired/i,
      /no brakes/i, /brake/i, /abs/i, /engine management/i,
      /oil leak/i, /coolant/i, /overheating/i,
    ];

    const rawNotes = str(vd.damageDescription || '');
    const noteLines = rawNotes.split(/\n/).map(l => l.trim()).filter(Boolean);
    const riskNotes = noteLines.filter(line => {
      const isIgnored = IGNORE_PATTERNS.some(p => p.test(line));
      const isRisk = RISK_PATTERNS.some(p => p.test(line));
      return !isIgnored && (isRisk || (!isIgnored && line.length > 20));
    });

    if (riskNotes.length > 0) {
      y += 3;
      checkPage(10 + riskNotes.length * 5);
      doc.setFillColor(255, 243, 230);
      doc.rect(MARGIN, y - 3, CONTENT_W, 6 + riskNotes.length * 5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(180, 80, 0);
      doc.text('SELLER NOTES — REVIEW REQUIRED', MARGIN + 2, y + 1);
      y += 6;
      for (const note of riskNotes) {
        const noteWrapped = doc.splitTextToSize(`• ${note}`, CONTENT_W - 4);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(100, 40, 0);
        for (const line of noteWrapped) {
          checkPage(5);
          doc.text(line, MARGIN + 2, y);
          y += 4.5;
        }
      }
      y += 4;
    }
  }

  // MOT History section
  const motHistory = vd.motHistory;
  if (Array.isArray(motHistory) && motHistory.length > 0) {
    sectionTitle('MOT History');
    for (const test of motHistory) {
      const pass = (test.testResult || '').toUpperCase() === 'PASSED';
      const failures   = (test.rfrAndComments || []).filter(c => c.type === 'FAIL');
      const advisories = (test.rfrAndComments || []).filter(c => c.type === 'ADVISORY');
      checkPage(10);
      const testLine = [
        test.testResult,
        test.completedDate,
        test.odometerValue ? `${Number(test.odometerValue).toLocaleString()} mi` : null,
        pass && test.expiryDate ? `exp ${test.expiryDate}` : null,
      ].filter(Boolean).join(' - ');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...(pass ? [0, 130, 0] : [180, 0, 0]));
      doc.text(str(testLine), MARGIN, y);
      y += 5;
      for (const f of failures) {
        const lines = doc.splitTextToSize(`FAIL: ${str(f.text)}`, CONTENT_W - 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(180, 0, 0);
        for (const line of lines) { checkPage(4); doc.text(line, MARGIN + 4, y); y += 4; }
      }
      for (const a of advisories) {
        const lines = doc.splitTextToSize(`> ${str(a.text)}`, CONTENT_W - 8);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        for (const line of lines) { checkPage(4); doc.text(line, MARGIN + 4, y); y += 4; }
      }
      y += 2;
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.15);
      doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
      y += 2;
    }
  }

  // Salvage History section
  const sh = vd.salvageHistory;
  if (sh) {
    const shFound = sh.salvage_auction_record_found === true;
    const shRecords = sh.salvage_auction_records || [];
    sectionTitle('Salvage History Check');
    if (!shFound) {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 130, 0);
      doc.text('[OK] No previous salvage auction records found', MARGIN, y); y += 8;
    } else {
      checkPage(8);
      const timesText = `[!] This vehicle has been through salvage auction ${shRecords.length} time${shRecords.length !== 1 ? 's' : ''}`;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(170, 0, 0);
      doc.text(str(timesText), MARGIN, y); y += 7;
      for (const rec of shRecords) {
        const dt = (s) => {
          if (!s) return '-';
          const d = s.split('T')[0].split('-');
          return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
        };
        checkPage(24);
        const recLines = [
          rec.salvage_auction_lot_date && ['Lot Date',         dt(rec.salvage_auction_lot_date)],
          rec.salvage_auction_lot_desc && ['Category',         rec.salvage_auction_lot_desc],
          rec.mileage != null          && ['Mileage at Sale',  `${Number(rec.mileage).toLocaleString()} miles`],
          rec.primary_damage_desc      && ['Primary Damage',   rec.primary_damage_desc],
          rec.secondary_damage_desc    && ['Secondary Damage', rec.secondary_damage_desc],
          rec.salvage_auction_location && ['Auction Location', rec.salvage_auction_location],
        ].filter(Boolean);
        for (const [label, value] of recLines) {
          checkPage(8);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
          doc.text(label, MARGIN, y);
          doc.setFont('helvetica', label === 'Category' ? 'bold' : 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(label === 'Category' ? 170 : 20, 0, 0);
          doc.text(str(value), MARGIN + 40, y); y += 5;
          doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.15);
          doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1); y += 2;
        }
        const imgCount = rec.external_image_urls?.length || 0;
        if (imgCount > 0) {
          checkPage(6);
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(100, 100, 100);
          doc.text(`${imgCount} photo${imgCount !== 1 ? 's' : ''} on record`, MARGIN, y); y += 6;
        }
        y += 2;
      }
    }
  }

  // Brego Market Valuation section
  if (bregoData) {
    const fmtP = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : 'N/A';
    const src = bregoData._mileageSource;
    const srcLabel = src === 'copart_listed' ? 'Copart listing' : src === 'dvsa_mot' ? 'DVSA last MOT' : 'default (50k miles)';
    const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    sectionTitle(`Live Market Valuation (Brego, ${monthYear})`);
    checkPage(36);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    doc.text(`Mileage: ${Number(bregoData._mileageUsed).toLocaleString('en-GB')} miles (source: ${srcLabel})`, MARGIN, y); y += 5;
    const COL = CONTENT_W / 4;
    const headers = ['', 'Low', 'Average', 'High'];
    headers.forEach((h, i) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
      doc.text(h, MARGIN + i * COL + (i === 0 ? 0 : COL / 2), y, i === 0 ? {} : { align: 'center' });
    });
    y += 5;
    doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.2); doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    const rows = [
      ['Retail', bregoData.retail_low_valuation, bregoData.retail_average_valuation, bregoData.retail_high_valuation],
      ['Trade',  bregoData.trade_low_valuation,  bregoData.trade_average_valuation,  bregoData.trade_high_valuation],
    ];
    for (const [label, lo, avg, hi] of rows) {
      checkPage(8);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
      doc.text(label, MARGIN, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
      doc.text(fmtP(lo),  MARGIN + COL * 1.5, y, { align: 'center' });
      doc.setFont('helvetica', 'bold'); doc.setTextColor(0, 120, 60);
      doc.text(fmtP(avg), MARGIN + COL * 2.5, y, { align: 'center' });
      doc.setFont('helvetica', 'normal'); doc.setTextColor(20, 20, 20);
      doc.text(fmtP(hi),  MARGIN + COL * 3.5, y, { align: 'center' });
      y += 6;
      doc.setDrawColor(220, 220, 220); doc.setLineWidth(0.15); doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    if (vd.estimatedRetail) {
      checkPage(8); y += 2;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
      doc.text(`Copart ERV: ${str(vd.estimatedRetail)} — vendor-type interpretation in assessment`, MARGIN, y); y += 6;
    }
    if (src !== 'copart_listed') {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(160, 100, 0);
      doc.text(`Note: mileage from ${srcLabel} — engine applied 5-10% downward caution to retail figures.`, MARGIN, y); y += 7;
    }
    y += 2;
  }

  // Fix 4 — Section 3: REPAIR ESTIMATE BANNER
  const repairRange = str(assessment['Estimated Repair Range']);
  if (repairRange) {
    checkPage(26);
    y += 3;
    doc.setFillColor(240, 90, 26);
    doc.roundedRect(MARGIN, y - 3, CONTENT_W, 19, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 200, 170);
    doc.text('ESTIMATED REPAIR RANGE', MARGIN + 4, y + 3);
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text(repairRange, MARGIN + 4, y + 12);
    y += 23;
  }

  // Fix 4 — Section 4: DAMAGE ASSESSMENT
  sectionTitle('Damage Assessment');
  fieldBlock('Visible Damage Summary',      assessment['Visible Damage Summary']);
  fieldBlock('Key Cost Drivers',            assessment['Key Cost Drivers']);
  fieldBlock('Red Flags',                   assessment['Red Flags']);
  fieldBlock('Alternative Damage Scenario', assessment['Alternative Damage Scenario']);
  fieldBlock('Airbags',                     assessment['Airbags']);

  // Fix 5: keep existing colour logic for Confidence Level
  const confLevel = str(assessment['Confidence Level']);
  const confColor = confLevel.toLowerCase().includes('high')   ? [0, 130, 0]
                  : confLevel.toLowerCase().includes('medium') ? [160, 110, 0]
                  : confLevel.toLowerCase().includes('low')    ? [160, 0, 0]
                  : [20, 20, 20];
  fieldBlock('Confidence Level', confLevel, { color: confColor, bold: true });

  // Fix 4 — Section 5: VALUATION & BIDDING
  sectionTitle('Valuation & Bidding');
  fieldBlock('Realistic Exit Value', assessment['Realistic Exit Value'], { bold: true });
  fieldBlock('Margin Calculation',   assessment['Margin Calculation']);
  fieldBlock('Bidder Note',          assessment['Bidder Note']);

  // Fix 5: keep existing colour logic for Recommended Action
  const action = str(assessment['Recommended Action']);
  const actionColor = action.toLowerCase().includes('option a') ? [0, 130, 0]
                    : action.toLowerCase().includes('option b') ? [160, 110, 0]
                    : action.toLowerCase().includes('option c') ? [160, 0, 0]
                    : [20, 20, 20];
  fieldBlock('Recommended Action', action, { color: actionColor, bold: true });

  // Fix 4 — Section 6: WHATSAPP INSPECTION CHECKLIST
  const checklistItems = parseChecklistItems(assessment['WhatsApp Inspection Checklist']).map(item => str(item));
  if (checklistItems.length > 0) {
    sectionTitle('WhatsApp Inspection Checklist (£10 - book 48hrs before sale)');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(20, 20, 20);
    for (let i = 0; i < checklistItems.length; i++) {
      const itemText = checklistItems[i];
      const prefix = `${i + 1}. `;
      const wrapped = doc.splitTextToSize(prefix + itemText, CONTENT_W - 4);
      for (const line of wrapped) {
        checkPage(4.5);
        doc.text(line, MARGIN + 2, y);
        y += 4.5;
      }
      checkPage(4);
      y += 2;
    }
  }

  // Fix 4 — Section 7: FOOTER
  checkPage(18);
  y += 6;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(150, 150, 150);
  const disclaimer =
    `Generated by MotorQuoter - motorquoter.app - ${checkDate} - This assessment is AI-generated using the MotorQuoter Assessment Engine and is for bidding guidance only. It is not a professional repair quote. Repair costs are estimates based on visible damage in photos; hidden or secondary damage may increase actual costs. MotorQuoter is not affiliated with Copart, CAP, HPI or any third-party data provider. Always commission a physical inspection before bidding.`;
  const discLines = doc.splitTextToSize(disclaimer, CONTENT_W);
  for (const line of discLines) {
    checkPage(4);
    doc.text(line, MARGIN, y);
    y += 3.5;
  }

  return doc.output('arraybuffer');
}

export async function POST(request) {
  try {
    const { assessment, vehicleDetails, market, identifier, bregoData } = await request.json();
    if (!assessment) {
      return Response.json({ error: 'Missing assessment data' }, { status: 400 });
    }

    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
    const ref = (identifier || 'Salvage').replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'Salvage';
    const filename = `${ref}Assessment${datePart}.pdf`;
    const today = now.toLocaleDateString('en-GB');

    const pdfBuffer = buildAssessmentPdf(
      assessment,
      vehicleDetails || {},
      market || 'GB',
      identifier || '',
      today,
      bregoData || null
    );

    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.byteLength),
      },
    });

  } catch (err) {
    console.error('Assessment PDF error:', err);
    return Response.json({ error: 'PDF generation failed' }, { status: 500 });
  }
}
