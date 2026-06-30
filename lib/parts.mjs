import { PANEL_PRICE_TABLE } from './priceBand.mjs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS } from './panelEnum.mjs';

// Parts money path — lamp reconciliation, visibility gate, instrumentation.
// Lifted from app/api/salvage/assess/route.js (CB7 fix, 12 Jun 2026) so the
// regression harness (scripts/replay-lamp-fix.mjs) imports the literal shipped
// functions: tested path = shipped path. .mjs because the repo has no
// "type":"module" — raw node must load this file alongside Next.
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

export function reconcileParts(parts, lampResult, costedParts = [], grilleAllowance = 0, bandKey = null) {
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    // Prose-authority fail-safe: on a tier-1 lot the prompt tells the model to omit
    // the headlamp line when VDS confirms the lamp intact. Log loudly if one slips through;
    // do NOT strip — code cannot distinguish an intact-but-orphaned line from a
    // legitimate uncertain/cannot-confirm line without parsing prose. Prompt is primary.
    const orphanLampIdx = parts.reduce((acc, p, i) => { if (isLampLine(p.name)) acc.push(i); return acc; }, []);
    if (orphanLampIdx.length > 0) {
      console.error(`[LAMP ORPHAN] ${orphanLampIdx.length} headlamp line(s) on tier-1 lot — NOT stripped (cannot distinguish intact/uncertain from prose alone). Investigate if this appears on a real lot.`);
      // fall through — keep the line; prompt is the primary enforcement layer
    }
    return { parts: applyTableOverride(parts, bandKey), allowanceParts: [] };
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
      // Reconcile the kept lamp into parts_sum (priced at max(model cost, band))
      const cost0      = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      const effective0 = Math.max(cost0, band);
      workParts        = workParts.map((item, i) => i === keepIdx ? mandate(item, cost0, effective0, keptOrdinal) : item);

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
      const modelCost = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      const effective = Math.max(modelCost, band);
      workParts       = workParts.map((item, i) => i === keepIdx ? mandate(item, modelCost, effective, keptOrdinal) : item);
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
    return { gatedParts: reconciledParts, blockAbsent };
  }
  const gateStripped = [];
  const gatedParts = [];
  const usedVerdicts = new Set();
  for (const rp of reconciledParts) {
    if (rp._grilleMandated) { gatedParts.push(rp); continue; }
    const verdict = (rp._lampMandated || rp._lampOrdinal != null)
      ? lampVerdictFor(costedParts, rp.name, rp._lampOrdinal ?? null)
      : costedParts.find(cp => cp.panelId === rp.panelId)
          ?? null;
    if (rp._lampMandated) {
      // Lamp money is code-mandated (A1): the row is never removed. iv===true
      // keeps max(cost, band); anything else (iv=false / iv=null / no verdict)
      // strips only the unconfirmed model pricing above band — Q1 clamp.
      if (verdict && verdict.independentlyVisible === true) { gatedParts.push(rp); continue; }
      gatedParts.push({ ...rp, used: rp._band, oem: null });
      console.log(`[GATE][LAMP] "${rp.name}" iv≠true — model pricing clamped to band £${rp._band}; band retained in repair total`);
      const lampType = lampResult?.lampType ?? 'led';
      if (!flaggedParts.some(f => normName(f.partName) === normName(rp.name) && f._gateGenerated)) {
        flaggedParts.push({
          partName: rp.name, zone: 'front', weight: 'medium',
          reason: `model's lamp pricing not independently confirmed — precautionary £${rp._band} (${lampType.toUpperCase()}) allowance retained in repair total; confirm serviceable unit on inspection`,
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
  return { gatedParts, blockAbsent };
}

// Post-gate instrumentation: lamp_delta / lamp_inserted describe the rows
// actually inside parts_sum — reality, never assumption (A3).
export function finalizeLampInstrumentation(gatedParts, lampResult) {
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    return { lamp_delta: 0, lamp_inserted: false, lamp_count: 0 };
  }
  const mandated = gatedParts.filter(p => p._lampMandated);
  const lamp_delta    = mandated.reduce((acc, p) => acc + ((p.used ?? p.oem ?? 0) - (p._modelLampCost ?? 0)), 0);
  const lamp_inserted = mandated.some(p => p._inserted);
  return { lamp_delta, lamp_inserted, lamp_count: lampResult.lampCount ?? 1 };
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

// Builds the buyer-facing Inspection Flags list from stored assessment data.
// Filters _amalgDisagree floors to only those the main assessment call implicated
// (panel present in _preGateParts). Non-DISAGREE entries (_amalgNotVisible,
// _amalgMissing, _gateGenerated) pass through untouched.
// Fail-open: if _preGateParts is absent or empty, returns all flags — a silent
// empty list is worse than a noisy one.
export function buildBuyerFlags(assessment) {
  const all      = assessment._flaggedParts || [];
  const preGate  = assessment._preGateParts || [];
  // Existing DISAGREE filter (UNCHANGED): an _amalgDisagree floor survives only if the main
  // assessment call implicated the panel (present in _preGateParts). Fail-open on empty preGate.
  const preGatePanelIds = new Set(preGate.map(p => p.panelId).filter(Boolean));
  const disagreeFiltered = preGate.length === 0
    ? all
    : all.filter(f => !f._amalgDisagree || preGatePanelIds.has(f.panelId));

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
