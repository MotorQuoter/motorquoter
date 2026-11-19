// batch 252 D1 (Vincent, 19 Nov) — ONE SENTENCE FOR AN UNCOSTED DISPUTED PANEL. A leaf module (no imports), so both
// lib/parts.mjs and lib/labour.mjs can read it without a cycle (parts.mjs already imports labour.mjs).
//
// One state: the photos disagree on the panel (at least one damaged read, at least one clean) and it is not in the repair
// total. It used to be written three ways (batch 251 T3): F1 "Photographs disagree on the X — …" (split vote, A1),
// F2/F2c "The photos disagree on this panel - it is not costed …" (Q4-declined quarter) and F3/F3c "the listing photographs
// disagree on this part — …" (the raw amalgamation flag on panels A1 skips). All three now read the line below.
// Genuinely different states keep their own lines: the aperture panel (behind a displaced bumper), the single-MINOR read
// (batch 182 P3) and the M1 costed-disputed note.
// No dash anywhere: the PDF prints flag reasons without dash mapping (lib/labour.mjs note on the Q4 reason).

// The OTHER fallback name (one owner; lib/parts.mjs re-exports it as OTHER_FALLBACK_NAME — batch 171 P1).
export const UNNAMED_PART_NAME = 'Unidentified part — see photos';

/** true when a part has no name the buyer can use: OTHER with no word of its own, or the bare word "Other". */
export function isUnnamedPart(partName, panelId) {
  const n = String(partName ?? '').trim();
  if (!n || /^other$/i.test(n) || n === UNNAMED_PART_NAME) return true;
  return panelId === 'OTHER' && /^other\b/i.test(n);
}

export function disputedUncostedLine(partName, panelId) {
  if (isUnnamedPart(partName, panelId)) {
    return 'Photos disagree on a part we could not name. It is not in the repair total. Check the damaged area on inspection before bidding.';
  }
  // Mid-sentence the name reads in lower case ("the front wing"), as the batch 183 P3 sentence does; an acronym lead
  // ("SRS airbag") is kept.
  const n = String(partName).trim();
  const name = /^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n;
  return `Photos disagree on the ${name}: some show damage, some do not. It is not in the repair total. Check it on inspection before bidding.`;
}
