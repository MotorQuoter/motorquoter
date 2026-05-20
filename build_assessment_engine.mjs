import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle,
} from 'docx';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const VERSION = 'v1.6';
const DATE = '20 May 2026';
const REFINEMENTS = 38;
const OUTPUT_DIR = 'C:/mnt/user-data/outputs';
const OUTPUT_FILE = 'MotorQuoter_Assessment_Engine_v1_6_2026-05-20.docx';

const src = readFileSync('./config/assessmentEngine.js', 'utf8');
const promptMatch = src.match(/`([\s\S]*)`;\s*$/);
const PROMPT = promptMatch ? promptMatch[1].trim() : '';

function h1(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 28, color: '1A1A1A', font: 'Calibri' })],
    spacing: { before: 400, after: 160 },
    border: { bottom: { color: 'F05A1A', size: 6, style: BorderStyle.SINGLE, space: 4 } },
  });
}

function h2(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 22, color: '444444', font: 'Calibri' })],
    spacing: { before: 240, after: 100 },
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, font: 'Calibri', bold: opts.bold, italics: opts.italic })],
    spacing: { before: 60, after: 60 },
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text, size: 20, font: 'Calibri' })],
    spacing: { before: 40, after: 40 },
  });
}

function space() {
  return new Paragraph({ children: [new TextRun('')], spacing: { before: 60, after: 60 } });
}

function parsePromptSections(prompt) {
  const sectionRx = /^(SECTION \d+:[^\n]+)$/gm;
  const positions = [];
  let m;
  while ((m = sectionRx.exec(prompt)) !== null) {
    positions.push({ title: m[1], start: m.index, end: m.index + m[0].length });
  }
  const sections = [];
  for (let i = 0; i < positions.length; i++) {
    const contentStart = positions[i].end;
    const contentEnd = i + 1 < positions.length ? positions[i + 1].start : prompt.length;
    sections.push({ title: positions[i].title, content: prompt.slice(contentStart, contentEnd).trim() });
  }
  return sections;
}

function renderContent(text) {
  const paras = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('- ') || t.startsWith('• ')) {
      paras.push(bullet(t.replace(/^[-•]\s*/, '')));
    } else if (/^\([a-z]\)/.test(t)) {
      paras.push(bullet(t));
    } else if (t === t.toUpperCase() && t.length > 8 && !/^\d/.test(t) && !t.startsWith('SECTION')) {
      paras.push(h2(t));
    } else {
      paras.push(body(t));
    }
  }
  return paras;
}

const promptSections = parsePromptSections(PROMPT);

const refinementLog = [
  { n: 1,  text: 'Initial prompt structure — core rules, output format, Copart intelligence.' },
  { n: 2,  text: 'Added UK offside/nearside convention with steering wheel anchor logic.' },
  { n: 3,  text: 'Added Cat N/S retail value discount rule — 20-25% Cat N, 25-35% Cat S.' },
  { n: 4,  text: 'Added Copart lot designation icons (R, S, Enhanced, Featured, Pure Sale).' },
  { n: 5,  text: 'Added windscreen chalk marking interpretation guide.' },
  { n: 6,  text: 'Added dashboard warning light interpretation guide.' },
  { n: 7,  text: 'Added No Keys + Keyless Entry System flag and WhatsApp inspection caveat.' },
  { n: 8,  text: 'Added Returned Lot Detection — C suffix + old Cat date pattern.' },
  { n: 9,  text: 'Added Cut vs Disconnected Lines — theft forensics guidance.' },
  { n: 10, text: 'Added Donor Vehicle Strategy for powertrain theft scenarios.' },
  { n: 11, text: 'Added Yard Damage vs Accident Damage guidance for vans.' },
  { n: 12, text: 'Added Dual Control Vehicle Detection — ex-driving school flag.' },
  { n: 13, text: 'Added parts pricing tiers — OEM, used/salvage, aftermarket.' },
  { n: 14, text: 'Added Seller Notes / Additional Information filtering rules.' },
  { n: 15, text: 'Added Secondary Damage field caveat — frequently understated.' },
  { n: 16, text: 'Added VAT Flag for commercial vehicles.' },
  { n: 17, text: 'Added Windscreen Sticker Suffix Codes (X, P, C, Q) — vendor type.' },
  { n: 18, text: 'MANDATORY windscreen sticker suffix reporting in every assessment.' },
  { n: 19, text: 'Added WhatsApp Inspection Checklist to required output format.' },
  { n: 20, text: 'Added Three-Tier Recommended Action framework (Option A/B/C).' },
  { n: 21, text: 'Clarified Cat S/N classification unreliability — assess from photos independently.' },
  { n: 22, text: "Added Occam's razor rule — always state mundane explanation first." },
  { n: 23, text: 'Added assessment date currency rule — never reference prior year in valuation.' },
  { n: 24, text: 'Copart descriptions warning — written by yard staff, not mechanics.' },
  { n: 25, text: 'Do not weight Copart damage descriptions heavily.' },
  { n: 26, text: 'When VAT on Sale = Yes, treat as confirmed and calculate explicitly.' },
  { n: 27, text: 'When Category present in structured data, treat as confirmed — no chalk annotation override.' },
  { n: 28, text: 'Bidder Note field — one sentence risk summary.' },
  { n: 29, text: 'Copart R&D designation is arrival-only — no collection guarantee.' },
  { n: 30, text: 'Additional Information (A) field — always check, most useful detail.' },
  { n: 31, text: 'Complete powertrain extraction guidance — matched set difficulty.' },
  { n: 32, text: 'Date reset to 1 Jan flag — battery disconnected, fault codes cleared.' },
  { n: 33, text: 'Main dealer labour rate correction — £100-£150/hr.' },
  { n: 34, text: 'Boot screen only note — does not confirm engine starts.' },
  { n: 35, text: 'Dual controls — Occam\'s razor on premium/EV vehicles. On Porsche, BMW, Mercedes, Audi, Tesla etc., "dual controls" = dual-zone climate. Only flag ex-driving school if (a) mainstream learner model AND (b) explicit instructor branding/pedal reference. Source: CO08CEO Porsche Taycan, 20 May 2026.' },
  { n: 36, text: 'When salvage auction history is present in context, reference it explicitly. Cross-reference prior damage vs current — flag match as possible inadequate prior repair. Note mileage delta. If no prior history, state as positive signal in Bidder Note. Source: Session 20 May 2026.' },
  { n: 37, text: 'Offside/nearside must be derived from visual evidence in photos, never from Copart damage description text. Copart damage descriptions do not specify which side. Model was defaulting to description text rather than photo evidence. Fix: mandatory steering wheel location step before any side reference. If steering wheel not visible in photos, state "side not confirmed from photos" — do not guess. Source: Session 20 May 2026.' },
  { n: 38, text: 'Cat S vs Cat N classification is unreliable and inconsistent across insurers. Do not emphasise category in Red Flags beyond a single mention. Many insurers apply Cat S conservatively to any structural panel involvement even where deformation is minimal. Equally, severely damaged vehicles sometimes receive Cat N. Always assess structural risk independently from photo evidence. The category is indicative only — never lead with it as a primary risk factor. Source: Session 20 May 2026.' },
];

const children = [
  // Cover
  new Paragraph({
    children: [new TextRun({ text: 'MOTORQUOTER', bold: true, size: 64, color: 'F05A1A', font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 1200, after: 240 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Assessment Engine', size: 44, font: 'Calibri', color: '333333' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
  }),
  new Paragraph({
    children: [new TextRun({ text: `${VERSION} — ${REFINEMENTS} refinements — compiled ${DATE}`, size: 24, font: 'Calibri', color: '888888', italics: true })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 1200 },
  }),

  // Prompt sections
  ...promptSections.flatMap(sec => [
    h1(sec.title),
    ...renderContent(sec.content),
    space(),
  ]),

  // Refinement log
  h1('SECTION 7: PROMPT REFINEMENT LOG'),
  body(`${REFINEMENTS} refinements as of ${DATE}`, { italic: true }),
  space(),
  ...refinementLog.map(r =>
    new Paragraph({
      children: [
        new TextRun({ text: `#${String(r.n).padStart(2, '0')}  `, bold: true, size: 20, font: 'Calibri', color: 'F05A1A' }),
        new TextRun({ text: r.text, size: 20, font: 'Calibri' }),
      ],
      spacing: { before: 60, after: 60 },
    })
  ),
];

const doc = new Document({
  creator: 'MotorQuoter',
  title: `MotorQuoter Assessment Engine ${VERSION}`,
  sections: [{ properties: {}, children }],
});

mkdirSync(OUTPUT_DIR, { recursive: true });
const outputPath = path.join(OUTPUT_DIR, OUTPUT_FILE);
const buffer = await Packer.toBuffer(doc);
writeFileSync(outputPath, buffer);

// Also copy to Documents
const docsPath = 'C:/Users/vincy/Documents/' + OUTPUT_FILE;
writeFileSync(docsPath, buffer);

console.log(`Written: ${outputPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
console.log(`Copied:  ${docsPath}`);
