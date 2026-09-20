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
import { computeLabour, labourDisplayLines, isBodyPanel } from './labour.mjs';
import { PANEL_PRICE_TABLE } from './priceBand.mjs';
import { HEADLAMP_BANDS, LAMP_TYPES } from './lampBands.mjs';
import { structureFloorApplies, isStructureFloorRow, structureFloorStruckReason } from './structureFloor.mjs';   // batch 149 Y3 — the SAME rule the engine used

// batch 114 — the buyer's lamp-type correction (Vincent, 11 Sep: "Let the photo set the band with the user
// having the option to correct it"). A LOT-level field on the edit layer, not a per-row edit: both headlamps
// of one car share one technology. Closed enum, validated here and in the edits API.
export const isLampType = (t) => typeof t === 'string' && LAMP_TYPES.includes(t);

// ── batch 158 A2 — THE BUYER CAN EDIT A LINE, NOT ONLY STRIKE OR ADD IT ─────────────────────────────
// Vincent, 18 Sep. Two edits per row, both reversible and both stored in the same layer:
//   'action' — repair ↔ replace. The line is RE-PRICED from the code-owned grid (lib/priceBand.mjs) at
//              this car's band, and labour re-derives through the one labour owner (lib/labour.mjs),
//              exactly as it does when a line is struck. Offered ONLY where the grid prices the panel.
//   'amount' — the buyer's own figure. It overrides the part price; the engine's figure is kept on the
//              row (_amended.from) so the screen can grey it and ↺ always restores it.
// Nothing is deleted and nothing is clamped: an amend is a view-time recompute of an untouched ledger,
// the same contract as a strike.
export const isAmendAction = (a) => a === 'repair' || a === 'replace';
export function amendableRow(row, bandKey) {
  // What the UI may offer for this row. A structure floor, the labour line, an SRS rider or any
  // non-panel row is not a part the buyer re-prices by action — it can still take an amount override.
  const pid = row?.panelId ?? null;
  const entry = pid && bandKey ? PANEL_PRICE_TABLE?.[pid]?.[bandKey] : null;
  const priced = !!entry && isNum(entry.used);
  const canRepair = priced && isBodyPanel(pid);      // only a body panel has a repair path (panel work carries it)
  return {
    amount: true,
    action: priced && canRepair ? ['repair', 'replace'] : [],
    replaceFigure: priced ? Number(entry.used) : null,
    oemFigure: priced && isNum(entry.oem) ? Number(entry.oem) : null,
  };
}
// The figure a row carries after an action flip. repair = £0 part (panel work carries it, the engine's
// own applyGradeOwnsAction shape); replace = the grid's second-hand figure for this band.
function amendedRowFor(row, amend, bandKey) {
  const cap = amendableRow(row, bandKey);
  if (isNum(amend?.amount)) {
    const to = Math.max(0, Number(amend.amount));
    return { ...row, used: to, oem: null, _repairNoPart: false,
      _amended: { kind: 'amount', from: figureOf(row), to, fromAction: row.action ?? null } };
  }
  if (!isAmendAction(amend?.action) || !cap.action.includes(amend.action) || amend.action === row.action) return null;
  const from = figureOf(row);
  if (amend.action === 'repair') {
    return { ...row, used: null, oem: null, _repairNoPart: true,
      _amended: { kind: 'action', from, to: 0, fromAction: row.action ?? null, toAction: 'repair' }, action: 'repair' };
  }
  // A WELDED panel the engine priced at NEW keeps that treatment when the buyer flips it back to
  // replace (batch 127: a welded quarter has no second-hand price — the engine moved its S/H figure to
  // _weldedAtNew and charged OEM). Re-pricing it at the grid's S/H figure would quietly undo that rule,
  // so the row returns to the engine's own new-price shape.
  const welded = row?._weldedAtNew != null;
  const to = welded && isNum(cap.oemFigure) ? cap.oemFigure : cap.replaceFigure;
  return { ...row, used: welded ? null : cap.replaceFigure, oem: welded ? cap.oemFigure : cap.oemFigure,
    _repairNoPart: false,
    _amended: { kind: 'action', from, to, fromAction: row.action ?? null, toAction: 'replace', welded }, action: 'replace' };
}
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

// ── batch 163 T2 — THE ONE "IS THIS PANEL CHARGED?" CHECK ───────────────────────────────────────────
// A REPAIRED panel carries no £ on its own row: the grade rule moves its cost into the Labour & paint
// line and marks the row _repairNoPart (lib/labour.mjs). So a £ scan of the row says "not charged" about
// a panel the buyer is paying for. That is not hypothetical — batch 160 §3's summary called GY75CJU's
// repaired REAR_QUARTER a panel nothing would break, and it is a labelled HIT worth £1,275 to drop.
//
// This rule was written out by hand in EIGHT places (route.js ×4, parts.mjs, ledgerEdits.mjs,
// flooredProseScrub.mjs, score-accuracy.mjs). They all meant the same thing; they need not have, and the
// next one need not either. One owner now. Surrounding conditions (!_struck, !isStructureFloorRow,
// !isLabour(name), panelId !== null) stay at their call sites — they are not part of "is it charged".
//
// The two spellings that existed were equivalent and this keeps the safer one of each:
//   `figureOf(r) > 0` vs `(r.used ?? r.oem ?? 0) > 0` — identical for every value. figureOf's trailing
//     `|| 0` only ever replaces a FALSY figure, and every falsy value already fails `> 0`; it never
//     touches a truthy one. No input can separate them.
//   `|| r._repairNoPart` vs `|| r._repairNoPart === true` — the strict form, because the field is only
//     ever written as a literal boolean (ledgerEdits:57/63/73, labour.mjs:230) and a truthy non-true
//     value arriving here would be a bug to surface, not to absorb.
// Null-safe by construction (`?.`), which the parts.mjs copy already was and the others were not.
export function isChargedRow(row) {
  return figureOf(row) > 0 || row?._repairNoPart === true;
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
  const hasLayer      = !!editLayer && (Array.isArray(editLayer.strikes) || Array.isArray(editLayer.adds)
    || Array.isArray(editLayer.amends) || isLampType(editLayer.lampType));
  const stampMismatch = hasLayer && (editLayer.stamp ?? null) !== currentStamp;
  const suppressed    = !hasLayer || stampMismatch || catAB;

  const strikes = suppressed ? [] : (Array.isArray(editLayer.strikes) ? editLayer.strikes : []);
  const adds    = suppressed ? [] : (Array.isArray(editLayer.adds) ? editLayer.adds : []);
  const lampType = suppressed ? null : (isLampType(editLayer.lampType) ? editLayer.lampType : null);

  const struckKeys = new Set(strikes);
  const rows = reconciled.map((p, i) => ({ ...p, _rowKey: keys[i], _struck: struckKeys.has(keys[i]) }));

  // ── batch 158 A2 — apply the buyer's per-row amends ────────────────────────────────────────────
  // Before anything downstream, so the struck sum, the labour recompute, the total, the margins, the
  // break-even and both ceilings all see the amended figures. A struck row is skipped: a strike already
  // removes the line, and strike-wins is the existing contract (see the lamp correction below).
  // The band comes from what the engine stored; without it the grid cannot be consulted, so an action
  // flip is simply not available and only the amount override applies (which needs no grid).
  const amends = suppressed ? [] : (Array.isArray(editLayer.amends) ? editLayer.amends : []);
  const bandKey = assessment?._priceBandKey ?? null;
  let amendDelta = 0;
  const amendedActions = new Map();   // panelId → new action, for the labour recompute below
  for (const am of amends) {
    const i = rows.findIndex((r) => r._rowKey === am?.rowKey);
    if (i === -1 || rows[i]._struck) continue;
    const next = amendedRowFor(rows[i], am, bandKey);
    if (!next) continue;
    amendDelta += next._amended.to - next._amended.from;
    if (next._amended.kind === 'action' && next.panelId) amendedActions.set(next.panelId, next._amended.toAction);
    rows[i] = next;
  }

  const struckSum = rows.filter((r) => r._struck).reduce((a, r) => a + figureOf(r), 0);
  const addedSum  = adds.reduce((a, x) => a + (isNum(x?.amount) ? Number(x.amount) : 0), 0);

  // ── batch 149 Y3 — A STRIKE RE-CHECKS THE STRUCTURE FLOOR ──────────────────────────────
  // Batch 147 X2 (Vincent, 16 Sep): no structure charge when the only damage at an end is the bumper.
  // The ENGINE applied that when it built the ledger — but striking a row can make a zone bumper-only
  // AFTER the fact, and the £500 floor stayed. SF69YBB: striking the rear quarter left the rear zone
  // with nothing but the bumper, and still charged £500 of jig work for it.
  //
  // Re-run the engine's OWN rule (lib/structureFloor.mjs — one owner, imported by both) over the
  // SURVIVING costed rows. Same definition of "other damage" as X2: engine-costed money, or a repaired
  // panel. A buyer-ADDED line does not count — the buyer's own figure is not a detection of damage, and
  // adds carry no panelId so they cannot enter the set by construction.
  //
  // A floor the buyer struck DIRECTLY is skipped (strike wins; struckSum already has it), so striking a
  // floor row by hand still works exactly as before. Un-striking the panel puts the floor back, because
  // nothing is persisted — the whole thing is recomputed from the layer on every read.
  // NOTHING RUNS WHEN SUPPRESSED, so no-edit parity holds by construction.
  let structFloorDelta = 0;
  const structFloorsDropped = [];
  if (!suppressed) {
    const survivingDamaged = new Set(
      rows.filter((r) => !r._struck && r.panelId && !isStructureFloorRow(r)
                      && isChargedRow(r))   // batch 163 T2 — one owner
          .map((r) => r.panelId),
    );
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r._struck || !isStructureFloorRow(r)) continue;
      const verdict = structureFloorApplies(r.panelId, survivingDamaged);
      if (verdict.apply) continue;
      const was = figureOf(r);
      structFloorDelta -= was;
      rows[i] = { ...r, _struck: true, _structFloorDropped: true, _structFloorWas: was,
                  _structFloorReason: structureFloorStruckReason() };
      structFloorsDropped.push({ panelId: r.panelId, was, reason: structureFloorStruckReason() });
    }
  }

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
  // ── batch 161 E2 (Vincent, 19 Sep) — THE BUYER'S OWN LABOUR FIGURE STANDS ────────────────────────
  // Once he has typed his repairer's figure on the Labour & paint row, striking or restoring a body
  // panel must not re-derive it and must not overwrite it. Without this the amend loop above would set
  // his figure and the recompute below would immediately replace it on the next strike — and, worse,
  // double-count: amendDelta has already booked his figure, so a labourDelta on top moves the total
  // twice. Undo (clearAmend drops the amend) removes the marker, and labour follows the ledger again.
  // A STRUCK labour row is not an own figure: the amend loop skips struck rows, so strike-wins holds.
  const labourRowIdx = rows.findIndex((r) => r._codeLabour);
  const labourOwnFigure = labourRowIdx >= 0 && !rows[labourRowIdx]._struck
    && rows[labourRowIdx]?._amended?.kind === 'amount';
  if (!suppressed) {
    const survivingPanelIds = new Set(rows.filter((r) => !r._struck && r.panelId).map((r) => r.panelId));
    const allBodyPanels = Array.isArray(assessment?._labourBodyPanels) ? assessment._labourBodyPanels : null;
    const li = labourRowIdx;
    // Recompute ONLY when a body panel was actually struck. Parity then holds BY CONSTRUCTION rather
    // than by coincidence: with nothing struck the stored row is returned untouched, so an assessment
    // whose labour row was written by a different composition (an older shape, or one including the
    // structural/SRS riders) can never drift on a no-edit read. It also means `_labourWas` is only ever
    // compared against a figure the engine derived from this same panel list.
    const bodyPanelStruck = allBodyPanels
      ? allBodyPanels.some((bp) => bp?.panelId && !survivingPanelIds.has(bp.panelId))
      : false;
    // batch 158 A2: an action amend changes a body panel's repair/replace, which is an INPUT to the same
    // lookup — so it re-runs the recompute for exactly the same reason a strike does, through the same
    // owner. The panel list is the engine's own, with that panel's action swapped; nothing else moves.
    const bodyPanelAmended = allBodyPanels
      ? allBodyPanels.some((bp) => bp?.panelId && amendedActions.has(bp.panelId))
      : false;
    if (allBodyPanels && li >= 0 && !labourOwnFigure && (bodyPanelStruck || bodyPanelAmended)) {
      const before = figureOf(rows[li]);
      const recomputed = computeLabour({
        bodyPanels: allBodyPanels.filter((bp) => survivingPanelIds.has(bp?.panelId))
          .map((bp) => (amendedActions.has(bp?.panelId) ? { ...bp, action: amendedActions.get(bp.panelId) } : bp)),
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

  const delta     = addedSum - struckSum + labourDelta + lampDelta + structFloorDelta + amendDelta;

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
    // batch 149 Y3 — structure floors the strike made bumper-only, dropped from the total. [] when none.
    // Their rows are in `rows` marked _struck + _structFloorDropped, carrying _structFloorReason.
    structFloorDelta,
    structFloorsDropped,
    // batch 127 — DISPLAY ONLY (spec §6 + item 4). The columns behind the labour row (stored, or from the same
    // recompute a struck body panel triggered), and the three approved sentences built from them — null when the
    // report has no columns or the buyer struck the labour line (then "the total uses the top" would be false).
    // Nothing above reads either field: partsSum, delta, margins, ceilings and divergence are computed first.
    labourColumns,
    // batch 161 E3 (Vincent, 19 Sep): once the buyer has entered his own labour figure, OUR range, the
    // second-hand comparison and the addendum must not be shown as if they still applied — "the total
    // uses the top" is false, and the addendum tells him to press Change on a line he has already
    // changed. Nulling labourDisplay HIDES all three, on BOTH surfaces at once: the screen guards the
    // per-row lines and the addendum on this field (page.js), and so does the PDF (pdf/route.js). No
    // replacement sentence is invented here — in edit mode the row already reads "your figure · was £X",
    // and new buyer wording is Vincent's to write.
    labourDisplay: rows.some((r) => r._codeLabour && !r._struck) && !labourOwnFigure
      ? labourDisplayLines(labourColumns) : null,

    marginScenarios,
    breakEven,
    investmentBlock,
    salvageGuide,
    allStruck,
    warnings,
  };
}
