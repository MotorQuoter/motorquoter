// Per-part damage cards (AEP-style) for the salvage report.
//
// PURE assembler — packages the FINAL reconciled parts pipeline into a per-part list
// for the report + PDF. It READS the finalised arrays; it never recomputes costs, never
// touches parts_sum / the reconciliation / _marginScenarios / _investmentBlock.
//
// Origin taxonomy (verified against the pipeline, per the IAA/investment-block lesson):
//   • Visible  = the costed money rows (gatedParts, i.e. what sums to parts_sum). These are
//                the independently-visible / confirmed-missing repair items — real cost.
//   • Related  = flaggedParts (gate-generated / completeness-net inspection asks) — NOT in
//                the repair total, so carried at £0 until confirmed (existing convention).
//   • Inferred = allowanceParts (code-added band allowances, e.g. the second-corner headlamp)
//                — excluded from the repair total, carried at £0; the band value is noted.
//
// Fields verified: gatedParts rows carry name / action / used|oem / panelId (+ _lampMandated,
// _inserted, _amalgMissing markers). Severity + iv live on costedParts as _ledgerSeverity
// (SEVERE/MODERATE/MINOR, or _severeOverride→SEVERE) and independentlyVisible — joined by
// panelId. There are NO per-part labour hours in the pipeline, so labourHrs is omitted (not
// fabricated). There is no per-part damageType descriptor enum, so damageType is omitted too.

const isLabour = name => /labour|paint|prep/i.test(name || '');
const money = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const titleSev = s => {
  if (!s) return null;
  const t = String(s).toUpperCase();
  return t === 'SEVERE' ? 'Severe' : t === 'MODERATE' ? 'Moderate' : t === 'MINOR' ? 'Minor' : null;
};
const norm = s => String(s || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

export function buildDamageCards({ gatedParts = [], costedParts = [], flaggedParts = [], allowanceParts = [] } = {}) {
  // Verdict lookup by panelId → severity + iv (first match wins).
  const verdictByPanel = new Map();
  for (const cp of costedParts) {
    if (cp?.panelId != null && !verdictByPanel.has(cp.panelId)) verdictByPanel.set(cp.panelId, cp);
  }
  const sevOf = cp => cp ? (cp._ledgerSeverity || (cp._severeOverride ? 'SEVERE' : null)) : null;

  const cards = [];
  const visibleNames = new Set();

  // ── Visible — the costed money rows (skip labour/paint) ──────────────────────
  for (const gp of gatedParts) {
    if (isLabour(gp?.name)) continue;
    if (gp?._structFloor) continue;   // batch 106: the £500 jig floor is inferred, not a visible-damage
                                      // card — it lives in the parts table + inspection flag, never as a complete figure here.
    const cp = gp?.panelId != null ? verdictByPanel.get(gp.panelId) : null;
    const missing = gp?._amalgMissing || gp?._inserted;
    const lampPrecaution = gp?._lampMandated && !(cp && cp.independentlyVisible === true);
    const note = missing
      ? 'Not present in the listing photos — replacement costed.'
      : lampPrecaution
        ? 'Precautionary lamp allowance — serviceability unconfirmed; confirm on inspection.'
        : null;
    cards.push({
      part: gp?.name ?? null,
      origin: 'Visible',
      damageType: null,
      severity: titleSev(sevOf(cp)),
      action: gp?.action || 'replace',
      cost: money(gp?.used ?? gp?.oem ?? null),
      note,
    });
    visibleNames.add(norm(gp?.name));
  }

  // ── Related — gate-generated / completeness-net flags (£0, not in total) ──────
  for (const f of flaggedParts) {
    if (visibleNames.has(norm(f?.partName))) continue; // already shown as a costed row
    cards.push({
      part: f?.partName ?? null,
      origin: 'Related',
      damageType: null,
      severity: null,
      action: 'inspect',
      cost: 0,
      note: f?.reason || 'Possible related damage — not independently confirmed; verify on inspection.',
    });
  }

  // ── Inferred — code-added band allowances (£0 in the card; band value noted) ──
  for (const a of allowanceParts) {
    const band = money(a?.used);
    cards.push({
      part: a?.name ?? null,
      origin: 'Inferred',
      damageType: null,
      severity: null,
      action: a?.action || 'replace',
      cost: 0,
      note: `Band allowance${band != null ? ` £${band.toLocaleString('en-GB')}` : ''} — excluded from repair total until confirmed.`,
    });
  }

  return cards;
}
