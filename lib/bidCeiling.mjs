// Rebuild (Repair & resell) bid-ceiling hammer — the most you can bid, rebuild, and still exit at
// the after-repair value with zero margin. Derived from the margin ladder (_marginScenarios).
//
// Why this is SEPARATE from route.js `breakEvenHammer`: that function is the input to the
// SalvageGuide divergence cross-check, where returning null outside the sampled ladder is a
// DELIBERATE fail-safe ("never a false alarm"). We must not change that. But for the investment
// block's rebuild ceiling, a null on the HEALTHIEST lots — where every sampled margin is still
// positive and the true break-even sits just above the ladder top — is wrong: the strongest
// repairable Cat S lots then show no headline rebuild number. This function fixes only that case.
//
// Behaviour:
//   • In-range zero-crossing → identical result to breakEvenHammer (linear interpolation).
//   • Every sampled margin POSITIVE (break-even above the ladder top) → linearly EXTRAPOLATE the
//     zero-crossing from the last two points. Only when margin is descending (rising cost).
//   • Any margin already negative but no crossing found, or all-negative → null (repair not
//     viable at a shown hammer → correctly no rebuild ceiling).

function pts(scenarios) {
  return Array.isArray(scenarios)
    ? scenarios.filter(s => Number.isFinite(Number(s?.hammer)) && Number.isFinite(Number(s?.margin)))
        .map(s => ({ hammer: Number(s.hammer), margin: Number(s.margin) }))
    : [];
}

// In-range crossing — MUST match route.js breakEvenHammer exactly (kept in sync deliberately).
function inRangeBreakEven(p) {
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if ((a.margin >= 0 && b.margin < 0) || (a.margin < 0 && b.margin >= 0)) {
      const t = a.margin / (a.margin - b.margin);
      return Math.round(a.hammer + t * (b.hammer - a.hammer));
    }
  }
  return null;
}

export function rebuildCeilingHammer(scenarios) {
  const p = pts(scenarios);
  if (p.length < 2) return null;

  const inRange = inRangeBreakEven(p);
  if (inRange != null) return inRange;

  // No in-range crossing. Extrapolate ONLY when the ladder top is still positive and margin is
  // descending — i.e. the break-even sits above the shown range. (All-negative or ascending → null.)
  const a = p[p.length - 2], b = p[p.length - 1];
  if (b.margin > 0 && b.margin < a.margin && b.hammer > a.hammer) {
    const slope = (b.margin - a.margin) / (b.hammer - a.hammer); // < 0
    const be = b.hammer - b.margin / slope;                       // hammer where margin == 0
    if (Number.isFinite(be) && be > b.hammer) return Math.round(be);
  }
  return null;
}
