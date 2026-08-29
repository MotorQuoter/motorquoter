// Code-owned labour model (batch 85, Option 1 STRUCTURE — Option-2-ready). Replaces the model-invented
// "Labour & paint" line with a code-computed figure: per surviving panel, labour = hours(action×severity)
// × rate, EXCEPT a panel whose class is normally obtainable FINISHED + colour-matched (a sourceable
// clip/bolt-on), which takes fitting-only hours. This is the whole £950-vs-£250 idea (Vincent): a
// colour-matched used moulding clips on — very little labour.
//
// 🔴 EVERY NUMBER BELOW IS A DRAFT — Cowork/CC proposals, NOT confirmed by Vincent. They MUST NOT ship.
// A labour figure computed from constants nobody in the trade chose is the same defect as one the model
// invented — just wrong more consistently (batch 85 §1). The STRUCTURE ships; the numbers wait for Vincent.
//
// OPTION 2 LANDS ON TOP WITHOUT A REWRITE: `sourceable` is an INPUT (a Set of panelIds), defaulting to the
// curated draft list. Option 2 = populate that Set from a REAL per-lot sourcing/colour-match signal
// (batch 84 B2) and merge part+labour into one "cost to put right" — the function already accepts the
// input and already collapses labour for a sourceable part; only the SOURCE of the flag changes.

// ── DRAFT constants — do NOT ship ────────────────────────────────────────────────────────────────
// (a) hours by action × severity. DRAFT SHAPE: repair > replace (strip/beat/fill/sand/prime/paint vs
//     unbolt/bolt-on/paint) — Vincent flagged this as trade judgement; the ratio here is a placeholder.
export const DRAFT_HOURS = Object.freeze({
  replace: { MINOR: 0.5, MODERATE: 1.5, SEVERE: 3.0 },
  repair:  { MINOR: 1.0, MODERATE: 3.0, SEVERE: 5.0 },
});
// (b) labour rate £/hour. DRAFT: a mid indie-bodyshop ballpark; UNCONFIRMED — Vincent supplies the real one.
export const DRAFT_RATE = 50;
// fitting-only hours for a sourceable finished + colour-matched part (clip/bolt-on, no paint match). DRAFT.
export const DRAFT_SOURCEABLE_FIT_HOURS = 0.5;
// (c) 🎯 the sourceable part-class list — panel classes normally obtainable FINISHED + colour-matched, so
//     labour collapses to fitting-only. DRAFT from the panel enum — this is TRADE KNOWLEDGE, Vincent's to
//     correct. Everything NOT in this set is treated as needing full (paint-match / structural) labour.
export const DRAFT_SOURCEABLE_CLASSES = Object.freeze(new Set([
  'WHEEL_ARCH_MOULDING', 'SIDE_SKIRT', 'DOOR_MIRROR', 'FOG_LAMP', 'HEADLAMP', 'REAR_LAMP', 'GRILLE',
  'WHEEL', 'TYRE', 'WINDSCREEN', 'SIDE_GLASS', 'REAR_GLASS',
]));

const isLabour = (p) => /labour|paint|prep/i.test(p?.name || p?.partName || '');

/**
 * Compute code-owned labour for the surviving costed panels. Pure. REPLACES the model's labour line
 * (never just removes it — dropping it would leave parts_sum parts-only and every margin/ceiling
 * over-optimistic, batch 84 B4.2).
 * @param severityOf (part) → 'MINOR'|'MODERATE'|'SEVERE'
 * @param sourceable Set<panelId> of classes obtainable finished+colour-matched (the Option-2 input)
 * @returns { total, lines:[{panelId, action, severity, sourceable, hours, labour}] }
 */
export function computeCodeLabour({
  parts, severityOf,
  hours = DRAFT_HOURS, rate = DRAFT_RATE,
  sourceable = DRAFT_SOURCEABLE_CLASSES, sourceableFitHours = DRAFT_SOURCEABLE_FIT_HOURS,
} = {}) {
  let total = 0;
  const lines = [];
  for (const p of (Array.isArray(parts) ? parts : []).filter((x) => !isLabour(x))) {
    const severity = (severityOf && severityOf(p)) || 'MODERATE';
    const action = /repair/i.test(p.action || '') ? 'repair' : 'replace';
    const isSourceable = !!(sourceable && p.panelId && sourceable.has(p.panelId));
    const h = isSourceable ? sourceableFitHours : ((hours[action] && hours[action][severity]) ?? hours.replace.MODERATE);
    const labour = Math.round(h * rate);
    total += labour;
    lines.push({ panelId: p.panelId ?? (p.name || p.partName), action, severity, sourceable: isSourceable, hours: h, labour });
  }
  return { total, lines };
}
