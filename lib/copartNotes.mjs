// batch 202 — the auction's notes about the vehicle, shown to the buyer AS WRITTEN (Vincent, 1 Oct 2026).
//
// ONE owner. The notes come from ONE of two places, never merged:
//   'box'   — the optional "Additional notes" box on the input form (vd.copartNotes), any auction source. It wins
//             whenever it holds anything after trimming.
//   'paste' — Copart lots only, box empty: the upper-case lines below the VAT line of the pasted Copart page.
//             Copart's notes land wherever the page copy drops them (after "View Notes", before it, after "Reports
//             and services" — batch 200), so position is not used: page text is mixed case and the notes are not.
//   'none'  — neither.
// Computed ONCE at assessment time and stamped (assessment._copartNotes); screen and PDF read the stamp. A stored
// report without the stamp shows no notes (ruled: old reports are not back-filled).
// The notes never reach a model prompt and never move money. Two code-owned lines (pyro fuses, stolen-recovered)
// go into Red Flags and the checklist.
import { belowVatLine } from './normaliseLot.js';

// Copart page text that gets glued onto the front of the first note (batch 198 §1, batch 201 §6).
const GLUED_PREFIXES = ['Additional information:', 'View Notes', 'Reports and services', 'Vehicle report',
  'Virtual vehicle viewing', 'Book viewing', 'dditional Information'];

// A lot is Copart unless the form said otherwise — the same default the normaliser and the route use
// (lib/normaliseLot.js `rawVd.auctionSource || 'copart'`, assess/route.js `enrichedVd.auctionSource || 'copart'`).
export const isCopartSource = (auctionSource) => (auctionSource || 'copart') === 'copart';

// The box text, line by line: trimmed, empty lines dropped, otherwise exactly as the buyer typed or pasted it.
export function boxLines(text) {
  return String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// The Copart fallback: every line below the VAT line, glued page text stripped from its front, kept only when it has a
// capital letter and no lower-case letter. Verbatim, in Copart's order (a cut-off capture stays cut off).
export function copartPasteNoteLines(rawCopartPaste) {
  const out = [];
  for (const raw of belowVatLine(rawCopartPaste || '').split(/\r?\n/)) {
    let l = raw.trim(), prev;
    do { prev = l; for (const p of GLUED_PREFIXES) if (l.startsWith(p)) l = l.slice(p.length).trim(); } while (l !== prev);
    if (l && /[A-Z]/.test(l) && !/[a-z]/.test(l)) out.push(l);
  }
  return out;
}

// { source, lines } for a vehicle-details object.
export function copartNotes(vd) {
  const box = boxLines(vd?.copartNotes);
  if (box.length) return { source: 'box', lines: box };
  if (isCopartSource(vd?.auctionSource)) {
    const paste = copartPasteNoteLines(vd?.rawCopartPaste);
    if (paste.length) return { source: 'paste', lines: paste };
  }
  return { source: 'none', lines: [] };
}

// ── The two code-owned lines (batch 200 §B.4 wording, Vincent 1 Oct). Copart lots say "Copart"; other sources say
// "the notes" / "the auction house" (batch 202 §6). Each goes into Red Flags AND the checklist, word for word.
const PYRO = {
  copart: 'Copart declare the high-voltage pyro fuses have been bypassed for inspection. Safety item — the high-voltage system must be checked and reinstated by a qualified EV technician before the car is driven or charged.',
  other:  'The notes say the high-voltage pyro fuses have been bypassed for inspection. Safety item — the high-voltage system must be checked and reinstated by a qualified EV technician before the car is driven or charged.',
};
const STOLEN = {
  copart: 'Copart record this vehicle as stolen and recovered. Before bidding, ask Copart to confirm the registration number (VRM) and chassis number (VIN) are correct for this vehicle. You need both to apply for the V5C, and a replacement VIN plate or sticker can only be made once you are sure of them — buyers have had problems with a wrong VRM or VIN on stolen-recovered cars.',
  other:  'The notes record this vehicle as stolen and recovered. Before bidding, ask the auction house to confirm the registration number (VRM) and chassis number (VIN) are correct for this vehicle. You need both to apply for the V5C, and a replacement VIN plate or sticker can only be made once you are sure of them — buyers have had problems with a wrong VRM or VIN on stolen-recovered cars.',
};
export const CODE_LINE_WORDING = { PYRO, STOLEN };

// Triggers: the phrase anywhere in any line, any case (a buyer typing into the box may not use capitals).
// Pyro first (safety), then stolen-recovered.
export function copartNotesCodeLines(lines, auctionSource) {
  const text = (lines || []).join('\n').toUpperCase();
  const k = isCopartSource(auctionSource) ? 'copart' : 'other';
  const out = [];
  if (text.includes('PYRO FUSE')) out.push(PYRO[k]);
  if (text.includes('STOLEN RECOVERED')) out.push(STOLEN[k]);
  return out;
}

// Keys from the notes ("NUMBER OF KEYS 1", "NUMBER OF KEYS WITH VEHICLE 1", "2ND SET OF KEYS AVAILABLE").
export function keysFromNotes(lines) {
  const text = (lines || []).join('\n').toUpperCase();
  const kc = text.match(/NUMBER OF KEYS(?: WITH VEHICLE)? (\d+)/);
  return { count: kc ? Number(kc[1]) : null, secondSet: text.includes('2ND SET OF KEYS AVAILABLE') };
}

// Vehicle details "Keys" value: the listing's Has key value plus what the notes say about keys.
export function keysDetailText(hasKey, keys) {
  const bits = [];
  if (keys?.count != null) bits.push(`${keys.count} key${keys.count === 1 ? '' : 's'}`);
  if (keys?.secondSet) bits.push('second set available');
  return [hasKey, bits.join(', ')].filter(v => v && String(v).trim()).join(' - ') || null;
}

// Re-run (rerun-submit): the re-run form is not prefilled, so an empty / whitespace-only box KEEPS the stored notes;
// new non-empty text replaces them (Vincent, 1 Oct, ruling (b)).
export function carryForwardNotes(storedNotes, incomingNotes) {
  return String(incomingNotes ?? '').trim() ? incomingNotes : (storedNotes ?? null);
}

// Buyer-facing words around the box — ONE owner, screen and PDF.
export const NOTES_HEADING = 'Notes — as written';
export const NOTES_SOURCE_LINE = { box: 'From the notes you added.', paste: 'From the Copart page you pasted.' };
export const NOTES_NOT_COSTED = 'These notes are not costed unless they appear in the repair breakdown.';

// The assessment-time step. Stamps assessment._copartNotes = { source, lines }; puts the code lines at the top of
// Red Flags (below a Cat A/B stop line, which always stays first) and appends them to the checklist. Never reads or
// writes the ledger. Idempotent: a line already present is not added twice.
export function stampCopartNotes(assessment, vd, { catABStopLine = null } = {}) {
  const notes = copartNotes(vd);
  assessment._copartNotes = notes;
  const codeLines = copartNotesCodeLines(notes.lines, vd?.auctionSource);
  if (codeLines.length) {
    const rf = (assessment['Red Flags'] || '').split('\n').filter(l => l.trim());
    const fresh = codeLines.filter(c => !rf.some(l => l.includes(c))).map(c => `- ${c}`);
    const stopIdx = catABStopLine ? rf.findIndex(l => l.includes(catABStopLine)) : -1;
    assessment['Red Flags'] = (stopIdx >= 0
      ? [...rf.slice(0, stopIdx + 1), ...fresh, ...rf.slice(stopIdx + 1)]
      : [...fresh, ...rf]).join('\n');
    let text = (assessment['WhatsApp Inspection Checklist'] || '').trim();
    let next = (text.match(/^\d+[.)]/mg) || []).length + 1;
    for (const c of codeLines) {
      if (text.includes(c)) continue;
      text += `${text ? '\n' : ''}${next}. ${c}`;
      next++;
    }
    assessment['WhatsApp Inspection Checklist'] = text;
  }
  return { ...notes, codeLines };
}
