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
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '');

  const positions = [];
  for (const field of ASSESSMENT_FIELDS) {
    const rx = new RegExp(esc(field) + '\\s*:', 'i');
    const m = clean.match(rx);
    if (m !== null) {
      positions.push({ field, start: m.index, afterColon: m.index + m[0].length });
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
  const hasFields = ['Visible Damage Summary', 'Estimated Repair Range', 'Key Cost Drivers']
    .some(f => assessment[f] && String(assessment[f]).trim().length > 2);
  if (hasFields) return assessment;
  if (assessment._raw) return { ...parseFromRaw(assessment._raw), _market: assessment._market };
  return assessment;
}

function parseChecklistItems(text) {
  if (!text) return [];
  const parts = text.split(/\n(?=\d+[.)]\s)/);
  return parts
    .map(part => stripMd(part.replace(/^\d+[.)]\s*/, '').trim()))
    .filter(s => s.length > 0);
}

function buildAssessmentPdf(rawAssessment, vehicleDetails, market, identifier, checkDate) {
  const assessment = resolveFields(rawAssessment);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  let y = MARGIN;

  // Fix 1: replace £ and em dashes before passing to jsPDF (helvetica cannot render them)
  const str = (v) => stripMd(v == null ? '' : String(v))
    .replace(/£/g, 'GBP')
    .replace(/—/g, '-')
    .replace(/–/g, '-');

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
    const vehicleStr = [vd.year, vd.make, vd.model].filter(Boolean).join(' ');
    if (vehicleStr) fieldBlock('Vehicle', vehicleStr);
    if (vd.vrm)               fieldBlock('Registration', vd.vrm);
    if (vd.lotNumber)         fieldBlock('Copart Lot', vd.lotNumber);
    if (vd.damageDescription) fieldBlock('Seller Damage Description', vd.damageDescription);
    fieldBlock('Market', market === 'IE' ? 'Republic of Ireland' : 'Great Britain');
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
  const checklistItems = parseChecklistItems(assessment['WhatsApp Inspection Checklist']);
  if (checklistItems.length > 0) {
    sectionTitle('WhatsApp Inspection Checklist (GBP 15 - book 48hrs before sale)');
    for (let i = 0; i < checklistItems.length; i++) {
      const itemText = checklistItems[i];
      const prefix = `${i + 1}. `;
      const wrapped = doc.splitTextToSize(prefix + itemText, CONTENT_W - 4);
      checkPage(wrapped.length * 4.5 + 4);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(20, 20, 20);
      for (const line of wrapped) {
        doc.text(line, MARGIN + 2, y);
        y += 4.5;
      }
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
    const { assessment, vehicleDetails, market, identifier } = await request.json();
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
      today
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
