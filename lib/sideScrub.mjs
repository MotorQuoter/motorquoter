// Part-name side-word scrub (Option A, 10 Jul 2026).
//
// OWNERSHIP SPLIT OF RECORD — two tools, one owner per token class, NEVER overlapping:
//   • sanitizeSideTerms (lib/sanitizeProse.js, "Item 15")
//       scope:     PROSE-WIDE (every buyer-facing field + _raw), at one chokepoint
//                  (route.js: sanitizeSideTerms(rawText) before parseAssessment).
//       tokens:    COMPOUND side-terms — offside / nearside / driver's-side /
//                  passenger's-side / left-hand-side / right-hand-side (+ variants).
//       semantics: SUBSTITUTION (offside → "damaged-side", nearside → "opposite-side"),
//                  preserving RHD/LHD vehicle spec intact.
//   • scrubSideWords (THIS FILE)
//       scope:     PART-NAME CELLS ONLY (the display name rendered in the parts table).
//       tokens:    the RESIDUAL Item 15 does not own — bare "left" / "right" and the
//                  abbreviations "n/s" / "o/s". nearside/offside are DELIBERATELY absent:
//                  Item 15 has already substituted them upstream, so they never reach here.
//       semantics: REMOVAL (bare tokens stripped; artifacts tidied). Removal is safe on a
//                  short structured part-name cell but NOT on free prose — which is exactly
//                  why bare left/right live here and not in the prose layer.
//
// This is the BACKSTOP behind the prompt ban (route.js prompt: "Do NOT use the words
// offside/nearside/left/right"). Never the first line of defence.
//
// Pure + side-effect-free: callers own the [SIDE SCRUB] log and the _sideScrubbed stamp.
// Identity/costing NEVER call this — the scrub is display-only, applied to the
// `?? rawName` fallback leg (non-panel rows) which never reach a normName/enum/dedup
// comparison that changes row survival or money (see route.js parseParts + parts.mjs gate).

// Residual token set only — bare left/right + n/s/o/s. Word-boundary, case-insensitive.
// Must not touch words merely CONTAINING a token (cleft, bright, leftover, upright).
const SIDE_RX = /\b(?:n\/s|o\/s|left|right)\b/gi;

/**
 * Strip residual side vocabulary from a single part-name cell.
 * @param {string|null|undefined} name
 * @returns {{ name: string, original: string, changed: boolean, guarded: boolean }}
 *   name    — scrubbed cell (or original when guarded / unchanged)
 *   changed — true only when the rendered cell differs from the original
 *   guarded — true when the cell was ONLY a side token: original is kept, never blank
 */
export function scrubSideWords(name) {
  if (!name || typeof name !== 'string') {
    return { name, original: name, changed: false, guarded: false };
  }
  const original = name;
  let s = name.replace(SIDE_RX, '');
  s = s
    .replace(/\(\s*[,;\s]*\)/g, '')       // empty / emptied parens: "(offside)" -> "()" -> ""
    .replace(/-+(?=[\s,;)]|$)/g, '')       // trailing dangling hyphen: "Front-" -> "Front"
    .replace(/(?<=[\s(])-+/g, '')          // leading dangling hyphen:  "(-, x)" -> "(, x)"
    .replace(/\(\s*[,;]\s*/g, '(')         // "( , " -> "("
    .replace(/[,;]\s*\)/g, ')')            // ", )" -> ")"
    .replace(/[,;]\s*[,;]/g, ',')          // double separators
    .replace(/\s+([,;)])/g, '$1')          // space before punctuation
    .replace(/\s{2,}/g, ' ')               // collapse double spaces
    .replace(/^[\s,;-]+|[\s,;-]+$/g, '')   // strip leading/trailing separators
    .trim();
  // Only-a-side-word guard: never emit a blank cell — keep the original, caller logs loud.
  if (!s || !/[a-z0-9]/i.test(s)) {
    return { name: original, original, changed: false, guarded: true };
  }
  return { name: s, original, changed: s !== original, guarded: false };
}
