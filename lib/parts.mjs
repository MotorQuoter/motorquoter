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

// Batch 103 (Vincent, 1 Sep 2026): the BUMPER_OFF_* buyer strings are removed with the
// demote they belonged to. The bumper's state no longer suppresses any part, so no panel is
// ever stripped "because the bumper is off"; §4 in the route states the limit on a COSTED
// panel instead. The gate strip-reason below is now the single neutral not-confirmed string.

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

  const mandate = (row, modelCost, effective, ordinal, pair = false) => ({
    ...row, oem: null, used: effective,
    _lampMandated: true, _band: band, _modelLampCost: modelCost, _lampOrdinal: ordinal,
    ...(pair ? { _lampPair: true } : {}),
  });
  // batch 109 task C — `ordinal` is now a parameter. An inserted second-corner lamp must pair to the
  // SAME verdict as the kept row, or the gate could cost one lamp and shelve the other; see the
  // lampCount===2 block below. Default null preserves the previous single-inserted-row behaviour.
  const insertedRow = (ordinal = null, pair = false) => ({
    name: 'Headlamp', action: 'replace', oem: null, used: band,
    _inserted: true, _lampMandated: true, _band: band, _modelLampCost: null, _lampOrdinal: ordinal,
    ...(pair ? { _lampPair: true } : {}),
  });

  if (lampCount === 2) {
    // ── batch 109 task C — VINCENT'S RULING, 10 Sep 2026 ────────────────────────────────────────
    // On a full-width front hit BOTH headlamps go in the repair total, each at the band price, and
    // no lamp allowance row is emitted. Previously this block costed exactly one lamp and shelved
    // the second as an inspection allowance "excluded from repair total BY DESIGN" — so on the six
    // full-width lots in the corpus the buyer was quoted one lamp for a two-lamp impact.
    //
    // WHY BOTH ROWS CARRY THE SAME _lampOrdinal: the visibility gate decides a mandated lamp's fate
    // from lampVerdictFor(costedParts, name, _lampOrdinal) — k-th row pairs with k-th lamp VERDICT.
    // coreObs.costedParts is amalgamate's output and amalgamate pools by panelId, so there is only
    // ever ONE HEADLAMP verdict. Giving the second row its own ordinal would send it down the
    // out-of-range normName fallback — same answer today, but by coincidence, not by construction.
    // Pinning both rows to keptOrdinal makes "the gate treats them identically" a property of the
    // code rather than of the current shape of the data.
    //
    // A1 on this pair: 109C left A1 in force (iv≠true → both lamps shelved together). Batch 111 task 3
    // (Vincent, 11 Sep) REVERSED that for this pair only — both stay costed at band and a strike-the-line
    // limit flag is raised. The scoped exception lives in applyVisibilityGate; A1 governs everything else.
    if (lampIndices.length >= 1) {
      // Reconcile the kept lamp into parts_sum. The band OWNS the price (single-owner invariant):
      // the model figure never prices a headlamp row — it is retained only as _modelLampCost for
      // the lamp_delta instrumentation. (Was max(model, band); model could win when model > band.)
      const cost0 = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      if (cost0 !== band) console.log(`[LAMP][BAND] "${workParts[keepIdx].name}" model £${cost0} → band £${band} (band owns)`);
      workParts   = workParts.map((item, i) => i === keepIdx ? mandate(item, cost0, band, keptOrdinal, true) : item);

      const others = lampIndices.filter(i => i !== keepIdx);
      if (others.length >= 1) {
        // Model priced ≥2 lamps: the SECOND is now mandated at band and KEPT in the money.
        const secondIdx = others[0];
        const cost1 = workParts[secondIdx].used ?? workParts[secondIdx].oem ?? 0;
        if (cost1 !== band) console.log(`[LAMP][BAND] "${workParts[secondIdx].name}" model £${cost1} → band £${band} (band owns)`);
        workParts = workParts.map((item, i) => i === secondIdx ? mandate(item, cost1, band, keptOrdinal, true) : item);
        console.log(`[LAMP][PAIR-COST] second headlamp costed at band £${band} — included in the repair total (batch 109C ruling)`);
        // A THIRD or later model lamp line is not a third headlamp — a car has two, and the count is
        // code-owned (lampCount). It is dropped from the money and NOT shelved as an allowance (this
        // block emits none). Loud, because a silently vanished priced row is the defect this project
        // keeps finding. Never observed on the 14-lot corpus: no stored lot has >1 model lamp row.
        const extras = others.slice(1);
        if (extras.length > 0) {
          for (const n of extras) {
            console.warn(`[LAMP][DROP] third-or-later model lamp line "${workParts[n].name}" (£${workParts[n].used ?? workParts[n].oem ?? 0}) removed — a vehicle has two headlamps and lampCount is code-owned at 2`);
          }
          const toRemove = new Set(extras);
          workParts = workParts.filter((_, i) => !toRemove.has(i));
        }
      } else {
        // Model priced exactly 1 lamp — INSERT the second as a COSTED row (was: an allowance row).
        const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
        const at = labourIdx >= 0 ? labourIdx : workParts.length;
        workParts = [...workParts.slice(0, at), insertedRow(keptOrdinal, true), ...workParts.slice(at)];
        console.log(`[LAMP][PAIR-COST] second-corner "Headlamp" inserted at band £${band} — included in the repair total (batch 109C ruling)`);
      }
    } else {
      // Model priced 0 lamps — insert TWO costed rows (same band, one type-read). Both carry
      // _lampOrdinal null, so both take the identical normName fallback in the gate.
      const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), insertedRow(null, true), insertedRow(null, true), ...workParts.slice(at)];
      console.log(`[LAMP][PAIR-COST] both headlamps inserted at band £${band} each — included in the repair total (batch 109C ruling)`);
    }
  } else {
    // lampCount === 1: mandate exactly one lamp, no allowance row
    if (lampIndices.length >= 1) {
      // Band OWNS the price (single-owner invariant): model figure never prices the row, kept only
      // as _modelLampCost. (Was max(model, band).)
      const modelCost = workParts[keepIdx].used ?? workParts[keepIdx].oem ?? 0;
      if (modelCost !== band) console.log(`[LAMP][BAND] "${workParts[keepIdx].name}" model £${modelCost} → band £${band} (band owns)`);
      workParts       = workParts.map((item, i) => i === keepIdx ? mandate(item, modelCost, band, keptOrdinal) : item);

      // ── batch 112 task 1 — VINCENT, 11 Sep: BAND the surplus lamp row ─────────────────────────────
      // Call 1 priced a second headlamp on a lot its own damageSpan reads as one corner. That is an
      // unresolved conflict that moves money, so the batch-106 £0 rule governs: cost it at band, state the
      // limit (the gate raises LAMP_SURPLUS_LIMIT_REASON), let the buyer strike it — never £0, never a
      // model price. Pinned to keptOrdinal so the gate treats it exactly as the kept row (109C reasoning).
      // THE GUARD: only a row whose panelId is genuinely HEADLAMP is band-priced. isLampLine also matches
      // "Headlamp bracket" / "washer jet" / "bulb" — a £40 bracket must never bill at £350 — so a lamp-named
      // row with no HEADLAMP panelId is left exactly as it is, and the [LAMP MONEY][NOT BAND-OWNED] line
      // reports it. The band owns every HEADLAMP pound; it does not reprice a row the engine cannot name.
      // A third or later HEADLAMP row is dropped, loud, as on the pair path — a vehicle has two headlamps.
      // A surplus exists only when there are ≥2 HEADLAMP-panel rows: if the kept row were a lamp-named row
      // with no HEADLAMP panelId (a grammar break Call 1 has never produced), its single HEADLAMP row is the
      // lamp, not a second one, and must not be banded as a surplus on top of it.
      const headIdx = lampIndices.filter(i => parts[i].panelId === PANEL.HEADLAMP);
      const surplus = headIdx.length >= 2 ? headIdx.filter(i => i !== keepIdx) : [];
      if (surplus.length > 0) {
        const s = surplus[0];
        const sCost = workParts[s].used ?? workParts[s].oem ?? 0;
        workParts = workParts.map((item, i) => i === s ? { ...mandate(item, sCost, band, keptOrdinal), _lampSurplus: true } : item);
        console.log(`[LAMP][SURPLUS] second HEADLAMP line on a lampCount 1 lot — model £${sCost} → band £${band}, in the repair total with a strike-the-line limit (batch 112 ruling)`);
        const extras = new Set(surplus.slice(1));
        for (const n of extras) {
          console.warn(`[LAMP][DROP] third-or-later HEADLAMP line "${workParts[n].name}" (£${workParts[n].used ?? workParts[n].oem ?? 0}) removed — a vehicle has two headlamps`);
        }
        if (extras.size > 0) workParts = workParts.filter((_, i) => !extras.has(i));
      }
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

// batch 111 task 3 — the limit note for an unconfirmed full-width lamp pair. Same voice as the batch-103
// §4 bumper-off note (route.js), deliberately: one idea, one voice. Single owner — the gate writes it
// onto the flag, and the damage card reads the flag's reason, never a copy.
// A flag reason that tells the buyer the part carries no cost (the amalgamate no-cost families + the gate's
// own strip wording). Used only to find flags that would contradict a costed lamp pair.
const NO_COST_CLAIM = /not included in the repair (cost|total)|carries no cost|excluded from (the )?repair total/i;
export const LAMP_PAIR_LIMIT_REASON = 'Neither front headlamp could be confirmed damaged from these photographs. On a full-width frontal impact both are implicated, so each has been included in the repair total on the impact evidence — strike the line on the ledger if the inspection shows it sound.';
// batch 112 task 1 — the surplus-lamp limit note, same voice. "Neither" would be false here: on this path
// the kept lamp IS confirmed (the surplus row only reaches the money on iv:true) — it is the SECOND lamp
// that nothing confirms, and the reason it is priced at all is a conflict inside the assessment itself.
export const LAMP_SURPLUS_LIMIT_REASON = 'The assessment priced a second headlamp, but the impact reads as a single front corner and the second lamp could not be confirmed damaged from these photographs. It has been included in the repair total at the band price — strike the line on the ledger if the inspection shows it sound.';

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
      if (verdict && verdict.independentlyVisible === true) {
        gatedParts.push(bandRow);
        // batch 112 task 1: a banded surplus lamp states its limit — one flag, however many surplus rows.
        if (rp._lampSurplus && !flaggedParts.some(f => f._lampSurplusLimit)) {
          flaggedParts.push({
            partName: rp.name, zone: 'front', weight: 'medium',
            reason: LAMP_SURPLUS_LIMIT_REASON, _gateGenerated: true, _lampSurplusLimit: true,
          });
        }
        continue;
      }
      // ── batch 111 task 3 — VINCENT, 11 Sep: "Cost both lamps, and put in a line the buyer can strike out
      // if the lamp turns out sound." A SCOPED, RULED EXCEPTION to A1 — NOT a repeal of A1. It applies to
      // exactly: tier 2, lampCount === 2, _lampPair rows (the batch-109C full-width pair). Every other
      // mandated lamp — lampCount 1, the tier-1 orphan — still falls through to A1 below and leaves the
      // total. This deliberately REVERSES how 109C built the iv≠true pair (both shelved together): both now
      // stay in the money at band, and one limit flag says so and tells the buyer to strike the line.
      // Both rows pair to the same pooled HEADLAMP verdict, so iv≠true here means NEITHER lamp was
      // confirmed — the note says "neither", not "the second". Do not re-litigate without a new ruling.
      // batch 112 task 4 (Vincent, 11 Sep): NARROWED to UNCERTAINTY. The ruling meant "can't confirm it",
      // not positive evidence — a _perViewClear verdict (every view that saw the lamps judged them
      // undamaged) is NOT uncertainty, so it is excluded and falls through to A1 like any other lamp.
      if (rp._lampPair && lampResult?.tier2Fired && lampResult.lampCount === 2 && !verdict?._perViewClear) {
        gatedParts.push({ ...bandRow, _lampPairUnconfirmed: true });
        if (!flaggedParts.some(f => f._lampPairLimit)) {
          // One statement of the limit. amalgamate may already have flagged the HEADLAMP panel with a
          // NO-COST reason (cosmetic 2-vote: "not included in the repair cost"; single-MINOR: "carries no
          // cost") — beside a pair now IN the total, that flag would contradict the money. Rewrite it in
          // place (batch-106 family-A precedent), keeping its markers so the §2 invariant still sees a flag
          // for the panel. Flags that make no cost claim (not-visible, disagree) are left as they are.
          const noCost = flaggedParts.filter(f => f.panelId === PANEL.HEADLAMP && NO_COST_CLAIM.test(f.reason || ''));
          for (const f of noCost) {
            console.log(`[GATE][LAMP PAIR] HEADLAMP flag "${(f.reason || '').slice(0, 60)}…" claimed no cost beside a costed pair — reason rewritten to the pair limit`);
            f.reason = LAMP_PAIR_LIMIT_REASON;
            f._lampPairLimit = true;
          }
          if (noCost.length === 0) {
            flaggedParts.push({
              partName: rp.name, zone: 'front', weight: 'medium',
              reason: LAMP_PAIR_LIMIT_REASON, _gateGenerated: true, _lampPairLimit: true,
            });
          }
        }
        console.log(`[GATE][LAMP PAIR] "${rp.name}" iv≠true on a full-width pair — kept costed at band £${rp._band}, strike-the-line limit stated (batch 111 ruling; A1 exception)`);
        continue;
      }
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
      flaggedParts.push({
        partName: v.partName, zone: v.zone, weight: 'medium',
        reason: 'excluded from repair total — not independently confirmed on its own shots; verify on the WhatsApp inspection before bidding',
        _gateGenerated: true,
      });
    }
  }
  return { gatedParts, gateAllowanceParts, blockAbsent };
}

// batch 112 task 2 — the tier-2 assumed-lamp-type disclosure flag, or null. Raised when the lamp band fired
// (tier 2), the type was ASSUMED (indeterminate spec → LED band), and a lamp is actually in the money. One
// per lot: never alongside the tier-1 orphan disclosure or a previous tier-2 one. The sentence is passed in
// by the caller — LAMP_ASSUMED_DISCLOSURE in route.js stays its single owner; this module holds no copy.
export function tier2LampDisclosureFlag(lampResult, gatedParts, flaggedParts, disclosure) {
  if (!lampResult?.tier2Fired || lampResult.lampTypeAssumed !== true) return null;
  if (!gatedParts.some(gp => gp._lampMandated)) return null;
  if (flaggedParts.some(f => f._orphanLampDisclosure || f._tier2LampDisclosure)) return null;
  return { partName: 'Headlamp', zone: 'front', weight: 'medium', reason: disclosure, _tier2LampDisclosure: true, _gateGenerated: true };
}

// Post-gate instrumentation: lamp_delta / lamp_inserted describe the rows
// actually inside parts_sum — reality, never assumption (A3).
// A headlamp row, however it got there: code-owned (_lampMandated), keyed to the HEADLAMP panel, or named
// like a lamp. Deliberately wider than _lampMandated — this is what the counter must SEE, not what the band
// owns; widening "mandated" instead would hide an unowned row rather than count it. The name test is also
// wider than isLampLine, which misses plurals ("Headlamps (pair)", "Headlights", "Head light"): a free-text
// row like that gets no panelId from parseParts, passes the gate unchecked at the model price, and would be
// invisible to a counter built on isLampLine alone. isLampLine itself is NOT changed — it routes money.
const LAMP_NAME_FOR_COUNT = /\bhead[\s-]?(?:lamp|light)s?\b|\bfront\s+lamps?\b/i;
const isLampMoneyRow = p => p?._lampMandated === true || p?.panelId === PANEL.HEADLAMP || isLampLine(p?.name || '') || LAMP_NAME_FOR_COUNT.test(p?.name || '');

export function finalizeLampInstrumentation(gatedParts, lampResult) {
  // S5-1 proof surface — count the lamp £ rows ACTUALLY in gatedParts (= parts_sum) on EVERY path,
  // incl. tier-1/orphan (which the tier2-gated block below skips). batch 111 task 1a: this used to count
  // _lampMandated rows only, on the belief that _lampMandated covers every lamp £ in the money. It does
  // not: on a lampCount===1 tier-2 lot where the model prices two headlamp lines, the second passes the
  // gate unmandated at the MODEL price and the old count reported 1 with 2 in the money. lamp_delta and
  // lamp_inserted still describe the mandated rows (they are band-vs-model instrumentation); lamp_count
  // stays geometric intent.
  const mandated = gatedParts.filter(p => p._lampMandated);
  const lamp_money_rows = gatedParts.filter(isLampMoneyRow).length;
  const orphan_collapse = !lampResult?.tier2Fired && lamp_money_rows > 1; // tier-1 clamp touched >1 lamp line
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    return { lamp_delta: 0, lamp_inserted: false, lamp_count: 0, lamp_money_rows, orphan_collapse };
  }
  const lamp_delta    = mandated.reduce((acc, p) => acc + ((p.used ?? p.oem ?? 0) - (p._modelLampCost ?? 0)), 0);
  const lamp_inserted = mandated.some(p => p._inserted);
  return { lamp_delta, lamp_inserted, lamp_count: lampResult.lampCount ?? 1, lamp_money_rows, orphan_collapse };
}

// The [LAMP MONEY] >1-row diagnostic, classified (batch 110 task 1). Returns null at ≤1 mandated lamp
// row — the rows_in_money line already reports that count — else { level, line }, never silent on >1.
// S5-1 (9 Jul) called every tier-2 lot with >1 mandated lamp row "INVARIANT BROKEN … structurally
// impossible". That was true when written: tier-2 put at most ONE lamp in the money and shelved the
// second corner as an allowance. Batch 109C (Vincent, 10 Sep) made two the DESIGNED outcome on a
// lampCount===2 lot, so the old text fired as a breach on every full-width lot. The invariant is now:
// on tier-2, mandated lamp rows ≤ lampCount, and two is legitimate only as the 109C pair — exactly 2
// rows, both _lampPair. Anything else on tier-2 is still a breach and still warns.
// batch 111 task 1a: checked FIRST, at any count — a lamp row in the money that the band does not own
// breaks "the band owns every headlamp pound". It warns even when it is the only lamp row.
// batch 112 task 1 splits the unowned case in two, because only one of them is a breach. A HEADLAMP-panel
// row at a non-band price breaks "the band owns every headlamp pound" — after the surplus ruling nothing
// should produce it. A lamp-NAMED row with no HEADLAMP panelId is deliberately NOT repriced (it may be a
// bracket or a bulb — the engine cannot name it), so it is reported as UNIDENTIFIED, not as a breach.
export function classifyLampMoneyRows(gatedParts, lampResult, spanSource) {
  const rows = gatedParts.filter(isLampMoneyRow);
  const unowned = rows.filter(p => !p._lampMandated);
  if (unowned.length > 0) {
    const figs = arr => arr.map(p => `"${p.name}" £${p.used ?? p.oem ?? 0}`).join(', ');
    const head = unowned.filter(p => p.panelId === PANEL.HEADLAMP);
    const unnamed = unowned.filter(p => p.panelId !== PANEL.HEADLAMP);
    const ctx = `tier2=${!!lampResult?.tier2Fired} lampCount=${lampResult?.lampCount ?? 'n/a'}; span_source=${spanSource}.`;
    if (head.length > 0) {
      return { level: 'warn', line: `[LAMP MONEY][NOT BAND-OWNED] ${rows.length} lamp row(s) in parts_sum, ${head.length} NOT band-owned (${figs(head)})${unnamed.length ? `, plus ${unnamed.length} unidentified (${figs(unnamed)})` : ''} — INVARIANT BROKEN: the band owns every headlamp pound; ${ctx}` };
    }
    return { level: 'warn', line: `[LAMP MONEY][UNIDENTIFIED] ${rows.length} lamp row(s) in parts_sum, ${unnamed.length} lamp-named with no HEADLAMP panelId (${figs(unnamed)}) — left at the model price, NOT repriced: the engine cannot show it is a headlamp (it may be a bracket or a bulb); ${ctx}` };
  }
  const mandated = rows;
  const n = mandated.length;
  if (n <= 1) return null;
  if (!lampResult?.tier2Fired) {
    return { level: 'warn', line: `[LAMP MONEY][ORPHAN COLLAPSE] ${n} lamp rows in parts_sum — orphan-collapse (non-tier2 path — S5-2 target); span_source=${spanSource}.` };
  }
  const lampCount = lampResult.lampCount ?? 1;
  if (lampCount === 2 && n === 2 && mandated.every(p => p._lampPair === true)) {
    return { level: 'log', line: `[LAMP MONEY][PAIR] ${n} lamp rows in parts_sum — full-width pair (lampCount=2), both headlamps costed at band as ruled 10 Sep (batch 109C); expected, not a breach; span_source=${spanSource}.` };
  }
  if (lampCount === 1 && n === 2 && mandated.filter(p => p._lampSurplus === true).length === 1) {
    return { level: 'log', line: `[LAMP MONEY][SURPLUS] ${n} lamp rows in parts_sum — lampCount=1 lot where the assessment priced a second HEADLAMP line; banded and limit-stated as ruled 11 Sep (batch 112); expected, not a breach; span_source=${spanSource}.` };
  }
  return { level: 'warn', line: `[LAMP MONEY][ORPHAN COLLAPSE] ${n} lamp rows in parts_sum — tier2-anomaly (INVARIANT BROKEN: ${n} mandated lamp rows on a lampCount=${lampCount} path; the only sanctioned >1 cases are the batch-109C full-width pair (exactly 2 rows, both _lampPair) and the batch-112 surplus (lampCount 1, exactly 2 rows, one _lampSurplus)); span_source=${spanSource}.` };
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
    // batch 112 task 3 (Vincent, 11 Sep): the pair guard goes FIRST. A _lampPair row is costed because the
    // impact is full-width, not because a photo showed its lamp absent — and every HEADLAMP row shares ONE
    // pooled ledger verdict, so a "missing" on that verdict cannot be pinned to either instance. Same for a
    // batch-112 _lampSurplus row. Those rows never claim "Not present in the listing photos" (the claim
    // 109C already removed from the damage cards). Every other row keeps the wording exactly as before.
    const prose  = !gp._lampPair && !gp._lampSurplus && (led?._amalgMissing || gp._inserted)
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
