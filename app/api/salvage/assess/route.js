import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createCanvas, loadImage } from 'canvas';
import { formatOdometerCompact } from '@/lib/odometerDisplay';
import { ASSESSMENT_ENGINE_PROMPT } from '@/config/assessmentEngine';
import { MODELS } from '@/config/models';
import { isInfraFailure, sendOpsAlert } from '@/lib/opsAlert.mjs';
import { feeStack as copartFeeStack } from '@/lib/copartFees';
import { feeStack as iaaFeeStack } from '@/lib/iaaFees';
const FEE_STACKS = { copart: copartFeeStack, iaa: iaaFeeStack };
import { buildInvestmentBlock } from '@/lib/investmentBlock';
import { buildDamageCards } from '@/lib/damageCards';
import { scrubFlooredProse } from '@/lib/flooredProseScrub.mjs';
import { rebuildCeilingHammer } from '@/lib/bidCeiling.mjs';
import { buildPartsSourcing } from '@/lib/partsSourcing.mjs';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';
import { resolvePhotoOdometerReading } from '@/lib/mileageCheck.mjs';
import { withOneAutoCache } from '@/lib/oneautoCache';
import {
  CORE_GROUPS, VENDOR_SUFFIX_MAP, WHEEL_CORNERS, CORNER_LABELS,
  wheelSlotId, tyreSlotId, buildSlot, buildGroup, assembleCoreSlots,
} from '@/lib/coreSlots';
import {
  isLampLine, normName, sumPartsRealistic, reconcileParts,
  applyVisibilityGate, finalizeLampInstrumentation, computeLabourRatio,
  assembleVdsParts, assembleKcdParts, bindClaimClasses, buildBuyerFlags, BUMPER_OFF_SEAM_REASON, BUMPER_OFF_MOUNTING_REASON, BUMPER_OFF_SYMMETRIC_REASON, BUMPER_OFF_UNCOSTABLE_REASON,
} from '@/lib/parts.mjs';
import { sanitizeSideTerms } from '@/lib/sanitizeProse';
import { scrubSideWords } from '@/lib/sideScrub.mjs';
import { normaliseLot } from '@/lib/normaliseLot';
import { runRescueGate } from '@/lib/apertureRescue.mjs';
import { PANEL, PANEL_DISPLAY, PANEL_BEHAVIOUR, PANEL_CLASS, EV_PANEL_RESOLVED_CLASS, isBevLot } from '@/lib/panelEnum.mjs';
import { derivePriceBand, PANEL_PRICE_TABLE } from '@/lib/priceBand.mjs';
import { applyFogBumperRule, completenessFlagsFor } from '@/lib/partsCompleteness.mjs';

// ── Body-class resolution ──────────────────────────────────────────────────────
// Keyword set from 270-session string enumeration (25 Jun 2026).
// M1/M2 → top-level class from typeApproval alone.
// N1 → sub-split from Brego vehicle_desc + Copart Body style.
// UNRESOLVED: both sources absent, or sources conflict → caller rejects/escalates.
const _PICKUP_RE     = /pick[\s-]?up/i;
const _PANEL_VAN_RE  = /\bvan\b/i;
const _COACHBUILT_RE = /luton|dropside|drop\s*side|tipper|chassis\s*cab|box\s*van|flatbed|curtain/i;
// Minibus corroboration for the N1-edge / M2-absent case. GUARDED: the bare word "minibus"
// only — NEVER a seat-count. A1 proved "[N seats]" appears on ordinary M1 cars (Kia Picanto
// "[4 seats]"), so any N-seat regex is a known trap and is deliberately absent.
const _MINIBUS_RE    = /\bminibus\b/i;

function _classifyBodyString(s) {
  if (!s || !s.trim()) return null;
  if (_MINIBUS_RE.test(s))    return 'minibus';
  if (_PICKUP_RE.test(s))     return 'pickup';
  if (_COACHBUILT_RE.test(s)) return 'coachbuilt';
  if (_PANEL_VAN_RE.test(s))  return 'panel_van';
  return null;
}

// resolveBodyClass — pure, no model call.
// Returns { bodyClass, source, conflict, conflictDetail? }
// bodyClass ∈ { 'car' | 'people_carrier' | 'minibus' | 'panel_van' | 'pickup' | 'coachbuilt' | 'UNRESOLVED' | null }
// null = typeApproval absent (pre-Part-1 session) — caller must NOT enforce N1 rules.
function resolveBodyClass(typeApproval, vehicleDesc, copartBodyStyle) {
  const ta = (typeApproval || '').toUpperCase().trim();
  if (!ta) return { bodyClass: null, source: 'typeApproval_absent', conflict: false };
  if (ta === 'M1') return { bodyClass: 'car', source: 'typeApproval', conflict: false };
  if (ta === 'M2') return { bodyClass: 'minibus', source: 'typeApproval', conflict: false };
  if (ta !== 'N1') return { bodyClass: null, source: 'typeApproval_other', conflict: false };

  const fromDesc  = _classifyBodyString(vehicleDesc);
  const fromStyle = _classifyBodyString(copartBodyStyle);

  if (fromDesc && fromStyle) {
    if (fromDesc === fromStyle) return { bodyClass: fromDesc, source: 'both', conflict: false };
    // Disagreement: do NOT pick one — force ask-user path
    return { bodyClass: 'UNRESOLVED', source: 'conflict', conflict: true, conflictDetail: `vehicle_desc→${fromDesc} copartBodyStyle→${fromStyle}` };
  }
  if (fromDesc)  return { bodyClass: fromDesc,  source: 'vehicle_desc', conflict: false };
  if (fromStyle) return { bodyClass: fromStyle, source: 'copart_body_style', conflict: false };
  return { bodyClass: 'UNRESOLVED', source: 'none', conflict: false };
}

// Coachbuilt body panels — out-of-model when bodyClass = 'coachbuilt'.
// These are the Stage-1 van/pickup body panels that map to non-cab body structure.
// Cab/front panels (BONNET, FRONT_BUMPER, FRONT_WING, etc.) are NOT listed here
// and remain in the costed set for coachbuilt vehicles.
const COACHBUILT_BODY_PANELS = new Set([
  'SLIDING_DOOR_SOLID', 'SLIDING_DOOR_GLAZED',
  'BARN_DOOR_L', 'BARN_DOOR_R',
  'LOAD_BULKHEAD', 'CREW_WINDOW', 'BODY_SIDE_GLAZING', 'TAILGATE_GLAZED',
  'BED_SIDE_L', 'BED_SIDE_R', 'BED_FLOOR', 'DROP_TAILGATE', 'CAB_REAR_PANEL',
]);

// ── Body-class panel-eligibility (allow-set) ──────────────────────────────────
// Universals every class may cost: front section, doors/sides, glass, rear bumper/
// lamp/panel, roof, wheels/tyres, all structural flags, presence checks, OTHER, EV.
// Per-class additions sit on top. The gate strips any costed/flagged panel NOT in the
// resolved class's set (cross-body misattribution — e.g. BOOT_LID costed on a pickup).
const _ELIGIBLE_UNIVERSAL = [
  PANEL.FRONT_BUMPER, PANEL.GRILLE, PANEL.BONNET, PANEL.SLAM_PANEL, PANEL.FRONT_WING,
  PANEL.HEADLAMP, PANEL.FOG_LAMP, PANEL.RADIATOR_PACK, PANEL.FRONT_DOOR, PANEL.REAR_DOOR,
  PANEL.SILL, PANEL.SIDE_SKIRT, PANEL.DOOR_MIRROR, PANEL.SIDE_GLASS, PANEL.REAR_BUMPER,
  PANEL.REAR_LAMP, PANEL.WINDSCREEN, PANEL.ROOF, PANEL.WHEEL, PANEL.TYRE, PANEL.REAR_PANEL,
  PANEL.FRONT_STRUCTURE, PANEL.REAR_STRUCTURE, PANEL.SIDE_STRUCTURE, PANEL.DISPLACED_WHEEL, PANEL.AIRBAG,
  PANEL.SPARE_WHEEL, PANEL.PARCEL_SHELF, PANEL.OTHER, PANEL.EV_BATTERY_ZONE, PANEL.EV_BATTERY_PRESENCE,
];
const ELIGIBLE_PANELS = Object.freeze({
  car: new Set([
    ..._ELIGIBLE_UNIVERSAL,
    PANEL.BOOT_LID, PANEL.REAR_QUARTER, PANEL.REAR_GLASS,
  ]),
  pickup: new Set([
    ..._ELIGIBLE_UNIVERSAL,
    PANEL.BED_SIDE_L, PANEL.BED_SIDE_R, PANEL.BED_FLOOR, PANEL.DROP_TAILGATE,
    PANEL.CAB_REAR_PANEL, PANEL.CAB_REAR_GLASS,
  ]),
  panel_van: new Set([
    ..._ELIGIBLE_UNIVERSAL,
    PANEL.SLIDING_DOOR_SOLID, PANEL.SLIDING_DOOR_GLAZED, PANEL.BARN_DOOR_L, PANEL.BARN_DOOR_R,
    PANEL.LOAD_BULKHEAD, PANEL.CREW_WINDOW, PANEL.TAILGATE_GLAZED,
  ]),
  minibus: new Set([
    ..._ELIGIBLE_UNIVERSAL,
    PANEL.BOOT_LID, PANEL.REAR_QUARTER, PANEL.REAR_GLASS, PANEL.BODY_SIDE_GLAZING,
    PANEL.SLIDING_DOOR_GLAZED, PANEL.BARN_DOOR_L, PANEL.BARN_DOOR_R, PANEL.TAILGATE_GLAZED,
  ]),
});

export const maxDuration = 300;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const HEADLAMP_BANDS = {
  halogen: 150, // S/H unit + fitted, GBP
  hid:     250, // HID / projector unit + fitted
  led:     350, // LED / adaptive / matrix unit + fitted
};
const HEADLAMP_BAND_DEFAULT = 'led'; // conservative high — indeterminate spec always defaults here

const ASSESSMENT_FIELDS = [
  'Visible Damage Summary',
  'Parts Breakdown',
  'Part Verdicts',
  'Key Cost Drivers',
  'Red Flags',
  'Alternative Damage Scenario',
  'Airbags',
  'Confidence Level',
  'Bidder Note',
  'Recommended Action',
  'Realistic Exit Value',
  'Exit Band Position',
  'Margin Calculation',
  'WhatsApp Inspection Checklist',
];

function parseAssessment(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const clean = text
    .replace(/\*{1,3}/g, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '');

  const positions = [];
  for (const field of ASSESSMENT_FIELDS) {
    const patterns = [
      new RegExp('^#{1,6}\\s*' + esc(field) + '\\s*$', 'im'),
      new RegExp('^\\s*' + esc(field) + '\\s*:', 'im'),
    ];
    for (const rx of patterns) {
      const m = clean.match(rx);
      if (m !== null) {
        positions.push({ field, start: m.index, afterColon: m.index + m[0].length });
        break;
      }
    }
  }
  positions.sort((a, b) => a.start - b.start);

  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const { field, afterColon } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : clean.length;
    result[field] = clean.slice(afterColon, end).trim();
  }
  return result;
}

function catLetter(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let m = t.match(/^cat(?:egory)?\s+([snabcd])\b/);
  if (m) return m[1];
  m = t.match(/^([snabcd])\s+repairable/);
  if (m) return m[1];
  m = t.match(/^([snabcd])$/);
  if (m) return m[1];
  return null;
}

// Self-reference by LOT NUMBER (Vincent's ruling, 29 Aug 2026). Every salvage record carries the
// Copart lot number in salvage_auction_record_id (the documented "Salvage record id", integer); the
// engine already holds the same number as vd.lotNumber. They are equal ⟺ the record IS this listing's
// own auction event — a self-reference, not a prior. This is the ONLY self-match test. The retired
// 14-day-window + mileage(±100) + category predicate could not separate self from a genuine prior:
// across the fixture set the record sits 0–81 days BEFORE the listing's own sale date with no pattern,
// so no date window (and no mileage/category proxy) can do the job — only the lot number can.
// Generalised to N records; isSelfReferenceFirstWriteOff stays true when the WHOLE history is
// self-matches (N=1 is just a case of that), so "first write-off" still means "no PRIOR history".
// selfMatchCount / recordsExcludingSelf feed the salvage-count-excl-self CORE slot.
//
// NB salvage_auction_reference is NOT in SalvageGuide's published spec (carguide/salvagecheck/v2) —
// present in every observed record but undocumented and withdrawable, so it is read as corroboration
// only, never as the sole basis of a match. salvage_auction_record_id IS documented and is the key.
function tagSelfReference(shResult, vd) {
  if (!shResult) return;
  const records = shResult.salvage_auction_records || [];
  const lotNumber = vd.lotNumber != null ? String(vd.lotNumber).trim() : null;
  const saleMs = vd.saleDate?.ms ?? null; // the listing's own auction sale date — future-date guard
  const selfFlags = records.map((rec) => {
    // PRIMARY + ONLY test — lot-number identity.
    const recId = rec.salvage_auction_record_id != null ? String(rec.salvage_auction_record_id).trim() : null;
    if (lotNumber != null && recId != null && recId === lotNumber) {
      console.log(`[SELF-REF] id-hit: record ${recId} === lot ${lotNumber} → self-reference (excluded from prior count)`);
      return true;
    }
    // Future-date guard (ruling 4): a record dated AFTER the listing's own sale date can never be a
    // prior — a prior event is necessarily earlier. Belt-and-braces behind the id test; fires only
    // when the sale date is known and the record date is strictly later.
    if (saleMs != null && rec.salvage_auction_lot_date) {
      const recMs = new Date(rec.salvage_auction_lot_date).getTime();
      if (!isNaN(recMs) && recMs > saleMs) {
        console.log(`[SELF-REF] future-date-guard: record ${rec.salvage_auction_lot_date} is after the listing sale ${new Date(saleMs).toISOString()} → cannot be a prior (excluded)`);
        return true;
      }
    }
    // No id match and not future-dated: we cannot prove self-reference without the key and we do not
    // guess. The record STANDS AS A GENUINE PRIOR — the recoverable over-count direction (a wrongly
    // shown prior is recoverable; a hidden one is not). The retired date+mileage fallback is NOT
    // reinstated in any reduced form.
    console.log(`[SELF-REF] id-miss: record ${recId ?? 'null'} != lot ${lotNumber ?? 'null'} → genuine prior retained`);
    return false;
  });
  const selfMatchCount = selfFlags.filter(Boolean).length;
  shResult.selfMatchCount = selfMatchCount;
  shResult.recordsExcludingSelf = Math.max(0, records.length - selfMatchCount);
  shResult.isSelfReferenceFirstWriteOff = records.length > 0 && selfMatchCount === records.length;
}

// ---------------------------------------------------------------------------
// CORE slot builders — assemble assessment._slots from coreObs (model vision
// read, via recordCoreObservations) + enrichedVd / bregoData (code-owned data).
// Each builder returns ONE buildSlot() record; group builders compose them.
// This is the slot-output pattern (_exitValue/_reconciledParts) generalised to
// every CORE slot, per CC_Brief_CORE_SlotEngine_Phase1.md.
// ---------------------------------------------------------------------------

// Reads the windscreen-sticker letter from coreObs.windscreenSticker (backfilled from the
// vision dash-read after it awaits; no longer from Call-2 prose) and resolves it through
// the code-owned VENDOR_SUFFIX_MAP.
function resolveVendorSuffix(coreObs) {
  const sticker = coreObs.windscreenSticker || {};
  const visible = Boolean(sticker.visible);
  const letter = sticker.suffixLetter || 'UNREADABLE';
  if (!visible) return { status: 'absent', letter: null, mapped: null, stickerSeen: Boolean(sticker.stickerSeen) }; // no legible suffix; stickerSeen splits "no sticker" vs "present but illegible"
  if (letter === 'UNREADABLE') return { status: 'unreadable', letter: null, mapped: null }; // sticker present, letter illegible
  if (letter === 'OTHER') return { status: 'other', letter, mapped: null };
  return { status: 'mapped', letter, mapped: VENDOR_SUFFIX_MAP[letter] || null };
}

function buildVendorSuffixSlot(vendorSuffix) {
  if (vendorSuffix.status === 'absent') {
    // Two distinct miss states after the targeted re-read (:sticker retry): a sticker was seen but
    // its suffix is illegible (stickerSeen) vs no sticker seen at all. Both stay status 'absent'
    // (tier silent) — only the wording splits.
    const seen = vendorSuffix.stickerSeen === true;
    return buildSlot({
      id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: seen
        ? 'Vendor sticker present but the suffix is not legible in the photos'
        : 'No vendor sticker visible in the listing photos',
      confidence: 'hidden', source: 'model',
      flag: { severity: 'info', whatsapp: seen
        ? 'Vendor sticker present but the suffix is not legible in the photos — photograph the upper windscreen area on the WhatsApp inspection'
        : 'No vendor sticker was visible in the listing photos — photograph the upper windscreen area to establish vendor type before bidding',
        tier: 1 },
    });
  }
  if (vendorSuffix.status === 'unreadable') {
    return buildSlot({
      id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'Vendor sticker present but suffix letter not legible — vendor type unconfirmed',
      confidence: 'hidden', source: 'model',
      flag: { severity: 'info', whatsapp: 'Photograph the windscreen lot-number sticker close-up — the vendor-suffix letter was not legible in the current photo set', tier: 1 },
    });
  }
  if (vendorSuffix.status === 'other') {
    return buildSlot({
      id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: `Sticker is legible but shows "${vendorSuffix.letter}" — outside the known X/P/C/Q vendor codes, vendor type unconfirmed`,
      confidence: 'visible', source: 'model',
    });
  }
  const { letter, mapped } = vendorSuffix;
  return buildSlot({
    id: 'vendor-suffix', label: `Vendor type (windscreen sticker suffix ${letter})`,
    kind: 'confirmation', verdict: 'confirmed',
    detail: `Sticker reads "${letter}" — ${mapped.vendorType}`,
    confidence: 'visible', source: 'model',
  });
}

function extractDoorCount(text) {
  if (!text) return null;
  const s = String(text);
  // Auction shorthand: "3DR" / "3 DR" (Copart paste form). Bounded 2-5 — door
  // counts outside that range are not real body configs and must not match.
  const dr = s.match(/\b([2-5])\s?DR\b/i);
  if (dr) return parseInt(dr[1], 10);
  // Word form: "3 door" / "3-door" / "3door".
  const word = s.match(/\b([2-5])\s*[- ]?\s*door/i);
  if (word) return parseInt(word[1], 10);
  return null; // null = unknown — callers MUST fail open (never assume a default).
}

// Targets the specific "3-door/5-door wander" the design notes flag — door-count is the only
// cross-check loose enough to be reliable (full-string fuzzy matching is not). A confident,
// non-empty model read is sufficient for "confirmed" on its own — matching how the model
// reasons in its own prose ("3-door Coupe (confirmed)", stated without reference to the
// listing). The listing comparison only steps in as an OVERRIDE, downgrading to "discrepancy"
// when both sources exist AND actively conflict on door count.
// (06 Jun fix — SR16GOT slot/prose clash: the old code REQUIRED listing corroboration before
// calling it "confirmed", imposing a stricter bar than the model applies to itself — the slot
// said "unconfirmed — none clearly visible" while the prose said "3-door Coupe (confirmed)".)
function buildBodyStyleSlot(enrichedVd, coreObs) {
  // Source: Brego vehicle_desc (code-owned, populated for all GB lots with a live valuation
  // call). Falls back to Copart listing bodyStyle (usually empty). Body-style mismatch comes
  // from the vision dash-read cross-check, not from Call-2 prose.
  const descriptor = (enrichedVd.bregoValuation?.vehicle_desc || enrichedVd.bodyStyle || '').trim();
  const mismatch   = coreObs.bodyStyleMismatch || 'unclear';

  if (!descriptor) {
    return buildSlot({
      id: 'body-style', label: 'Body style',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'No body style data available from valuation or listing sources',
      confidence: 'hidden', source: 'code',
    });
  }
  if (mismatch === 'mismatch') {
    return buildSlot({
      id: 'body-style', label: 'Body style',
      kind: 'confirmation', verdict: 'discrepancy',
      detail: `Data describes ${descriptor} — but the photos appear to show a different vehicle type; verify identity before bidding`,
      confidence: 'visible', source: 'code+model',
      flag: { severity: 'red', whatsapp: `Body-style mismatch — data describes ${descriptor} but the photos appear to show a different vehicle type; verify vehicle identity before bidding`, tier: 1 },
    });
  }
  return buildSlot({
    id: 'body-style', label: 'Body style',
    kind: 'confirmation', verdict: 'confirmed',
    detail: descriptor,
    confidence: mismatch === 'match' ? 'corroborated' : 'inferred',
    source: 'code',
  });
}

function buildCategorySlot(enrichedVd) {
  const cat = (enrichedVd.category || '').trim();
  if (!cat) {
    return buildSlot({
      id: 'category', label: 'Salvage category recorded',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'No salvage category on the listing — the exit-value band calculation cannot run without it',
      confidence: 'hidden', source: 'code',
      flag: { severity: 'caution', whatsapp: 'Salvage category is missing from the listing — confirm it directly with the auction handler before bidding', tier: 1 },
    });
  }
  return buildSlot({
    id: 'category', label: 'Salvage category recorded',
    kind: 'confirmation', verdict: 'confirmed',
    detail: `${cat} — drives the exit-value band calculation`,
    confidence: 'visible', source: 'code',
  });
}

// "Why is it here?" — the surface-deceptive / provenance-contradiction check from the design
// notes: warranty-age + low-mileage-for-age + minimal damage story is the trigger pattern: a
// vehicle that LOOKS too clean to be genuine salvage.
// (batch 87 §6 — codePathA DELETED: the age+mileage+minimal-damage "too clean" heuristic pointed the
// wrong way across the corpus — 5 genuine Cat S structural write-offs passed both numeric limbs, and
// the one non-damage lot (DL72FVX stolen/recovered) failed them. A nearly-new low-mileage car in
// Copart is the most ordinary thing in the auction. The constants and their derived flags are gone;
// Path B (non-insurer C/Q vendor suffix) carries provenance instead.)

// Code-owned provenance concern — two-tier, deterministic from category + resolved vendor suffix.
// Returns 'catU' | 'catS' | null. Requires a non-insurer suffix (C or Q) either way.
//   TIER 1 'catU' (primary): positively-recorded Cat U ("U …", e.g. "U - Used Unrecorded") — never
//     categorised by an insurer, history wholly unvouched. Null category (null-paste / no listing
//     data) is NOT Cat U and must never fire — /^u\b/ requires U as a standalone recorded token.
//   TIER 2 'catS' (secondary): Cat S — historic insurer category, non-insurer re-entry (prior
//     write-off re-entered, possibly unrepaired).
// Shared by the CORE provenance slot and the Red Flags injection so the two can never diverge.
function qcProvenanceConcern(enrichedVd, vendorSuffix) {
  const nonInsurerSuffix = vendorSuffix.status === 'mapped' && vendorSuffix.mapped?.insurerEntered === false;
  if (!nonInsurerSuffix) return null;
  const cat = (enrichedVd.category || '').trim();
  if (/^u\b/i.test(cat)) return 'catU';
  if (/^s\b/i.test(cat)) return 'catS';
  return null;
}

function buildProvenanceContradictionSlot(enrichedVd, vendorSuffix) {
  // BATCH 88 — PROVENANCE COLLAPSE + proseFlagged DELETED (batch 88 follow-up, Vincent's word). Every
  // car here is a write-off, so "the salvage story holds together" is not information. The ONE question
  // with signal is WHO ENTERED the car, and the windscreen vendor suffix is the sole admissible witness
  // (§A): non-insurer (C/Q) on Cat U/S → SPEAK (qcProvenanceConcern); everything else → SILENCE (return
  // null → caller omits via .filter(Boolean)). proseFlagged is gone — limb 1 (suffix) is dead under §A;
  // limb 2 (Copart re-entry) is owned by tagSelfReference + buildSalvageCountSlot (prose-independent,
  // fires on DL72FVX); limb 3 (damage-doesn't-explain-writeoff) reasons from the D1-banned descriptor.
  // NB the Call-2 provenanceConcern* fields are still EXTRACTED but now UNREAD: removing them from the
  // Call-2 schema would change the request body and break the £0 cassette hash, so it is a separate
  // re-capture step (batch 88 note), NOT folded in here.
  // Path B is the whole check now: qcProvenanceConcern already requires a non-insurer suffix, so any
  // hit is a red-severity concern by construction.
  const provConcern = qcProvenanceConcern(enrichedVd, vendorSuffix); // 'catU' | 'catS' | null

  if (provConcern) {
    const descriptor = [enrichedVd.year, enrichedVd.make, enrichedVd.model].filter(Boolean).join(' ') || 'This vehicle';
    const signals = [];
    if (provConcern === 'catU') signals.push('non-insurer entry with no insurance salvage category recorded (Cat U — history unvouched)');
    if (provConcern === 'catS') signals.push('non-insurer entry on a Cat S structural write-off (historic category — possible unrepaired re-entry)');
    const whatsappParts = [];
    if (provConcern === 'catU') whatsappParts.push('non-insurer vendor entry (C/Q suffix) on an uncategorised Cat U — establish why it is in salvage');
    if (provConcern === 'catS') whatsappParts.push('non-insurer vendor entry (C/Q suffix) on a Cat S write-off — possible re-entered unrepaired lot');
    return buildSlot({
      id: 'provenance-contradiction', label: '"Why is it here?" — provenance concern flagged',
      kind: 'confirmation', verdict: 'discrepancy',
      detail: `${descriptor} — ${signals.join('; ')}`,
      confidence: 'inferred', source: 'code',
      flag: {
        severity: 'red',
        whatsapp: `${whatsappParts.join('; ')}. Ask the handler directly why this vehicle was written off and press for an explanation before bidding`,
        tier: 1,
      },
    });
  }

  // SILENCE — insurer-entered (X/P), or the suffix is unmapped/unreadable/absent (the vendor-suffix
  // slot already owns the "cannot read who entered" checklist item — single-owner, batch 88 §B), or a
  // clean read. Every car here is a write-off, so "the story holds together" is not information it
  // could not work out itself. Return null → the caller omits the slot via .filter(Boolean).
  return null;
}

function buildIdentityGroup(enrichedVd, coreObs, brMileage, brAgeYears, proseFlags) {
  const vendorSuffix = resolveVendorSuffix(coreObs);
  return buildGroup({
    id: CORE_GROUPS.IDENTITY.id, label: CORE_GROUPS.IDENTITY.label,
    // .filter(Boolean): buildProvenanceContradictionSlot returns null on the silent case (batch 88);
    // the other three builders never return null (verified — else deriveAllClear/deriveFlags would
    // already crash on slot.flag), so the filter only ever drops the omitted provenance slot.
    slots: [
      buildBodyStyleSlot(enrichedVd, coreObs),
      buildCategorySlot(enrichedVd),
      buildVendorSuffixSlot(vendorSuffix),
      buildProvenanceContradictionSlot(enrichedVd, vendorSuffix),
    ].filter(Boolean),
  });
}

const MILEAGE_SOURCE_LABELS = {
  copart_listed: 'the Copart listing field',
  listing_odometer: 'the listing description',
  photo_odometer: 'the dashboard photo',
  dvsa_mot: 'the last DVSA MOT record',
  default_fallback: 'a default estimate',
};

// Reuses the code's EXISTING mileage-hygiene signals (motMileageFlag / photoMileageFlag /
// age-estimate source) rather than re-deriving comparison logic — those flags already ARE the
// corroboration check; this slot just forces them into a verdict instead of leaving them as
// prose the model might restate inconsistently.
function buildMileageCorroborationSlot(enrichedVd, brMileage, brMileageSource) {
  const fmtMiles = (n) => `${Number(n).toLocaleString('en-GB')} miles`;
  const flagText = enrichedVd.motMileageFlag || enrichedVd.photoMileageFlag || null;

  if (flagText) {
    return buildSlot({
      id: 'mileage-corroboration', label: 'Mileage corroborated against other sources',
      kind: 'confirmation', verdict: 'discrepancy',
      detail: String(flagText).replace(/^[⚠️\s|]+/, '').trim(),
      confidence: 'visible', source: 'code',
      flag: { severity: 'caution', whatsapp: 'Mileage sources do not agree — confirm actual mileage (dash photo plus V5/MOT paperwork) before bidding', tier: 1 },
    });
  }

  if (brMileageSource === 'age_estimate' || brMileageSource === 'age_anomaly') {
    return buildSlot({
      id: 'mileage-corroboration', label: 'Mileage corroborated against other sources',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: `${fmtMiles(brMileage)} — ESTIMATED from vehicle age only; no listing, photo or DVSA mileage was available`,
      confidence: 'inferred', source: 'code',
      flag: { severity: 'caution', whatsapp: 'No confirmed mileage is available for this lot — photograph the odometer clearly and confirm it against the V5/MOT paperwork before bidding', tier: 1 },
    });
  }

  const sourceLabel = MILEAGE_SOURCE_LABELS[brMileageSource] || brMileageSource;
  return buildSlot({
    id: 'mileage-corroboration', label: 'Mileage corroborated against other sources',
    kind: 'confirmation', verdict: 'confirmed',
    detail: `${fmtMiles(brMileage)} from ${sourceLabel} — no discrepancy flagged against the other available sources`,
    confidence: 'corroborated', source: 'code',
  });
}

// Generalised salvage-count slot — consumes selfMatchCount/recordsExcludingSelf from the
// generalised tagSelfReference() above. 0 excl. self = clean; 1 = note worth a light WhatsApp
// question (was it repaired with paperwork?); 2+ = a repeat write-off pattern, a real red flag.
function buildSalvageCountSlot(enrichedVd, proseFlags) {
  const sh = enrichedVd.salvageHistory;
  if (!sh) {
    return buildSlot({
      id: 'salvage-count-excl-self', label: 'Prior salvage auction history',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'Salvage auction history lookup was unavailable for this lot',
      confidence: 'hidden', source: 'code',
    });
  }
  const found = sh.salvage_auction_record_found === true;
  let excl = sh.recordsExcludingSelf ?? 0;
  let proseOverrideApplied = false;

  // Prose corroboration override — only on the 1-prior case where code missed the self-reference.
  // Code wins upward: on 2+ priors, prose cannot reduce the count (code holds the API record count).
  const proseCorroboratesSelf = proseFlags?.salvageSelfReferenceConfirmed === true;
  // Guard: selfMatchCount===0 means code found no self-match; prose may have caught what code missed.
  // When selfMatchCount>=1 code already handled the self-reference — the remaining excl is a genuine prior.
  if (excl === 1 && !sh.isSelfReferenceFirstWriteOff && proseCorroboratesSelf && (sh.selfMatchCount ?? 0) === 0) {
    // Second line of defence, freed of its date guard (Vincent, 29 Aug — the 14-day window is retired
    // everywhere). The lot-number id test is primary; a self-reference it could not make — e.g. a
    // non-Copart lot in a different numbering — can still be rescued by the model's prose confirmation.
    // Invariant: excl===1 && selfMatchCount===0 ⟹ records.length===1, so records[0] is the single candidate.
    //
    // §1 TIGHTENING (Vincent, 29 Aug): prose may overrule ONLY when there is NO id to check. A present
    // salvage_auction_record_id is a fact — and in this branch (selfMatchCount===0) it necessarily did
    // NOT match vd.lotNumber, so it is positive evidence of a DIFFERENT auction event. Prose does not
    // get to overrule that. An ABSENT id is absence of evidence — the only case where the model's read
    // adds anything, and the only path by which this design could ever HIDE a genuine prior (the
    // direction Vincent has consistently ruled against).
    const candidate = (sh.salvage_auction_records || [])[0];
    const candId = candidate?.salvage_auction_record_id;
    const lotNo  = enrichedVd.lotNumber;
    // Refuse ONLY when BOTH ids are present and they differ — two values cannot "differ" when one is
    // absent. Inside this branch (selfMatchCount===0) two PRESENT ids necessarily differ (tagSelfReference
    // would have matched them), so the substantive guard is `lotNo != null`: `vd.lotNumber` is optional
    // (parsed from the Copart paste; absent on IAA / paste-less lots), and without a lot number on our
    // side NOTHING was compared — a present record id is then absence-of-evidence, not evidence of a
    // distinct sale. Refusing there would close exactly the non-Copart rescue path §1 exists to preserve.
    const idsPresentAndDiffer = candId != null && lotNo != null && String(candId).trim() !== String(lotNo).trim();
    if (idsPresentAndDiffer) {
      console.error(`[SALVAGE SELF-REF OVERRIDE REFUSED] Prose claims self-reference but record id ${candId} differs from lot ${lotNo} — a present, non-matching id is evidence of a distinct auction event; prose cannot overrule a fact. Genuine prior retained.`);
    } else if (candId == null) {
      console.error('[SALVAGE SELF-REF OVERRIDE] Permitted — no record id to check (absent id); prose confirmed a self-reference the lot-number test could not make. effectiveExcl 1 → 0. Review tagSelfReference() for this lot.');
      excl = 0;
      proseOverrideApplied = true;
    } else {
      console.error(`[SALVAGE SELF-REF OVERRIDE] Permitted — no lot number on our side to compare against record id ${candId}; prose is the best signal available (non-Copart / paste-less lot). effectiveExcl 1 → 0. NB if this line fires often, lot numbers are not being parsed on some source — worth knowing.`);
      excl = 0;
      proseOverrideApplied = true;
    }
  }
  if (excl >= 2 && proseCorroboratesSelf) {
    console.error('[SALVAGE SELF-REF MISMATCH] Prose claims self-reference but code found 2+ records excluding self. Code wins upward — override not applied. Investigate.');
  }
  // Reconciled count: consumed by BOTH the CORE slot below and the Salvage History Check render surfaces.
  // Set once here so the two surfaces can never diverge.
  sh.genuinePriorCount = excl;

  if (!found || excl === 0) {
    return buildSlot({
      id: 'salvage-count-excl-self', label: 'Prior salvage auction history',
      kind: 'confirmation', verdict: 'confirmed',
      detail: 'No prior salvage auction events found, excluding this listing',
      confidence: 'corroborated', source: proseOverrideApplied ? 'code+model' : 'code',
    });
  }
  if (excl === 1) {
    return buildSlot({
      id: 'salvage-count-excl-self', label: 'Prior salvage auction history',
      kind: 'confirmation', verdict: 'confirmed',
      detail: '1 prior salvage auction event found, excluding this listing — see Salvage History Check for details',
      confidence: 'corroborated', source: 'code',
      flag: { severity: 'info', whatsapp: 'This vehicle has one prior salvage auction record — ask the handler whether the prior repair has any paperwork available', tier: 1 },
    });
  }
  return buildSlot({
    id: 'salvage-count-excl-self', label: 'Prior salvage auction history',
    kind: 'confirmation', verdict: 'discrepancy',
    detail: `${excl} prior salvage auction events found, excluding this listing — repeat write-off pattern materially raises risk`,
    confidence: 'corroborated', source: 'code',
    flag: { severity: 'red', whatsapp: `This vehicle has been through salvage auction ${excl} times before this listing — ask the handler for the full repair history and treat the valuation as high-risk`, tier: 1 },
  });
}

function buildMileageGroup(enrichedVd, brMileage, brMileageSource, proseFlags) {
  return buildGroup({
    id: CORE_GROUPS.MILEAGE.id, label: CORE_GROUPS.MILEAGE.label,
    slots: [
      buildMileageCorroborationSlot(enrichedVd, brMileage, brMileageSource),
      buildSalvageCountSlot(enrichedVd, proseFlags),
    ],
  });
}

function findCornerObs(coreObs, corner) {
  return (coreObs.corners || []).find(c => c?.corner === corner) || null;
}

// 06 Jun fix — SR16GOT slot/prose clash: these details name the SAME 4 states the model records
// in `recordCoreObservations` and reasons about in prose, so the slot can never land on a verdict
// the model itself wouldn't also write down ("appears intact" in the slot iff "appears intact"
// in the Visible Damage Summary).
//
// 06 Jun follow-up (BL75JAU false reassurance): a shredded rear tyre, glimpsed only
// incidentally in a general shot, was recorded "appears intact" — a positive claim made on
// a view too weak to support it. Absence of visible damage in a poor/incidental view is NOT
// evidence the thing is fine. The schema descriptions below now require a genuinely
// assessable view to claim "appears intact"; anything weaker — partial, obscured, too small
// to judge — must land on "genuinely-not-visible" (the can't-confirm state). Detail/flag
// wording for that state is phrased to cover both "absent" and "seen but not clearly enough".
const WHEEL_VERDICT_DETAIL = {
  'dedicated-photo-intact': 'Dedicated close-up shows the wheel intact — no visible damage',
  'no-dedicated-shot-but-appears-intact': 'No dedicated close-up, but clearly visible and assessable in the general photos, and appears intact — confirm on inspection',
  damaged: 'Damaged — visible deformation, cracking or buckling',
  'genuinely-not-visible': 'Not clearly visible — confirm on inspection',
};
const TYRE_VERDICT_DETAIL = {
  'dedicated-photo-intact': 'Dedicated close-up shows the tyre intact — no visible damage',
  'no-dedicated-shot-but-appears-intact': 'No dedicated close-up, but clearly visible and assessable in the general photos, and appears intact — confirm on inspection',
  damaged: 'Damaged — visible cuts, bulges or abnormal wear',
  'genuinely-not-visible': 'Not clearly visible — confirm on inspection',
};
const CORNER_VERDICT_CONFIDENCE = {
  'dedicated-photo-intact': 'visible',
  'no-dedicated-shot-but-appears-intact': 'inferred',
  damaged: 'visible',
  'genuinely-not-visible': 'hidden',
};
// Flag wording is keyed off WHICH gap the model reported — "looks fine but no dedicated shot"
// reads very differently to a buyer than "we can't see this corner at all", and the verdict
// (the model's own observation, not a derived visibility flag) is what decides which is true.
const CORNER_FLAG_WHATSAPP = {
  'no-dedicated-shot-but-appears-intact': corner => `Get a close-up of the ${CORNER_LABELS[corner].toLowerCase()} wheel and tyre — they look fine in the wider shots but there's no dedicated photo to confirm`,
  'genuinely-not-visible': corner => `Photograph the ${CORNER_LABELS[corner].toLowerCase()} wheel and tyre square-on — not clearly visible enough to confirm in the current photo set`,
};

function buildWheelSlot(corner, cornerObs) {
  const verdict = cornerObs?.wheelVerdict || 'genuinely-not-visible';
  const flagWhatsapp = CORNER_FLAG_WHATSAPP[verdict];
  return buildSlot({
    id: wheelSlotId(corner), label: `${CORNER_LABELS[corner]} wheel`,
    kind: 'wheel', verdict,
    detail: WHEEL_VERDICT_DETAIL[verdict] || WHEEL_VERDICT_DETAIL['genuinely-not-visible'],
    confidence: CORNER_VERDICT_CONFIDENCE[verdict] || 'hidden',
    source: 'model',
    flag: flagWhatsapp ? { severity: 'info', whatsapp: flagWhatsapp(corner), tier: 1 } : null,
  });
}

function buildTyreSlot(corner, cornerObs) {
  const verdict = cornerObs?.tyreVerdict || 'genuinely-not-visible';
  return buildSlot({
    id: tyreSlotId(corner), label: `${CORNER_LABELS[corner]} tyre`,
    kind: 'tyre', verdict,
    detail: TYRE_VERDICT_DETAIL[verdict] || TYRE_VERDICT_DETAIL['genuinely-not-visible'],
    confidence: CORNER_VERDICT_CONFIDENCE[verdict] || 'hidden',
    source: 'model',
    // No flag here — the wheel slot for the same corner already raises the "photograph this
    // corner" question; duplicating it per-tyre would double the WhatsApp item for one gap.
    flag: null,
  });
}

function buildPhysicalGroup(coreObs) {
  const slots = [];
  for (const corner of WHEEL_CORNERS) {
    const cornerObs = findCornerObs(coreObs, corner);
    slots.push(buildWheelSlot(corner, cornerObs));
    slots.push(buildTyreSlot(corner, cornerObs));
  }
  return buildGroup({ id: CORE_GROUPS.PHYSICAL.id, label: CORE_GROUPS.PHYSICAL.label, slots });
}

const LAMP_DETECTION_CONFIDENT_WORDING = false; // flip to true after false-positive guard passes (present-but-bumper-off lot)

// Fetch all lot images from Supabase Storage as base64 data URLs.
// Throws if any image cannot be retrieved — partial image sets are the unsafe failure mode.
async function fetchImagesFromStorage(supabase, imagePaths) {
  return Promise.all(imagePaths.map(async (path, i) => {
    const { data: blob, error } = await supabase.storage.from('lot-images').download(path);
    if (error || !blob) {
      throw new Error(`Storage fetch failed for image ${i + 1} of ${imagePaths.length}: ${error?.message || 'file not found'}`);
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }));
}

// Resize a stored base64 image to max 1024px longest edge for Haiku odo call only.
// Haiku's ceiling is 1568 TOKENS (not pixels); a 1568px image (~2,458 tokens) exceeds
// it, triggering API-side downsampling + double-JPEG that smears digits. 1024px keeps
// every image under the token ceiling with a single clean encode.
async function resizeToHaikuSafe(img) {
  const MAX = 1024;
  let mediaType = 'image/jpeg';
  let src = img;
  const m = img.match(/^data:([^;]+);base64,(.+)$/);
  if (m) { mediaType = m[1]; src = m[2]; }
  try {
    const loaded = await loadImage(Buffer.from(src, 'base64'));
    const { width, height } = loaded;
    if (width <= MAX && height <= MAX) {
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: src } };
    }
    const scale = MAX / Math.max(width, height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(loaded, 0, 0, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
  } catch {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: src } };
  }
}

// Retry wrapper for Anthropic 529/503 (server-side overload). Documented fix: bounded
// exponential backoff + jitter. Jitter is mandatory — un-jittered concurrent retries
// self-DoS and amplify the overload. MAX_RETRIES=3 → up to 4 attempts.
// Returns { res, exhausted, lastRequestId }. Network errors return exhausted=false so the
// caller's existing non-ok path handles them; 529-exhaustion sets exhausted=true.
const MAX_RETRIES = 3;

async function with529Retry(name, fetchThunk) {
  let attempt = 0;
  let lastRequestId = null;
  while (true) {
    let res;
    try { res = await fetchThunk(); } catch (_) {
      return { res: null, exhausted: false, lastRequestId };
    }
    lastRequestId = res.headers?.get('request-id') || res.headers?.get('x-request-id') || null;
    if (res.status !== 529 && res.status !== 503) {
      if (attempt > 0) console.log(`[529 RECOVERED] call=${name} after=${attempt}`);
      return { res, exhausted: false, lastRequestId };
    }
    if (attempt >= MAX_RETRIES) {
      console.error(`[529 EXHAUSTED] call=${name} request_id=${lastRequestId}`);
      return { res, exhausted: true, lastRequestId };
    }
    const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
    console.warn(`[529 RETRY] call=${name} attempt=${attempt + 1}/${MAX_RETRIES} request_id=${lastRequestId} backoff=${backoff}ms`);
    await new Promise(r => setTimeout(r, backoff));
    attempt++;
  }
}

async function runLampDetection(images, onExhaust) {
  try {
    if (images.length > 35) console.warn(`[LAMP DETECT] image set truncated to 35 (received ${images.length})`);
    const imageBlocks = images.slice(0, 35).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const userText = `Examine ALL images carefully before forming any verdict — survey every photo to locate the front corners before deciding.

For EACH front headlamp position (both corners), determine whether a headlamp unit is physically present in the aperture or the mount is empty. A displaced bumper can expose an empty recess that looks occupied — judge whether an actual lens/reflector/lamp body is present, not just that the recess is visible. Report per corner. Describe each corner by its relation to the body damage (e.g. 'the corner with the major impact damage' / 'the undamaged corner') or as left/right as viewed — do NOT use offside/nearside. Also state the lamp TYPE if determinable (halogen / HID / LED-adaptive).

Respond with a JSON array only — no markdown, no explanation, nothing else:
[
  {
    "corner_descriptor": "brief description identifying the corner",
    "verdict": "present" | "missing" | "cannot_determine",
    "lamp_type": "halogen" | "hid" | "led" | "indeterminate",
    "evidence": "one sentence describing what you can see"
  }
]`;
    const { res, exhausted } = await with529Retry('lamp-detect', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 1024,
        system: 'You are a vehicle damage assessor. Respond ONLY with a valid JSON array. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: userText }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return null; }
    if (!res?.ok) { console.warn('[LAMP DETECT] API error:', res?.status); return null; }
    const data = await res.json();
    console.log('[TOKEN LOG] lamp-detect Input:', data.usage?.input_tokens, '| Output:', data.usage?.output_tokens, '| Stop:', data.stop_reason, '| Model:', data.model || 'unknown');
    if (data.stop_reason === 'max_tokens') { console.warn('[LAMP DETECT] max_tokens — response truncated; lamp path returning null'); return null; }
    if (data.stop_reason === 'refusal')   { console.warn('[LAMP DETECT] refusal — content policy; lamp path returning null'); return null; }
    const raw = ((data.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) { console.warn('[LAMP DETECT] no JSON array in response:', raw.slice(0, 200)); return null; }
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[LAMP DETECT] error:', err.message);
    return null;
  }
}

// EV Step 3 — closed telltale enum the dash read may emit (array, may be empty). Parse validates
// every element against this list; unknowns are dropped with a breadcrumb. BATTERY_12V exists to
// stop the ordinary 12V charging symbol being misclassified into the EV/HV set.
const DASH_TELLTALE_ENUM = [
  'HV_BATTERY_WARNING', 'EV_SYSTEM_WARNING', 'COOLANT_TEMP', 'OIL_PRESSURE', 'AIRBAG_SRS',
  'ABS_BRAKE', 'STEERING_EPS', 'ENGINE_MIL', 'BATTERY_12V', 'TPMS', 'OTHER_TELLTALE',
];
// Code-owned grouping (NOT model-emitted): the EV/HV telltales that fire the expensive-repair flag.
const EV_HV_SET = ['HV_BATTERY_WARNING', 'EV_SYSTEM_WARNING'];
// Buyer-readable labels for the code-owned dashboard line (never show raw enum codes to buyers).
const TELLTALE_LABELS = {
  HV_BATTERY_WARNING: 'HV battery warning', EV_SYSTEM_WARNING: 'EV system fault',
  COOLANT_TEMP: 'coolant temperature', OIL_PRESSURE: 'oil pressure', AIRBAG_SRS: 'airbag/SRS',
  ABS_BRAKE: 'ABS/brake', STEERING_EPS: 'power steering', ENGINE_MIL: 'engine (MIL)',
  BATTERY_12V: '12V charging', TPMS: 'tyre pressure', OTHER_TELLTALE: 'other warning',
};
// Inherit the lamp-detect lesson: cautious wording default OFF; the flag always fires, only the
// wording strength is toggled once the false-positive guard has proven out.
const TELLTALE_CONFIDENT_WORDING = false;

async function runDashClusterRead(images, onExhaust, vehicleDesc) {
  const mismatchBlock = vehicleDesc
    ? `\nBODY-STYLE CROSS-CHECK — one field only:\nYou are given this data descriptor for this vehicle: "${vehicleDesc}". Scan ALL photos. Does any photo CLEARLY show this is a different vehicle TYPE — e.g. the descriptor says hatchback but the car is unmistakably a van, lorry, or motorbike? This is a STRICT mismatch test: default "match" or "unclear" unless the contradiction is beyond any doubt. Borderline SUV-vs-hatchback = "unclear". Fire "mismatch" ONLY on unambiguous cross-type contradiction (identity risk).`
    : '';
  const DASH_PROMPT = `You are reading instrument cluster state from salvage vehicle auction photos.

Apply this three-step decision in order:
1. Is a cluster/instrument panel visible in any photo? If no → return cluster "no-photo".
2. Is the cluster present but unlit or dark (engine not running, display off, photo too dark to judge)? If yes → return cluster "unlit". A dark cluster tells you nothing about warning state and must NOT be read as clean — but note it WAS photographed.
3. Cluster is visible AND lit/powered. Are any warning telltale icons lit? If yes → return cluster "warning". If no → return cluster "clean".

TELLTALES — a CLOSED list; emit ONLY these exact tokens in the "telltales" array:
  HV_BATTERY_WARNING  — HV/traction battery warning, turtle symbol, "check EV system"
  EV_SYSTEM_WARNING   — EV/hybrid system fault, isolation fault, charge-system warning
  COOLANT_TEMP        — coolant temperature / low coolant warning
  OIL_PRESSURE        — oil pressure / low oil warning
  AIRBAG_SRS          — airbag / SRS lamp
  ABS_BRAKE           — ABS or brake system lamp
  STEERING_EPS        — power steering / EPS lamp
  ENGINE_MIL          — check engine / MIL
  BATTERY_12V         — 12V charging-system lamp (the ordinary battery symbol) — this is NOT an EV/HV signal; use it so you never misread the 12V symbol as an EV warning
  TPMS                — tyre pressure warning
  OTHER_TELLTALE      — any lit amber/red warning not in this list, OR a warning lit but unreadable
Rules: cluster "warning" MUST have at least one telltale token; cluster "clean" MUST have an empty telltales array. Only lit AMBER or RED telltales count. A normal EV "READY" / "ready to drive" indicator is NOT a warning (it is a healthy state) — do not emit any token for it. Informational text messages (e.g. a park-assist sensor message) → OTHER_TELLTALE. Empty array when cluster is no-photo, unlit or clean.

HV MARKINGS — one boolean:
Set hvMarkings true ONLY on unambiguous high-voltage evidence anywhere in the photos: thick ORANGE HV cabling / conduit / connectors in the engine bay or underbody, or an HV / "HIGH VOLTAGE" warning label or sticker. Ordinary orange objects (trim, reflectors, wiring that is not clearly HV conduit) do NOT count. When in doubt, false.

AIRBAG FIELD — three states, image-grounded only:
- "no-photo": cluster not visible / dark / unlit (same condition family as cluster no-photo above)
- "not-lit": cluster lit AND no airbag warning telltale is illuminated
- "warning-lit": cluster lit AND airbag warning telltale is visibly illuminated
Do NOT infer airbag deployment from steering wheel damage or cabin trim — those are separate visual observations. Report only what the cluster telltale light shows.

WINDSCREEN STICKER SUFFIX — one field only:
Look for a long white PRINTED Copart lot-number sticker on the windscreen — usually near the top, but its exact position varies by vehicle type (vans and high-roof vehicles sit it higher or off-centre). It shows a multi-digit lot number followed by a single capital letter suffix (X, P, C, or Q). Read that trailing capital letter. It is a PRINTED sticker — NOT chalk marks, NOT handwritten yard annotations, NOT circled numbers on the glass.
- No white printed sticker visible → sticker: ""
- Sticker present but the suffix letter at its right end is not clearly legible → sticker: "UNREADABLE"
- Sticker present AND suffix letter clearly legible → sticker: that single letter (one of: X, P, C, Q; use "OTHER" for any other letter)
${mismatchBlock}
Return a raw JSON object only — no markdown, no explanation, no surrounding text:
{ "cluster": "no-photo" | "unlit" | "clean" | "warning", "telltales": ["<zero or more enum tokens; empty unless cluster is warning>"], "airbag": "no-photo" | "not-lit" | "warning-lit", "sticker": "<suffix letter, UNREADABLE, or empty string>", "bodyStyleMismatch": "match" | "mismatch" | "unclear", "hvMarkings": true | false }`;

  const FLOOR = { cluster: 'no-photo', telltales: [], airbag: 'no-photo', sticker: '', bodyStyleMismatch: 'unclear', hvMarkings: false };
  try {
    if (images.length > 35) console.warn(`[DASH READ] image set truncated to 35 (received ${images.length})`);
    const imageBlocks = images.slice(0, 35).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const { res, exhausted } = await with529Retry('dash-read', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 512,
        system: 'You are a vehicle assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: DASH_PROMPT }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return FLOOR; }
    if (!res?.ok) { console.warn('[DASH READ] API error:', res?.status); return FLOOR; }
    const apiData = await res.json();
    console.log('[TOKEN LOG] dash-read Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
    if (apiData.stop_reason === 'max_tokens') { console.warn('[DASH READ] max_tokens — truncated; defaulting floor'); return FLOOR; }
    if (apiData.stop_reason === 'refusal')   { console.warn('[DASH READ] refusal — content policy; defaulting floor'); return FLOOR; }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[DASH READ] no JSON object in response:', raw.slice(0, 200)); return FLOOR; }
    const parsed = JSON.parse(match[0]);
    const cluster = ['no-photo', 'unlit', 'clean', 'warning'].includes(parsed.cluster) ? parsed.cluster : 'no-photo';
    const airbag  = ['no-photo', 'not-lit', 'warning-lit'].includes(parsed.airbag) ? parsed.airbag : 'no-photo';
    // Telltale array — validate every element against the closed enum; drop unknowns (breadcrumb),
    // never pass them through. Only meaningful on cluster==='warning'; empty otherwise.
    const rawTelltales = Array.isArray(parsed.telltales) ? parsed.telltales : [];
    const telltales = cluster === 'warning'
      ? [...new Set(rawTelltales.filter(t => {
          const ok = DASH_TELLTALE_ENUM.includes(t);
          if (!ok) console.warn(`[DASH READ] dropped unknown telltale token "${t}"`);
          return ok;
        }))]
      : [];
    const hvMarkings = parsed.hvMarkings === true;
    const rawSticker = typeof parsed.sticker === 'string' ? parsed.sticker.trim().toUpperCase() : '';
    const VALID_STICKER = ['X', 'P', 'C', 'Q', 'OTHER', 'UNREADABLE', ''];
    const sticker = VALID_STICKER.includes(rawSticker) ? rawSticker : 'UNREADABLE';
    console.log(`[DASH READ] rawSticker="${rawSticker}" → sticker="${sticker}"`);
    const bodyStyleMismatch = ['match', 'mismatch', 'unclear'].includes(parsed.bodyStyleMismatch) ? parsed.bodyStyleMismatch : 'unclear';
    return { cluster, telltales, airbag, sticker, bodyStyleMismatch, hvMarkings };
  } catch (err) {
    console.warn('[DASH READ] error:', err.message);
    return FLOOR;
  }
}

// Closed vendor-suffix enum for the targeted re-read (mirrors the primary dash-read's VALID_STICKER).
const STICKER_ENUM = ['X', 'P', 'C', 'Q', 'OTHER', 'UNREADABLE', ''];
// Legible-letter set for the retry adoption test. Single vocabulary owner is STICKER_ENUM; this is
// derived (STICKER_ENUM minus the two miss states) so the letter list is never copied a second time.
const STICKER_LEGIBLE = STICKER_ENUM.filter(s => s !== '' && s !== 'UNREADABLE');

// Frame-zone classification (always-run; supersedes the on-demand sticker frame-ID it replaces).
// One Haiku pass over ALL frames at 1024px (resizeToHaikuSafe — the token-ceiling fit), returning
// per-frame vehicle-aspect zones + windscreen-label visibility. Feeds the sticker retry's targeted
// read (windscreenLabel frames) and the attribution probe's frame selection (aspect zones).
// Isolated from the money pipeline; fails to { ok:false, frames:[] } so every consumer takes its
// full-set fallback (silence is a defect, never a silent skip).
const FRAME_ZONE_ENUM = ['front', 'rear', 'nearside', 'offside', 'roof', 'interior', 'detail'];

async function runFrameZoneId(images, onExhaust) {
  const emptyFail = { ok: false, frames: [] };
  try {
    const blocks = await Promise.all(images.slice(0, 35).map(resizeToHaikuSafe));
    const n = blocks.length;
    if (n === 0) return emptyFail;
    console.log(`[FRAME ZONE] firing over ${n} frame(s) source=haiku-1024px`);
    const prompt = `Each image is one photo of a salvage vehicle, numbered 0 to ${n - 1} in the order given.
For EACH photo, report which aspects of the vehicle it shows and whether the windscreen lot label is visible.
- zones: which aspects of the vehicle the photo shows. Use only these words: front, rear, nearside, offside, roof, interior, detail. A photo may show more than one — a three-quarter shot showing the front and one side is ["front","nearside"]. Use "detail" for a close-up of one part or area that does not frame a whole aspect (a single wheel, a panel edge, a VIN plate). Use "interior" for cabin or dashboard shots.
- windscreenLabel: true only when the printed white lot-number label and/or grease-pen lot number on the windscreen glass is visible in that photo; false otherwise.
Return a raw JSON object only, no other text:
{ "frames": [ { "i": <photo index>, "zones": ["<zone words>"], "windscreenLabel": true|false } ] }`;
    const { res, exhausted } = await with529Retry('frame-zone', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessLight,
        max_tokens: 3072,   // headroom: a truncated (max_tokens) reply is unparseable → global full-set fallback, so buy margin over ~35×30-tok frames
        system: 'You are a vehicle photo classifier. Respond ONLY with a raw JSON object. No markdown, no explanation.',
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return emptyFail; }
    if (!res?.ok) { console.warn('[FRAME ZONE] API error:', res?.status); return emptyFail; }
    const apiData = await res.json();
    console.log('[TOKEN LOG] frame-zone Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
    if (apiData.stop_reason === 'max_tokens') { console.warn('[FRAME ZONE] max_tokens — truncated; failed state'); return emptyFail; }
    if (apiData.stop_reason === 'refusal')   { console.warn('[FRAME ZONE] refusal — content policy; failed state'); return emptyFail; }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.warn('[FRAME ZONE] no JSON object in response; failed state'); return emptyFail; }
    const parsed = JSON.parse(m[0]);
    const rawFrames = Array.isArray(parsed.frames) ? parsed.frames : null;
    if (!rawFrames) { console.warn('[FRAME ZONE] no frames array; failed state'); return emptyFail; }
    const seen = new Set();
    const frames = [];
    for (const f of rawFrames) {
      const i = Number.isInteger(f?.i) ? f.i : null;
      if (i === null || i < 0 || i >= n || seen.has(i)) continue;        // in-range unique indices only
      seen.add(i);
      const rawZones = Array.isArray(f.zones) ? f.zones : [];
      const zones = [...new Set(rawZones
        .map(z => (typeof z === 'string' ? z.trim().toLowerCase() : ''))
        .filter(z => {
          const ok = FRAME_ZONE_ENUM.includes(z);
          if (!ok && z) console.warn(`[FRAME ZONE] dropped unknown zone "${z}" (frame ${i})`);
          return ok;
        }))];
      frames.push({ i, zones, windscreenLabel: f.windscreenLabel === true });
    }
    const zc = FRAME_ZONE_ENUM.reduce((a, z) => { a[z] = frames.filter(fr => fr.zones.includes(z)).length; return a; }, {});
    console.log(`[FRAME ZONE] ok=true frames=${frames.length}/${n} windscreenLabel=${frames.filter(fr => fr.windscreenLabel).length} zones=${JSON.stringify(zc)}`);
    return { ok: true, frames };
  } catch (err) {
    console.warn('[FRAME ZONE] error:', err.message);
    return emptyFail;
  }
}

// Targeted sticker re-read (Opus, FULL resolution) on the identified frame(s); falls back to the
// full set when frameIndices is empty (load-bearing fallback). Single-purpose: read the trailing
// vendor letter off the windscreen lot label / number. Output constrained to STICKER_ENUM.
// Returns '' on failure — the caller's resolution then preserves the primary read.
async function runStickerRead(images, frameIndices, onExhaust) {
  const all = images.slice(0, 35);
  const targeted = Array.isArray(frameIndices) && frameIndices.length
    ? frameIndices.map(i => images[i]).filter(Boolean)
    : [];
  const frameSet = targeted.length ? targeted : all;   // fallback: full set (never empty)
  try {
    const imageBlocks = frameSet.map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const mm = img.match(/^data:([^;]+);base64,(.+)$/);
      if (mm) { mediaType = mm[1]; data = mm[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const prompt = `These photos show one salvage vehicle. Find the printed white Copart lot-number label and/or the grease-pen lot number written on the WINDSCREEN glass. It is a multi-digit number ending in a single capital vendor letter — one of X, P, C, or Q. Read ONLY that trailing capital letter.
- No printed lot label or lot number visible on the windscreen glass → sticker: ""
- A lot label / number is visible but the trailing letter is not clearly legible → sticker: "UNREADABLE"
- The trailing letter is clearly legible → that single letter (X, P, C, or Q; use "OTHER" for any other letter)
Do NOT read chalk yard marks, circled numbers, or other handwritten annotations — only the lot number and its trailing letter.
Return a raw JSON object only, no other text: { "sticker": "<letter, UNREADABLE, or empty string>" }`;
    const { res, exhausted } = await with529Retry('sticker-read', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 64,
        system: 'You are a vehicle assessor. Respond ONLY with a raw JSON object. No markdown, no explanation.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return ''; }
    if (!res?.ok) { console.warn('[STICKER RETRY] API error:', res?.status); return ''; }
    const apiData = await res.json();
    console.log('[TOKEN LOG] sticker-read Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Model:', apiData.model || 'unknown');
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.warn('[STICKER RETRY] no JSON object in response'); return ''; }
    const parsed = JSON.parse(m[0]);
    const rawSticker = typeof parsed.sticker === 'string' ? parsed.sticker.trim().toUpperCase() : '';
    return STICKER_ENUM.includes(rawSticker) ? rawSticker : 'UNREADABLE';
  } catch (err) {
    console.warn('[STICKER RETRY] error:', err.message);
    return '';
  }
}

// Fault 1a — aperture panel read (torn / seam / mounting-structure / factory-symmetric). Dedicated
// single-purpose vision pass (mirrors runDashClusterRead): a bumper-off rear-quarter / front-wing is
// byte-identical on every existing field between a genuinely torn panel, an intact seam merely exposed
// by the missing bumper, torn bumper-mounting furniture standing in front of a clean panel, and a
// factory styling pressing that reads as a crease. This read is the ONLY signal that separates them.
// It judges the PANEL'S OWN OUTER FACE: torn/folded/buckled on the face = genuine impact (keep cost);
// straight intact seam, torn mounting furniture, OR a feature matched on the undamaged opposite side,
// all with a clean face = no panel damage (demote to flag). Returns a constrained enum; CODE owns the cost decision.
// Fail-safe: any failure/exhaust → null; invalid verdict → 'ambiguous'. Both keep cost
// (policy: on structure, ambiguity falls to assume-damage).
async function runAperturePanelRead(images, lampObs, frameIndices, apertureZone, onExhaust) {
  // Per-suspect corner steer (C1): zone comes from the caller's suspect tag, not lampObs aggregation.
  // struckSide is a FRONT-impact datum (C2 ruling) — it steers the FRONT hint only, never a rear read.
  const isRear     = apertureZone === 'rear';
  const bumperWord = isRear ? 'rear bumper' : 'front bumper';
  const sideWord   = (!isRear && (lampObs?.struckSide === 'offside' || lampObs?.struckSide === 'nearside'))
    ? lampObs.struckSide + ' ' : '';
  const cornerHint = isRear ? 'rear' : `${sideWord}front`;
  const APERTURE_PROMPT = `You are judging a single salvage vehicle from auction photos. The ${bumperWord} is displaced or torn away on the ${cornerHint} corner, exposing the body panel behind it (the rear quarter panel for a rear corner, the front wing for a front corner).

Survey ALL photos to locate that corner, then focus on the ${cornerHint} corner where the bumper is displaced. Judge the BODY PANEL'S OWN METAL — not the bumper, not the panel gap:

SURFACE SELECTION — read this before judging: with the bumper displaced or absent, TWO different surfaces are visible at this corner. (1) The OUTER PAINTED FACE — the smooth, body-coloured skin that was visible before the bumper left. (2) The EXPOSED INNER STRUCTURE — bumper mounting brackets, closing panels, vent housings, wiring, apertures, and unfinished or roughly painted metal that the bumper used to cover. The inner structure is irregular, rough, and cluttered BY DESIGN — it is NOT damage and must NOT be graded, and torn, bent, or exposed mounting furniture (mounting rails, carrier brackets, closing-panel tinware) visible in front of the panel is the MOUNTING-STRUCTURE verdict below, never TORN. Factory pressed swage or character lines running along the flank are styling, not creases. Judge ONLY the outer painted face. If the outer painted face shows smooth, continuous paint and reflections, the panel is undamaged regardless of how rough the exposed inner region looks.

TORN = deformation on the OUTER PAINTED FACE, away from the bumper-mating edge and away from exposed inner structure and mounting hardware: sharp creases radiating into the panel face, dents or crumpling on the face, cracked or scuffed paint at the deformation, or a body line misaligned versus the adjacent door or panel. This is genuine impact to the panel's own skin.
SEAM = a factory pressed flange, fold, return edge, seam, or join line at the panel's bumper-mating edge, now visible ONLY because the bumper is displaced or absent. The factory closure line is STRAIGHT, UNIFORM, and WELL-DEFINED — it runs a consistent, manufactured path. A clean, regular line at the exposed edge is evidence the panel is UNDAMAGED: you are seeing the join the bumper used to cover. Deformation at or along the exposed mating edge alone, with the panel face otherwise clean, is SEAM.
MOUNTING-STRUCTURE = torn, bent, or exposed bumper-mounting FURNITURE — not the panel's outer face. Serrated bumper mounting rails (sawtooth-profile black strips are FACTORY HARDWARE, not creased metal), carrier brackets, and lower closing-panel / carrier tinware all tear away with a displaced bumper. The outer painted face itself shows NO deformation — its paint and reflections are continuous. The damage belongs to the bumper assembly, not to this panel.
FACTORY-SYMMETRIC = the feature that appears to be damage on this panel is present in the SAME position and shape on the opposite-side equivalent panel in the reference frames — it is factory styling (haunch pressing, character line, swage) or a shared reflection pattern, not impact. The panel is UNDAMAGED.

ATTRIBUTE BY WHAT, NOT WHERE: choose the verdict by which component the damaged metal belongs to, not by where it sits in the frame. Torn metal at the panel's edge that is part of the bumper carrier or its mounting furniture is MOUNTING-STRUCTURE even though it lies inside the panel's visual region. Only deformation of the panel's OWN outer painted face is TORN.

GEOMETRY TEST — apply before deciding TORN: genuine impact creasing is IRREGULAR — it changes direction, varies in depth, breaks the panel's reflection, and disturbs the paint. The factory closure line does none of these. Any crease you intend to cite as TORN must be visibly DISTINCT from the straight closure line and from shadow cast at the exposed edge. If the only "damage" you can see follows a straight, uniform path, it is the factory closure — verdict SEAM.

MANDATORY BEFORE ANY "torn" VERDICT — OPPOSITE-SIDE TEST: when frames of the opposite-side equivalent panel are provided, you MUST examine the same location on the undamaged side before returning "torn". Many body styles carry a pronounced factory haunch or character pressing sweeping over the rear wheel arch that breaks reflections and reads as a crease — it is styling, present identically on both sides. If the feature you intend to cite as damage appears in the same position and shape on the opposite side, the verdict is FACTORY-SYMMETRIC. Return "torn" only when you can state in your evidence sentence what is DIFFERENT from the opposite side at that location. If opposite-side frames are provided and you cannot articulate the asymmetry, the verdict is "ambiguous", not "torn".

Return ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{ "verdict": "torn" | "seam" | "mounting-structure" | "factory-symmetric" | "ambiguous", "evidence": "<one short sentence on the panel metal you can see; for a torn verdict, when opposite-side frames are provided, name what is DIFFERENT from the opposite side at that location>" }

Use "ambiguous" ONLY when the photos genuinely cannot resolve the panel's metal condition (angle, lighting, occlusion). Do NOT use "ambiguous" as a hedge when the metal condition is visible — decide torn, seam, mounting-structure, or factory-symmetric.`;
  try {
    if (images.length > 35) console.warn(`[APERTURE PANEL] image set truncated to 35 (received ${images.length})`);
    // C3 targeting: read the panel's targeted frames when given; else the full set (never empty).
    const all = images.slice(0, 35);
    const targeted = Array.isArray(frameIndices) && frameIndices.length ? frameIndices.map(i => images[i]).filter(Boolean) : [];
    const frameSet = targeted.length ? targeted : all;
    const imageBlocks = frameSet.map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    // Shared-image cache breakpoint — same 35-image payload + same system as correspondence;
    // this read fires after correspondence's cache write → cache READ ($0.50/M vs fresh $5/M).
    if (imageBlocks.length) imageBlocks[imageBlocks.length - 1].cache_control = { type: 'ephemeral' };
    const { res, exhausted } = await with529Retry('aperture-panel', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 512,
        system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: APERTURE_PROMPT }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return null; }
    if (!res?.ok) { console.warn('[APERTURE PANEL] API error:', res?.status); return null; }
    const apiData = await res.json();
    console.log('[TOKEN LOG] aperture-panel Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
    if (apiData.stop_reason === 'max_tokens') { console.warn('[APERTURE PANEL] max_tokens — truncated; returning null (keep-cost fail-safe)'); return null; }
    if (apiData.stop_reason === 'refusal')   { console.warn('[APERTURE PANEL] refusal — content policy; returning null (keep-cost fail-safe)'); return null; }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[APERTURE PANEL] no JSON object in response:', raw.slice(0, 200)); return null; }
    const parsed = JSON.parse(match[0]);
    const verdict  = ['torn', 'seam', 'mounting-structure', 'factory-symmetric', 'ambiguous'].includes(parsed.verdict) ? parsed.verdict : 'ambiguous';
    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence : '';
    console.log(`[APERTURE PANEL] verdict=${verdict} evidence="${evidence}"`);
    return { verdict, evidence };
  } catch (err) {
    console.warn('[APERTURE PANEL] error:', err.message);
    return null;
  }
}

// ── Attribution probe (commit 2) — per costed panel, challenge the pipeline's own claim ───────
// Fired at the application point over the surviving costed set (Option B — universal by
// construction). Opus, one call per panel; a mismatch or non-verdict FLOORS (one-way, never
// promotes). Structured alongside the other targeted reads (aperture/sticker): imageBlocks map,
// with529Retry, trailing cache_control breakpoint, raw-JSON parse + closed-enum validation.

// Fixed, code-owned severity wording — single owner of the two costed grades' probe phrasing.
const PROBE_SEVERITY_WORDING = {
  SEVERE:   'seriously impact-damaged and requiring replacement',
  MODERATE: 'impact-damaged and requiring significant repair',
};

// Missing-class claim wording — single owner. Used when the ledger records the part ABSENT
// (_amalgMissing). The probe question and verdict enum invert accordingly (see runAttributionProbe).
const PROBE_MISSING_WORDING = 'missing, torn away in the impact';

// Code-owned inspection-flag wording for a probe-floored panel. Buyer-facing; no internal-
// contradiction leak. Missing-claim parts get a "recorded as missing … absence not confirmed"
// line (a "damage was recorded" flag against a missing claim is itself a self-contradiction).
// For the damaged class, SEVERE leads "Serious damage"; MODERATE drops the word.
function attribFlagWording(partName, grade, isMissing) {
  if (isMissing) {
    return `The ${partName} was recorded as missing during assessment but its absence could not be photographically confirmed — inspect this panel before bidding.`;
  }
  const lead = grade === 'SEVERE' ? 'Serious damage to the' : 'Damage to the';
  return `${lead} ${partName} was recorded during assessment but could not be photographically confirmed — inspect this panel before bidding.`;
}

// Panel zone → frame-zone aspect words. underside / anything unmapped → null → full set.
const PROBE_ZONE_MAP = {
  front: ['front'], rear: ['rear'], 'flank-damaged-side': ['nearside', 'offside'],
  roof: ['roof'], interior: ['interior'],
};
// Frame selection from the always-run frame-zone pass. Every fallback names itself in `source`
// (silence is a defect). null indices → the probe reads the full set.
function selectProbeFrames(frameZones, panelZone) {
  if (!frameZones.ok) return { indices: null, source: 'full-set:frame-zone-failed' };
  const want = PROBE_ZONE_MAP[panelZone];
  if (!want) return { indices: null, source: `full-set:no-zone-map(${panelZone})` };
  const idx = frameZones.frames.filter(f => f.zones.some(z => want.includes(z))).map(f => f.i).slice(0, 35);
  if (idx.length === 0) return { indices: null, source: `full-set:no-matched-frames(${panelZone})` };
  return { indices: idx, source: `frame-zone:[${idx.join(',')}]` };
}

// Attribution-probe frame targeting (C2). Precedence — each branch names itself in `source`
// (silence is a defect). Flank panels only; all other panels fall through to selectProbeFrames
// UNCHANGED, so front/rear/roof/interior targeting is byte-identical to before C2:
//   1. correspondence-split flank instance (_gOwned) → its OWN member frames (side-correct by
//      construction) — kills the flank both-sides blindness (E3) with no side inference.
//   2. pooled front-flank panel on a FRONT impact + determinate struckSide → frame-zone frames on
//      that side. struckSide is a front-impact datum (plate-relative-to-lights), so P2 is gated to
//      front-flank panels on an aperture-exposed (front) impact and never drives rear-corner side
//      inference (Q3). A pooled rear quarter falls through to P3.
//   3. everything else → zone-map → full-set fallback (selectProbeFrames), UNCHANGED.
const P2_FRONT_FLANK = new Set([PANEL.FRONT_WING, PANEL.FRONT_DOOR]);
function selectProbeFramesForPanel(cp, frameZones, struckSide, frontImpact) {
  if (cp._gOwned === true && Array.isArray(cp._probeViews) && cp._probeViews.length) {
    const idx = cp._probeViews.slice(0, 35);
    if (idx.length <= 2) console.log(`[ATTRIB PROBE] ${cp.panelId} thin instance set (${idx.length} frames)`);
    return { indices: idx, source: `corr-instance:[${idx.join(',')}]` };
  }
  if (frontImpact && P2_FRONT_FLANK.has(cp.panelId) && cp.zone === 'flank-damaged-side'
      && (struckSide === 'offside' || struckSide === 'nearside') && frameZones.ok) {
    const idx = frameZones.frames.filter(f => f.zones.includes(struckSide)).map(f => f.i).slice(0, 35);
    if (idx.length) {
      if (idx.length <= 2) console.log(`[ATTRIB PROBE] ${cp.panelId} thin struck-side set (${idx.length} frames)`);
      return { indices: idx, source: `struck-side:${struckSide}:[${idx.join(',')}]` };
    }
  }
  return selectProbeFrames(frameZones, cp.zone);
}

// Aperture-read frame targeting (C3). Sibling of selectProbeFramesForPanel; called per aperture-
// suspect panel. Precedence, each self-naming in `source`:
//   1. correspondence-split flank instance (_gOwned) → its OWN member frames (side-correct).
//   2. frame-zone frames on the aperture zone OR the struck side (union — the seam-vs-crease call
//      needs both the corner-facing and the struck-side profile evidence).
//   3. null → full-set fallback inside runAperturePanelRead.
function selectApertureFrames(cp, frameZones, struckSide, apertureZone) {
  if (cp._gOwned === true && Array.isArray(cp._probeViews) && cp._probeViews.length) {
    // Opposite-reference augmentation: append the Case-B excluded-CLEAN views so the C1 comparison
    // instruction has reference material (the split's damaged-only set starves it). Damaged frames
    // LEAD (index order = payload order); deduped refs FOLLOW. Thin-set log measures the damaged
    // instance (not the augmented set) — augmentation adds comparators, not damage evidence.
    const dmg  = cp._probeViews;
    const refs = Array.isArray(cp._oppRefViews) ? cp._oppRefViews.filter(i => !dmg.includes(i)) : [];
    const idx  = [...dmg, ...refs].slice(0, 35);
    if (dmg.length <= 2) console.log(`[APERTURE] ${cp.panelId} thin instance set (${dmg.length} frames)`);
    const source = refs.length
      ? `corr-instance+opp-ref:[${dmg.join(',')}]+[${refs.join(',')}]`
      : `corr-instance:[${dmg.join(',')}]`;
    return { indices: idx, source };
  }
  if (frameZones.ok) {
    const want = [apertureZone];
    if (struckSide === 'offside' || struckSide === 'nearside') want.push(struckSide);
    const idx = frameZones.frames.filter(f => f.zones.some(z => want.includes(z))).map(f => f.i).slice(0, 35);
    if (idx.length) {
      if (idx.length <= 2) console.log(`[APERTURE] ${cp.panelId} thin aperture-zone set (${idx.length} frames)`);
      return { indices: idx, source: `aperture-zone:${want.join('+')}:[${idx.join(',')}]` };
    }
  }
  return { indices: null, source: 'full-set:no-targeted-frames' };
}

const PROBE_VERDICT_ENUM = ['no-damage-visible', 'minor-cosmetic', 'consistent-with-claim', 'cannot-determine'];
// Missing-branch verdict vocabulary. Mapping is INVERTED vs the damaged branch: absent /
// area-destroyed CONFIRM a missing claim (keep); present-and-intact / minor-cosmetic-only
// CONTRADICT it (floor). cannot-determine is shared with the damaged enum and floors in both.
const PROBE_MISSING_VERDICT_ENUM = ['absent', 'area-destroyed', 'present-and-intact', 'minor-cosmetic-only', 'cannot-determine'];

// One probe call. Returns { verdict, note } when the model reached a verdict (off-enum coerces to
// 'cannot-determine' — a reached verdict floors). Returns null ONLY on infrastructure failure
// (exhaust / !ok / max_tokens / refusal / parse throw) — the caller stamps probe-error and KEEPS.
async function runAttributionProbe(images, frameIndices, partName, claimWording, isMissing, onExhaust) {
  const all = images.slice(0, 35);
  const targeted = Array.isArray(frameIndices) && frameIndices.length
    ? frameIndices.map(i => images[i]).filter(Boolean) : [];
  const frameSet = targeted.length ? targeted : all;   // full-set fallback (never empty)
  try {
    const imageBlocks = frameSet.map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const mm = img.match(/^data:([^;]+);base64,(.+)$/);
      if (mm) { mediaType = mm[1]; data = mm[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    if (imageBlocks.length) imageBlocks[imageBlocks.length - 1].cache_control = { type: 'ephemeral' };
    const enumList = isMissing ? PROBE_MISSING_VERDICT_ENUM : PROBE_VERDICT_ENUM;
    const prompt = isMissing
      ? `An assessment of this salvage vehicle claims: the ${partName} is ${claimWording}. Examine the photographs. State plainly whether the ${partName} is present and intact in its mounting, or whether it is absent / its mounting area is destroyed by the impact.
Return a raw JSON object only, no other text:
{ "verdict": "absent" | "area-destroyed" | "present-and-intact" | "minor-cosmetic-only" | "cannot-determine", "note": "<one sentence>" }`
      : `An assessment of this salvage vehicle claims: the ${partName} is ${claimWording}. Examine the photographs. State exactly what damage is identifiable on the ${partName} and where, or state plainly that no damage can be identified on it.
Return a raw JSON object only, no other text:
{ "verdict": "no-damage-visible" | "minor-cosmetic" | "consistent-with-claim" | "cannot-determine", "note": "<one sentence>" }`;
    const { res, exhausted } = await with529Retry('attribution-probe', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 256,
        system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return null; }
    if (!res?.ok) { console.warn('[ATTRIB PROBE] API error:', res?.status); return null; }
    const apiData = await res.json();
    console.log('[TOKEN LOG] attribution-probe Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| CacheWrite:', apiData.usage?.cache_creation_input_tokens ?? 0, '| CacheRead:', apiData.usage?.cache_read_input_tokens ?? 0, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
    if (apiData.stop_reason === 'max_tokens') { console.warn('[ATTRIB PROBE] max_tokens — truncated; infra-failure (keep)'); return null; }
    if (apiData.stop_reason === 'refusal')   { console.warn('[ATTRIB PROBE] refusal — content policy; infra-failure (keep)'); return null; }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.warn('[ATTRIB PROBE] no JSON object in response; infra-failure (keep)'); return null; }
    const parsed = JSON.parse(m[0]);
    const verdict = enumList.includes(parsed.verdict) ? parsed.verdict : 'cannot-determine';
    return { verdict, note: typeof parsed.note === 'string' ? parsed.note : '' };
  } catch (err) {
    console.warn('[ATTRIB PROBE] error:', err.message);
    return null;   // parse/other throw = infra-failure (keep)
  }
}

// Paired-flank panels: exactly TWO physical instances (left + right) on every car.
// Option G (cross-view correspondence pass) runs ONLY on these eight panels.
// WHEEL/TYRE (four instances each) are explicitly excluded — their four-corner problem
// is a separate fix to be built after G proves out on doors.
const PAIRED_FLANK_PANELS = new Set([
  PANEL.FRONT_DOOR, PANEL.REAR_DOOR, PANEL.FRONT_WING, PANEL.REAR_QUARTER,
  PANEL.SILL, PANEL.SIDE_SKIRT, PANEL.DOOR_MIRROR, PANEL.SIDE_GLASS,
]);

// Silence-as-clean (Defect-2 / option C) — DELIBERATELY scoped to REAR_PANEL only.
// A view that imaged a co-visible rear neighbour but emitted NO line for the target panel
// counts as an implicit-clean vote (the panel was in frame; the model looked and didn't flag
// it). This inverts the single-view-genuine→cost protection, so it is restricted to panels
// where (a) co-visibility with the neighbours below is geometrically reliable and (b) the
// false-positive mode (seam/shadow/bumper-snag) is the known failure. REAR_PANEL qualifies;
// BOOT_LID and REAR_GLASS do NOT (single-angle boot dents / glass cracks are real). The set
// contains only non-flank panels by construction, so flank panels keep their G-pass logic.
const SILENCE_AS_CLEAN_PANELS = new Set([PANEL.REAR_PANEL]);
// Explicit co-visible neighbours — a view that observed any of these had the rear panel
// (between/around them) in frame. Tighter than z:rear, which also tags REAR_QUARTER corner shots.
const PANEL_REAR_NEIGHBOURS  = new Set([PANEL.REAR_BUMPER, PANEL.REAR_LAMP, PANEL.BOOT_LID]);

// Hidden / exposed-only front-internal cost parts that get a STRAIGHT corroboration floor
// (require ≥2 damaged views to cost). This is the ORIGINAL viewsThatSaw mechanism — sound here
// because these parts are emitted in MULTIPLE views (so ≥2 views saw it but <2 confirmed damage
// = uncorroborated). It is NOT silence-as-clean (no neighbour anchor) — REAR_PANEL's mechanism
// above is separate and untouched. SLAM_PANEL only here; RADIATOR_PACK floors POST-amalgamate
// (its escape-hatch proxy isn't available during amalgamate — see the RADIATOR_PACK rule).
const HIDDEN_CORROBORATION_PANELS = new Set([PANEL.SLAM_PANEL]);

// Option G — cross-view panel-correspondence pass.
// Per-view already got the iv verdicts right; G's ONLY job is correspondence: are the
// iv:true views and the iv:false views looking at the SAME physical instance, or
// DIFFERENT physical instances? Fires only when at least one paired-flank panel has
// BOTH damaged (iv:true) and clean (iv:false) votes — otherwise it is a no-op.
// Returns Map<panelId, { instance_groups, uncertain_view_pairs, confidence, floored }>.
// floored=true → panel stays on the pooled/floor path (the safe default).
async function runCorrespondencePass(perViewResults, images, onExhaust) {
  // 1. Collect per-panel iv observations for paired-flank panels only
  const panelObsMap = new Map();
  for (const { costedParts, idx } of perViewResults) {
    for (const cp of costedParts) {
      if (!PAIRED_FLANK_PANELS.has(cp.panelId)) continue;
      if (!panelObsMap.has(cp.panelId)) panelObsMap.set(cp.panelId, { damaged: [], clean: [] });
      const obs = panelObsMap.get(cp.panelId);
      if (cp.independentlyVisible === true)  obs.damaged.push(idx);
      if (cp.independentlyVisible === false) obs.clean.push(idx);
    }
  }
  // Only fire for panels that have BOTH damaged and clean views (the disagree condition)
  const mixedPanels = [...panelObsMap.entries()]
    .filter(([, obs]) => obs.damaged.length > 0 && obs.clean.length > 0);
  if (mixedPanels.length === 0) {
    console.log('[CORR] no mixed-vote flank panels — correspondence pass skipped');
    return new Map();
  }
  const floorAll = () => new Map(
    mixedPanels.map(([pid]) => [pid, { instance_groups: [], uncertain_view_pairs: [], floored: true }])
  );
  // 2. Build observation lines: view idx → panelId → iv verdict
  const obsLines = [];
  for (const [panelId, obs] of mixedPanels) {
    for (const idx of obs.damaged) obsLines.push(`view ${idx} → ${panelId} → iv:true`);
    for (const idx of obs.clean)   obsLines.push(`view ${idx} → ${panelId} → iv:false`);
  }
  // 3. Build image blocks — full-size, no resize (Opus path; same as lamp-detect)
  const corrImageBlocks = images.slice(0, 35).map(img => {
    let mediaType = 'image/jpeg';
    let data = img;
    const m = img.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { mediaType = m[1]; data = m[2]; }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
  // Shared-image cache breakpoint. These 3 reads (correspondence, aperture, sill-rocker)
  // send the IDENTICAL 35-image payload AND the identical system string, so a cache_control
  // on the last image block makes the [system + 35 images] prefix reusable across them.
  // correspondence fires first → cache WRITE (1.25×); aperture/sill-rocker fire later within
  // the 5-min window → cache READ ($0.50/M vs fresh $5/M). Read-specific prompt text sits
  // AFTER this block, uncached (negligible). Only pays off because ≥2 reads reuse the prefix.
  if (corrImageBlocks.length) corrImageBlocks[corrImageBlocks.length - 1].cache_control = { type: 'ephemeral' };
  // 4. Build question — NO side naming anywhere
  const corrN = corrImageBlocks.length;
  const corrQuestion = `These are ${corrN} photos of one vehicle, numbered view 0 through view ${corrN - 1} in the order they appear in this message.

Per-view analysis flagged these observations:
${obsLines.join('\n')}

Each of the panels above exists as a LEFT and a RIGHT physical instance — one each side of the car (two front doors, two rear doors, two sills, etc.). Looking at the images: for each panel, how many PHYSICALLY DISTINCT damaged instances are there?

For each distinct damaged instance, list the view indices showing it. Group views showing the SAME physical instance together. Do NOT name sides — group only by same-vs-different physical instance. If you cannot tell whether two views show the same or different instances, say so for that pair — it will be treated as unresolved and floored (the safe default).

Respond with ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{
  "panels": [
    {
      "panelId": "<PANEL_ID from the observations above>",
      "distinct_damaged_instances": <number>,
      "instance_groups": [[<view indices for instance 1>], [<view indices for instance 2 if present>]],
      "uncertain_view_pairs": [[<a>, <b>]],
      "confidence": "low" | "med" | "high"
    }
  ]
}`;
  // 5. Opus 4.8 call — same pattern as lamp-detect / dash-read
  const { res: corrRes, exhausted: corrExhausted } = await with529Retry('correspondence', () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELS.assessPrimary,
      max_tokens: 1024,
      system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
      messages: [{ role: 'user', content: [...corrImageBlocks, { type: 'text', text: corrQuestion }] }],
    }),
  }));
  if (corrExhausted) { onExhaust?.(); return floorAll(); }
  if (!corrRes?.ok)  { console.warn('[CORR] API error:', corrRes?.status, '— flooring all flank panels'); return floorAll(); }
  const corrApiData = await corrRes.json();
  console.log('[TOKEN LOG] correspondence Input:', corrApiData.usage?.input_tokens, '| Output:', corrApiData.usage?.output_tokens, '| Stop:', corrApiData.stop_reason, '| Model:', corrApiData.model || 'unknown');
  if (corrApiData.stop_reason === 'max_tokens') { console.warn('[CORR] max_tokens — flooring all flank panels');  return floorAll(); }
  if (corrApiData.stop_reason === 'refusal')   { console.warn('[CORR] refusal — flooring all flank panels');      return floorAll(); }
  // 6. Parse JSON from the text block
  const corrRawText = ((corrApiData.content || []).find(b => b.type === 'text')?.text || '').trim();
  console.log('[CORR] raw model output:', corrRawText.slice(0, 800));
  let corrParsed;
  try { const jm = corrRawText.match(/\{[\s\S]*\}/); corrParsed = jm ? JSON.parse(jm[0]) : null; } catch { corrParsed = null; }
  if (!corrParsed?.panels || !Array.isArray(corrParsed.panels)) {
    console.error('[CORR] parse failure — flooring all flank panels');
    return floorAll();
  }
  // 7. Build and return result map
  const corrResult = new Map();
  for (const entry of corrParsed.panels) {
    const { panelId, distinct_damaged_instances, instance_groups, uncertain_view_pairs, confidence } = entry;
    if (!PAIRED_FLANK_PANELS.has(panelId)) { console.warn(`[CORR] unknown panelId "${panelId}" in response — skipped`); continue; }
    if (confidence === 'low') {
      console.log(`[CORR] ${panelId} confidence=low → floored`);
      corrResult.set(panelId, { instance_groups: [], uncertain_view_pairs: [], floored: true });
      continue;
    }
    corrResult.set(panelId, {
      instance_groups:      Array.isArray(instance_groups)      ? instance_groups      : [],
      uncertain_view_pairs: Array.isArray(uncertain_view_pairs) ? uncertain_view_pairs : [],
      confidence:           confidence ?? 'low',
      floored:              false,
    });
    console.log(`[CORR] ${panelId} instances=${distinct_damaged_instances ?? '?'} confidence=${confidence} uncertain=${uncertain_view_pairs?.length ?? 0}`);
  }
  // Any mixed panel absent from model response → floor it
  for (const [panelId] of mixedPanels) {
    if (!corrResult.has(panelId)) {
      console.warn(`[CORR] ${panelId} absent from model response — floored`);
      corrResult.set(panelId, { instance_groups: [], uncertain_view_pairs: [], floored: true });
    }
  }
  return corrResult;
}

// Sill rocker-discrimination read. Fires only when SILL is in the costed set.
// Per-view votes SILL iv:true on struck-side views where a torn door bottom meets
// sill height — correct perception, wrong attribution. This asks the question the
// per-view pass never asks: is the rocker structure ITSELF deformed?
// Returns { rocker_independently_deformed: bool, confidence: 'low'|'med'|'high' }
// or null on any failure (caller treats null as uncertain → floor to inspection flag).
async function runSillRockerRead(images, onExhaust) {
  try {
    const imageBlocks = images.slice(0, 35).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    // Shared-image cache breakpoint — same 35-image payload + same system as correspondence;
    // this read fires after correspondence's cache write → cache READ ($0.50/M vs fresh $5/M).
    if (imageBlocks.length) imageBlocks[imageBlocks.length - 1].cache_control = { type: 'ephemeral' };
    const question = `These photos show one vehicle with damage along one flank. Look ONLY at the SILL / ROCKER PANEL — the structural member along the bottom of the body between the front and rear wheels, BELOW the doors.

Is the rocker panel's OWN structure deformed — crushed, buckled, dented, or its lower body line displaced — INDEPENDENT of the door skins above it? If the only damage near sill height is the bottom edge of DOOR damage (a tear or crease reaching down to sill height), that is DOOR damage — answer false. Answer true ONLY if the rocker's own structure is visibly deformed separate from the doors.

Respond with ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{ "rocker_independently_deformed": true | false, "confidence": "low" | "med" | "high" }`;
    const { res, exhausted } = await with529Retry('sill-rocker', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 256,
        system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: question }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return null; }
    if (!res?.ok) { console.warn('[SILL ROCKER] API error:', res?.status); return null; }
    const data = await res.json();
    console.log('[TOKEN LOG] sill-rocker Input:', data.usage?.input_tokens, '| Output:', data.usage?.output_tokens, '| Stop:', data.stop_reason, '| Model:', data.model || 'unknown');
    if (data.stop_reason === 'max_tokens') { console.warn('[SILL ROCKER] max_tokens — returning null'); return null; }
    const raw = ((data.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[SILL ROCKER] no JSON in response:', raw.slice(0, 200)); return null; }
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[SILL ROCKER] error:', err.message);
    return null;
  }
}

// Bonnet skin-vs-displaced discrimination read. Fires only when the BONNET is disagree-floored.
// Per-view DISAGREES on a displaced-but-intact bonnet: some views read the proud edge / open
// shut-line gap as damage (iv:true), others as intact (iv:false). This asks the question per-view
// never resolves — is the hood SKIN'S OWN metal deformed, or is the bonnet merely displaced?
// Returns { skin_damaged: bool, confidence: 'low'|'med'|'high' } or null on any failure
// (caller treats null as uncertain → leave the floor untouched; never clears on a guess).
async function runBonnetSkinRead(images, onExhaust) {
  try {
    const imageBlocks = images.slice(0, 35).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    // Shared-image cache breakpoint — same 35-image payload + same system as correspondence/sill.
    if (imageBlocks.length) imageBlocks[imageBlocks.length - 1].cache_control = { type: 'ephemeral' };
    const question = `These photos show one salvage vehicle. Look ONLY at the BONNET (hood) — the horizontal metal skin panel between the two front wings, forward of the windscreen.

Distinguish two DIFFERENT things:
- SKIN DAMAGE: the bonnet's OWN metal is creased, dented, buckled, folded, or punctured. This is genuine damage to the hood panel and needs the panel repaired or replaced.
- DISPLACEMENT: the bonnet sits proud, is unlatched or misaligned, or its shut-line gap to the wings/scuttle is open — but the skin itself is straight and intact. This is a refit/alignment consequence of structural or latch-area impact BEHIND the bonnet, not damage to the panel.

Answer skin_damaged:true ONLY when the hood skin's OWN metal is visibly deformed. A bonnet that is only displaced / proud / misaligned with an intact skin is skin_damaged:false. Do NOT infer skin damage from a disturbed shut line, a proud or lifted edge, or from damage on the adjacent wings, slam panel, or front structure. If you genuinely cannot tell, use low confidence.

Respond with ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{ "skin_damaged": true | false, "confidence": "low" | "med" | "high" }`;
    const { res, exhausted } = await with529Retry('bonnet-skin', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 256,
        system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: question }] }],
      }),
    }));
    if (exhausted) { onExhaust?.(); return null; }
    if (!res?.ok) { console.warn('[BONNET_READ] API error:', res?.status); return null; }
    const data = await res.json();
    console.log('[TOKEN LOG] bonnet-skin Input:', data.usage?.input_tokens, '| Output:', data.usage?.output_tokens, '| Stop:', data.stop_reason, '| Model:', data.model || 'unknown');
    if (data.stop_reason === 'max_tokens') { console.warn('[BONNET_READ] max_tokens — returning null'); return null; }
    const raw = ((data.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[BONNET_READ] no JSON in response:', raw.slice(0, 200)); return null; }
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[BONNET_READ] error:', err.message);
    return null;
  }
}

const AMALG_REASON_DISAGREE    = 'per-view disagreement — seen as undamaged in at least one photo and damaged in another; condition could not be resolved across views; request on the WhatsApp inspection before bidding';
const AMALG_REASON_NOT_VISIBLE = 'not visible in any photo — no view showed this part clearly enough to confirm condition; request on the WhatsApp inspection before bidding';
// Aperture-confusion rewording: fired post-assembly when a DISAGREE floor sits behind a
// confirmed displaced bumper. States only the situation and uncertainty — no damage verb,
// no damage claim, no "inspect in person" (buyers have no Copart access).
const AMALG_REASON_APERTURE_REAR  = 'Rear bumper displaced on this corner; the quarter panel behind it cannot be reliably assessed from the listing photos.';
const AMALG_REASON_APERTURE_WING  = 'Front bumper displaced on this corner; the wing behind it cannot be reliably assessed from the listing photos.';
const AMALG_REASON_APERTURE_LAMP  = 'Front bumper displaced on this corner; the headlamp mounting area cannot be reliably assessed from the listing photos.';
const AMALG_REASON_FLAG_CLASS     = 'structural or inspection-class component — flagged for inspection, not included in the repair cost; assess on the WhatsApp inspection before bidding';
const AMALG_REASON_COSMETIC       = 'light cosmetic damage — refinish or trim-grade; not included in the repair cost; confirm extent on the WhatsApp inspection';
const AMALG_REASON_UNCORROBORATED = 'single-view damage — only one photo flagged this panel; the other photos that show this area did not flag it, so the damage is not corroborated; not included in the repair cost; confirm on the WhatsApp inspection before bidding';
// Ruling 2 (batch 81): a SINGLE unsupported MINOR view. Weaker evidence than a disagree — one weak
// signal, below the 2-vote cosmetic threshold — so the wording says so and is honest about the split.
// Surfaced, never priced (the buyer prices it via the batch-82 add-line). Distinct from the disagree,
// cosmetic and uncorroborated reasons so the buyer can tell how strong the signal is.
const AMALG_REASON_SINGLE_MINOR = 'one photo suggested light damage here; the other views of this area did not — a single weak signal, not confirmed and not dismissed; carries no cost. If it matters to you, confirm on the WhatsApp inspection and add your own figure.';
const AMALG_REASON_RAD_UNCORROBORATED = 'single-view damage on a part only visible when the front is open; no second view confirmed it and no central front-structure damage corroborates it; not included in the repair cost; confirm on the WhatsApp inspection before bidding';
// Byte-for-byte copy of the gate's inline RQ rider (parts.mjs :282) — appended to
// BUMPER_OFF_SEAM_REASON for rear-quarter so the no-model-row push matches the gate's
// with-model-row flag reason exactly. Leading space is intentional (concatenation join).
const BUMPER_OFF_RQ_RIDER = ' Inner structural integrity not visible from exterior shots — confirm on the WhatsApp inspection before bidding.';

// EV-integrity Step 2 — EV_BATTERY_PRESENCE flag reasons (BEV lots only; flag-only).
// Governing principle: never assert absence. The ONLY positive inference is presence-from-
// running; the negative direction is always cannot-confirm → inspect, never "likely stripped".
const EV_BATTERY_REASON_RUNS        = "Runs and drives — strong indication the HV battery is present and live (an EV can't move under its own power without it); confirm by diagnostic on inspection.";
const EV_BATTERY_REASON_UNCONFIRMED = 'EV traction battery presence not confirmable remotely — verify the pack is fitted and reports voltage before bidding; a removed or damaged HV battery is the largest single value risk on a salvage EV.';

// EV-integrity Step 5 — cooling/HV governing verdict wording (BEV lots only). Single owner of the
// three-tier verdict strings. Tier 1 fires ONLY on ≥2-view SEVERE corroboration of EV_BATTERY_ZONE
// (positive photographic evidence — never inferred from not-running/dash/absence; Step 2 caveat).
const EV_VERDICT_TIER1_REDFLAG = 'HIGH-VOLTAGE BATTERY PACK — VISIBLE SEVERE DAMAGE: two or more photos show severe damage to the underfloor HV battery pack. On a battery-electric vehicle the traction pack alone normally exceeds any viable repair budget — this is typically cost-prohibitive to repair. Treat as parts/scrap value unless an EV specialist confirms the pack is serviceable.';
const EV_VERDICT_TIER1_FLAG = 'HV battery pack shows severe visible damage across multiple photos — pack replacement is normally cost-prohibitive; confirm serviceability with an EV specialist before bidding.';
const EV_VERDICT_MARGIN_CAVEAT = 'Note — the repair total above excludes the high-voltage battery pack, which shows visible severe damage. If the pack needs replacement the true repair cost normally exceeds any viable margin; treat the figures above as best-case, pack-serviceable-only.';
const EV_VERDICT_TIER2_HARD = 'High-voltage battery and EV-system integrity could not be confirmed and there is adverse evidence on this lot (dash warning, unconfirmed cooling circuit, or possible pack-area damage). An EV specialist diagnostic of the HV pack and cooling system is the deciding item before bidding — a damaged or isolated HV pack is the largest single value risk on a salvage EV.';
const EV_VERDICT_TIER2_SOFT = 'High-voltage battery and EV cooling integrity cannot be confirmed from the listing photos. An EV specialist diagnostic is the deciding item before bidding — a removed, damaged, or isolated HV pack is the largest single value risk on a salvage EV. Do not assume the pack is sound because the body is intact (a crash trips the HV isolator; present-but-isolated looks identical to missing).';
const EV_VERDICT_TIER3_NOTE = 'Runs and drives, clean instrument cluster, no adverse cooling or HV evidence — a strong indication the HV battery and EV systems are live and intact. Confirm with an EV diagnostic on inspection.';

// A3 SEVERE-DISCIPLINE clause, factored out ONLY so the replay harness can A/B it (Cowork §11).
// PROD-INERT: REPLAY_A3_OFF is never set in production, so this is the full clause (including its
// trailing blank line) and PER_VIEW_PROMPT below interpolates to a string byte-identical to before.
// When the harness sets REPLAY_A3_OFF=true it becomes '' (clause removed) — dev tooling only.
const A3_SEVERE_DISCIPLINE = process.env.REPLAY_A3_OFF === 'true' ? '' : `SEVERE DISCIPLINE (ALL panels — A3, Vincent 5 Aug): grade SEVERE only when the photo POSITIVELY shows
through-metal damage — a torn, split, cracked, crushed or folded panel, a broken or displaced body
line, or structural deformation. The EXTENT of a scuffed AREA does not make it SEVERE: a surface scuff,
scratch, graze, paint transfer, or light dent on a panel whose body line and metal are otherwise intact
is MINOR (refinish/repair), however large the marked area. When you cannot tell a surface scuff from
genuine deformation on a panel shown square-on, grade MODERATE — never default up to SEVERE. Do NOT
escalate to SEVERE on the basis of dirt, road film, abrasion, or paint transfer without visible metal
deformation. (This applies to every panel; the lower-flank grounding below is the stricter iv:false rule
for SILL/SIDE_SKIRT specifically.)

`;

export const PER_VIEW_PROMPT = `You are assessing damage on a salvage vehicle from a SINGLE photograph. This is one view of several; other views are assessed separately. Assess ONLY what THIS photograph shows. Do not infer, assume, or carry over anything from any other view — you have not seen them.

For each damage-relevant part you can assess in this photo, output one line in this exact format and nothing else:

PART: <PANEL_ID> | iv:<true|false|na|missing> | sev:<SEVERE|MODERATE|MINOR|-> | z:<front|rear|flank-damaged-side|roof|underside|interior>

<PANEL_ID> must be one identifier from the closed vocabulary below, written exactly as shown (SCREAMING_SNAKE_CASE). If a part you observe does not fit any identifier, use OTHER.

CLOSED PANEL VOCABULARY:

COST panels — carry a repair price when damaged:
  FRONT_BUMPER      front bumper / bumper cover / front fascia
  GRILLE            front grille / grille insert
  BONNET            bonnet / hood
  SLAM_PANEL        slam panel / rad support / front upper tie bar
  FRONT_WING        front wing / front fender
  HEADLAMP          front or rear headlamp / headlight (any position — do not invent FRONT_HEADLAMP)
  FOG_LAMP          front or rear fog lamp / driving lamp
  RADIATOR_PACK     radiator / condenser / cooling pack (costed as a unit on frontal hits)
  FRONT_DOOR        front door / front door shell
  REAR_DOOR         rear door / rear door shell (car rear door only — NOT a van sliding door; use SLIDING_DOOR_SOLID or SLIDING_DOOR_GLAZED for sliding doors)
  SILL              structural sill / rocker panel (structural, not trim)
  SIDE_SKIRT        side skirt / rocker trim / side trim strip (trim only, not structural)
  DOOR_MIRROR       door mirror / wing mirror / side mirror
  SIDE_GLASS        side glass / door glass (any door window — glass pane struck in isolation; if the whole sliding door skin is struck use SLIDING_DOOR_GLAZED instead)
  REAR_BUMPER       rear bumper / rear bumper cover / rear fascia
  REAR_QUARTER      rear quarter panel / rear quarter / rear haunch (do not invent FRONT_QUARTER)
  WHEEL_ARCH_MOULDING  wheel arch moulding / wheel arch trim / arch moulding / arch trim / arch surround (the plastic trim strip around a wheel arch — NOT the metal quarter/wing panel behind it)
  REAR_LAMP         tail lamp / tail light / rear lamp cluster
  BOOT_LID          boot lid / trunk lid / hatchback rear door (car only — for van rear closures use BARN_DOOR_L/R or TAILGATE_GLAZED; do not route van barn doors or van tailgates here)
  REAR_PANEL        rear closing panel between the rear lamps (not the same as REAR_BUMPER)
  WINDSCREEN        windscreen / front windshield
  REAR_GLASS        rear glass / rear windscreen / rear screen
  ROOF              roof panel / roof skin
  WHEEL             alloy or steel wheel — any corner; do not add a position qualifier
  TYRE              tyre / tire — any corner; do not add a position qualifier

Van/passenger body panels:
  SLIDING_DOOR_SOLID   panel van solid sliding side door / plain metal sliding door — whole door skin struck (track and runner folded in); do not use for glazed passenger-van doors
  SLIDING_DOOR_GLAZED  passenger van glazed sliding door / glazed side door with glass panel — whole door struck including glass; if only the glass pane is broken use SIDE_GLASS instead
  BARN_DOOR_L          left rear barn door (van / minibus) — split rear closure, left leaf
  BARN_DOOR_R          right rear barn door (van / minibus) — split rear closure, right leaf
  LOAD_BULKHEAD        load bulkhead / cab divider / partition panel behind cab seats
  CREW_WINDOW          crew van glazed body-side window / second-row side window bonded into body (not a door glass — use SIDE_GLASS for door glass)
  BODY_SIDE_GLAZING    people-carrier or minibus bonded body-side glazing / fixed passenger window (not a door)
  TAILGATE_GLAZED      van single top-hinged glazed tailgate / single-piece rear door with glass (not barn doors; not BOOT_LID)

Pickup-only panels:
  BED_SIDE_L       pickup load-bed left side panel / left bed wall
  BED_SIDE_R       pickup load-bed right side panel / right bed wall
  BED_FLOOR        pickup load-bed floor / bed deck
  DROP_TAILGATE    pickup drop tailgate / pickup rear bed closure (distinct from van barn door or car hatchback tailgate)
  CAB_REAR_PANEL   pickup cab rear wall / back wall of the cab (body-on-frame rear cab panel)
  CAB_REAR_GLASS   pickup double-cab rear cab window / rear cab glass behind the seats (bonded fixed glazing; NOT a door glass — use SIDE_GLASS for door glass; NOT the cab rear metal wall — use CAB_REAR_PANEL for that; NOT the load-bed)

STRUCTURAL FLAG — never costed; always flagged for inspection:
  FRONT_STRUCTURE   chassis leg / inner wing / subframe / front upper structure / engine bay metal
  REAR_STRUCTURE    rear chassis leg / boot floor structure / rear longitudinal
  SIDE_STRUCTURE    A-pillar / B-pillar / C-pillar / inner sill reinforcement

VISIBLE FLAG — geometric evidence only:
  DISPLACED_WHEEL   wheel visibly out of position (wrong angle or pushed out of arch)
  AIRBAG            deployed airbag / SRS restraint visibly deployed in the cabin (deflated or hanging bag at the steering wheel, dashboard, roof rail / A-pillar, or seat; burst SRS module cover) — DEPLOYED bag only, NOT an intact airbag or a dash warning light. Genuine non-airbag interior damage still uses OTHER.

PRESENCE CHECK:
  SPARE_WHEEL       spare wheel / spare tyre (visible in boot)
  PARCEL_SHELF      parcel shelf / rear load cover

ESCAPE:
  OTHER             any damage-relevant part not listed above

EV-CONDITIONAL — use only on electric or plug-in hybrid vehicles:
  EV_BATTERY_ZONE      underfloor battery zone / battery pack area
  EV_BATTERY_PRESENCE  high-voltage battery visible / battery tray

The iv value has FOUR meanings. Read carefully:

- iv:true    — visible in this photo AND damaged.
- iv:false   — visible in this photo AND undamaged. You can see it clearly and it is fine.
- iv:na      — you CANNOT resolve this part: out of frame, occluded, too distant, too oblique,
               in shadow, or otherwise not clearly shown. When in doubt, use iv:na.
- iv:missing — the part is ABSENT: torn away, not present where it should be, or the mounting
               point is exposed with nothing attached. HIGH BAR — use ONLY when certain the part
               is gone, not merely damaged-but-present. A crumpled bumper still in place is iv:true.
               A bumper completely torn off leaving bare bodywork is iv:missing. "I don't see it
               in this shot" is iv:na, not iv:missing.

severity (on iv:true only; use - on false/na/missing):
  SEVERE   = destroyed / replace-grade — torn, shredded, crushed, structural deformation
  MODERATE = clear impact damage, repair-grade
  MINOR    = cosmetic — scuff / scratch / light dent, refinish only

${A3_SEVERE_DISCIPLINE}--- LOWER-FLANK GROUNDING (SILL, SIDE_SKIRT, and the lower extent of the doors) ---
Lower rocker, sill and side-skirt panels routinely carry PRE-EXISTING kerb-rash, road film, dirt, stone-chips, light surface scuffs and shadow that are NOT fresh collision damage. Do NOT grade or cost these as damage. For SILL or SIDE_SKIRT to be iv:true, the photo must show actual DEFORMATION or IMPACT — a crease, dent, crack, gouge, or displacement consistent with the collision event. Surface scuff, scratch, dirt, road film, shadow, or kerb/abrasion rash ALONE on these lower-flank panels is iv:false (seen and undamaged) — it is NOT MINOR and NOT MODERATE. If the lower-flank condition is ambiguous between surface contamination / pre-existing kerb-rash and genuine light impact, use iv:na — do NOT default to grading it damaged. Apply the same judgement an assessor reaches in prose: scuffing that reads as pre-existing kerb/abrasion rather than fresh impact is not a costed panel. This rule is scoped to the lower-flank panels named here; it does NOT change how scuffs are graded on any other panel.
--- END LOWER-FLANK GROUNDING ---

--- BONNET: WING-EDGE & DISPLACEMENT ---
BONNET is the horizontal hood skin between the wings. Damage on the vertical fender, at or above the front wheel arch, or at the front corner where the wing meets the headlamp, is FRONT_WING — NOT BONNET. A wing or front-corner impact visible near the bonnet edge is FRONT_WING — do not file it under BONNET because it is near the bonnet.
Grade BONNET iv:true ONLY if the horizontal hood SKIN itself is creased, dented, or buckled in THIS photo. A bonnet that is unlatched, sitting proud, misaligned, or showing a disturbed shut-line gap — but whose skin is intact — is DISPLACED, not damaged: an alignment consequence of structural/latch-area impact behind it. Grade it iv:false (the refit resolves with the structural repair, not a panel replacement). Do not grade a displaced-but-intact bonnet as a damaged panel.
--- END BONNET: WING-EDGE & DISPLACEMENT ---

The distinction between iv:false and iv:na is critical. iv:false is a positive statement you have seen the part and it is undamaged. iv:na means you could not assess it. Never use iv:false for a part you cannot clearly see — that case is always iv:na.

--- RESOLVABILITY THRESHOLD (tunable — this clause only) ---
Only return iv:true or iv:false for a part fully and clearly in frame, shown square-on enough to judge its condition with confidence. A part partially shown, sharply angled, partly hidden, or otherwise not fully and clearly presented is iv:na. Set the bar HIGH: if not confident you see the whole part well enough to judge it, return iv:na.
--- END RESOLVABILITY THRESHOLD ---

Report exterior body panels even when undamaged (iv:false) — a clean view resolves a damaged report of the same panel from another view. Do not omit a clean exterior panel just because nothing in the photo is damaged.

Do NOT report (unless visibly damaged):
- Interior components: buttons, switches, seat belt buckles, steering wheel trim, carpet, floor mats, gear lever, door cards
- Under-bonnet ancillaries: fluid reservoirs, hoses, cables, filter housings, air intake
- Antenna, number plates, badges, wiper blades, fuel cap

In addition to PART: lines, emit exactly one HV: line per photo:

HV: <visible|absent|na>
  visible : an EV/HV high-voltage warning label (orange triangle, lightning bolt, or "HIGH VOLTAGE" text) is clearly legible in this view.
  absent  : this view clearly shows surfaces where such a label would appear if present and there is none. HIGH BAR — only when the label-bearing surface is fully visible and unobscured; any doubt → na.
  na      : cannot determine from this view (the common case).

Do NOT write any prose, summary, cost, or commentary. Return ONLY PART: lines and the one HV: line.
Do NOT use the words "offside", "nearside", "left", or "right" anywhere — WHEEL and TYRE are position-blind by design; for paired parts (headlamps, door mirrors) report once with the PANEL_ID and no position qualifier.
If no damage-relevant parts are visible in this photo, still emit the HV: line — the sticker observation is independent of panel damage.`;



async function runPerViewAssess(image, idx, onExhaust) {
  try {
    let mediaType = 'image/jpeg';
    let data = image;
    const m = image.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { mediaType = m[1]; data = m[2]; }
    const { res, exhausted } = await with529Retry(`per-view-${idx}`, () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 2048,
        system: [{ type: 'text', text: PER_VIEW_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        ]}],
      }),
    }));
    if (exhausted) { onExhaust?.(); return { costedParts: [], idx, hvLabelSeen: false }; }
    if (!res?.ok) { console.warn(`[PER-VIEW][${idx}] API error ${res?.status}`); return { costedParts: [], idx, hvLabelSeen: false }; }
    const apiData = await res.json();
    const _u = apiData.usage || {};
    console.log(`[TOKEN LOG][PER-VIEW][${idx}] Input:${_u.input_tokens} Output:${_u.output_tokens} CacheWrite:${_u.cache_creation_input_tokens ?? 0} CacheRead:${_u.cache_read_input_tokens ?? 0} Stop:${apiData.stop_reason}`);
    if (apiData.stop_reason === 'max_tokens') { console.warn(`[PER-VIEW][${idx}] max_tokens — truncated; treating as empty`); return { costedParts: [], idx, hvLabelSeen: false }; }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const { costedParts } = parsePartVerdicts(raw);
    const hvLabelSeen = parseHvLines(raw);
    if (hvLabelSeen) console.log(`[PER-VIEW][${idx}] HV: visible`);
    // Validate each emitted string against the closed PANEL vocabulary.
    // Unknown strings (including the legacy 'none' sentinel) are routed to OTHER and logged.
    const knownIds = new Set(Object.values(PANEL));
    const enriched = costedParts
      .map(cp => {
        const rawId = cp.panelId;
        if (!rawId || rawId.toLowerCase() === 'none') return null; // legacy sentinel — discard silently
        if (knownIds.has(rawId)) {
          return { ...cp, panelId: rawId, partName: PANEL_DISPLAY[rawId] };
        }
        console.warn(`[PER-VIEW][${idx}] unknown panel ID "${rawId}" — routed to OTHER`);
        return { ...cp, panelId: PANEL.OTHER, partName: PANEL_DISPLAY[PANEL.OTHER] };
      })
      .filter(Boolean);
    enriched.forEach(cp => {
      const ivLabel = cp.independentlyVisible === true ? 'true' : cp.independentlyVisible === false ? 'false' : cp.independentlyVisible === 'missing' ? 'missing' : 'na';
      console.log(`[PER-VIEW][${idx}] panel=${cp.panelId} iv=${ivLabel} zone=${cp.zone}`);
    });
    if (enriched.length === 0) console.log(`[PER-VIEW][${idx}] 0 valid enum IDs from this view — no records contributed`);
    return { costedParts: enriched, idx, hvLabelSeen };
  } catch (err) {
    console.warn(`[PER-VIEW][${idx}] error:`, err.message);
    return { costedParts: [], idx, hvLabelSeen: false };
  }
}

function groupByPanelId(allPerViewResults) {
  const map = new Map(); // panelId → verdict-line strings[]
  for (const { costedParts, idx } of allPerViewResults) {
    for (const cp of costedParts) {
      if (!cp.panelId || !PANEL_DISPLAY[cp.panelId]) {
        console.warn(`[GROUPBY] view ${idx} — invalid panelId "${cp.panelId}" — skipped`);
        continue;
      }
      const ivStr  = cp.independentlyVisible === true ? 'true' : cp.independentlyVisible === false ? 'false' : cp.independentlyVisible === 'missing' ? 'missing' : 'na';
      const sevStr = cp.severity ?? '-';
      const line   = `[view:${idx}] PART: ${cp.panelId} | iv:${ivStr} | sev:${sevStr} | z:${cp.zone}`;
      if (!map.has(cp.panelId)) map.set(cp.panelId, []);
      map.get(cp.panelId).push(line);
    }
  }
  const groups = [...map.entries()].map(([panelId, members]) => ({ panelId, members }));
  console.log(`[GROUPBY] ${groups.length} panel group(s) from ${allPerViewResults.length} view(s)`);
  return groups;
}

// Option G — split pooled-flank groups by physical instance (Commit 2 of G build).
// Consumes the correspondenceMap from runCorrespondencePass.  For each paired-flank panel
// with a valid, actionable correspondence result, replaces the single pooled group with
// per-instance groups carrying a bare panelId + a separate _instanceKey:
//   { panelId: 'FRONT_DOOR', _instanceKey: 'FRONT_DOOR#1', members: [...] }
// amalgamate then runs its unchanged severity/disagree truth table on each instance
// independently.  ALL safety conditions are checked here — any failure keeps the panel
// on the pooled/floor path.
function splitGroupsByInstance(rawGroups, correspondenceMap) {
  if (!correspondenceMap?.size) return rawGroups;
  const result = [];
  for (const group of rawGroups) {
    const { panelId, members } = group;
    const corr = correspondenceMap.get(panelId);
    if (!corr) { result.push(group); continue; }        // non-flank panel or not in map
    // ── Safety gate 1: floored / low-confidence / uncertain pairs ─────────────────────
    if (corr.floored) {
      console.log(`[G] ${panelId} floored=true action=floor`);
      result.push(group); continue;
    }
    if (corr.confidence === 'low') {
      console.log(`[G] ${panelId} confidence=low action=floor`);
      result.push(group); continue;
    }
    if ((corr.uncertain_view_pairs?.length ?? 0) > 0) {
      console.log(`[G] ${panelId} uncertain_pairs=${corr.uncertain_view_pairs.length} action=floor`);
      result.push(group); continue;
    }
    const instanceGroups = (corr.instance_groups || []).filter(g => Array.isArray(g) && g.length > 0);
    if (instanceGroups.length === 0) {
      console.log(`[G] ${panelId} instances=0 action=floor`);
      result.push(group); continue;
    }
    // ── Build memberByView — shared by Case A (≥2 instances) and Case B (1 instance) ──
    const viewIdxOf  = m => { const r = m.match(/^\[view:(\d+)\]/); return r ? parseInt(r[1], 10) : -1; };
    const memberByView = new Map();
    for (const member of members) {
      const idx = viewIdxOf(member);
      if (idx >= 0) memberByView.set(idx, member);
    }
    if (instanceGroups.length >= 2) {
      // ── Case A: two-sided — split per instance ────────────────────────────────────────
      const splitGroups = [];
      for (let i = 0; i < instanceGroups.length; i++) {
        const instanceMembers = instanceGroups[i].map(idx => memberByView.get(idx)).filter(Boolean);
        if (instanceMembers.length === 0) continue;
        splitGroups.push({ panelId, _instanceKey: `${panelId}#${i + 1}`, members: instanceMembers });
      }
      if (splitGroups.length < 2) {
        console.log(`[G] ${panelId} split-yield=${splitGroups.length} action=floor`);
        result.push(group); continue;
      }
      // Safety gate 2: never cost a clean-majority instance
      const wouldCostCleanMajority = splitGroups.some(g => {
        const damagedVotes = g.members.filter(m => /\|\s*iv:true\s*\|/i.test(m)).length;
        const cleanVotes   = g.members.filter(m => /\|\s*iv:false\s*\|/i.test(m)).length;
        return damagedVotes > 0 && cleanVotes > damagedVotes;
      });
      if (wouldCostCleanMajority) {
        console.log(`[G] ${panelId} SAFETY_ABORT=clean-majority action=floor`);
        result.push(group); continue;
      }
      console.log(`[G] ${panelId} instances=${splitGroups.length} groups=${JSON.stringify(instanceGroups)} confidence=${corr.confidence} action=split`);
      result.push(...splitGroups);
      const assignedViews = new Set(instanceGroups.flat());
      const unassignedCount = [...memberByView.keys()].filter(idx => !assignedViews.has(idx)).length;
      if (unassignedCount > 0) console.log(`[G] ${panelId} ${unassignedCount} unassigned view(s) excluded (iv:na / not in correspondence)`);
    } else {
      // ── Case B/C: one damaged instance identified ─────────────────────────────────────
      const damagedViewSet  = new Set(instanceGroups[0]);
      const allViewIndices  = [...memberByView.keys()];
      const excludedIndices = allViewIndices.filter(idx => !damagedViewSet.has(idx));
      if (excludedIndices.length === 0) {
        // Case C: damaged instance covers all views — no opposite-side dilution to fix
        console.log(`[G] ${panelId} instances=1 no-excluded-views action=floor (damaged instance covers all views)`);
        result.push(group); continue;
      }
      // S2: never drop an iv:true view — excluding a real damage observation is incoherent
      const hasIvTrueExcluded = excludedIndices.some(idx => /\|\s*iv:true\s*\|/i.test(memberByView.get(idx) ?? ''));
      if (hasIvTrueExcluded) {
        console.log(`[G] ${panelId} SAFETY_ABORT=iv-true-in-excluded action=floor`);
        result.push(group); continue;
      }
      // S2b: the damaged instance must be all-damaged — no iv:false inside the struck bucket.
      // Symmetric with S2: S2 forbids dropping real damage; S2b forbids including a clean
      // observation in the damaged bucket. Either means the model mis-grouped; floor is safe.
      // iv:na inside the instance is acceptable — unresolvable, not contradictory.
      const hasCleanInDamagedInstance = instanceGroups[0].some(idx =>
        /\|\s*iv:false\s*\|/i.test(memberByView.get(idx) ?? ''));
      if (hasCleanInDamagedInstance) {
        console.log(`[G] ${panelId} SAFETY_ABORT=clean-vote-in-damaged-instance action=floor`);
        result.push(group); continue;
      }
      // Build damaged instance's member list
      const instanceMembers = instanceGroups[0].map(idx => memberByView.get(idx)).filter(Boolean);
      if (instanceMembers.length === 0) {
        console.log(`[G] ${panelId} SAFETY_ABORT=empty-instance action=floor`);
        result.push(group); continue;
      }
      // S1: damaged instance must be majority-damaged (backstop after S2/S2b)
      const instDamagedVotes = instanceMembers.filter(m => /\|\s*iv:true\s*\|/i.test(m)).length;
      const instCleanVotes   = instanceMembers.filter(m => /\|\s*iv:false\s*\|/i.test(m)).length;
      if (instCleanVotes >= instDamagedVotes) {
        console.log(`[G] ${panelId} SAFETY_ABORT=instance-not-majority-damaged damaged=${instDamagedVotes} clean=${instCleanVotes} action=floor`);
        result.push(group); continue;
      }
      // S2c (symmetric to S2): an EXCLUDED view that SAW this flank panel and graded it CLEAN
      // (iv:false) is a positive disagreement with a lone damaged grade. For PAIRED_FLANK_PANELS,
      // an uncorroborated single damaged instance (instDamagedVotes < 2) contradicted by ≥1 such
      // excluded clean view is floored to inspection, not cost — closes the single-view flank gap
      // (FRONT_WING/REAR_DOOR). Anchor is a POSITIVE clean observation only: iv:na (couldn't
      // resolve) does NOT count, and a view that never saw the panel is absent from excludedIndices
      // entirely — so a genuine single-angle dent (only one view had the angle) is NOT floored.
      const excludedCleanViews = excludedIndices.filter(idx =>
        /\|\s*iv:false\s*\|/i.test(memberByView.get(idx) ?? ''));
      if (PAIRED_FLANK_PANELS.has(panelId) && instDamagedVotes < 2 && excludedCleanViews.length > 0) {
        console.log(`[G] ${panelId} SAFETY_ABORT=excluded-clean-uncorroborated damaged=${instDamagedVotes} excludedCleanViews=[${excludedCleanViews.join(',')}] action=floor`);
        result.push(group); continue;
      }
      // Case B accepted: one group carrying only the damaged instance's views
      console.log(`[G] ${panelId} instances=1 excluded=${excludedIndices.length} damaged=${instDamagedVotes} clean=${instCleanVotes} confidence=${corr.confidence} action=split`);
      result.push({ panelId, _instanceKey: `${panelId}#1`, members: instanceMembers, _oppRefViews: excludedCleanViews });
      excludedIndices.forEach(idx => {
        const iv = (memberByView.get(idx) ?? '').match(/\|\s*iv:(true|false|na|missing)\s*\|/i)?.[1] ?? '?';
        console.log(`[G] ${panelId} excluded view:${idx} iv:${iv} (opposite-side — not part of damaged instance)`);
      });
    }
  }
  return result;
}

const MINOR_COSMETIC_FLAG_THRESHOLD = 2; // min MINOR-only damaged votes to trigger cosmetic flag (two-vote minimum; a single unsupported MINOR clears — LP71NSU boot-lid phantom)
const SEVERE_OVERRIDE_THRESHOLD     = 2; // min SEVERE votes to fire the no-floor cost override (provisional — lone SEVERE floors to inspect; lower to 1 if real destroyed parts floor wrongly)
const STICKY_COST_THRESHOLD         = 0.70; // min damaged/resolving ratio to RESCUE a disagree-floored COST panel back to cost (post-amalgamate sticky pass; tunable — see [AMALG][STICKY])

function amalgamate(groups, viewPanelSets) {
  const costedParts  = [];
  const flaggedParts = [];
  const pvVotesMap   = {};
  let pvVotesCollision = false;
  if (!Array.isArray(groups) || groups.length === 0) return { costedParts, flaggedParts, pvVotesMap, pvVotesCollision };
  for (const group of groups) {
    const { panelId, members, _instanceKey, _oppRefViews } = group; // panelId is the enum-ID group key from groupByPanelId
    if (!Array.isArray(members) || members.length === 0) {
      console.warn(`[AMALG] ${panelId} — empty members array; skipping (invariant: groupByPanelId never produces empty groups)`);
      continue;
    }
    const partName = PANEL_DISPLAY[panelId]; // display string; the gate joins on this field
    const zone = (() => { const m = members[0]?.match(/\|\s*z:(\S+)/); return m ? m[1] : 'unknown'; })();
    if (zone === 'unknown') console.warn(`[AMALG] ${panelId} zone unknown — first member line did not contain z: field`);
    const rawClass = PANEL_BEHAVIOUR[panelId];
    const effClass = rawClass === PANEL_CLASS.EV_CONDITIONAL
      ? EV_PANEL_RESOLVED_CLASS[panelId]
      : rawClass;
    const isFlagOnly = effClass === PANEL_CLASS.STRUCTURAL_FLAG
                    || effClass === PANEL_CLASS.VISIBLE_FLAG
                    || effClass === PANEL_CLASS.PRESENCE_CHECK;
    const verdicts  = members.map(line => {
      const m = line.match(/\|\s*iv:(true|false|na|missing)\s*\|/i);
      return m ? m[1].toLowerCase() : 'na';
    });
    const missing   = verdicts.filter(v => v === 'missing').length;
    const damaged   = verdicts.filter(v => v === 'true').length;
    const clean     = verdicts.filter(v => v === 'false').length;
    const na        = verdicts.filter(v => v === 'na').length;
    const resolving = missing + damaged + clean;
    // Views that SAW this panel = present-area observations (damaged + clean + na), excl. 'missing'.
    // The corroboration-floor denominator for HIDDEN_CORROBORATION_PANELS (distinct from `damaged`).
    const viewsThatSaw = damaged + clean + na;
    // C2 targeting: view indices of every member line (the frames that imaged this panel/instance).
    // For a correspondence-split flank instance the member set IS that instance's one-sided frames,
    // so this is side-correct by construction. Ruling Q1: ALL member views (not damaged-only).
    const _probeViews = members
      .map(l => { const r = l.match(/^\[view:(\d+)\]/); return r ? parseInt(r[1], 10) : -1; })
      .filter(i => i >= 0);
    const damagedSevs = members
      .filter(l => /\|\s*iv:true\s*\|/i.test(l))
      .map(l => { const sm = l.match(/\|\s*sev:(SEVERE|MODERATE|MINOR)\s*\|/i); return sm ? sm[1].toUpperCase() : 'MODERATE'; });
    const severeVotes    = damagedSevs.filter(s => s === 'SEVERE').length;
    const severeOverride = severeVotes >= SEVERE_OVERRIDE_THRESHOLD;
    const hasModerate    = damagedSevs.some(s => s === 'MODERATE');
    const minorVotes     = damagedSevs.filter(s => s === 'MINOR').length;
    const minorOnly      = damagedSevs.length > 0 && severeVotes === 0 && !hasModerate;
    console.log(`[AMALG][SEV] ${panelId} grades=[${damagedSevs.join(',')}] severeVotes=${severeVotes} override=${severeOverride} minorOnly=${minorOnly}`);
    const _preCosted = costedParts.length;
    if (missing > 0) {
      if (isFlagOnly) {
        console.log(`[AMALG] ${panelId} missing (flag-class) → flag (not cost)`);
        flaggedParts.push({ panelId, partName, zone, weight: 'high', reason: AMALG_REASON_FLAG_CLASS });
      } else {
        // Missing dominates: absence is not adjudicable by a view that didn't notice it.
        // A clean vote cannot override a missing vote — you cannot mistake a present part
        // for absent, but you can easily fail to notice one that is gone. Missing+true also
        // costs: both agree replacement is needed.
        // _amalgMissing: forward-provisioning for buyer-facing missing-vs-damaged wording.
        console.log(`[AMALG] ${panelId} missing (${missing} missing, ${damaged} damaged, ${clean} clean) → cost (replace)`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: true, partHeight: null, _amalgMissing: true, _ledgerSeverity: 'SEVERE',
          ...(_instanceKey ? { _gOwned: true, _gSeverity: 'SEVERE' } : {}) });
      }
    } else if (resolving === 0) {
      console.log(`[AMALG] ${panelId} 0 resolving — not-visible → floor`);
      costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null });
      flaggedParts.push({ panelId, partName, zone, weight: 'medium', reason: AMALG_REASON_NOT_VISIBLE, _amalgNotVisible: true });
    } else if (severeOverride) {
      if (isFlagOnly) {
        console.log(`[AMALG] ${panelId} SEVERE damaged (flag-class) → flag (not cost)`);
        flaggedParts.push({ panelId, partName, zone, weight: 'high', reason: AMALG_REASON_FLAG_CLASS });
      } else {
        console.log(`[AMALG] ${panelId} SEVERE damaged (${damaged} damaged, ${clean} clean) → cost (SEVERE override, no floor)`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: true, partHeight: null, _severeOverride: true, _ledgerSeverity: 'SEVERE',
          ...(_instanceKey ? { _gOwned: true, _gSeverity: damagedSevs.includes('SEVERE') ? 'SEVERE' : 'MODERATE' } : {}) });
      }
    } else if (!isFlagOnly && minorOnly) {
      // Cosmetic (MINOR-only) panels: require TWO independent MINOR votes to surface a
      // buyer-facing cosmetic flag. A single unsupported MINOR vote CLEARS — same
      // _perViewClear marker a genuinely-clean panel gets, so it produces NO buyer
      // artifact at all (no flag, no cost, no note). Capture ALL minorOnly here so a
      // sub-threshold panel can never fall through to the cost/disagree branches below
      // (a bare threshold bump would re-route single-MINOR to cost/floor). LP71NSU boot-lid.
      if (minorVotes >= MINOR_COSMETIC_FLAG_THRESHOLD) {
        console.log(`[AMALG][COSMETIC] ${panelId} minorVotes=${minorVotes} → cosmetic flag`);
        flaggedParts.push({ panelId, partName, zone, weight: 'low', reason: AMALG_REASON_COSMETIC, _amalgCosmetic: true });
      } else {
        // Ruling 2 (Vincent, batch 81): a single unsupported MINOR view is a DISAGREEMENT — the engine
        // must not resolve it silently. It surfaces as a LOW-weight, NO-COST inspection flag. The 2-vote
        // cosmetic-COST threshold is unchanged; what changes is that falling below it stops meaning
        // silence. _perViewClear stays so the gate strips any model cost line (no money enters
        // parts_sum); _amalgSingleMinor marks both the entry and the flag so the §2 invariant guarantees
        // the flag reaches the buyer even if a downstream splice removes it. The buyer prices it (batch 82).
        console.log(`[AMALG][COSMETIC] ${panelId} minorVotes=${minorVotes} < ${MINOR_COSMETIC_FLAG_THRESHOLD} → single unsupported MINOR → low-weight flag, no cost (Ruling 2)`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _perViewClear: true, _amalgSingleMinor: true, _ledgerSeverity: 'MINOR' });
        flaggedParts.push({ panelId, partName, zone, weight: 'low', reason: AMALG_REASON_SINGLE_MINOR, _amalgSingleMinor: true });
      }
    } else if (damaged > 0 && clean === 0) {
      // Silence-as-clean implicit corroboration (REAR_PANEL only). Count views that imaged a
      // co-visible rear neighbour but emitted no line for this panel — each is an implicit-clean
      // vote (panel in frame, model looked, didn't flag). effectiveClean = explicit + implicit.
      let implicitClean = 0;
      if (viewPanelSets && SILENCE_AS_CLEAN_PANELS.has(panelId)) {
        for (const panelSet of viewPanelSets.values()) {
          if (panelSet.has(panelId)) continue;                                    // view DID flag/observe it — not silent
          if ([...PANEL_REAR_NEIGHBOURS].some(nb => panelSet.has(nb))) implicitClean++;
        }
      }
      const effectiveClean = clean + implicitClean;
      if (isFlagOnly) {
        console.log(`[AMALG] ${panelId} ${damaged}/${resolving} damaged (flag-class) → flag (not cost)`);
        flaggedParts.push({ panelId, partName, zone, weight: 'high', reason: AMALG_REASON_FLAG_CLASS });
      } else if (HIDDEN_CORROBORATION_PANELS.has(panelId) && viewsThatSaw >= 2 && damaged < 2) {
        // Straight corroboration floor for hidden exposed-only cost parts (SLAM_PANEL): ≥2 views
        // saw it but <2 confirmed damage → uncorroborated → floor to inspection. NOT silence-as-clean
        // (no neighbour anchor) — distinct from the REAR_PANEL branch below. On SF69YBB SLAM_PANEL is
        // 4/4 SEVERE → handled by severeOverride above, never reaches here; the floor only bites a
        // single-grade-among-na SLAM_PANEL. Reached only when severeOverride is false.
        console.log(`[AMALG] ${panelId} ${damaged}/${viewsThatSaw} single-grade among views that saw it → uncorroborated → floor`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _amalgUncorroborated: true });
        flaggedParts.push({ panelId, partName, zone, weight: 'medium', reason: AMALG_REASON_UNCORROBORATED, _amalgUncorroborated: true });
      } else if (SILENCE_AS_CLEAN_PANELS.has(panelId) && damaged < 2 && effectiveClean >= 1) {
        // Single damaged read, but co-visible neighbours seen in other views did NOT flag this
        // panel → uncorroborated → floor to inspection (not cost). Reached only when severeOverride
        // is false (a lone SEVERE is severeVotes=1 < threshold), so it is independent of override.
        // SILENCE_AS_CLEAN_PANELS holds only non-flank panels, so flank G-pass logic is untouched.
        console.log(`[AMALG] ${panelId} ${damaged} damaged + ${implicitClean} implicit-clean (neighbour-seen, panel-silent) → uncorroborated → floor`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _amalgUncorroborated: true });
        flaggedParts.push({ panelId, partName, zone, weight: 'medium', reason: AMALG_REASON_UNCORROBORATED, _amalgUncorroborated: true });
      } else {
        console.log(`[AMALG] ${panelId} ${damaged}/${resolving} damaged → cost`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: true, partHeight: null,
          _ledgerSeverity: damagedSevs.includes('SEVERE') ? 'SEVERE' : (hasModerate ? 'MODERATE' : 'MINOR'),
          ...(_instanceKey ? { _gOwned: true, _gSeverity: damagedSevs.includes('SEVERE') ? 'SEVERE' : 'MODERATE' } : {}) });
      }
    } else if (clean > 0 && damaged === 0) {
      console.log(`[AMALG] ${panelId} ${clean}/${resolving} clean → clear`);
      costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _perViewClear: true });
    } else {
      // DISAGREE — some views saw damage, some saw it clean. Batch 81 §1 (Vincent): the engine must
      // never silently resolve a disagreement — it surfaces it and the buyer rules. The panel STAYS in
      // the ledger costed at its reconciled/table price AND carries this inspection flag; the visibility
      // gate no longer strips it (lib/parts.mjs). iv stays false (it was not independently confirmed),
      // so the _amalgDisagree marker — now on the COSTED entry, mirroring the flag — is how the gate and
      // the §2 ledger/flag invariant recognise a disagree panel distinctly from a per-view CLEAR (which
      // still strips). This is the over-count-safe direction: a costed-but-flagged phantom is challengeable;
      // a silent deletion corrupts the total, the profit window and the bid ceiling with no trace.
      // Extent grade for the labour shape (batch 81 amendment 2): a disagree survivor carries the
      // severity of its DAMAGED views (the extent the buyer is inspecting for), so severity-weighted
      // labour can weight it. SEVERE if any damaged view was SEVERE, else MODERATE if any MODERATE, else
      // MINOR. Independent of the cost figure — extent, not value.
      const _disagreeSev = damagedSevs.includes('SEVERE') ? 'SEVERE' : (hasModerate ? 'MODERATE' : 'MINOR');
      console.log(`[AMALG] ${panelId} disagree (${damaged} damaged, ${clean} clean) → COST + flag (batch 81 §1; gate no longer strips) sev=${_disagreeSev}`);
      costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _amalgDisagree: true, _ledgerSeverity: _disagreeSev });
      flaggedParts.push({ panelId, partName, zone, weight: 'medium', reason: AMALG_REASON_DISAGREE, _amalgDisagree: true });
    }
    // C2 stamp: attach the member frames to whichever costed entry this group produced.
    // LOAD-BEARING INVARIANT: each branch of the chain above pushes AT MOST ONE costedParts entry
    // (flag-class branches push zero) — so when the count grew, the last entry is this group's costed
    // part. If a future branch pushes two costed entries this stamp silently mis-targets; keep it 1:1.
    if (costedParts.length > _preCosted) {
      const _cp = costedParts[costedParts.length - 1];
      _cp._probeViews = _probeViews;
      // opp-ref: carry the Case-B excluded-clean views (group._oppRefViews) so the aperture P1 branch
      // can append them as opposite-side reference frames. Same 1:1 last-entry mechanism as _probeViews.
      if (Array.isArray(_oppRefViews) && _oppRefViews.length) _cp._oppRefViews = _oppRefViews;
    }
    // Per-panel vote split — keyed by _instanceKey when G split this panel, else bare panelId.
    // _instanceKey (e.g. 'FRONT_DOOR#1') keeps pvVotesMap entries distinct for G-split instances
    // while all downstream consumers (gate, VDS, seeder) still see bare panelId on the object.
    const branch = missing > 0              ? 'iv:missing-dominant'
                 : resolving === 0          ? 'not-visible'
                 : damaged > 0 && clean === 0 ? 'passed-costed'
                 : clean > 0 && damaged === 0 ? 'passed-clear'
                 : 'disagree';
    let pvKey = _instanceKey ?? panelId;
    if (pvKey in pvVotesMap) {
      pvVotesCollision = true;
      let n = 2;
      while (`${panelId}#${n}` in pvVotesMap) n++;
      pvKey = `${panelId}#${n}`;
    }
    pvVotesMap[pvKey] = { views: members.length, resolving, damaged, clean, notVisible: missing, branch, severeVotes };
  }
  return { costedParts, flaggedParts, pvVotesMap, pvVotesCollision };
}

function ledgerPreamble(pvResult) {
  // _gOwned entries are G-split COSTED instances: code injects their cost lines post-gate.
  // Filter them out so the model never sees a COSTED ledger line for them and emits no
  // Parts Breakdown row. CLEAR and FLOORED split-instance entries are NOT _gOwned and
  // remain in the ledger — model correctly skips them per the existing CLEAR/FLOORED rule.
  const lines = pvResult.costedParts.filter(e => !e._gOwned).map(e => {
    const word = e.independentlyVisible === true
      ? (e._amalgMissing  ? 'MISSING' : 'COSTED')
      : (e._perViewClear  ? 'CLEAR'   : 'FLOORED');
    return `${word.padEnd(8)}${e.partName}  ${e.zone}`;
  });
  return (
    'PANEL DAMAGE LEDGER — per-view analysis across all photos, already determined.\n' +
    'COSTED  = damaged confirmed → cost it (repair or replace).\n' +
    'MISSING = physically absent → cost it as replace.\n' +
    'FLOORED = unresolved → do NOT cost; it belongs in flags.\n' +
    'CLEAR   = confirmed undamaged → do NOT cost.\n\n' +
    lines.join('\n')
  );
}

function selectStruckCornerVerdict(corners) {
  if (!Array.isArray(corners) || corners.length === 0) return null;
  // A 'missing' verdict is the strongest signal — prefer it
  const missingCorner = corners.find(c => c.verdict === 'missing');
  if (missingCorner) return missingCorner;
  // Look for damage keywords in descriptor or evidence
  const DAMAGE_MARKERS = /damage|struck|impact|deformed|crushed|displaced bumper|exposed recess|major/i;
  const damagedCorner = corners.find(c =>
    DAMAGE_MARKERS.test(c.corner_descriptor || '') ||
    DAMAGE_MARKERS.test(c.evidence || '')
  );
  if (damagedCorner) return damagedCorner;
  // Single corner reported — use it
  if (corners.length === 1) return corners[0];
  return null; // ambiguous — fall back to cannot_determine
}

function deriveLampType(vd) {
  const make     = (vd.make  || '').toLowerCase().replace(/[-\s]/g, '');
  const model    = (vd.model || '').toLowerCase();
  const year     = parseInt(vd.year, 10) || 0;
  const specText = [vd.model, vd.engineSize, vd.bodyStyle, vd.damageDescription]
    .filter(Boolean).join(' ').toLowerCase();

  // Explicit lamp-type markers in spec text override derivation
  if (/\b(full[\s-]?led|matrix[\s-]?led|adaptive[\s-]?led|laser[\s-]?headlamp)\b/.test(specText)) return 'led';
  if (/\bxenon\b|\bbi[\s-]?xenon\b|\bhid\b/.test(specText)) return 'hid';

  // Tesla — always LED
  if (make === 'tesla') return 'led';

  // Lexus — LED standard on recent models
  if (make === 'lexus' && year >= 2016) return 'led';

  // Toyota
  if (make === 'toyota') {
    // Yaris Gen3 (2011-2019) — halogen across all trims; GR Yaris starts 2020
    if (model.includes('yaris') && year >= 2011 && year <= 2019) return 'halogen';
    // Aygo (2014-2021) — halogen
    if (model.includes('aygo') && year >= 2014 && year <= 2021) return 'halogen';
    // GT86 (2012-2021) — halogen
    if ((model.includes('gt86') || model.includes('gt 86')) && year >= 2012 && year <= 2021) return 'halogen';
  }

  // Ford
  if (make === 'ford') {
    // Fiesta Mk7/7.5/8 (2012-2022) — halogen standard; LED optional pack, not pinnable without trim
    if (model.includes('fiesta') && year >= 2012 && year <= 2022) return 'halogen';
    // Focus Mk3 (2011-2018) — halogen standard
    if (model.includes('focus') && year >= 2011 && year <= 2018) return 'halogen';
    // Ka/Ka+ (2008-2021) — halogen
    if (model.includes('ka') && year >= 2008 && year <= 2021) return 'halogen';
  }

  // Vauxhall / Opel
  if (make === 'vauxhall' || make === 'opel') {
    // Corsa D (2006-2014) and E (2014-2019) — halogen
    if (model.includes('corsa') && year >= 2006 && year <= 2019) return 'halogen';
    // Astra K (2015-2021) — halogen standard
    if (model.includes('astra') && year >= 2015 && year <= 2021) return 'halogen';
    // Adam — halogen
    if (model.includes('adam') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Volkswagen
  if (make === 'volkswagen' || make === 'vw') {
    // Polo (6R 2009-2017 / AW 2018-2022) — halogen standard across trims
    if (model.includes('polo') && year >= 2009 && year <= 2022) return 'halogen';
    // Up! (2012-2019) — halogen
    if (model.includes('up') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Renault
  if (make === 'renault') {
    // Clio III/IV (2012-2019) — halogen standard
    if (model.includes('clio') && year >= 2012 && year <= 2019) return 'halogen';
    // Megane IV (2016-2022) — halogen standard on most trims
    if ((model.includes('megane') || model.includes('mégane')) && year >= 2016 && year <= 2022) return 'halogen';
    // Twingo III (2014-2022) — halogen
    if (model.includes('twingo') && year >= 2014 && year <= 2022) return 'halogen';
  }

  // Nissan
  if (make === 'nissan') {
    // Micra K13 (2010-2016) — halogen
    if (model.includes('micra') && year >= 2010 && year <= 2016) return 'halogen';
    // Juke Mk1 (2010-2019) — halogen standard
    if (model.includes('juke') && year >= 2010 && year <= 2019) return 'halogen';
    // Note (2012-2016) — halogen
    if (model.includes('note') && year >= 2012 && year <= 2016) return 'halogen';
  }

  // Seat
  if (make === 'seat') {
    // Ibiza 5th gen (2017-2021) — halogen standard
    if (model.includes('ibiza') && year >= 2017 && year <= 2021) return 'halogen';
    // Mii (2012-2019) — halogen
    if (model.includes('mii') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Skoda
  if (make === 'skoda') {
    // Fabia (2014-2021) — halogen standard
    if (model.includes('fabia') && year >= 2014 && year <= 2021) return 'halogen';
    // Citigo (2012-2019) — halogen
    if (model.includes('citigo') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Kia / Hyundai — halogen standard on city/supermini models pre-2020
  if (make === 'kia') {
    if ((model.includes('rio') || model.includes('picanto') || model.includes('stonic')) && year >= 2011 && year <= 2019) return 'halogen';
  }
  if (make === 'hyundai') {
    if ((model.includes('i10') || model.includes('i20')) && year >= 2013 && year <= 2019) return 'halogen';
  }

  // Honda
  if (make === 'honda') {
    // Jazz Mk3 (2015-2020) — halogen standard
    if (model.includes('jazz') && year >= 2015 && year <= 2020) return 'halogen';
    // Civic Mk10 (2017-2022) — halogen standard on entry trims
    if (model.includes('civic') && year >= 2017 && year <= 2019) return 'halogen';
  }

  // Fiat
  if (make === 'fiat') {
    // 500 (2007-2023) — halogen standard
    if (model.includes('500') && year >= 2007 && year <= 2022) return 'halogen';
    // Panda (2012-2021) — halogen
    if (model.includes('panda') && year >= 2012 && year <= 2021) return 'halogen';
  }

  // Universal floor: pre-2011 vehicles are essentially all halogen
  if (year > 0 && year <= 2010) return 'halogen';

  return 'indeterminate';
}

// Assumed-LED disclosure — single owner of the wording. Emitted as prose by computeLampResult on the
// tier-2 assumed path, and as an inspection flag on the tier-1 orphan clamp (post-gate, below) — the
// disclosure follows the assumption wherever an assumed-LED band arises, not any one trigger path.
const LAMP_ASSUMED_DISCLOSURE = 'Lamp type could not be confirmed from the vehicle spec, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';

// Single owner of the spec→type→band resolution. Spec-table type OWNS the band when concrete; when
// indeterminate, the HIGHER of any vision detection / LED default is used (never under-budget).
// Consumed by computeLampResult (with detection) and by the request-scope specLampBand computation for
// the tier-1 orphan clamp (detection null). Discarded detection is logged so the swing is visible.
function resolveLampBand(specLampType, detectionLampType = null) {
  const LAMP_RANK        = { halogen: 1, hid: 2, led: 3 };
  const specAssumed      = !HEADLAMP_BANDS[specLampType];
  const resolvedSpecType = specAssumed ? HEADLAMP_BAND_DEFAULT : specLampType;
  const resolvedDetType  = (detectionLampType && HEADLAMP_BANDS[detectionLampType]) ? detectionLampType : null;
  let resolvedType;
  if (!specAssumed) {
    resolvedType = resolvedSpecType;                       // spec concrete → spec wins, detection ignored
    if (resolvedDetType && resolvedDetType !== resolvedSpecType) {
      console.log(`[LAMP] detection=${resolvedDetType} discarded — spec-table ${resolvedSpecType} concrete (spec wins)`);
    }
  } else {
    resolvedType = (resolvedDetType && (LAMP_RANK[resolvedDetType] ?? 0) > (LAMP_RANK[resolvedSpecType] ?? 0))
      ? resolvedDetType : resolvedSpecType;                // spec indeterminate → HIGHER of detection / LED default
  }
  return { resolvedType, bandValue: HEADLAMP_BANDS[resolvedType], lampTypeAssumed: specAssumed && !resolvedDetType };
}

const DAMAGE_SPAN_ENUM = ['single_corner', 'full_width'];
const STRUCK_SIDE_ENUM = ['offside', 'nearside', 'central'];
// C4 — normalise a raw impact-obs field to its default on absence/invalid-enum, returning enough
// metadata to loud-log the substitution and stamp a per-field marker. `defaulted` is true for both
// absent and off-enum; `rejected` carries the verbatim off-enum value (null when merely absent).
function normaliseImpactField(raw, enumVals, dflt) {
  if (raw === undefined || raw === null || raw === '') return { value: dflt, defaulted: true, rejected: null };
  if (!enumVals.includes(raw)) return { value: dflt, defaulted: true, rejected: raw };
  return { value: raw, defaulted: false, rejected: null };
}
// C4 — tier-1 floor observation (infra-failure / no-arm). Every field defaulted; markers say so, so
// the unconditional stamp reads a floor honestly. apertureExposed:false → span is moot (lampCount 1).
function tier1FloorLampObs() {
  return {
    struckSide: 'central', apertureExposed: false, rearApertureExposed: false, damageSpan: 'full_width',
    _sideDefaulted: true, _sideRejected: null, _spanDefaulted: true, _spanRejected: null,
  };
}

function computeLampResult(struckSide, apertureExposed, lampType, detectionVerdict = null, detectionLampType = null, damageSpan = 'full_width', spanDefaulted = false) {
  // struckSide kept as internal field for logging only — never interpolated into rendered strings
  const side = (struckSide === 'offside' || struckSide === 'nearside') ? struckSide : 'central';

  // Band selection is owned by resolveLampBand (single owner): spec-table type wins when concrete;
  // when indeterminate, the HIGHER of detection / LED default. Detection oscillates run-to-run and
  // may never override a concrete spec upward.
  const { resolvedType, bandValue, lampTypeAssumed } = resolveLampBand(lampType, detectionLampType);

  // Lamp count from geometry: full-width frontal implies both lamps implicated
  const lampCount = (apertureExposed && damageSpan === 'full_width') ? 2 : 1;
  // S5-1 — span-source provenance: single owner, labelled where the count decision is taken (never
  // re-derived downstream). spanDefaulted refines full_width when the span VALUE was defaulted upstream.
  const spanSource = !apertureExposed ? 'tier1-forced'
    : damageSpan === 'full_width' ? (spanDefaulted ? 'full_width-defaulted' : 'full_width')
    : 'single_corner';

  const assumedDisclosure = ' ' + LAMP_ASSUMED_DISCLOSURE;
  const tier1Line = 'Struck front corner — confirm a serviceable headlamp on inspection.';

  if (!apertureExposed) {
    return { tier: 1, tier2Fired: false, struckSide: side, tier1Line, lampType: resolvedType, lampTypeAssumed, lampAllowance: 0, lampCount: 1, spanSource };
  }

  // Verdict branch: toggle gates confident 'missing' wording; detection is authoritative otherwise
  const effectiveVerdict = (detectionVerdict === 'missing' && !LAMP_DETECTION_CONFIDENT_WORDING)
    ? 'cannot_determine'
    : (detectionVerdict || 'cannot_determine');

  const checklistEntry = 'Show the struck-side headlamp aperture with the bumper pulled clear — confirm the actual headlamp type and that a serviceable unit is fitted, not just an exposed recess.';
  const checklistEntry2nd = lampCount === 2
    ? `Inspect the opposite-side headlamp — on a full-width frontal impact both lamps are implicated; check for displacement, cracking, or moisture ingress and confirm serviceability. Budget ~£${bandValue} if replacement needed — flagged as inspection allowance, not included in repair total.`
    : null;

  if (effectiveVerdict === 'present') {
    // Cost always applies on apertureExposed — a displaced-bumper aperture makes photo evidence
    // unreliable regardless of what appears present. Verdict controls wording only.
    let verdictLine = `Struck front corner headlamp — the headlamp on the struck corner appears present; however, on a displaced-bumper impact the aperture is unreliable and serviceability cannot be confirmed from photos. Replacement costed at £${bandValue} (${resolvedType}) as a precautionary allowance.`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict, spanSource };
  }

  if (effectiveVerdict === 'missing') {
    let verdictLine = `Struck front corner headlamp — the headlamp on the struck corner is missing. Replacement costed at £${bandValue} (${resolvedType}).`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict, spanSource };
  }

  // cannot_determine — default path and toggle-OFF 'missing'
  let verdictLine = `Struck front corner headlamp — on a displaced-bumper front-corner impact the headlamp is treated as a replacement; presence and serviceability cannot be confirmed from the photos. Replacement costed at £${bandValue} (${resolvedType}).`;
  verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
  const costDriverEntry = lampTypeAssumed
    ? `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}, assumed).`
    : `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}).`;
  return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict, spanSource };
}

// ── Parts Breakdown helpers ──────────────────────────────────────────────────

function parsePrice(s) {
  if (!s || /^[—\-–]+$|n\/a|nil|none/i.test(s.trim())) return null;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

function parseParts(text, sideScrubOut = null) {
  if (!text) return [];
  const result = [];
  for (const line of text.split('\n')) {
    // Trailing `|` tolerated — model occasionally closes rows Markdown-table-style
    // (e.g. "| £420 | — |"); the old anchor on a no-pipe tail rejected every such line.
    const m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|?\s*$/);
    if (!m) continue;
    const [, name, action, col3, col4] = m;
    const rawName      = name.trim();
    const panelId      = PANEL[rawName];
    let   resolvedName = PANEL_DISPLAY[panelId] ?? rawName;
    // Side-word scrub (lib/sideScrub.mjs) — residual tokens (left/right/n/s/o/s), removal
    // semantics, FALLBACK LEG ONLY. PANEL_DISPLAY names are neutral by construction; do not
    // double-process them. Display-only: applied after panelId resolution, no effect on
    // costing/identity (these non-panel rows pass the gate unchecked). Item 15 owns compound
    // side-terms upstream, so only bare tokens/abbreviations ever survive to here.
    if (!panelId) {
      const scrub = scrubSideWords(resolvedName);
      if (scrub.guarded) {
        console.warn(`[SIDE SCRUB][GUARD] "${scrub.original}" is only a side token — kept original (never blank)`);
      } else if (scrub.changed) {
        console.log(`[SIDE SCRUB] "${scrub.original}" -> "${scrub.name}"`);
        if (sideScrubOut) sideScrubOut.push({ original: scrub.original, scrubbed: scrub.name });
        resolvedName = scrub.name;
      }
    }
    result.push({ panelId, name: resolvedName, action: action.trim(), oem: parsePrice(col3), used: parsePrice(col4) });
  }
  return result;
}

function parsePartVerdicts(blockText) {
  const costedParts  = [];
  const flaggedParts = [];
  if (!blockText) return { costedParts, flaggedParts };

  const ZONES = 'front|rear|flank-damaged-side|roof|underside|interior';

  for (const line of blockText.split('\n')) {
    const t = line.trim();

    // PART: name | iv:X | z:Y | ph:Z  (ph optional)
    const pm = t.match(
      new RegExp(
        `^PART:\\s+(.+?)\\s*\\|\\s*iv:(true|false|na|missing)\\s*(?:\\|\\s*sev:(SEVERE|MODERATE|MINOR|-)\\s*)?\\|\\s*z:(${ZONES})(?:\\s*\\|\\s*ph:(low|mid|high))?\\s*$`,
        'i'
      )
    );
    if (pm) {
      const [, rawId, ivRaw, sevRaw, zone, phRaw] = pm;
      const panelId  = rawId.trim();
      const partName = PANEL_DISPLAY[panelId] ?? panelId;
      costedParts.push({
        panelId,
        partName,
        zone,
        independentlyVisible: ivRaw === 'true' ? true : ivRaw === 'false' ? false : ivRaw.toLowerCase() === 'missing' ? 'missing' : null,
        severity:             (sevRaw && sevRaw !== '-') ? sevRaw.toUpperCase() : null,
        partHeight:           phRaw || null,
      });
      continue;
    }

    // FLAG: name | z:Y | weight:W :: reason  (reason is everything after ::, pipe-safe)
    const fm = t.match(
      new RegExp(
        `^FLAG:\\s+(.+?)\\s*\\|\\s*z:(${ZONES})\\s*\\|\\s*weight:(low|medium|high)\\s*::(.+)$`,
        'i'
      )
    );
    if (fm) {
      const [, rawId, zone, weight, reason] = fm;
      const panelId  = rawId.trim();
      const partName = PANEL_DISPLAY[panelId] ?? panelId;
      flaggedParts.push({ panelId, partName, zone, weight, reason: reason.trim() });
    }
    // Unmatched lines silently skipped. Absent block → both arrays [].
  }

  return { costedParts, flaggedParts };
}

// Returns true if any line in the per-view output is "HV: visible".
// Distinct from parsePartVerdicts — HV: lines have a different prefix and are not PART: records.
function parseHvLines(blockText) {
  if (!blockText) return false;
  for (const line of blockText.split('\n')) {
    if (/^HV:\s*visible\s*$/i.test(line.trim())) return true;
  }
  return false;
}

// isLampLine / reconcileParts / sumPartsRealistic / normName / the visibility
// gate live in lib/parts.mjs (CB7 fix, 12 Jun 2026) so the regression harness
// imports the literal shipped functions.

function renderParts(parts) {
  // Three cost columns: OEM | S/H | Repair cost. A row populates EITHER OEM+S/H (replace) OR
  // Repair cost (repair / labour / non-part), NEVER both. Position only — the summed figure is
  // (used ?? oem), exactly as sumPartsRealistic reads it; no value is recomputed here.
  const fmt = v => v != null ? `£${v}` : '—';
  return parts.map((p, i) => {
    const isReplace  = (p.action || '').toLowerCase() === 'replace';
    const oemCell    = isReplace ? fmt(p.oem)            : '—';
    const shCell     = isReplace ? fmt(p.used)           : '—';
    const repairCell = isReplace ? '—'                   : fmt(p.used ?? p.oem);
    return `${i + 1}. ${p.name} | ${p.action} | ${oemCell} | ${shCell} | ${repairCell}`;
  }).join('\n');
}

const EXIT_BAND_STEPS = ['lower', 'mid-low', 'mid', 'mid-high', 'upper'];

const EXIT_BAND_PCT = {
  s: { lower: 70, 'mid-low': 72.5, mid: 75, 'mid-high': 77.5, upper: 80 },
  n: { lower: 80, 'mid-low': 82.5, mid: 85, 'mid-high': 87.5, upper: 90 },
};

function parseExitBandStep(text) {
  if (!text) return null;
  const first = text.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z-]/g, '');
  return EXIT_BAND_STEPS.includes(first) ? first : null;
}

// ── Cat A / Cat B hard stop (code backstop — batch 71 FIX 1) ──────────────────────────────────
// Safety/compliance gate, not a quality tweak. Category A (scrap — must be crushed, no V5C reissued)
// and Category B (break — shell crushed, licensed dismantlers only, bolt-on parts only) can never
// return to the road as a repairable vehicle. assessmentEngine.js §241/243 instructs the MODEL to
// refuse a repair estimate and whole-vehicle exit valuation — but that is the model choosing to obey
// a prompt, and computeExitFromBand below treats an unknown band (INCLUDING A/B) as Cat S, so absent
// this gate the engine WOULD price one. This reads the recorded category only (enrichedVd.category),
// post-perception, and enforces the refusal regardless of what the model produced.
const CAT_AB_STOP = {
  a: 'Category A — scrap only. This vehicle must be crushed entirely and cannot legally return to the road; no V5C is reissued. It is not a repair or resale prospect, so no repair estimate or exit valuation is produced.',
  b: 'Category B — break/dismantle only. The bodyshell must be crushed and only bolt-on parts may be reused; it may be sold solely to licensed dismantlers. It is not a repairable vehicle, so no repair estimate or whole-vehicle exit valuation is produced.',
};
// Returns 'a' | 'b' | null from the recorded category. Null category never fires (catLetter → null).
function catABHardStopLetter(categoryStr) {
  const c = catLetter(categoryStr || '');
  return (c === 'a' || c === 'b') ? c : null;
}

function computeExitFromBand(tradeLow, categoryStr, bandText) {
  const cat = catLetter(categoryStr || '');
  const band = cat === 'n' ? 'n' : 's'; // unknown → Cat S (conservative)
  const rawStep = parseExitBandStep(bandText);
  if (!rawStep) {
    console.warn(`[EXIT BAND] unexpected value="${(bandText || '').slice(0, 80)}" defaulted to mid`);
  }
  const step = rawStep ?? 'mid';
  const pct  = EXIT_BAND_PCT[band][step];
  const exit = Math.round(tradeLow * pct / 100);
  if (exit >= tradeLow) {
    console.warn(`[EXIT BAND] sanity fail: exit £${exit} >= trade_low £${tradeLow}`);
  }
  return { exit, band, step, pct };
}

const HAMMER_LADDER_LOW_PCT  = 0.10;
const HAMMER_LADDER_HIGH_PCT = 0.50;
const HAMMER_LADDER_ROWS     = 6;

function buildHammerLadder(exitValue) {
  const low  = exitValue * HAMMER_LADDER_LOW_PCT;
  const high = exitValue * HAMMER_LADDER_HIGH_PCT;
  const step = (high - low) / (HAMMER_LADDER_ROWS - 1);

  const inc = exitValue < 3000  ?  50
            : exitValue < 10000 ? 100
            : exitValue < 25000 ? 250
            :                     500;

  const raw = Array.from({ length: HAMMER_LADDER_ROWS }, (_, i) => low + i * step);
  const rounded = raw.map(v => Math.round(v / inc) * inc);

  // Ensure strict ascending order after rounding (nudge any collision up one increment)
  for (let i = 1; i < rounded.length; i++) {
    if (rounded[i] <= rounded[i - 1]) rounded[i] = rounded[i - 1] + inc;
  }
  return rounded;
}

// ── SalvageGuide market cross-check (Bid Predictor) ──────────────────────────
// One Auto SalvageGuide is a LABELLED, independent market reference shown ALONGSIDE the engine's
// own figures. It NEVER feeds the exit value or the margin maths — Brego/Cazana own the repaired-
// retail/exit value; the engine owns the hammer judgement. The divergence flag fires when the
// engine's break-even hammer sits outside SalvageGuide's predicted bid range by more than this
// fraction. Tunable.
const SALVAGEGUIDE_DIVERGENCE_PCT = 0.15;

// The engine's single implied "predicted hammer" for the cross-check = the break-even hammer:
// where the margin ladder crosses £0 (the most you could pay at hammer and still not lose money).
// Linear-interpolated between the two bracketing ladder rows; null when the ladder never crosses
// £0 (break-even outside the shown range) → no divergence claim (fail-safe, never a false alarm).
function breakEvenHammer(scenarios) {
  if (!Array.isArray(scenarios)) return null;
  const pts = scenarios.filter(s => Number.isFinite(Number(s?.hammer)) && Number.isFinite(Number(s?.margin)));
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.margin >= 0 && b.margin < 0) || (a.margin < 0 && b.margin >= 0)) {
      const t = a.margin / (a.margin - b.margin);
      return Math.round(a.hammer + t * (b.hammer - a.hammer));
    }
  }
  return null;
}

// Airbag deployment is CODE-OWNED from structured signals — the per-view AIRBAG enum
// (authoritative: a SEEN deployed bag) and the Copart listing paste (corroborator + the ONLY
// path to an explicit count/position upgrade). Prose is NOT a source: it wobbles run-to-run
// (VXZ2849 — both front bags deployed, prose underplayed them → the retired CALL2 field read
// all-unknown → £0). The per-view position ban means the enum confirms DEPLOYMENT but not
// COUNT; count (T2/T3) is earned only when the paste explicitly names ≥2 distinct bags.

// Parse the raw Copart paste for airbag deployment + explicit count/position. Null-safe
// (rawCopartPaste is Copart-only, null elsewhere). Count signals are scoped to airbag-context
// sentences so "driver's door" / "passenger seat" cannot be mistaken for a front-pair read.
function analyseAirbagPaste(pasteRaw) {
  const paste = typeof pasteRaw === 'string' ? pasteRaw : '';
  if (!paste) return { deployed: false, intact: false, curtainSide: false, bothFront: false };
  // Copart mashes tokens against adjacent values with NO boundary, on BOTH edges — canaries
  // (real pastes): TRAILING "AIRBAGS DEPLOYED2024" (word→digit; ET24KZJ) and LEADING
  // "View NotesAIRBAGS DEPLOYED" (lowercase→UPPERCASE camelCase join from a DOM copy; FP21YHW).
  // Two-part defence — match against `clean`, never the raw paste:
  //   • `clean` inserts a space at every lowercase→UPPERCASE join, so a leading-mashed airbag
  //     word ("NotesAIRBAGS" → "Notes AIRBAGS") becomes reachable by the leading \b. All-lowercase
  //     runs ("repairbags") are untouched → still blocked by the leading \b (no false positive).
  //   • trailing (?=\b|\d) (not \b) matches a normal boundary OR a following digit, still rejecting
  //     a following LETTER (keeps "undeployed" out).
  // Do NOT mutate rawCopartPaste (immutable) and do NOT pre-clean globally in normaliseLot/
  // parseCopart (wrecks mixed-case values like "EcoBoost"/"McLaren"). If you touch these, re-test
  // BOTH canary strings above.
  const clean = paste.replace(/([a-z])([A-Z])/g, '$1 $2');
  const deployed = /\bair\s?bags?(?=\b|\d)[^.\n]{0,20}\bdeployed(?=\b|\d)|\bdeployed(?=\b|\d)[^.\n]{0,20}\bair\s?bags?(?=\b|\d)/i.test(clean);
  // High-bar explicit "airbags NOT deployed / intact" — the only structured positive-no-deployment
  // signal (the enum never emits an intact vote). Only ever suppresses a flag, never a cost.
  const intact = !deployed && /\bair\s?bags?(?=\b|\d)[^.\n]{0,30}\b(?:not deployed|undeployed|intact|did not deploy|didn'?t deploy)(?=\b|\d)/i.test(clean);
  // Count/position — scoped to airbag-context sentences only.
  const ctxBlob = clean.split(/(?<=[.!?\n])\s+/).filter(s => /\bair\s?bags?(?=\b|\d)|\bsrs(?=\b|\d)/i.test(s)).join(' ');
  const curtainSide = /\bcurtain(?=\b|\d)|\bthorax(?=\b|\d)|seat[\s-]?mounted|\bside(?=\b|\d)[^.\n]{0,12}air\s?bag|air\s?bag[^.\n]{0,12}\bside(?=\b|\d)/i.test(ctxBlob);
  const bothFront   = /\bdriver(?=\b|\d)/i.test(ctxBlob) && /\bpassenger(?=\b|\d)/i.test(ctxBlob);
  return { deployed, intact, curtainSide, bothFront };
}

// Code-owned SRS tier from structured signals. deploymentConfirmedByEnum (per-view AIRBAG enum)
// is authoritative; the paste corroborates deployment and is the ONLY count upgrade. Returns
// { deploymentConfirmed, tier, confident, countResolved, branch }.
//   paste names a curtain/side bag         → T3 confident (count resolved)
//   paste names driver AND passenger       → T2 confident (count resolved)
//   deployment confirmed, count unknown    → T1 CONFIDENT FLOOR (never £0; + inspect-for-extent)
//   no enum signal AND no paste deployment → deploymentConfirmed:false (caller: paste-intact → no
//                                            flag; otherwise the honest "confirm whether deployed"
//                                            defer flag). A bare plural "airbags" is NOT a count —
//                                            never infer T2 from the word being plural.
function srsTierFromSignals(deploymentConfirmedByEnum, paste) {
  const deploymentConfirmed = Boolean(deploymentConfirmedByEnum) || paste.deployed;
  if (!deploymentConfirmed) return { deploymentConfirmed: false, tier: null, confident: false, countResolved: false, branch: 'no-deployment-signal' };
  if (paste.curtainSide) return { deploymentConfirmed: true, tier: 3, confident: true, countResolved: true,  branch: 'paste-curtain/side→T3' };
  if (paste.bothFront)   return { deploymentConfirmed: true, tier: 2, confident: true, countResolved: true,  branch: 'paste-both-front→T2' };
  return { deploymentConfirmed: true, tier: 1, confident: true, countResolved: false, branch: 'deployment-confirmed-count-unresolved→T1-floor' };
}

// Thrown by runAssessment when too many model calls exhausted their 529 retries (single-instance
// call lost, or 3+ per-view calls lost). The route's envelope catches it to reset session status,
// refund, and return 503 — the old inline 529-abort path, now surfaced from the pure pipeline.
class AssessmentOverloadedError extends Error {
  constructor(reason) { super(`assessment overloaded: ${reason}`); this.name = 'AssessmentOverloadedError'; this.reason = reason; }
}

export async function GET(request) {
  console.log(`[DEPLOY] sha=${process.env.VERCEL_GIT_COMMIT_SHA || 'n/a'} dep=${process.env.VERCEL_DEPLOYMENT_ID || 'n/a'} url=${process.env.VERCEL_URL || 'n/a'} env=${process.env.VERCEL_ENV || 'n/a'}`);
  const { searchParams } = new URL(request.url);
  const stripeSessionId = searchParams.get('session_id');
  const salvageId = searchParams.get('salvage_id');
  const promoToken = searchParams.get('promo_token');

  // Captured at Stripe verification; used for abort-refund if 529s exhaust all retries.
  // Only set for non-promo sessions (promo has no charge to refund).
  let paymentIntentId = null;
  let chargeAmount    = null;

  if (!salvageId || (!stripeSessionId && !promoToken)) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  const supabase = getSupabase();

  try {
    // CB4: staleness threshold — created_at used as proxy for processing-started-at.
    // updated_at not verified to auto-update (no trigger confirmed in this codebase).
    // 600s = 300s maxDuration + ~300s checkout flow headroom. Long-term recommendation:
    // add a Supabase `updated_at` trigger for a tighter (≈360s) threshold.
    // Hoisted here so both the promo guard and the main guard can reference it.
    const STALE_PROCESSING_SECS = 600;

    if (promoToken) {
      const { data: tokenCheck } = await supabase
        .from('salvage_sessions')
        .select('vehicle_details')
        .eq('id', salvageId)
        .single();
      if (!tokenCheck || tokenCheck.vehicle_details?.promoToken !== promoToken) {
        return NextResponse.json({ error: 'Invalid promo token' }, { status: 403 });
      }
    } else {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const stripeSession = await stripe.checkout.sessions.retrieve(stripeSessionId);
      if (stripeSession.payment_status !== 'paid') {
        return NextResponse.json({ error: 'Payment not confirmed' }, { status: 402 });
      }
      // Bind the paid session to THIS salvage session (C§2). Without this, a paid session for salvage A
      // could drive an assessment of salvage B — the promo branch above already binds promoToken, and
      // the vehicle product binds the paid VRM (vehicle/route.js). checkout writes metadata.salvage_id
      // (checkout:145); require it to match, so paymentIntentId/chargeAmount below (and the auto-refund
      // path that reads chargeAmount) are the RIGHT payment for this lot.
      if (stripeSession.metadata?.salvage_id !== salvageId) {
        return NextResponse.json({ error: 'Payment does not match this assessment' }, { status: 403 });
      }
      paymentIntentId = stripeSession.payment_intent || null;
      chargeAmount    = stripeSession.amount_total   || null;
    }

    if (promoToken) {
      const { data: claimed } = await supabase
        .from('salvage_sessions')
        .update({ status: 'processing' })
        .eq('id', salvageId)
        .in('status', ['promo_redeemed', 'pending'])
        .select('id');

      if (!claimed?.length) {
        const { data: current } = await supabase
          .from('salvage_sessions')
          .select('status, assessment, vehicle_details, market, rerun_count, created_at')
          .eq('id', salvageId)
          .single();
        if (current?.assessment) {
          const vd = current.vehicle_details || {};
          return NextResponse.json({
            assessment: current.assessment,
            vehicleDetails: vd,
            market: current.market,
            rerunCount: current.rerun_count ?? 0,
            bregoData: vd.bregoValuation ?? null,
          });
        }
        // CB4: stale-lock recovery for promo path
        if (current?.status === 'processing') {
          const ageSec = current.created_at
            ? (Date.now() - new Date(current.created_at).getTime()) / 1000
            : Infinity;
          if (ageSec > STALE_PROCESSING_SECS) {
            // CE: promo-aware reset — token must remain retryable; promo claim accepts
            // 'promo_redeemed', not 'failed'. Mirrors what the catch block already does.
            console.error(`[STALE LOCK] promo salvageId=${salvageId} processing for ${Math.round(ageSec)}s — resetting to promo_redeemed`);
            await supabase.from('salvage_sessions').update({ status: 'promo_redeemed' }).eq('id', salvageId).eq('status', 'processing');
            return NextResponse.json({ error: 'Assessment timed out — please try again' }, { status: 500 });
          }
        }
        return NextResponse.json({ error: 'Assessment already in progress' }, { status: 409 });
      }
    }

    // Check for cached assessment first (without fetching images)
    // NOTE: zero One Auto calls here — salvageHistory is stored in vehicle_details
    // on the initial assess run and read back verbatim.
    const { data: check } = await supabase
      .from('salvage_sessions')
      .select('status, vehicle_details, market, assessment, rerun_count, stripe_session_id, created_at')
      .eq('id', salvageId)
      .single();

    if (check?.assessment) {
      if (stripeSessionId && !check.stripe_session_id && !promoToken) {
        const { error: recoveryWriteError } = await supabase
          .from('salvage_sessions')
          .update({ stripe_session_id: stripeSessionId })
          .eq('id', salvageId);
        if (recoveryWriteError) {
          console.error(`[STRIPE SESSION WRITE FAILED] salvageId=${salvageId} error=${JSON.stringify(recoveryWriteError)}`);
        }
      }
      const vd = check.vehicle_details || {};
      return NextResponse.json({
        assessment: check.assessment,
        vehicleDetails: vd,
        market: check.market,
        rerunCount: check.rerun_count ?? 0,
        bregoData: vd.bregoValuation ?? null,
      });
    }

    // CB4: stale-lock recovery — hard Vercel kills (maxDuration=300s) bypass catch,
    // leaving status='processing' permanently. Caught exceptions use the catch block
    // to reset to 'failed'; this handles the uncaught hard-kill case only.
    // CE: promo sessions are identified from the row (vehicle_details.promoToken)
    // rather than the request parameter, so the guard is correct even in the
    // cross-contamination edge case (Stripe session_id presented with a promo
    // salvage_id). Promo sessions that just claimed also land here with
    // status='processing'; the row-level exclusion prevents the main guard from
    // 409ing them or overwriting the inner block's promo-aware stale reset.
    // Promo hard-kills are handled entirely by the inner block's CB4 guard;
    // this path is non-promo only. The inner promo guard is promo-scope by
    // definition (it sits inside the if (promoToken) verification block).
    if (check?.status === 'processing' && !check?.assessment && !check.vehicle_details?.promoToken) {
      const ageSec = check.created_at
        ? (Date.now() - new Date(check.created_at).getTime()) / 1000
        : Infinity;
      if (ageSec > STALE_PROCESSING_SECS) {
        console.error(`[STALE LOCK] salvageId=${salvageId} processing for ${Math.round(ageSec)}s — resetting to failed`);
        await supabase
          .from('salvage_sessions')
          .update({ status: 'failed' })
          .eq('id', salvageId)
          .eq('status', 'processing');
        return NextResponse.json({ error: 'Assessment timed out — please try again' }, { status: 500 });
      }
      // Live processing session (within window) — return 409
      return NextResponse.json({ error: 'Assessment already in progress' }, { status: 409 });
    }

    // Need to run assessment — fetch full session including images
    const { data: session, error: fetchError } = await supabase
      .from('salvage_sessions')
      .select('*')
      .eq('id', salvageId)
      .single();

    if (fetchError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Photos are kept 24 hours (batch 42); the ROW survives, so absence no longer signals expiry —
    // images_purged_at does. Return the honest 410 on that POSITIVE fact, BEFORE any image fetch, so
    // the customer never reaches fetchImagesFromStorage's partial-set throw for an expired assessment.
    if (session.images_purged_at) {
      return NextResponse.json(
        { error: 'The photos for this assessment have expired — they are kept for 24 hours. Please start a new assessment.', expired: true },
        { status: 410 }
      );
    }

    if (!promoToken) {
      const sessionUpdate = { status: 'processing' };
      if (stripeSessionId) sessionUpdate.stripe_session_id = stripeSessionId;
      const { error: sessionWriteError } = await supabase.from('salvage_sessions').update(sessionUpdate).eq('id', salvageId);
      if (sessionWriteError) {
        console.error(`[STRIPE SESSION WRITE FAILED] salvageId=${salvageId} error=${JSON.stringify(sessionWriteError)}`);
      }
    }

    const vd = session.vehicle_details || {};
    const market = session.market || 'GB';
    const roiTier = vd.roiTier || 'roi_free';

    // Fetch images once; feed Haiku, Opus, and lamp detection from the same array.
    // Fails loudly if any image is missing — a partial set degrades the assessment invisibly.
    let images;
    try {
      if (session.image_paths?.length) {
        images = await fetchImagesFromStorage(supabase, session.image_paths);
      } else if (session.images?.length) {
        images = session.images; // legacy sessions stored base64 directly
      } else {
        return NextResponse.json({ error: 'No images found for this session' }, { status: 400 });
      }
    } catch (imgErr) {
      // Photos are retained for 24 hours (batch 39). A missing/partial set here means they were swept
      // — fetchImagesFromStorage throws rather than assess a partial set. Reach the customer with an
      // honest explanation, never a 500 and never a silent/partial assessment.
      console.warn('[ASSESS] image fetch failed (expired/swept?):', imgErr.message);
      return NextResponse.json(
        { error: 'The photos for this assessment have expired — they are kept for 24 hours. Please start a new assessment.', expired: true },
        { status: 410 }
      );
    }

    // === Pure assessment pipeline (extracted for the replay harness — Cowork §7/§8). The route
    // keeps the Stripe/persistence envelope; runAssessment computes the assessment from
    // (images + vehicle_details + market) with no DB writes, no Stripe, and no One-Auto billing of
    // its own (One Auto flows through withOneAutoCache, which the harness overrides). The body below
    // is unchanged — only wrapped — so the prod path stays byte-identical. ===
    let assessment, enrichedVd;
    try {
      ({ assessment, enrichedVd } = await runAssessment({ images, vd, market, roiTier }));
    } catch (pipelineErr) {
      if (!(pipelineErr instanceof AssessmentOverloadedError)) throw pipelineErr;
      // 529 overloaded — reset session status (as the generic catch would), refund, return 503.
      if (promoToken) {
        await supabase.from('salvage_sessions').update({ status: 'promo_redeemed' }).eq('id', salvageId).eq('status', 'processing');
      } else {
        await supabase.from('salvage_sessions').update({ status: 'failed' }).eq('id', salvageId).eq('status', 'processing');
      }
      let refundStatus = 'no_charge';
      let abortMessage = "Our servers are experiencing high demand right now and your assessment couldn't be completed. Please try again in a few minutes.";
      if (!promoToken && paymentIntentId == null) {
        // Charged session but paymentIntentId not captured — manual reconciliation needed
        refundStatus = 'refund_failed';
        abortMessage = "Our servers are experiencing high demand right now and your assessment couldn't be completed. We were unable to process your refund automatically — please contact support@motorquoter.app and we'll refund you straight away.";
      } else if (paymentIntentId && chargeAmount) {
        try {
          const stripeInst = new Stripe(process.env.STRIPE_SECRET_KEY);
          const refund = await stripeInst.refunds.create({ payment_intent: paymentIntentId, amount: chargeAmount });
          console.log(`[529 ABORT] refund issued refundId=${refund.id} paymentIntentId=${paymentIntentId} amount=${chargeAmount}`);
          refundStatus = 'refunded';
          abortMessage = "Our servers are experiencing high demand right now and your assessment couldn't be completed. Your payment has been automatically refunded and should return to your account within a few working days. Please try again in a few minutes.";
        } catch (refErr) {
          console.error(`[529 ABORT] refund FAILED paymentIntentId=${paymentIntentId}`, refErr.message);
          refundStatus = 'refund_failed';
          abortMessage = `Our servers are experiencing high demand right now and your assessment couldn't be completed. We were unable to process your refund automatically — please contact support@motorquoter.app and we'll refund you straight away. (Reference: ${paymentIntentId}).`;
        }
      }
      return NextResponse.json({
        aborted: true,
        reason: 'overloaded',
        refundStatus,
        message: abortMessage,
      }, { status: 503 });
    }

    // Render hint (Commit 4): copy the session's payment_kind onto the assessment so both surfaces
    // (web + PDF) can mark a free_report without a second query. Source of truth stays
    // salvage_sessions.payment_kind; this is a denormalised copy, like the other assessment._ stamps.
    assessment._payment_kind = session.payment_kind ?? null;

    await supabase
      .from('salvage_sessions')
      .update({ status: 'assessed', assessment, vehicle_details: enrichedVd })
      .eq('id', salvageId);

    return NextResponse.json({ assessment, vehicleDetails: enrichedVd, market, rerunCount: 0, bregoData: enrichedVd.bregoValuation ?? null });

  } catch (err) {
    console.error('Salvage assess error:', err);
    if (promoToken) {
      // Promo: reset to promo_redeemed so the token remains usable for a retry.
      await supabase
        .from('salvage_sessions')
        .update({ status: 'promo_redeemed' })
        .eq('id', salvageId)
        .eq('status', 'processing');
    } else {
      // Non-promo: reset to 'failed' so the client can retry without hitting the
      // CB4 staleness window. Hard kills (maxDuration) bypass this catch and still
      // need CB4 as a backstop — they leave the session 'processing' until detected stale.
      await supabase
        .from('salvage_sessions')
        .update({ status: 'failed' })
        .eq('id', salvageId)
        .eq('status', 'processing');
    }
    return NextResponse.json({ error: err.message || 'Assessment failed' }, { status: 500 });
  }
}

// ============================================================================================
// runAssessment — the pure assessment pipeline. No Stripe, no DB writes, no One-Auto billing of its
// own; the paid One Auto calls flow through withOneAutoCache (which the replay harness overrides
// with stored fixtures). Shared by the GET route above and scripts/replay.mjs. Returns
// { assessment, enrichedVd }. Interior throws propagate to the route's catch (status reset);
// AssessmentOverloadedError is caught by the route for the 529 refund/503 path. (Cowork §7/§8.)
// ============================================================================================
export async function runAssessment({ images, vd, market, roiTier }) {

    // Per-view assess calls fire here in parallel with the main call.
    // Grouping + amalgamate run inline after parseParts so the main-call part names
    // can anchor the grouping canonical names (name-seam fix).
    let _pvExhaustedCount = 0;
    const _exhaustedCalls = new Set();
    // Per-view cache write-storm fix: every view carries the IDENTICAL PER_VIEW_PROMPT
    // cached system block (3909 tokens). Firing all 24 concurrently means none can read a
    // cache that hasn't been written yet → ~23 redundant cache WRITES (1.25x) of the same
    // prompt. Sequence ONE view first so it WRITES the cache, then fan out the remaining
    // views so they READ it (0.1x). Dispatch timing ONLY — every view still runs, results
    // are collected in image order, and the fired/landed (_pvExhaustedCount/_exhaustedCalls)
    // accounting is unchanged.
    const _fireView = (img, i) =>
      runPerViewAssess(img, i, () => { _pvExhaustedCount++; _exhaustedCalls.add(`per-view-${i}`); });
    const perViewResultsPromise = images.length === 0
      ? Promise.resolve([])
      : (async () => {
          const first = await _fireView(images[0], 0);                                  // cache WRITE
          const rest  = await Promise.all(images.slice(1).map((img, j) => _fireView(img, j + 1))); // cache READs
          return [first, ...rest];
        })();

    // Frame-zone classification — always-run (supersedes the on-demand sticker frame-ID). Fires in
    // parallel with the per-view fan-out; resolved once after amalgamate (below), consumed by the
    // sticker retry (windscreenLabel frames) and — commit 2 — the attribution probe (aspect zones).
    const frameZonePromise = runFrameZoneId(images, () => _exhaustedCalls.add('frame-zone'));

    const enrichedVd = normaliseLot(vd);

    // Fetch ROI vehicle data for paid tiers
    let roiData = null;
    if (market === 'IE' && roiTier !== 'roi_free' && enrichedVd.vrm) {
      const oneAutoBase = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
      const oneAutoKey = process.env.ONE_AUTO_API_KEY;
      const cleanVrm = enrichedVd.vrm.replace(/\s+/g, '').toUpperCase();

      roiData = {};
      const isPro = ['roi_pro', 'roi_history'].includes(roiTier);
      const isHistory = roiTier === 'roi_history';

      const [bregoResult, demandResult, cpgResult, hpiResult] = await Promise.all([
        withOneAutoCache('BREGO_ROI', cleanVrm, async () => {
          const r = await fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          if (!raw) return null;
          const result = raw?.success === true ? (raw.result ?? raw) : (raw?.result ?? null);
          return (result && !result.error) ? result : null;
        }),
        withOneAutoCache('MARKETDEMAND', cleanVrm, async () => {
          const r = await fetch(`${oneAutoBase}/percayso/marketdemandfromvrm/?vrm=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? (raw?.success ? raw : null);
          return (result && !result.error) ? result : null;
        }),
        isPro
          ? withOneAutoCache('PRICEGUIDE', cleanVrm, async () => {
              const r = await fetch(`${oneAutoBase}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
              const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
              const result = raw?.result ?? raw;
              return (result && !result.error) ? result : null;
            })
          : Promise.resolve(null),
        isHistory
          ? withOneAutoCache('HPICHECK', cleanVrm, async () => {
              const r = await fetch(`${oneAutoBase}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
              const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
              const result = raw?.result ?? raw;
              return (result && !result.error) ? result : null;
            })
          : Promise.resolve(null),
      ]);

      if (bregoResult) roiData.valuation = bregoResult;
      if (demandResult) roiData.marketDemand = demandResult;
      if (isPro && cpgResult) roiData.priceGuide = cpgResult;
      if (isHistory && hpiResult) roiData.historyCheck = hpiResult;
    }

    if (roiData) enrichedVd.roiData = roiData;

    // Pre-extraction pass (#62): Haiku reads dashboard odometer before Brego valuation
    let photoOdometer = null;
    try {
      const preExtractBlocks = await Promise.all(images.map(resizeToHaikuSafe));
      const { res: haikuRes, exhausted: haikuOdoExhausted } = await with529Retry('haiku-odo', () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODELS.assessLightDated,
          max_tokens: 200,
          system: 'Read the vehicle\'s dashboard/odometer from these auction photos. Respond with ONLY the total mileage as a bare integer — no words, no markdown, no explanation, no units. Example valid responses: 131828 or 87450. If no odometer is clearly readable in any photo, respond with exactly one word: null. Do not write anything else.',
          messages: [{ role: 'user', content: preExtractBlocks }],
        }),
      }));
      if (!haikuOdoExhausted && haikuRes?.ok) {
        const haikuData = await haikuRes.json();
        const raw = (haikuData.content?.[0]?.text || '').trim();
        const nums = (raw.replace(/,/g, '').match(/\d+/g) || [])
          .map(n => parseInt(n, 10))
          .filter(n => n >= 1 && n <= 999999);
        const uniq = [...new Set(nums)];
        // batch 75 §2b — CROSS-CHECK, don't discard. A cluster shot routinely shows odometer AND trip
        // AND range; the old `uniq.length === 1 ? uniq[0] : NaN` threw a legible reading away whenever a
        // second number appeared, silently falling back to the listing. Per assessmentEngine.js:24 the
        // photo is the CROSS-CHECK, not the valuation basis — so confirm or diverge, never silently drop:
        //   • exactly one number                     → use it (unchanged)
        //   • several, exactly ONE ≈ listing (±tol)   → that IS the odometer, the rest were trip/range
        //   • several, none (or >1) ≈ listing         → real divergence → §24 flag; photoOdometer stays null
        //   • none                                    → fall back to listing (unchanged)
        const listedForCheck = (() => {
          const r = enrichedVd.copartListedMileage ?? enrichedVd.odometer;
          if (r == null) return NaN;
          const m = String(r).replace(/,/g, '').match(/\d+/);
          return m ? parseInt(m[0], 10) : NaN;
        })();
        const odoDecision = resolvePhotoOdometerReading(uniq, listedForCheck);
        if (odoDecision.value !== null) {
          photoOdometer = odoDecision.value;
          if (uniq.length > 1) console.log(`[HAIKU ODO] multi-number ${JSON.stringify(uniq)} — one ≈ listing ${listedForCheck} → confirmed ${photoOdometer}`);
        } else if (odoDecision.diverged) {
          // Divergence — do NOT set photoOdometer (valuation anchors on the listing); raise the §24
          // divergence flag rather than silently discard the reading.
          enrichedVd.photoMileageFlag = `Dash photo appears to show ${uniq.map(n => n.toLocaleString()).join(' / ')} miles; listing shows ${listedForCheck.toLocaleString()} miles — photo legibility is limited, verify before bidding.`;
          console.log(`[HAIKU ODO] multi-number ${JSON.stringify(uniq)} — none/ambiguous ≈ listing ${listedForCheck} → divergence flagged, photoOdometer null`);
        }
        // else: no numbers, or multi-number with no listing to check → photoOdometer stays null.
      }
      // exhausted or non-2xx: photoOdometer stays null, downstream hierarchy takes over
    } catch { /* Haiku threw — photoOdometer stays null */ }

    // Sanity-check photo read against last DVSA MOT mileage (valuation hygiene only).
    // Must run before photoMileageFlag so a nulled-out read doesn't produce a misleading flag.
    if (photoOdometer !== null) {
      const lastMot = parseInt(String(enrichedVd.lastMotMileage || '').replace(/,/g, ''), 10);
      if (lastMot >= 1 && photoOdometer < lastMot) {
        const gap = lastMot - photoOdometer;
        console.log(`[HAIKU ODO SANITY] photo ${photoOdometer} < last MOT ${lastMot}, gap ${gap}, falling back`);
        photoOdometer = null;
      }
      // If lastMot is missing/0/unparseable: no baseline — keep photoOdometer as-is
    }

    if (photoOdometer !== null) {
      const listedRaw = enrichedVd.copartListedMileage ?? enrichedVd.odometer;
      const listedMileage = listedRaw != null
        ? (() => { const m = String(listedRaw).replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN; })()
        : NaN;
      if (!isNaN(listedMileage) && listedMileage >= 1) {
        const diff = Math.abs(photoOdometer - listedMileage);
        if (diff > 3000) {
          enrichedVd.photoMileageFlag = `Photo odometer reads ${photoOdometer.toLocaleString()} miles; listing shows ${listedMileage.toLocaleString()} miles — discrepancy of ${diff.toLocaleString()} miles. Verify before bidding.`;
        }
      }
    }

    // Determine mileage for Brego valuation
    const { mileage: brMileage, source: brMileageSource, ageYears: brAgeYears } = getMileageForValuation({
      photoOdometer,
      formMileage: enrichedVd.copartListedMileage ?? null,
      listingOdometer: enrichedVd.odometer ?? null,
      dvsaMileage: enrichedVd.lastMotMileage ?? null,
      vehicleYear: enrichedVd.year ?? null,
    });
    if (brMileageSource === 'age_anomaly') {
      console.log(`[MILEAGE ANOMALY] vrm=${enrichedVd.vrm || 'unknown'} year=${enrichedVd.year || '?'} age=${brAgeYears ?? '?'}yr no listing/photo/DVSA mileage available, estimating ${brMileage} miles from age`);
    }

    // Fetch salvage history + Brego valuation in parallel (GB/NI only)
    let bregoData = null;
    if (market !== 'IE' && enrichedVd.vrm) {
      const oneAutoBase = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
      const cleanVrmB = enrichedVd.vrm.replace(/\s+/g, '').toUpperCase();
      const hdrs = { 'x-api-key': process.env.ONE_AUTO_API_KEY };

      const [shResult, brResult, sgResult] = await Promise.all([
        withOneAutoCache('SALVAGEHISTORY', cleanVrmB, async () => {
          const r = await fetch(`${oneAutoBase}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrmB}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
        // Finding 7: current_mileage varies the valuation → it must be in the cache key.
        withOneAutoCache('BREGO_GB', cleanVrmB, { current_mileage: brMileage }, async () => {
          const r = await fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrmB}&current_mileage=${brMileage}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
        // SalvageGuide Bid Predictor — labelled market cross-check. Data-layer only; salvage_category
        // is a DATA param (never enters the model's context — category-blindness is unaffected).
        // Fail-safe: any error / missing category / no numbers → null → the block is simply omitted.
        // D1 (batch 87 §2): primary_damage_desc REMOVED — the Copart damage descriptor is inadmissible
        // (wrong in both directions across the corpus; on SF69YBB the string sent was literally "Unknown").
        // salvage_category / current_mileage remain and still vary the prediction, so both stay in the
        // cache key. Dropping the desc param CHANGES the key → existing SALVAGEGUIDE cache entries are
        // invalidated, which is correct: they were computed on inadmissible input.
        (() => {
          const sgCat = catLetter(enrichedVd.category)?.toUpperCase();
          const sgMileage = Number.isFinite(Number(brMileage)) ? String(Math.round(brMileage)) : undefined;
          return withOneAutoCache(
            'SALVAGEGUIDE', cleanVrmB,
            { salvage_category: sgCat, current_mileage: sgMileage },
            async () => {
              if (!sgCat) return null; // category required by the endpoint; skip cleanly if absent
              const p = new URLSearchParams({ vehicle_registration_mark: cleanVrmB, salvage_category: sgCat });
              if (sgMileage) p.set('current_mileage', sgMileage);
              const r = await fetch(`${oneAutoBase}/salvageguide/bidpredictionfromvrm/?${p.toString()}`, { headers: hdrs });
              const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
              const result = raw?.result ?? raw;
              return (result && !result.error) ? result : null;
            }
          );
        })(),
      ]);

      if (shResult) {
        tagSelfReference(shResult, enrichedVd);
        enrichedVd.salvageHistory = shResult;
      }

      if (brResult) {
        bregoData = { ...brResult, _mileageSource: brMileageSource, _mileageUsed: brMileage };
        enrichedVd.bregoValuation = bregoData;
      }

      if (sgResult) enrichedVd.salvageGuide = sgResult;
    }

    // ── Body-class resolution (Stage 5) ───────────────────────────────────────
    // Runs after Brego resolves so vehicle_desc is available as tier-1 source.
    // typeApproval null (pre-Part-1 sessions) → bodyClassResult.bodyClass === null → no enforcement.
    const bodyClassResult = resolveBodyClass(
      enrichedVd.typeApproval,
      enrichedVd.bregoValuation?.vehicle_desc,
      enrichedVd.bodyStyle,
    );
    console.log(`[BODY_CLASS] typeApproval=${enrichedVd.typeApproval ?? 'absent'} bodyClass=${bodyClassResult.bodyClass} source=${bodyClassResult.source} conflict=${bodyClassResult.conflict}${bodyClassResult.conflictDetail ? ` detail="${bodyClassResult.conflictDetail}"` : ''}`);

    if (bodyClassResult.bodyClass === 'UNRESOLVED') {
      // N1 sub-class unresolvable — reset session so the call is retryable, then reject.
      // Throw routes through the outer catch which handles promo/non-promo status reset.
      const errMsg = bodyClassResult.conflict
        ? `Body type conflict — automated sources disagree on vehicle sub-type (${bodyClassResult.conflictDetail}). Please verify the vehicle type and re-submit.`
        : 'Vehicle type could not be confirmed — this N1 vehicle requires body type selection (van, pickup, or specialist body) before assessment. Please re-submit with body type selected.';
      throw new Error(errMsg);
    }

    const AUCTION_SOURCE_LABELS = {
      copart: 'Copart UK',
      iaa: 'IAA UK / SYNETIQ',
      bca: 'BCA',
      manheim: 'Manheim',
      other: 'Other / Private',
    };

    const auctionSource = enrichedVd.auctionSource || 'copart';

    const feeRef = null; // fees/margins are code-computed; model no longer calls computeCopartFees

    const contextLines = [
      enrichedVd.vrm && `Registration: ${enrichedVd.vrm}`,
      enrichedVd.make && `Make: ${enrichedVd.make}`,
      enrichedVd.model && `Model: ${enrichedVd.model}`,
      enrichedVd.year && `Year: ${enrichedVd.year}`,
      enrichedVd.bodyStyle && `Body Style (from listing): ${enrichedVd.bodyStyle}`,
      enrichedVd.lotNumber && `Copart Lot Number: ${enrichedVd.lotNumber}`,
      // batch 73 (3b): the Copart DAMAGE LABEL FAMILY (damageDescription / primary / secondary /
      // additional) is deliberately WITHHELD from the perception context. These fields are a member of
      // auction staff's classification of the damage, not an observation — and run 1 vs run 4 (EN23NJX)
      // proved the model treats the label as evidence and fabricates damage to match it. The engine must
      // report what it SEES. enrichedVd is untouched, so frontStruck/rearStruck below still force
      // recordImpactObservation (nulling the fields at source would un-force the tool — NOT the fix).
      // The label is shown to the BUYER code-side, after both model calls (see §7 injection below).
      enrichedVd.dvlaVerified && `DVLA Verified: Yes — vehicle identity confirmed against DVLA database`,
      enrichedVd.colour && `DVLA Colour: ${enrichedVd.colour}`,
      enrichedVd.fuelType && `DVLA Fuel Type: ${enrichedVd.fuelType}`,
      enrichedVd.taxStatus && `Tax Status: ${enrichedVd.taxStatus}`,
      enrichedVd.motStatus && `MOT Status: ${enrichedVd.motStatus}`,
      // "Recorded" dropped: lastMotMileage is normalised at source (data.motMileage), so for a km car
      // this is no longer the RECORDED figure — the word would make the prompt assert something false.
      enrichedVd.lastMotMileage && `Last MOT Mileage: ${enrichedVd.lastMotMileage} miles`,
      (() => {
        const mh = enrichedVd.motHistory;
        if (!Array.isArray(mh) || mh.length === 0) return null;
        const lines = mh.slice(0, 15).map(t => {
          const result  = (t.testResult || '').toUpperCase() === 'PASSED' ? 'PASS' : 'FAIL';
          // Feed the model NORMALISED miles — a raw km reading labelled "mi" makes it read a unit
          // switch as a rollback. Keep the km original explicit (genuine import/NI signal), never silent.
          const odo = formatOdometerCompact(t);
          const remarks = (t.defects || [])
            .slice(0, 4)
            .map(d => `${(d.type || 'ADVISORY').toUpperCase()}: ${(d.text || '').slice(0, 60)}`)
            .join('; ');
          return [t.completedDate, result, odo, remarks ? `[${remarks}]` : ''].filter(Boolean).join(' ');
        });
        return `DVSA MOT History (most recent first):\n${lines.join('\n')}`;
      })(),
      enrichedVd.motMileageFlag && `MILEAGE DISCREPANCY FLAG: ${enrichedVd.motMileageFlag}`,
      enrichedVd.photoMileageFlag && `PHOTO MILEAGE DISCREPANCY: ${enrichedVd.photoMileageFlag}`,
      `Market: ${market}`,
      market === 'IE' && enrichedVd.motStatus && `NCT Status: ${enrichedVd.motStatus}`,
      market === 'IE' && enrichedVd.motExpiryDate && `NCT Expiry: ${enrichedVd.motExpiryDate}`,
      market === 'IE' && enrichedVd.monthOfFirstRegistration && `First Registered in Ireland: ${enrichedVd.monthOfFirstRegistration}`,
      market === 'IE' && roiData?.valuation?.current?.retail && `Current Retail Valuation (IE): €${roiData.valuation.current.retail}`,
      market === 'IE' && roiData?.valuation?.future?.retail && `Future Retail Valuation (IE): €${roiData.valuation.future.retail}`,
      auctionSource !== 'copart' && `Auction Source: ${AUCTION_SOURCE_LABELS[auctionSource] || auctionSource}`,
      feeRef,
      enrichedVd.vatOnSale && `VAT on Sale: ${enrichedVd.vatOnSale}`,
      enrichedVd.runCondition && `Run Condition: ${enrichedVd.runCondition}`,
      enrichedVd.keys && `Keys: ${enrichedVd.keys}`,
      enrichedVd.transmission && `Transmission: ${enrichedVd.transmission}`,
      // batch 73 (3b): primaryDamage / secondaryDamage / additionalDamage WITHHELD from perception —
      // see the damage-label-family note above. Withheld as a FAMILY: on another lot the staff guess
      // lands in a different field, so removing only the populated one would not hold.
      enrichedVd.v5Status && `V5 Status: ${enrichedVd.v5Status}`,
      (() => {
        const sh = enrichedVd.salvageHistory;
        if (!sh) return null;
        const found = sh.salvage_auction_record_found === true;
        const records = sh.salvage_auction_records || [];
        // §2b (Vincent, 29 Aug): NEUTRAL heading. The old "Previous Salvage Auction History" pre-judged
        // every record as a PRIOR event — false on a lot whose only register record is its own current
        // entry (DL72FVX), and the model wrote about a prior because the heading told it there was one.
        // We do NOT replace it with the opposite assertion either: the code establishes the record
        // carries this lot's number, it does not PROVE the record is this listing's own entry (rests on
        // the untested one-lot-one-record assumption). So the heading names ONLY what the register
        // returned and takes no position; the buyer-facing count still does (buildSalvageCountSlot).
        if (!found) return 'Salvage auction register: no records returned for this vehicle.';
        // §2a (Ruling 1, 28 Aug): Primary/Secondary Damage descriptors are withheld from perception —
        // they are Copart staff free-text (the damage-label family, batch 73) and re-enter the model's
        // eyes through this door. Lot date and mileage stay. The buyer keeps the label code-side (§7).
        const lines = records.map((rec, i) => [
          `Record ${i + 1}:`,
          rec.salvage_auction_lot_date && `  Lot Date: ${rec.salvage_auction_lot_date}`,
          rec.mileage != null          && `  Mileage at Sale: ${Number(rec.mileage).toLocaleString()} miles`,
        ].filter(Boolean).join('\n')).join('\n');
        return `Salvage auction register records for this vehicle (${records.length} found):\n${lines}`;
      })(),
      (() => {
        if (!bregoData) return 'Live market valuation data: UNAVAILABLE — proceed with assessment but flag exit value as low confidence.';
        const fmt = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : 'N/A';
        const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
        // Map new source codes to strings the engine's mileage-source rules already know
        const engineSrc = brMileageSource === 'listing_odometer' ? 'copart_listed'
          : (brMileageSource === 'age_estimate' || brMileageSource === 'age_anomaly') ? 'default_fallback'
          : brMileageSource;
        const lines = [
          `Live market valuation data (${monthYear}):`,
          `- Retail low (poor condition): ${fmt(bregoData.retail_low_valuation)}`,
          `- Retail average (average condition): ${fmt(bregoData.retail_average_valuation)}`,
          `- Retail high (excellent condition): ${fmt(bregoData.retail_high_valuation)}`,
          `- Trade low (poor condition): ${fmt(bregoData.trade_low_valuation)}`,
          `- Trade average (average condition): ${fmt(bregoData.trade_average_valuation)}`,
          `- Trade high (excellent condition): ${fmt(bregoData.trade_high_valuation)}`,
          bregoData.vehicle_desc ? `- Vehicle: ${bregoData.vehicle_desc}` : null,
          `- Mileage used for valuation: ${bregoData._mileageUsed} miles`,
          `- Mileage source: ${engineSrc}`,
        ];
        if (brMileageSource === 'age_estimate') {
          lines.push(`⚠️ MILEAGE ESTIMATE — MUST FLAG IN REPORT: No actual mileage was available from the listing, dashboard photos, or DVSA. The valuation mileage of ${Number(bregoData._mileageUsed).toLocaleString()} miles is estimated from vehicle age only. Label it as "ESTIMATED from age — actual mileage NOT confirmed". State that the valuation, exit value, and margin all depend on this unverified figure. Add a "Confirm actual mileage before bidding" item to the WhatsApp checklist. Reduce Confidence Level by one tier.`);
        }
        if (brMileageSource === 'age_anomaly') {
          lines.push(`⚠️ MILEAGE ANOMALY — MUST FLAG IN REPORT: The vehicle is over 4 years old but no mileage data could be retrieved from the listing, dashboard photos, or DVSA. The figure of ${Number(bregoData._mileageUsed).toLocaleString()} miles is a rough age-based estimate and is highly uncertain. State explicitly in the report that no mileage data was available, the valuation is unreliable without confirmed mileage, and the buyer MUST verify actual mileage before bidding. Set Confidence Level: Low.`);
        }
        return lines.filter(Boolean).join('\n');
      })(),
    ].filter(Boolean).join('\n');

    const imageBlocks = images
      .map((img, i) => {
        let mediaType = 'image/jpeg';
        let data = img;
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) { mediaType = match[1]; data = match[2]; }
        const block = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
        return block;
      });

    const userContent = [
      ...imageBlocks,
      {
        type: 'text',
        text: `Please assess this vehicle for auction bidding purposes.\n\nVehicle Details:\n${contextLines}\n\nAnalyse all provided photos and give a complete assessment using the required output format. After the Margin Calculation field, include a "WhatsApp Inspection Checklist:" section with at minimum 5 specific items tailored to this vehicle's damage profile, selected and expanded from the standard checklist items in your knowledge base. When describing wheel or tyre damage in the Visible Damage Summary, if the affected corner cannot be confidently identified from the photos, hedge the description (e.g. "one or both front tyres" or "front tyre — corner uncertain") rather than asserting a specific corner with false confidence.`,
      },
    ];

    // ── §4 (batch 80) DEV SEAM — dump the assembled Call-1 prompt. £0, vision-free, dev-only ────────
    // When MQ_DUMP_CALL1_PROMPT is set, write the fully-assembled Call-1 user text (Vehicle Details
    // incl. the salvage-history block) to a file and log a one-liner. This is the only way to OBSERVE —
    // not reconstruct — that §2a/§2b landed in the bytes the model receives (closes batch 77 §1), and
    // it hands over the byte-exact salvage-history block batch 78 could not reach at £0. It dumps the
    // string that is ABOUT to be sent — nothing goes to any API here — and never fires in production
    // (no env var). MQ_DUMP_CALL1_PROMPT=1 → default filename; any other value → that path.
    if (process.env.MQ_DUMP_CALL1_PROMPT) {
      try {
        const _dumpText = userContent.find(b => b.type === 'text')?.text ?? '';
        const _dumpPath = process.env.MQ_DUMP_CALL1_PROMPT === '1'
          ? `call1-prompt-${enrichedVd.vrm || 'lot'}.txt`
          : process.env.MQ_DUMP_CALL1_PROMPT;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(_dumpPath, _dumpText, 'utf8');
        console.log(`[CALL1 DUMP] assembled Call-1 prompt (${_dumpText.length} chars, ${imageBlocks.length} images) → ${_dumpPath}`);
      } catch (e) {
        console.warn(`[CALL1 DUMP] failed: ${e.message}`);
      }
    }

    const LAMP_OBS_TOOL = {
      name: 'recordImpactObservation',
      description: 'Call exactly once on any impact lot (front or rear damage), before writing your assessment. Pass your plate-anchor side determination, bumper displacement and removal-mode observations, and damage span. After calling, include each implicated front headlamp as a separate Parts Breakdown line. The engine reconciles costs to the authoritative band — do NOT pre-adjust your repair figure. Do not write lamp commentary outside the Parts Breakdown lines.',
      input_schema: {
        type: 'object',
        properties: {
          struckSide: {
            type: 'string',
            enum: ['offside', 'nearside', 'central'],
            description: 'Struck side from plate-relative-to-lights internal reasoning. Use "central" if side is not confidently determinable.',
          },
          apertureExposed: {
            type: 'boolean',
            description: 'True if the front bumper is visibly displaced or removed on the struck corner, exposing the front-wing-to-bumper seam or the lamp mounting recess. Set on lots with front bumper displacement; omit or set false if the front bumper is intact. Assess the front and rear apertures INDEPENDENTLY — a front-primary impact does not mean the rear bumper is intact.',
          },
          damageSpan: {
            type: 'string',
            enum: ['single_corner', 'full_width'],
            description: 'Structural extent of damage across the front. single_corner: damage confined to one side (one wing, one bumper corner). full_width: damage spans the full front width — bonnet crumpled, slam panel or front panel affected, both front corners involved. Judge from structural damage footprint (bonnet, slam panel, wing, bumper reach), NOT from lamp absence or presence.',
          },
          rearApertureExposed: {
            type: 'boolean',
            description: 'True if the rear bumper is torn away or displaced from the body on the struck corner, exposing the rear-quarter-to-bumper seam or fold. Set on lots with rear bumper displacement; omit or set false if the rear bumper is intact. Assess this INDEPENDENTLY of the front — set it whenever the rear bumper is displaced, even if the primary impact is at the front.',
          },
        },
        required: ['struckSide', 'apertureExposed', 'damageSpan'],
      },
    };

    // frontStruck / rearStruck are STILL descriptor-derived and STILL inadmissible under D1 — but they
    // are retained here ONLY for the two non-lamp consumers the batch-89 ruling explicitly left in place:
    // the sticky-rescue struck-zone seed (:4281-4282) and the _struckZones flag-suppression set
    // (:4878-4879). Vincent rules on those two in a later batch; do not wire them into the lamp path.
    const frontStruck    = /front/i.test(enrichedVd.primaryDamage || '') || /front/i.test(enrichedVd.secondaryDamage || '');
    const rearStruck     = /rear/i.test(enrichedVd.primaryDamage  || '') || /rear/i.test(enrichedVd.secondaryDamage  || '');

    // Call 1 tools: LAMP_OBS_TOOL always offered AND forced on iter 0 for EVERY lot (batch 89 — the
    // headlamp check runs on every car; the descriptor-derived hasImpactZone force-gate is deleted).
    // A costed lamp line still requires apertureExposed===true downstream (computeLampResult:2392), so a
    // non-impact lot with an intact bumper produces a tier-1 £0 observation, not a phantom cost.
    const claudeTools = [LAMP_OBS_TOOL];
    const messages = [{ role: 'user', content: userContent }];
    let lampObs = null;
    let lampObsSource = null;
    let coreObs = null;
    let rawText = '';

    // Fire lamp detection on EVERY lot, in parallel with the Claude assess call (batch 89 — Vincent:
    // run the headlamp check on every car). The old frontStruck gate was descriptor-derived (D1) and
    // is deleted with no replacement — deleting it removes an owner, it does not add a rule. A costed
    // lamp line still requires apertureExposed===true (computeLampResult:2392), so a non-impact lot with
    // an intact bumper reads tier-1 £0; the phantom risk §1 accepts is a lamp costed only where the model
    // asserts an exposed aperture.
    const lampDetectionPromise = runLampDetection(images, () => _exhaustedCalls.add('lamp-detect'));
    // Fire dash cluster read on ALL lots (not gated on isBev or frontStruck) — joins in post-call region
    const dashReadPromise = runDashClusterRead(images, () => _exhaustedCalls.add('dash-read'), enrichedVd.bregoValuation?.vehicle_desc || null);

    // raw per-view ledger assembled pre-main-call (Step 4a) — finalisation (aperture/bumper-off) still applies post-call
    const perViewResults = await perViewResultsPromise;

    // Survivor-count diagnostic — coarse health signal (not the billing gate)
    const viewsFired  = images.length;
    const viewsLanded = perViewResults.filter(r => r.costedParts.length > 0 || r.hvLabelSeen).length;
    console.log(`[PER-VIEW] fired=${viewsFired} landed≈${viewsLanded}`);

    const hvLabelSeen    = perViewResults.some(r => r.hvLabelSeen === true);
    console.log(`[HV] hvLabelSeen=${hvLabelSeen}`);
    const correspondenceMap = await runCorrespondencePass(perViewResults, images, () => _exhaustedCalls.add('correspondence'));
    console.log(`[G] correspondenceMap size=${correspondenceMap.size} panels=${[...correspondenceMap.keys()].join(',') || 'none'}`);
    const rawGroups         = groupByPanelId(perViewResults);
    const groups            = splitGroupsByInstance(rawGroups, correspondenceMap);
    const splitKeys         = groups.map(g => g._instanceKey).filter(Boolean);
    if (splitKeys.length > 0) console.log(`[G] split produced ${splitKeys.length} instance-group(s): ${splitKeys.join(', ')}`);
    // Per-view panel sets (view idx → Set of panelIds that view emitted). Feeds amalgamate's
    // silence-as-clean inference (option C): a view that imaged a rear neighbour but emitted no
    // REAR_PANEL line is an implicit-clean vote. Built from the raw per-view results.
    const viewPanelSets = new Map(
      perViewResults.map(r => [r.idx, new Set((r.costedParts || []).map(cp => cp.panelId).filter(Boolean))])
    );
    const pvResult          = amalgamate(groups, viewPanelSets);
    messages[0].content.push({ type: 'text', text: ledgerPreamble(pvResult) });

    // Resolve the always-run frame-zone pass once (fired at the per-view fan-out). By here per-view
    // is already awaited, so this single Haiku call is long done — a no-cost join before CALL1.
    // Consumed by the sticker retry (windscreenLabel) and, in commit 2, the attribution probe (zones).
    const _frameZones = await frameZonePromise; // { ok, frames:[{i,zones,windscreenLabel}] }

    const callClaude = async (withTools, forced = false) => {
      const body = JSON.stringify({
        model: MODELS.assessPrimary,
        max_tokens: 16000,
        system: [{ type: 'text', text: ASSESSMENT_ENGINE_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages,
        ...(withTools && claudeTools.length > 0 ? {
          tools: claudeTools,
          ...(forced ? { tool_choice: { type: 'any' } } : {}),
        } : {}),
      });
      const { res, exhausted } = await with529Retry('call1', () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body,
      }));
      if (exhausted || !res) {
        if (exhausted) _exhaustedCalls.add('call1');
        return { res: null, data: null, exhausted: exhausted ?? false };
      }
      const data = await res.json();
      // Live infra-failure alert (throttled) — awaited before returning so it runs on Vercel
      // (post-response work is not guaranteed). The caller throws on !res.ok; the alert already ran.
      if (!res.ok && isInfraFailure(res.status, data)) {
        await sendOpsAlert('claude-assess', 'MotorQuoter: assess Claude call failing', `status ${res.status} — ${data?.error?.type || ''}: ${data?.error?.message || ''}. Model: ${MODELS.assessPrimary}. Likely retired/auth — check config/models.js.`);
      }
      return { res, data, exhausted: false };
    };

    // Tool-use loop — keep calling with tools while the model keeps recording observations,
    // then a final no-tools call forces the prose (mirrors the existing lamp two-call shape,
    // generalised so either/both forced tools can fire in one round or across several).
    // iter=0 on EVERY lot (batch 89): forced=true so the model MUST call
    // recordImpactObservation (tool_choice:{type:'any'}). iter>=1: forced=false — continuation
    // rounds have tool_result context and must be free to end_turn into prose naturally.
    const MAX_TOOL_ROUNDS = 4;
    for (let iter = 0; iter < MAX_TOOL_ROUNDS; iter++) {
      const { res: apiRes, data: apiData, exhausted: call1Exhausted } = await callClaude(true, iter === 0);
      if (call1Exhausted) break; // _exhaustedCalls.add('call1') already done inside callClaude
      if (!apiRes) throw new Error(`Claude API network error (call1 iter=${iter})`);
      console.log(`[TOKEN LOG] iter=${iter} Input:`, apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
      console.log(`[CACHE] iter=${iter} write=` + (apiData.usage?.cache_creation_input_tokens ?? 0) + ' read=' + (apiData.usage?.cache_read_input_tokens ?? 0) + ' input=' + (apiData.usage?.input_tokens ?? 0));
      if (!apiRes.ok) throw new Error(apiData.error?.message || `Claude API error (iter ${iter})`);

      const content = apiData.content || [];

      if (apiData.stop_reason !== 'tool_use') {
        if (apiData.stop_reason === 'max_tokens') throw new Error(`[MAX_TOKENS] main assess call truncated at iter=${iter} — response ceiling hit`);
        if (apiData.stop_reason === 'refusal')   throw new Error(`[REFUSAL] main assess call refused at iter=${iter} — content policy`);
        rawText = content.filter(c => c.type === 'text').map(c => c.text).join('');
        break;
      }

      const toolResults = content
        .filter(c => c.type === 'tool_use')
        .map(block => {
          if (block.name === 'recordImpactObservation') {
            const _side = normaliseImpactField(block.input?.struckSide, STRUCK_SIDE_ENUM, 'central');
            const _span = normaliseImpactField(block.input?.damageSpan, DAMAGE_SPAN_ENUM, 'full_width');
            lampObs = {
              struckSide:          _side.value,
              apertureExposed:     Boolean(block.input?.apertureExposed),
              damageSpan:          _span.value,
              rearApertureExposed: block.input?.rearApertureExposed === true,
              _sideDefaulted: _side.defaulted, _sideRejected: _side.rejected,
              _spanDefaulted: _span.defaulted, _spanRejected: _span.rejected,
            };
            lampObsSource = (iter === 0) ? 'listing-forced' : 'voluntary-iter0'; // batch 89: tool forced on iter 0 for every lot
            if (_side.defaulted) console.log(`[IMPACT OBS][DEFAULT] struckSide ${_side.rejected != null ? `invalid "${_side.rejected}"` : 'absent'} → central (neutral default — C2, inert for rear)`);
            if (_span.defaulted) console.log(`[IMPACT OBS][DEFAULT] damageSpan ${_span.rejected != null ? `invalid "${_span.rejected}"` : 'absent'} → full_width (over-warn ruling 08Jul)`);
            console.log(`[IMPACT OBS] recordImpactObservation: struckSide=${lampObs.struckSide} apertureExposed=${lampObs.apertureExposed} rearApertureExposed=${lampObs.rearApertureExposed} damageSpan=${lampObs.damageSpan}`);
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ recorded: true }) };
          }
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Unknown tool' }) };
        });

      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Force the prose if the loop ended without text (e.g. the model was still mid tool-use
    // when MAX_TOOL_ROUNDS was hit) — final call with no tools available, same as the existing
    // lamp flow's second call.
    if (!rawText && !_exhaustedCalls.has('call1')) {
      const { res: finalRes, data: finalData, exhausted: finalExhausted } = await callClaude(false);
      if (!finalExhausted) {
        if (!finalRes) throw new Error('Claude API network error (call1-final)');
        console.log('[TOKEN LOG] iter=final Input:', finalData.usage?.input_tokens, '| Output:', finalData.usage?.output_tokens, '| Stop:', finalData.stop_reason, '| Model:', finalData.model || 'unknown');
        console.log('[CACHE] iter=final write=' + (finalData.usage?.cache_creation_input_tokens ?? 0) + ' read=' + (finalData.usage?.cache_read_input_tokens ?? 0) + ' input=' + (finalData.usage?.input_tokens ?? 0));
        if (!finalRes.ok) throw new Error(finalData.error?.message || 'Claude API error (final)');
        if (finalData.stop_reason === 'max_tokens') throw new Error('[MAX_TOKENS] main assess call truncated (final) — response ceiling hit');
        if (finalData.stop_reason === 'refusal')   throw new Error('[REFUSAL] main assess call refused (final) — content policy');
        rawText = (finalData.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      }
    }

    // Call 2 — Haiku structured extraction from committed prose
    // Text-only (no images re-sent), forced tool_choice. Extracts provenance verdicts and
    // per-zone damage classification from Call-1 prose. windscreenSticker and bodyStyle are
    // now code-owned (dash-read vision + Brego vehicle_desc) — no longer extracted here.
    const CORE_EXTRACTION_TOOL = {
      name: 'recordCoreObservations',
      description: 'Extract two provenance-faithfulness verdicts and per-zone damage event classification from the assessment text below. Transcribe exactly what the assessment states — do not interpret, infer, or add anything beyond what is written.',
      input_schema: {
        type: 'object',
        properties: {
          provenanceConcernFlagged: {
            type: 'boolean',
            description: 'Set true ONLY if the assessment raises a SUBSTANTIVE concern about WHY this vehicle is in salvage or about the vendor entry channel — specifically one of: a non-insurer vendor suffix (Q- or C-suffix), a Copart re-entry / salvage-self-reference risk (the record may be a prior write-off re-entered rather than the current event), or explicit doubt that the described damage explains the write-off. DO NOT set true for any of these (they are NOT provenance concerns): generic "before bidding" / "resolve before any bid" / inspection-checklist language; partial-V5, documentation, or re-registration notes; mechanical, HV/EV, electrical, or warning-light fault concerns. Set false — the common case — if the assessment is silent on provenance, gives a clean provenance read, or only raises the non-provenance matters just listed. When you set true you MUST also fill provenanceConcernReason with the specific concern; if you cannot name a concrete one, set false. Default false when uncertain.',
          },
          provenanceConcernReason: {
            type: 'string',
            description: 'REQUIRED whenever provenanceConcernFlagged is true: a specific, substantive sentence naming the actual provenance concern — e.g. "Q-suffix non-insurer vendor entry on a structural write-off" or "single salvage record may be a prior write-off re-entered, not the current event". Empty string when provenanceConcernFlagged is false. If you cannot write a concrete why-in-salvage / vendor-channel reason, set provenanceConcernFlagged=false rather than writing a vague or boilerplate reason.',
          },
          salvageSelfReferenceConfirmed: {
            type: 'boolean',
            description: 'Set true ONLY if the assessment explicitly concludes that the single salvage history record found IS this lot\'s own current first write-off entry — i.e. the record is not a prior event. Set false if the assessment raises any prior salvage events as genuine concerns, is silent on the matter, or does not address this. Default false when uncertain.',
          },
          perZone: {
            type: 'array',
            description: 'One entry per damage zone the assessment identifies. Transcribe from the prose — do not infer zones not mentioned.',
            items: {
              type: 'object',
              properties: {
                zone: {
                  type: 'string',
                  enum: ['front', 'rear', 'flank-damaged-side', 'roof', 'underside', 'interior'],
                  description: 'Zone label from the fixed set. front/rear = frontal or rear impacts. flank-damaged-side = side/flank impact on the affected side. roof = overhead damage. underside = suspension/drivetrain/floor. interior = cockpit/cabin.',
                },
                eventType: {
                  type: 'string',
                  enum: ['impact', 'thermal', 'water', 'other-non-impact'],
                  description: 'Damage event type the assessment states for this zone.',
                },
                heightBand: {
                  type: ['string', 'null'],
                  enum: ['low', 'mid', 'high', 'indeterminate', null],
                  description: 'Strike height band. Populate ONLY when eventType is "impact" and the prose states a band. MUST be null for thermal/water/other-non-impact — absence is correct, not a failure.',
                },
              },
              required: ['zone', 'eventType', 'heightBand'],
            },
          },
          namedAsIntact: {
            type: 'array',
            description: 'Panels the assessment text EXPLICITLY describes as undamaged / intact / undisturbed / sound / clean. Transcribe ONLY panels the prose affirmatively calls sound — e.g. "the bonnet, grille and both headlamps read undamaged". Do NOT include a panel merely because it is unmentioned: silence is not intactness. Emit only the fixed tokens below. Empty array when the prose makes no affirmative soundness statement (the common case).',
            items: {
              type: 'string',
              enum: ['DOOR_MIRROR', 'FOG_LAMP', 'HEADLAMP', 'FRONT_WING', 'REAR_QUARTER', 'FRONT_DOOR', 'REAR_DOOR', 'SILL', 'BONNET', 'GRILLE'],
            },
          },
        },
        required: ['provenanceConcernFlagged', 'salvageSelfReferenceConfirmed', 'perZone'],
      },
    };

    const call2Start = Date.now();
    const { res: call2Res, exhausted: call2Exhausted } = await with529Retry('call2', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS.assessLight,
        max_tokens: 1024,
        tools: [CORE_EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: 'recordCoreObservations' },
        messages: [{
          role: 'user',
          content: `Extract provenance verdicts and per-zone damage classification from this vehicle assessment. Report only what the text explicitly states — do not interpret, infer, or add anything beyond what is written.\nFor provenanceConcernFlagged: set true ONLY if the text explicitly raises a concern about why the vehicle is in salvage or its vendor entry channel; false otherwise.\nFor salvageSelfReferenceConfirmed: set true ONLY if the text explicitly concludes the single salvage record is this lot's own current first write-off entry; false otherwise.\nFor perZone: one entry per damage zone mentioned in the prose; zone must be one of: front, rear, flank-damaged-side, roof, underside, interior; heightBand must be null for non-impact eventTypes.\nFor namedAsIntact: list ONLY panels the text affirmatively describes as undamaged/intact/undisturbed/sound/clean, using the fixed tokens. Do NOT list a panel just because it is unmentioned — silence is not intactness. Empty array if the prose makes no soundness statement.\n\n${rawText}`,
        }],
      }),
    }));
    let call2Data = null;
    if (call2Exhausted) {
      _exhaustedCalls.add('call2');
      console.error('[CALL2] 529-exhausted — coreObs floor default will fire');
    } else if (!call2Res?.ok) {
      console.error(`[CALL2] API error ${call2Res?.status}`);
      // Body only read in this !ok branch (no double-read). Live infra-failure alert, awaited.
      const call2Err = await call2Res?.json().catch(() => null);
      if (isInfraFailure(call2Res?.status, call2Err)) {
        await sendOpsAlert('claude-assess', 'MotorQuoter: assess (light classifier) Claude call failing', `status ${call2Res?.status} — ${call2Err?.error?.type || ''}: ${call2Err?.error?.message || ''}. Model: ${MODELS.assessLight}. Likely retired/auth — check config/models.js.`);
      }
    } else {
      call2Data = await call2Res.json();
    }
    const call2Latency = Date.now() - call2Start;
    if (call2Data) console.log(`[CALL2] stop_reason=${call2Data?.stop_reason} input=${call2Data.usage?.input_tokens} output=${call2Data.usage?.output_tokens} latency=${call2Latency}ms`);
    if (call2Data?.stop_reason === 'max_tokens') {
      console.error('[CALL2][TRUNCATED] stop_reason=max_tokens — extraction JSON cut mid-structure; perZone array may be incomplete or absent');
    }

    const call2ToolBlock = (call2Data?.content || []).find(b => b.type === 'tool_use' && b.name === 'recordCoreObservations');
    if (call2ToolBlock?.input) {
      console.log('[CALL2] raw tool_use input:', JSON.stringify(call2ToolBlock.input));
      const inp = call2ToolBlock.input;
      coreObs = {
        corners: [],
        proseFlags: {
          provenanceConcernFlagged:      typeof inp.provenanceConcernFlagged === 'boolean'      ? inp.provenanceConcernFlagged      : null,
          provenanceConcernReason:       (typeof inp.provenanceConcernReason === 'string' && inp.provenanceConcernReason.trim()) ? inp.provenanceConcernReason.trim() : null,
          salvageSelfReferenceConfirmed: typeof inp.salvageSelfReferenceConfirmed === 'boolean' ? inp.salvageSelfReferenceConfirmed : null,
        },
        perZone: Array.isArray(inp.perZone) ? inp.perZone : [],
        // batch 75 §1 — panels the prose EXPLICITLY calls sound; the completeness net (Fix A) excludes
        // these so it stops telling the buyer to inspect parts the engine just described as undamaged.
        // Absent/empty (older payload / parse failure) → [] → the net behaves EXACTLY as before.
        namedAsIntact: Array.isArray(inp.namedAsIntact) ? inp.namedAsIntact.filter(s => typeof s === 'string') : [],
      };
      console.log(`[CALL2] extracted provenanceConcernFlagged=${coreObs.proseFlags.provenanceConcernFlagged} provenanceConcernReason=${coreObs.proseFlags.provenanceConcernReason ? JSON.stringify(coreObs.proseFlags.provenanceConcernReason.slice(0, 100)) : 'none'} salvageSelfReferenceConfirmed=${coreObs.proseFlags.salvageSelfReferenceConfirmed} perZone=${coreObs.perZone.length} namedAsIntact=${coreObs.namedAsIntact.length}`);
    } else {
      console.error(`[CALL2] EXTRACTION FAILURE — no tool block returned despite forced tool_choice. stop_reason=${call2Data?.stop_reason ?? 'exhausted/error'} latency=${call2Latency}ms`);
      // coreObs floor default fires below
    }

    // Guarantee CORE observations — floor defaults if Call 2 failed to return a tool block.
    // windscreenSticker and bodyStyleMismatch are NOT in this floor — they are backfilled
    // from the vision dash-read (runDashClusterRead) after it awaits at line ~2498.
    if (!coreObs) {
      coreObs = {
        corners: [],
        proseFlags: { provenanceConcernFlagged: null, provenanceConcernReason: null, salvageSelfReferenceConfirmed: null },
        perZone:     [],
        namedAsIntact: [],
        costedParts: [],
        flaggedParts: [],
      };
      console.log('[CORE OBS] Call 2 extraction failed — honest-absence floor defaults applied; proseFlags=null perZone/costedParts/flaggedParts=[] (unavailable)');
    }

    // Join lamp detection (ran in parallel with Claude calls)
    const lampDetectionRaw = await lampDetectionPromise;
    const detectedCorner   = lampDetectionRaw ? selectStruckCornerVerdict(lampDetectionRaw) : null;
    console.log('[LAMP DETECT]', detectedCorner   // batch 89: lamp detection runs on every lot now
      ? `struck corner: verdict=${detectedCorner.verdict} lamp_type=${detectedCorner.lamp_type} evidence="${(detectedCorner.evidence || '').slice(0, 80)}"`
      : lampDetectionRaw ? 'no struck corner identified in response' : 'call skipped or failed');

    // Layer 2 backstop (item 14): frontStruck=true but no lampObs from Call 1.
    // Migrated from perZone-based trigger to code-owned frontStruck — no prose dependency.
    // Uses the full Call-1 thread (Opus — thread carries 1568px images, Haiku-safe resize not applicable).
    // Expected input: ~22–33K tokens (system prefix cached + messages thread). max_tokens=512 covers
    // one tool_use block; observed backstop output at BL75JAU iter=0: 97 tokens.
    if (!_exhaustedCalls.has('call1') && !lampObs) {   // batch 89: backstop on every lot with no Call-1 lampObs
      console.log('[LAMP] Layer 2 backstop triggered — no Call-1 lamp observation');
      const { res: backstopRes, exhausted: backstopExhausted } = await with529Retry('backstop', () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODELS.assessPrimary,
          max_tokens: 512,
          system: [{ type: 'text', text: ASSESSMENT_ENGINE_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [
            ...messages,
            { role: 'assistant', content: rawText },
            { role: 'user', content: 'You identified impact damage in your assessment above. Call recordImpactObservation now, based on the photos and your assessment: record struckSide and damageSpan; set apertureExposed if the FRONT bumper is displaced or removed exposing the wing-to-bumper or lamp seam; and set rearApertureExposed if the REAR bumper is torn or displaced exposing the rear-quarter seam. Assess the front and rear apertures independently — do not assume the rear bumper is intact because the main impact is at the front.' },
          ],
          tools: [LAMP_OBS_TOOL],
          tool_choice: { type: 'any' },
        }),
      }));
      if (backstopExhausted || !backstopRes?.ok) {
        lampObs = tier1FloorLampObs();
        lampObsSource = 'layer2-backstop';
        console.warn('[LAMP] Layer 2 backstop 529-exhausted or error — tier-1 floor applied (apertureExposed:false)');
      } else {
        const backstopData = await backstopRes.json();
        console.log(`[LAMP] Layer 2: stop=${backstopData.stop_reason} input=${backstopData.usage?.input_tokens} output=${backstopData.usage?.output_tokens}`);
        const backstopBlock = (backstopData.content || []).find(b => b.type === 'tool_use' && b.name === 'recordImpactObservation');
        if (backstopBlock?.input) {
          const _side = normaliseImpactField(backstopBlock.input?.struckSide, STRUCK_SIDE_ENUM, 'central');
          const _span = normaliseImpactField(backstopBlock.input?.damageSpan, DAMAGE_SPAN_ENUM, 'full_width');
          lampObs = {
            struckSide:      _side.value,
            apertureExposed: Boolean(backstopBlock.input?.apertureExposed),
            damageSpan:      _span.value,
            rearApertureExposed: false,
            _sideDefaulted: _side.defaulted, _sideRejected: _side.rejected,
            _spanDefaulted: _span.defaulted, _spanRejected: _span.rejected,
          };
          lampObsSource = 'layer2-backstop';
          if (_side.defaulted) console.log(`[LAMP][DEFAULT] struckSide ${_side.rejected != null ? `invalid "${_side.rejected}"` : 'absent'} → central (neutral default — C2, inert for rear)`);
          if (_span.defaulted) console.log(`[LAMP][DEFAULT] damageSpan ${_span.rejected != null ? `invalid "${_span.rejected}"` : 'absent'} → full_width (over-warn ruling 08Jul)`);
          console.log(`[LAMP] Layer 2 observation: struckSide=${lampObs.struckSide} apertureExposed=${lampObs.apertureExposed} damageSpan=${lampObs.damageSpan}`);
        } else {
          lampObs = tier1FloorLampObs();
          lampObsSource = 'layer2-backstop';
          console.log('[LAMP] Layer 2 backstop failed — no tool block returned; tier-1 floor applied (apertureExposed:false)');
        }
      }
    }

    // Defensive floor: no observation after all layers on any lot (batch 89 — every car is checked now)
    // (guards against transient API failures on the forced path; should not fire in practice)
    if (!lampObs) {
      lampObs = tier1FloorLampObs();
      lampObsSource = 'no-arm';
      console.log('[LAMP] no observation after all layers; tier-1 floor applied (apertureExposed:false → £0)');
    }

    // Layer 3: unconditional trigger observability — one line per run, every lot
    lampObsSource = lampObsSource || 'no-arm';
    console.log(`[LAMP][TRIGGER] source=${lampObsSource}`);

    // Fault 1a — the aperture panel read now fires per aperture-suspect panel inside the
    // bumper-off rule (C3), targeted to that panel's frames; no early full-set single call.

    let lampResult = null;
    if (lampObs) {
      const derivedLampType = deriveLampType(enrichedVd);
      lampResult = computeLampResult(
        lampObs.struckSide, lampObs.apertureExposed, derivedLampType,
        detectedCorner?.verdict   || null,
        detectedCorner?.lamp_type || null,
        lampObs.damageSpan        || 'full_width',
        lampObs._spanDefaulted    === true
      );
      console.log(`[LAMP] final: tier=${lampResult.tier} effectiveVerdict=${lampResult.effectiveVerdict} band=£${lampResult.lampAllowance} type=${lampResult.lampType} assumed=${lampResult.lampTypeAssumed}`);
    }

    // Item 15 — enforce prose-ban on absolute side labels before any buyer-facing field is parsed.
    // Single chokepoint: rawText is final here (Call 2 already read it); parseAssessment and
    // _raw both receive the sanitized version so every surface is covered in one pass.
    const sanitizedRawText = sanitizeSideTerms(rawText);
    const assessment = parseAssessment(sanitizedRawText);
    assessment._raw = sanitizedRawText;
    assessment._market = market;
    assessment._frameZones = _frameZones; // { ok, frames:[{i,zones,windscreenLabel}] } — always-run frame-zone pass
    if (lampResult) assessment._lampResult = lampResult;
    assessment._lampObs = lampObs ? {
      struckSide:          lampObs.struckSide ?? 'central',
      apertureExposed:     lampObs.apertureExposed === true,
      rearApertureExposed: lampObs.rearApertureExposed === true,
      damageSpan:          lampObs.damageSpan ?? 'full_width',
      _spanDefaulted:      lampObs._spanDefaulted === true,
      _spanRejected:       lampObs._spanRejected ?? null,
      _sideDefaulted:      lampObs._sideDefaulted === true,
      _sideRejected:       lampObs._sideRejected ?? null,
      lampObsSource:       lampObsSource ?? null,
    } : null;

    // Append deterministic 2nd-lamp checklist item on full-width lots (before Supabase write)
    if (lampResult?.checklistEntry2nd) {
      const existing = (assessment['WhatsApp Inspection Checklist'] || '').trim();
      if (existing) {
        const itemCount = (existing.match(/^\d+[.)]/mg) || []).length;
        assessment['WhatsApp Inspection Checklist'] = existing + `\n${itemCount + 1}. ${lampResult.checklistEntry2nd}`;
      }
    }

    // Parts reconciliation — lamp band folded in; parts_sum is the sole repair figure
    const _sideScrubbed = [];
    const _partsBreakdownText = assessment['Parts Breakdown'] || '';
    const rawParts = parseParts(_partsBreakdownText, _sideScrubbed);
    assessment._sideScrubbed = _sideScrubbed; // provenance stamp — [] when scrub ran and changed nothing

    // Loud-fail on silent parse collapse (parts-parser-brittleness follow-up, loud-fail only —
    // format broadening deferred). BL75JAU class: the model closes rows in a format parseParts
    // doesn't match, every row fails, rawParts is [], and the repair total silently falls back to
    // the lamp-floor — a plausible-looking WRONG number. Detect it: table-shaped text (a line with
    // ≥2 pipes) that yielded ZERO parsed rows. A loud failure beats a silent wrong number.
    const _partsTextHasRows = _partsBreakdownText.split('\n').some(l => (l.match(/\|/g) || []).length >= 2);
    assessment._partsParseFailed = rawParts.length === 0 && _partsTextHasRows;
    if (assessment._partsParseFailed) {
      const _firstRow = _partsBreakdownText.split('\n').find(l => (l.match(/\|/g) || []).length >= 2) || '';
      console.error(`[PARTS][PARSE FAILED] Parts Breakdown has table-shaped rows but parseParts returned 0 — format mismatch; repair total would fall back to lamp-floor only. First row: ${JSON.stringify(_firstRow.trim())}`);
    }

    // (raw ledger computation moved above main call — Step 4a; assignments remain below)
    coreObs.costedParts  = pvResult.costedParts;
    coreObs.flaggedParts = pvResult.flaggedParts;
    assessment._pvVotes  = pvResult.pvVotesMap ?? null;

    // ── §9 FLAG-TRACE SEAM (batch 81) — dev-only, env-flagged, £0, never fires in prod ─────────────
    // Batch 79/81 could not name the line that removes a disagree panel's flag downstream (DL72FVX's
    // WHEEL_ARCH_MOULDING vanished silently). The §2 invariant re-establishes it regardless, but this
    // seam names WHERE it goes: when MQ_TRACE_FLAGS is set, it logs the disagree / single-MINOR flag
    // panelIds present at each stage, so ONE instrumented run bisects the removal to a code region. The
    // markers are on the amalgamate flags, so the trace follows the exact class the invariant guards.
    const _traceFlags = (stage) => {
      if (!process.env.MQ_TRACE_FLAGS) return;
      const ids = (coreObs.flaggedParts || [])
        .filter(f => f._amalgDisagree || f._amalgSingleMinor)
        .map(f => `${f.panelId}${f._amalgSingleMinor ? '(minor)' : ''}`);
      console.log(`[FLAG TRACE][${stage}] disagree/single-minor flags present: [${ids.join(', ')}]`);
    };
    _traceFlags('post-amalgamate');
    if (pvResult.pvVotesCollision) {
      assessment._pvVotesCollision = true;
      console.warn('[AMALG] key collision in pvVotes — duplicate canonical part name; see _pvVotesCollision marker');
    }
    console.log(`[PART VERDICTS][PER-VIEW] costedParts=${pvResult.costedParts.length} flaggedParts=${pvResult.flaggedParts.length}`);
    console.log('[PART VERDICTS][PER-VIEW] costedParts:', JSON.stringify(pvResult.costedParts));
    console.log('[PART VERDICTS][PER-VIEW] flaggedParts:', JSON.stringify(pvResult.flaggedParts));

    // ── Aperture-grille cost rule ──────────────────────────────────────────────
    // Code-owned, no model call. Condition: front bumper physically displaced
    // (apertureExposed) AND lamp-detect confirmed headlamp mount empty
    // (detectedCorner.verdict='missing'). Together these establish the grille is
    // absent — no bumper and no lamp means nothing sits between camera and
    // radiator. Per-view cannot reliably adjudicate absence (empty region reads
    // as damaged-present or clean-background per angle); the deterministic
    // structured pair overrides per-view amalgamation.
    // Distinct from the bumper-off panel floor rule (acts on wing/quarter, floors
    // downward): this acts on the grille and costs upward. No collision.
    // Note: detectedCorner.verdict is the RAW lamp-detect verdict — not
    // lampResult.effectiveVerdict, which is suppressed by LAMP_DETECTION_CONFIDENT_WORDING.
    if (lampObs?.apertureExposed === true && detectedCorner?.verdict === 'missing') {
      const grilleEntry = coreObs.costedParts.find(cp => cp.panelId === PANEL.GRILLE);
      if (!grilleEntry) {
        console.log('[AMALG][APERTURE] grille established absent but no canonical match — LOGGED, not applied');
      } else {
        const prior = grilleEntry._amalgMissing        ? 'cost (missing)'
          : grilleEntry.independentlyVisible === true  ? 'cost (damaged)'
          : grilleEntry._perViewClear                  ? 'clear (all-clean)'
          : 'floor';
        console.log(`[AMALG][APERTURE] "${grilleEntry.partName}" bumper-off + lamp-missing → force cost (replace), per-view said ${prior}`);
        grilleEntry.independentlyVisible = true;
        grilleEntry._amalgMissing = true;
        const fi = coreObs.flaggedParts.findIndex(fp => fp.panelId === PANEL.GRILLE);
        if (fi !== -1) coreObs.flaggedParts.splice(fi, 1);
      }
    }
    // ── End aperture-grille cost rule ─────────────────────────────────────────

    // Hard-fail if the per-view pipeline produced nothing while costed parts exist.
    // A bare return here would bypass the catch block and strand the session in
    // 'processing' until the 600s stale-lock. Throwing routes through catch (2239–2258)
    // which resets promo→promo_redeemed (immediately retryable) and non-promo→failed
    // (retry via same stripe session_id passes payment_status=paid at no re-charge).
    if (pvResult.costedParts.length === 0 && rawParts.length > 0) {
      console.error(`[PER-VIEW][ABORT] pipeline produced 0 verdicts while ${rawParts.length} costed part(s) exist — aborting; session reset to retryable`);
      throw new Error('Assessment could not be completed — please retry');
    }

    // ── Bumper-off rule ────────────────────────────────────────────────────────
    // Code-owned, no model call. Runs BEFORE perception probe so the probe never
    // challenges a panel already demoted here.
    // Signal: bumper physically off (apertureExposed / rearApertureExposed from the
    // structured early call) → adjacent wing/quarter seam exposed → line demoted.
    // No peel/crush classification: bumper off is sufficient — the seam is exposed
    // regardless of how the bumper left.
    const bumperOffDemoted = []; // { partName, rx } — fed to KCD scrub below
    let _apertureReads = [];     // hoisted above the (unconditional) block so the always-stamp below runs on every lot
    {
      // Adjacent-bumper LEDGER signal (code-owned fact) OR'd with the model flag.
      // A severe/displaced/missing bumper means the wing/quarter seam behind it is exposed →
      // the panel is aperture-suspect and cannot be certainly visible → floor to inspect, even
      // if the front-framed impact prompt never elicited the model aperture flag, and even if
      // the panel was SEVERE-overridden. Severity is read from the costed entry: _severeOverride
      // (≥2-SEVERE-vote path) OR _ledgerSeverity==='SEVERE' (stamped on every costed entry,
      // catching the normal damaged>0/clean===0 path and missing too). Bumpers aren't G-split,
      // so _gSeverity is never present on them — _ledgerSeverity is the field that covers them.
      const bumperSevereInLedger = (pid) => coreObs.costedParts.some(cp =>
        cp.panelId === pid && cp.independentlyVisible === true &&
        (cp._severeOverride === true || cp._ledgerSeverity === 'SEVERE'));
      const frontBumperSevere = bumperSevereInLedger(PANEL.FRONT_BUMPER);
      const rearBumperSevere  = bumperSevereInLedger(PANEL.REAR_BUMPER);
      const frontBumperOff = (lampObs?.apertureExposed === true)     || frontBumperSevere;
      const rearBumperOff  = (lampObs?.rearApertureExposed === true) || rearBumperSevere;
      console.log(`[BUMPER-OFF] frontBumperOff=${frontBumperOff} (model=${lampObs?.apertureExposed === true} ledger=${frontBumperSevere}) rearBumperOff=${rearBumperOff} (model=${lampObs?.rearApertureExposed === true} ledger=${rearBumperSevere})`);
      // Persist the authoritative bumper-off determination for the downstream fog-bumper rule
      // (Fix B, lib/partsCompleteness) — it runs after the gate, out of this block's scope.
      assessment._frontBumperOff = frontBumperOff;
      assessment._rearBumperOff  = rearBumperOff;
      // (a) collect aperture-suspect panels (guards + bumperOffHere unchanged), tagging aperture zone.
      const _apertureSuspects = [];
      for (const cp of coreObs.costedParts) {
        if (cp.independentlyVisible !== true || cp._labourSafe || cp._amalgMissing === true) continue;
        const isFW = /\bfront\b.*\bwing\b/i.test(cp.partName);
        const isRQ = /\brear\b.*\bquarter\b/i.test(cp.partName);
        const bumperOffHere = (isFW && frontBumperOff) || (isRQ && rearBumperOff);
        if (bumperOffHere) _apertureSuspects.push({ cp, isRQ, apertureZone: isRQ ? 'rear' : 'front' });
      }
      // (b) C3 — fire a targeted aperture read PER suspect (frames per selectApertureFrames; prompt
      // byte-identical — same lampObs). Parallel; full-set fallback inside runAperturePanelRead. Each
      // panel is now gated on ITS OWN verdict, not one shared full-set read.
      _apertureReads = await Promise.all(_apertureSuspects.map(async (s) => {
        const { indices, source } = selectApertureFrames(s.cp, _frameZones, lampObs?.struckSide, s.apertureZone);
        const r = await runAperturePanelRead(images, lampObs, indices, s.apertureZone, () => _exhaustedCalls.add('aperture-panel'));
        return { ...s, verdict: r?.verdict ?? null, evidence: r?.evidence ?? '', frameSource: source };
      }));
      // (c) DETERMINISTIC bumper-off demote — keep-cost authority REVOKED. EVERY aperture suspect
      // demotes regardless of the probe verdict, incl. 'torn', 'ambiguous', and null (probe
      // failure/exhaust). Evidence: four SF69YBB runs across three prompt generations returned a false
      // 'torn' on a clean quarter — perception cannot separate the panel face from body-coloured torn
      // carrier wreckage in listing photos, so it no longer holds cost. This restores the June
      // deterministic rule; the probe now selects the flag REASON only, never the cost decision. Cost is
      // excluded via independentlyVisible=false (G-inject skips _gOwned; the gate strips a model row);
      // the compensating flag below is the buyer's signal.
      for (const { cp, isRQ, verdict, frameSource } of _apertureReads) {
        console.log(`[APERTURE GATE] panel="${cp.partName}" verdict=${verdict} frames=${frameSource} → demote (deterministic)`);
        cp.independentlyVisible = false;
        cp._bumperOffStripped = true;
        const _demoteCause = `${verdict ?? 'no-read'}-demote`;   // provenance only — probe no longer decides cost
        cp._apertureDemoteCause = _demoteCause;
        // 1b flag-gap: a _gOwned panel (no model Parts row) demoted here never reaches gateStripped, so
        // the gate's :281-288 bumper-off flag never fires for it and the panel vanishes (no cost, no
        // flag). Push the inspection flag at the demotion site, mirroring the RAD hatch (:2963). The
        // gate's strip-loop dedup (parts.mjs :279, keyed on normName(partName)) suppresses its own push
        // when a model row DOES exist, since this push lands first. The reason is verdict-selected;
        // dedup is keyed on partName, not reason text, so the divergence is safe.
        const _explained = (verdict === 'seam' || verdict === 'mounting-structure' || verdict === 'factory-symmetric');
        coreObs.flaggedParts.push({
          panelId:  cp.panelId,
          partName: cp.partName,
          zone:     cp.zone,
          // Uncostable (torn/ambiguous/null) is HIGH — possible real cost excluded; the factory
          // explanations (seam/mounting/symmetric) stay medium.
          weight:   _explained ? 'medium' : 'high',
          reason:   verdict === 'factory-symmetric'
            ? BUMPER_OFF_SYMMETRIC_REASON
            : verdict === 'mounting-structure'
              ? BUMPER_OFF_MOUNTING_REASON
              : verdict === 'seam'
                ? (isRQ ? BUMPER_OFF_SEAM_REASON + BUMPER_OFF_RQ_RIDER : BUMPER_OFF_SEAM_REASON)
                : BUMPER_OFF_UNCOSTABLE_REASON,
          _bumperOffStripped: true,
          _apertureDemoted: true,   // breadcrumb — deterministic bumper-off demote, for telemetry + validation
          _apertureDemoteCause: _demoteCause,   // provenance: <verdict|no-read>-demote (probe no longer decides)
        });
        bumperOffDemoted.push({ partName: cp.partName, rx: isRQ ? /\brear\b.*\bquarter\b/i : /\bfront\b.*\bwing\b/i });
        console.log(`[BUMPER-OFF] demoted "${cp.partName}" — bumper displaced (${_demoteCause})`);
      }
    }

    // ── Aperture Rescue Gate (Stage 1) — behind APERTURE_RESCUE_ENABLED (default OFF) ────────────
    // Recover a genuinely-deformed panel the demote just floored with a `torn` verdict, WITHOUT
    // re-opening the SF69YBB fabrication. Scope-locked (§1) to verdict==='torn' aperture demotes.
    // Safe-by-construction: PROMOTE needs a frame UNANIMOUSLY face-deformed AND no frame face-clean
    // (lib/apertureRescue.mjs decideRescue); any doubt / cannot-determine / wrong-panel → leave floored.
    // On PROMOTE of a MODEL-row panel we restore its stripped parts-breakdown line (§4); a _gOwned
    // panel has no model line → it stays a HIGH-weight flagged allowance (never an invented hard cost).
    if (process.env.APERTURE_RESCUE_ENABLED === 'true') {
      const _stripB64 = (du) => du.replace(/^data:[^;]+;base64,/, '');
      const rescueImaging = {
        async meta(du) { const im = await loadImage(Buffer.from(_stripB64(du), 'base64')); return { W: im.width, H: im.height }; },
        async crop(du, box) {
          const im = await loadImage(Buffer.from(_stripB64(du), 'base64'));
          const c = createCanvas(box.width, box.height);
          c.getContext('2d').drawImage(im, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
          return c.toDataURL('image/jpeg', 0.9);
        },
      };
      const rescueCall = async (du, text, maxTok = 300) => {
        const mm = du.match(/^data:([^;]+);base64,(.+)$/);
        const media_type = mm ? mm[1] : 'image/jpeg';
        const data = mm ? mm[2] : du;
        const { res, exhausted } = await with529Retry('aperture-rescue', () => fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: MODELS.assessPrimary, max_tokens: maxTok,
            system: 'Respond ONLY with a raw JSON object. No markdown.',
            messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text }] }],
          }),
        }));
        if (exhausted || !res?.ok) return null;
        const d = await res.json();
        return (d.content || []).find(b => b.type === 'text')?.text || null;
      };
      const _rescueInstanceIdx = (fs) => { const m = String(fs || '').match(/\[([\d,\s]*)\]/); return m ? m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite) : []; };
      for (const a of _apertureReads) {
        if (a.verdict !== 'torn') continue;   // scope lock §1 — only torn demotes are rescue candidates
        const kind = a.isRQ ? 'REAR_QUARTER' : 'FRONT_WING';
        const idxs = _rescueInstanceIdx(a.frameSource).slice(0, 3); // best-lit targeted frames (§3)
        const frames = idxs.map((i) => ({ i, du: images[i] })).filter(f => f.du).map(f => ({ id: `${a.cp.panelId}_${f.i}`, dataUrl: f.du }));
        if (!frames.length) { console.log(`[APERTURE RESCUE] ${a.cp.panelId} — no targeted frames; leave floored`); continue; }
        let result;
        try { result = await runRescueGate({ kind, frames, call: rescueCall, imaging: rescueImaging }); }
        catch (err) { console.warn(`[APERTURE RESCUE] ${a.cp.panelId} error: ${err.message} — leave floored`); continue; }
        console.log(`[APERTURE RESCUE] ${a.cp.panelId} -> ${result.decision} (${result.reason})`);
        if (result.decision !== 'PROMOTE') continue;
        if (a.cp._gOwned === true) {
          // §4 no-model-line edge: keep the HIGH-weight flagged allowance already in place; never invent a hard cost.
          a.cp._apertureRescuedAllowance = true;
          console.log(`[APERTURE RESCUE] ${a.cp.panelId} PROMOTE but _gOwned (no model parts line) — kept as HIGH-weight allowance flag (§4)`);
          continue;
        }
        // MODEL-row panel: restore the stripped parts-breakdown line — revert the demote's mutations so
        // it re-costs via its original path (reconcile/gate below), with NO invented figure.
        a.cp.independentlyVisible = true;
        delete a.cp._bumperOffStripped;
        a.cp._apertureRescued = true;
        const _fi = coreObs.flaggedParts.findIndex(f => f._apertureDemoted && f.panelId === a.cp.panelId);
        if (_fi !== -1) coreObs.flaggedParts.splice(_fi, 1);   // drop the "excluded from repair total" flag (now costed)
        const _bi = bumperOffDemoted.findIndex(x => x.partName === a.cp.partName);
        if (_bi !== -1) bumperOffDemoted.splice(_bi, 1);       // un-scrub from Key Cost Drivers
        console.log(`[APERTURE RESCUE] PROMOTED "${a.cp.partName}" — model parts-breakdown line restored to costed set`);
      }
    }

    // Always-stamp (C1): full per-suspect aperture evidence into JSONB — [] on no-suspect lots. Runs on
    // EVERY lot (outside the unconditional block); _apertureReads is hoisted above the block for this.
    assessment._apertureReads = _apertureReads.map(a => ({
      panelId: a.cp.panelId, verdict: a.verdict, evidence: a.evidence, frameSource: a.frameSource, rescued: a.cp._apertureRescued === true,
    }));
    // ── End bumper-off rule ────────────────────────────────────────────────────

    // ── RADIATOR_PACK corroboration floor + low-centre escape hatch (post-amalgamate) ──
    // RADIATOR_PACK is hidden — only in frame when the front is torn open. A single damaged grade
    // among na's can false-cost £300. Floor it to inspection UNLESS the ledger shows a low-centre
    // front structural impact, which corroborates the rad by geometry (Vincent's trade ruling).
    // Lives HERE, not in amalgamate: the proxy (SLAM/FRONT_STRUCTURE severity) and the geometry
    // signals are produced after amalgamate and group iteration order is undefined, so the ledger
    // isn't reliably present during amalgamate. Code-owned proxy ONLY — NOT struckSide (defaults to
    // 'central' on absence → unsound) or heightBand (null on most runs). pvVotesMap is returned by
    // amalgamate and pvResult is in scope here; coreObs.costedParts/flaggedParts already assigned.
    {
      const radVotes = pvResult.pvVotesMap?.RADIATOR_PACK;
      const radEntry = coreObs.costedParts.find(cp => cp.panelId === PANEL.RADIATOR_PACK && cp.independentlyVisible === true);
      if (radEntry && radVotes && radVotes.damaged < 2) {
        // Escape-hatch proxy, read from the costed/flagged ledger (deterministic, code-owned):
        //   SLAM_PANEL severe — costed entry carries _severeOverride (≥2-SEVERE path) or _ledgerSeverity==='SEVERE'.
        //   FRONT_STRUCTURE severe — flag-class, so it lives in flaggedParts as the high-weight damage
        //     flag (weight:'high' + AMALG_REASON_FLAG_CLASS; the not-visible flag is weight:'medium').
        const slamSevere = coreObs.costedParts.some(cp =>
          cp.panelId === PANEL.SLAM_PANEL && cp.independentlyVisible === true &&
          (cp._severeOverride === true || cp._ledgerSeverity === 'SEVERE'));
        const frontStructureSevere = coreObs.flaggedParts.some(f =>
          f.panelId === PANEL.FRONT_STRUCTURE && f.weight === 'high' && f.reason === AMALG_REASON_FLAG_CLASS);
        if (slamSevere || frontStructureSevere) {
          console.log(`[RAD FLOOR] RADIATOR_PACK damaged=${radVotes.damaged} (single-grade, views=${radVotes.views}) BUT low-centre proxy fired (slamSevere=${slamSevere} frontStructureSevere=${frontStructureSevere}) → hatch=fired → £cost retained`);
          assessment._radPackDisposition = 'retained-proxy';
        } else {
          // Mirror the bumper-off demotion: iv=false in place → the gate strips it from the total
          // and the G-inject guard skips it. Push the specific inspection flag here so the gate's
          // generic strip reason is deduped out (it keys on partName).
          radEntry.independentlyVisible = false;
          radEntry._radUncorroborated = true;
          coreObs.flaggedParts.push({ panelId: PANEL.RADIATOR_PACK, partName: PANEL_DISPLAY[PANEL.RADIATOR_PACK], zone: radEntry.zone, weight: 'medium', reason: AMALG_REASON_RAD_UNCORROBORATED, _radUncorroborated: true });
          console.log(`[RAD FLOOR] RADIATOR_PACK damaged=${radVotes.damaged} (single-grade, views=${radVotes.views}) AND no low-centre proxy (slamSevere=false frontStructureSevere=false) → floor to inspection`);
          assessment._radPackDisposition = 'floored';
        }
      } else {
        // Rule did not fire: a corroborated costed rad entry (damaged≥2 / no votes) is retained
        // as-is; no costed rad entry at all → nothing to price. Purely observational stamp — no
        // behaviour change (the outcome above is exactly what the untouched rule already produced).
        assessment._radPackDisposition = radEntry ? 'retained-corroborated' : 'none';
      }
      // Step 5 interface — rad-pack grade carried off the amalgamate ledger record (accurate
      // three-state _ledgerSeverity, :1777; survives the iv flip above). Inert: nothing reads it today.
      assessment._radPackSeverity = radEntry ? (radEntry._ledgerSeverity ?? null) : null;
    }

    // ── KCD scrub retired (4d) ────────────────────────────────────────────────
    // The Key Cost Drivers list is now code-assembled from the finalised ledger
    // (_kcdParts, assembleKcdParts). Demoted/floored parts are absent from gatedParts
    // by construction, so they can never appear as drivers — the demoted-part line-drop
    // this scrub performed is preserved automatically. Model KCD prose is bound by the
    // claim-class binder (class 4 covers demoted-part claims). Closes the "kept until 4e" note.

    // ── VDS scrub retired (Step 4c) ───────────────────────────────────────────
    // The model no longer authors per-panel VDS prose, so there is nothing to
    // reframe — the per-panel damage section is code-assembled into _vdsParts after
    // finalisation (see assembleVdsParts below). The bumper-off seam reason now
    // reaches the buyer via the gate-generated Inspection Flag (BUMPER_OFF_SEAM_REASON
    // in applyVisibilityGate) and the assembled VDS block for the demoted panel.

    // ── Red Flags demoted-part scrub retired (4e) ─────────────────────────────
    // Absorbed into the claim-class binder (PART STATUS, class 4): a demoted/floored
    // part asserted as damaged or a cost driver is dropped there, keyed on the ledger's
    // iv:false set (which includes bumper-off demoted parts). Not stacked — the binder is
    // the single owner of demoted-part claim removal. Inner-structure concern still reaches
    // the buyer via the gate-generated Inspection Flag. Closes the "kept until 4e" note.

    // Perception probe retired — bumper-off rule demotes wing/quarter panels
    // deterministically before reconcile. Completeness probe will be built separately.

    // ── Sill rocker-discrimination read ──────────────────────────────────────
    // Fires ONLY when SILL is in the costed set (independentlyVisible=true after
    // amalgamate + bumper-off rule). Per-view votes SILL iv:true where a torn
    // door bottom meets sill height — correct perception, wrong attribution.
    // This call asks the discriminating question per-view never asks; code owns
    // the cost consequence: deformed+confident → cost; not-deformed → flag;
    // uncertain / null → floor to inspection flag (never costs a guess).
    {
      const sillEntry = coreObs.costedParts.find(cp => cp.panelId === PANEL.SILL && cp.independentlyVisible === true);
      if (sillEntry) {
        const sillResult = await runSillRockerRead(images, () => _exhaustedCalls.add('sill-rocker'));
        const confident  = sillResult?.confidence === 'med' || sillResult?.confidence === 'high';
        const deformed   = sillResult?.rocker_independently_deformed === true;
        let action;
        if (sillResult === null) {
          action = 'flag-uncertain';
        } else if (deformed && confident) {
          action = 'cost';
        } else if (!deformed) {
          action = 'flag-clean';
        } else {
          // deformed=true, confidence=low
          action = 'flag-uncertain';
        }
        console.log(`[SILL ROCKER] deformed=${sillResult?.rocker_independently_deformed ?? 'null'} confidence=${sillResult?.confidence ?? 'null'} → action=${action}`);
        if (action !== 'cost') {
          const reason = action === 'flag-clean'
            ? 'Sill/rocker condition: low damage at sill height reads as door-edge, not rocker deformation — verify inner sill on inspection.'
            : 'Sill condition not independently confirmable from photos — verify rocker/inner-sill on inspection.';
          const sillIdx = coreObs.costedParts.indexOf(sillEntry);
          if (sillIdx !== -1) coreObs.costedParts.splice(sillIdx, 1);
          coreObs.flaggedParts.push({ panelId: PANEL.SILL, partName: sillEntry.partName, zone: sillEntry.zone, weight: 'medium', reason });
        }
      } else {
        console.log('[SILL ROCKER] no SILL costed entry — skipped');
      }
    }
    // ── End sill rocker-discrimination read ───────────────────────────────────

    // ── Bonnet skin-vs-displaced discriminator read ───────────────────────────
    // Mirror of the sill read, OPPOSITE direction. Per-view disagrees on a displaced-but-intact
    // bonnet (proud edge / open shut-line read as damage by some views, intact by others), so
    // amalgamate floors it (_amalgDisagree). At ratio≥0.70 the sticky pass below would rescue that
    // floor to a phantom cost. This read asks whether the hood SKIN itself is deformed; a confident
    // "skin intact" converts the disagree-floor to a genuine CLEAR — dropping the _amalgDisagree
    // flag (so sticky's input set no longer contains it) and marking the twin _perViewClear (so the
    // gate strips any model Bonnet row with no flag). ONE-WAY: only clears on a confident
    // skin-intact read; a genuinely skin-damaged or uncertain/failed bonnet keeps its floor (a real
    // one can still be rescued by sticky at ratio≥0.70). Runs pre-sticky AND pre-gate by placement.
    {
      const bonnetFlag = coreObs.flaggedParts.find(f => f.panelId === PANEL.BONNET && f._amalgDisagree);
      const bonnetTwin = coreObs.costedParts.find(cp =>
        cp.panelId === PANEL.BONNET && cp.independentlyVisible === false &&
        !cp._perViewClear && !cp._amalgMissing && !cp._amalgUncorroborated &&
        !cp._amalgNotVisible && !cp._radUncorroborated && !cp._bumperOffStripped);
      if (bonnetFlag && bonnetTwin) {
        const bonnetRead  = await runBonnetSkinRead(images, () => _exhaustedCalls.add('bonnet-skin'));
        const confident   = bonnetRead?.confidence === 'med' || bonnetRead?.confidence === 'high';
        const skinDamaged = bonnetRead?.skin_damaged === true;
        const action = bonnetRead === null       ? 'leave-floor-null'
                     : (!skinDamaged && confident) ? 'clear'
                     : skinDamaged && confident    ? 'leave-floor-damaged'
                     : 'leave-floor-uncertain';
        console.log(`[BONNET_READ] skin_damaged=${bonnetRead?.skin_damaged ?? 'null'} confidence=${bonnetRead?.confidence ?? 'null'} → action=${action}`);
        if (action === 'clear') {
          // Floor → CLEAR. Drop the disagree flag (removes it from sticky's input set AND from the
          // buyer flags), mark the twin _perViewClear (gate strips any model Bonnet row, no gate
          // flag), and add ONE neutral low-weight breadcrumb — NOT _amalgDisagree, NOT a cost, so
          // nothing sticky or the gate acts on it.
          const fi = coreObs.flaggedParts.indexOf(bonnetFlag);
          if (fi !== -1) coreObs.flaggedParts.splice(fi, 1);
          bonnetTwin._perViewClear   = true;
          bonnetTwin._bonnetDisplaced = true;
          delete bonnetTwin._amalgDisagree;   // batch 81 §2: the skin-read genuinely CLEARED this disagree — drop the marker so the invariant does not re-add a disagree flag
          coreObs.flaggedParts.push({
            panelId: PANEL.BONNET, partName: PANEL_DISPLAY[PANEL.BONNET], zone: bonnetTwin.zone, weight: 'low',
            reason: 'Bonnet sits proud / shut line disturbed — hood skin intact; refits with the structural repair, no separate panel cost.',
            _bonnetDisplaced: true,
          });
          console.log('[BONNET_READ] CLEAR — displaced-but-intact bonnet: dropped disagree floor, marked _perViewClear, breadcrumb added (no cost, no sticky target)');
        }
      } else {
        console.log(`[BONNET_READ] gate skip — bonnet not disagree-floored (flag=${!!bonnetFlag} twin=${!!bonnetTwin})`);
      }
    }
    // ── End bonnet skin-vs-displaced discriminator read ───────────────────────

    // ── In-zone sticky cost rescue (Option B) ─────────────────────────────────
    // Code-owned, no model call. Promotes a disagree-FLOORED panel back to cost when the
    // vote split is lopsided toward damage AND the panel sits in a struck zone. Kills the
    // disagree→floor knife-edge swing (LP71NSU £3,685↔£2,965): amalgamate's disagree branch
    // (:1672) floors any panel with BOTH damaged>0 AND clean>0, ignoring the damaged:clean
    // ratio, so model run-to-run variance on a single clean vote flips a heavily-damaged
    // panel in/out of the total. This pass restores the panel when ≥STICKY_COST_THRESHOLD of
    // resolving views called it damaged.
    //
    // ONE-WAY: this pass ONLY sets independentlyVisible false→true on _amalgDisagree entries.
    // It never demotes, never touches a non-disagree-floored panel. Its input set
    // ({iv:false + _amalgDisagree}) is DISJOINT from the demotion rules above (bumper-off/rad/
    // sill all act on iv:true only), so a rescued panel cannot be re-demoted here and order
    // is immaterial — running last makes the promotion sticky.
    //
    // The cost materialises only because the model authored a Parts Breakdown row for the
    // panel: the gate keeps that row iff the matching verdict is iv:true (lib/parts.mjs :254),
    // it does NOT inject rows. So we GUARD on a matching rawParts row — without one, flipping
    // iv:true would drop the flag and produce no cost (the panel would vanish). No row → leave
    // floored, flag intact.
    {
      // Struck set: model-classified zones (coreObs.perZone, ANY eventType) ∪ listing-derived
      // front/rear. Byte-identical to the _struckZoneSet built later at the FLAG SUPPRESS block,
      // computed earlier here where perZone + frontStruck/rearStruck are already in scope.
      const stickyStruck = new Set((coreObs.perZone || []).map(z => z?.zone).filter(Boolean));
      if (frontStruck) stickyStruck.add('front');
      if (rearStruck)  stickyStruck.add('rear');

      // Count _amalgDisagree flags per panelId so we only rescue an UNAMBIGUOUS match — a
      // G-split instance (pvVotes keyed by _instanceKey) or a bare-panelId collision cannot be
      // matched to amalgamate's own vote counts with certainty → skip (fail-safe: stay floored).
      const disagreeCountByPanel = new Map();
      for (const f of coreObs.flaggedParts) {
        if (f._amalgDisagree) disagreeCountByPanel.set(f.panelId, (disagreeCountByPanel.get(f.panelId) || 0) + 1);
      }

      const pvVotes = pvResult.pvVotesMap || {};
      // Snapshot the flag list — we splice rescued entries out of coreObs.flaggedParts inside the loop.
      for (const flag of [...coreObs.flaggedParts]) {
        if (!flag._amalgDisagree) continue;
        const panelId = flag.panelId;

        // (a) unambiguous disagree match + amalgamate's OWN damaged/resolving (no recompute).
        if ((disagreeCountByPanel.get(panelId) || 0) !== 1) {
          console.log(`[AMALG][STICKY] ${panelId} — ${disagreeCountByPanel.get(panelId)} disagree flags share this panelId (G-split/collision) → ambiguous vote match, floor retained`);
          continue;
        }
        const votes = pvVotes[panelId];
        if (!votes || votes.branch !== 'disagree' || !(votes.resolving > 0)) {
          console.log(`[AMALG][STICKY] ${panelId} — no clean disagree vote entry in pvVotesMap (branch=${votes?.branch ?? 'absent'}) → floor retained`);
          continue;
        }
        const ratio = votes.damaged / votes.resolving;

        // (d) COST class only — the disagree branch does NOT gate on isFlagOnly, so a flag-class
        // panel can carry a disagree floor; never promote one. effClass exactly as amalgamate (:1562).
        const rawClass = PANEL_BEHAVIOUR[panelId];
        const effClass = rawClass === PANEL_CLASS.EV_CONDITIONAL ? EV_PANEL_RESOLVED_CLASS[panelId] : rawClass;
        if (effClass !== PANEL_CLASS.COST) {
          console.log(`[AMALG][STICKY] ${panelId} ratio=${ratio.toFixed(3)} — effClass=${effClass} not COST → floor retained`);
          continue;
        }

        // (b) lopsided toward damage and (c) zone struck.
        if (ratio < STICKY_COST_THRESHOLD) continue;
        if (!stickyStruck.has(flag.zone)) {
          console.log(`[AMALG][STICKY] ${panelId} damaged=${votes.damaged}/${votes.resolving} ratio=${ratio.toFixed(3)} zone=${flag.zone} NOT struck=[${[...stickyStruck].join(', ')}] → floor retained`);
          continue;
        }

        // GUARD: cost only materialises if the model authored a Parts Breakdown row for this
        // panel (the gate keeps it; it never injects). No row → flipping iv would vanish the
        // panel (no cost, no flag) → leave floored.
        if (!rawParts.some(p => p.panelId === panelId)) {
          console.log(`[AMALG][STICKY] ${panelId} damaged=${votes.damaged}/${votes.resolving} ratio=${ratio.toFixed(3)} zone=${flag.zone} struck — no model Parts row to cost; floor retained`);
          continue;
        }

        // Locate the disagree-floor costed twin: iv:false carrying the _amalgDisagree marker and NONE
        // of the other floor/clear markers (the disagree branch pushes exactly this shape — batch 81 §1
        // added _amalgDisagree to the costed entry; the exclusions below are unchanged and still isolate
        // it from per-view-clear / missing / uncorroborated / not-visible / rad / bumper-off twins).
        const twin = coreObs.costedParts.find(cp =>
          cp.panelId === panelId &&
          cp.independentlyVisible === false &&
          !cp._perViewClear && !cp._amalgMissing && !cp._amalgUncorroborated &&
          !cp._amalgNotVisible && !cp._radUncorroborated && !cp._bumperOffStripped);
        if (!twin) {
          console.log(`[AMALG][STICKY] ${panelId} ratio=${ratio.toFixed(3)} — no bare disagree-floor costed twin found → floor retained`);
          continue;
        }

        // Promote: iv true (gate keeps the model row → costs once) + drop the flag so it does
        // not ALSO surface in Inspection Flags (_flaggedParts is built downstream at FLAG SUPPRESS).
        twin.independentlyVisible = true;
        twin._stickyRescued = true;
        delete twin._amalgDisagree;   // batch 81 §1: rescued = CONFIRMED, no longer a disagree (so the gate/§2 invariant do not treat it as costed-but-flagged)
        const fi = coreObs.flaggedParts.indexOf(flag);
        if (fi !== -1) coreObs.flaggedParts.splice(fi, 1);
        console.log(`[AMALG][STICKY] ${flag.partName} damaged=${votes.damaged}/${votes.resolving} ratio=${ratio.toFixed(3)} zone=${flag.zone} struck → cost (was disagree-floor)`);
      }
    }
    _traceFlags('post-sticky-and-flank-reads');
    // ── End in-zone sticky cost rescue ─────────────────────────────────────────

    // ── Attribution probe (commit 2) — universal per-panel claim challenge ──────
    // Option B: fire over the surviving costed set (iv:true) right here, after every upstream floor
    // (aperture/RAD/sticky/zone) has run — universal by construction, no wasted calls, no skip
    // bookkeeping (skipped-already-floored stays in the action enum as documented-unreachable under
    // B). One-way: a verdict may FLOOR, never promote. Code-owned money systems are EXEMPT: rad-pack
    // (disposition machinery above is sole owner) — probe fired for telemetry, no mutation; HEADLAMP
    // (lamp-band allowance does not read iv) — skipped entirely, no vision call, no verdict.
    // Action enum: exempt-rad | exempt-lamp | probe-error | kept | floored (+ skipped-already-floored,
    // documented-unreachable under B).
    assessment._attributionProbe = { ok: true, panels: [] };
    {
      const _probeSurvivors = coreObs.costedParts.filter(cp => cp.independentlyVisible === true);
      const _probeResults = await Promise.all(_probeSurvivors.map(async (cp) => {
        const _missing = cp._amalgMissing === true;
        const _graded = PROBE_SEVERITY_WORDING[cp._ledgerSeverity] ? cp._ledgerSeverity : null;
        if (!_graded) console.log(`[ATTRIB PROBE] ${cp.panelId} no ledger grade → MODERATE wording (guard)`);
        const grade = _graded || 'MODERATE';
        // HEADLAMP: lamp-band money is code-owned (does not read iv) — probe-exempt, no vision call.
        if (cp.panelId === PANEL.HEADLAMP) {
          return { cp, grade, missing: _missing, frames: 'exempt', frameSource: 'exempt-lamp', r: null, exempt: 'exempt-lamp' };
        }
        const claimWording = _missing ? PROBE_MISSING_WORDING : PROBE_SEVERITY_WORDING[grade];
        const { indices, source } = selectProbeFramesForPanel(cp, _frameZones, lampObs?.struckSide, lampObs?.apertureExposed === true);
        const r = await runAttributionProbe(images, indices, PANEL_DISPLAY[cp.panelId], claimWording, _missing, () => _exhaustedCalls.add('attribution-probe'));
        return { cp, grade, missing: _missing, frames: indices ? indices : 'full-set', frameSource: source, r };
      }));
      const _attribFloored = [];
      for (const { cp, grade, missing, frames, frameSource, r, exempt } of _probeResults) {
        const claim = missing
          ? `${PANEL_DISPLAY[cp.panelId]} is ${PROBE_MISSING_WORDING}`
          : `${PANEL_DISPLAY[cp.panelId]} is ${PROBE_SEVERITY_WORDING[grade]}`;
        let action;
        if (exempt) {
          action = exempt;                                         // exempt-lamp — no vision call, no mutation
        } else if (cp.panelId === PANEL.RADIATOR_PACK) {
          action = 'exempt-rad';                                   // telemetry only, no mutation
        } else if (r === null) {
          action = 'probe-error';                                 // infra-failure → KEEP
        } else if (missing
            ? (r.verdict === 'absent' || r.verdict === 'area-destroyed')   // inverted: absence confirms
            : (r.verdict === 'consistent-with-claim')) {
          action = 'kept';
        } else {
          // FLOOR — mirror the zone-floor flag push EXACTLY (:3748-3755); only the marker differs.
          cp.independentlyVisible = false;
          cp._attribFloored = true;
          coreObs.flaggedParts.push({
            panelId:  cp.panelId,
            partName: PANEL_DISPLAY[cp.panelId],
            zone:     cp.zone,
            weight:   grade === 'SEVERE' ? 'high' : 'medium',
            reason:   attribFlagWording(PANEL_DISPLAY[cp.panelId], grade, missing),
            _attribFloored: true,
          });
          _attribFloored.push({ partName: PANEL_DISPLAY[cp.panelId] });
          action = 'floored';
        }
        assessment._attributionProbe.panels.push({
          panelId: cp.panelId, claim, verdict: r ? r.verdict : action,
          note: r ? r.note : '', frames, action,
        });
        console.log(`[ATTRIB PROBE] ${cp.panelId} ${r ? r.verdict : action} ${action} frames=${frameSource}`);
      }

      // Post-application prose scrub retired (4d/4e) — probe-floored panels set iv:false, so they
      // are in the claim binder's demoted set. KCD is code-assembled (floored parts absent from the
      // ledger by construction); Red Flags probe-floored claims are dropped by PART STATUS (class 4).
      // Single owner, not stacked. _attribFloored retained for the flag-push bookkeeping above.
    }
    // ── End attribution probe ───────────────────────────────────────────────────

    // Grille-set allowance detection: fires when per-view or aperture rule established
    // the front grille missing (_amalgMissing) and the main call did not price it.
    const grilleIsMissing     = coreObs.costedParts.some(cp => cp._amalgMissing === true && normName(cp.partName) === normName('front grille'));
    const grilleAlreadyPriced = rawParts.some(p => normName(p.name) === normName('front grille'));
    const grilleAllowance     = (grilleIsMissing && !grilleAlreadyPriced) ? 250 : 0;
    if (grilleAllowance > 0) console.log('[GRILLE BAND] front grille established missing, not in main-call Parts Breakdown — queuing £250 allowance');

    const bandKey = derivePriceBand(enrichedVd.bregoValuation?.trade_average_valuation ?? null);
    if (bandKey) {
      console.log(`[PRICE TABLE] band=${bandKey} (trade_avg=£${enrichedVd.bregoValuation.trade_average_valuation})`);
    } else {
      console.log('[PRICE TABLE] no trade_average_valuation — all panels retain model figures (Q2 fallback)');
    }

    // Spec-table lamp band, computed at request scope regardless of tier / lampObs — the tier-1 orphan
    // clamp (reconcileParts) needs a band even when the lamp machinery never fired (undisplaced front).
    // Detection is null here: the orphan path has no lamp-detect read; spec-table type (LED default when
    // indeterminate) owns it. Single owner of the resolution: resolveLampBand (shared with computeLampResult).
    const _specLampType = deriveLampType(enrichedVd);
    const { bandValue: specLampBand, lampTypeAssumed: specLampAssumed } = resolveLampBand(_specLampType, null);
    console.log(`[LAMP][SPEC-BAND] type=${_specLampType || 'indeterminate'} band=£${specLampBand} assumed=${specLampAssumed}`);

    const { parts: reconciledParts, allowanceParts } = reconcileParts(rawParts, lampResult, coreObs.costedParts, grilleAllowance, bandKey, specLampBand, specLampAssumed, HEADLAMP_BANDS[HEADLAMP_BAND_DEFAULT]);

    // Phase 2 — visibility gate (Test 1); lamp rows are rule-B paired. A1 (Vincent 5 Aug): a
    // precautionary (iv≠true) mandated lamp is now moved OUT of the repair total into an inspection
    // allowance — the gate returns those rows in gateAllowanceParts; merge them into allowanceParts
    // (same £0-in-total, band-shown-as-allowance treatment as the reconcileParts lamp allowances).
    const { gatedParts, gateAllowanceParts } = applyVisibilityGate(reconciledParts, coreObs.costedParts, coreObs.flaggedParts, lampResult);
    if (gateAllowanceParts?.length) allowanceParts.push(...gateAllowanceParts);
    _traceFlags('post-gate');

    // Tier-1 orphan clamp disclosure — reconcileParts marks assumed-LED orphan rows; the disclosure
    // follows the assumption, so emit the assumed-LED inspection flag here wherever such a row survives
    // the gate. computeLampResult carries the same disclosure as prose on the tier-2 assumed path; the
    // orphan has no prose surface, so it gets the flag instead. Single-owner wording: LAMP_ASSUMED_DISCLOSURE.
    for (const gp of gatedParts) {
      if (!gp._orphanAssumedDisclosure) continue;
      if (coreObs.flaggedParts.some(f => normName(f.partName) === normName(gp.name) && f._orphanLampDisclosure)) continue;
      coreObs.flaggedParts.push({
        partName: gp.name, zone: 'front', weight: 'medium',
        reason: LAMP_ASSUMED_DISCLOSURE, _orphanLampDisclosure: true, _gateGenerated: true,
      });
      console.log(`[LAMP ORPHAN] "${gp.name}" assumed-LED disclosure flag emitted`);
    }

    // Option G — inject code-owned cost lines for G-split COSTED instances.
    // These entries were filtered out of the model-facing ledger (see ledgerPreamble) so the
    // model emitted no Parts Breakdown row for them. Code prices them here from PANEL_PRICE_TABLE
    // at the lot's band figure. Injected post-gate: the gate only sees reconciledParts (model
    // output); injected rows are never gated, never deduped, summed by sumPartsRealistic identically
    // to any normal row. Two COSTED instances of the same panel → two injected lines → 2× table
    // figure. Locked Option A reconciliation is preserved: no new sum path, no divergence flag.
    for (const e of coreObs.costedParts) {
      if (!e._gOwned) continue;
      // Honour the bumper-off/gate demotion: a _gOwned entry that was demoted to inspection
      // (independentlyVisible=false / _bumperOffStripped) must NOT be re-costed here. The
      // demotion is a fact set on coreObs.costedParts; the gate already stripped the row and
      // moved it to inspection flags. Re-injecting full table cost would put a stripped panel
      // back into the repair total (it must stay in inspection flags only).
      if (e.independentlyVisible === false || e._bumperOffStripped === true) {
        console.log(`[G INJECT] ${e.panelId} skipped — demoted (iv=false/_bumperOffStripped); not re-costed`);
        continue;
      }
      if (!bandKey) {
        console.log(`[G INJECT] ${e.panelId} floored — no band (no Brego trade valuation)`);
        continue;
      }
      const tableEntry = PANEL_PRICE_TABLE[e.panelId]?.[bandKey];
      if (!tableEntry) {
        console.log(`[G INJECT] ${e.panelId} floored — no table entry for band "${bandKey}"`);
        continue;
      }
      const action = e._gSeverity === 'SEVERE' ? 'replace' : 'repair';
      // Strip any model-emitted row for this panel — model's row is non-deterministic (some runs
      // emit it, others don't). Code owns the cost for _gOwned panels via injection; the model
      // row would double-count if present. Reverse-iterate to splice safely in-place.
      let strippedCount = 0;
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        if (gatedParts[i].panelId === e.panelId) { gatedParts.splice(i, 1); strippedCount++; }
      }
      gatedParts.push({
        panelId:  e.panelId,
        name:     PANEL_DISPLAY[e.panelId],
        action,
        oem:      tableEntry.oem,
        used:     tableEntry.used,
        _tableMandated: true,
        _gOwned:  true,
      });
      console.log(`[G INJECT] ${e.panelId} stripped-model-rows=${strippedCount} action=${action} used=£${tableEntry.used} oem=£${tableEntry.oem} band=${bandKey}`);
    }

    // ── WHEEL / TYRE injection (Fault 3, table-sourced) ──────────────────────
    // Amalgamate-confirmed wheel/tyre damage (an iv=true entry in coreObs.costedParts)
    // frequently carries no model Parts Breakdown row → no cost line today. Inject the
    // band figure, mirroring G-inject. Strip any model wheel/tyre row first so a model
    // line can never double with the injected one. One row each, 1× (four-corner counting
    // deferred). Clean / na / hidden read → inject NEITHER (confirmed damage only).
    for (const [pid, logTag] of [[PANEL.WHEEL, 'WHEEL_INJECT'], [PANEL.TYRE, 'TYRE_INJECT']]) {
      const confirmed = coreObs.costedParts.some(cp => cp.panelId === pid && cp.independentlyVisible === true);
      if (!confirmed) continue;
      const wtEntry = bandKey ? PANEL_PRICE_TABLE[pid]?.[bandKey] : null;
      if (!wtEntry) {
        console.log(`[${logTag}] ${pid} confirmed iv=true but skipped — ${bandKey ? `no table entry for band "${bandKey}"` : 'no band (no Brego trade valuation)'}`);
        continue;
      }
      let wtStripped = 0;
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        if (gatedParts[i].panelId === pid) { gatedParts.splice(i, 1); wtStripped++; }
      }
      gatedParts.push({
        panelId: pid,
        name:    PANEL_DISPLAY[pid],
        action:  'replace',
        oem:     wtEntry.oem,
        used:    wtEntry.used,
        _tableMandated: true,
        _gOwned:  true,
      });
      console.log(`[${logTag}] ${pid} band=${bandKey} used=£${wtEntry.used} (oem=£${wtEntry.oem}) stripped-model-rows=${wtStripped}`);
    }

    // ── SRS airbag tier (CODE-owned from per-view enum + Copart paste) ───────────
    // THREE cleanly separated jobs — do not let them bleed:
    //   IN-PLAY = _srsGateOpen: the INDEPENDENT impact/interior signal (frontStruck / listing
    //             damage text / a per-view interior OTHER hit). SOLE in-play authority. A frontal
    //             cabin hit must gate OPEN so it reaches the flag path, never a silent £0.
    //   DEPLOYMENT = CODE-owned, structured: the per-view AIRBAG enum (a SEEN deployed bag —
    //             authoritative) OR the Copart paste "airbags deployed" match (corroborator).
    //             NOT prose — prose wobbles (VXZ2849: both bags deployed, prose underplayed →
    //             the retired CALL2 field read all-unknown → £0). Enum is ground truth.
    //   TIER    = srsTierFromSignals: paste explicitly names curtain/side → T3; names driver AND
    //             passenger → T2; deployment confirmed but count unresolvable → T1 CONFIDENT FLOOR
    //             (never £0) + inspect-for-extent flag. £900/T2 must be EARNED by ≥2-bag evidence,
    //             never floored blind. Band lookup + SRS_AIRBAG_T{n} rows UNCHANGED.
    const SRS_ROW_RE = /\bair\s?bags?\b|\bsrs\b|supplementary restraint|restraint system/i;
    // Strip the model's free-text airbag row(s) from the repair total (mirror G-inject); returns count.
    const stripModelAirbagRows = () => {
      let n = 0;
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        if (gatedParts[i].panelId === PANEL.AIRBAG || SRS_ROW_RE.test(gatedParts[i].name || '')) { gatedParts.splice(i, 1); n++; }
      }
      return n;
    };
    // Drop flag-class AIRBAG inspection entries; returns count. Each terminal path below
    // re-establishes the SINGLE canonical airbag signal (costed line [+ extent flag], or one
    // defer flag) — the raw amalgamate detection is collapsed INTO that, never silently discarded.
    const suppressAirbagFlags = () => {
      let n = 0;
      for (let i = coreObs.flaggedParts.length - 1; i >= 0; i--) {
        if (coreObs.flaggedParts[i].panelId === PANEL.AIRBAG) { coreObs.flaggedParts.splice(i, 1); n++; }
      }
      return n;
    };

    // DEPLOYMENT — CODE-owned from the per-view AIRBAG enum (authoritative), corroborated by paste.
    const _airbagVotes    = pvResult.pvVotesMap?.AIRBAG ?? null;
    const _airbagEnumFlag = coreObs.flaggedParts.some(f => f.panelId === PANEL.AIRBAG);
    const _deploymentByEnum = (_airbagVotes?.damaged > 0) || _airbagEnumFlag;
    const _srsPaste = analyseAirbagPaste(enrichedVd.rawCopartPaste);
    const srsT = srsTierFromSignals(_deploymentByEnum, _srsPaste);

    // IN-PLAY gate — §3 THIRD-DOOR FIX (Vincent, 29 Aug). Previously this gate opened on
    // `frontStruck || /front|cabin|.../.test(enrichedVd.primaryDamage/secondaryDamage)` — i.e. on the
    // COPART DAMAGE LABEL, a staff guess withheld from perception (batch 73). Its "Front End" on
    // DL72FVX opened the gate and produced an airbag-unconfirmed HIGH defer flag on an UNDEPLOYED BEV.
    // The label must not author the SRS gate code-side either. The gate now opens ONLY on genuine,
    // independent evidence: a per-view interior OTHER hit the model actually saw, OR confirmed airbag
    // deployment (enum/paste, via srsT.deploymentConfirmed). This preserves every real cost path
    // (deployment ⟹ gate open ⟹ tier costed) and the perception-based defer (interior vision, no
    // deployment), and drops ONLY the label-driven phantom. frontStruck/rearStruck are UNTOUCHED at
    // source — they still force recordImpactObservation (run 4) — they are simply no longer read here.
    const _srsInteriorVision = coreObs.costedParts.some(cp =>
      cp.panelId === PANEL.OTHER && cp.zone === 'interior' && cp.independentlyVisible === true);
    const _srsGateOpen = _srsInteriorVision || srsT.deploymentConfirmed;
    let srsInjected = false;
    let srsDeferred = false;
    console.log(`[SRS_TIER] gateOpen=${_srsGateOpen} (interiorVision=${_srsInteriorVision} deploymentConfirmed=${srsT.deploymentConfirmed}; label no longer opens the gate) enumDeployed=${_deploymentByEnum} (votes=${_airbagVotes?.damaged ?? 0} amalgFlag=${_airbagEnumFlag}) paste={deployed:${_srsPaste.deployed},intact:${_srsPaste.intact},curtainSide:${_srsPaste.curtainSide},bothFront:${_srsPaste.bothFront}} → tier=${srsT.tier ? 'T' + srsT.tier : 'none'} confident=${srsT.confident} countResolved=${srsT.countResolved} branch=${srsT.branch}`);

    if (_srsGateOpen && srsT.deploymentConfirmed) {
      // Deployment CERTAIN (enum and/or paste). Cost the tier — T1 is a confident FLOOR, never £0.
      const srsEntry = bandKey ? PANEL_PRICE_TABLE[`SRS_AIRBAG_T${srsT.tier}`]?.[bandKey] : null;
      if (!srsEntry) {
        // No band → no table price for ANY panel (Q2 fallback). Retain the model's airbag treatment
        // AND the real amalgamate AIRBAG flag (not suppressed) as the honest buyer signal.
        console.log(`[SRS_TIER] tier=T${srsT.tier} confident but ${bandKey ? `no table entry for band "${bandKey}"` : 'no band (no Brego trade valuation)'} — model airbag treatment + amalgamate flag retained (band-independent fallback, as all panels)`);
      } else {
        const srsStripped = stripModelAirbagRows();
        console.log(`[SRS_STRIP] removed ${srsStripped} model airbag row(s) from repair total`);
        gatedParts.push({
          panelId: 'SRS_AIRBAG', // injection-only sentinel, distinct from PANEL.OTHER
          name:    'SRS airbag kit (deployed)',
          action:  'replace',
          oem:     srsEntry.oem,
          used:    srsEntry.used,
          _tableMandated: true,
          _gOwned:  true,
        });
        srsInjected = true;
        const srsFlagDropped = suppressAirbagFlags(); // collapse the raw amalgamate flag INTO the canonical signal
        console.log(`[SRS_INJECT] tier=T${srsT.tier} band=${bandKey} used=£${srsEntry.used} (oem=£${srsEntry.oem}) branch=${srsT.branch} countResolved=${srsT.countResolved} collapsed-airbag-flags=${srsFlagDropped}`);
        if (!srsT.countResolved) {
          // Deployment certain, count unresolvable → the costed T1 floor is paired with an
          // inspect-for-extent flag (NOT a "confirm whether deployed" flag — deployment is certain).
          coreObs.flaggedParts.push({
            panelId: PANEL.AIRBAG, partName: PANEL_DISPLAY[PANEL.AIRBAG], zone: 'interior', weight: 'high',
            reason: 'SRS airbags deployed — at least one bag confirmed; confirm full extent (driver / passenger / curtain / side) on inspection to finalise cost.',
            _srsExtentFloor: true,
          });
          console.log('[SRS_TIER] T1 CONFIDENT FLOOR — deployment certain, count unresolvable → SRS_AIRBAG_T1 cost + inspect-for-extent flag');
        }
      }
    } else if (_srsGateOpen && _srsPaste.intact) {
      // Gate open, no deployment evidence, and the paste EXPLICITLY states airbags intact/undeployed
      // → genuine no-deployment read → no cost, no flag.
      console.log('[SRS_TIER] no SRS cost/flag — gate open but paste explicitly states airbags not deployed');
    } else if (_srsGateOpen) {
      // Gate open, NO deployment signal (enum or paste) and no explicit-intact statement → the honest
      // defer flag. This is the ONLY path that still says "confirm whether deployed" — and only when
      // there is genuinely no deployment evidence. Strip any unreliable model £; £0 + inspect flag.
      const srsStripped = stripModelAirbagRows();
      suppressAirbagFlags();
      coreObs.flaggedParts.push({
        panelId: PANEL.AIRBAG, partName: PANEL_DISPLAY[PANEL.AIRBAG], zone: 'interior', weight: 'high',
        reason: 'Interior/cabin disturbance visible in the photos but airbag deployment not confirmed — confirm whether the SRS airbags deployed on inspection before bidding.',
        _srsDeferred: true,
      });
      srsDeferred = true;
      console.log(`[SRS_TIER] DEFER — gate open, no deployment signal (enum/paste) → inspect flag, no price; stripped-model-rows=${srsStripped}`);
    } else {
      console.log('[SRS_TIER] no SRS cost/flag — gate closed (no front/cabin/interior signal)');
    }

    // ── Coachbuilt body-panel strip (Stage 5) ────────────────────────────────
    // When body class resolves to coachbuilt, the van/pickup body panels are
    // out-of-model. Cab/front panels (not in COACHBUILT_BODY_PANELS) are retained.
    if (bodyClassResult.bodyClass === 'coachbuilt') {
      const strippedPanels = [];
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        if (COACHBUILT_BODY_PANELS.has(gatedParts[i].panelId)) {
          strippedPanels.push(gatedParts[i].panelId);
          gatedParts.splice(i, 1);
        }
      }
      // Mirror strip in coreObs.flaggedParts (removes flags for stripped panels)
      for (let i = coreObs.flaggedParts.length - 1; i >= 0; i--) {
        if (COACHBUILT_BODY_PANELS.has(coreObs.flaggedParts[i].panelId)) {
          coreObs.flaggedParts.splice(i, 1);
        }
      }
      console.log(`[COACHBUILT] body-panel strip: removed [${strippedPanels.join(', ')}]. Cab/front section retained.`);
      // Inject a high-weight flag so the buyer knows the body is out of model
      coreObs.flaggedParts.push({
        panelId: null,
        partName: 'Coachbuilt body — out of model',
        zone: 'rear',
        weight: 'high',
        reason: 'Coachbuilt specialist body detected — body structure not in model. Cost above covers cab/front section only. Inspect the full load body on site before bidding.',
      });
    }

    // ── Body-class panel-eligibility gate (Stage 5, allow-set) ───────────────
    // Strip any costed/flagged panel that the resolved bodyClass cannot carry
    // (e.g. a BOOT_LID costed on a pickup, or van body panels on a car). Mirrors
    // the coachbuilt deny-strip above. Bypass by construction: bodyClass === null
    // (pre-Part-1, no enforcement) and 'coachbuilt' (own deny-strip) are absent
    // from ELIGIBLE_PANELS → _eligibleSet undefined → skip; 'UNRESOLVED' throws
    // upstream and never reaches here. Only car/panel_van/pickup/minibus gate.
    const _eligibleSet = ELIGIBLE_PANELS[bodyClassResult.bodyClass];
    if (_eligibleSet) {
      const removed = [];
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        const pid = gatedParts[i].panelId;
        // Strip only KEYED panel rows outside the allow-set. Non-panel rows
        // (labour / paint / sundries / blend — no panelId, see parts.mjs gate)
        // are never cross-body misattributions; leave them in the total.
        // SRS_AIRBAG is a code-injected sentinel (not a real PANEL, so absent from
        // ELIGIBLE_PANELS) — exempt it: a deployed-airbag kit is valid on every body
        // class and must survive this gate (it is injected just above, in the SRS block).
        if (pid != null && pid !== 'SRS_AIRBAG' && !_eligibleSet.has(pid)) {
          removed.push(pid);
          gatedParts.splice(i, 1);
        }
      }
      // Mirror strip in coreObs.flaggedParts. Null-panelId flags (free-text/structural
      // prose, coachbuilt notice) are never keyed — leave them untouched.
      for (let i = coreObs.flaggedParts.length - 1; i >= 0; i--) {
        const pid = coreObs.flaggedParts[i].panelId;
        if (pid != null && !_eligibleSet.has(pid)) {
          coreObs.flaggedParts.splice(i, 1);
        }
      }
      console.log(`[BODY_CLASS_STRIP] bodyClass=${bodyClassResult.bodyClass} removed=[${removed.join(', ')}]`);
    }

    // ── Door-count strip (Stage 5) ───────────────────────────────────────────
    // A body with ≤3 doors physically has no REAR_DOOR — a rear car door is a
    // 4/5-door-only panel. Strip any REAR_DOOR row when the listing AFFIRMS ≤3
    // doors (e.g. a 3-door Defender 90), mirroring BODY_CLASS_STRIP's mechanism
    // and pipeline point exactly. REAR_QUARTER and all other panels are untouched
    // — a genuinely torn rear quarter survives this strip.
    // FAIL OPEN: extractDoorCount returns null when the paste has no door token.
    // null = unknown, NOT a default — we strip ONLY on an affirmative ≤3 reading,
    // so a missing/legacy paste field can never delete a real REAR_DOOR on a 5-door.
    const _doorCount = extractDoorCount(enrichedVd.rawCopartPaste);
    if (_doorCount !== null && _doorCount <= 3) {
      let _doorStripped = 0;
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        if (gatedParts[i].panelId === PANEL.REAR_DOOR) { gatedParts.splice(i, 1); _doorStripped++; }
      }
      // Mirror strip in coreObs.flaggedParts (removes any REAR_DOOR flag too).
      for (let i = coreObs.flaggedParts.length - 1; i >= 0; i--) {
        if (coreObs.flaggedParts[i].panelId === PANEL.REAR_DOOR) { coreObs.flaggedParts.splice(i, 1); }
      }
      console.log(`[DOOR_STRIP] doors=${_doorCount} (≤3) → REAR_DOOR removed (cost rows=${_doorStripped})`);
    } else {
      console.log(`[DOOR_STRIP] doors=${_doorCount === null ? 'unknown' : _doorCount} → no strip (fail-open)`);
    }

    // EV-integrity Step 1 — code-derived BEV fact (DVLA precedence; live-feed strings).
    // Dash read is awaited HERE (its promise was fired early at the per-view stage, :~2739) so its
    // HV-marking evidence can OR into isBev and its telltales can drive the EV/HV flag below — all
    // BEFORE the Step-2 weight-sort. This is a reorder of the single existing await, not a new
    // call; the _dashState / sticker / _dashLine assignments further down reuse this same dashRead.
    const dashRead = await dashReadPromise;
    const hvEvidence = hvLabelSeen || dashRead.hvMarkings === true;
    const isBev = isBevLot(enrichedVd, hvEvidence);
    assessment._isBev = isBev;
    console.log(`[EV GATE] isBev=${isBev} (DVLA fuelType="${enrichedVd.fuelType ?? ''}" listing fuel="${enrichedVd.fuel ?? ''}" hvLabelSeen=${hvLabelSeen} dashHvMarkings=${dashRead.hvMarkings})`);

    // EV-integrity Step 2 — EV_BATTERY_PRESENCE flag enrich (FLAG-ONLY: reason + weight only).
    // Mirrors the aperture-reason post-call mutation on coreObs.flaggedParts, but BEFORE the
    // weight-sort below since weight changes. Fires ONLY when isBev — non-EV / HYBRID ELECTRIC /
    // ICE lots are byte-identical. Mutates ONLY the flagged entry; the floored costedPart is
    // never touched (no price, no iv flip, no zone change). Never asserts absence: positive
    // inference only from runs-and-drives, otherwise cannot-confirm → inspect.
    if (isBev) {
      const runsAndDrives = /runs?\s+and\s+drives?/i.test(enrichedVd.runCondition || '');
      for (const flag of coreObs.flaggedParts) {
        if (flag.panelId !== PANEL.EV_BATTERY_PRESENCE) continue;
        flag.weight = runsAndDrives ? 'low' : 'medium';
        flag.reason = runsAndDrives ? EV_BATTERY_REASON_RUNS : EV_BATTERY_REASON_UNCONFIRMED;
        flag._evPresence = true;
        console.log(`[EV PRESENCE] EV_BATTERY_PRESENCE → weight=${flag.weight} (runsAndDrives=${runsAndDrives}, runCondition="${enrichedVd.runCondition ?? ''}")`);
      }
    }

    // EV-integrity Step 3 — EV/HV telltale → high-weight expensive-repair flag. Pushed directly to
    // coreObs.flaggedParts (the surviving per-assessment pattern — never through amalgamate). Fires
    // whenever the cluster shows a warning AND an EV/HV telltale is read (a warning is a warning —
    // NOT gated on isBev). This is the ONLY consequence rule built here; coolant→rad-pack is Step 4.
    // The flag always fires; only wording strength is gated by TELLTALE_CONFIDENT_WORDING (OFF).
    const _evHvTelltales = dashRead.cluster === 'warning'
      ? dashRead.telltales.filter(t => EV_HV_SET.includes(t))
      : [];
    if (_evHvTelltales.length > 0) {
      const reason = TELLTALE_CONFIDENT_WORDING
        ? 'EV/HV system warning lit on the cluster — high-voltage battery / EV-system fault indicated; expensive specialist repair likely. Confirm with an EV diagnostic before bidding.'
        : 'EV/HV system warning lit on the cluster — possible high-voltage battery / EV-system fault; potentially expensive to resolve. Have an EV diagnostic read the fault code before bidding.';
      coreObs.flaggedParts.push({
        panelId: null, partName: 'EV/HV system warning', zone: 'interior',
        weight: 'high', reason, _evHvTelltale: true,
      });
      console.log(`[EV HV TELLTALE] flagged — telltales=[${_evHvTelltales.join(',')}] confidentWording=${TELLTALE_CONFIDENT_WORDING}`);
    }

    // ── EV-integrity Step 5 — cooling/HV governing verdict ───────────────────
    // Single governing EV verdict on BEV lots. Three-tier: cost-prohibitive (tier 1, ≥2-view SEVERE
    // corroboration of EV_BATTERY_ZONE — positive photographic evidence only), inspect (tier 2,
    // default under false-positive-preferred), clear (tier 3, all-green running lot). Subsumes the
    // Step-2 presence flag and Step-3 telltale flag so the report never ships duplicate EV flags.
    // Money-neutral: tiers move no cost; tier 1 is VERDICT LANGUAGE (Red Flags lead + margin caveat
    // at :C site) — repair total / exit band / margin maths untouched. Runs after the Step-3 push so
    // both prior flags are present to subsume; before the :_flaggedParts snapshot so removals land.
    if (isBev) {
      const ez = pvResult.pvVotesMap?.EV_BATTERY_ZONE ?? null; // null = model never observed the pack
      const ezSevere  = (ez?.severeVotes ?? 0) >= 2;           // ≥2-view SEVERE corroboration gate
      const ezDamaged = (ez?.damaged ?? 0) > 0;
      const dashWarning = dashRead.cluster === 'warning';
      const dashClean   = dashRead.cluster === 'clean';        // 'no-photo' is NOT clean → never tier 3
      const radFloored  = assessment._radPackDisposition === 'floored';
      const runsAndDrives = /runs?\s+and\s+drives?/i.test(enrichedVd.runCondition || '');
      const hardSignal = dashWarning || radFloored || ezDamaged;

      let verdict, tier;
      if (ezSevere)                                                        { verdict = 'cost-prohibitive'; tier = 1; }
      else if (dashClean && runsAndDrives && !radFloored && !ezDamaged)    { verdict = 'clear';            tier = 3; }
      else                                                                 { verdict = 'inspect';          tier = 2; }

      // Subsume prior EV flags into the single verdict. Tier 1/2 remove the Step-2 presence flag, the
      // Step-3 telltale flag, AND the raw EV_BATTERY_ZONE amalgamate flag; tier 3 removes the presence
      // flag only (no telltale/pack damage exists on an all-green lot).
      const _before = coreObs.flaggedParts.length;
      coreObs.flaggedParts = coreObs.flaggedParts.filter(f => tier === 3
        ? !(f._evPresence)
        : !(f._evPresence || f._evHvTelltale || f.panelId === PANEL.EV_BATTERY_ZONE));
      const _subsumed = _before - coreObs.flaggedParts.length;

      assessment._evCoolingHvVerdict = verdict;
      assessment._evCoolingHvEvidence = {
        tier, severeVotes: ez?.severeVotes ?? 0, dashCluster: dashRead.cluster,
        telltales: dashRead.telltales ?? [], radDisposition: assessment._radPackDisposition ?? null,
        runsAndDrives, packViewed: ez !== null,
      };

      if (tier === 1) {
        // Tier-1 flag only here; the cost-prohibitive Red Flags LEAD is injected post-binder (4f C-2),
        // so it is exempt from bindClaimClasses BY SEQUENCE rather than by a fragile prefix match.
        coreObs.flaggedParts.push({ panelId: PANEL.EV_BATTERY_ZONE, partName: 'HV battery pack', zone: 'underside', weight: 'high', reason: EV_VERDICT_TIER1_FLAG, _evVerdict: 'cost-prohibitive' });
      } else if (tier === 2) {
        coreObs.flaggedParts.push({ panelId: PANEL.EV_BATTERY_ZONE, partName: 'HV battery / EV system', zone: 'interior', weight: 'high', reason: hardSignal ? EV_VERDICT_TIER2_HARD : EV_VERDICT_TIER2_SOFT, _evVerdict: 'inspect' });
      } else {
        coreObs.flaggedParts.push({ panelId: PANEL.EV_BATTERY_ZONE, partName: 'HV battery', zone: 'underside', weight: 'low', reason: EV_VERDICT_TIER3_NOTE, _evVerdict: 'clear' });
      }
      console.log(`[EV VERDICT] tier=${tier} verdict=${verdict} ezSevere=${ez?.severeVotes ?? 0} dash=${dashRead.cluster} radDispo=${assessment._radPackDisposition ?? 'none'} runsAndDrives=${runsAndDrives} hardSignal=${hardSignal} subsumed=${_subsumed} flag(s)`);
    }

    // ── Rear-closure display label by body shape (LABEL ONLY) ────────────────
    // Estates/tourings/avants/sportbrakes/5-door/hatchbacks have a TAILGATE; saloons,
    // coupes and 4-door cars have a BOOT LID. Indeterminate → Boot lid (safe default).
    // Derived from held data (Brego vehicle_desc / listing body style / Copart paste /
    // damage description) — NO API call. This rewrites ONLY the buyer-facing display name
    // on BOOT_LID cost rows and flags; the enum ID stays BOOT_LID and the cost / flag /
    // vote / gate logic is untouched. No new panel.
    const REAR_CLOSURE_TAILGATE = /\b(estate|touring|avant|sport[\s-]?brake|shooting[\s-]?brake|5[\s-]?dr|5[\s-]?door|hatch(?:back)?)\b/i;
    const _rearBlob = [enrichedVd.bregoValuation?.vehicle_desc, enrichedVd.bodyStyle, enrichedVd.rawCopartPaste, enrichedVd.damageDescription]
      .filter(Boolean).join(' ');
    const _rearClosureLabel = REAR_CLOSURE_TAILGATE.test(_rearBlob) ? 'Tailgate' : 'Boot lid';
    if (_rearClosureLabel !== 'Boot lid') {
      const _isBootLid = (pid, nm) => pid === PANEL.BOOT_LID || /\bboot[\s-]?lid\b|\btrunk[\s-]?lid\b/i.test(nm || '');
      let _relabelled = 0;
      for (const p of gatedParts)           if (_isBootLid(p.panelId, p.name))     { p.name = _rearClosureLabel; _relabelled++; }
      for (const f of coreObs.flaggedParts) if (_isBootLid(f.panelId, f.partName)) { f.partName = _rearClosureLabel; _relabelled++; }
      if (_relabelled > 0) console.log(`[REAR CLOSURE] body indicates tailgate → relabelled ${_relabelled} BOOT_LID entry(ies) "${_rearClosureLabel}"`);
    }

    // ── Struck-zone set for zone-aware not-visible flag suppression (Task 6, no new call) ──
    // Authoritative damage zones the model classified (coreObs.perZone — ANY eventType, so a
    // thermal/flood zone still protects its panels) ∪ the listing-derived front/rear. Enable
    // suppression ONLY on a confidently SINGLE struck zone that is NOT the roof; multi-zone
    // (≥2), rollover (roof struck), or no-known-zone → _suppressActive=false → buildBuyerFlags
    // suppresses NOTHING (fail-open). Stored on the assessment because BOTH buyer surfaces (the
    // server checklist seed and the client Inspection Flags render) call buildBuyerFlags.
    // Amalgamate floor logic is untouched — this only governs what reaches the buyer.
    const _struckZoneSet = new Set((coreObs.perZone || []).map(z => z?.zone).filter(Boolean));
    if (frontStruck) _struckZoneSet.add('front');
    if (rearStruck)  _struckZoneSet.add('rear');
    assessment._struckZones    = [..._struckZoneSet];
    assessment._suppressActive = _struckZoneSet.size === 1 && !_struckZoneSet.has('roof');
    console.log(`[FLAG SUPPRESS] struckZones=[${assessment._struckZones.join(', ')}] suppressActive=${assessment._suppressActive} (perZone=${(coreObs.perZone || []).length} frontStruck=${frontStruck} rearStruck=${rearStruck})`);

    _traceFlags('pre-invariant');
    // ── §2 LEDGER/FLAG INVARIANT (batch 81) ────────────────────────────────────────────────────────
    // Every panel amalgamate DECIDED ABOUT — a disagree floor OR a single-unsupported-MINOR (Ruling 2) —
    // must reach the buyer as exactly one inspection flag. Silent clearance is the defect, at either
    // threshold (DL72FVX: WHEEL_ARCH_MOULDING was disagree-floored, its flag pushed by amalgamate, then
    // removed by a downstream splice with NO log line — costed nothing, warned nothing, the one item
    // physically confirmed as damaged vanished without trace). Finding the splice is the §9 seam's job;
    // THIS is what stops the next one — a code-owned backstop that re-establishes the flag from the
    // authoritative marker on coreObs.costedParts, regardless of which splice removed it. Runs after all
    // amalgamate/flank/gate mutations and just before the _flaggedParts snapshot. Additive only: never
    // removes a flag, never a cost, never touches parts_sum. Markers are kept accurate upstream — sticky
    // rescue and the bonnet skin-read both delete _amalgDisagree when they genuinely resolve a disagree,
    // so a rescued/re-cleared panel is not re-flagged here.
    {
      let _reAdded = 0;
      for (const cp of coreObs.costedParts) {
        const isDisagree = cp._amalgDisagree === true && cp.independentlyVisible === false && !cp._perViewClear;
        const isSingleMinor = cp._amalgSingleMinor === true;
        if (!isDisagree && !isSingleMinor) continue;
        if (coreObs.flaggedParts.some(f => f.panelId === cp.panelId)) continue;   // a flag for this panel already survives
        coreObs.flaggedParts.push(isDisagree
          ? { panelId: cp.panelId, partName: cp.partName ?? PANEL_DISPLAY[cp.panelId] ?? cp.panelId, zone: cp.zone, weight: 'medium', reason: AMALG_REASON_DISAGREE, _amalgDisagree: true, _invariantReAdded: true }
          : { panelId: cp.panelId, partName: cp.partName ?? PANEL_DISPLAY[cp.panelId] ?? cp.panelId, zone: cp.zone, weight: 'low', reason: AMALG_REASON_SINGLE_MINOR, _amalgSingleMinor: true, _invariantReAdded: true });
        _reAdded++;
        console.error(`[LEDGER/FLAG INVARIANT] ${cp.panelId} was ${isDisagree ? 'disagree-floored' : 'single-MINOR'} but had NO surviving flag — a downstream splice removed it silently; flag RE-ESTABLISHED. Investigate the remover (§9 seam).`);
      }
      if (_reAdded === 0) console.log('[LEDGER/FLAG INVARIANT] all disagree / single-MINOR panels retained their flag — no re-add needed');
    }

    assessment._flaggedParts = [...coreObs.flaggedParts].sort((a, b) =>
      ({'high': 0, 'medium': 1, 'low': 2}[a.weight] ?? 1) -
      ({'high': 0, 'medium': 1, 'low': 2}[b.weight] ?? 1)
    );

    // Aperture-confusion reason (Step 4c — Path 2a: post-call, NOT in amalgamate).
    // amalgamate runs pre-main-call and cannot know apertureExposed; lampObs is a
    // main-call output. The aperture reason is therefore set HERE, on the ledger flag
    // entry, keyed by panelId — replacing the former post-hoc flag overwrite. A DISAGREE
    // floor sitting behind a confirmed displaced bumper is not genuine disagreement: the
    // entry carries the neutral exposed-aperture wording natively, which the assembled VDS
    // reads. (assessment._flaggedParts shares object refs with coreObs.flaggedParts, so
    // the buyer flags list updates in lockstep.)
    if (lampObs) {
      const apertureMap = new Map();
      if (lampObs.rearApertureExposed === true) apertureMap.set(PANEL.REAR_QUARTER, AMALG_REASON_APERTURE_REAR);
      if (lampObs.apertureExposed     === true) apertureMap.set(PANEL.FRONT_WING,   AMALG_REASON_APERTURE_WING);
      if (lampObs.apertureExposed     === true) apertureMap.set(PANEL.HEADLAMP,     AMALG_REASON_APERTURE_LAMP);
      if (apertureMap.size > 0) {
        for (const flag of coreObs.flaggedParts) {
          if (flag._amalgDisagree && apertureMap.has(flag.panelId)) {
            console.log(`[APERTURE-REASON] "${flag.partName}" reason set on ledger entry (aperture-confusion, not genuine disagreement)`);
            flag.reason = apertureMap.get(flag.panelId);
            flag._amalgAperture = true;
          }
        }
      }
    }

    // EV-integrity dash/cluster read joins here (fields set from the SAME dashRead awaited earlier
    // at the isBev step — no second await). Fires on ALL lots; extracts sticker suffix + body-style
    // mismatch (Part C) so Call-2 no longer mines prose for those values.
    assessment._dashState  = dashRead.cluster;
    assessment._airbagState = dashRead.airbag;
    console.log(`[DASH READ] cluster=${dashRead.cluster} airbag=${dashRead.airbag} telltales=[${dashRead.telltales.join(',')}] hvMarkings=${dashRead.hvMarkings}`);

    // Part B — body-style owner: Brego vehicle_desc (code-owned for all GB lots with a live
    // valuation call). Degrades gracefully to make/model/year if vehicle_desc absent (~7%
    // of lots where Brego is unavailable). Never fabricates a class word.
    assessment._bodyStyle = enrichedVd.bregoValuation?.vehicle_desc ||
      [enrichedVd.make, enrichedVd.model, enrichedVd.year].filter(Boolean).join(' ') || null;

    // Part C — sticker suffix from vision dash-read, with a targeted re-read on a miss (frame-ID +
    // full-res Opus read; full-set fallback). Fires ONLY when the primary read is a miss ("" or
    // UNREADABLE); a valid primary letter short-circuits — the retry fills misses, never overrides.
    const _primarySticker = dashRead.sticker;
    let _finalSticker = _primarySticker;
    let _stickerRetry = { fired: false, primary: _primarySticker, frameSource: null, final: _primarySticker };
    if (_primarySticker === '' || _primarySticker === 'UNREADABLE') {
      // windscreenLabel frames come from the always-run frame-zone pass (already sanitised to in-range
      // unique indices). Full-set fallback is load-bearing: pass failed OR zero windscreenLabel frames
      // → _wlFrames=[] → runStickerRead re-reads the FULL set (broad retry, never no-retry).
      const _wlFrames = _frameZones.ok ? _frameZones.frames.filter(f => f.windscreenLabel).map(f => f.i) : [];
      console.log(`[STICKER RETRY] windscreenLabel frames=${_wlFrames.length ? _wlFrames.join(',') : 'none'} source=${_frameZones.ok ? 'frame-zone' : 'frame-zone-failed'}`);
      console.log(`[STICKER RETRY] primary="${_primarySticker}" → fired (frames=${_wlFrames.length || 'all'})`);
      const _retry = await runStickerRead(images, _wlFrames, () => _exhaustedCalls.add('sticker-read'));
      if (STICKER_LEGIBLE.includes(_retry)) {
        _finalSticker = _retry;                                               // retry rescued a legible letter
        console.log(`[STICKER RETRY] result=${_retry} adopted`);
      } else {
        // both passes missed — keep the two states distinct; UNREADABLE (from either pass) beats "".
        _finalSticker = (_primarySticker === 'UNREADABLE' || _retry === 'UNREADABLE') ? 'UNREADABLE' : '';
        console.log(`[STICKER RETRY] result=${_finalSticker === 'UNREADABLE' ? 'unreadable' : 'confirmed-empty'}`);
      }
      _stickerRetry = { fired: true, primary: _primarySticker, frameSource: _wlFrames.length ? `frame-zone:[${_wlFrames.join(',')}]` : 'full-set-fallback', final: _finalSticker };
    }
    assessment._stickerRetry = _stickerRetry;

    // Backfill coreObs.windscreenSticker so resolveVendorSuffix() works unchanged downstream. The two
    // miss states are preserved (no collapse): stickerSeen=true means a sticker was seen but its suffix
    // is illegible; false means no sticker was seen at all. Both keep visible=false → resolveVendorSuffix
    // status 'absent' → the tier system stays correctly silent; only the checklist wording splits.
    assessment._stickerSuffix = _finalSticker || 'UNREADABLE';
    coreObs.windscreenSticker = {
      visible:      Boolean(_finalSticker && _finalSticker !== 'UNREADABLE'),
      suffixLetter: _finalSticker || 'UNREADABLE',
      stickerSeen:  _finalSticker === 'UNREADABLE',
    };
    coreObs.bodyStyleMismatch = dashRead.bodyStyleMismatch || 'unclear';
    console.log(`[BODY/STICKER] bodyStyle="${assessment._bodyStyle}" stickerSuffix=${assessment._stickerSuffix} bodyStyleMismatch=${coreObs.bodyStyleMismatch} retryFired=${_stickerRetry.fired}`);

    // Assemble code-owned dashboard line (replaces model VDS cluster assertion).
    // batch 75 §2a: distinguish "no cluster photograph at all" from "cluster photographed but unlit".
    // The read declining a dark cluster is CORRECT (you cannot read telltales off it) — but "not
    // visible" reads as a missed photo. "Unlit because the car is a non-runner" is true and useful.
    const _dashLine = dashRead.cluster === 'warning'
      ? `Dashboard read: warning light(s) shown — ${dashRead.telltales.map(t => TELLTALE_LABELS[t] || t).join(', ')}`
      : dashRead.cluster === 'clean'
      ? 'Dashboard read: cluster lit, no warning lights shown.'
      : dashRead.cluster === 'unlit'
      ? 'The instrument cluster is photographed but unlit — the vehicle is a non-runner, so warning-lamp and airbag state cannot be read from it.'
      : 'No dashboard photograph in the listing.';
    assessment._dashLine = _dashLine;

    // Assemble code-owned Airbags line from _airbagState (overwrites any model-authored field).
    // When a costed SRS kit was injected (srsInjected — the confident-tier path), the injected
    // line + Red Flags ARE the authoritative deployment record — POINT to them here instead of
    // letting the cluster-telltale read assert "no deployed bags visible" and contradict the
    // £-charged SRS line. When deployment was DEFERRED (srsDeferred — gate open, extent
    // unresolved, £0 + inspect flag), point to the inspect flag rather than assert a cluster
    // verdict that would contradict it. Otherwise (no SRS cost/flag) the cluster-telltale text is
    // byte-for-byte unchanged — a genuinely undeployed lot still reads its real cluster verdict.
    assessment['Airbags'] = srsInjected
      ? 'Airbag deployment is detailed in the repair breakdown (SRS airbag kit) and Red Flags above — confirm full extent on inspection.'
      : srsDeferred
      ? 'Airbag deployment could not be fully confirmed from the listing — see Red Flags; confirm SRS status and extent on inspection.'
      : dashRead.airbag === 'warning-lit'
      ? 'Airbag warning light shown on the cluster — airbag system fault or deployment likely; confirm on inspection.'
      : dashRead.airbag === 'not-lit'
      ? 'No airbag warning light shown on the cluster; no deployed bags visible in the cabin shots. Confirm on inspection.'
      : dashRead.cluster === 'unlit'
      ? 'The instrument cluster is photographed but unlit (non-runner) — airbag warning state cannot be read from it. Confirm on inspection.'
      : 'No dashboard photograph in the listing — airbag state could not be confirmed. Confirm on inspection.';

    // 529 abort decision — fires before report assembly.
    // ABORT if any single-instance call exhausted (Call-1/Call-2/lamp-detect/dash-read),
    // or if more than 2 per-view calls exhausted (3+ lost = beyond redundancy).
    {
      const singleExhausted = ['call1', 'call2', 'lamp-detect', 'dash-read']
        .some(k => _exhaustedCalls.has(k));
      const shouldAbort = singleExhausted || _pvExhaustedCount > 2;
      if (shouldAbort) {
        const reason = singleExhausted ? 'singleInstanceCall' : 'perView>2';
        console.error(`[529 ABORT] reason=${reason} exhausted=[${[..._exhaustedCalls].join(', ')}]`);
        throw new AssessmentOverloadedError(reason);   // route envelope resets status + refunds + 503
      } else if (_exhaustedCalls.size > 0) {
        console.log(`[529 OK] degraded-within-tolerance lostViews=${_pvExhaustedCount}`);
      }
    }

    // ── Parts-completeness (batch 61 rewrite, lib/partsCompleteness) — LAST mutation of gatedParts
    // before parts_sum, and after the _flaggedParts snapshot so buildBuyerFlags sees the survivors.
    // Fix B FIRST (adds fog rows + fog flags) so Fix A's survivor check already sees any fog flag.
    {
      // Fix B — fogs follow the bumper. Bumper gone ⇒ both that-end fogs costed (seeded from the fog
      // price band, or flagged if no band). Bumper intact + one fog ⇒ "check the second" flag only.
      // "Gone" = v2.0's AUTHORITATIVE bumper-off signal (aperture exposed OR ledger-severe), NOT any
      // costed bumper `replace`. The pre-v2.0 module OR'd in a costed-replace fallback; the batch-65
      // fixture survey showed that over-firing on 4 of 11 lots (a cosmetic replace is not "gone" and
      // must not seed fogs). v2.0 has the authoritative flag, so trust it alone.
      const fogSeed = PANEL_PRICE_TABLE[PANEL.FOG_LAMP]?.[bandKey] ?? null;
      // §3 (batch 81): the seeded fog is a CHILD of the bumper — cost it only when the bumper is a
      // CONFIRMED cost (iv:true), not when it merely survived as a disagree or fired _rearBumperOff from
      // an aperture read. An unconfirmed parent yields a fog FLAG, not a cost (applyFogBumperRule).
      const _bumperConfirmed = (pid) => coreObs.costedParts.some(cp => cp.panelId === pid && cp.independentlyVisible === true);
      const fogRule = applyFogBumperRule({
        costedParts: gatedParts,
        frontBumperGone: assessment._frontBumperOff === true,
        rearBumperGone:  assessment._rearBumperOff === true,
        frontBumperConfirmed: _bumperConfirmed(PANEL.FRONT_BUMPER),
        rearBumperConfirmed:  _bumperConfirmed(PANEL.REAR_BUMPER),
        fogSeed,
      });
      if (fogRule.costedToAdd.length) {
        gatedParts.push(...fogRule.costedToAdd);
        console.log(`[FOG RULE] +${fogRule.costedToAdd.length} fog row(s) costed (bumper gone)`);
      }
      if (fogRule.flagsToAdd.length) assessment._flaggedParts.push(...fogRule.flagsToAdd);

      // Fix A — completeness net. Any component NAMED in the (model-authored) Visible Damage Summary
      // that is neither costed nor in the SURVIVING buyer flags becomes an inspection flag. FLAG-ONLY —
      // never a cost, so parts_sum is untouched. Survivors via buildBuyerFlags (post-suppression view).
      const extraFlags = completenessFlagsFor(assessment, gatedParts, buildBuyerFlags, coreObs.namedAsIntact);
      if (extraFlags.length) {
        assessment._flaggedParts.push(...extraFlags);
        console.log(`[COMPLETENESS NET] +${extraFlags.length} flag(s) for VDS-named-but-uncosted components`);
      }
    }

    // ── FIX 3 (batch 71 → batch 81 §5): bumper-off / bumper-UNCONFIRMED — a CONTROL, not narration ──
    // A bumper read as displaced (_frontBumperOff/_rearBumperOff) drives consequential spend (seeded
    // fogs). If that bumper is NOT CONFIRMED (iv:true) — merely disagreed under §1, or "off" via an
    // aperture read — the engine would spend on the consequence while too uncertain to cost the cause.
    // §5 (Vincent): a flag that only WATCHES money leave is not a control — where the contradiction
    // identifies unsupported spend it must SUPPRESS it. §3 already gates the fog SEED on parent
    // confirmation (computed BEFORE the spend), so nothing is normally seeded here; this is the
    // enforcement backstop that STRIPS any bumper-off-derived fog cost that reached the ledger without a
    // confirmed parent, then raises ONE buyer flag if §3 did not already surface it. Confirmation is read
    // from the VERDICT (iv:true), not mere presence in gatedParts — which a §1 disagree row now satisfies.
    for (const [off, panelId, end] of [
      [assessment._frontBumperOff, PANEL.FRONT_BUMPER, 'front'],
      [assessment._rearBumperOff,  PANEL.REAR_BUMPER,  'rear'],
    ]) {
      if (off !== true) continue;
      const bumperConfirmed = coreObs.costedParts.some(cp => cp.panelId === panelId && cp.independentlyVisible === true);
      if (bumperConfirmed) continue;   // parent confirmed → the consequential spend is supported → no contradiction
      const endRe = new RegExp(end, 'i');
      let stripped = 0, strippedVal = 0;
      for (let i = gatedParts.length - 1; i >= 0; i--) {
        const gp = gatedParts[i];
        if (gp.panelId === PANEL.FOG_LAMP && gp._fogPaired && endRe.test(`${gp.zone || ''} ${gp.name || ''}`)) {
          strippedVal += gp.used ?? gp.oem ?? 0; gatedParts.splice(i, 1); stripped++;
        }
      }
      if (stripped) console.error(`[BUMPER CONTROL] ${end} bumper off but UNCONFIRMED — stripped ${stripped} unsupported seeded fog cost(s) (£${strippedVal}) from the repair total`);
      const alreadyFlagged = assessment._flaggedParts.some(f => (f._fogUnconfirmedParent || f._bumperOffContradiction) && (f.zone === end || endRe.test(f.partName || '')));
      if (!alreadyFlagged) {
        assessment._flaggedParts.push({
          panelId, partName: `${end} bumper`, zone: end, weight: 'high',
          reason: `The ${end} bumper was read as displaced but could not be confirmed on the photos, so nothing that depends on it being off has been costed. Confirm whether the ${end} bumper is genuinely off on the WhatsApp inspection before relying on the ${end}-end damage read.`,
          _bumperOffContradiction: true,
        });
        console.log(`[BUMPER CONTROL] ${end} bumper off but unconfirmed → flagged (no unsupported spend remains)`);
      }
    }

    // ── §4 LABOUR RECONCILIATION (batch 81, Vincent amendment 2) ───────────────────────────────────
    // Labour/paint is summed into parts_sum unconditionally and filtered out of the displayed list — so
    // before this it could ship (DL72FVX) labour to fit and paint ZERO surviving panels. Labour now
    // follows what SURVIVES. NON-NEGOTIABLE FLOOR: zero surviving costed parts ⟹ zero labour. The partial
    // shape is chosen by lib/parts.computeLabourRatio; Vincent's ruling (amendment 2): labour tracks the
    // EXTENT of damage, not value. LABOUR_SHAPE selects the shape for the evaluation sweep (default the
    // value baseline until Vincent picks). severityOf maps each part to its per-view verdict grade
    // (_ledgerSeverity, now stamped on confirmed AND disagree AND single-minor entries). Runs AFTER fog
    // seeding and BEFORE parts_sum. Touches labour rows only; never a part, never a flag.
    {
      const isLabour = (nm) => /labour|paint|prep/i.test(nm || '');
      const labourRows = gatedParts.filter(p => isLabour(p.name));
      if (labourRows.length) {
        const shape = process.env.LABOUR_SHAPE || 'severity';   // Vincent's ruling (amendment 2): labour tracks the EXTENT of damage. severity locked; NO action multiplier (the repair×1.5 was an invented constant). Env override kept for evaluation only; prod never sets it.
        const sevByPanel = new Map();
        for (const cp of coreObs.costedParts) if (cp.panelId && cp._ledgerSeverity) sevByPanel.set(cp.panelId, cp._ledgerSeverity);
        const severityOf = (p) => sevByPanel.get(p.panelId) || 'MODERATE';
        const ratio = computeLabourRatio({
          survivingParts: gatedParts.filter(p => !isLabour(p.name)),
          preGateParts:   (reconciledParts || []).filter(p => !isLabour(p.name)),
          severityOf, shape,
        });
        const val = (p) => p.used ?? p.oem ?? 0;
        for (const lr of labourRows) {
          const before = val(lr);
          const scaled = Math.round(before * ratio);
          if (lr.used != null) lr.used = scaled; else lr.oem = scaled;
          lr._labourReconciled = true;
          if (scaled !== before) console.log(`[LABOUR RECONCILE][${shape}] "${lr.name}" £${before} → £${scaled} (ratio ${ratio.toFixed(3)})`);
        }
        if (ratio === 0) console.error('[LABOUR RECONCILE] zero surviving costed parts → labour zeroed (it was fitting nothing)');
      }
    }

    // Code-assembled Visible Damage Summary (Step 4c). COSTED PANELS ONLY — one block per
    // real repair line (action + finalised figure). Floored/flagged panels live in the
    // Inspection Flags surface, never here (one panel, one surface). No model-authored
    // per-panel prose survives. Reads the FINALISED ledger (post bumper-off, post gate).
    assessment._vdsParts = assembleVdsParts(coreObs.costedParts, gatedParts);
    console.log(`[VDS ASSEMBLE] ${assessment._vdsParts.length} code-assembled costed block(s)`);

    // Code-assembled Key Cost Drivers (4d). The ledger IS the driver list — biggest-ticket repair
    // lines, code-owned figures. Demoted/floored parts are absent from gatedParts by construction,
    // so the retired KCD scrub is no longer needed. Model KCD prose (bound below) is judgement colour.
    assessment._kcdParts = assembleKcdParts(gatedParts);
    console.log(`[KCD ASSEMBLE] ${assessment._kcdParts.length} code-assembled driver(s)`);

    const parts_sum = sumPartsRealistic(gatedParts);

    // Instrumentation finalised post-gate: lamp_delta/lamp_inserted describe the
    // rows actually inside parts_sum — reality, never assumption (CB7 fix)
    const { lamp_delta, lamp_inserted, lamp_count, lamp_money_rows, orphan_collapse } = finalizeLampInstrumentation(gatedParts, lampResult);
    const lamp_span_source = lampResult?.spanSource ?? 'no-lamp-result';   // S5-1 — verbatim copy of the branch computeLampResult labelled

    if (gatedParts.length > 0) {
      assessment['Parts Breakdown'] = renderParts(gatedParts);
    }
    assessment._reconciledParts = gatedParts;
    assessment._preGateParts    = reconciledParts;
    assessment._allowanceParts  = allowanceParts;
    assessment._partsReconciliation = { parts_sum, lamp_delta, lamp_inserted, lamp_count, lamp_money_rows, lamp_span_source, orphan_collapse };

    // Per-part damage cards (AEP-style) — purely additive; READS the finalised parts pipeline.
    // Never mutates parts_sum / the reconciliation. Wrapped so it can never break the assessment.
    try {
      const _cards = buildDamageCards({
        gatedParts,
        costedParts:    coreObs.costedParts,
        flaggedParts:   coreObs.flaggedParts,
        allowanceParts,
      });
      if (_cards.length > 0) {
        assessment._damageCards = _cards;
        const byOrigin = _cards.reduce((m, c) => { m[c.origin] = (m[c.origin] || 0) + 1; return m; }, {});
        console.log(`[DAMAGE CARDS] ${_cards.length} card(s): ${JSON.stringify(byOrigin)}`);
      }
    } catch (e) {
      console.warn(`[DAMAGE CARDS] skipped — ${e?.message || e}`);
    }

    // Floored-panel prose scrub (Cowork §13). Deterministic post-processor: using the FINAL damage
    // cards as ground truth, it drops Key-Cost-Driver lines whose lead panel was FLOORED (not costed)
    // and neutralises severe-damage adjectives asserted on floored panels in KCD/VDS — the reliable
    // fix for the slot/prose divergence a prompt clause could not close (proven on the harness).
    // Costed panels and legitimate unseeable-risk framing are left untouched. Wrapped so it can never
    // break the assessment.
    try {
      const _scrub = scrubFlooredProse(assessment);
      if (_scrub.kcdDropped.length || _scrub.kcdChanges.length || _scrub.vdsChanges.length) {
        console.log(`[FLOORED SCRUB] KCD dropped ${_scrub.kcdDropped.length}, neutralised KCD ${_scrub.kcdChanges.length} / VDS ${_scrub.vdsChanges.length}`);
      }
    } catch (e) {
      console.warn(`[FLOORED SCRUB] skipped — ${e?.message || e}`);
    }

    // Parts Sourcing (AEP-style) — purely additive shoppable-link layer. READS the reconciled
    // basket (gatedParts); never mutates a costed figure. eBay UK is the only feed wired now.
    // EPN campaign ID comes from server env; when unset the links are honest plain eBay searches
    // (no campid) so nothing fabricated/broken ships — the panel switches live when the ID lands.
    // Wrapped so it can never break the assessment. Presence-gated: no links → no panel.
    try {
      const epn = {
        campaignId: (process.env.EBAY_EPN_CAMPAIGN_ID || '').trim() || null,
        customId:   (process.env.EBAY_EPN_CUSTOM_ID   || '').trim() || null,
      };
      const _sourcing = buildPartsSourcing({
        parts:   gatedParts,
        vehicle: { make: enrichedVd.make, model: enrichedVd.model, year: enrichedVd.year },
        epn,
      });
      if (_sourcing.links.length > 0) {
        assessment._partsSourcing = _sourcing;
        console.log(`[PARTS SOURCING] ${_sourcing.links.length} eBay link(s), campid=${epn.campaignId ? 'set' : 'unset (plain search)'}`);
      }
    } catch (e) {
      console.warn(`[PARTS SOURCING] skipped — ${e?.message || e}`);
    }
    console.log(`[PARTS] repair=£${parts_sum} lamp_inserted=${lamp_inserted} lamps=${lamp_count} band_each=£${lampResult?.lampAllowance ?? 0} lamp_delta=£${lamp_delta}`);
    console.log(`[LAMP MONEY] rows_in_money=${lamp_money_rows} span_source=${lamp_span_source} orphan_collapse=${orphan_collapse} (lamp_count intent=${lamp_count})`);
    if (lamp_money_rows > 1) {
      const _branch = orphan_collapse
        ? 'orphan-collapse (non-tier2 path — S5-2 target)'
        : 'tier2-anomaly (INVARIANT BROKEN: >1 mandated lamp row on a path where that is structurally impossible)';
      console.warn(`[LAMP MONEY][ORPHAN COLLAPSE] ${lamp_money_rows} lamp rows in parts_sum — ${_branch}; span_source=${lamp_span_source}.`);
    }

    // CB8: wheel-net item adapts when costed wheel/tyre lines are in gatedParts,
    // avoiding contradiction with already-confirmed wheel damage in the checklist.
    {
      const IS_WHEEL_TYRE = /\b(?:wheel|tyre|tire|rim|alloy)\b/i;
      const damagedWheelParts = gatedParts.filter(p => IS_WHEEL_TYRE.test(p.name));
      const netItem = damagedWheelParts.length > 0
        ? `Wheel/tyre damage already identified and costed (${damagedWheelParts.map(p => p.name).join(', ')}) — photograph ALL corners close-up to confirm extent of identified damage and that unaffected corners are serviceable`
        : `Inspect and photograph all four wheels and tyres close-up — confirm no shredding, kerbing, cuts or bulges (the listing photos do not show the wheels clearly enough to confirm condition)`;
      console.log(`[WHEEL NET] ${damagedWheelParts.length > 0 ? 'adapt' : 'unconditional'} — appending to checklist. damagedWheels=${damagedWheelParts.length}`);
      const existing = (assessment['WhatsApp Inspection Checklist'] || '').trim();
      if (existing) {
        const itemCount = (existing.match(/^\d+[.)]/mg) || []).length;
        assessment['WhatsApp Inspection Checklist'] = existing + `\n${itemCount + 1}. ${netItem}`;
      } else {
        console.warn('[WHEEL NET] checklist section empty — item not appended; model may have used a non-standard section header');
      }
    }

    // EV Step 4 — dash telltale → WhatsApp inspection query. Supplementary evidence ONLY:
    // a lit coolant / oil lamp NEVER gates money (no cost, no flag, no rad-rule input — Vincent's
    // ruling). It appends a code-owned inspection item and nothing more. Runs once, in the
    // deterministic tier (before buyer-flag seeding). dashRead.telltales is already Set-deduped
    // (:947) so each telltale yields at most one item. Fires on ANY lot with the telltale; the
    // frontStruck boolean only selects the coolant wording, it does not gate the item.
    {
      const _telltaleItems = [];
      if (dashRead.cluster === 'warning' && dashRead.telltales.includes('COOLANT_TEMP')) {
        _telltaleItems.push(frontStruck
          ? 'Coolant temperature warning is lit on the cluster and the front impact has exposed the radiator pack — show the coolant level in the expansion tank and the radiator/condenser faces close up for leaks or crush damage before bidding.'
          : 'Coolant temperature warning is lit on the cluster — show the coolant level in the expansion tank and check for visible leaks before bidding.');
      }
      if (dashRead.cluster === 'warning' && dashRead.telltales.includes('OIL_PRESSURE')) {
        _telltaleItems.push('Oil pressure warning is lit on the cluster — show the engine oil level and the sump/underside of the engine for impact damage or leaks before bidding.');
      }
      if (_telltaleItems.length > 0) {
        const existing = (assessment['WhatsApp Inspection Checklist'] || '').trim();
        if (existing) {
          let nextItem = (existing.match(/^\d+[.)]/mg) || []).length + 1;
          let text = existing;
          for (const item of _telltaleItems) { text += `\n${nextItem}. ${item}`; nextItem++; }
          assessment['WhatsApp Inspection Checklist'] = text;
          console.log(`[DASH TELLTALE] appended ${_telltaleItems.length} inspection quer${_telltaleItems.length === 1 ? 'y' : 'ies'} (coolant/oil) frontStruck=${frontStruck} telltales=[${dashRead.telltales.join(',')}]`);
        } else {
          console.warn('[DASH TELLTALE] checklist section empty — telltale item(s) not appended');
        }
      }
    }

    // Seed buyer-flag items onto the checklist after all curated/deterministic items.
    // De-dupe rules:
    // Rule 1: WHEEL/TYRE/DISPLACED_WHEEL → always suppress (wheel-net covers all corners).
    // Rule 2: lamp panels when tier2Fired → suppress (curated lamp entries cover the aperture).
    // Rule 3 (concept-based): structural panels (FRONT/REAR/SIDE_STRUCTURE) → suppress only
    //   when their specific curated concern is ACTUALLY PRESENT in this lot's checklist text —
    //   verified per-lot with detection keywords, never assumed. Falls through to seed when
    //   the concern is absent (e.g. a lot where the model omitted the chassis-leg item).
    //   Detection keywords are keyed by panelId (stable), not by display partName (drift-prone).
    // Fallback: verbatim normName phrase-match for all remaining non-structural panels.
    {
      const STRUCTURAL_CONCERN_KEYWORDS = new Map([
        [PANEL.FRONT_STRUCTURE, ['chassis']],
        [PANEL.REAR_STRUCTURE,  ['longitudinal', 'boot floor']],
        [PANEL.SIDE_STRUCTURE,  ['inner sill', 'b-pillar', 'c-pillar']],
      ]);

      const buyerFlags = buildBuyerFlags(assessment);
      if (buyerFlags.length > 0) {
        let checklistText = (assessment['WhatsApp Inspection Checklist'] || '').trim();
        if (checklistText) {
          // Single counter initialised once — do not re-parse the text on every append.
          let nextItem = (checklistText.match(/^\d+[.)]/mg) || []).length + 1;
          for (const flag of buyerFlags) {
            const part = (flag.partName || '').trim();
            if (!part) continue;
            // Rule 1: wheel/tyre/displaced-wheel → wheel-net covers unconditionally
            if (/\b(?:wheel|tyre|tire|rim|alloy)\b/i.test(part)) {
              console.log(`[SEED] skip "${part}" reason=wheelnet`);
              continue;
            }
            // Rule 2: lamp panels when tier2Fired → curated lamp entries cover the aperture
            if (isLampLine(part) && lampResult?.tier2Fired) {
              console.log(`[SEED] skip "${part}" reason=lamp-tier2`);
              continue;
            }
            // Rule 3: concept-map — structural panels keyed by panelId
            const clLower = checklistText.toLowerCase(); // recomputed per iteration so appended items accrue
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
            let seedItem;
            if (flag._bumperOffStripped) {
              seedItem = `Show ${part} behind the displaced bumper — confirm whether the panel itself is damaged or just the exposed seam.`;
            } else if (flag._amalgDisagree) {
              seedItem = `Show ${part} close-up — condition could not be resolved across views in the listing photos.`;
            } else if (flag._amalgNotVisible) {
              seedItem = `Show ${part} close-up — not visible in any of the listing photos.`;
            } else if (flag._gateGenerated) {
              seedItem = `Show ${part} close-up — could not be confirmed from the listing photos.`;
            } else if (flag.weight === 'high') {
              seedItem = `Show ${part} close-up — structural or inspection-class component; confirm condition before bidding.`;
            } else if (flag.weight === 'low') {
              seedItem = `Show ${part} close-up — confirm the cosmetic damage extent.`;
            } else {
              seedItem = `Show ${part} close-up — condition could not be confirmed from the listing photos.`;
            }
            checklistText += `\n${nextItem}. ${seedItem}`;
            console.log(`[SEED] add "${part}" as item ${nextItem}`);
            nextItem++;
          }
          assessment['WhatsApp Inspection Checklist'] = checklistText;
        } else {
          console.warn('[SEED] checklist empty — flag items not seeded');
        }
      }
    }

    // ── FIX 1 (batch 71): Cat A/B hard stop — refuse repair estimate + whole-vehicle exit valuation ──
    // Post-perception, code-owned, reads the recorded category only. On Cat A/B: null the whole-vehicle
    // money outputs (exit value, margin ladder, SalvageGuide cross-check, investment block are all
    // guarded below on !_catAB) and state the legal position in the buyer-facing fields. The itemised
    // visible-damage ledger is left intact — it is a damage record, not a repair plan.
    const _catAB = catABHardStopLetter(enrichedVd.category);
    if (_catAB) {
      const _stop = CAT_AB_STOP[_catAB];
      assessment._catABHardStop = _catAB.toUpperCase();
      assessment['Realistic Exit Value'] = _stop;
      assessment['Exit Band Position']   = '';
      assessment['Recommended Action']   = _stop;
      const _rfAB = (assessment['Red Flags'] || '').trim();
      assessment['Red Flags'] = _rfAB ? `- ${_stop}\n${_rfAB}` : `- ${_stop}`;
      assessment._exitValue       = null;
      assessment._marginScenarios = null;
      console.log(`[CAT A/B HARD STOP] category="${enrichedVd.category}" → repair estimate + whole-vehicle exit valuation refused`);
    }

    // Code-owned exit value: trade-low × band percentage keyed by category + model's 5-step position
    let exitValue = null;
    if (!_catAB && bregoData?.trade_low_valuation) {
      const { exit, band, step, pct } = computeExitFromBand(
        bregoData.trade_low_valuation,
        enrichedVd.category || '',
        assessment['Exit Band Position'] || ''
      );
      exitValue = exit;
      const catLabel    = band === 'n' ? 'Cat N' : 'Cat S';
      const tradeLowFmt = Number(bregoData.trade_low_valuation).toLocaleString('en-GB');
      const exitFmt     = Number(exit).toLocaleString('en-GB');
      assessment['Realistic Exit Value'] = (assessment['Realistic Exit Value'] || '').trimEnd() +
        `\n\nExit: £${exitFmt} — ${step} position, ${pct}% of trade-low £${tradeLowFmt} (${catLabel} band)`;
      assessment._exitValue = exitValue;
      console.log(`[EXIT BAND] cat=${catLabel} step=${step} pct=${pct}% tradeLow=£${bregoData.trade_low_valuation} → exit=£${exitValue}`);
    } else {
      console.warn('[EXIT BAND] no trade_low_valuation — exit value unavailable, margin skipped');
    }

    const lotIsVatQualifying = enrichedVd.vatOnSale === 'Yes';

    const feeStackFn = FEE_STACKS[auctionSource];
    if (!_catAB && feeStackFn && parts_sum > 0 && exitValue != null) {
      const marginScenarios = buildHammerLadder(exitValue).map(hammer => {
        const fees = feeStackFn(hammer);
        const hammerVat = lotIsVatQualifying ? Math.round(hammer * 0.20 * 100) / 100 : 0;
        const margin = Math.round((exitValue - parts_sum - hammer - hammerVat - fees.totalIncVat) * 100) / 100;
        return { hammer, exit_value: exitValue, repair: parts_sum, hammerVat, ...fees, margin };
      });
      assessment._marginScenarios = marginScenarios;
      console.log(`[MARGIN] source=${auctionSource} exit=£${exitValue} repair=£${parts_sum} scenarios=${marginScenarios.length}`);
    } else if (feeStackFn) {
      console.warn(`[MARGIN] skipped — source=${auctionSource} parts_sum=${parts_sum} exitValue=${exitValue}`);
    }

    // ── SalvageGuide market cross-check (labelled reference; NEVER feeds exit/margin) ──
    // Maps the predicted-bid range + a secondary retail ref, and computes the divergence flag vs
    // the engine's break-even hammer. Attached only when a usable bid range came back; otherwise the
    // block is silently omitted downstream and the assessment renders exactly as before.
    if (!_catAB && enrichedVd.salvageGuide) {
      const sg = enrichedVd.salvageGuide;
      const sgNum = v => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;
      const bidLow  = sgNum(sg.salvage_auction_predicted_bid_low_gbp);
      const bidAvg  = sgNum(sg.salvage_auction_predicted_bid_average_gbp);
      const bidHigh = sgNum(sg.salvage_auction_predicted_bid_high_gbp);
      if (bidLow != null && bidHigh != null) {
        const be = breakEvenHammer(assessment._marginScenarios);
        const divergence = (be != null)
          ? (be < bidLow * (1 - SALVAGEGUIDE_DIVERGENCE_PCT) || be > bidHigh * (1 + SALVAGEGUIDE_DIVERGENCE_PCT))
          : null;
        assessment._salvageGuide = {
          bidLow, bidAvg, bidHigh,
          retailLow: sgNum(sg.category_adjusted_retail_value_low_gbp),
          retailHigh: sgNum(sg.category_adjusted_retail_value_high_gbp),
          breakEven: be, divergence,
        };
        console.log(`[SALVAGEGUIDE] bid £${bidLow}-£${bidHigh} (avg £${bidAvg ?? '—'}) breakEven=${be ?? 'n/a'} divergence=${divergence}`);
      }
    }

    // ── Investment Block (AEP-style) — purely additive; READS the figures above ──────
    // Never mutates _exitValue / parts_sum / _marginScenarios / "Realistic Exit Value".
    // Packages as-is-clean (undamaged retail), after-repair value (_exitValue), part-out,
    // as-is-salvage, and three named bid ceilings. Omitted (null) if nothing meaningful.
    // batch 71 FIX 1: skipped entirely on a Cat A/B hard stop — no whole-vehicle investment framing.
    if (!_catAB) try {
      const ib = buildInvestmentBlock({
        retailLow:     bregoData?.retail_low_valuation,
        retailAverage: bregoData?.retail_average_valuation,
        retailHigh:    bregoData?.retail_high_valuation,
        tradeAverage:  bregoData?.trade_average_valuation,   // same band input as the repair estimate
        exitValue,
        breakEven:     breakEvenHammer(assessment._marginScenarios),
        rebuildHammer: rebuildCeilingHammer(assessment._marginScenarios),   // surfaces the ceiling when break-even sits above the ladder top (healthy repairable lots)
        hammerLadder:  exitValue != null ? buildHammerLadder(exitValue) : null,
        salvageGuide:  enrichedVd.salvageGuide || null,
        confidence:    assessment['Confidence Level'] || null,
        feeStackFn:    FEE_STACKS[auctionSource],
      });
      if (ib) {
        assessment._investmentBlock = ib;
        console.log(`[INVEST BLOCK] asIsClean=${ib.asIsClean?.mid ?? '—'} afterRepair=${ib.afterRepairValue ?? '—'} partOut=${ib.partOut ? `${ib.partOut.low}-${ib.partOut.high}` : '—'} asIsSalvage=${ib.asIsSalvage ? `${ib.asIsSalvage.low}-${ib.asIsSalvage.high}(${ib.asIsSalvage.basis})` : '—'} ceilings=rebuild:${ib.bidCeilings.rebuild?.value ?? '—'}/flip:${ib.bidCeilings.flip?.value ?? '—'}/parts:${ib.bidCeilings.partsOut?.value ?? '—'}`);
      }
    } catch (e) {
      // Additive block must never break the assessment — omit on any error.
      console.warn(`[INVEST BLOCK] skipped — ${e?.message || e}`);
    }

    // EV Step 5 — tier-1 margin caveat (VERDICT LANGUAGE only; maths above untouched). The repair
    // total excludes the HV pack, so on a cost-prohibitive verdict the margin figures are best-case;
    // append a code-owned caveat line to the buyer-facing Margin Calculation field.
    if (assessment._evCoolingHvVerdict === 'cost-prohibitive' && assessment['Margin Calculation']) {
      assessment['Margin Calculation'] = assessment['Margin Calculation'].trimEnd() + `\n\n${EV_VERDICT_MARGIN_CAVEAT}`;
      console.log('[EV VERDICT] tier-1 margin caveat appended');
    }

    // ── 4d/4e/4f — claim-class binder ──────────────────────────────────────────
    // Bind narrative claims to the finalised ledger across the five claim classes. Contradicting
    // sentences are DROPPED (no rewrite) and recorded in _narrativeBindings. Bound surfaces:
    // KCD + Red Flags (redflags); Alt Scenario + Bidder Note (speculation — hedged prose spared);
    // and 4f C-3 adds VDS standfirst preamble (redflags, via 'Visible Damage Summary'; parseVdsParts
    // re-parses at render), plus Realistic Exit Value + Margin Calculation + Recommended Action
    // (speculation — class-2 context-gating preserves the legitimate exit/margin/bid figures these
    // surfaces quote; the code-owned exit-band line and EV margin caveat carry no repair-context
    // figure, so they survive the pass). Runs after the ledger/exit/EV-verdict are final and BEFORE
    // both the provenance inject and the EV tier-1 lead injection below, which are therefore
    // sequence-exempt by construction.
    {
      const _claimCtx = {
        lampType: lampResult?.lampType ?? null,
        allowedFigures: [
          ...gatedParts.filter(gp => !/labour|paint|prep/i.test(gp.name)).map(gp => gp.used ?? gp.oem),
          parts_sum, exitValue,
        ].filter(v => v != null && Number.isFinite(Number(v))).map(Number),
        partActions: gatedParts.filter(gp => !/labour|paint|prep/i.test(gp.name)).map(gp => [gp.name, gp.action ?? 'replace']),
        demoted: coreObs.costedParts
          .filter(cp => cp.independentlyVisible === false)
          .map(cp => PANEL_DISPLAY[cp.panelId] || cp.partName || '')
          .filter(Boolean),
        evVerdict: assessment._evCoolingHvVerdict ?? null,
      };
      assessment._narrativeBindings = [];   // stamp always: [] = binder ran, dropped nothing (≠ never-ran)
      for (const [field, mode] of [
        ['Key Cost Drivers', 'redflags'], ['Red Flags', 'redflags'],
        ['Alternative Damage Scenario', 'speculation'], ['Bidder Note', 'speculation'],
        ['Visible Damage Summary', 'redflags'],                                    // 4f C-3: standfirst preamble
        ['Realistic Exit Value', 'speculation'], ['Margin Calculation', 'speculation'], // 4f C-3: figures-bearing
        ['Recommended Action', 'speculation'],                                     // 4f C-3: full set
      ]) {
        if (!assessment[field]) continue;
        const { text, dropped } = bindClaimClasses(assessment[field], _claimCtx, mode);
        for (const d of dropped) assessment._narrativeBindings.push({ surface: field, droppedSentence: d.sentence, claimClass: d.class, reason: d.reason });
        if (dropped.length) console.log(`[CLAIM BIND] ${field}: dropped ${dropped.length} sentence(s) [${dropped.map(d => d.class).join(', ')}]`);
        assessment[field] = text;
      }
    }

    // ── EV tier-1 lead: post-binder injection (4f C-2) ──────────────────────────────
    // The cost-prohibitive HV-pack verdict leads Red Flags. Injected AFTER bindClaimClasses so the
    // code-owned lead is exempt from the scrub BY SEQUENCE — replacing the pre-binder prepend +
    // _exemptLeads prefix match, which was fragile to lead-wording drift. Prepends (lead goes first);
    // the code-owned provenance line below still appends last.
    if (assessment._evCoolingHvVerdict === 'cost-prohibitive') {
      const _rf = (assessment['Red Flags'] || '').trim();
      assessment['Red Flags'] = _rf ? `- ${EV_VERDICT_TIER1_REDFLAG}\n${_rf}` : `- ${EV_VERDICT_TIER1_REDFLAG}`;
      console.log('[EV LEAD] tier-1 cost-prohibitive lead prepended to Red Flags (post-binder)');
    }

    // CORE slot engine — code-owned structured verdicts from coreObs (model vision read) +
    // enrichedVd/bregoData (code-owned data). Phase 1: identity, mileage, physical (wheel/tyre).
    // proseFlags: Call-2 prose-faithfulness conclusions; null fields = Call 2 unavailable.
    const proseFlags = coreObs.proseFlags ?? { provenanceConcernFlagged: null, provenanceConcernReason: null, salvageSelfReferenceConfirmed: null };
    assessment._slots = assembleCoreSlots([
      buildIdentityGroup(enrichedVd, coreObs, brMileage, brAgeYears, proseFlags),
      buildMileageGroup(enrichedVd, brMileage, brMileageSource, proseFlags),
      buildPhysicalGroup(coreObs),
    ]);
    console.log(`[CORE SLOTS] groups=${assessment._slots.groups.length} allClear=${assessment._slots.allClear.length} flags=${assessment._slots.flags.length}`);

    // ── §7 (batch 73): show Copart's damage LABEL to the BUYER — code-side, AFTER both model calls ──
    // The label family is withheld from perception (3b) because it is auction staff's classification,
    // not an observation. But a bidder may still want to see what Copart recorded. It is injected HERE,
    // downstream of Call 1 (perception) AND Call 2 (extraction), so it can never re-enter a prompt — it
    // is a render-time fact only, like category (route.js:390/:445). The two statements are printed
    // plainly with NO agreement/disagreement scoring; the buyer draws the conclusion. This is the whole
    // product on a lot where the label and the photos disagree (EN23NJX: "Rear End" vs a moulding).
    const _labelParts = [enrichedVd.primaryDamage, enrichedVd.secondaryDamage, enrichedVd.additionalDamage]
      .map(s => (s || '').trim()).filter(Boolean);
    if (_labelParts.length) {
      const _label = _labelParts.join('; ');
      assessment._copartDamageLabel = {
        label: _label,
        line1: `Copart record this lot as: ${_label}.`,
        line2: 'This assessment is from the photographs only.',
      };
    }

    // ── Provenance concern: code-owned Red Flags line (deterministic surfacing) ──
    // The two-tier non-insurer concern (C/Q suffix on Cat U primary / Cat S secondary) renders in
    // the Structured Checklist, but its appearance in Red Flags was model-prose lottery (same lot/
    // suffix: present on some runs, absent on others). Inject a fixed high-severity line when the
    // CODE determination fires, suffix-specific lead + tier-specific body, deduped against a
    // model-authored provenance line so the buyer never sees it twice. Runs after the vendor-suffix
    // backfill (:4003) so resolveVendorSuffix is valid. Code-owned ONLY — the null-paste model-raised
    // concern (category null → qcProvenanceConcern null) stays model-owned, never injected.
    {
      const _provVendorSuffix = resolveVendorSuffix(coreObs);
      const _provTier = qcProvenanceConcern(enrichedVd, _provVendorSuffix); // 'catU' | 'catS' | null
      if (_provTier) {
        const _suffixLead = _provVendorSuffix.letter === 'Q'
          ? 'Copart-owned Cash-for-Cars entry (Q windscreen suffix)'
          : 'Private or trade entry (C windscreen suffix)';
        const _provLine = _provTier === 'catU'
          ? `${_suffixLead} with no insurance salvage category recorded: this vehicle has never been categorised by an insurer, so its damage and disposal history is wholly unvouched. This can be routine trade or fleet disposal — but 'why is it here?' is the question to answer before bidding. Establish the entry reason and apply extra scrutiny on inspection.`
          : `${_suffixLead} on a Cat S structural write-off: the category is historic — this is a previously written-off vehicle re-entered by a non-insurer, possibly unrepaired. Establish why the last owner disposed of it before bidding.`;
        const _provDedupRx = /insurer write-?off|non-insurer|copart[- ](acquired|purchased|owned)|copart estate|cash[- ]for[- ]cars|disposal route|reason for disposal|entered the copart|undisclosed reason|unvouched|unrecorded|uncategori[sz]ed|never (been )?categori[sz]ed|no (insurance |salvage )?category|re-?entered|previously written[- ]off|private or trade entry|why (this|the) vehicle (is in salvage|entered|was written off|was disposed)/i;
        const _rfExisting = (assessment['Red Flags'] || '').trim();
        if (_rfExisting.split('\n').some(l => _provDedupRx.test(l))) {
          console.log(`[PROVENANCE INJECT] model line present — injected line suppressed (tier=${_provTier})`);
        } else {
          assessment['Red Flags'] = _rfExisting ? `${_rfExisting}\n- ${_provLine}` : `- ${_provLine}`;
          console.log(`[PROVENANCE INJECT] red-flag line injected (code-owned concern, tier=${_provTier})`);
        }
      }
    }

    // ── Sale-date → booking-reminder stamp (4f C-6) ───────────────────────────
    // enrichedVd.saleDate is { ms, offsetH } on a successful STRICT parse of the one observed Copart
    // format, else null (parse failure or absent). Stamp numeric ms + offset for the render state
    // machine; ISO is human-facing. HARD RULE upstream: a partial/unrecognised format → null → the
    // render shows generic 48h wording, never a computed date. The now-vs-sale state fires at render.
    {
      const _sd = enrichedVd.saleDate || null;
      assessment._saleDateMs      = _sd ? _sd.ms : null;
      assessment._saleDateOffsetH = _sd ? _sd.offsetH : null;
      assessment._saleDateISO     = _sd ? new Date(_sd.ms).toISOString() : null;
      console.log(`[BOOKING REMINDER] saleDate ${_sd
        ? `parsed → ${assessment._saleDateISO} (GMT${_sd.offsetH >= 0 ? '+' : ''}${_sd.offsetH})`
        : `absent/unparseable (raw=${JSON.stringify(enrichedVd.saleDateRaw ?? null)}) → generic 48h wording`}`);
    }

    logEvent('assessment_submitted', { vrm: enrichedVd.vrm || '', metadata: { lot_number: enrichedVd.lotNumber || null } });

    // Pure pipeline complete. The route envelope stamps assessment._payment_kind (needs the
    // session), persists { status:'assessed', assessment, vehicle_details: enrichedVd }, and returns.
    return { assessment, enrichedVd };
}
