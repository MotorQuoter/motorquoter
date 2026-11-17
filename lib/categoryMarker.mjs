// batch 247 B2 ruling 2 (Vincent, 17 Nov) — the code-owned V5 / category marker line in Red Flags.
//
// It replaces the model's old V5-marker sentences, removed from the prompt in B2(i). The model never sees the salvage
// category, so it must never be the voice on it: this line comes from the RECORDED category only (route.js passes
// catLetter(enrichedVd.category)) and the listing's V5 field (enrichedVd.v5Status). One owner: this file.
//
// Shown only for Cat S or N with a known V5 state. Any other category, no category, or a V5 field that does not say plainly
// whether the V5 is there (e.g. "Partial V5 Available", blank) → no line.

const V5_ABSENT_RX  = /^\s*(?:no|none|not\s+(?:available|present|supplied)|no\s+v5c?)\s*$/i;
const V5_PRESENT_RX = /^\s*(?:yes|(?:physical\s+)?v5c?\s+(?:available|present)|available|present)\s*$/i;

/** 'present' | 'absent' | null (unknown or partial — no line). */
export function v5State(v5Status) {
  if (!v5Status || typeof v5Status !== 'string') return null;
  if (V5_ABSENT_RX.test(v5Status)) return 'absent';
  if (V5_PRESENT_RX.test(v5Status)) return 'present';
  return null;
}

/**
 * @param catLetterLower  catLetter(enrichedVd.category) — 's' | 'n' | other | null
 * @param v5Status        enrichedVd.v5Status
 * @returns the Red Flags line (no bullet), or null
 */
export function categoryMarkerLine(catLetterLower, v5Status) {
  const cat = String(catLetterLower || '').toUpperCase();
  if (cat !== 'S' && cat !== 'N') return null;
  const v5 = v5State(v5Status);
  if (v5 === 'absent') return `No V5 is present, so the buyer must apply to DVLA for one. This car is recorded as Category ${cat}, and the new V5 will carry that marker permanently; it also shows on future history checks.`;
  if (v5 === 'present') return `This car is recorded as Category ${cat}. The V5 carries that marker permanently and it shows on future history checks.`;
  return null;
}
