// Item 15 — side-term substitution layer.
//
// Enforces the prose-ban on absolute side labels (offside/nearside/driver's-side/
// passenger's-side/left-hand-side/right-hand-side and all spelling variants).
// Runs at a single chokepoint in route.js: after Call-2 finishes (which reads rawText),
// before parseAssessment — so every buyer-facing field and the _raw fallback emerge clean.
//
// Design constraints:
//   • Substitution, not detection: result can never assert a side it cannot verify.
//   • One chokepoint, no per-surface duplication.
//   • Hard exclusion: "right/left-hand drive", "RHD", "LHD" (vehicle spec) survive intact,
//     preserving the original spelling/hyphenation of the matched text exactly.
//   • CORNER_LABELS (Front Left / Front Right etc.) are code-generated and OUT OF SCOPE —
//     the ban's unreliability premise applies to model inference only, not code-certain structure.
//   • DVSA/MOT History is structurally isolated in its own section; no substitution needed there.
//
// Substitution direction:
//   offside / driver's-side / right-hand-side  → "damaged-side"  (UK RHD primary damage side)
//   nearside / passenger's-side / left-hand-side → "opposite-side" (complementary side)
//   These are relative, never absolute — clean-by-construction.

/**
 * Replace banned absolute-side compounds in model-generated prose with
 * side-relative language. Idempotent — safe to call multiple times.
 *
 * @param {string|null|undefined} text
 * @returns {string} sanitized text (same reference if no banned terms found)
 */
export function sanitizeSideTerms(text) {
  if (!text) return text;

  let s = text;

  // ── Step 1: mask vehicle-spec terms that must survive intact ──────────────────
  // Capture each match verbatim so restoration returns the EXACT original form
  // (e.g. "right hand drive" — no hyphen — must come back without a hyphen).
  // Sentinels use index slots to survive further regex passes without collision.
  const captured = [];
  const capture = (match) => {
    const slot = `\x01C${captured.length}\x01`;
    captured.push(match);
    return slot;
  };

  // right/left-hand drive (and no-hyphen / extra-space variants) — vehicle spec
  s = s.replace(/\bright[-\s]?hand[-\s]?drive\b/gi, capture);
  s = s.replace(/\bleft[-\s]?hand[-\s]?drive\b/gi,  capture);
  // Standalone ALL-CAPS abbreviations — rare in prose but guard defensively
  s = s.replace(/\bRHD\b/g, capture);
  s = s.replace(/\bLHD\b/g, capture);

  // ── Step 2: substitute banned compounds (longer/specific first) ───────────────

  // — offside-front / offside front (and off-side variants) —
  s = s.replace(/\boff[-\s]?side[-\s]front\b/gi, 'damaged front');
  s = s.replace(/\boff[-\s]?side[-\s]rear\b/gi,  'damaged rear');

  // — nearside-front / nearside front (and near-side variants) —
  s = s.replace(/\bnear[-\s]?side[-\s]front\b/gi, 'opposite front');
  s = s.replace(/\bnear[-\s]?side[-\s]rear\b/gi,  'opposite rear');

  // — standalone offside / off-side —
  s = s.replace(/\boff[-\s]?side\b/gi, 'damaged-side');

  // — standalone nearside / near-side —
  s = s.replace(/\bnear[-\s]?side\b/gi, 'opposite-side');

  // — driver's side / driver's-side / driver side / driver-side / drivers side —
  // '?s? allows: driver (no s), driver's (apostrophe-s), drivers (s without apostrophe)
  // [-\s] allows space or hyphen before "side"
  s = s.replace(/\bdriver'?s?[-\s]side\b/gi, 'damaged-side');

  // — passenger's side / passenger's-side / passenger side / passenger-side —
  s = s.replace(/\bpassenger'?s?[-\s]side\b/gi, 'opposite-side');

  // — right-hand-side / right hand side (UK RHD = right = offside = primary damage side) —
  s = s.replace(/\bright[-\s]?hand[-\s]side\b/gi, 'damaged-side');

  // — left-hand-side / left hand side (UK RHD = left = nearside = opposite side) —
  s = s.replace(/\bleft[-\s]?hand[-\s]side\b/gi, 'opposite-side');

  // ── Step 3: restore protected vehicle-spec terms verbatim ─────────────────────
  for (let i = 0; i < captured.length; i++) {
    s = s.replace(`\x01C${i}\x01`, captured[i]);
  }

  return s;
}
