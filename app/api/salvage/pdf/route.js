import { jsPDF } from 'jspdf';
import { createClient } from '@supabase/supabase-js';
import { parseVdsParts, buildBuyerFlags } from '@/lib/parts.mjs';
import { formatOdometer } from '@/lib/odometerDisplay';
import { scrubSideWords } from '@/lib/sideScrub.mjs';
import { applyEdits } from '@/lib/ledgerEdits.mjs';
import { computeBookingLine, bookingHeaderSuffix, isChecklistSuppressed, checklistWarning } from '@/lib/bookingLine.mjs';
import { categoryDirective } from '@/config/booking.mjs';
import { FREE_REPORT_STRINGS } from '@/config/freeReport.mjs';
import { FEEDBACK_URL, FEEDBACK_STRINGS } from '@/config/feedback.mjs';
import { VENDOR_SUFFIX_MAP } from '@/lib/coreSlots';
import { parseAction } from '@/config/recommendedAction.mjs';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;

const ASSESSMENT_FIELDS = [
  'Visible Damage Summary',
  'Parts Breakdown',
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
      new RegExp('^\\s*' + esc(field) + '\\s*:', 'im'),
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

function parsePdfParts(text) {
  if (!text) return [];
  const result = [];
  for (const line of text.split('\n')) {
    // 5-field: name | action | OEM | S/H | Repair cost
    const m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/);
    if (!m) continue;
    const [, name, action, col3, col4, col5] = m;
    const parseP = s => {
      if (!s || /^[—\-–]+$|n\/a/i.test(s.trim())) return null;
      const n = s.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
      return n ? Math.round(parseFloat(n[0])) : null;
    };
    // Reconstruct {oem, used} to match _reconciledParts exactly (see success/page.js parseParts).
    const act = action.trim().toLowerCase();
    const oem  = act === 'replace' ? parseP(col3) : act === 'repair' ? null : parseP(col5);
    const used = act === 'replace' ? parseP(col4) : act === 'repair' ? parseP(col5) : null;
    // Side-word scrub (lib/sideScrub.mjs) — display-only fallback parser (runs only when the
    // server never produced _reconciledParts). No stamp: this degraded path is not persisted.
    result.push({ name: scrubSideWords(name.trim()).name, action: action.trim(), oem, used });
  }
  return result;
}

function parseChecklistItems(text) {
  if (!text) return [];
  const parts = text.split(/\n(?=\d+[.)]\s)/);
  return parts
    .map(part => stripMd(part.replace(/^\d+[.)]\s*/, '').trim()))
    .filter(s => s.length > 0);
}

function buildAssessmentPdf(rawAssessment, vehicleDetails, market, identifier, checkDate, bregoData, editLayer) {
  const assessment = resolveFields(rawAssessment);
  // Buyer ledger edits (batch 105): the SAME recompute path the screen uses, so the PDF can never
  // disagree with what the buyer saw. With no stored layer it reproduces the engine figures exactly.
  // Every parts_sum-downstream surface below reads from `edited`; row keys come from edited.rows.
  const edited = applyEdits(assessment, editLayer ?? null);
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
    // Measure the wrap in the SAME font the value renders in (set again below). Otherwise
    // splitTextToSize measures in whatever font the previous call left — e.g. a sectionTitle's
    // 7.5pt — and a 9pt value then overflows CONTENT_W and clips mid-word at the right edge
    // (witnessed on Realistic Exit Value, which follows sectionTitle('Valuation & Bidding')).
    doc.setFont('helvetica', (!isEmpty && opts.bold) ? 'bold' : 'normal');
    doc.setFontSize((!isEmpty && opts.large) ? 11 : 9);
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

  // Free-report marking (Commit 4) — gated on the assessment's payment_kind render hint.
  if (assessment._payment_kind === 'free_report') {
    y += 4; // Piece 3: drop onto its own line, clear of the header's "GB Market - date" row
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(240, 90, 26);
    doc.text(FREE_REPORT_STRINGS.marking, MARGIN, y);
    y += 5;
  }

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

  // Structured Checklist (CORE) — code-owned forced-verdict slots, same _slots shape the web
  // page renders from (lib/coreSlots.js), so the two surfaces never drift. [OK]/[VERDICT]
  // markers replace checkmark glyphs — Helvetica/WinAnsi can't render them (see str() above).
  const slotData = assessment._slots;
  if (slotData?.groups?.length > 0) {
    sectionTitle('Structured Checklist (CORE)');
    const allClearSet = new Set(slotData.allClear);
    const allClearSlots = slotData.groups.flatMap(g => g.slots).filter(s => allClearSet.has(s.id));
    if (allClearSlots.length > 0) {
      const okLines = doc.splitTextToSize(`[OK] Verified clear - ${allClearSlots.map(s => s.label).join(', ')}`, CONTENT_W);
      checkPage(4.5 * okLines.length + 2);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(0, 130, 0);
      for (const line of okLines) { doc.text(str(line), MARGIN, y); y += 4.5; }
      y += 2;
    }
    for (const group of slotData.groups) {
      if (group.id === 'physical') continue;
      const shown = group.slots.filter(s => !allClearSet.has(s.id));
      if (shown.length === 0) continue;
      checkPage(8);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
      doc.text(group.label.toUpperCase(), MARGIN, y);
      y += 4;
      for (const slot of shown) {
        const c = (slot.verdict === 'confirmed' || slot.verdict === 'undamaged' || slot.verdict === 'dedicated-photo-intact') ? [0, 130, 0]
          : (slot.verdict === 'discrepancy' || slot.verdict === 'damaged') ? [180, 0, 0]
          : [180, 80, 0];
        const lines = doc.splitTextToSize(`[${slot.verdict.toUpperCase()}] ${slot.label}: ${slot.detail}`, CONTENT_W - 4);
        checkPage(4 * lines.length + 1);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...c);
        for (const line of lines) { doc.text(str(line), MARGIN + 2, y); y += 4; }
      }
      y += 2;
    }
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 3;
  }

  // MOT History section
  const motHistory = vd.motHistory;
  if (Array.isArray(motHistory) && motHistory.length > 0) {
    sectionTitle('MOT History');
    for (const test of motHistory) {
      const pass = (test.testResult || '').toUpperCase() === 'PASSED';
      const failures   = (test.defects || []).filter(d => d.type === 'MAJOR');
      const advisories = (test.defects || []).filter(d => d.type === 'ADVISORY' || d.type === 'PRS');
      checkPage(10);
      const testLine = [
        test.testResult,
        test.completedDate,
        formatOdometer(test).label,   // normalised miles; km rows annotated "(NNN km)" — free-flow line, no column collision
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
    const shSelfRef = sh.isSelfReferenceFirstWriteOff === true;
    const shGenuinePriors = sh.genuinePriorCount ?? shRecords.length;
    sectionTitle('Salvage History Check');
    if (!shFound) {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 130, 0);
      doc.text('[OK] No previous salvage auction records found', MARGIN, y); y += 8;
    } else if (shSelfRef || shGenuinePriors === 0) {
      checkPage(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 130, 0);
      doc.text('[OK] First write-off — no prior salvage auction history', MARGIN, y); y += 8;
    } else {
      checkPage(8);
      const timesText = `[!] This vehicle has been through salvage auction ${shGenuinePriors} time${shGenuinePriors !== 1 ? 's' : ''}`;
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
    const srcLabel = src === 'copart_listed' ? 'Copart listing'
      : src === 'listing_odometer' ? 'Copart listing (parsed)'
      : src === 'dvsa_mot' ? 'DVSA last MOT'
      : src === 'photo_odometer' ? 'Odometer read from photos'
      : src === 'age_estimate' ? 'Age-based estimate'
      : src === 'age_anomaly' ? 'Age-based estimate (no data found)'
      : 'default (50k miles)';
    const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    sectionTitle(`Live Market Valuation (${monthYear})`);
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
    if (src === 'age_estimate' || src === 'age_anomaly') {
      checkPage(12);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(180, 0, 0);
      const estimateWarning = src === 'age_anomaly'
        ? `ESTIMATED mileage — vehicle over 4 years old, no listing/photo/DVSA mileage available. Valuation, exit value and margin depend on an unverified estimate. Confirm actual mileage before bidding.`
        : `ESTIMATED mileage — no actual mileage confirmed from listing, photos, or DVSA. Valuation, exit value and margin depend on this assumed figure. Confirm actual mileage before bidding.`;
      const warnLines = doc.splitTextToSize(estimateWarning, CONTENT_W);
      doc.text(warnLines, MARGIN, y); y += warnLines.length * 4 + 4;
    }
    if (vd.photoMileageFlag) {
      checkPage(10);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(160, 100, 0);
      const flagLines = doc.splitTextToSize(str(vd.photoMileageFlag), CONTENT_W);
      doc.text(flagLines, MARGIN, y); y += flagLines.length * 4 + 3;
    }
    y += 2;
  }

  // Section 3: REPAIR ESTIMATE BANNER — code-owned parts_sum, edited view (buyer strikes/adds applied)
  const partsSum = assessment._partsReconciliation?.parts_sum;
  if (partsSum > 0) {
    const bannerH = edited.applied ? 24 : 19;
    checkPage(bannerH + 7);
    y += 3;
    doc.setFillColor(240, 90, 26);
    doc.roundedRect(MARGIN, y - 3, CONTENT_W, bannerH, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(255, 200, 170);
    doc.text('ESTIMATED REPAIR — VISIBLE ITEMS', MARGIN + 4, y + 3);
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text(`£${Number(edited.partsSum).toLocaleString('en-GB')}`, MARGIN + 4, y + 12);
    if (edited.applied) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(255, 220, 200);
      doc.text(`Adjusted by you - engine estimate £${Number(partsSum).toLocaleString('en-GB')}`, MARGIN + 4, y + 18);
    }
    y += bannerH + 4;
  }

  // Fix 4 — Section 4: DAMAGE ASSESSMENT
  sectionTitle('Damage Assessment');
  // §7 (batch 73): Copart's damage LABEL, shown to the buyer as a plain fact. It never reached the
  // assessment (withheld from both model calls, 3b) — printed beside the photo-based read with no
  // agreement/disagreement scoring. Parity with the salvage success page.
  if (assessment._copartDamageLabel) {
    fieldBlock('Auction Damage Label', `${assessment._copartDamageLabel.line1}\n${assessment._copartDamageLabel.line2}`);
  }
  // VDS — code-assembled Asset ID line + model standfirst + code-assembled per-panel blocks.
  // (_vdsParts, Step 4c). parseVdsParts().preamble extracts the model standfirst and
  // strips any stray PART: text; the per-panel section is fully code-owned.
  {
    const { preamble } = parseVdsParts(assessment['Visible Damage Summary'] || '');
    const vdsParts = assessment._vdsParts || [];
    const bodyStyle = assessment._bodyStyle || '';
    const stickerSuffix = assessment._stickerSuffix || '';
    const vendorEntry = stickerSuffix && stickerSuffix !== 'UNREADABLE'
      ? (VENDOR_SUFFIX_MAP[stickerSuffix]?.vendorType
          ? `${stickerSuffix} — ${VENDOR_SUFFIX_MAP[stickerSuffix].vendorType}`
          : stickerSuffix)
      : stickerSuffix === 'UNREADABLE' ? 'Vendor suffix not legible' : null;
    // Non-insurer suffixes (C, Q) get the warning colour — map stays the single owner of the class.
    const isNonInsurerSuffix = !!(stickerSuffix && stickerSuffix !== 'UNREADABLE'
      && VENDOR_SUFFIX_MAP[stickerSuffix]?.insurerEntered === false);
    const assetIdLine = bodyStyle
      ? (vendorEntry ? `${bodyStyle}  ·  Vendor: ${vendorEntry}` : bodyStyle)
      : null;
    if (!preamble && vdsParts.length === 0 && !assetIdLine) {
      fieldBlock('Visible Damage Summary', assessment['Visible Damage Summary']);
    } else {
      checkPage(14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 100, 100);
      doc.text('VISIBLE DAMAGE SUMMARY', MARGIN, y);
      y += 4;
      if (assetIdLine) {
        const assetLines = doc.splitTextToSize(str(assetIdLine).toUpperCase(), CONTENT_W);
        checkPage(assetLines.length * 4.5 + 3);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        if (isNonInsurerSuffix) doc.setTextColor(160, 110, 0); else doc.setTextColor(120, 120, 120);
        for (const line of assetLines) { checkPage(5); doc.text(line, MARGIN, y); y += 4.5; }
        y += 2;
      }
      if (preamble) {
        const preambleLines = doc.splitTextToSize(str(preamble), CONTENT_W);
        checkPage(preambleLines.length * 4.5 + 4);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(20, 20, 20);
        for (const line of preambleLines) { checkPage(5); doc.text(line, MARGIN, y); y += 4.5; }
        y += 2;
      }
      for (const { partName, action, prose } of vdsParts) {
        checkPage(12);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(80, 80, 80);
        doc.text(str(partName) + (action ? ` — ${action}` : ''), MARGIN, y);
        y += 4;
        const proseLines = doc.splitTextToSize(str(prose), CONTENT_W - 4);
        checkPage(proseLines.length * 4.5 + 3);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(20, 20, 20);
        for (const line of proseLines) { checkPage(5); doc.text(line, MARGIN + 4, y); y += 4.5; }
        y += 2;
      }
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.15);
      doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
      y += 3;
    }
  }

  // Parts Breakdown — structured table
  // 4f C-4 render guard: refuse any row with a blank/whitespace name (loud log).
  const _pdfNamed = (rows, src) => rows.filter(p => {
    if ((p?.name ?? '').trim() !== '') return true;
    console.warn(`[PARTS RENDER GUARD] dropped blank-name row from ${src}:`, JSON.stringify(p));
    return false;
  });
  // Render from the edit view's rows when structured (each carries _rowKey + _struck); filter the
  // blank-name guard over THESE rows so keys never re-index over the filtered array (batch 105).
  const hasStructured = assessment._reconciledParts?.length > 0;
  const pdfParts = _pdfNamed(hasStructured ? edited.rows : parsePdfParts(assessment['Parts Breakdown'] || ''), 'pdf-parts');
  const pdfAddedRows = hasStructured ? (edited.addedRows || []) : [];
  const pdfAllowanceParts = _pdfNamed(assessment._allowanceParts || [], 'pdf-allowance');
  if (pdfParts.length > 0 || pdfAllowanceParts.length > 0 || pdfAddedRows.length > 0) {
    const fmtPP = v => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
    checkPage(8 + (pdfParts.length + pdfAddedRows.length + pdfAllowanceParts.length) * 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text('PARTS BREAKDOWN', MARGIN, y);
    y += 4;
    // Five columns: PART | ACTION | OEM | S/H | REPAIR. Widths sum to 1.0 so the REPAIR right
    // edge lands exactly on the right margin (xRepair + COL_REPAIR = MARGIN + CONTENT_W).
    const COL_PART   = CONTENT_W * 0.36;
    const COL_ACT    = CONTENT_W * 0.12;
    const COL_OEM    = CONTENT_W * 0.17;
    const COL_SH     = CONTENT_W * 0.17;
    const COL_REPAIR = CONTENT_W * 0.18;
    const xAct    = MARGIN + COL_PART;
    const xOem    = xAct + COL_ACT;
    const xSh     = xOem + COL_OEM;
    const xRepair = xSh + COL_SH;
    // Three cost columns. replace → OEM + S/H. repair → OEM (all-OEM "New" comparison, when the model
    // gave a replace price) + Repair cost. labour/other → Repair cost only. The repair-row OEM now
    // reconciles with the New total (oemTotal = oem ?? used per row); S/H side and totals untouched.
    const costCells = (p) => {
      const act = (p.action || '').toLowerCase();
      if (act === 'replace') return { oem: p.oem ?? null, sh: p.used ?? null, repair: null };
      if (act === 'repair')  return { oem: p.oem ?? null, sh: null, repair: p.used ?? p.oem ?? null };
      return { oem: null, sh: null, repair: p.used ?? p.oem ?? null };
    };
    // Header
    doc.setFontSize(7); doc.setTextColor(140, 140, 140);
    doc.text('PART',   MARGIN, y);
    doc.text('ACTION', xAct,   y);
    doc.text('OEM',    xOem + COL_OEM,       y, { align: 'right' });
    doc.text('S/H',    xSh + COL_SH,         y, { align: 'right' });
    doc.text('REPAIR', xRepair + COL_REPAIR, y, { align: 'right' });
    y += 3;
    doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 2;
    for (const p of pdfParts) {
      const c = costCells(p);
      const struck = !!p._struck;
      checkPage(6);
      const tc = struck ? 150 : 20;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(tc, tc, tc);
      doc.text(str(p.name),   MARGIN, y);
      doc.setTextColor(130, 130, 130); doc.setFontSize(7.5);
      doc.text(str(p.action), xAct,   y);
      doc.setFontSize(8.5); doc.setTextColor(tc, tc, tc);
      doc.setFont('helvetica', 'normal');
      doc.text(str(fmtPP(c.oem)),    xOem + COL_OEM,       y, { align: 'right' });
      doc.setFont('helvetica', (!struck && c.sh != null) ? 'bold' : 'normal');
      doc.text(str(fmtPP(c.sh)),     xSh + COL_SH,         y, { align: 'right' });
      doc.setFont('helvetica', (!struck && c.repair != null) ? 'bold' : 'normal');
      doc.text(str(fmtPP(c.repair)), xRepair + COL_REPAIR, y, { align: 'right' });
      // Struck line: a rule through the row, and the figures greyed — the line stays visible, never removed.
      if (struck) { doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.3); doc.line(MARGIN, y - 1.1, xRepair + COL_REPAIR, y - 1.1); }
      y += 5;
      doc.setFont('helvetica', 'normal'); doc.setDrawColor(230, 230, 230); doc.setLineWidth(0.1);
      doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    // Buyer added lines — the buyer's own figure, marked as theirs (in the S/H column).
    for (const a of pdfAddedRows) {
      checkPage(6);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
      doc.text(str(`${a.text}  (your line)`), MARGIN, y);
      doc.setTextColor(130, 130, 130); doc.setFontSize(7.5);
      doc.text('added', xAct, y);
      doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
      doc.text('—', xOem + COL_OEM, y, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(str(fmtPP(a.amount)), xSh + COL_SH, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.text('—', xRepair + COL_REPAIR, y, { align: 'right' });
      y += 5;
      doc.setDrawColor(230, 230, 230); doc.setLineWidth(0.1);
      doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    // Allowance rows — visually distinct, excluded from repair total
    for (const p of pdfAllowanceParts) {
      checkPage(6);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(150, 150, 150);
      doc.text(str(p.name), MARGIN, y);
      doc.setFontSize(7.5);
      doc.text('inspect', xAct, y);
      doc.text('—', xOem + COL_OEM, y, { align: 'right' });
      doc.setFont('helvetica', 'bolditalic');
      doc.text(`~£${Number(p.used).toLocaleString('en-GB')}`, xSh + COL_SH, y, { align: 'right' });
      doc.setFont('helvetica', 'italic');
      doc.text('—', xRepair + COL_REPAIR, y, { align: 'right' });
      y += 5;
      doc.setFont('helvetica', 'normal'); doc.setDrawColor(230, 230, 230); doc.setLineWidth(0.1);
      doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    if (pdfAllowanceParts.length > 0) {
      checkPage(5);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(160, 160, 160);
      doc.text('Italic rows: inspection allowance — confirm on inspection, not included in repair total. See Inspection Flags for other excluded items.', MARGIN, y);
      y += 5;
    }
    // Column totals row — New (OEM) vs S/H bid. S/H = stored parts_sum (bid figure); New = oem??used per row.
    // Render-only: oemTotal never written to any stored field; no downstream calc reads it.
    if (assessment._partsReconciliation?.parts_sum > 0) {
      const oemTotal = pdfParts.filter(p => !p._struck).reduce((acc, p) => acc + (p.oem ?? p.used ?? 0), 0)
        + pdfAddedRows.reduce((acc, a) => acc + (Number(a.amount) || 0), 0);
      const shTotal  = edited.partsSum;
      checkPage(14);
      doc.setDrawColor(100, 100, 100); doc.setLineWidth(0.5);
      doc.line(xOem, y, PAGE_W - MARGIN, y);
      y += 5;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(60, 60, 60);
      doc.text('Repair total', MARGIN, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(130, 130, 130);
      doc.text(str(fmtPP(oemTotal)), xOem + COL_OEM, y, { align: 'right' });
      doc.setFont('helvetica', 'bold'); doc.setTextColor(240, 90, 26);
      doc.text(str(fmtPP(shTotal)),  xRepair + COL_REPAIR, y, { align: 'right' });
      y += 3.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(150, 150, 150);
      doc.text('New', xOem + COL_OEM, y, { align: 'right' });
      doc.text('S/H', xRepair + COL_REPAIR, y, { align: 'right' });
      y += 3;
    }
    y += 3;
    doc.setDrawColor(220, 220, 220); doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 4;
  }

  // Parts Sourcing — shoppable affiliate links over the costed basket (AEP-style). Additive:
  // the costed figures above are unchanged. Disclosure is mandatory + visible (web + PDF).
  const pdfSourcing = assessment._partsSourcing;
  if (pdfSourcing?.links?.length > 0) {
    checkPage(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text('PARTS SOURCING', MARGIN, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    const introLines = doc.splitTextToSize('Your repair estimate is itemised above. These are live eBay UK listings to buy the same parts — a convenience only; eBay prices vary and do not change the estimate.', CONTENT_W);
    for (const line of introLines) { doc.text(line, MARGIN, y); y += 3.6; }
    y += 1.4;
    for (const l of pdfSourcing.links) {
      checkPage(6);
      const feedColour = [22, 120, 60];
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(20, 20, 20);
      doc.text(l.part, MARGIN, y);
      const partW = doc.getTextWidth(l.part) + 3;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...feedColour);
      doc.text(l.feedLabel, MARGIN + partW, y);
      // Clickable buy link, right-aligned.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(240, 90, 26);
      const linkLabel = 'Find on eBay →';
      const linkW = doc.getTextWidth(linkLabel);
      doc.textWithLink(linkLabel, PAGE_W - MARGIN - linkW, y, { url: l.url });
      y += 5;
    }
    y += 1;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 140);
    const discLines = doc.splitTextToSize(pdfSourcing.disclosure, CONTENT_W);
    checkPage(discLines.length * 4 + 3);
    for (const line of discLines) { doc.text(line, MARGIN, y); y += 4; }
    y += 3;
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.15);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 3;
  }

  // Key Cost Drivers — code-assembled driver list (_kcdParts, 4d) + optional model judgement colour
  // (claim-bound; may be empty → drivers stand alone). Well-formed when colour drops entirely.
  {
    const kcdColour  = (assessment['Key Cost Drivers'] || '').trim();
    const kcdDrivers = (assessment._kcdParts || []).map(d => d.prose).join('\n');
    const kcdText    = [kcdColour, kcdDrivers].filter(Boolean).join('\n\n');
    if (kcdText) fieldBlock('Key Cost Drivers', kcdText);
  }

  // Damage Breakdown — per-part cards (AEP-style): Visible (costed) / Related / Inferred (£0).
  if (assessment._damageCards?.length > 0) {
    const g = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '-';
    const lines = assessment._damageCards.map(c => {
      const bits = [c.origin];
      if (c.severity) bits.push(c.severity);
      if (c.action) bits.push(c.action);
      const head = `${c.part} — ${bits.join(', ')}: ${c.cost ? g(c.cost) : '£0'}`;
      return c.note ? `${head}\n  ${c.note}` : head;
    });
    fieldBlock('Damage Breakdown', lines.join('\n'));
  }

  // Inspection Flags — structured per-part flags (model + gate-generated), weight high→low
  const pdfFlags = buildBuyerFlags(assessment);
  if (pdfFlags.length > 0) {
    checkPage(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    doc.text('INSPECTION FLAGS', MARGIN, y);
    y += 6;
    for (const f of pdfFlags) {
      const wc = f.weight === 'high' ? [192, 57, 43] : f.weight === 'medium' ? [184, 134, 11] : [136, 136, 136];
      checkPage(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...wc);
      const badge = f.weight.toUpperCase();
      doc.text(badge, MARGIN, y);
      const badgeW = doc.getTextWidth(badge) + 3;
      doc.setTextColor(20, 20, 20);
      doc.text(f.partName, MARGIN + badgeW, y);
      y += 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(60, 60, 60);
      const reasonLines = doc.splitTextToSize(f.reason, CONTENT_W - 4);
      checkPage(reasonLines.length * 4 + 3);
      for (const line of reasonLines) {
        doc.text(line, MARGIN + 4, y);
        y += 4;
      }
      y += 2;
    }
    y += 3;
  }

  if (assessment._dashLine) fieldBlock('Dashboard', assessment._dashLine);
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

  // Margin table — server-computed from tool inputs
  if (Array.isArray(assessment._marginScenarios) && assessment._marginScenarios.length > 0) {
    const msc       = edited.marginScenarios;   // margins shifted by −delta; rungs unchanged
    const fmtM      = (v) => {
      if (v == null) return '-';
      const n = Number(v);
      const abs = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (n < 0 ? '-' : '') + '£' + abs;
    };
    const carExit   = msc[0].exit_value;
    const carRepair = msc[0].repair;
    const hasVat    = msc.some(s => s.hammerVat > 0);
    const hasMargin = msc.some(s => s.margin !== null);

    // Car-level rows (exit + repair)
    const carRows = [
      carExit   != null ? ['Exit value',  fmtM(carExit),   [0, 130, 0]]  : null,
      carRepair != null ? ['Repair cost', fmtM(carRepair), [170, 0, 0]] : null,
    ].filter(Boolean);
    for (const [label, value, rgb] of carRows) {
      checkPage(7);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(60, 60, 60);
      doc.text(label, MARGIN, y);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      doc.text(value, PAGE_W - MARGIN, y, { align: 'right' });
      y += 5;
      doc.setDrawColor(230, 230, 230); doc.setLineWidth(0.1);
      doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    if (carRows.length > 0) y += 2;

    // Column layout: hammer label takes left 35%, data columns split right 65%
    const numDataCols = (hasVat ? 1 : 0) + 1 + (hasMargin ? 1 : 0);
    const HAMMER_W    = CONTENT_W * 0.35;
    const dataColW    = (CONTENT_W - HAMMER_W) / numDataCols;
    const dataXPos    = (i) => MARGIN + HAMMER_W + (i + 1) * dataColW;
    const colLabels   = [...(hasVat ? ['Hammer VAT'] : []), 'Copart Fees', ...(hasMargin ? ['Margin'] : [])];

    // Header row
    checkPage(8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(90, 90, 90);
    doc.text('HAMMER', MARGIN, y);
    colLabels.forEach((h, i) => doc.text(h.toUpperCase(), dataXPos(i), y, { align: 'right' }));
    y += 3;
    doc.setDrawColor(180, 180, 180); doc.setLineWidth(0.2);
    doc.line(MARGIN, y - 1, PAGE_W - MARGIN, y - 1);
    y += 3;

    // Scenario rows
    for (const s of msc) {
      checkPage(7);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(20, 20, 20);
      doc.text(fmtM(s.hammer), MARGIN, y);
      let ci = 0;
      if (hasVat) {
        if (s.hammerVat > 0) {
          doc.setTextColor(170, 0, 0); doc.text(fmtM(s.hammerVat), dataXPos(ci), y, { align: 'right' });
        } else {
          doc.setTextColor(150, 150, 150); doc.text('-', dataXPos(ci), y, { align: 'right' });
        }
        ci++;
      }
      doc.setTextColor(170, 0, 0); doc.text(fmtM(s.totalIncVat), dataXPos(ci), y, { align: 'right' });
      ci++;
      if (hasMargin) {
        if (s.margin !== null) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(s.margin >= 0 ? 0 : 170, s.margin >= 0 ? 130 : 0, 0);
          doc.text(fmtM(s.margin), dataXPos(ci), y, { align: 'right' });
        } else {
          doc.setFont('helvetica', 'normal'); doc.setTextColor(150, 150, 150);
          doc.text('-', dataXPos(ci), y, { align: 'right' });
        }
      }
      y += 5;
      doc.setDrawColor(230, 230, 230); doc.setLineWidth(0.1);
      doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
    }
    y += 2;
  }

  // SalvageGuide market cross-check — labelled independent reference; omitted entirely if absent.
  if (assessment._salvageGuide) {
    const sg = edited.salvageGuide;   // divergence recomputed against the edited break-even
    const g = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
    let sgTxt = `SalvageGuide (independent auction market data) — predicted bid ${g(sg.bidLow)} - ${g(sg.bidHigh)}${sg.bidAvg != null ? ` (avg ${g(sg.bidAvg)})` : ''}.`;
    if (sg.retailLow != null && sg.retailHigh != null) sgTxt += ` Market retail ref ${g(sg.retailLow)} - ${g(sg.retailHigh)}.`;
    if (sg.divergence === true) {
      // batch 95 §1: an extrapolated break-even (past the sampled margin ladder) is a weaker basis than
      // a real in-range crossing, so the note hedges accordingly. In-range wording unchanged.
      sgTxt += sg.breakEvenSource === 'extrapolated'
        ? ` NOTE: our estimated break-even sits above the market's predicted range — worth a closer look before you bid.`
        : ` NOTE: our assessment and the market data disagree here — worth a closer look before you bid.`;
    }
    fieldBlock('Market Cross-Check', sgTxt);
  } else if (assessment._bidPredictionUnavailable) {
    // Batch 103 §3: the independent bid prediction was skipped because the salvage category string was
    // not one we could match. Tell the buyer plainly; nothing is guessed.
    fieldBlock('Market Cross-Check', `The independent market bid prediction (SalvageGuide) could not be run for this vehicle: its salvage category ("${assessment._bidPredictionUnavailable.rawCategory}") was not one we could match to a standard salvage category, so this cross-check was skipped. Nothing has been guessed. Every other figure in this report is unaffected.`);
  }

  // Investment Analysis — additive block (AEP-style). Omitted entirely if absent.
  if (assessment._investmentBlock) {
    const ib = edited.investmentBlock;   // rebuild ceiling + breakeven-band mid recomputed
    const g = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
    const range = (o) => o ? `${g(o.low)} - ${g(o.high)}${o.mid != null ? ` (avg ${g(o.mid)})` : ''}` : '—';
    const lines = [];
    if (ib.asIsClean) lines.push(`Undamaged retail: ${range(ib.asIsClean)}.`);
    if (ib.afterRepairValue != null) lines.push(`After repair (Cat-adjusted): ${g(ib.afterRepairValue)}.`);
    if (ib.asIsSalvage) {
      const basis = ib.asIsSalvage.basis === 'salvageguide' ? 'SalvageGuide predicted bid'
                  : ib.asIsSalvage.basis === 'breakeven-band' ? 'estimated around break-even hammer' : '';
      lines.push(`As it stands (unrepaired): ${range(ib.asIsSalvage)}${basis ? ` [${basis}]` : ''}.`);
    }
    if (ib.partOut) lines.push(`Breaking value: ${range(ib.partOut)}.`);
    const c = ib.bidCeilings || {};
    if (c.rebuild || c.flip || c.partsOut) {
      lines.push('Max bid ceilings:');
      if (c.rebuild)  lines.push(`  - Repair & resell: ${g(c.rebuild.value)} — ${c.rebuild.assumption}`);
      if (c.flip)     lines.push(`  - Sell on as it stands: ${g(c.flip.value)} — ${c.flip.assumption}`);
      if (c.partsOut) lines.push(`  - Break for parts: ${g(c.partsOut.value)} — ${c.partsOut.assumption}`);
    }
    lines.push(`Indicative estimates — not a guaranteed valuation.${ib.confidence ? ` Confidence: ${ib.confidence}.` : ''}`);
    fieldBlock('Investment Analysis', lines.join('\n'));
  }

  fieldBlock('Bidder Note',          assessment['Bidder Note']);

  // Booking-window state (shared owner: lib/bookingLine.mjs). Computed once here; drives the
  // Recommended Action suppression, the checklist header suffix, and the code booking line below.
  const booking = computeBookingLine(assessment);

  // Recommended Action renders raw model prose (the prose suppressor was retired in Commit 2).
  const action = str(assessment['Recommended Action']);
  const actionColor = action.toLowerCase().includes('option a') ? [0, 130, 0]
                    : action.toLowerCase().includes('option b') ? [160, 110, 0]
                    : action.toLowerCase().includes('option c') ? [160, 0, 0]
                    : [20, 20, 20];
  // Code-owned bid directive (Commit 3) — head of the Recommended Action section, rendered only
  // when a HIGH-weight inspection flag is present; string selected by salvage category. See
  // config/booking.mjs. Matches the web surface.
  if (pdfFlags.some(f => f.weight === 'high')) {
    fieldBlock('Bid Directive', categoryDirective(vd.category), { color: [160, 0, 0], bold: true });
  }
  // Surface the plain-English tier label (shared copy with the web via config/recommendedAction)
  // ahead of the model's reasoning; the "Option X —" prefix is stripped so it doesn't read twice.
  const pa = parseAction(action);
  fieldBlock('Recommended Action', pa.label ? `${pa.label}\n${pa.body}` : pa.body, { color: actionColor, bold: true });

  // Fix 4 — Section 6: WHATSAPP INSPECTION CHECKLIST
  const checklistItems = parseChecklistItems(assessment['WhatsApp Inspection Checklist']).map(item => str(item));
  if (checklistItems.length > 0 && !isChecklistSuppressed(booking.state)) {
    sectionTitle(`WhatsApp Inspection Checklist (£10 - ${bookingHeaderSuffix()})`);
    // Code-owned booking reminder line (shared owner lib/bookingLine.mjs; matches the web) —
    // the single authority on inspection timing, incl. the window-closed message.
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    for (const bl of doc.splitTextToSize(booking.line, CONTENT_W)) { checkPage(4.5); doc.text(bl, MARGIN, y); y += 4.5; }
    y += 1;
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
  } else if (isChecklistSuppressed(booking.state)) {
    // Sale-passed / window-closed: the checklist section is suppressed entirely and the
    // code-owned warning renders in its place (matches the web). Gated on the state ALONE —
    // never on model output (item count), so it shows even if the model authored no items.
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(160, 0, 0);
    for (const wl of doc.splitTextToSize(checklistWarning(booking.state), CONTENT_W)) { checkPage(4.5); doc.text(wl, MARGIN, y); y += 4.5; }
    y += 1;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(20, 20, 20);
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
    `Generated by MotorQuoter - motorquoter.app - ${checkDate} - This assessment is AI-generated using the MotorQuoter Assessment Engine and is for bidding guidance only. It is not a professional repair quote. The repair figure is the sum of itemised parts costed as visible in the photos. Items not independently confirmable appear in Inspection Flags and italic allowance rows and are not in this figure. Hidden, secondary, or unphotographed damage may increase actual costs. MotorQuoter is not affiliated with Copart, CAP, HPI or any third-party data provider. Always commission a physical inspection before bidding.`;
  const discLines = doc.splitTextToSize(disclaimer, CONTENT_W);
  for (const line of discLines) {
    checkPage(4);
    doc.text(line, MARGIN, y);
    y += 3.5;
  }

  // Feedback line (Piece 2) — renders only once FEEDBACK_URL is set (dormant otherwise).
  if (FEEDBACK_URL) {
    y += 2;
    checkPage(4);
    doc.setTextColor(120, 120, 120);
    doc.text(`${FEEDBACK_STRINGS.pdf} ${FEEDBACK_URL}`, MARGIN, y);
  }

  return doc.output('arraybuffer');
}

export async function POST(request) {
  try {
    let body;
    try { body = await request.json(); } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { salvage_id, session_id, promo_token } = body;
    if (!salvage_id) {
      return Response.json({ error: 'Missing salvage_id' }, { status: 400 });
    }

    const supabase = getSupabase();
    // Deploy-before-apply: the edit_layer column may not be migrated yet. Try WITH it; if the select
    // errors (column absent), fall back to the pre-edit-layer columns so the PDF still generates.
    let { data: session, error } = await supabase
      .from('salvage_sessions')
      .select('assessment, vehicle_details, market, stripe_session_id, edit_layer')
      .eq('id', salvage_id)
      .single();
    if (error) {
      ({ data: session, error } = await supabase
        .from('salvage_sessions')
        .select('assessment, vehicle_details, market, stripe_session_id')
        .eq('id', salvage_id)
        .single());
    }

    if (error || !session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    // Ownership: caller must supply a credential that matches the stored session record
    const ownsViaStripe = session_id && session.stripe_session_id && session.stripe_session_id === session_id;
    const ownsViaPromo  = promo_token && session.vehicle_details?.promoToken && session.vehicle_details.promoToken === promo_token;
    if (!ownsViaStripe && !ownsViaPromo) {
      return Response.json({ error: 'Unauthorised' }, { status: 403 });
    }

    const { assessment } = session;
    if (!assessment) {
      return Response.json({ error: 'Assessment not ready' }, { status: 404 });
    }

    const vd         = session.vehicle_details || {};
    const market     = session.market || 'GB';
    const bregoData  = vd.bregoValuation || null;
    const identifier = vd.vrm || vd.lotNumber || [vd.make, vd.model, vd.year].filter(Boolean).join(' ') || 'Salvage';

    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
    const ref = identifier.replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'Salvage';
    const filename = `${ref}Assessment${datePart}.pdf`;
    const today = now.toLocaleDateString('en-GB');

    const pdfBuffer = buildAssessmentPdf(
      assessment,
      vd,
      market,
      identifier,
      today,
      bregoData,
      session.edit_layer ?? null
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
