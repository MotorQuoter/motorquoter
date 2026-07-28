// Single source of truth for the Recommended Action tier COPY (labels + prose parsing),
// shared by the web report (app/salvage/success/page.js) and the PDF (app/api/salvage/pdf/route.js)
// so the plain-English label is identical on both surfaces. Colours legitimately differ between
// screen and print, so each render site keeps its own actionColor map — this module is copy only.
//
// The engine (config/assessmentEngine.js) emits "Option A/B/C — …" prose; the tiers are:
//   A — High Confidence, Straightforward Damage
//   B — Significant Unknowns Present
//   C — Too Many Unknowns, High Risk
export const ACTION_TIER_LABEL = {
  a: 'High Confidence — Straightforward Damage',
  b: 'Significant Unknowns Present',
  c: 'High Risk — Too Many Unknowns',
};

// Display-only. Returns { letter, label, body }; body = the prose with a leading "Option X —/:/."
// stripped so the tier isn't stated twice. Never mutates the stored value; when no option letter
// is present, letter/label are null and body is the raw prose (render falls back to neutral text).
export function parseAction(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^option\s+([abc])\b[\s—:.\-]*/i);
  if (!m) return { letter: null, label: null, body: s };
  const letter = m[1].toLowerCase();
  return { letter, label: ACTION_TIER_LABEL[letter], body: s.slice(m[0].length).trim() };
}
