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

import { REPAIR_NO_PART_NOTE, STRUCT_FLOOR_NOTE, isNonPartRow } from './labour.mjs';

// batch 117: labour / SRS fitting / allowance rows get no damage card — they are operations, not damage. The
// £500 jig FLOOR is the one exception: batch 106 made it a coherent Visible card ("from £500"), so it stays.
const isLabour = gp => isNonPartRow(gp) && !gp?._structFloor;
const money = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const titleSev = s => {
  if (!s) return null;
  const t = String(s).toUpperCase();
  return t === 'SEVERE' ? 'Severe' : t === 'MODERATE' ? 'Moderate' : t === 'MINOR' ? 'Minor' : null;
};
const norm = s => String(s || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

// `limitFlags` defaults to `flaggedParts` and exists because assessment._flaggedParts is a sorted COPY
// taken before the §4 bumper-off note is pushed — so coreObs.flaggedParts (which builds the Related
// cards) never carries it. The caller passes the authoritative final list here for the limit lookup ONLY,
// leaving the Related/Inferred card composition byte-identical.
export function buildDamageCards({ gatedParts = [], costedParts = [], flaggedParts = [], allowanceParts = [], limitFlags = null } = {}) {
  // Verdict lookup by panelId → severity + iv (first match wins).
  const verdictByPanel = new Map();
  for (const cp of costedParts) {
    if (cp?.panelId != null && !verdictByPanel.has(cp.panelId)) verdictByPanel.set(cp.panelId, cp);
  }
  const sevOf = cp => cp ? (cp._ledgerSeverity || (cp._severeOverride ? 'SEVERE' : null)) : null;

  // batch 107: a panel carrying the §4 bumper-off LIMIT note is costed on the visible evidence but its
  // face cannot be confirmed behind a torn bumper. The Damage Breakdown must carry that limit too —
  // otherwise this surface shows a bare "Severe · replace · £175" in the certain voice while the
  // Inspection Flags say the opposite, which is the same self-contradiction batch 106 fixed on the
  // structural line. Single source: the flag's own reason, never a second wording.
  const bumperLimitReason = new Map();
  for (const f of (limitFlags || flaggedParts)) {
    if (f?._bumperOffLimit && f.panelId != null && !bumperLimitReason.has(f.panelId)) {
      bumperLimitReason.set(f.panelId, f.reason || null);
    }
  }
  // batch 111 task 3: an unconfirmed full-width lamp pair is costed with a strike-the-line limit note.
  // Looked up by marker, not panelId — the inserted half of the pair carries no panelId. Same single-source
  // rule as the bumper note: the flag's own reason.
  const lampPairLimitReason = (limitFlags || flaggedParts).find(f => f?._lampPairLimit)?.reason || null;
  // batch 112 task 1: the banded surplus lamp on a lampCount 1 lot — same single-source rule.
  const lampSurplusLimitReason = (limitFlags || flaggedParts).find(f => f?._lampSurplusLimit)?.reason || null;

  const cards = [];
  const visibleNames = new Set();

  // ── Visible — the costed money rows (skip labour/paint) ──────────────────────
  for (const gp of gatedParts) {
    if (isLabour(gp)) continue;
    const cp = gp?.panelId != null ? verdictByPanel.get(gp.panelId) : null;
    const missing = gp?._amalgMissing || gp?._inserted;
    const lampPrecaution = gp?._lampMandated && !(cp && cp.independentlyVisible === true);
    // batch 106: the £500 jig FLOOR is costed (in the repair total) but not scopeable — the card must
    // say the floor is INCLUDED, never repeat the old "not included" (which contradicts the Parts
    // Breakdown line). Rendered "from £500" (the _structFloor marker travels to the render).
    const bumperLimit = gp?.panelId != null ? bumperLimitReason.get(gp.panelId) : null;
    // batch 109C (Vincent, 10 Sep): on a full-width front hit BOTH headlamps are costed and IN the
    // repair total. Its rows are marked _lampPair. This branch sits ABOVE `missing` deliberately —
    // the inserted half of the pair carries _inserted, which would otherwise print "Not present in
    // the listing photos", a claim about a photograph that was never made. The pair is inferred from
    // the impact span, not from a lamp being absent from a frame.
    const note = bumperLimit
      ? bumperLimit
      : gp?._repairNoPart
        ? REPAIR_NO_PART_NOTE   // batch 116: repaired, no part — cost is in panel work
      : gp?._structFloor
      ? STRUCT_FLOOR_NOTE   // batch 117 task 6: single owner (lib/labour.mjs) — floor + stated ceiling
      : gp?._lampPairUnconfirmed && lampPairLimitReason
        ? lampPairLimitReason
      : gp?._lampSurplus && lampSurplusLimitReason
        ? lampSurplusLimitReason
      : gp?._lampPair
        ? `Full-width frontal impact — both headlamps are costed at £${gp?.used ?? gp?._band} each and included in the repair total; confirm serviceability on inspection.`
      : missing
        ? 'Not present in the listing photos — replacement costed.'
        : lampPrecaution
          ? 'Precautionary lamp allowance — serviceability unconfirmed; confirm on inspection.'
          : null;
    cards.push({
      part: gp?.name ?? null,
      // batch 106 fix: carry the LEDGER identity onto the card. The rowKey stamper keys off
      // panelId (falling back to a name: slug); without this the card derived `name:front-bumper`
      // while the ledger row derived `FRONT_BUMPER`, so every card stamped _rowKey:null and the
      // Damage Breakdown was never edit-aware. Visible cards only — Related/Inferred cards are £0
      // flags with no ledger row to strike, so they correctly stay unkeyed.
      panelId: gp?.panelId ?? null,
      origin: 'Visible',
      damageType: null,
      severity: gp?._structFloor ? null : titleSev(sevOf(cp)),
      action: gp?._structFloor ? 'jig/geometry' : (gp?.action || 'replace'),
      cost: money(gp?.used ?? gp?.oem ?? null),
      note,
      ...(gp?._structFloor ? { _structFloor: true } : {}),
      ...(gp?._srsFloor ? { _fromFigure: true } : {}),   // batch 130: the flat £500 SRS floor renders "from £500" (spec §10)
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
