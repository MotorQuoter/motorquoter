import { PANEL_PRICE_TABLE } from './priceBand.mjs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS } from './panelEnum.mjs';

// Parts money path — lamp reconciliation, visibility gate, instrumentation.
// Lifted from app/api/salvage/assess/route.js (CB7 fix, 12 Jun 2026) into a
// standalone module for reuse by the shipped route. .mjs because the repo has
// no "type":"module" — raw node must load this file alongside Next.
//
// CB7 fix (approved 12 Jun): lamp money is code-mandated (locked architecture
// A1-A3) — the displayed repair total must carry exactly the lamp money the
// lamp machinery mandates. Mandated lamp rows are marked _lampMandated and are
// never REMOVED by the gate; iv===true keeps max(model cost, band), anything
// else is clamped to exactly the band (the gate strips only the unconfirmed
// model pricing above band — Q1 ruling).
//
// Lamp verdict pairing — rule B (adopted 12 Jun): normName strips
// parentheticals, so every per-corner lamp name ("Front headlamp (corner 1)"
// etc.) normalises to the same string and name matching cannot attribute
// per-lamp iv. The k-th lamp ROW therefore pairs with the k-th lamp VERDICT,
// positional among lamp entries in each block; normName is the fallback for
// the degenerate case. Pairings are logged ([LAMP][PAIR]) so ordering drift
// between the Parts Breakdown and Part Verdicts blocks is visible, never silent.

export const BUMPER_OFF_SEAM_REASON = 'Excluded from repair total — the adjacent bumper is displaced or torn away, exposing the body seam; the apparent crease on this panel is consistent with the exposed seam, not confirmed impact deformation — verify on the WhatsApp inspection before bidding.';

export const BUMPER_OFF_MOUNTING_REASON = 'Excluded from repair total — the displaced bumper has torn away its own mounting structure (mounting rails, carrier brackets, or lower closing-panel tinware) directly in front of this panel, so the panel face itself cannot be confirmed from the listing photos; the visible torn metal belongs to the bumper assembly, not this panel — confirm the panel face on the WhatsApp inspection before bidding.';

export const BUMPER_OFF_SYMMETRIC_REASON = 'Excluded from repair total — the apparent damage on this panel matches an identical factory styling feature on the opposite-side panel in the listing photos, indicating a factory pressing rather than impact; confirm the panel face on the WhatsApp inspection before bidding.';

export const BUMPER_OFF_UNCOSTABLE_REASON = 'Excluded from repair total — the adjacent bumper is displaced or torn away and possible damage is visible in this panel\'s region, but panel-face damage cannot be reliably separated from torn bumper-mounting structure in listing photos; confirm the panel face and expect possible panel cost on the WhatsApp inspection before bidding.';

export function isLampLine(name) {
  return /\bhead[\s-]?lamp\b|\bheadlight\b|\bfront\s+lamp\b/i.test(name);
}

export const normName = s => s.toLowerCase().trim()
  .replace(/\s*&\s*|\s+and\s+/gi, ' and ')
  .replace(/\s*\([^)]*\)/g, '')
  .replace(/\s+/g, ' ');

// normKey: like normName but preserves parenthetical qualifiers.
// Used for the gate join (CB3) so "Door mirror (left)" and "Door mirror (right)"
// get distinct join keys and are not both matched to the first costedParts entry.
// normName is kept for flag dedup paths (wider net is correct there).
export const normKey = s => s.toLowerCase().trim()
  .replace(/\s*&\s*|\s+and\s+/gi, ' and ')
  .replace(/\s+/g, ' ');

export function sumPartsRealistic(parts) {
  return parts.reduce((acc, p) => acc + (p.used ?? p.oem ?? 0), 0);
}

// ── Labour shape (batch 81 amendment 2, Vincent: labour tracks the EXTENT of damage, not value) ──────
// The model quotes ONE labour figure for its whole read; as the gate strips model-costed panels, labour
// must follow what SURVIVES. Non-negotiable floor: zero surviving costed parts ⟹ zero labour. Each SHAPE
// scales the model's labour by (Σ surviving weight / Σ pre-gate weight) under a different per-panel weight:
//   'value'           — baseline (part VALUE). What a part costs to buy, NOT how long it takes to fit.
//   'severity'        — extent grade only (MINOR/MODERATE/SEVERE). Ignores price entirely.
//   'severity-action' — severity × a repair/replace multiplier. ⚠️ OPEN QUESTION for Vincent: in the
//                       bodyshop a REPAIR (strip/beat/fill/sand/prime/paint) is often MORE labour than a
//                       REPLACE (unbolt/bolt-on/paint) — the OPPOSITE of how cost weights them. The
//                       multipliers below encode repair>replace as a CANDIDATE, not a decision.
export const SEVERITY_WEIGHT = { MINOR: 1, MODERATE: 2, SEVERE: 3 };
export const ACTION_WEIGHT   = { repair: 1.5, replace: 1.0 };   // candidate only — Vincent rules

// severityOf(part) → 'MINOR'|'MODERATE'|'SEVERE' (caller maps via the per-view verdict by panelId).
// Returns the scale factor in [0,1] to apply to the model's labour figure.
export function computeLabourRatio({ survivingParts, preGateParts, severityOf, shape = 'value' } = {}) {
  const isLabour = (p) => /labour|paint|prep/i.test(p?.name || p?.partName || '');
  const val = (p) => p.used ?? p.oem ?? 0;
  const sev = (p) => SEVERITY_WEIGHT[(severityOf && severityOf(p)) || 'MODERATE'] ?? 2;
  const act = (p) => ACTION_WEIGHT[p.action] ?? 1;
  const weightOf = (p) =>
      shape === 'severity'        ? sev(p)
    : shape === 'severity-action' ? sev(p) * act(p)
    :                               val(p);   // 'value' baseline
  const surv = (Array.isArray(survivingParts) ? survivingParts : []).filter((p) => !isLabour(p));
  const pre  = (Array.isArray(preGateParts) ? preGateParts : []).filter((p) => !isLabour(p));
  if (surv.length === 0) return 0;                                   // floor: no parts ⟹ no labour
  const survW = surv.reduce((a, p) => a + weightOf(p), 0);
  const preW  = pre.reduce((a, p) => a + weightOf(p), 0);
  if (preW <= 0) return 1;                                           // nothing to scale against → keep
  return Math.min(1, survW / preW);
}

// Layer 2 backstop trigger predicate (item 14): fires when Call-1 prose identifies
// a front/impact zone but no lamp observation was obtained. Exported for unit testing.
export function needsLampBackstop(perZone, lampObs) {
  return !lampObs && Array.isArray(perZone) && perZone.some(z => z.zone === 'front' && z.eventType === 'impact');
}

// Rule B pairing: k-th lamp row ↔ k-th lamp verdict (positional among lamp
// entries); normName fallback when no verdict exists at that ordinal.
export function lampVerdictFor(costedParts, rowName, lampOrdinal) {
  const lampVerdicts = costedParts.filter(cp => isLampLine(cp.partName));
  if (lampOrdinal != null && lampOrdinal >= 0 && lampOrdinal < lampVerdicts.length) {
    return lampVerdicts[lampOrdinal];
  }
  return costedParts.find(cp => normName(cp.partName) === normName(rowName)) ?? null;
}

// Local helper: applies PANEL_PRICE_TABLE overrides to a parts array.
// Called from both the tier-1 early-return path and the tier-2 reconcile path so
// the table fires on EVERY lot regardless of lamp tier. Lamp and grille rows are
// already marked by the time the tier-2 path calls this; on the tier-1 path no
// rows are marked so the guard is a no-op (correct — no lamp/grille rows exist).
function applyTableOverride(partsArr, bandKey) {
  return partsArr.map(rp => {
    if (rp._lampMandated || rp._grilleMandated) return rp;
    if (!rp.panelId) return rp;
    if (!bandKey) {
      console.log(`[TABLE FALLBACK] no Brego trade valuation — model figure retained for ${rp.name}`);
      return rp;
    }
    const entry = PANEL_PRICE_TABLE[rp.panelId]?.[bandKey];
    if (!entry) {
      if (PANEL_PRICE_TABLE[rp.panelId]) {
        console.warn(`[TABLE] band "${bandKey}" not found for ${rp.panelId} — model figure retained`);
      }
      return rp;
    }
    console.log(`[TABLE] ${rp.panelId} band=${bandKey} → used=£${entry.used} oem=£${entry.oem} (model: used=£${rp.used ?? 'null'} oem=£${rp.oem ?? 'null'})`);
    return { ...rp, oem: entry.oem, used: entry.used, _tableMandated: true };
  });
}

export function reconcileParts(parts, lampResult, costedParts = [], grilleAllowance = 0, bandKey = null, specLampBand = null, specLampAssumed = false, ledFallbackBand = null) {
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    // Tier-1 / no-aperture orphan: the model authored a headlamp line but the band machinery did
    // not fire (undisplaced front — stone-smash, vandalism, MOT-fail lamp). This is a legitimate
    // cost class, so the line is KEPT — but the band OWNS the price (single-owner invariant): clamp
    // to the request-scope spec-table band, mark _lampMandated + _band so the gate treats it
    // identically to any code-owned lamp row, and mark the assumed-LED disclosure when the spec is
    // indeterminate (route.js emits the flag post-gate). specLampBand is always computable at request
    // scope; if it is genuinely absent (null) the row is left untouched and logged loudly — no silent
    // model figure reaches the total, the obstacle is surfaced for follow-up.
    let workParts = parts;
    const allowanceParts = [];
    const orphanLampIdx = parts.reduce((acc, p, i) => { if (isLampLine(p.name)) acc.push(i); return acc; }, []);
    if (orphanLampIdx.length > 0) {
      // Band always OWNS the price. specLampBand is always numeric from the production caller
      // (route.js resolveLampBand). FAIL-SAFE (S5-2 ruling a): if it is ever null, clamp to the
      // caller-supplied LED-default (ledFallbackBand) rather than leak an un-flagged model figure —
      // the figure stays route.js-owned; parts.mjs holds no lamp £ literal. Loud on the fallback.
      let band = specLampBand;
      if (band == null && ledFallbackBand != null) {
        band = ledFallbackBand;
        console.error(`[LAMP ORPHAN][FAIL-SAFE] specLampBand null — clamping ${orphanLampIdx.length} headlamp line(s) to caller LED-default £${band} (band owns; never a model figure).`);
      }
      if (band == null) {
        // No band available at all (neither spec nor fallback supplied) — only a bare non-production
        // caller reaches this; preserve prior behaviour (leave the model figure, loud). Unreachable
        // from route.js, which always supplies both.
        console.error(`[LAMP ORPHAN] ${orphanLampIdx.length} headlamp line(s) but no band available — left as model figure; investigate.`);
      } else {
        // CAP-ONE (Q2): keep the FIRST orphan lamp line clamped to band in the money; route every
        // additional orphan lamp line to allowanceParts (mirrors the tier-2 rule). Ordinal-0 keep —
        // the fallback leg of the existing iv-aware rule; tier-2's machinery is left byte-identical.
        const keepIdx = orphanLampIdx[0];
        const dropSet = new Set(orphanLampIdx.slice(1));
        workParts = parts.map((p, i) => {
          if (i !== keepIdx) return p;
          const modelCost = p.used ?? p.oem ?? 0;
          console.log(`[LAMP ORPHAN] "${p.name}" clamped model £${modelCost} → band £${band}`);
          return { ...p, used: band, oem: null, _lampMandated: true, _band: band, _modelLampCost: modelCost,
            ...(specLampAssumed ? { _orphanAssumedDisclosure: true } : {}) };
        });
        if (dropSet.size > 0) {
          for (const n of dropSet) {
            console.log(`[LAMP][ALLOWANCE] orphan lamp "${parts[n].name}" → allowance row (band £${band}) — excluded from repair total BY DESIGN`);
            allowanceParts.push({ name: 'Headlamp', action: 'replace', used: band, _allowance: true });
          }
          workParts = workParts.filter((_, i) => !dropSet.has(i));
        }
      }
    }
    return { parts: applyTableOverride(workParts, bandKey), allowanceParts };
  }
  const band      = lampResult.lampAllowance;
  const lampCount = lampResult.lampCount ?? 1;

  const lampIndices = [];
  parts.forEach((p, i) => { if (isLampLine(p.name)) lampIndices.push(i); });

  // Stamp every lamp row with its ordinal so the gate uses the same rule-B
  // pairing this function used; log each pairing.
  let workParts = parts.map((p, i) => {
    const k = lampIndices.indexOf(i);
    return k >= 0 ? { ...p, _lampOrdinal: k } : p;
  });
  lampIndices.forEach((pi, k) => {
    const v = lampVerdictFor(costedParts, parts[pi].name, k);
    console.log(v
      ? `[LAMP][PAIR] row ${k} "${parts[pi].name}" ↔ verdict ${k} "${v.partName}" iv=${v.independentlyVisible}`
      : `[LAMP][PAIR] row ${k} "${parts[pi].name}" ↔ no verdict (normName fallback empty)`);
  });

  // (a) iv-aware keep-selection: mandate the first lamp whose paired verdict
  // confirms iv===true; else the first lamp line.
  const ivAtOrdinal = k => {
    const v = lampVerdictFor(costedParts, parts[lampIndices[k]].name, k);
    return v ? v.independentlyVisible : undefined;
  };
  let keptOrdinal = lampIndices.findIndex((_, k) => ivAtOrdinal(k) === true);
  if (keptOrdinal < 0) keptOrdinal = 0;
  const keepIdx = lampIndices[keptOrdinal];

  const allowanceParts = [];

  const mandate = (row, modelCost, effective, ordinal) => ({
    ...row, oem: null, used: effective,
    _lampMandated: true, _band: band, _modelLampCost: modelCost, _lampOrdinal: ordinal,
  });
  const insertedRow = () => ({
    name: 'Headlamp', action: 'replace', oem: null, used: band,
    _inserted: true, _lampMandated: true, _band: band, _modelLampCost: null, _lampOrdinal: null,
  });

  if (lampCount === 2) {
    if (lampIndices.length >= 1) {
      // Reconcile the kept lamp into parts_sum. The band OWNS the price (single-owner invariant):
      // the model figure never prices a headlamp row — it is retained only as _modelLampCost for
      // the lamp_delta instrumentation. (Was max(model, band); model could win when model > band.)
      const cost0 = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      if (cost0 !== band) console.log(`[LAMP][BAND] "${workParts[keepIdx].name}" model £${cost0} → band £${band} (band owns)`);
      workParts   = workParts.map((item, i) => i === keepIdx ? mandate(item, cost0, band, keptOrdinal) : item);

      const others = lampIndices.filter(i => i !== keepIdx);
      if (others.length >= 1) {
        // Remaining model lamp lines move to allowanceParts, removed from workParts
        for (const n of others) {
          console.log(`[LAMP][ALLOWANCE] moved "${workParts[n].name}" to allowance row (band £${band}) — excluded from repair total BY DESIGN`);
          allowanceParts.push({ name: 'Headlamp', action: 'replace', used: band, _allowance: true });
        }
        const toRemove = new Set(others);
        workParts = workParts.filter((_, i) => !toRemove.has(i));
      } else {
        // Model priced exactly 1 lamp — add the second as an allowance row
        console.log(`[LAMP][ALLOWANCE] added second-corner "Headlamp" allowance row (band £${band}) — excluded from repair total BY DESIGN`);
        allowanceParts.push({ name: 'Headlamp', action: 'replace', used: band, _allowance: true });
      }
    } else {
      // Model priced 0 lamps — insert one priced, one allowance (same band, one type-read)
      const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), insertedRow(), ...workParts.slice(at)];
      console.log(`[LAMP][ALLOWANCE] added second-corner "Headlamp" allowance row (band £${band}) — excluded from repair total BY DESIGN`);
      allowanceParts.push({ name: 'Headlamp', action: 'replace', used: band, _allowance: true });
    }
  } else {
    // lampCount === 1: mandate exactly one lamp, no allowance row
    if (lampIndices.length >= 1) {
      // Band OWNS the price (single-owner invariant): model figure never prices the row, kept only
      // as _modelLampCost. (Was max(model, band).)
      const modelCost = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      if (modelCost !== band) console.log(`[LAMP][BAND] "${workParts[keepIdx].name}" model £${modelCost} → band £${band} (band owns)`);
      workParts       = workParts.map((item, i) => i === keepIdx ? mandate(item, modelCost, band, keptOrdinal) : item);
    } else {
      const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), insertedRow(), ...workParts.slice(at)];
    }
  }

  // Grille-set injection (mirrors lamp insertedRow): inject before labour line when
  // the front grille is established missing and not already in the main-call parts list.
  if (grilleAllowance > 0 && !workParts.some(p => p._grilleMandated)) {
    const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
    const at = labourIdx >= 0 ? labourIdx : workParts.length;
    workParts = [...workParts.slice(0, at),
      { name: 'Front grille set', action: 'replace', oem: null, used: grilleAllowance, _grilleMandated: true },
      ...workParts.slice(at)];
    console.log(`[GRILLE BAND] established missing → £${grilleAllowance} used allowance injected`);
  }

  workParts = applyTableOverride(workParts, bandKey);

  return { parts: workParts, allowanceParts };
}

// Phase 2 visibility gate. Mutates flaggedParts (pushes gate-generated flags,
// deduped by normName against existing entries — dedup behaviour unchanged, Q4 parked).
export function applyVisibilityGate(reconciledParts, costedParts, flaggedParts, lampResult) {
  // Note: allowance rows (_allowance:true) never appear in reconciledParts —
  // reconcileParts returns them in the separate allowanceParts array. The gate
  // therefore only ever sees priced rows.
  const blockAbsent = costedParts.length === 0 && reconciledParts.length > 0;
  if (blockAbsent) {
    console.error(
      `[GATE][INOPERATIVE] Part Verdicts absent/empty while ${reconciledParts.length} costed part(s) present` +
      ` — gate did not run; parts pass through unfiltered`
    );
    return { gatedParts: reconciledParts, gateAllowanceParts: [], blockAbsent };
  }
  const gateStripped = [];
  const gatedParts = [];
  // A1: precautionary (iv≠true) mandated-lamp rows are moved OUT of the repair total into these
  // inspection-allowance rows (same shape as reconcileParts' orphan/second-corner lamp allowances).
  const gateAllowanceParts = [];
  const usedVerdicts = new Set();
  for (const rp of reconciledParts) {
    if (rp._grilleMandated) { gatedParts.push(rp); continue; }
    const verdict = (rp._lampMandated || rp._lampOrdinal != null)
      ? lampVerdictFor(costedParts, rp.name, rp._lampOrdinal ?? null)
      : costedParts.find(cp => cp.panelId === rp.panelId)
          ?? null;
    if (rp._lampMandated) {
      // Lamp money is code-owned: the band OWNS the price at EVERY iv state — the row is emitted at
      // band and never removed (single-owner invariant). reconcileParts already prices the mandated
      // row at band, so this band re-assertion is idempotent belt-and-braces; no code path can carry
      // a model figure onto a headlamp money surface. iv≠true additionally raises the
      // unconfirmed-pricing inspection flag.
      const bandRow = { ...rp, used: rp._band, oem: null };
      if (verdict && verdict.independentlyVisible === true) { gatedParts.push(bandRow); continue; }
      // A1 (Vincent 5 Aug): the lamp is NOT independently-visibly damaged — a precautionary,
      // serviceability-unconfirmed lamp. It must NOT sit in the costed repair total. Move it to a
      // £0 inspection allowance (band value shown as the allowance, excluded from parts_sum) —
      // exactly the orphan/second-corner lamp allowance treatment. Genuinely-damaged lamps
      // (iv:true, above) stay costed. Part-out HEADLAMP_USED_BY_BAND recovery is a separate path.
      gateAllowanceParts.push({ name: 'Headlamp', action: 'replace', used: rp._band, _allowance: true });
      console.log(`[GATE][LAMP] "${rp.name}" iv≠true — band £${rp._band} → £0 inspection allowance (excluded from repair total)`);
      const lampType = lampResult?.lampType ?? 'led';
      if (!flaggedParts.some(f => normName(f.partName) === normName(rp.name) && f._gateGenerated)) {
        flaggedParts.push({
          partName: rp.name, zone: 'front', weight: 'medium',
          reason: `model's lamp pricing not independently confirmed — precautionary £${rp._band} (${lampType.toUpperCase()}) inspection allowance, NOT included in the repair total; confirm serviceable unit on inspection`,
          _gateGenerated: true,
        });
      }
      continue;
    }
    if (!verdict) {
      if (rp.panelId) {
        // Resolves to a known panel that amalgamate did NOT put in the costed set
        // (it was flagged / floored / cleared). Code owns the cost set — a panel
        // amalgamate did not cost cannot cost because the model wrote a row for it.
        console.log(`[GATE] no-verdict-match "${rp.name}" → resolved ${rp.panelId}, not in costed set → STRIPPED`);
        continue;
      }
      // Non-panel row (labour / paint / sundries / blend) — no panelId — pass as today.
      console.log(`[GATE] no-verdict-match "${rp.name}" — passed unchecked (no costedParts entry)`);
      gatedParts.push(rp);
      continue;
    }
    if (verdict._labourSafe) { gatedParts.push(rp); continue; }
    if (verdict.independentlyVisible === true) {
      const vKey = normKey(verdict.partName);
      if (usedVerdicts.has(vKey)) {
        console.log(`[GATE][DEDUP] "${rp.name}" shares verdict key "${vKey}" — duplicate row stripped`);
        if (!flaggedParts.some(f => normName(f.partName) === normName(rp.name) && f._gateGenerated)) {
          flaggedParts.push({
            partName: rp.name, zone: verdict.zone ?? 'unknown', weight: 'medium',
            reason: 'duplicate part row excluded from repair total — only the first entry for this part is included; verify repair scope on inspection',
            _gateGenerated: true,
          });
        }
        continue;
      }
      usedVerdicts.add(vKey);
      gatedParts.push(rp);
      continue;
    }
    // Batch 81 §1 (Vincent): a DISAGREE panel is NOT stripped. Some views saw damage, some saw it
    // clean — the engine must not silently resolve that; it costs the row at its reconciled/table price
    // and surfaces the disagreement as an inspection flag (already pushed by amalgamate), and the buyer
    // rules. A silent deletion would corrupt the repair total, the profit window and the bid ceiling
    // with no trace on the page; a costed-but-flagged row is visible and challengeable. iv stays false
    // (unconfirmed) — the _amalgDisagree marker on the verdict is what distinguishes this from a
    // per-view CLEAR (iv:false, _perViewClear), which still strips. The §2 invariant (in route.js)
    // backstops the paired flag in case a downstream splice removed it.
    if (verdict._amalgDisagree) {
      gatedParts.push({ ...rp, _disagreeCosted: true });
      console.log(`[GATE][DISAGREE] "${rp.name}" kept costed at £${rp.used ?? rp.oem} (per-view disagreement — flagged, not stripped)`);
      continue;
    }
    gateStripped.push(verdict);
  }
  for (const v of gateStripped) {
    if (v._perViewClear) {
      console.log(`[GATE][PER-VIEW-CLEAR] "${v.partName}" confirmed undamaged across all resolving views — no flag`);
      continue;
    }
    const ivLabel = v.independentlyVisible === false ? 'iv=false' : 'iv=null(ambiguous)';
    console.log(`[GATE] stripped "${v.partName}" zone=${v.zone} ${ivLabel}`);
    if (!flaggedParts.some(f => normName(f.partName) === normName(v.partName))) {
      const isRQ = /\brear\b.*\bquarter\b/i.test(v.partName);
      const reason = v._bumperOffStripped
        ? BUMPER_OFF_SEAM_REASON + (isRQ ? ' Inner structural integrity not visible from exterior shots — confirm on the WhatsApp inspection before bidding.' : '')
        : 'excluded from repair total — not independently confirmed on its own shots; verify on the WhatsApp inspection before bidding';
      flaggedParts.push({
        partName: v.partName, zone: v.zone, weight: 'medium',
        reason,
        _gateGenerated: true,
        ...(v._bumperOffStripped ? { _bumperOffStripped: true } : {}),
      });
    }
  }
  return { gatedParts, gateAllowanceParts, blockAbsent };
}

// Post-gate instrumentation: lamp_delta / lamp_inserted describe the rows
// actually inside parts_sum — reality, never assumption (A3).
export function finalizeLampInstrumentation(gatedParts, lampResult) {
  // S5-1 proof surface — count mandated (non-allowance) lamp £ rows ACTUALLY in gatedParts on EVERY
  // path, incl. tier-1/orphan (which the tier2-gated block below skips). _lampMandated covers every
  // lamp £ in the money (verified: specLampBand always numeric → orphan clamp always flags). True
  // double-count detector; lamp_count stays geometric intent.
  const mandated = gatedParts.filter(p => p._lampMandated);
  const lamp_money_rows = mandated.length;
  const orphan_collapse = !lampResult?.tier2Fired && lamp_money_rows > 1; // tier-1 clamp touched >1 lamp line
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    return { lamp_delta: 0, lamp_inserted: false, lamp_count: 0, lamp_money_rows, orphan_collapse };
  }
  const lamp_delta    = mandated.reduce((acc, p) => acc + ((p.used ?? p.oem ?? 0) - (p._modelLampCost ?? 0)), 0);
  const lamp_inserted = mandated.some(p => p._inserted);
  return { lamp_delta, lamp_inserted, lamp_count: lampResult.lampCount ?? 1, lamp_money_rows, orphan_collapse };
}

// VDS per-part block parser. Splits "PART: name\nprose" blocks from freeform text.
// Returns { preamble, parts: [{ partName, prose }] }. When no PART: blocks are
// present, parts is empty and preamble holds the full text — caller falls back to
// rendering the raw string unchanged.
export function parseVdsParts(text) {
  if (!text) return { preamble: '', parts: [] };
  const segments = text.split(/\n+(?=PART:\s)/);
  let preamble = '';
  const parts = [];
  for (const seg of segments) {
    const trimmed = seg.trimStart();
    if (trimmed.startsWith('PART:')) {
      const nlIdx = trimmed.indexOf('\n');
      const headerLine = nlIdx >= 0 ? trimmed.slice(0, nlIdx) : trimmed;
      const prose = nlIdx >= 0 ? trimmed.slice(nlIdx + 1).trim() : '';
      const partName = headerLine.slice('PART:'.length).trim();
      if (partName) parts.push({ partName, prose });
    } else {
      preamble = seg.trim();
    }
  }
  return { preamble, parts };
}

// Reassembles a parsed VDS back to string after scrub. Called only when at least
// one block was reframed; when no scrub occurs the original string is kept as-is.
export function reassembleVds(preamble, parts) {
  const sections = [];
  if (preamble) sections.push(preamble);
  for (const { partName, prose } of parts) {
    sections.push('PART: ' + partName + (prose ? '\n' + prose : ''));
  }
  return sections.join('\n\n');
}

// Code-assembled Visible Damage Summary (Step 4c). Replaces the model-authored
// per-panel PART: prose entirely — there is no model text in the per-panel path.
// COSTED PANELS ONLY: one block per real repair line item (gatedParts → action + the
// finalised band-derived figure). Floored/flagged panels belong to Inspection Flags and
// nowhere else — one panel, one surface — so they are NOT pulled in here (4c-fix). CLEAR
// panels are omitted; labour/paint is skipped. Returns [{ panelId, partName, action, prose }].
//
// Source is the FINALISED ledger: gatedParts (post reconcile + visibility gate, so the
// figure matches the repair total). costedLedger supplies the MISSING (absent) marker.
// Reads no model prose.
export function assembleVdsParts(costedLedger, gatedParts) {
  const out   = [];
  const money = n => n != null ? `£${Number(n).toLocaleString('en-GB')}` : null;

  // Ledger determination lookup — marks which costed panels were MISSING (absent).
  const ledgerByPanel = new Map();
  for (const cp of (costedLedger || [])) if (cp.panelId != null) ledgerByPanel.set(cp.panelId, cp);

  // One block per real repair line item — action + finalised figure. Skip labour/paint.
  for (const gp of (gatedParts || [])) {
    if (/labour|paint|prep/i.test(gp.name)) continue;
    if (gp._structFloor) continue;   // batch 106: the £500 jig FLOOR is inferred inspection-class, not
                                     // visible damage — it lives in the parts table + inspection flag, never here as a figure.
    const figure = money(gp.used ?? gp.oem ?? null);
    const led    = gp.panelId != null ? ledgerByPanel.get(gp.panelId) : null;
    const verb   = gp.action === 'repair' ? 'Repair' : 'Replace';
    const prose  = (led?._amalgMissing || gp._inserted)
      ? (figure ? `Not present in the listing photos — replace, ${figure}.` : 'Not present in the listing photos — replace.')
      : (figure ? `${verb} — ${figure}.` : `${verb}.`);
    out.push({ panelId: gp.panelId ?? null, partName: gp.name, action: gp.action ?? 'replace', prose });
  }

  return out;
}

// 4d — code-assembled Key Cost Drivers. The finalised repair lines that carry a real figure,
// ordered biggest-ticket first — the ledger IS the driver list, no model figures. Demoted/floored
// parts are absent from gatedParts by construction, so they can never appear here (this is what the
// retired KCD scrub used to enforce). Mirrors assembleVdsParts; reads no model prose.
export function assembleKcdParts(gatedParts) {
  const money = n => `£${Number(n).toLocaleString('en-GB')}`;
  return (gatedParts || [])
    .filter(gp => !/labour|paint|prep/i.test(gp.name))
    .filter(gp => !gp._structFloor)   // batch 106: the £500 jig floor is not a "cost driver" figure
    .map(gp => ({ panelId: gp.panelId ?? null, partName: gp.name, action: gp.action ?? 'replace', figure: gp.used ?? gp.oem ?? null }))
    .filter(r => r.figure != null && r.figure > 0)
    .sort((a, b) => b.figure - a.figure)
    .map(r => ({ ...r, prose: `${r.partName} — ${r.action === 'repair' ? 'repair' : 'replace'}: ${money(r.figure)}` }));
}

// ── 4d/4e — claim-class binder ───────────────────────────────────────────────────────────────
// Binds narrative claims to the finalised ledger across FIVE claim classes (lamp type / figures /
// action word / part status / EV verdict). A sentence that POSITIVELY CONTRADICTS a class is
// DROPPED WHOLE — never reworded (a reworded lamp claim can become a wrong cost claim). Judgement
// and speculation that do not contradict are preserved. In 'speculation' mode (Alt Scenario /
// Bidder Note) a hedged sentence is spared entirely; 'redflags' mode drops on a plain assertive
// contradiction. Every detector fails OPEN (any doubt → keep). Returns
// { text, dropped:[{class, reason, sentence}] } for loud logging and _narrativeBindings provenance.
const _CLAIM_HEDGE = /\b(may|might|could|possibl[ey]|perhaps|potential(ly)?|likely|appears?|seems?|suggests?|assum\w+|uncertain|unconfirmed|if\s)\b/i;
const _CLAIM_REPAIR_CTX = /\b(repair|replac|parts?|fix|bill|rebuild|refinish|estimate|repair total|cost to)\b/i;
function _splitSentences(s) {
  return (s.match(/[^.!?]+[.!?]*/g) || [s]).map(x => x.trim()).filter(Boolean);
}
function _escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _sentenceContradicts(sentence, ctx, mode) {
  const s = sentence;
  const spareHedge = mode === 'speculation' && _CLAIM_HEDGE.test(s);
  if (spareHedge) return null;

  // Class 1 — LAMP TYPE vs the code-owned band type.
  if (ctx.lampType && /\b(head\s?lamp|headlight|lamp unit|xenon|hid|led|halogen)\b/i.test(s)) {
    const asserted = /\bLED\b/i.test(s) ? 'led'
      : /\b(HID|xenon)\b/i.test(s) ? 'hid'
      : /\bhalogen\b/i.test(s) ? 'halogen' : null;
    if (asserted && asserted !== ctx.lampType) return { class: 'lamp-type', reason: `asserts ${asserted}; code-owned band is ${ctx.lampType}` };
  }
  // Class 2 — FIGURES vs the parts table / reconciled total (± exit value), ±£1 rounding tolerance.
  // redflags mode: strict — any £ not in the ledger set is a fabricated repair figure. speculation
  // mode: only in a repair-cost context, so legitimate market / exit / profit figures are preserved.
  if (mode === 'redflags' || _CLAIM_REPAIR_CTX.test(s)) {
    const figs = [...s.matchAll(/£\s?([\d][\d,]*(?:\.\d+)?)/g)].map(m => Number(m[1].replace(/,/g, '')));
    for (const f of figs) {
      if (Number.isFinite(f) && !ctx.allowedFigures.some(a => Math.abs(a - f) <= 1)) return { class: 'figure', reason: `£${f} not in the ledger/total set` };
    }
  }
  // Class 3 — ACTION WORD vs the row's action.
  for (const [name, action] of ctx.partActions) {
    if (!name) continue;
    if (new RegExp(`\\b${_escapeRx(name)}\\b`, 'i').test(s)) {
      const saysRepair  = /\brepair(ed|s|ing)?\b/i.test(s);
      const saysReplace = /\breplac(e|ed|es|ing|ement)\b/i.test(s);
      if (saysRepair && !saysReplace && action === 'replace') return { class: 'action', reason: `says repair; "${name}" row action is replace` };
      if (saysReplace && !saysRepair && action === 'repair')  return { class: 'action', reason: `says replace; "${name}" row action is repair` };
    }
  }
  // Class 4 — PART STATUS: a demoted / uncosted / floored part asserted as damaged or a cost driver.
  for (const name of ctx.demoted) {
    if (name && new RegExp(`\\b${_escapeRx(name)}\\b`, 'i').test(s)
      && /\b(damag|costl?y|cost driver|biggest|expensive|replac|repair|write[- ]?off|structural)\b/i.test(s)) return { class: 'part-status', reason: `"${name}" is demoted/uncosted in the ledger` };
  }
  // Class 5 — EV CLAIMS vs the stamped _evCoolingHvVerdict.
  if (ctx.evVerdict && /\b(battery|hv|high[- ]voltage|traction (?:pack|battery)|ev[- ]system)\b/i.test(s)) {
    const saysIntact = /\b(intact|fine|sound|healthy|serviceable|present and (?:live|intact)|no (?:issue|damage|concern|fault))\b/i.test(s);
    const saysDead   = /\b(destroyed|crushed|holed|missing|gone|dead|scrap|cost[- ]prohibitive|write[- ]?off|beyond repair)\b/i.test(s);
    if (ctx.evVerdict === 'cost-prohibitive' && saysIntact) return { class: 'ev', reason: 'asserts pack sound; verdict is cost-prohibitive' };
    if (ctx.evVerdict === 'clear'            && saysDead)   return { class: 'ev', reason: 'asserts pack damaged/missing; verdict is clear' };
  }
  return null;
}
export function bindClaimClasses(text, ctx, mode = 'redflags') {
  const dropped = [];
  if (!text || typeof text !== 'string') return { text: text || '', dropped };
  const keptLines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { keptLines.push(line); continue; }
    const bulletM = line.match(/^(\s*[-*•]?\s*)([\s\S]*)$/);
    const prefix = bulletM ? bulletM[1] : '';
    const body   = bulletM ? bulletM[2] : line;
    const kept = [];
    for (const sent of _splitSentences(body)) {
      const hit = _sentenceContradicts(sent, ctx, mode);
      if (hit) { dropped.push({ class: hit.class, reason: hit.reason, sentence: sent }); continue; }
      kept.push(sent);
    }
    if (kept.length === 0) continue; // whole line was contradictory → drop the line
    keptLines.push(prefix + kept.join(' ').trim());
  }
  const out = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, dropped };
}

// Builds the buyer-facing Inspection Flags list from stored assessment data.
// Filters _amalgDisagree floors to only those the main assessment call implicated
// (panel present in _preGateParts). Non-DISAGREE entries (_amalgNotVisible,
// _amalgMissing, _gateGenerated) pass through untouched.
// Fail-open: if _preGateParts is absent or empty, returns all flags — a silent
// empty list is worse than a noisy one.
export function buildBuyerFlags(assessment) {
  const all      = assessment._flaggedParts || [];
  const preGate  = assessment._preGateParts || [];
  // DISAGREE filter — behaviour UNCHANGED (ruled correct, option A): an _amalgDisagree floor survives
  // only if the main assessment call implicated the panel (present in _preGateParts). Fail-open on
  // empty preGate. 4f C-4 adds PROVENANCE ONLY: each hidden flag is logged [FLAG SUPPRESS DISAGREE]
  // and stamped into assessment._suppressedFlags (assigned every call → idempotent; the server-side
  // seed call at route.js persists it to JSONB). The keep/drop decision below is byte-identical.
  const preGatePanelIds = new Set(preGate.map(p => p.panelId).filter(Boolean));
  const _disagreeDropped = [];
  const disagreeFiltered = preGate.length === 0
    ? all
    : all.filter(f => {
        const keep = !f._amalgDisagree || preGatePanelIds.has(f.panelId);
        if (!keep) {
          _disagreeDropped.push({ panelId: f.panelId, partName: f.partName, zone: f.zone, weight: f.weight, filter: 'disagree', reason: 'per-view disagreement not corroborated by the main assessment call (panel absent from _preGateParts)' });
          console.log(`[FLAG SUPPRESS DISAGREE] dropped ${f.panelId} (${f.partName}) zone=${f.zone} weight=${f.weight} — uncorroborated per-view disagreement; not in _preGateParts`);
        }
        return keep;
      });
  assessment._suppressedFlags = _disagreeDropped;

  // ── Zone-aware not-visible suppression (Task 6) ──────────────────────────────────────────
  // Drops a buyer flag ONLY when EVERY condition below holds; otherwise the flag is KEPT.
  //   (a) assessment._suppressActive — the server sets this TRUE only on a confidently SINGLE
  //       struck zone that is not the roof. Multi-zone (≥2), rollover (roof struck), or
  //       no-known-zone → FALSE → this whole block is a no-op (fail-open: when in doubt, KEEP).
  //   (b) the flag is an _amalgNotVisible "couldn't see it" ask (the only noise type in scope).
  //   (c) weight is low or medium — a high-weight flag is NEVER suppressed.
  //   (d) panelId is not ROOF — rollover hard-exempt regardless of zone/weight.
  //   (e) panelId is not a STRUCTURAL_FLAG-class chassis member (FRONT/REAR/SIDE_STRUCTURE).
  //       The not-visible floor stamps EVERY panel 'medium', so the weight ceiling does NOT
  //       protect structural panels — they need this explicit class exemption.
  //   (f) panelId is not EV_BATTERY_ZONE — HV battery integrity is never silently dropped.
  //   (g) the flag's zone took NO damage (zone ∉ the struck-zone set).
  // SLAM_PANEL is deliberately NOT exempt: it is a bolt-on front panel, so on any lot where it
  // could be structural the FRONT zone was struck and suppression cannot fire (unstruck-only).
  // Amalgamate floor logic is untouched — this only filters what reaches the buyer; drops are logged.
  if (assessment._suppressActive !== true) return disagreeFiltered;
  const struck = new Set(assessment._struckZones || []);
  return disagreeFiltered.filter(f => {
    const suppress =
      f._amalgNotVisible === true &&
      (f.weight === 'low' || f.weight === 'medium') &&
      f.panelId !== PANEL.ROOF &&
      PANEL_BEHAVIOUR[f.panelId] !== PANEL_CLASS.STRUCTURAL_FLAG &&
      f.panelId !== PANEL.EV_BATTERY_ZONE &&
      !struck.has(f.zone);
    if (suppress) console.log(`[FLAG SUPPRESS] dropped ${f.panelId} (${f.partName}) zone=${f.zone} weight=${f.weight} — unstruck-zone not-visible; struck=[${[...struck].join(', ')}]`);
    return !suppress;
  });
}
