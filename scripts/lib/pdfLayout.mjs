// Dev tooling (batch 189): read a jsPDF-built PDF back as positioned text runs, so a validator can check what reaches the
// page — junk strings, line widths against the margin, headings stranded at a page foot, header placement. Not part of
// the app runtime. Assumes jsPDF's uncompressed output (the salvage PDF never enables compression).
import { jsPDF } from 'jspdf';

const PT = 72 / 25.4;
const CP = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
const unesc = (s) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, e) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e] ?? String.fromCharCode(parseInt(e, 8))));
const style = (base) => {
  const b = String(base);
  const st = /BoldOblique|BoldItalic/i.test(b) ? 'bolditalic' : /Bold/i.test(b) ? 'bold' : /Oblique|Italic/i.test(b) ? 'italic' : 'normal';
  return [/Courier/i.test(b) ? 'courier' : /Times/i.test(b) ? 'times' : 'helvetica', st];
};

// → { pages, items: [{ page, x, y (mm from top, baseline), size, style, color, text, w (mm), junk }] }
export function pdfLayout(buf, pageH = 297) {
  const pdf = Buffer.from(buf).toString('latin1');
  const fontObj = {}; const objBase = {};
  for (const m of pdf.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) fontObj[m[1]] = m[2];
  for (const m of pdf.matchAll(/(\d+)\s+0\s+obj\s*<<\s*\/Type\s*\/Font\s*\/BaseFont\s*\/([\w-]+)/g)) objBase[m[1]] = m[2];
  const meas = new jsPDF({ unit: 'mm', format: 'a4' });
  const streams = [...pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => m[1]).filter((s) => /(^|\n)BT\n/.test(s));
  const items = []; let page = 0;
  for (const s of streams) {
    page++;
    let font = null, size = 0, color = '';
    for (const bt of s.matchAll(/(?:^|\n)BT\n([\s\S]*?)\nET(?=\r?\n|$)/g)) {   // ET on its own line (not the "ET" in "MARKET")
      const body = bt[1];
      const f = body.match(/\/(F\d+)\s+([\d.]+)\s+Tf/); if (f) { font = f[1]; size = +f[2]; }
      const col = body.match(/([\d.]+\s+[\d.]+\s+[\d.]+\s+rg|[\d.]+\s+g)/); if (col) color = col[1];
      const td = body.match(/([\d.-]+)\s+([\d.-]+)\s+Td/);
      const tj = body.match(/\(((?:\\.|[^\\)])*)\)\s*Tj/);
      if (!td || !tj) continue;
      const raw = unesc(tj[1]);
      const junk = raw.includes('\0');
      const text = junk ? raw : [...raw].map((ch) => CP[ch.charCodeAt(0)] ?? ch).join('');
      const [fam, st] = style(objBase[fontObj[font]] || font);
      meas.setFont(fam, st); meas.setFontSize(size);
      items.push({ page, x: +td[1] / PT, y: pageH - +td[2] / PT, size, style: st, color, text, w: junk ? NaN : meas.getTextWidth(text), junk });
    }
  }
  return { pages: page, items };
}

// a sectionTitle heading: bold 7.5pt, grey 90/255 (0.353), upper case, at the left margin
export const isSectionHeading = (it, margin = 20) =>
  it.style === 'bold' && Math.abs(it.size - 7.5) < 0.01 && /0\.353/.test(it.color) && it.text === it.text.toUpperCase() && Math.abs(it.x - margin) < 0.1;

// batch 191 P2 — a block LABEL whose body must follow it on the same page: an Inspection Flags badge / part name (bold
// 7pt), a VDS per-panel label (bold 8pt, grey 80/255), any bold 7.5pt upper-case label or table header (block headings,
// slot-group labels, the fee table's column row), and the fee table's title.
export const isBlockLabel = (it) => it.style === 'bold' && (
  Math.abs(it.size - 7) < 0.01
  || (Math.abs(it.size - 8) < 0.01 && /0\.31/.test(it.color))
  || (Math.abs(it.size - 7.5) < 0.01 && it.text === it.text.toUpperCase() && /[A-Z]/.test(it.text))
  || (Math.abs(it.size - 8.5) < 0.01 && /^Copart fees at/.test(it.text)));
// every page but the last whose final printed line is labels only (the body went to the next page)
export function labelsLastOnPage({ pages, items }) {
  const out = [];
  for (let p = 1; p < pages; p++) {
    const on = items.filter((i) => i.page === p);
    if (!on.length) continue;
    const lastY = Math.max(...on.map((i) => i.y));
    const line = on.filter((i) => Math.abs(i.y - lastY) < 0.1);
    if (line.every(isBlockLabel)) out.push({ page: p, y: lastY, text: line.map((i) => i.text).join(' ') });
  }
  return out;
}
