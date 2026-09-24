import { PANEL_PRICE_TABLE } from './priceBand.mjs';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS, EV_PANEL_RESOLVED_CLASS, PANEL_DISPLAY } from './panelEnum.mjs';
import { isStructureFloorPanel } from './structureFloor.mjs';
import { rowKeyFor, isChargedRow } from './ledgerEdits.mjs';
import { REPAIR_NO_PART_NOTE, isNonPartRow, isFromFigureRow, Q4_DECLINED_CHECKLIST_ITEM } from './labour.mjs';

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

// ── Seed buyer-flag items onto the WhatsApp checklist (moved out of the assess route in batch 132, logic unchanged) ──
// Moved so the seeding can be exercised by a validator on real stored shapes; the route calls this with the same
// inputs it used inline. Returns the new checklist text. `checklistText` is the already-trimmed, non-empty checklist;
// `buyerFlags` is buildBuyerFlags(assessment); `lampTier2Fired` is lampResult?.tier2Fired.
// De-dupe rules (unchanged):
// Rule 1: WHEEL/TYRE/DISPLACED_WHEEL → always suppress (wheel-net covers all corners).
// Rule 2: lamp panels when tier2Fired → suppress (curated lamp entries cover the aperture).
// Rule 3 (concept-based): structural panels (FRONT/REAR/SIDE_STRUCTURE) → suppress only
//   when their specific curated concern is ACTUALLY PRESENT in this lot's checklist text —
//   verified per-lot with detection keywords, never assumed. Falls through to seed when
//   the concern is absent (e.g. a lot where the model omitted the chassis-leg item).
//   Detection keywords are keyed by panelId (stable), not by display partName (drift-prone).
// Fallback: verbatim normName phrase-match for all remaining non-structural panels.
// batch 132: a quarter flag Q4 DECLINED (_q4Declined, one owner lib/labour.mjs) is seeded FIRST, always, once, with the
// owner's wording — the phrase-match de-dupe does not apply to it (a model line naming the quarter does not say it is
// uncosted and must be checked).
// batch 152 X1 (Vincent, 17 Sep: "change it") — a flag-only class that is NOT a structure panel (spare wheel /
// tyre mobility kit, parcel shelf, displaced wheel, airbag marker, EV battery) is an inspection item, not a
// structural component. Structure membership has ONE owner, lib/structureFloor.mjs (the same set that may carry
// the jig floor, batch 150 Z1) — never a string. Exported for the validator.
const FLAG_ONLY_CLASSES = new Set([PANEL_CLASS.STRUCTURAL_FLAG, PANEL_CLASS.VISIBLE_FLAG, PANEL_CLASS.PRESENCE_CHECK]);
export function isNonStructureFlagClass(panelId) {
  if (!panelId || isStructureFloorPanel(panelId)) return false;
  const raw = PANEL_BEHAVIOUR[panelId];
  const eff = raw === PANEL_CLASS.EV_CONDITIONAL ? EV_PANEL_RESOLVED_CLASS[panelId] : raw;
  return FLAG_ONLY_CLASSES.has(eff);
}

// ── batch 158 A1 — A SPLIT-VOTE PANEL THAT IS NOT COSTED MUST STILL BE INSPECTED ────────────────────
// Vincent, 18 Sep: when the per-photo reads disagree on a panel (at least one damaged AND at least one
// clean) and the panel ends up NOT costed, the buyer must be told, in the flags and in the checklist.
// This does NOT cost it — that is the batch 151 V1 rule, reverted in batch 156.
// CK75ONW's bonnet is the case: votes {damaged 1, clean 2}, uncosted. It was not silently missing — it
// carried the bonnet-skin-read breadcrumb ("hood skin intact … no separate panel cost") and a checklist
// line ("confirm the cosmetic damage extent"). Both are wrong: neither says the photographs disagree, and
// the first asserts the panel is fine. So this REPLACES the reason on an existing flag rather than adding
// a second one, and carries its own marker: the panel is absent from _preGateParts (route.js's bonnet read
// deletes _amalgDisagree by design), so an _amalgDisagree flag would be dropped by the filter below.
export const SPLIT_VOTE_REASON = (partName) =>
  `Photographs disagree on the ${partName} — some show damage, some do not. Not included in the repair total; check it on inspection before bidding.`;
export const isSplitVote = (v) => !!v && (v.damaged || 0) >= 1 && (v.clean || 0) >= 1;
// batch 182 P3 (Vincent, 22 Sep): a single unsupported MINOR vote (amalgamation's _amalgSingleMinor) is not a real
// disagreement — one photo shows possible marking. It keeps its own line instead of "Photographs disagree" (SV24YCN
// run 2 rear bumper: 1 MINOR against 1 clean). Every other split vote keeps SPLIT_VOTE_REASON.
export const SINGLE_MINOR_REASON = (partName) =>
  `One photo shows possible minor marking on the ${partName} — not costed; check it on inspection before bidding.`;   // batch 183 P2 restores "before bidding"
/**
 * @param pvVotes     pvResult.pvVotesMap / assessment._pvVotes
 * @param gatedParts  the FINAL ledger — a panel in the money is not this rule's business
 * @param flags       coreObs.flaggedParts, mutated in place (reason replaced or flag pushed)
 * @param display     PANEL_DISPLAY
 * @returns [{ panelId, action }] for the log
 */
export function discloseSplitVoteUncosted({ pvVotes, gatedParts, flags, display = {} }) {
  const costed = new Set((gatedParts || []).filter(inMoney).map((r) => r.panelId).filter(Boolean));
  const out = [];
  for (const [pid, v] of Object.entries(pvVotes || {})) {
    if (!isSplitVote(v) || costed.has(pid)) continue;
    if (PANEL_BEHAVIOUR[pid] !== PANEL_CLASS.COST) continue;   // a flag-class panel has its own wording
    const partName = display[pid] || pid;
    const existing = (flags || []).find((f) => f.panelId === pid);
    const reason = existing?._amalgSingleMinor ? SINGLE_MINOR_REASON(partName) : SPLIT_VOTE_REASON(partName);   // batch 182 P3
    if (existing) {
      existing.reason = reason;
      existing.weight = 'medium';
      existing._splitVoteUncosted = true;
      out.push({ panelId: pid, action: 'reworded' });
    } else {
      (flags || []).push({ panelId: pid, partName, zone: 'unknown', weight: 'medium', reason, _splitVoteUncosted: true });
      out.push({ panelId: pid, action: 'added' });
    }
  }
  return out;
}

// ── batch 165 item 1 — A PANEL REMOVED FOR THE BODY TYPE NEVER COMES BACK ───────────────────────────
// Vincent, 21 Sep: a panel the body-class gate removes (REAR_QUARTER on a pickup) must not reach the buyer
// anywhere — no ledger row, no Inspection Flag, no checklist line — whatever later step would add it.
// Batch 164: AK75RDX's quarter was stripped, then 158 A1 re-added its flag from the votes, Q4 acted on it
// and the seed wrote checklist item 18. ONE owner: the body's allow-set (ELIGIBLE_PANELS, route.js). This
// runs ONCE, at the single point route.js places it — after every step that can add a panel (A1, the §2
// invariant, fog, completeness, bumper control) and before every step that reads the result (Q4, labour,
// the ledger, the damage cards, the buyer flags and the checklist seed). Nothing is re-checked downstream.
/**
 * @param eligible     Set of panelIds this body can carry (ELIGIBLE_PANELS[bodyClass])
 * @param gatedParts   the ledger, mutated in place
 * @param flagLists    every flag array a buyer surface reads (coreObs.flaggedParts, assessment._flaggedParts)
 * @param costedParts  the per-view verdicts (coreObs.costedParts), mutated in place
 * @returns {{ rows: string[], flags: string[], verdicts: string[] }} what was removed, for the log
 */
export function stripBodyIneligible({ eligible, gatedParts = [], flagLists = [], costedParts = [] } = {}) {
  const out = { rows: [], flags: [], verdicts: [] };
  if (!eligible) return out;
  // Only KEYED rows outside the allow-set. Non-panel rows (labour / paint / sundries / blend) carry no
  // panelId and are never cross-body misattributions. SRS_AIRBAG is a code-injected sentinel, not a PANEL
  // (so absent from ELIGIBLE_PANELS): a deployed-airbag kit is valid on every body class.
  const ineligible = (pid) => pid != null && !eligible.has(pid);
  for (let i = gatedParts.length - 1; i >= 0; i--) {
    const pid = gatedParts[i].panelId;
    if (pid !== 'SRS_AIRBAG' && ineligible(pid)) { out.rows.push(pid); gatedParts.splice(i, 1); }
  }
  // Null-panelId flags (free-text/structural prose, coachbuilt notice) are never keyed — left untouched.
  for (const list of flagLists) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (ineligible(list[i]?.panelId)) { out.flags.push(list[i].panelId); list.splice(i, 1); }
    }
  }
  for (let i = costedParts.length - 1; i >= 0; i--) {
    if (ineligible(costedParts[i]?.panelId)) { out.verdicts.push(costedParts[i].panelId); costedParts.splice(i, 1); }
  }
  return out;
}

// batch 158 A3 — the panels the wheel-net checklist line actually covers. Mirrors route.js's
// WHEEL_NET_PANELS/EXCLUDED: only the real wheel and tyre rows, never the arch trim that merely has
// "wheel" in its display name. The name regex is the fallback for a flag with no panelId.
export const WHEEL_NET_NAME_RE = /\b(?:wheel|tyre|tire|rim|alloy)\b/i;
export const WHEEL_NET_PANEL_IDS = new Set([PANEL.WHEEL, PANEL.TYRE, PANEL.DISPLACED_WHEEL, PANEL.SPARE_WHEEL]);

export function seedChecklistFromFlags(checklistText, buyerFlags, { lampTier2Fired = false } = {}) {
  const STRUCTURAL_CONCERN_KEYWORDS = new Map([
    [PANEL.FRONT_STRUCTURE, ['chassis']],
    [PANEL.REAR_STRUCTURE,  ['longitudinal', 'boot floor']],
    [PANEL.SIDE_STRUCTURE,  ['inner sill', 'b-pillar', 'c-pillar']],
  ]);
  let text = checklistText;
  // Single counter initialised once — do not re-parse the text on every append.
  let nextItem = (text.match(/^\d+[.)]/mg) || []).length + 1;
  for (const flag of buyerFlags || []) {
    const part = (flag.partName || '').trim();
    if (!part) continue;
    // batch 132 (Vincent, 15 Sep: "It should be in the check list.") — the declined quarter, before every de-dupe rule.
    if (flag._q4Declined === true) {
      if (text.includes(Q4_DECLINED_CHECKLIST_ITEM)) {
        console.log(`[SEED] skip "${part}" reason=q4-declined-already-seeded`);
        continue;
      }
      text += `\n${nextItem}. ${Q4_DECLINED_CHECKLIST_ITEM}`;
      console.log(`[SEED] add "${part}" as item ${nextItem} (q4-declined)`);
      nextItem++;
      continue;
    }
    // batch 158 A1 (Vincent, 18 Sep) — the split-vote uncosted panel, before every de-dupe rule, exactly
    // as the Q4-declined quarter is. The checklist says what the flag says, word for word: a phrase-match
    // on the panel's name must not suppress it, because the model's own checklist usually mentions the
    // panel already and says something softer about it.
    // batch 165 item 2 (Vincent, 21 Sep): an APERTURE panel gets ONE wording, the bumper-displaced one. The
    // aperture step (route.js, _amalgAperture) owns that wording and writes it onto the flag AFTER A1, so the
    // line follows the flag's final reason — A1's sentence is never re-derived from the mark for these panels.
    // Q4-declined quarters are handled above and keep Q4's line (batch 132).
    if (flag._splitVoteUncosted === true) {
      const aperture = flag._amalgAperture === true && !!flag.reason;
      const line = aperture ? flag.reason : flag._amalgSingleMinor ? SINGLE_MINOR_REASON(part) : SPLIT_VOTE_REASON(part);   // batch 182 P3
      if (text.includes(line)) {
        console.log(`[SEED] skip "${part}" reason=split-vote-already-seeded`);
        continue;
      }
      text += `\n${nextItem}. ${line}`;
      console.log(`[SEED] add "${part}" as item ${nextItem} (${aperture ? 'aperture wording' : 'split-vote uncosted'})`);
      nextItem++;
      continue;
    }
    // Rule 1: wheel/tyre/displaced-wheel → wheel-net covers unconditionally.
    // batch 158 A3: keyed on the panelId where there is one — the same fix as route.js's wheelNetParts.
    // A wheel arch moulding or liner is TRIM; the wheel-net line does not cover it, so skipping it here
    // silently dropped it from the checklist as well as misnaming it there.
    if (WHEEL_NET_PANEL_IDS.has(flag.panelId) || (!flag.panelId && WHEEL_NET_NAME_RE.test(part))) {
      console.log(`[SEED] skip "${part}" reason=wheelnet`);
      continue;
    }
    // Rule 2: lamp panels when tier2Fired → curated lamp entries cover the aperture (checklistEntry, restored batch 114
    // on every tier-2 lot since batch 115, costed or A1-shelved; checklistEntry2nd on a pair).
    if (isLampLine(part) && lampTier2Fired) {
      console.log(`[SEED] skip "${part}" reason=lamp-tier2`);
      continue;
    }
    // Rule 3: concept-map — structural panels keyed by panelId
    const clLower = text.toLowerCase(); // recomputed per iteration so appended items accrue
    const pid = flag.panelId || null;
    if (pid && STRUCTURAL_CONCERN_KEYWORDS.has(pid)) {
      const keywords = STRUCTURAL_CONCERN_KEYWORDS.get(pid);
      if (keywords.some(kw => clLower.includes(kw))) {
        console.log(`[SEED] skip "${part}" reason=concept-map:${pid}`);
        continue;
      }
      // Concern absent from this lot's checklist — fall through and seed.
    } else {
      // Fallback: verbatim phrase-match for non-structural panels
      if (clLower.includes(normName(part).toLowerCase())) {
        console.log(`[SEED] skip "${part}" reason=phrase-match`);
        continue;
      }
    }
    // batch 172 P4 (Vincent, 21 Sep): the unnamed OTHER part reads naturally — "Show a close-up of the unidentified part in
    // the listing photos — …", not "Show Unidentified part — see photos close-up — …". Named parts are unchanged.
    const show = part === OTHER_FALLBACK_NAME ? 'Show a close-up of the unidentified part in the listing photos' : `Show ${part} close-up`;
    let seedItem;
    if (flag._amalgAperture === true && flag.reason) {
      // batch 165 item 2: the aperture flag's own wording, never "the listing photographs disagree" below.
      seedItem = flag.reason;
    } else if ((flag._fogSecondOneCorner === true || flag._presenceMissing === true) && flag.reason) {
      // batch 177 P3 / P4: Vincent's line, verbatim ("Second front fog lamp — confirm …", "No spare wheel seen — …").
      seedItem = flag.reason;
    } else if (flag._amalgDisagree) {
      // batch 145 V1: the checklist says what the FLAG says. Same wording as AMALG_REASON_DISAGREE
      // (route.js, batch 143), so the buyer reads one description of the panel, not two.
      seedItem = `${show} — the listing photographs disagree on this part; condition unconfirmed.`;
    } else if (flag._amalgNotVisible) {
      // batch 145 V1: matches AMALG_REASON_NOT_VISIBLE (route.js, batch 141 item 5). "the engine's
      // read" was internal language and described the same panel differently from its own flag.
      seedItem = `${show} — not clear from the listing photographs; condition unconfirmed.`;
    } else if (flag._gateGenerated) {
      seedItem = `${show} — could not be confirmed from the listing photographs.`;
    } else if (flag._srsExtentFloor) {
      // batch 131 (Vincent, 15 Sep — option (a)): the AIRBAG line only, keyed on the SRS flag's marker. "Must be
      // checked" is his word; the number and location of the bags live in the words, never the figure. Every
      // other high-weight flag keeps the generic line below. Em dash as every sibling line: the PDF's str() maps
      // it to a hyphen ("close-up - the number …"), it does not drop it.
      seedItem = `${show} — the number and location of the bags must be checked before bidding.`;
    } else if (flag.weight === 'high' && isNonStructureFlagClass(pid)) {
      seedItem = `${show} — inspection item; confirm condition before bidding.`;
    } else if (flag.weight === 'high') {
      seedItem = `${show} — structural or inspection-class component; confirm condition before bidding.`;
    } else if (flag.weight === 'low') {
      seedItem = `${show} — confirm the cosmetic damage extent.`;
    } else {
      seedItem = `${show} — condition could not be confirmed from the listing photographs.`;
    }
    text += `\n${nextItem}. ${seedItem}`;
    console.log(`[SEED] add "${part}" as item ${nextItem}`);
    nextItem++;
  }
  return text;
}

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
        const labourIdx = workParts.findIndex(p => isNonPartRow(p));
        const at = labourIdx >= 0 ? labourIdx : workParts.length;
        workParts = [...workParts.slice(0, at), insertedRow(keptOrdinal, true), ...workParts.slice(at)];
        console.log(`[LAMP][PAIR-COST] second-corner "Headlamp" inserted at band £${band} — included in the repair total (batch 109C ruling)`);
      }
    } else {
      // Model priced 0 lamps — insert TWO costed rows (same band, one type-read). Both carry
      // _lampOrdinal null, so both take the identical normName fallback in the gate.
      const labourIdx = workParts.findIndex(p => isNonPartRow(p));
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
      const labourIdx = workParts.findIndex(p => isNonPartRow(p));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), insertedRow(), ...workParts.slice(at)];
    }
  }

  // Grille-set injection (mirrors lamp insertedRow): inject before labour line when
  // the front grille is established missing and not already in the main-call parts list.
  if (grilleAllowance > 0 && !workParts.some(p => p._grilleMandated)) {
    const labourIdx = workParts.findIndex(p => isNonPartRow(p));
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

// ── batch 150 Z2 — A PANEL IN THE MONEY NEVER CARRIES A "NOT INCLUDED" REASON ────────────────────────
// CK75ONW (16 Sep): Rear panel costed £200 in the Parts Breakdown while its flag said "…not included in the
// repair cost". Zero-rule C (route.js, batch 106) costs an uncorroborated panel at band and KEEPS the flag
// so the limit is stated — but, unlike family A, never rewrote the flag's no-cost clause. C, D and F all
// had that hole. This is the one owner: run once, after the ledger is final, over every flag. Whether a
// panel is costed is NOT decided here — only the words are made to match the money.
// Same voice as the batch-103 §4 note and the batch-111 lamp pair: say it is in, say how to strike it.
const STRIKE_TAIL = 'It has been included in the repair total on the visible evidence — strike the line on the ledger if the inspection shows it sound.';
export const COSTED_REASON_UNCORROBORATED = `single-view damage — only one photo flagged this panel; the other photos that show this area did not flag it, so the damage is not corroborated. ${STRIKE_TAIL}`;
export const COSTED_REASON_RAD_UNCORROBORATED = `single-view damage on a part only visible when the front is open; no second view confirmed it and no central front-structure damage corroborates it. ${STRIKE_TAIL}`;
export const COSTED_REASON_COSMETIC = 'light cosmetic damage — refinish or trim-grade. It has been included in the repair total at the repair figure — strike the line on the ledger if the inspection shows it sound.';
// A row counts as "in the money" when it carries a figure, or is a repaired panel whose cost sits in panel
// work (batch 116). Same definition the structure floor uses (lib/structureFloor.mjs).
// batch 163 T2: one owner, lib/ledgerEdits.mjs. The local name stays — it reads well at its call sites.
const inMoney = isChargedRow;
/**
 * Rewrites, in place, every flag whose panel is costed but whose reason claims no cost.
 * @returns [{ panelId, from, to }] — one entry per rewrite (logged by the caller, locked by the validator).
 */
// batch 177 P2 (Vincent, 22 Sep) — A NOT-VISIBLE FLOOR FLAG GOES WHEN THE PANEL IS CHARGED. "Not clear from the listing
// photographs" beside a costed line for the same panel contradicts the ledger (SV24YCN: two front fogs costed by the
// fog rule, plus a FOG_LAMP "not clear" flag from a per-view na read). Runs once the ledger is final and before the
// checklist seed, so the flag's seeded checklist line never exists. Mutates each list in place; returns what went.
export function dropNotVisibleForCharged(flagLists, rows) {
  const charged = new Set((rows || []).filter(isChargedRow).map((r) => r.panelId).filter(Boolean));
  const out = [];
  for (const list of flagLists || []) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (f?._amalgNotVisible === true && charged.has(f.panelId)) { out.push({ panelId: f.panelId, partName: f.partName }); list.splice(i, 1); }
    }
  }
  return out;
}

export function reconcileFlagMoneyWording(flags, rows) {
  const costed = new Set((rows || []).filter(inMoney).map((r) => r.panelId).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const f of (flags || [])) {
    if (!f || seen.has(f) || !f.panelId || !costed.has(f.panelId)) continue;
    seen.add(f);
    const was = f.reason || '';
    if (!NO_COST_CLAIM.test(was)) continue;
    let to;
    if (f._radUncorroborated)        to = COSTED_REASON_RAD_UNCORROBORATED;
    else if (f._amalgUncorroborated) to = COSTED_REASON_UNCORROBORATED;
    else if (f._amalgCosmetic)       to = COSTED_REASON_COSMETIC;
    else {
      // Any other no-cost reason on a costed panel: keep what it says about the panel, drop the false clause.
      const head = was.split(/[;.]\s*/).filter((c) => c && !NO_COST_CLAIM.test(c) && !/whatsapp inspection/i.test(c)).join('; ').trim();
      to = head ? `${head}. ${STRIKE_TAIL}` : STRIKE_TAIL;
    }
    f.reason = to;
    f._costedWording = true;
    out.push({ panelId: f.panelId, from: was, to });
  }
  return out;
}

// ── batch 156 T0 — batch 151 V1 IS REVERTED (Vincent, 18 Sep: "Yes revert") ─────────────────────────
// disagreeMajorityRows and DISAGREE_MAJORITY_EXCLUDED are gone with the rule, and so is the
// _disagreeMajorityCosted carve-out in buildBuyerFlags below. Evidence (batch 155 scorecard, 16 lots):
// costing a majority-damaged disputed panel turned 5 panels Vincent labels CLEAN into phantoms
// (+£2,685: SF69YBB bonnet + front wing, AMZ3790 rear bumper, DMZ4614 front bumper, SA26KVT windscreen)
// and gained ZERO hits. A disputed panel is FLAGGED, NOT COSTED — main's behaviour. The rear quarter
// keeps its own Q4 rule (lib/labour.mjs); the gate still keeps a disputed panel the MODEL costed
// (_disagreeCosted, applyVisibilityGate below) — that path is untouched by this revert.

// ── batch 156 T2 — TRIM AND THE PANEL BEHIND IT, REPORTED NOT MERGED ────────────────────────
// The prompt's TRIM BEFORE PANEL rule tells the model to name the trim when the damage is confined to it.
// When the model names BOTH a trim item and the panel it sits on, and it read them in the SAME frames, that
// is the case Vincent wants to see before any merge rule is written. This REPORTS it — it changes no money
// and strikes no row (brief: "Do not build a merge rule yet"). CK75ONW is the test lot.
export const TRIM_BEHIND = Object.freeze({
  [PANEL.WHEEL_ARCH_MOULDING]: [PANEL.FRONT_WING, PANEL.REAR_QUARTER],
  [PANEL.WHEEL_ARCH_LINER]:    [PANEL.FRONT_WING, PANEL.REAR_QUARTER],
  [PANEL.REAR_LIGHT_STRIP]:    [PANEL.BOOT_LID],
});
/**
 * @param costedParts coreObs.costedParts (per-view verdicts; each carries _probeViews)
 * @returns [{ trim, panel, frames }] — one entry per trim/panel pair read in at least one shared frame
 */
export function trimPanelOverlaps(costedParts) {
  const out = [];
  const rows = (costedParts || []).filter((p) => p?.panelId);
  for (const t of rows) {
    const behind = TRIM_BEHIND[t.panelId];
    if (!behind) continue;
    const tv = new Set(t._probeViews || []);
    for (const p of rows) {
      if (!behind.includes(p.panelId)) continue;
      const frames = (p._probeViews || []).filter((v) => tv.has(v));
      if (frames.length) out.push({ trim: t.panelId, panel: p.panelId, frames });
    }
  }
  return out;
}

// Phase 2 visibility gate. Mutates flaggedParts (pushes gate-generated flags,
// deduped by normName against existing entries — dedup behaviour unchanged, Q4 parked).
// ── batch 171 P1 — AN OTHER PART IS NAMED BY THE MODEL'S OWN WORD, NEVER "Other" ───────────────────────
// OTHER is the escape hatch for a part outside the panel list (lib/panelEnum.mjs:17). Its only name is the word
// the model used for it (an unknown ID routed to OTHER, e.g. "UNDERSIDE"). A literal OTHER carries no word, so
// it is "Unidentified part — see photos". "Other" on its own is never shown to a buyer. One owner of the name.
export const OTHER_FALLBACK_NAME = 'Unidentified part — see photos';
export const OTHER_NOT_COSTED_REASON = 'part outside the standard panel list — flagged for inspection, not included in the repair cost; see the photos and confirm on the WhatsApp inspection before bidding';
const humanise = (w) => { const s = String(w || '').replace(/[_-]+/g, ' ').trim().toLowerCase(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
export function otherDisplayName(words) {
  const names = [...new Set((words || []).map(humanise).filter((n) => n && !/^(other|none)$/i.test(n)))];
  return names.length ? names.join(', ') : OTHER_FALLBACK_NAME;
}
/** Renames every OTHER flag, in place, from the per-view records' free-text words. */
export function nameOtherFlags(flags, perViewResults) {
  const words = [];
  for (const r of perViewResults || []) for (const cp of [...(r.costedParts || []), ...(r.instanceParts || [])]) {
    if (cp?.panelId === PANEL.OTHER && cp._freeName) words.push(cp._freeName);
  }
  const name = otherDisplayName(words);
  for (const f of flags || []) if (f?.panelId === PANEL.OTHER) f.partName = name;
  return name;
}

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
    // batch 171 P1 — OTHER IS NEVER COSTED, WHATEVER ITS SOURCE. This gate is the one owner: every model row
    // passes through it, and nothing added after it (G inject, zero-rule, fog, Q4, labour) can produce an OTHER
    // row. The row becomes an inspection flag under its own name, never "Other" (nameOtherFlags).
    if (rp.panelId === PANEL.OTHER) {
      const existing = flaggedParts.find((f) => f.panelId === PANEL.OTHER);
      if (!existing) {
        flaggedParts.push({ panelId: PANEL.OTHER, partName: otherDisplayName([rp.name]), zone: rp.zone ?? 'unknown', weight: 'medium',
          reason: OTHER_NOT_COSTED_REASON, _gateGenerated: true, _otherNotCosted: true });
      }
      console.log(`[GATE][OTHER] "${rp.name}" £${rp.used ?? rp.oem ?? 0} not costed — OTHER is flag-only (batch 171)`);
      continue;
    }
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
    // Batch 81 §1 (Vincent): a DISAGREE panel's row is NOT stripped. Some views saw damage, some saw it
    // clean — the engine must not silently resolve that; the disagreement is surfaced as an inspection
    // flag (already pushed by amalgamate), and the buyer rules. batch 165 item 3 — CORRECTED: this branch
    // runs ONLY when the model wrote a row for the panel. The engine itself does not cost a disputed
    // panel (batch 156: flagged, not costed; ledgerPreamble words it FLOORED). A row the model wrote
    // anyway is kept here at its reconciled/table price rather than deleted: a silent deletion would
    // corrupt the repair total, the profit window and the bid ceiling with no trace on the page, while a
    // costed-but-flagged row is visible and challengeable. With no model row there is nothing to keep, and
    // the panel reaches the buyer as a flag only (158 A1, discloseSplitVoteUncosted). iv stays false
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

// batch 114 task 2 (Vincent, 11 Sep: "yes") — the struck-side headlamp inspection ask back in the WhatsApp
// checklist. computeLampResult's checklistEntry ("Show the struck-side headlamp aperture … confirm the actual
// headlamp type …") has reached no buyer since 0724bfd (2 Jun), while the seed's Rule 2 kept lamp flags OUT
// of the checklist on the grounds that this curated entry covers them. ONE string — verdictLine /
// costDriverEntry / tier1Line stay dark.
// batch 115 (Vincent, 11 Sep: "close it"): returned on TIER 2 ALONE. 114 required a lamp in the money, which
// left the A1-shelved lamp — the engine saying "I could not confirm this, have it inspected" — as the one
// case with no ask at all (Rule 2 keeps its flag out of the checklist too). The wording asks the yard to show
// the aperture and confirm the type and a serviceable unit; it makes no cost claim, so it reads true for a
// shelved lamp as well as a costed one.
export function lampChecklistItem(lampResult) {
  if (!lampResult?.tier2Fired || !lampResult.checklistEntry) return null;
  return lampResult.checklistEntry;
}
// Append one numbered item exactly the way every code-owned checklist item is appended (count the numbered
// items, +1). An empty checklist section is left alone, as the existing appenders do.
export function appendChecklistItem(text, item) {
  const existing = (text || '').trim();
  if (!existing || !item) return text;
  const n = (existing.match(/^\d+[.)]/mg) || []).length;
  return `${existing}\n${n + 1}. ${item}`;
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

  // batch 115 (Vincent, 11 Sep) — every block carries the ledger row key so the buyer edit layer can drop a
  // struck line and re-price a lamp-type correction here too (screen + PDF). The key is not stamped
  // afterwards by a per-panel queue (the KCD/cards route): it is rowKeyFor — the SAME function applyEdits
  // uses — over THIS array, which the route passes as gatedParts and then stores unchanged as
  // _reconciledParts (no mutation between the two; route.js). So key i here IS key i in the ledger, by
  // construction — not by a match that could silently find nothing.
  const keys = rowKeyFor(gatedParts || []);

  // One block per real repair line item — action + finalised figure. Skip labour/paint.
  for (const [i, gp] of (gatedParts || []).entries()) {
    // batch 117: one owner (lib/labour.isNonPartRow) — labour, the SRS fitting rider, the structural allowance,
    // and (batch 106) the £500 jig FLOOR, which is inferred inspection-class, not visible damage.
    if (isNonPartRow(gp)) continue;
    const figure = money(gp.used ?? gp.oem ?? null);
    const led    = gp.panelId != null ? ledgerByPanel.get(gp.panelId) : null;
    const verb   = gp.action === 'repair' ? 'Repair' : 'Replace';
    // batch 112 task 3 (Vincent, 11 Sep): the pair guard goes FIRST. A _lampPair row is costed because the
    // impact is full-width, not because a photo showed its lamp absent — and every HEADLAMP row shares ONE
    // pooled ledger verdict, so a "missing" on that verdict cannot be pinned to either instance. Same for a
    // batch-112 _lampSurplus row. Those rows never claim "Not present in the listing photos" (the claim
    // 109C already removed from the damage cards). Every other row keeps the wording exactly as before.
    // batch 116: a repaired bolt-on panel carries no part — its cost is panel work in the Labour & paint line.
    const prose  = gp._repairNoPart ? REPAIR_NO_PART_NOTE
      : !gp._lampPair && !gp._lampSurplus && (led?._amalgMissing || gp._inserted)
      ? (figure ? `Not present in the listing photos — replace, ${figure}.` : 'Not present in the listing photos — replace.')
      : isFromFigureRow(gp) && figure
      ? `${verb} — from ${figure}.`   // batch 131: one owner — a floor row is "from £X", the bottom of a range (spec §10)
      : (figure ? `${verb} — ${figure}.` : `${verb}.`);
    out.push({ panelId: gp.panelId ?? null, partName: gp.name, action: gp.action ?? 'replace', prose, _rowKey: keys[i] });
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
    .filter(gp => !isNonPartRow(gp))   // batch 117: one owner — labour, SRS fitting, allowance, and the jig floor (batch 106)
    .map(gp => ({ panelId: gp.panelId ?? null, partName: gp.name, action: gp.action ?? 'replace', figure: gp.used ?? gp.oem ?? null, _from: isFromFigureRow(gp) }))
    .filter(r => r.figure != null && r.figure > 0)
    .sort((a, b) => b.figure - a.figure)
    // batch 130: the SRS figure is the flat £500 FLOOR, printed "from" (spec §10); every other driver prints as before.
    .map(({ _from, ...r }) => ({ ...r, prose: `${r.partName} — ${r.action === 'repair' ? 'repair' : 'replace'}: ${_from ? 'from ' : ''}${money(r.figure)}` }));
}

// ── 4d/4e — claim-class binder ───────────────────────────────────────────────────────────────
// Binds narrative claims to the finalised ledger across FOUR claim classes (lamp type / figures /
// action word / EV verdict; part status was taken out in batch 175 — see Class 4 below). A sentence that POSITIVELY CONTRADICTS a class is
// DROPPED WHOLE — never reworded (a reworded lamp claim can become a wrong cost claim). Judgement
// and speculation that do not contradict are preserved. In 'speculation' mode (Alt Scenario /
// Bidder Note) a hedged sentence is spared entirely; 'redflags' mode drops on a plain assertive
// contradiction. Every detector fails OPEN (any doubt → keep). Returns
// { text, dropped:[{class, reason, sentence}] } for loud logging and _narrativeBindings provenance.
const _CLAIM_HEDGE = /\b(may|might|could|possibl[ey]|perhaps|potential(ly)?|likely|appears?|seems?|suggests?|assum\w+|uncertain|unconfirmed|if\s)\b/i;
const _CLAIM_REPAIR_CTX = /\b(repair|replac|parts?|fix|bill|rebuild|refinish|estimate|repair total|cost to)\b/i;
const _CLAIM_COST_CTX   = /\b(cost(s|ed|ing)?|budget\w*|spend\w*)\b/i;                  // batch 172 P2 — a budget is a cost context
const _CLAIM_MARKET_CTX = /\b(retail|trade|market|valuations?|average)\b/i;               // batch 172 P2 — never checked
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
  // batch 172 P2 (Vincent, 21 Sep): "£31k" is £31,000, not £31; and only a figure in a repair or cost context is
  // checked. A retail / trade / market / valuation / average figure is never a repair claim (CK75ONW run 2 lost
  // "The live retail figures (average ~£31k) …" as "£31 not in the ledger"). Red Flags stays strict (batch 136: every £
  // there is a cost claim — it is the "what could make costs higher" field, a cost context by definition); the other
  // surfaces check a figure only in a repair or cost context. In BOTH, a retail/market figure is never checked.
  if (mode === 'redflags' || _CLAIM_REPAIR_CTX.test(s) || _CLAIM_COST_CTX.test(s)) {
    for (const m of s.matchAll(/£\s?([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?\b/g)) {
      const f = Number(m[1].replace(/,/g, '')) * (/[kK]/.test(m[2] || '') ? 1000 : /[mM]/.test(m[2] || '') ? 1e6 : 1);
      const around = s.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (_CLAIM_MARKET_CTX.test(around)) continue;                  // a market figure, not a repair figure
      if (Number.isFinite(f) && !ctx.allowedFigures.some(a => Math.abs(a - f) <= 1)) return { class: 'figure', reason: `£${f} not in the ledger/total set` };
    }
  }
  // Class 3 — ACTION WORD vs the row's action.
  // batch 172 P2: the action word must be bound to the named part — in the SAME clause. "the repair carries structural
  // work not itemised here" is about the whole job, not the rear bumper named in another clause (CK75ONW run 2 Red Flags).
  for (const [name, action] of ctx.partActions) {
    if (!name) continue;
    for (const cl of s.split(/\s+—\s+|;\s+|,\s+plus\s+|,\s+and\s+/)) {
      if (!_mentionsPart(name, cl)) continue;
      const saysRepair  = /\brepair(ed|s|ing)?\b/i.test(cl);
      const saysReplace = /\breplac(e|ed|es|ing|ement)\b/i.test(cl);
      if (saysRepair && !saysReplace && action === 'replace') return { class: 'action', reason: `says repair; "${name}" row action is replace` };
      if (saysReplace && !saysRepair && action === 'repair')  return { class: 'action', reason: `says replace; "${name}" row action is repair` };
    }
  }
  // Class 4 — PART STATUS: REMOVED from the binder in batch 175 (Vincent, 22 Sep). Every sentence it deleted in batches
  // 172/174 was TRUE against Vincent's labels, so deleting it hid missed damage. A sentence that says an uncosted panel is
  // damaged is now KEPT, and the panel goes on the inspection list: findProseDamageUncosted / addProseDamageInspection.
  // Class 5 — EV CLAIMS vs the stamped _evCoolingHvVerdict.
  if (ctx.evVerdict && /\b(battery|hv|high[- ]voltage|traction (?:pack|battery)|ev[- ]system)\b/i.test(s)) {
    const saysIntact = /\b(intact|fine|sound|healthy|serviceable|present and (?:live|intact)|no (?:issue|damage|concern|fault))\b/i.test(s);
    const saysDead   = /\b(destroyed|crushed|holed|missing|gone|dead|scrap|cost[- ]prohibitive|write[- ]?off|beyond repair)\b/i.test(s);
    if (ctx.evVerdict === 'cost-prohibitive' && saysIntact) return { class: 'ev', reason: 'asserts pack sound; verdict is cost-prohibitive' };
    if (ctx.evVerdict === 'clear'            && saysDead)   return { class: 'ev', reason: 'asserts pack damaged/missing; verdict is clear' };
  }
  return null;
}
// batch 136 task C3 — a part name must name the PART, not an everyday phrase. HV25ODX: "deflated bag … hanging at the
// wheel" (the STEERING wheel) matched the demoted WHEEL panel and the whole Visible Damage Summary was dropped. Phrases in
// which "wheel" does not mean a road wheel are masked before any wheel-bearing name is matched. Only "wheel" is masked, as
// ruled; the other single-word names that carry the same risk (Grille, Bonnet, Headlamp, Sill, Windscreen, Roof, Tyre,
// and "Other") are reported in the batch 136 handoff for a ruling.
const _NOT_A_ROAD_WHEEL = [/\bsteering[\s-]+wheel\b/gi, /\b(?:at|behind|on|off)\s+the\s+wheel\b/gi];
// batch 174 G1 — THE LONGER PART NAME WINS. "Wheel" inside "wheel arch liner" / "wheel-arch moulding" names the liner or
// the moulding, not the road wheel. Every part name the engine uses (PANEL_DISPLAY) that contains this name as whole
// words is masked first, longest first; a space and a hyphen are the same separator. Generalises _NOT_A_ROAD_WHEEL.
const _PART_NAMES = [...new Set(Object.values(PANEL_DISPLAY))].sort((a, b) => b.length - a.length);
const _nameRx = (n, flags) => new RegExp(`\\b${n.trim().split(/[\s-]+/).map(_escapeRx).join('[\\s-]+')}\\b`, flags);
function _mentionsPart(name, sentence) {
  let text = sentence;
  if (/\bwheel\b/i.test(name)) for (const rx of _NOT_A_ROAD_WHEEL) text = text.replace(rx, ' ');
  for (const other of _PART_NAMES) {
    if (other.length > name.length && _nameRx(name, 'i').test(other)) text = text.replace(_nameRx(other, 'gi'), ' ');
  }
  return new RegExp(`\\b${_escapeRx(name)}\\b`, 'i').test(text);
}

// batch 175 (Vincent, 22 Sep) — PROSE THAT SAYS AN UNCOSTED PANEL IS DAMAGED IS KEPT, AND THE PANEL IS INSPECTED.
// Detection is batch 174's (held) plus the plain condition words. A false hit costs one extra inspection line, not a
// deleted sentence. A claim needs, in ONE clause:
//   • the panel's name (G1 above);
//   • a status word — the batch 172 P3 stems (the old closing \b meant "damag" never matched "damaged") or a plain
//     condition word (gone, missing, cracked, starred, chip(ped), fractured, displaced, broken, torn, split, dented,
//     crushed, buckled, creased, smashed);
// G2 — a clause is the " — " / "; " split plus commas; a comma inside brackets is a list, not a clause break. A location is
//      not a claim: "the damaged side / struck corner" (and end, flank, area), "<part> height / level / line".
// G3 — a negation (no / not / without / nor), an all-clear word (intact, undisturbed, unmarked, serviceable) or an
//      inspection ask ("not (independently) confirmed", "should be confirmed", verify, check) in the clause → not a claim.
const _PART_STATUS_WORD = /\b(?:(?:damag|replac|repair)\w*|costl?y|cost driver|biggest|expensive|write[- ]?off|structural|gone|missing|cracked|starred|chip(?:ped|s)?|fractured|displaced|broken|torn|split|dented|crushed|buckled|creased|smashed)\b/i;
const _LOCATION_USE     = /\b(?:the\s+)?(?:damaged|struck)[\s-]+(?:side|corner|end|flank|area)s?\b/gi;
const _NOT_A_CLAIM      = /\b(?:no|not|without|nor|intact|undisturbed|unmarked|serviceable|verif\w*|check\w*)\b|n't\b|\bshould\s+be\s+confirmed\b/i;
function _boundClauses(sentence) {
  const held = [];
  const masked = String(sentence).replace(/\([^()]*\)/g, (m) => { held.push(m); return `\u0000${held.length - 1}\u0000`; });
  return masked.split(/\s+—\s+|;\s+|,\s+/).map((c) => c.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]));
}
function _partStatusClaim(name, text) {
  const heightRx = new RegExp(`(?:\\b(?:at|to|above|below)\\s+)?(?:\\bthe\\s+)?${_nameRx(name).source}[\\s-]+(?:height|level|line)\\b`, 'gi');
  for (const clause of _boundClauses(text)) {
    const c = clause.replace(_LOCATION_USE, ' ').replace(heightRx, ' ');
    if (_mentionsPart(name, c) && _PART_STATUS_WORD.test(c) && !_NOT_A_CLAIM.test(c)) return true;
  }
  return false;
}

// Every sentence of `text` that says an uncosted panel is damaged. `panels` = [{ panelId, name }]. In 'speculation' mode a
// hedged sentence says nothing is damaged, so it is skipped — the same sparing the binder gives it. Returns
// [{ panelId, panel, sentence }]; one record per (panel, sentence).
export function findProseDamageUncosted(text, panels, mode = 'redflags') {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const body = line.replace(/^\s*[-*•]?\s*/, '');
    for (const sent of _splitSentences(body)) {
      if (mode === 'speculation' && _CLAIM_HEDGE.test(sent)) continue;
      for (const p of panels || []) {
        if (p?.name && _partStatusClaim(p.name, sent)) out.push({ panelId: p.panelId ?? null, panel: p.name, sentence: sent });
      }
    }
  }
  return out;
}

// batch 175: the one wording, code-owned.
export const PROSE_DAMAGE_UNCOSTED_REASON = (part) =>
  `The report describes damage to the ${part} that is not in the repair total — check it on inspection and add it to the ledger if confirmed.`;

// One inspection line per panel, from the _proseDamageUncosted records. A panel that already has a buyer-visible flag, or
// a checklist line naming it, gets nothing new — the existing line stands. Otherwise: a flag in Inspection Flags
// (_proseDamageUncosted: true, so the page can pre-fill the add-line control) and the same words on the checklist.
// Stamps each record's `inspection` with what happened: 'added' | 'existing flag' | 'existing checklist line'.
export function addProseDamageInspection(assessment, records, zoneOf = () => null) {
  const done = new Map();
  for (const r of records || []) {
    const key = r.panelId || r.panel;
    if (done.has(key)) { r.inspection = done.get(key); continue; }
    let outcome;
    const flagged = buildBuyerFlags(assessment).some((f) => (r.panelId && f.panelId === r.panelId) || (!r.panelId && f.partName === r.panel));
    const checklist = String(assessment['WhatsApp Inspection Checklist'] || '');
    const listed = checklist.split('\n').some((l) => /^\s*\d+[.)]/.test(l) && _mentionsPart(r.panel, l));
    if (flagged) outcome = 'existing flag';
    else if (listed) outcome = 'existing checklist line';
    else {
      const reason = PROSE_DAMAGE_UNCOSTED_REASON(r.panel);
      (assessment._flaggedParts ||= []).push({ panelId: r.panelId, partName: r.panel, zone: zoneOf(r.panelId), weight: 'medium', reason, _proseDamageUncosted: true });
      if (checklist.trim()) {
        const next = (checklist.match(/^\d+[.)]/mg) || []).length + 1;
        assessment['WhatsApp Inspection Checklist'] = `${checklist.trim()}\n${next}. ${reason}`;
      }
      outcome = 'added';
    }
    console.log(`[PROSE DAMAGE] ${r.panel}: ${outcome} — "${r.sentence.slice(0, 90)}"`);
    done.set(key, outcome);
    r.inspection = outcome;
  }
  return records;
}

// batch 183 P3 (Vincent, 23 Sep) — A PROSE SENTENCE MAY NOT CLAIM A LEDGER LINE THAT DOES NOT EXIST. "…the rear bumper
// replacement and the sill work per the Parts Breakdown" (EN23NJX Margin) names two panels with no charged row. The
// sentence is KEPT; the cost-reference phrase is removed, and one code-owned sentence follows it naming the uncharged
// panels. Charged panels in the sentence are untouched; no money moves.
// • The phrase: "per the Parts Breakdown" is the only cost reference to ledger lines on the corpus (7 Margin sentences).
//   "computed from the Parts Breakdown" describes the margin table, not a line, and is not one.
// • What it claims: the panels named BEFORE the phrase, in its own " — " / "; " clause ("bolt-on panels, cooling pack,
//   both headlamps and airbag work per the Parts Breakdown, with the front structure … as the open swing items" claims the
//   first list, not the front structure the sentence itself calls open). A negation in that span claims nothing.
// • A panel is named by its display name (G1 masking); uncharged = not in `chargedIds` (isChargedRow, CLAUDE.md rule 7).
const _COST_REF_RX = /,?\s*\bper the Parts Breakdown\b/i;
const _COST_REF_NEGATION = /\b(?:no|not|without|excluding|excludes?|except)\b|n't\b/i;
const _lowerLead = (n) => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n);
export const COST_CLAIM_UNCHARGED_SENTENCE = (names) => {
  const the = names.map((n) => `the ${_lowerLead(n)}`);
  const list = the.length === 1 ? the[0] : `${the.slice(0, -1).join(', ')} and ${the[the.length - 1]}`;
  return `Not in the repair total: ${list} — check ${the.length === 1 ? 'it' : 'them'} on inspection.`;
};
export function unbindUnchargedCostClaims(text, chargedIds) {
  const hits = [];
  if (!text || typeof text !== 'string' || !_COST_REF_RX.test(text)) return { text, hits };
  const charged = chargedIds instanceof Set ? chargedIds : new Set(chargedIds || []);
  let out = text;
  for (const sent of _splitSentences(text.split('\n').map((l) => l.replace(/^\s*[-*•]?\s*/, '')).join('\n'))) {
    const m = _COST_REF_RX.exec(sent);
    if (!m) continue;
    const before = sent.slice(0, m.index);
    const span = before.split(/\s+—\s+|;\s+/).pop();
    if (_COST_REF_NEGATION.test(span)) continue;
    const named = Object.entries(PANEL_DISPLAY)
      .filter(([id, name]) => id !== 'OTHER' && _mentionsPart(name, span))
      .map(([panelId, name]) => ({ panelId, name, charged: charged.has(panelId), at: span.search(_nameRx(name, 'i')) }))
      .sort((x, y) => x.at - y.at)                                   // the order the sentence names them
      .map(({ at, ...p }) => p);
    const uncharged = named.filter((p) => !p.charged);
    if (!uncharged.length) continue;
    const kept = sent.replace(_COST_REF_RX, '');
    const after = `${/[.!?]$/.test(kept) ? kept : `${kept}.`} ${COST_CLAIM_UNCHARGED_SENTENCE(uncharged.map((p) => p.name))}`;
    if (!out.includes(sent)) continue;
    out = out.replace(sent, after);
    hits.push({ sentence: sent, after, panels: named });
  }
  return { text: out, hits };
}

// batch 184 P2 (Vincent, 23 Sep) — THE MARGIN "DRIVEN BY" SENTENCE IS CODE-OWNED. The model's sentence about what the
// itemised repair is driven by / dominated by / made up of named panels the ledger does not charge (EN23NJX rear bumper
// and sill, both clean). It is replaced by one sentence built from the final ledger's CHARGED rows (the caller passes
// them, from isChargedRow — CLAUDE.md rule 7). No £ figures; the table carries them.
// • Items: every charged row except the labour row, by the figure the total uses (figureOf), largest first; rows with
//   the same name and action merge ("the headlamp ×2 (replace)"). A replace/repair row says its action; a floor or other
//   non-part row (the £500 structure floor, action "inspect") is "the <name> allowance". Over 4 items: the 4 largest,
//   then "N other lines" (N = ledger lines). Labour & paint last, only when its line is above £0.
// • A driver sentence: "… repair/cost … driven by / dominated by / made up of …", "the cost drivers are …", "… as the
//   main drivers", or "The (itemised) repair is <short description> — / : <list>". Never a band-position sentence, an
//   "If …" sentence, or a sentence about costs outside the total.
// • MIXED (held, left as written, reported): a driver sentence that is also a band-position statement or carries a cost
//   swing outside the total ("with the material swing being whether the front structure is straight").
// • Only the first driver sentence is replaced. A batch 183 P3 "Not in the repair total: …" sentence straight after it
//   goes with it (its panels are already on the inspection list via the P3 records).
const _DRIVER_RX = [
  /\b(?:repair|cost)\b.*\b(?:driven by|dominated by|made up of)\b/i,
  /\bcost drivers (?:are|is)\b/i,
  /\bas the main drivers\b/i,
  /^The (?:itemised )?repair is [\w\s-]{0,60}?(?:\s—\s|:)/i,
];
const _DRIVER_NOT = /^(?:If|When|Should)\b|\boutside the itemised\b/i;
const _DRIVER_MIXED = /^The band position\b|\bswing\b|\bnot in (?:this|the) (?:estimate|total)\b|\bunconfirmed\b/i;
const _P3_TAIL_RX = /^\s*Not in the repair total: [^.]*? — check (?:it|them) on inspection\./;
export const DRIVER_SENTENCE = (chargedRows) => {
  const labour = (chargedRows || []).filter((r) => /^labour\b/i.test(String(r?.name || '')));
  const groups = new Map();
  for (const r of chargedRows || []) {
    if (labour.includes(r)) continue;
    const name = String(r.name || PANEL_DISPLAY[r.panelId] || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!name) continue;
    const allowance = isNonPartRow(r) || !/^(?:replace|repair)$/.test(r.action);
    const key = `${name}|${allowance ? 'allowance' : r.action}`;
    const g = groups.get(key) || { name, action: allowance ? null : r.action, n: 0, fig: 0, order: groups.size };
    g.n++; g.fig += (r.used ?? r.oem ?? 0) || 0;
    groups.set(key, g);
  }
  const items = [...groups.values()].sort((a, b) => b.fig - a.fig || a.order - b.order);
  const label = (g) => {
    const n = _lowerLead(g.name);
    return g.action ? `the ${n}${g.n > 1 ? ` ×${g.n}` : ''} (${g.action})` : `the ${n} allowance${g.n > 1 ? ` ×${g.n}` : ''}`;
  };
  const parts = items.slice(0, 4).map(label);
  const rest = items.slice(4).reduce((s, g) => s + g.n, 0);
  if (rest) parts.push(`${rest} other line${rest === 1 ? '' : 's'}`);
  if (labour.some((r) => ((r.used ?? r.oem ?? 0) || 0) > 0)) parts.push('labour & paint');
  if (!parts.length) return 'The repair total has no itemised lines.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `The repair total is made up of: ${list}.`;
};
export function isDriverSentence(s) {
  const t = String(s || '').trim();
  if (!t || _DRIVER_NOT.test(t) || !_DRIVER_RX.some((rx) => rx.test(t))) return null;
  return _DRIVER_MIXED.test(t) ? 'mixed' : 'driver';
}
// batch 185 P1 (Vincent, 24 Sep) — TWO MIXED SHAPES ARE HANDLED BY RULE. Keyed on the wording, never on a lot.
// • Shape A — a band-position sentence carrying a driver clause: "The band position … <head> whose cost is dominated by
//   / driven by / made up of …". The head is kept word for word, cut at the word before "whose" and closed with ".";
//   the code sentence follows it.
// • Shape B — "The repair is a … — <list> — with the X swing sitting in Y / being Y." Everything up to and including the
//   second dash becomes the code sentence; the swing clause becomes its own sentence, in two forms only:
//   "sitting in Y" → "The X swing sits in Y."  ·  "being Y" → "The X swing is Y."  Any other swing wording is held.
// A mixed sentence matching neither stays held (left as written, reported). A 183 P3 tail goes with it, as for a driver.
const _SHAPE_A_RX = /^(The band position\b.*?)\s+whose\s+(?:costs?|repair)\s+(?:is|are)\s+(?:dominated by|driven by|made up of)\b/i;
const _SHAPE_B_RX = /^The (?:itemised )?repair is [^—]*? — [^—]+ — ([\s\S]*)$/i;
const _SWING_RX = [
  [/^with the ([^—]+?) swing sitting in ([^—]+?)\.$/i, (x, y) => `The ${x} swing sits in ${y}.`],
  [/^with the ([^—]+?) swing being ([^—]+?)\.$/i, (x, y) => `The ${x} swing is ${y}.`],
];
function _mixedShape(sent, driver) {
  const a = sent.match(_SHAPE_A_RX);
  if (a) return { shape: 'A', after: `${a[1].replace(/[\s,;:]+$/, '')}. ${driver}` };
  const b = sent.match(_SHAPE_B_RX);
  if (!b) return null;
  const rest = b[1].trim().replace(/\.?$/, '.');
  for (const [rx, make] of _SWING_RX) {
    const m = rest.match(rx);
    if (m) return { shape: 'B', after: `${driver} ${make(m[1], m[2])}` };
  }
  return null;
}
export function codeOwnDriverSentence(text, chargedRows) {
  const held = [];
  if (!text || typeof text !== 'string') return { text, stamp: null, held };
  for (const sent of _splitSentences(text)) {
    const kind = isDriverSentence(sent);
    if (kind !== 'driver' && kind !== 'mixed') continue;
    const driver = DRIVER_SENTENCE(chargedRows);
    const shaped = kind === 'mixed' ? _mixedShape(sent, driver) : null;
    if (kind === 'mixed' && !shaped) { held.push(sent); continue; }
    const i = text.indexOf(sent);
    if (i < 0) continue;
    const after = shaped ? shaped.after : driver;
    const tail = text.slice(i + sent.length).match(_P3_TAIL_RX);
    const removed = tail ? `${sent}${tail[0]}` : sent;
    return {
      text: text.slice(0, i) + after + text.slice(i + removed.length),
      stamp: { ...(shaped ? { shape: shaped.shape } : {}), before: removed, after, rows: (chargedRows || []).map((r) => ({ panelId: r.panelId ?? null, name: r.name, action: r.action ?? null })) },
      held,
    };
  }
  return { text, stamp: null, held };
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
    const isBullet = /^\s*[-*•]/.test(line);
    const kept = [];
    const hits = [];
    for (const sent of _splitSentences(body)) {
      const hit = _sentenceContradicts(sent, ctx, mode);
      // batch 175: no part-status class any more, so no clause drop (batch 171 P4's dropDemotedClauses is gone).
      if (hit) { hits.push({ class: hit.class, reason: hit.reason, sentence: sent }); continue; }
      kept.push(sent);
    }
    dropped.push(...hits);
    if (kept.length === 0) continue; // whole line was contradictory → drop the line
    // batch 136 task C4 — no orphan sentences: when a BULLET loses its claim sentence, the whole bullet goes. HV25ODX's
    // VAT bullet lost "…£3,600 before Copart fees." and left "- Factor this into the bid ceiling." on its own. The rest
    // of the bullet is recorded (bullet-orphan) so nothing is removed silently. Plain prose keeps its other sentences.
    if (isBullet && hits.length) {
      for (const sent of kept) dropped.push({ class: 'bullet-orphan', reason: 'rest of a bullet whose claim sentence was dropped', sentence: sent });
      continue;
    }
    keptLines.push(prefix + kept.join(' ').trim());
  }
  const out = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // batch 136 task C2 — a checker never blanks a section. If every sentence would go, keep the field whole and hand back
  // what would have been dropped (keptWhole) for the caller to log and record.
  if (!out && text.trim()) return { text: text.trim(), dropped: [], keptWhole: dropped };
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
        // batch 132 (Vincent, 15 Sep: "It should be in the check list."): CARVE-OUT, not repeal — a quarter flag Q4 DECLINED
        // (_q4Declined, set by its one owner, lib/labour.mjs promoteFlaggedQuarter) is exempt. Every other flag this filter
        // hid before still hides. The vote test is NOT re-derived here — the mark is read.
        // batch 156 T0: the batch 151 V1 carve-out (_disagreeMajorityCosted) is reverted with the rule.
        // batch 158 A1: a split-vote panel the engine did NOT cost is a ruled disclosure — it is exempt,
        // like the Q4-declined quarter. Without this the bonnet case is filtered out (CK75ONW's bonnet is
        // absent from _preGateParts), which is the suppression Vincent asked to be found.
        // batch 177 M1: a disputed panel the M1 switch costed keeps its flag (it carries the "remove the line" note).
        const keep = !f._amalgDisagree || f._q4Declined === true || f._splitVoteUncosted === true
          || f._m1CostedDisputed === true || preGatePanelIds.has(f.panelId);
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
