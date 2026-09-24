// lib/pdfText.mjs — ONE OWNER of what a character becomes in the salvage PDF (batch 189 P1, Vincent 24 Sep).
// The PDF uses jsPDF's built-in Helvetica, which is WinAnsi (Windows-1252). jsPDF maps every Windows-1252 character
// itself (£ é × ’ “ ” … € — – • all print correctly). ANY other character makes jsPDF write the whole string as UTF-16,
// which prints as junk ("Find on eBay →" printed "Find on eBay !'"). The old str() deleted every character above
// U+00FF instead — so "≈ £2774" printed "  £2774", "−40°C" printed "40°C", and "don’t" printed "dont".
// Rule: a Windows-1252 character passes through; a character in PDF_CHAR_MAP becomes its readable ASCII form; anything
// else is decomposed (NFKD) to its base letters; only if nothing printable is left does it become "?" — never silently
// dropped, never junk. The PDF route applies pdfSafe() to every string it draws (str() and the doc text wrappers).
const CP1252_HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export const isWinAnsi = (ch) => {
  const n = ch.codePointAt(0);
  return n < 0x80 || (n >= 0xA0 && n <= 0xFF) || CP1252_HIGH.includes(ch);
};
// character → printable replacement. Every entry was found in the corpus, the SV24YCN stored row or code-owned
// strings (batch 189 inventory), or is a close sibling a model writes in the same places.
export const PDF_CHAR_MAP = Object.freeze({
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '↑': 'up', '↓': 'down', '↺': '(restore)',
  '≈': 'approx.', '≤': '<=', '≥': '>=', '≠': '!=', '−': '-', '∑': 'sum', 'Σ': 'sum',
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '─': '-', '′': "'", '″': '"',
  '✓': '[OK]', '✔': '[OK]', '✗': 'x', '✘': 'x', '⚠': 'Warning:',
  '️': '', '​': '', '‌': '', '‍': '', '⁠': '', '﻿': '',   // invisible: variation selector, zero-width
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
});
export function pdfSafe(v) {
  const s = v == null ? '' : String(v);
  let out = '';
  for (const ch of s) {
    if (isWinAnsi(ch)) { out += ch; continue; }
    if (Object.prototype.hasOwnProperty.call(PDF_CHAR_MAP, ch)) { out += PDF_CHAR_MAP[ch]; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += base && [...base].every(isWinAnsi) ? base : '?';
  }
  return out;
}
