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
import { computeLabour, labourDisplayLines } from './labour.mjs';
import { HEADLAMP_BANDS, LAMP_TYPES } from './lampBands.mjs';

// batch 114 — the buyer's lamp-type correction (Vincent, 11 Sep: "Let the photo set the band with the user
// having the option to correct it"). A LOT-level field on the edit layer, not a per-row edit: both headlamps
// of one car share one technology. Closed enum, validated here and in the edits API.
export const isLampType = (t) => typeof t === 'string' && LAMP_TYPES.includes(t);
const fmtGBP = (n) => `£${Number(n).toLocaleString('en-GB')}`;
// The one sentence every surface renders for an applied correction (screen + PDF).
export function lampCorrectionLine(type) {
  return `Headlamp type corrected by the buyer to ${type === 'hid' ? 'HID' : type === 'led' ? 'LED' : type} (${fmtGBP(HEADLAMP_BANDS[type])} per unit).`;
}
// Rows the correction re-priced, keyed by _rowKey → { from, to }. The screen and PDF use it to re-price the
// stored code-assembled surfaces (Key Cost Drivers, Damage Breakdown) whose figures were written at
// assess time, so no surface keeps the engine's figure beside the buyer's corrected one.
export function lampRepricedKeys(edited) {
  const m = new Map();
  for (const r of edited?.rows || []) if (r._lampTypeCorrected) m.set(r._rowKey, r._lampTypeCorrected);
  return m;
}
// batch 114 follow-on 1 (Vincent: "yes"): once the buyer has corrected — or confirmed — the lamp type, the
// "type could not be confirmed … assumed" disclosure flag contradicts him and goes. Render-time filter over
// buildBuyerFlags' output; the stored flags are untouched. No other flag is affected.
export function withoutAnsweredLampDisclosure(flags, edited) {
  if (!edited?.lampTypeCorrection) return flags;
  return (flags || []).filter((f) => !(f?._tier2LampDisclosure || f?._orphanLampDisclosure));
}
// batch 115 (Vincent, 11 Sep) — the Visible Damage Summary through the edit layer, screen and PDF. Each block
// carries its ledger _rowKey (assembleVdsParts). A struck row is marked `_struck` (the screen strikes it
// through, as it does Key Cost Drivers) or dropped (`dropStruck`, the PDF, as it does Key Cost Drivers); a
// lamp-type correction re-prices the figure inside the prose via repriceStoredEntry — the ONE money-
// rewriting path, not a second. A block with no key (a report assessed before batch 115) is never matched,
// so it prints exactly as it always did.
export function editedVdsParts(vdsParts, edited, { dropStruck = false } = {}) {
  const struck = new Set((edited?.rows || []).filter((r) => r._struck).map((r) => r._rowKey));
  const rp = lampRepricedKeys(edited);
  const out = [];
  for (const v of vdsParts || []) {
    const isStruck = v?._rowKey != null && struck.has(v._rowKey);
    if (isStruck && dropStruck) continue;
    out.push({ ...repriceStoredEntry(v, rp.get(v?._rowKey)), _struck: isStruck });
  }
  return out;
}
// batch 117 (Vincent, 11 Sep) — Parts Sourcing through the edit layer, the last surface that ignored it: on a
// saved PDF the buyer was still offered, on eBay, the rear quarter he had just struck off his own ledger.
// Each link carries the ledger keys of the rows it stands for (lib/partsSourcing, stamped in the route from the
// full ledger). A link is struck only when EVERY row it covers is struck (two fog lamps, one struck → the link
// stays, for the other). PDF: a struck link is dropped (as its Key Cost Drivers are). Screen: kept but marked
// `_struck` — the page renders it struck through with NO link, since the screen keeps struck lines visible but a
// "Find on eBay" for a part the buyer struck has no use. A lamp-type correction re-prices a link's figure via
// repriceStoredEntry. A link with no keys (a report assessed before 117) is never matched — prints as before.
export function editedSourcingLinks(links, edited, { dropStruck = false } = {}) {
  const struck = new Set((edited?.rows || []).filter((r) => r._struck).map((r) => r._rowKey));
  const rp = lampRepricedKeys(edited);
  const out = [];
  for (const l of links || []) {
    const keys = Array.isArray(l?._rowKeys) ? l._rowKeys : [];
    const isStruck = keys.length > 0 && keys.every((k) => struck.has(k));
    if (isStruck && dropStruck) continue;
    const moved = keys.map((k) => rp.get(k)).find(Boolean);
    out.push({ ...repriceStoredEntry(l, moved), _struck: isStruck });
  }
  return out;
}
// Re-price one stored KCD driver or damage card whose row the correction re-priced. The figures in their
// code-owned text were rendered from the same number (fmtGBP / `£${used}`), so the swap is exact.
export function repriceStoredEntry(entry, rp) {
  if (!rp || !entry) return entry;
  const swap = (s) => (typeof s === 'string' ? s.split(fmtGBP(rp.from)).join(fmtGBP(rp.to)).split(`£${rp.from} `).join(`£${rp.to} `) : s);
  return {
    ...entry,
    ...('figure' in entry ? { figure: rp.to } : {}),
    ...('cost' in entry ? { cost: rp.to } : {}),
    ...(entry.prose ? { prose: swap(entry.prose) } : {}),
    ...(entry.note ? { note: swap(entry.note) } : {}),
  };
}

// Mirror of route.js SALVAGEGUIDE_DIVERGENCE_PCT (the divergence band width). Kept in step by the
// no-edit parity test in validate-ledger-edits (an empty edit layer must reproduce the engine's own
// stored figures exactly).
// batch 106 §5 — ONE string, two surfaces. The screen (success/page.js) and the PDF banner
// (api/salvage/pdf/route.js) must say the same thing when a stored edit layer is suppressed by a stamp
// mismatch; they said it in one place and nowhere in the other, so the PDF was silent about a decision
// that moves money. The PDF variant is DERIVED from the canonical sentence, not retyped, so the wording
// cannot drift — it only swaps the em-dash for a hyphen (the PDF suppressor is a standing constraint on
// that surface). Fires only when the layer actually holds edits; a clean report shows neither string.
export const EDITS_DISCARDED_NOTICE =
  'You adjusted this ledger against an earlier version of the report — those changes no longer apply and have not been counted.';
export const EDITS_DISCARDED_PDF = EDITS_DISCARDED_NOTICE.replace(/—/g, '-');

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
  // Cat A/B legal hard stop. The engine stores this as `_catABHardStop` (a letter, set at
  // assess/route.js when catABHardStopLetter matches); the older `_catAB` name it reads on was never
  // written, so the gate was inert — a buyer could edit a legal write-off. Read the real field, keep
  // `_catAB` as a defensive alias. (batch 105)
  const catAB        = !!(assessment?._catABHardStop || assessment?._catAB);

  const keys = rowKeyFor(reconciled);

  // Version-stamp scoping (batch-82 §2 blocker). The free re-run nulls `assessment` and writes a fresh
  // one to the SAME row, and patch-body-type rewrites the ledger on the same row too — a stale edit
  // layer's keys would then land on rows the buyer never chose. Apply edits ONLY when the layer's `stamp`
  // (the ledgerHash of the _reconciledParts it was made against) matches the current ledger; on mismatch
  // apply NONE (the edits stay stored as valid calibration for the ledger they were made against — never
  // deleted — just not applicable here; the caller surfaces a "your edits were discarded" line). The
  // Cat A/B hard stop is not editable.
  const currentStamp  = ledgerHash(reconciled);
  const hasLayer      = !!editLayer && (Array.isArray(editLayer.strikes) || Array.isArray(editLayer.adds) || isLampType(editLayer.lampType));
  const stampMismatch = hasLayer && (editLayer.stamp ?? null) !== currentStamp;
  const suppressed    = !hasLayer || stampMismatch || catAB;

  const strikes = suppressed ? [] : (Array.isArray(editLayer.strikes) ? editLayer.strikes : []);
  const adds    = suppressed ? [] : (Array.isArray(editLayer.adds) ? editLayer.adds : []);
  const lampType = suppressed ? null : (isLampType(editLayer.lampType) ? editLayer.lampType : null);

  const struckKeys = new Set(strikes);
  const rows = reconciled.map((p, i) => ({ ...p, _rowKey: keys[i], _struck: struckKeys.has(keys[i]) }));

  const struckSum = rows.filter((r) => r._struck).reduce((a, r) => a + figureOf(r), 0);
  const addedSum  = adds.reduce((a, x) => a + (isNum(x?.amount) ? Number(x.amount) : 0), 0);

  // ── batch 114 — THE LAMP-TYPE CORRECTION ─────────────────────────────────────────────────────────────
  // Re-price every IN-MONEY code-owned lamp row (_lampMandated, not struck) to the corrected type's band;
  // the difference joins `delta`, so the total, margins, ceilings and SalvageGuide divergence follow through
  // the arithmetic below unchanged. A struck lamp stays struck (strike wins — it is already out of the
  // total). A1-shelved lamps are not in _reconciledParts at all, so they stay out by construction. Only the
  // edited VIEW's rows change: `reconciled` (and so the stamp) is never touched. Lamps carry no labour.
  let lampDelta = 0;
  let lampRowsRepriced = 0;
  if (lampType) {
    const to = HEADLAMP_BANDS[lampType];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r._lampMandated || r._struck) continue;
      const from = figureOf(r);
      if (from === to) continue;                       // correcting to the engine's own type is a no-op
      rows[i] = { ...r, used: to, oem: null, _lampTypeCorrected: { from, to } };
      lampDelta += to - from;
      lampRowsRepriced++;
    }
  }

  // ── LABOUR FOLLOWS THE LEDGER (Vincent's ruling, 8 Sep) ─────────────────────────────────────────
  // Striking a panel removed its PART cost and left its LABOUR in the total. Per LABOUR_SPEC_v1 a welded
  // quarter is £800 including the structure behind it, so a buyer striking a £175 quarter was clearing
  // £175 of a ~£975 phantom, and the only way to reach the rest was to strike the whole labour line —
  // which would have deleted the labour for every panel that IS damaged. This has been true of every
  // strike since batch 105, and the code-owned labour model roughly triples labour, so the gap is ~3x
  // what it was.
  //
  // The fix is only possible BECAUSE labour is a code-owned lookup: re-run lib/labour.computeLabour over
  // the SURVIVING body panels, the same function the engine used. computeLabourRatio could never have
  // supported this — you cannot recompute a ratio applied to a figure the model invented. Strikeable
  // labour is an argument FOR the labour model, not a side-effect of it.
  //
  // Inputs come from what the engine persisted (_labourBodyPanels / _labourTellCount), so this is the
  // engine's own arithmetic replayed, never a second implementation. Three deliberate limits:
  //   * suppressed / stampMismatch layers recompute NOTHING — nothing is applied in that state.
  //   * buyer-ADDED lines earn NO labour — the buyer priced his own line (they carry no panelId, so
  //     they cannot enter the surviving-panel set by construction).
  //   * _zeroRule rows earn no panel-work labour, and cannot here either: the engine excludes them when
  //     it builds _labourBodyPanels (route.js), so they are absent from the input list.
  let labourDelta = 0;
  // batch 127 — the labour range the page shows (display only). The engine's stored columns, unless a struck body
  // panel re-ran the labour lookup below, in which case the range comes from that SAME recompute, so the row's
  // figure and its "Estimate £low - £top" line can never disagree.
  let labourColumns = assessment?._labourColumns ?? null;
  if (!suppressed) {
    const survivingPanelIds = new Set(rows.filter((r) => !r._struck && r.panelId).map((r) => r.panelId));
    const allBodyPanels = Array.isArray(assessment?._labourBodyPanels) ? assessment._labourBodyPanels : null;
    const li = rows.findIndex((r) => r._codeLabour);
    // Recompute ONLY when a body panel was actually struck. Parity then holds BY CONSTRUCTION rather
    // than by coincidence: with nothing struck the stored row is returned untouched, so an assessment
    // whose labour row was written by a different composition (an older shape, or one including the
    // structural/SRS riders) can never drift on a no-edit read. It also means `_labourWas` is only ever
    // compared against a figure the engine derived from this same panel list.
    const bodyPanelStruck = allBodyPanels
      ? allBodyPanels.some((bp) => bp?.panelId && !survivingPanelIds.has(bp.panelId))
      : false;
    if (allBodyPanels && li >= 0 && bodyPanelStruck) {
      const before = figureOf(rows[li]);
      const recomputed = computeLabour({
        bodyPanels: allBodyPanels.filter((bp) => survivingPanelIds.has(bp?.panelId)),
        structuralTellCount: Number(assessment?._labourTellCount ?? 0),
        srsTier: null,
      });
      const after = recomputed?.panelWorkMoney;
      if (recomputed?.columns) labourColumns = recomputed.columns;   // batch 127: display follows the same recompute
      if (isNum(after) && Number(after) !== before) {
        labourDelta = round2(Number(after) - before);
        const usesUsed = rows[li].used != null;
        rows[li] = {
          ...rows[li],
          used: usesUsed ? Number(after) : rows[li].used,
          oem:  usesUsed ? rows[li].oem : Number(after),
          _labourRecomputed: true,
          _labourWas: before,
        };
      }
    }
  }

  const delta     = addedSum - struckSum + labourDelta + lampDelta;

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
  // batch 94 §5: SAME fallback as the assess path (single owner). newRebuild = rebuildCeilingHammer =
  // in-range crossing else extrapolated past the ladder top, null only when repair is non-viable; `breakEven`
  // (in-range only) decides the source. Must match route.js:5438 exactly or a struck line changes the warning.
  let salvageGuide = origSG;
  if (origSG && isNum(origSG.bidLow) && isNum(origSG.bidHigh)) {
    const be = newRebuild;
    const breakEvenSource = be == null ? null : (breakEven != null ? 'breakEven' : 'extrapolated');
    const divergence = (be != null)
      ? (be < origSG.bidLow * (1 - SALVAGEGUIDE_DIVERGENCE_PCT) || be > origSG.bidHigh * (1 + SALVAGEGUIDE_DIVERGENCE_PCT))
      : null;
    salvageGuide = { ...origSG, breakEven: be, breakEvenSource, divergence };
  }

  return {
    applied: !suppressed && (strikes.length > 0 || adds.length > 0 || !!lampType),
    // batch 114: the buyer's lamp-type correction as applied (null when none / suppressed). Present even
    // when it re-priced nothing (the buyer confirmed the engine's own type) — a confirmed type is still a
    // confirmed type, so surfaces drop the "type assumed" flag either way.
    lampTypeCorrection: lampType
      ? { type: lampType, band: HEADLAMP_BANDS[lampType], rowsRepriced: lampRowsRepriced, delta: lampDelta, line: lampCorrectionLine(lampType) }
      : null,
    stampMismatch,
    stamp: currentStamp,   // the current ledger's stamp — the caller stores this on a new edit layer
    notEditable: catAB,
    rows,
    addedRows: adds,
    partsSum,
    delta,
    labourDelta,   // the part of `delta` that is the code-owned labour row moving with the surviving panels
    // batch 127 — DISPLAY ONLY (spec §6 + item 4). The columns behind the labour row (stored, or from the same
    // recompute a struck body panel triggered), and the three approved sentences built from them — null when the
    // report has no columns or the buyer struck the labour line (then "the total uses the top" would be false).
    // Nothing above reads either field: partsSum, delta, margins, ceilings and divergence are computed first.
    labourColumns,
    labourDisplay: rows.some((r) => r._codeLabour && !r._struck) ? labourDisplayLines(labourColumns) : null,

    marginScenarios,
    breakEven,
    investmentBlock,
    salvageGuide,
    allStruck,
    warnings,
  };
}
