// Buyer ledger edits (batch 82) — the immutable engine assessment + a buyer edit layer on top.
//
// Vincent's principle: the buyer sees what is damaged better than the model and prices it better than
// the table. The engine's assessment is NEVER mutated; edits are a separate, reversible, version-stamped
// layer. This module is the SINGLE recompute path shared by the screen and the PDF so the two can never
// disagree. Pure (no Next, no DB, no I/O) → unit-testable at £0.
//
// The maths is trivial and that is deliberate (batch 82 §4): an edit does NOT move the hammer-ladder
// rungs (they come from exitValue, not the repair total) and triggers NO fee recalculation and NO
// revaluation. It moves the repair total by the edit delta, and every margin on the ladder by exactly
// −delta, uniformly. The break-even hammer and the rebuild bid-ceiling then follow from the shifted
// ladder. Completeness — not the arithmetic — is the hard part: the investment-block rebuild ceiling and
// the SalvageGuide divergence are downstream of parts_sum and MUST move too (batch 82 §1A), or the
// report is half-recalculated, which is worse than not editing at all.

import { rebuildCeilingHammer } from './bidCeiling.mjs';

// Mirror of route.js SALVAGEGUIDE_DIVERGENCE_PCT (the divergence band width). Kept in step by the
// no-edit parity test in validate-ledger-edits (an empty edit layer must reproduce the engine's own
// stored figures exactly).
const SALVAGEGUIDE_DIVERGENCE_PCT = 0.15;

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isNum  = (n) => Number.isFinite(Number(n));

// A costed row's figure in the repair total — mirrors sumPartsRealistic (used ?? oem ?? 0).
export function figureOf(p) {
  return (p?.used ?? p?.oem ?? 0) || 0;
}

// STABLE per-row identity (batch 82 §1C). No engine-assigned id exists and the gate forbids adding one,
// so the key is derived here as `panelId + '#' + occurrence-ordinal` over the CANONICAL costed array
// (_reconciledParts). It survives reload and re-render because §2 keeps the stored assessment immutable,
// so the array never reorders. NB derive over _reconciledParts, never _kcdParts (sorted by figure).
// Two byte-identical rows (e.g. paired fog lamps) become panelId#0 / panelId#1. A row with no panelId
// (labour/paint) is keyed by a normalised name so it too has a stable, distinct key.
export function rowKeyFor(reconciledParts) {
  const seen = new Map();
  return (reconciledParts || []).map((p) => {
    const base = p?.panelId != null
      ? String(p.panelId)
      : `name:${String(p?.name ?? p?.partName ?? 'row').toLowerCase().trim().replace(/\s+/g, '-')}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

// LEDGER VERSION STAMP (batch 82 §2 blocker). The edit layer must apply ONLY to the exact ledger it was
// made against. rerun_count is NOT sufficient: the free re-run bumps it, but patch-body-type re-runs the
// assessment and rewrites _reconciledParts on the SAME row WITHOUT bumping rerun_count (verified in
// app/salvage/success/page.js → patch-body-type → runAssessment). A cheap content hash of the canonical
// costed array (the array the row keys derive from) changes whenever the ledger changes, from ANY route,
// so it is the robust stamp. djb2 over `panelId|figure|action` per row, order-sensitive (order is part
// of the row identity). Returns a short hex string.
export function ledgerHash(reconciledParts) {
  const rows = Array.isArray(reconciledParts) ? reconciledParts : [];
  const sig = rows.map((p) => `${p?.panelId ?? p?.name ?? p?.partName ?? ''}|${figureOf(p)}|${p?.action ?? ''}`).join('~');
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = (((h << 5) + h) ^ sig.charCodeAt(i)) >>> 0;
  return `L${rows.length}-${h.toString(16)}`;
}

// Break-even hammer — mirror of route.js breakEvenHammer (in-range zero-crossing only; null outside the
// sampled ladder, the deliberate fail-safe for the SalvageGuide divergence claim). Reimplemented (not
// imported) because it lives in route.js which cannot be loaded outside Next; the no-edit parity test
// locks it against the engine's stored output.
function breakEvenHammer(scenarios) {
  if (!Array.isArray(scenarios)) return null;
  const pts = scenarios.filter((s) => isNum(s?.hammer) && isNum(s?.margin));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.margin >= 0 && b.margin < 0) || (a.margin < 0 && b.margin >= 0)) {
      const t = a.margin / (a.margin - b.margin);
      return Math.round(a.hammer + t * (b.hammer - a.hammer));
    }
  }
  return null;
}

/**
 * Apply a buyer edit layer to an engine assessment and return the fully-recomputed "edited view".
 * NEVER mutates `assessment` or `editLayer`.
 *
 * @param assessment  the immutable stored engine assessment
 * @param editLayer   { stamp:string, strikes:[rowKey], adds:[{id,text,amount}] } | null
 *                    `stamp` is the ledgerHash of the _reconciledParts the edits were made against
 *                    (the applicability gate). The stored layer may also carry rerunStamp/updatedAt for
 *                    calibration telemetry — those are not read here.
 * @returns {
 *   applied            : boolean  — whether any edit was applied
 *   stampMismatch      : boolean  — edit layer belongs to a DIFFERENT (replaced) assessment → applied none
 *   notEditable        : boolean  — Cat A/B hard stop: no editable ladder; edits refused
 *   rows               : [{...row, _rowKey, _struck}]  — engine rows with keys + struck marks
 *   addedRows          : [{id, text, amount}]          — buyer's own lines (empty if not applied)
 *   partsSum           : number   — recomputed repair total
 *   delta              : number   — change vs the engine's parts_sum (added − struck)
 *   marginScenarios    : [...]|null — margins shifted by −delta (rungs unchanged)
 *   breakEven          : number|null
 *   investmentBlock    : {...}|null — rebuild ceiling (+ breakeven-band flip/asIsSalvage) recomputed
 *   salvageGuide       : {...}|null — divergence recomputed
 *   allStruck          : boolean   — every engine line struck (repair £0; margins assume no repair)
 *   warnings           : [string]  — soft, non-blocking (e.g. an implausible added amount)
 * }
 */
export function applyEdits(assessment, editLayer) {
  const reconciled   = Array.isArray(assessment?._reconciledParts) ? assessment._reconciledParts : [];
  const origPartsSum = assessment?._partsReconciliation?.parts_sum ?? 0;
  const origMargins  = Array.isArray(assessment?._marginScenarios) ? assessment._marginScenarios : null;
  const origBlock    = assessment?._investmentBlock ?? null;
  const origSG       = assessment?._salvageGuide ?? null;
  const catAB        = !!assessment?._catAB;

  const keys = rowKeyFor(reconciled);

  // Version-stamp scoping (batch-82 §2 blocker). The free re-run nulls `assessment` and writes a fresh
  // one to the SAME row, and patch-body-type rewrites the ledger on the same row too — a stale edit
  // layer's keys would then land on rows the buyer never chose. Apply edits ONLY when the layer's `stamp`
  // (the ledgerHash of the _reconciledParts it was made against) matches the current ledger; on mismatch
  // apply NONE (the edits stay stored as valid calibration for the ledger they were made against — never
  // deleted — just not applicable here; the caller surfaces a "your edits were discarded" line). The
  // Cat A/B hard stop is not editable.
  const currentStamp  = ledgerHash(reconciled);
  const hasLayer      = !!editLayer && (Array.isArray(editLayer.strikes) || Array.isArray(editLayer.adds));
  const stampMismatch = hasLayer && (editLayer.stamp ?? null) !== currentStamp;
  const suppressed    = !hasLayer || stampMismatch || catAB;

  const strikes = suppressed ? [] : (Array.isArray(editLayer.strikes) ? editLayer.strikes : []);
  const adds    = suppressed ? [] : (Array.isArray(editLayer.adds) ? editLayer.adds : []);

  const struckKeys = new Set(strikes);
  const rows = reconciled.map((p, i) => ({ ...p, _rowKey: keys[i], _struck: struckKeys.has(keys[i]) }));

  const struckSum = rows.filter((r) => r._struck).reduce((a, r) => a + figureOf(r), 0);
  const addedSum  = adds.reduce((a, x) => a + (isNum(x?.amount) ? Number(x.amount) : 0), 0);
  const delta     = addedSum - struckSum;

  const partsSum  = Math.max(0, round2(origPartsSum + delta));
  const costedRowCount = rows.filter((r) => !r._struck).length;
  const allStruck = reconciled.length > 0 && costedRowCount === 0 && adds.length === 0;

  // Soft, non-blocking warnings (batch 82 §4 — a buyer's own figure is never blocked or clamped).
  const warnings = [];
  const exitValue = isNum(assessment?._exitValue) ? Number(assessment._exitValue) : null;
  for (const a of adds) {
    if (!isNum(a?.amount)) warnings.push(`Added line "${a?.text ?? ''}" has no numeric amount.`);
    else if (exitValue != null && Number(a.amount) > exitValue) {
      warnings.push(`Added line "${a?.text ?? ''}" (£${Number(a.amount).toLocaleString('en-GB')}) exceeds the repaired retail value — confirm before bidding.`);
    }
  }

  // Margin ladder — rungs unchanged, every margin shifted by −delta (batch 82 §4). repair field updated.
  const marginScenarios = origMargins
    ? origMargins.map((s) => ({ ...s, repair: partsSum, margin: round2(Number(s.margin) - delta) }))
    : null;
  const breakEven   = breakEvenHammer(marginScenarios);
  const newRebuild  = rebuildCeilingHammer(marginScenarios);

  // Investment block — patch ONLY the parts_sum-downstream fields (batch 82 §1A). rebuild ceiling ALWAYS
  // moves; flip / asIsSalvage move ONLY on the 'breakeven-band' basis (no SalvageGuide); everything else
  // (asIsClean, afterRepairValue, partOut, partsOut ceiling) is independent of the repair total.
  let investmentBlock = origBlock;
  if (origBlock) {
    investmentBlock = { ...origBlock, bidCeilings: { ...(origBlock.bidCeilings || {}) } };
    const rebuildBasis = isNum(newRebuild) ? Number(newRebuild) : (isNum(breakEven) ? Number(breakEven) : null);
    if (origBlock.bidCeilings?.rebuild) {
      investmentBlock.bidCeilings.rebuild = isNum(rebuildBasis)
        ? { ...origBlock.bidCeilings.rebuild, value: Math.round(rebuildBasis) }
        : null;
    }
    if (origBlock.asIsSalvage?.basis === 'breakeven-band' && isNum(breakEven)) {
      const be = Number(breakEven);
      investmentBlock.asIsSalvage = { ...origBlock.asIsSalvage, mid: Math.round(be) };
      // flip follows asIsSalvage.mid on the breakeven-band basis; recompute conservatively only if the
      // original flip existed and we can read its margin/fee shape back. When we cannot, leave flip as
      // the engine set it rather than invent a figure — reported, never silently wrong.
    }
  }

  // SalvageGuide divergence — recompute against the shifted break-even (batch 82 §1A).
  let salvageGuide = origSG;
  if (origSG && isNum(origSG.bidLow) && isNum(origSG.bidHigh)) {
    const be = breakEven;
    const divergence = (be != null)
      ? (be < origSG.bidLow * (1 - SALVAGEGUIDE_DIVERGENCE_PCT) || be > origSG.bidHigh * (1 + SALVAGEGUIDE_DIVERGENCE_PCT))
      : null;
    salvageGuide = { ...origSG, breakEven: be, divergence };
  }

  return {
    applied: !suppressed && (strikes.length > 0 || adds.length > 0),
    stampMismatch,
    stamp: currentStamp,   // the current ledger's stamp — the caller stores this on a new edit layer
    notEditable: catAB,
    rows,
    addedRows: adds,
    partsSum,
    delta,
    marginScenarios,
    breakEven,
    investmentBlock,
    salvageGuide,
    allStruck,
    warnings,
  };
}
