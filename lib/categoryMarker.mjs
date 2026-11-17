// batch 247 B2 ruling 2 (Vincent, 17 Nov) — the code-owned V5 / category marker line in Red Flags.
//
// It replaces the model's old V5-marker sentences, removed from the prompt in B2(i). The model never sees the salvage
// category, so it must never be the voice on it: this line comes from the RECORDED category only (route.js passes
// catLetter(enrichedVd.category)) and the listing's V5 field (enrichedVd.v5Status). One owner: this file.
//
// The matrix (batch 247 B2 ruling 2 + B3 rulings 2-3):
//                     V5 absent                         V5 present            partial / blank / unrecognised
//   Cat S or N        no-V5 + category marker            category marker       category half only
//   other / none      "No V5 is present, … for one."     no line               no line

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
  const v5 = v5State(v5Status);
  if (cat !== 'S' && cat !== 'N') {
    // batch 247 B3 ruling 2: the model no longer speaks on the V5, so the no-V5 fact must not be lost on a lot that is not S/N
    // (stolen/recovered, Cat U, blank). V5 present, partial or unknown on such a lot: no line.
    return v5 === 'absent' ? NO_V5_LINE : null;
  }
  if (v5 === 'absent') return `${NO_V5_LINE} This car is recorded as Category ${cat}, and the new V5 will carry that marker permanently; it also shows on future history checks.`;
  if (v5 === 'present') return `This car is recorded as Category ${cat}. The V5 carries that marker permanently and it shows on future history checks.`;
  // batch 247 B3 ruling 3: a partial ("Partial V5 Available") or blank / unrecognised V5 field — the category half only; the
  // line never claims the V5 is there or not.
  return `This car is recorded as Category ${cat}. That marker is permanent and shows on future history checks.`;
}

const NO_V5_LINE = 'No V5 is present, so the buyer must apply to DVLA for one.';
