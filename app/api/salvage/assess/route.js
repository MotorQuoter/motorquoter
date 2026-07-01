import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createCanvas, loadImage } from 'canvas';
import { ASSESSMENT_ENGINE_PROMPT } from '@/config/assessmentEngine';
import { feeStack } from '@/lib/copartFees';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';
import { withOneAutoCache } from '@/lib/oneautoCache';
import {
  CORE_GROUPS, VENDOR_SUFFIX_MAP, WHEEL_CORNERS, CORNER_LABELS,
  wheelSlotId, tyreSlotId, buildSlot, buildGroup, assembleCoreSlots,
} from '@/lib/coreSlots';
import {
  isLampLine, normName, sumPartsRealistic, reconcileParts,
  applyVisibilityGate, finalizeLampInstrumentation,
  assembleVdsParts, buildBuyerFlags, BUMPER_OFF_SEAM_REASON,
} from '@/lib/parts.mjs';
import { sanitizeSideTerms } from '@/lib/sanitizeProse';
import { normaliseLot } from '@/lib/normaliseLot';
import { PANEL, PANEL_DISPLAY, PANEL_BEHAVIOUR, PANEL_CLASS, EV_PANEL_RESOLVED_CLASS, isBevLot } from '@/lib/panelEnum.mjs';
import { derivePriceBand, PANEL_PRICE_TABLE } from '@/lib/priceBand.mjs';

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

// Generalised to N records (brief decision #3 — "the Juke" had 2 records, 1 was self, and the
// single-record-only check missed it). Same self-match predicate (mileage ±50 / category /
// damage-text) now runs across every record; isSelfReferenceFirstWriteOff is preserved for the
// existing web/PDF render branch — true when the WHOLE history is self-matches (the single-record
// case is just N=1 of that), so "first write-off" still means "no PRIOR history exists".
// selfMatchCount/recordsExcludingSelf are new: they feed the salvage-count-excl-self CORE slot.
// Maximum days between today and a salvage record date for the record to be considered a
// potential self-reference (the current lot's own first write-off). Used by tagSelfReference()
// and the prose-override date guard in buildSalvageCountSlot — both must use this constant
// so the windows cannot drift independently.
const SELF_REF_DATE_WINDOW_DAYS = 14;

function tagSelfReference(shResult, vd) {
  if (!shResult) return;
  const records = shResult.salvage_auction_records || [];
  let currentMileage = null;
  if (vd.copartListedMileage != null) {
    currentMileage = Number(vd.copartListedMileage);
  } else if (vd.odometer != null) {
    const n = parseInt(String(vd.odometer).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n)) currentMileage = n;
  }
  const curCat = catLetter(vd.category);
  const today = new Date();
  const selfFlags = records.map((rec) => {
    // Date is the required primary gate — a record excludes ONLY IF within SELF_REF_DATE_WINDOW_DAYS AND mileage+category match.
    // Any record older than that window is ALWAYS a genuine prior regardless of mileage proximity.
    let daysDelta = null;
    if (rec.salvage_auction_lot_date) {
      const recDate = new Date(rec.salvage_auction_lot_date);
      if (!isNaN(recDate.getTime())) {
        daysDelta = Math.abs((today - recDate) / (1000 * 60 * 60 * 24));
      } else {
        console.warn(`[SELF-REF] Unparseable lot date "${rec.salvage_auction_lot_date}" — record counted as genuine prior`);
      }
    } else {
      console.warn('[SELF-REF] No lot date on salvage record — record counted as genuine prior');
    }
    if (daysDelta === null || daysDelta > SELF_REF_DATE_WINDOW_DAYS) return false; // date gate: required AND condition

    const mileageMatch = currentMileage != null && rec.mileage != null
      ? Math.abs(rec.mileage - currentMileage) <= 100
      : null; // mileage unavailable → cannot confirm self-reference → genuine prior
    const recCat = catLetter(rec.salvage_auction_lot_desc);
    const categoryMatch = recCat != null && curCat != null && recCat === curCat;

    // Damage text is corroboration only — logged but does NOT gate the decision
    if (mileageMatch === true && categoryMatch) {
      const damageTextCorroborates = vd.primaryDamage != null && rec.primary_damage_desc != null
        && rec.primary_damage_desc.toLowerCase().trim() === vd.primaryDamage.toLowerCase().trim();
      if (!damageTextCorroborates) {
        console.log(`[SELF-REF] Date+mileage+category match; damage text differs — still self-reference. Listing: "${vd.primaryDamage}" / Record: "${rec.primary_damage_desc}"`);
      }
    }

    return mileageMatch === true && categoryMatch; // date already gated above
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
  if (!visible) return { status: 'absent', letter: null, mapped: null };      // no printed sticker seen
  if (letter === 'UNREADABLE') return { status: 'unreadable', letter: null, mapped: null }; // sticker present, letter illegible
  if (letter === 'OTHER') return { status: 'other', letter, mapped: null };
  return { status: 'mapped', letter, mapped: VENDOR_SUFFIX_MAP[letter] || null };
}

function buildVendorSuffixSlot(vendorSuffix) {
  if (vendorSuffix.status === 'absent') {
    return buildSlot({
      id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'No windscreen vendor sticker visible — vendor type unconfirmed',
      confidence: 'hidden', source: 'model',
      flag: { severity: 'info', whatsapp: 'No vendor sticker was visible in the photos — photograph the upper windscreen area to establish vendor type before bidding', tier: 1 },
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
    id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
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
// vehicle that LOOKS too clean to be genuine salvage. Severity steps up when the vendor-suffix
// slot (above) also resolved to a non-insurer entry (C/Q) — the "Q on a clean car" pattern.
// Thresholds are defensible defaults (UK new-car warranty ~3yr, UK average ~7-8k mi/yr) — Vincent
// should tune them from trade experience once validated against real lots.
const PROVENANCE_WARRANTY_AGE_YEARS = 3;
const PROVENANCE_LOW_MILES_PER_YEAR = 6000;

// Structural floor (NOT a meaning-test): a model provenance reason may quote into the buyer-facing
// slot only if it is sentence-shaped — ≥20 trimmed chars AND ≥4 whitespace-delimited words. This
// rejects fragments ("concern", "salvage", "Q suffix") that pass a bare non-empty check. What
// COUNTS as a real provenance concern stays the Call-2 schema's job; this only refuses to render a
// non-sentence as a reason. Deliberately crude — no keyword lists, no semantic judgement.
function isSubstantiveReason(s) {
  const t = (s || '').trim();
  return t.length >= 20 && t.split(/\s+/).filter(Boolean).length >= 4;
}

function buildProvenanceContradictionSlot(enrichedVd, vendorSuffix, brMileage, brAgeYears, proseFlags) {
  const currentYear = new Date().getFullYear();
  const listedYear = enrichedVd.year ? parseInt(String(enrichedVd.year), 10) : NaN;
  const ageYears = !isNaN(listedYear) ? (currentYear - listedYear) : (brAgeYears ?? null);
  const cat = (enrichedVd.category || '').trim();
  const hasDamageText = Boolean((enrichedVd.primaryDamage || '').trim() || (enrichedVd.secondaryDamage || '').trim());

  // Reason-gated: a bare boolean may not drive a buyer-facing assertion. The proseFlagged
  // contributor fires ONLY when the model both set the flag AND named a SUBSTANTIVE (sentence-
  // shaped) reason — see isSubstantiveReason. flag===true with an empty/absent/fragment reason →
  // suppressed (treated as no model concern); the code paths (codePathA / qcCatSFlag) still render
  // on their own merits, unchanged.
  const proseReason  = (proseFlags?.provenanceConcernReason || '').trim();
  const proseFlagged = proseFlags?.provenanceConcernFlagged === true && isSubstantiveReason(proseReason);
  const proseNull    = proseFlags?.provenanceConcernFlagged === null; // Call 2 unavailable

  if (ageYears == null || brMileage == null || !cat) {
    // Code arithmetic impossible — surface prose concern if present
    if (proseFlagged) {
      return buildSlot({
        id: 'provenance-contradiction', label: '"Why is it here?" — provenance concern flagged',
        kind: 'confirmation', verdict: 'discrepancy',
        detail: `Provenance concern: ${proseReason} (insufficient listing data for code arithmetic)`,
        confidence: 'inferred', source: 'code+model',
        flag: { severity: 'red', whatsapp: `Provenance concern raised: ${proseReason}. Ask the handler directly why this vehicle is in salvage before bidding`, tier: 1 },
      });
    }
    return buildSlot({
      id: 'provenance-contradiction', label: '"Why is it here?" — cannot confirm',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'Not enough listing data (age / mileage / category) to test whether the salvage story holds together',
      confidence: 'hidden', source: 'code',
    });
  }

  const isWarrantyAge = ageYears <= PROVENANCE_WARRANTY_AGE_YEARS;
  const milesPerYear = ageYears > 0 ? brMileage / ageYears : brMileage;
  const isLowMileage = milesPerYear < PROVENANCE_LOW_MILES_PER_YEAR;
  const isMinimalDamageStory = !hasDamageText || /^u\b/i.test(cat);
  const nonInsurerSuffix = vendorSuffix.status === 'mapped' && vendorSuffix.mapped?.insurerEntered === false;

  // Code path A (existing): too-clean pattern — warranty age + low mileage + minimal damage
  const codePathA = isWarrantyAge && isLowMileage && isMinimalDamageStory;
  // Code path B (new): Q/C non-insurer entry on a structural write-off
  const isCatS    = /^s\b/i.test(cat);
  const qcCatSFlag = nonInsurerSuffix && isCatS;

  // Conservative union: discrepancy if ANY of the three paths fires
  if (codePathA || qcCatSFlag || proseFlagged) {
    const descriptor = [enrichedVd.year, enrichedVd.make, enrichedVd.model].filter(Boolean).join(' ') || 'This vehicle';
    const signals = [];
    if (codePathA)    signals.push(`unusually clean for salvage (${Math.round(milesPerYear).toLocaleString('en-GB')} mi/yr at ${cat}, minimal damage described)`);
    if (qcCatSFlag)   signals.push('non-insurer entry on a structural write-off (Q/C suffix + Cat S)');
    if (proseFlagged) signals.push(proseReason);
    const whatsappParts = [];
    if (codePathA)    whatsappParts.push(`unusually clean for salvage — low mileage for its age, ${cat}, minimal damage described`);
    if (qcCatSFlag)   whatsappParts.push('non-insurer vendor entry (Q/C suffix) on a Cat S structural write-off');
    if (proseFlagged) whatsappParts.push(`provenance concern raised — ${proseReason}`);
    return buildSlot({
      id: 'provenance-contradiction', label: '"Why is it here?" — provenance concern flagged',
      kind: 'confirmation', verdict: 'discrepancy',
      detail: `${descriptor} — ${signals.join('; ')}`,
      confidence: proseFlagged ? 'corroborated' : 'inferred',
      source: proseFlagged ? 'code+model' : 'code',
      flag: {
        severity: (nonInsurerSuffix || proseFlagged) ? 'red' : 'caution',
        whatsapp: `${whatsappParts.join('; ')}. Ask the handler directly why this vehicle was written off and press for an explanation before bidding`,
        tier: 1,
      },
    });
  }

  // All three clean — check prose faithfulness availability
  if (proseNull) {
    // Call 2 failed: code found nothing but prose check unavailable — cannot confirm clear
    return buildSlot({
      id: 'provenance-contradiction', label: '"Why is it here?" — cannot confirm',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'Provenance code arithmetic found no concern, but prose faithfulness check was unavailable (Call 2 failed) — treat with caution',
      confidence: 'hidden', source: 'code',
      flag: { severity: 'caution', whatsapp: 'Provenance check partially unavailable for this lot — verify the vendor entry channel and ask the handler why the vehicle is in salvage', tier: 2 },
    });
  }

  return buildSlot({
    id: 'provenance-contradiction', label: '"Why is it here?" — story holds together',
    kind: 'confirmation', verdict: 'confirmed',
    detail: `Age, mileage, entry channel and damage description are consistent with a genuine ${cat} write-off — no provenance contradiction detected`,
    confidence: 'corroborated', source: 'code+model',
  });
}

function buildIdentityGroup(enrichedVd, coreObs, brMileage, brAgeYears, proseFlags) {
  const vendorSuffix = resolveVendorSuffix(coreObs);
  return buildGroup({
    id: CORE_GROUPS.IDENTITY.id, label: CORE_GROUPS.IDENTITY.label,
    slots: [
      buildBodyStyleSlot(enrichedVd, coreObs),
      buildCategorySlot(enrichedVd),
      buildVendorSuffixSlot(vendorSuffix),
      buildProvenanceContradictionSlot(enrichedVd, vendorSuffix, brMileage, brAgeYears, proseFlags),
    ],
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
    // Date guard: only fires when the candidate record is within SELF_REF_DATE_WINDOW_DAYS.
    // A record outside that window is a genuine prior by date alone — prose cannot override a hard date fact.
    // Invariant: excl===1 && selfMatchCount===0 ⟹ records.length===1, so records[0] is the single candidate.
    const candidate = (sh.salvage_auction_records || [])[0];
    let overrideDateOk = false;
    if (candidate?.salvage_auction_lot_date) {
      const recDate = new Date(candidate.salvage_auction_lot_date);
      if (!isNaN(recDate.getTime())) {
        overrideDateOk = Math.abs((Date.now() - recDate.getTime()) / (1000 * 60 * 60 * 24)) <= SELF_REF_DATE_WINDOW_DAYS;
      }
    }
    if (overrideDateOk) {
      console.error('[SALVAGE SELF-REF OVERRIDE] Prose confirmed self-reference that code missed (within 14-day window) — effectiveExcl forced from 1 to 0. Review tagSelfReference() criteria for this lot.');
      excl = 0;
      proseOverrideApplied = true;
    } else {
      console.error('[SALVAGE SELF-REF OVERRIDE REJECTED] Record date outside 14-day window — date guard blocked the prose override; genuine prior retained.');
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
        model: 'claude-opus-4-8',
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

async function runDashClusterRead(images, onExhaust, vehicleDesc) {
  const mismatchBlock = vehicleDesc
    ? `\nBODY-STYLE CROSS-CHECK — one field only:\nYou are given this data descriptor for this vehicle: "${vehicleDesc}". Scan ALL photos. Does any photo CLEARLY show this is a different vehicle TYPE — e.g. the descriptor says hatchback but the car is unmistakably a van, lorry, or motorbike? This is a STRICT mismatch test: default "match" or "unclear" unless the contradiction is beyond any doubt. Borderline SUV-vs-hatchback = "unclear". Fire "mismatch" ONLY on unambiguous cross-type contradiction (identity risk).`
    : '';
  const DASH_PROMPT = `You are reading instrument cluster state from salvage vehicle auction photos.

Apply this three-step decision in order:
1. Is a cluster/instrument panel visible in any photo? If no → return cluster "no-photo".
2. Is the cluster present but unlit or dark (engine not running, display off, photo too dark to judge)? If yes → return cluster "no-photo". A dark cluster tells you nothing and must NOT be read as clean.
3. Cluster is visible AND lit/powered. Are any warning telltale icons lit? If yes → return cluster "warning". If no → return cluster "clean".

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
{ "cluster": "no-photo" | "clean" | "warning", "telltales": "<describe all lit icons when warning; empty string otherwise>", "airbag": "no-photo" | "not-lit" | "warning-lit", "sticker": "<suffix letter, UNREADABLE, or empty string>", "bodyStyleMismatch": "match" | "mismatch" | "unclear" }`;

  const FLOOR = { cluster: 'no-photo', telltales: '', airbag: 'no-photo', sticker: '', bodyStyleMismatch: 'unclear' };
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
        model: 'claude-opus-4-8',
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
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[DASH READ] no JSON object in response:', raw.slice(0, 200)); return FLOOR; }
    const parsed = JSON.parse(match[0]);
    const cluster = ['no-photo', 'clean', 'warning'].includes(parsed.cluster) ? parsed.cluster : 'no-photo';
    const airbag  = ['no-photo', 'not-lit', 'warning-lit'].includes(parsed.airbag) ? parsed.airbag : 'no-photo';
    const rawSticker = typeof parsed.sticker === 'string' ? parsed.sticker.trim().toUpperCase() : '';
    const VALID_STICKER = ['X', 'P', 'C', 'Q', 'OTHER', 'UNREADABLE', ''];
    const sticker = VALID_STICKER.includes(rawSticker) ? rawSticker : 'UNREADABLE';
    console.log(`[DASH READ] rawSticker="${rawSticker}" → sticker="${sticker}"`);
    const bodyStyleMismatch = ['match', 'mismatch', 'unclear'].includes(parsed.bodyStyleMismatch) ? parsed.bodyStyleMismatch : 'unclear';
    return { cluster, telltales: typeof parsed.telltales === 'string' ? parsed.telltales : '', airbag, sticker, bodyStyleMismatch };
  } catch (err) {
    console.warn('[DASH READ] error:', err.message);
    return FLOOR;
  }
}

// Fault 1a — aperture torn-vs-seam read. Dedicated single-purpose vision pass (mirrors
// runDashClusterRead): a bumper-off rear-quarter / front-wing is byte-identical on every
// existing field between a genuinely torn panel and an intact seam merely exposed by the
// missing bumper. This read is the ONLY signal that separates them. It judges the PANEL'S
// OWN METAL: torn/folded/buckled = genuine impact (keep cost); straight intact seam = no
// panel damage (demote to flag). Returns a constrained enum; CODE owns the cost decision.
// Fail-safe: any failure/exhaust → null; invalid verdict → 'ambiguous'. Both keep cost
// (policy: on structure, ambiguity falls to assume-damage).
async function runAperturePanelRead(images, lampObs, onExhaust) {
  // Corner steer from the structured impact obs (hint only — model self-locates as lamp-detect does).
  const sideWord  = (lampObs?.struckSide === 'offside' || lampObs?.struckSide === 'nearside') ? lampObs.struckSide : '';
  const apertures = [];
  if (lampObs?.apertureExposed)     apertures.push('front');
  if (lampObs?.rearApertureExposed) apertures.push('rear');
  const cornerHint = `${sideWord ? sideWord + ' ' : ''}${apertures.join(' and ')}`.trim() || 'damaged';
  const APERTURE_PROMPT = `You are judging a single salvage vehicle from auction photos. The ${apertures.includes('rear') ? 'rear bumper' : 'front bumper'} is displaced or torn away on the ${cornerHint} corner, exposing the body panel behind it (the rear quarter panel for a rear corner, the front wing for a front corner).

Survey ALL photos to locate that corner, then focus on the ${cornerHint} corner where the bumper is displaced. Judge the BODY PANEL'S OWN METAL — not the bumper, not the panel gap:

TORN = the panel's own metal is folded, torn, buckled, creased, or crumpled; panel edges are displaced; the body line is deformed. This is genuine impact to the panel.
SEAM = a straight, intact factory seam or join line is now visible only because the bumper is gone, with NO metal deformation on the panel face itself. The panel is undamaged; you are seeing a normal join the bumper used to cover.

Return ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{ "verdict": "torn" | "seam" | "ambiguous", "evidence": "<one short sentence on the panel metal you can see>" }

Use "ambiguous" ONLY when the photos genuinely cannot resolve the panel's metal condition (angle, lighting, occlusion). Do NOT use "ambiguous" as a hedge when the metal condition is visible — decide torn or seam.`;
  try {
    if (images.length > 35) console.warn(`[APERTURE PANEL] image set truncated to 35 (received ${images.length})`);
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
    const { res, exhausted } = await with529Retry('aperture-panel', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
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
    const verdict  = ['torn', 'seam', 'ambiguous'].includes(parsed.verdict) ? parsed.verdict : 'ambiguous';
    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence : '';
    console.log(`[APERTURE PANEL] verdict=${verdict} evidence="${evidence.slice(0, 80)}"`);
    return { verdict, evidence };
  } catch (err) {
    console.warn('[APERTURE PANEL] error:', err.message);
    return null;
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
      model: 'claude-opus-4-8',
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
        model: 'claude-opus-4-8',
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

const PER_VIEW_PROMPT = `You are assessing damage on a salvage vehicle from a SINGLE photograph. This is one view of several; other views are assessed separately. Assess ONLY what THIS photograph shows. Do not infer, assume, or carry over anything from any other view — you have not seen them.

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

--- LOWER-FLANK GROUNDING (SILL, SIDE_SKIRT, and the lower extent of the doors) ---
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
        model: 'claude-opus-4-8',
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
      result.push({ panelId, _instanceKey: `${panelId}#1`, members: instanceMembers });
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
    const { panelId, members, _instanceKey } = group; // panelId is the enum-ID group key from groupByPanelId
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
    const damagedSevs = members
      .filter(l => /\|\s*iv:true\s*\|/i.test(l))
      .map(l => { const sm = l.match(/\|\s*sev:(SEVERE|MODERATE|MINOR)\s*\|/i); return sm ? sm[1].toUpperCase() : 'MODERATE'; });
    const severeVotes    = damagedSevs.filter(s => s === 'SEVERE').length;
    const severeOverride = severeVotes >= SEVERE_OVERRIDE_THRESHOLD;
    const hasModerate    = damagedSevs.some(s => s === 'MODERATE');
    const minorVotes     = damagedSevs.filter(s => s === 'MINOR').length;
    const minorOnly      = damagedSevs.length > 0 && severeVotes === 0 && !hasModerate;
    console.log(`[AMALG][SEV] ${panelId} grades=[${damagedSevs.join(',')}] severeVotes=${severeVotes} override=${severeOverride} minorOnly=${minorOnly}`);
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
        console.log(`[AMALG][COSMETIC] ${panelId} minorVotes=${minorVotes} < ${MINOR_COSMETIC_FLAG_THRESHOLD} → single unsupported MINOR → cleared (no flag, no cost)`);
        costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null, _perViewClear: true });
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
      console.log(`[AMALG] ${panelId} disagree (${damaged} damaged, ${clean} clean) → floor`);
      costedParts.push({ panelId, partName, zone, independentlyVisible: false, partHeight: null });
      flaggedParts.push({ panelId, partName, zone, weight: 'medium', reason: AMALG_REASON_DISAGREE, _amalgDisagree: true });
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
    pvVotesMap[pvKey] = { views: members.length, resolving, damaged, clean, notVisible: missing, branch };
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

function computeLampResult(struckSide, apertureExposed, lampType, detectionVerdict = null, detectionLampType = null, damageSpan = 'single_corner') {
  // struckSide kept as internal field for logging only — never interpolated into rendered strings
  const side = (struckSide === 'offside' || struckSide === 'nearside') ? struckSide : 'central';

  // Band selection: take the HIGHER of spec-derived and detection-reported (never under-budget)
  const LAMP_RANK    = { halogen: 1, hid: 2, led: 3 };
  const specAssumed      = !HEADLAMP_BANDS[lampType];
  const resolvedSpecType = specAssumed ? HEADLAMP_BAND_DEFAULT : lampType;
  const resolvedDetType  = (detectionLampType && HEADLAMP_BANDS[detectionLampType]) ? detectionLampType : null;
  const resolvedType     = (resolvedDetType && (LAMP_RANK[resolvedDetType] ?? 0) > (LAMP_RANK[resolvedSpecType] ?? 0))
    ? resolvedDetType : resolvedSpecType;
  const bandValue       = HEADLAMP_BANDS[resolvedType];
  const lampTypeAssumed = specAssumed && !resolvedDetType;

  // Lamp count from geometry: full-width frontal implies both lamps implicated
  const lampCount = (apertureExposed && damageSpan === 'full_width') ? 2 : 1;

  const assumedDisclosure = ' Lamp type could not be confirmed from the vehicle spec, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';
  const tier1Line = 'Struck front corner — confirm a serviceable headlamp on inspection.';

  if (!apertureExposed) {
    return { tier: 1, tier2Fired: false, struckSide: side, tier1Line, lampType: resolvedType, lampTypeAssumed, lampAllowance: 0, lampCount: 1 };
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
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
  }

  if (effectiveVerdict === 'missing') {
    let verdictLine = `Struck front corner headlamp — the headlamp on the struck corner is missing. Replacement costed at £${bandValue} (${resolvedType}).`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
  }

  // cannot_determine — default path and toggle-OFF 'missing'
  let verdictLine = `Struck front corner headlamp — on a displaced-bumper front-corner impact the headlamp is treated as a replacement; presence and serviceability cannot be confirmed from the photos. Replacement costed at £${bandValue} (${resolvedType}).`;
  verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
  const costDriverEntry = lampTypeAssumed
    ? `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}, assumed).`
    : `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}).`;
  return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
}

// ── Parts Breakdown helpers ──────────────────────────────────────────────────

function parsePrice(s) {
  if (!s || /^[—\-–]+$|n\/a|nil|none/i.test(s.trim())) return null;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

function parseParts(text) {
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
    const resolvedName = PANEL_DISPLAY[panelId] ?? rawName;
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
  const deployed = /\bair\s?bags?\b[^.\n]{0,20}\bdeployed\b|\bdeployed\b[^.\n]{0,20}\bair\s?bags?\b/i.test(paste);
  // High-bar explicit "airbags NOT deployed / intact" — the only structured positive-no-deployment
  // signal (the enum never emits an intact vote). Only ever suppresses a flag, never a cost.
  const intact = !deployed && /\bair\s?bags?\b[^.\n]{0,30}\b(?:not deployed|undeployed|intact|did not deploy|didn'?t deploy)\b/i.test(paste);
  // Count/position — scoped to airbag-context sentences only.
  const ctxBlob = paste.split(/(?<=[.!?\n])\s+/).filter(s => /\bair\s?bags?\b|\bsrs\b/i.test(s)).join(' ');
  const curtainSide = /\bcurtain\b|\bthorax\b|seat[\s-]?mounted|\bside\b[^.\n]{0,12}air\s?bag|air\s?bag[^.\n]{0,12}\bside\b/i.test(ctxBlob);
  const bothFront   = /\bdriver\b/i.test(ctxBlob) && /\bpassenger\b/i.test(ctxBlob);
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
    if (session.image_paths?.length) {
      images = await fetchImagesFromStorage(supabase, session.image_paths);
    } else if (session.images?.length) {
      images = session.images; // legacy sessions stored base64 directly
    } else {
      return NextResponse.json({ error: 'No images found for this session' }, { status: 400 });
    }

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

    const enrichedVd = normaliseLot(vd);

    // TEMP NORM-VALIDATION — REMOVE after field diff vs NORM-BASELINE confirmed (zero changes except damageDescription Category label)
    console.log('[NORM VALIDATION]', JSON.stringify(enrichedVd));

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
          model: 'claude-haiku-4-5-20251001',
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
        const parsed = uniq.length === 1 ? uniq[0] : NaN;
        if (!isNaN(parsed)) photoOdometer = parsed;
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

      const [shResult, brResult] = await Promise.all([
        withOneAutoCache('SALVAGEHISTORY', cleanVrmB, async () => {
          const r = await fetch(`${oneAutoBase}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrmB}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
        withOneAutoCache('BREGO_GB', cleanVrmB, async () => {
          const r = await fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrmB}&current_mileage=${brMileage}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
      ]);

      if (shResult) {
        tagSelfReference(shResult, enrichedVd);
        enrichedVd.salvageHistory = shResult;
      }

      if (brResult) {
        bregoData = { ...brResult, _mileageSource: brMileageSource, _mileageUsed: brMileage };
        enrichedVd.bregoValuation = bregoData;
      }
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
      enrichedVd.damageDescription && `Seller/Copart Damage Description: ${enrichedVd.damageDescription}`,
      enrichedVd.dvlaVerified && `DVLA Verified: Yes — vehicle identity confirmed against DVLA database`,
      enrichedVd.colour && `DVLA Colour: ${enrichedVd.colour}`,
      enrichedVd.fuelType && `DVLA Fuel Type: ${enrichedVd.fuelType}`,
      enrichedVd.taxStatus && `Tax Status: ${enrichedVd.taxStatus}`,
      enrichedVd.motStatus && `MOT Status: ${enrichedVd.motStatus}`,
      enrichedVd.lastMotMileage && `Last MOT Recorded Mileage: ${enrichedVd.lastMotMileage} miles`,
      (() => {
        const mh = enrichedVd.motHistory;
        if (!Array.isArray(mh) || mh.length === 0) return null;
        const lines = mh.slice(0, 15).map(t => {
          const result  = (t.testResult || '').toUpperCase() === 'PASSED' ? 'PASS' : 'FAIL';
          const odo     = t.odometerValue != null ? `${Number(t.odometerValue).toLocaleString('en-GB')}mi` : '';
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
      enrichedVd.primaryDamage && `Primary Damage: ${enrichedVd.primaryDamage}`,
      enrichedVd.secondaryDamage && `Secondary Damage: ${enrichedVd.secondaryDamage}`,
      enrichedVd.additionalDamage && `Additional Damage: ${enrichedVd.additionalDamage}`,
      enrichedVd.v5Status && `V5 Status: ${enrichedVd.v5Status}`,
      (() => {
        const sh = enrichedVd.salvageHistory;
        if (!sh) return null;
        const found = sh.salvage_auction_record_found === true;
        const records = sh.salvage_auction_records || [];
        if (!found) return 'Previous Salvage Auction History: No previous salvage auction history found.';
        const lines = records.map((rec, i) => [
          `Record ${i + 1}:`,
          rec.salvage_auction_lot_date && `  Lot Date: ${rec.salvage_auction_lot_date}`,
          rec.mileage != null          && `  Mileage at Sale: ${Number(rec.mileage).toLocaleString()} miles`,
          rec.primary_damage_desc      && `  Primary Damage: ${rec.primary_damage_desc}`,
          rec.secondary_damage_desc    && `  Secondary Damage: ${rec.secondary_damage_desc}`,
        ].filter(Boolean).join('\n')).join('\n');
        return `Previous Salvage Auction History (${records.length} record${records.length !== 1 ? 's' : ''} found):\n${lines}`;
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

    const frontStruck    = /front/i.test(enrichedVd.primaryDamage || '') || /front/i.test(enrichedVd.secondaryDamage || '');
    const rearStruck     = /rear/i.test(enrichedVd.primaryDamage  || '') || /rear/i.test(enrichedVd.secondaryDamage  || '');
    const hasImpactZone  = frontStruck || rearStruck; // derived from listing descriptors only — no prose

    // Call 1 tools: LAMP_OBS_TOOL always offered (item 14 — trigger input-integrity).
    // Force guard (iter===0 && hasImpactZone): fires on front OR rear impact lots from listing data.
    // Non-impact lots (fire/flood/theft/mechanical): hasImpactZone=false — tool offered but not
    // forced; model will not call it; lampObs stays null correctly.
    const claudeTools = [LAMP_OBS_TOOL];
    const messages = [{ role: 'user', content: userContent }];
    let lampObs = null;
    let lampObsSource = null;
    let coreObs = null;
    let rawText = '';

    // Fire lamp detection in parallel with the Claude assess call — joins after
    const lampDetectionPromise = frontStruck
      ? runLampDetection(images, () => _exhaustedCalls.add('lamp-detect'))
      : Promise.resolve(null);
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

    const callClaude = async (withTools, forced = false) => {
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
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
      return { res, data, exhausted: false };
    };

    // Tool-use loop — keep calling with tools while the model keeps recording observations,
    // then a final no-tools call forces the prose (mirrors the existing lamp two-call shape,
    // generalised so either/both forced tools can fire in one round or across several).
    // iter=0 on impact lots (hasImpactZone): forced=true so the model MUST call
    // recordImpactObservation (tool_choice:{type:'any'}). iter>=1: forced=false — continuation
    // rounds have tool_result context and must be free to end_turn into prose naturally.
    const MAX_TOOL_ROUNDS = 4;
    for (let iter = 0; iter < MAX_TOOL_ROUNDS; iter++) {
      const { res: apiRes, data: apiData, exhausted: call1Exhausted } = await callClaude(true, iter === 0 && hasImpactZone);
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
            lampObs = {
              struckSide:          block.input?.struckSide     || 'central',
              apertureExposed:     Boolean(block.input?.apertureExposed),
              damageSpan:          block.input?.damageSpan     || 'single_corner',
              rearApertureExposed: block.input?.rearApertureExposed === true,
            };
            lampObsSource = (iter === 0 && hasImpactZone) ? 'listing-forced' : 'voluntary-iter0';
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
        },
        required: ['provenanceConcernFlagged', 'salvageSelfReferenceConfirmed', 'perZone'],
      },
    };

    const call2Start = Date.now();
    const { res: call2Res, exhausted: call2Exhausted } = await with529Retry('call2', () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        tools: [CORE_EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: 'recordCoreObservations' },
        messages: [{
          role: 'user',
          content: `Extract provenance verdicts and per-zone damage classification from this vehicle assessment. Report only what the text explicitly states — do not interpret, infer, or add anything beyond what is written.\nFor provenanceConcernFlagged: set true ONLY if the text explicitly raises a concern about why the vehicle is in salvage or its vendor entry channel; false otherwise.\nFor salvageSelfReferenceConfirmed: set true ONLY if the text explicitly concludes the single salvage record is this lot's own current first write-off entry; false otherwise.\nFor perZone: one entry per damage zone mentioned in the prose; zone must be one of: front, rear, flank-damaged-side, roof, underside, interior; heightBand must be null for non-impact eventTypes.\n\n${rawText}`,
        }],
      }),
    }));
    let call2Data = null;
    if (call2Exhausted) {
      _exhaustedCalls.add('call2');
      console.error('[CALL2] 529-exhausted — coreObs floor default will fire');
    } else if (!call2Res?.ok) {
      console.error(`[CALL2] API error ${call2Res?.status}`);
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
      };
      console.log(`[CALL2] extracted provenanceConcernFlagged=${coreObs.proseFlags.provenanceConcernFlagged} provenanceConcernReason=${coreObs.proseFlags.provenanceConcernReason ? JSON.stringify(coreObs.proseFlags.provenanceConcernReason.slice(0, 100)) : 'none'} salvageSelfReferenceConfirmed=${coreObs.proseFlags.salvageSelfReferenceConfirmed} perZone=${coreObs.perZone.length}`);
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
        costedParts: [],
        flaggedParts: [],
      };
      console.log('[CORE OBS] Call 2 extraction failed — honest-absence floor defaults applied; proseFlags=null perZone/costedParts/flaggedParts=[] (unavailable)');
    }

    // Join lamp detection (ran in parallel with Claude calls)
    const lampDetectionRaw = await lampDetectionPromise;
    const detectedCorner   = lampDetectionRaw ? selectStruckCornerVerdict(lampDetectionRaw) : null;
    if (frontStruck) {
      console.log('[LAMP DETECT]', detectedCorner
        ? `struck corner: verdict=${detectedCorner.verdict} lamp_type=${detectedCorner.lamp_type} evidence="${(detectedCorner.evidence || '').slice(0, 80)}"`
        : lampDetectionRaw ? 'no struck corner identified in response' : 'call skipped or failed');
    }

    // Layer 2 backstop (item 14): frontStruck=true but no lampObs from Call 1.
    // Migrated from perZone-based trigger to code-owned frontStruck — no prose dependency.
    // Uses the full Call-1 thread (Opus — thread carries 1568px images, Haiku-safe resize not applicable).
    // Expected input: ~22–33K tokens (system prefix cached + messages thread). max_tokens=512 covers
    // one tool_use block; observed backstop output at BL75JAU iter=0: 97 tokens.
    if (!_exhaustedCalls.has('call1') && frontStruck && !lampObs) {
      console.log('[LAMP] Layer 2 backstop triggered — frontStruck=true, no Call-1 lamp observation');
      const { res: backstopRes, exhausted: backstopExhausted } = await with529Retry('backstop', () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 512,
          system: [{ type: 'text', text: ASSESSMENT_ENGINE_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [
            ...messages,
            { role: 'assistant', content: rawText },
            { role: 'user', content: 'You identified impact damage in your assessment above. Call recordLampObservation now, based on the photos and your assessment: record struckSide and damageSpan; set apertureExposed if the FRONT bumper is displaced or removed exposing the wing-to-bumper or lamp seam; and set rearApertureExposed if the REAR bumper is torn or displaced exposing the rear-quarter seam. Assess the front and rear apertures independently — do not assume the rear bumper is intact because the main impact is at the front.' },
          ],
          tools: [LAMP_OBS_TOOL],
          tool_choice: { type: 'any' },
        }),
      }));
      if (backstopExhausted || !backstopRes?.ok) {
        lampObs = { struckSide: 'central', apertureExposed: false };
        lampObsSource = 'layer2-backstop';
        console.warn('[LAMP] Layer 2 backstop 529-exhausted or error — tier-1 floor applied (apertureExposed:false)');
      } else {
        const backstopData = await backstopRes.json();
        console.log(`[LAMP] Layer 2: stop=${backstopData.stop_reason} input=${backstopData.usage?.input_tokens} output=${backstopData.usage?.output_tokens}`);
        const backstopBlock = (backstopData.content || []).find(b => b.type === 'tool_use' && b.name === 'recordLampObservation');
        if (backstopBlock?.input) {
          lampObs = {
            struckSide:      backstopBlock.input?.struckSide      || 'central',
            apertureExposed: Boolean(backstopBlock.input?.apertureExposed),
            damageSpan:      backstopBlock.input?.damageSpan      || 'single_corner',
          };
          lampObsSource = 'layer2-backstop';
          console.log(`[LAMP] Layer 2 observation: struckSide=${lampObs.struckSide} apertureExposed=${lampObs.apertureExposed} damageSpan=${lampObs.damageSpan}`);
        } else {
          lampObs = { struckSide: 'central', apertureExposed: false };
          lampObsSource = 'layer2-backstop';
          console.log('[LAMP] Layer 2 backstop failed — no tool block returned; tier-1 floor applied (apertureExposed:false)');
        }
      }
    }

    // Defensive floor: frontStruck=true from text fields but no observation after all layers
    // (guards against transient API failures on the item-13 forced path; should not fire in practice)
    if (frontStruck && !lampObs) {
      lampObs = { struckSide: 'central', apertureExposed: false };
      lampObsSource = 'no-arm';
      console.log('[LAMP] frontStruck text-confirmed — no observation after all layers; tier-1 floor applied');
    }

    // Layer 3: unconditional trigger observability — one line per run, every lot
    lampObsSource = lampObsSource || 'no-arm';
    console.log(`[LAMP][TRIGGER] source=${lampObsSource}`);

    // Fault 1a — fire the aperture torn-vs-seam read now that lampObs is final. Gated on
    // bumper-off (same source the demotion uses); on non-bumper-off lots it never calls.
    // Fired here as a promise so its fetch overlaps the synchronous reconciliation work
    // below; awaited just before the demotion loop so apertureVerdict is in hand there.
    const aperturePanelPromise =
      (lampObs?.apertureExposed === true || lampObs?.rearApertureExposed === true)
        ? runAperturePanelRead(images, lampObs, () => _exhaustedCalls.add('aperture-panel'))
        : Promise.resolve(null);

    let lampResult = null;
    if (lampObs) {
      const derivedLampType = deriveLampType(enrichedVd);
      lampResult = computeLampResult(
        lampObs.struckSide, lampObs.apertureExposed, derivedLampType,
        detectedCorner?.verdict   || null,
        detectedCorner?.lamp_type || null,
        lampObs.damageSpan        || 'single_corner'
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
    if (lampResult) assessment._lampResult = lampResult;
    assessment._lampObs = lampObs ? {
      apertureExposed: lampObs.apertureExposed,
      ...('rearApertureExposed' in lampObs ? { rearApertureExposed: lampObs.rearApertureExposed } : {}),
      ...('damageSpan'          in lampObs ? { damageSpan:          lampObs.damageSpan }          : {}),
      lampObsSource: lampObsSource ?? null,
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
    const rawParts = parseParts(assessment['Parts Breakdown'] || '');

    // (raw ledger computation moved above main call — Step 4a; assignments remain below)
    coreObs.costedParts  = pvResult.costedParts;
    coreObs.flaggedParts = pvResult.flaggedParts;
    assessment._pvVotes  = pvResult.pvVotesMap ?? null;
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

    // Fault 1a — resolve the aperture verdict before the demotion decision. 'torn'/'ambiguous'/
    // null all keep cost (assume-damage on structure); only 'seam' demotes. null = call skipped
    // (not bumper-off), failed, exhausted, or unparseable — all fail safe toward cost.
    const aperturePanelRaw = await aperturePanelPromise;
    const apertureVerdict  = aperturePanelRaw?.verdict ?? null; // 'torn' | 'seam' | 'ambiguous' | null

    // ── Bumper-off rule ────────────────────────────────────────────────────────
    // Code-owned, no model call. Runs BEFORE perception probe so the probe never
    // challenges a panel already demoted here.
    // Signal: bumper physically off (apertureExposed / rearApertureExposed from the
    // structured early call) → adjacent wing/quarter seam exposed → line demoted.
    // No peel/crush classification: bumper off is sufficient — the seam is exposed
    // regardless of how the bumper left.
    const bumperOffDemoted = []; // { partName, rx } — fed to KCD scrub below
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
      for (const cp of coreObs.costedParts) {
        if (cp.independentlyVisible !== true || cp._labourSafe || cp._amalgMissing === true) continue;
        const isFW = /\bfront\b.*\bwing\b/i.test(cp.partName);
        const isRQ = /\brear\b.*\bquarter\b/i.test(cp.partName);
        const bumperOffHere = (isFW && frontBumperOff) || (isRQ && rearBumperOff);
        if (bumperOffHere) {
          // Fault 1a — gate the demotion on the torn-vs-seam vision verdict. Demote ONLY on a
          // confirmed intact seam; 'torn'/'ambiguous'/null keep cost (cost survives via the
          // existing G-inject table path for _gOwned, or applyVisibilityGate for a model row).
          const apertureSaysDemote = (apertureVerdict === 'seam');
          console.log(`[APERTURE GATE] panel="${cp.partName}" verdict=${apertureVerdict} → ${apertureSaysDemote ? 'demote' : 'keep-cost'}`);
          if (!apertureSaysDemote) continue;
          cp.independentlyVisible = false;
          cp._bumperOffStripped = true;
          // 1b flag-gap: a _gOwned panel (no model Parts row) demoted here never reaches
          // gateStripped, so the gate's :281-288 bumper-off flag never fires for it and the
          // panel vanishes (no cost, no flag). Push the inspection flag at the demotion site,
          // mirroring the RAD hatch (:2963). The gate's strip-loop dedup (parts.mjs :279,
          // keyed on normName(partName), no _gateGenerated clause) suppresses its own push
          // when a model row DOES exist, since this push lands first. reason matches the gate
          // byte-for-byte (BUMPER_OFF_SEAM_REASON + RQ rider). Additive only — no cost path.
          coreObs.flaggedParts.push({
            panelId:  cp.panelId,
            partName: cp.partName,
            zone:     cp.zone,
            weight:   'medium',
            reason:   isRQ ? BUMPER_OFF_SEAM_REASON + BUMPER_OFF_RQ_RIDER : BUMPER_OFF_SEAM_REASON,
            _bumperOffStripped: true,
          });
          bumperOffDemoted.push({ partName: cp.partName, rx: isRQ ? /\brear\b.*\bquarter\b/i : /\bfront\b.*\bwing\b/i });
          console.log(`[BUMPER-OFF] demoted "${cp.partName}" — bumper displaced, seam exposed`);
        }
      }
    }
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
        } else {
          // Mirror the bumper-off demotion: iv=false in place → the gate strips it from the total
          // and the G-inject guard skips it. Push the specific inspection flag here so the gate's
          // generic strip reason is deduped out (it keys on partName).
          radEntry.independentlyVisible = false;
          radEntry._radUncorroborated = true;
          coreObs.flaggedParts.push({ panelId: PANEL.RADIATOR_PACK, partName: PANEL_DISPLAY[PANEL.RADIATOR_PACK], zone: radEntry.zone, weight: 'medium', reason: AMALG_REASON_RAD_UNCORROBORATED, _radUncorroborated: true });
          console.log(`[RAD FLOOR] RADIATOR_PACK damaged=${radVotes.damaged} (single-grade, views=${radVotes.views}) AND no low-centre proxy (slamSevere=false frontStructureSevere=false) → floor to inspection`);
        }
      }
    }

    // ── KCD scrub — drop demoted-part driver lines ────────────────────────────
    // Structured KCD (part-name-first before ':' on each line) lets code locate
    // and drop any driver whose leading token is a bumper-off demoted part.
    // Deterministic: the token IS the canonical Parts Breakdown part name.
    // Fail-safe: lines with no colon-delimited token are kept, never dropped.
    if (bumperOffDemoted.length > 0 && assessment['Key Cost Drivers']) {
      const lines = assessment['Key Cost Drivers'].split('\n');
      const kept = lines.filter(line => {
        const m = line.match(/^[\s\-*•\d.]*(.+?):/);
        if (!m) return true;
        const tok = m[1].trim();
        return !bumperOffDemoted.some(d => d.rx.test(tok));
      });
      if (kept.length < lines.length) {
        console.log(`[KCD SCRUB] dropped ${lines.length - kept.length} line(s) for bumper-off demoted parts`);
        assessment['Key Cost Drivers'] = kept.join('\n').trim() || '';
      }
    }
    // ── End KCD scrub ─────────────────────────────────────────────────────────

    // ── VDS scrub retired (Step 4c) ───────────────────────────────────────────
    // The model no longer authors per-panel VDS prose, so there is nothing to
    // reframe — the per-panel damage section is code-assembled into _vdsParts after
    // finalisation (see assembleVdsParts below). The bumper-off seam reason now
    // reaches the buyer via the gate-generated Inspection Flag (BUMPER_OFF_SEAM_REASON
    // in applyVisibilityGate) and the assembled VDS block for the demoted panel.

    // ── Red Flags scrub — full-line regex drop ────────────────────────────────
    // Full-line regex (not leading-token): catches combined-line entries with no
    // colon delimiter (e.g. "Rear quarter inner structure unknown — OUTER
    // deformation visible"). Inner-structure concern is preserved in the
    // gate-generated Inspection Flag (BUMPER_OFF_SEAM_REASON + rear-quarter
    // inner-structure addendum — see lib/parts.mjs applyVisibilityGate).
    if (bumperOffDemoted.length > 0 && assessment['Red Flags']) {
      const rfLines = assessment['Red Flags'].split('\n');
      const rfKept  = rfLines.filter(line => !bumperOffDemoted.some(d => d.rx.test(line)));
      if (rfKept.length < rfLines.length) {
        console.log(`[RED FLAGS SCRUB] dropped ${rfLines.length - rfKept.length} line(s) for bumper-off demoted parts`);
        assessment['Red Flags'] = rfKept.join('\n').trim() || '';
      }
    }
    // ── End Red Flags scrub ───────────────────────────────────────────────────

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

        // Locate the bare disagree-floor costed twin: iv:false carrying NONE of the other
        // floor/clear markers (the disagree branch at :1674 pushes exactly this shape).
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
        const fi = coreObs.flaggedParts.indexOf(flag);
        if (fi !== -1) coreObs.flaggedParts.splice(fi, 1);
        console.log(`[AMALG][STICKY] ${flag.partName} damaged=${votes.damaged}/${votes.resolving} ratio=${ratio.toFixed(3)} zone=${flag.zone} struck → cost (was disagree-floor)`);
      }
    }
    // ── End in-zone sticky cost rescue ─────────────────────────────────────────

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

    const { parts: reconciledParts, allowanceParts } = reconcileParts(rawParts, lampResult, coreObs.costedParts, grilleAllowance, bandKey);

    // Phase 2 — visibility gate (Test 1); lamp rows are rule-B paired and the
    // mandated lamp row is band-retained, never removed (CB7 fix, lib/parts.mjs)
    const { gatedParts } = applyVisibilityGate(reconciledParts, coreObs.costedParts, coreObs.flaggedParts, lampResult);

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

    // IN-PLAY gate — independent of airbag deployment evidence (verbatim from the recovered gate).
    const _srsInteriorVision = coreObs.costedParts.some(cp =>
      cp.panelId === PANEL.OTHER && cp.zone === 'interior' && cp.independentlyVisible === true);
    const _srsCabinImpact = frontStruck
      || /front|cabin|interior|air\s?bag|roll[\s-]?over/i.test(`${enrichedVd.primaryDamage || ''} ${enrichedVd.secondaryDamage || ''}`);
    const _srsGateOpen = _srsInteriorVision || _srsCabinImpact;

    // DEPLOYMENT — CODE-owned from the per-view AIRBAG enum (authoritative), corroborated by paste.
    const _airbagVotes    = pvResult.pvVotesMap?.AIRBAG ?? null;
    const _airbagEnumFlag = coreObs.flaggedParts.some(f => f.panelId === PANEL.AIRBAG);
    const _deploymentByEnum = (_airbagVotes?.damaged > 0) || _airbagEnumFlag;
    const _srsPaste = analyseAirbagPaste(enrichedVd.rawCopartPaste);
    const srsT = srsTierFromSignals(_deploymentByEnum, _srsPaste);
    let srsInjected = false;
    let srsDeferred = false;
    console.log(`[SRS_TIER] gateOpen=${_srsGateOpen} (interiorVision=${_srsInteriorVision} cabinImpact=${_srsCabinImpact}) enumDeployed=${_deploymentByEnum} (votes=${_airbagVotes?.damaged ?? 0} amalgFlag=${_airbagEnumFlag}) paste={deployed:${_srsPaste.deployed},intact:${_srsPaste.intact},curtainSide:${_srsPaste.curtainSide},bothFront:${_srsPaste.bothFront}} → deploymentConfirmed=${srsT.deploymentConfirmed} tier=${srsT.tier ? 'T' + srsT.tier : 'none'} confident=${srsT.confident} countResolved=${srsT.countResolved} branch=${srsT.branch}`);

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
        reason: 'Front/cabin impact with airbag status unconfirmed in the listing — confirm whether the SRS airbags deployed on inspection before bidding.',
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
    // Fires on EVERY lot from enrichedVd (fuelType via ...rawVd, fuel listing-parsed). Computed
    // here (moved above the weight-sort) so Step 2 can read it before the flag is re-weighted.
    const isBev = isBevLot(enrichedVd, hvLabelSeen);
    assessment._isBev = isBev;
    console.log(`[EV GATE] isBev=${isBev} (DVLA fuelType="${enrichedVd.fuelType ?? ''}" listing fuel="${enrichedVd.fuel ?? ''}" hvLabelSeen=${hvLabelSeen})`);

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

    // EV-integrity Step 3 — dash/cluster read (ran in parallel with main call, joins here).
    // Fires on ALL lots; not gated on isBev. Now also extracts sticker suffix + body-style
    // mismatch (Part C) so Call-2 no longer mines prose for those values.
    const dashRead = await dashReadPromise;
    assessment._dashState  = dashRead.cluster;
    assessment._airbagState = dashRead.airbag;
    console.log(`[DASH READ] cluster=${dashRead.cluster} airbag=${dashRead.airbag} telltales="${dashRead.telltales}"`);

    // Part B — body-style owner: Brego vehicle_desc (code-owned for all GB lots with a live
    // valuation call). Degrades gracefully to make/model/year if vehicle_desc absent (~7%
    // of lots where Brego is unavailable). Never fabricates a class word.
    assessment._bodyStyle = enrichedVd.bregoValuation?.vehicle_desc ||
      [enrichedVd.make, enrichedVd.model, enrichedVd.year].filter(Boolean).join(' ') || null;

    // Part C — sticker suffix from vision dash-read (migrated from Call-2 prose extraction).
    // Backfill coreObs.windscreenSticker so resolveVendorSuffix() works unchanged downstream.
    const _rawSticker = dashRead.sticker || '';
    assessment._stickerSuffix = _rawSticker || 'UNREADABLE';
    coreObs.windscreenSticker = {
      visible:      Boolean(_rawSticker && _rawSticker !== 'UNREADABLE'),
      suffixLetter: _rawSticker || 'UNREADABLE',
    };
    coreObs.bodyStyleMismatch = dashRead.bodyStyleMismatch || 'unclear';
    console.log(`[BODY/STICKER] bodyStyle="${assessment._bodyStyle}" stickerSuffix=${assessment._stickerSuffix} bodyStyleMismatch=${coreObs.bodyStyleMismatch}`);

    // Assemble code-owned dashboard line (replaces model VDS cluster assertion).
    const _dashLine = dashRead.cluster === 'warning'
      ? `Dashboard read: warning light(s) shown — ${dashRead.telltales}`
      : dashRead.cluster === 'clean'
      ? 'Dashboard read: cluster lit, no warning lights shown.'
      : 'Dashboard not visible in the listing photos.';
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
      : 'Dashboard not visible — airbag state could not be confirmed from photos. Confirm on inspection.';

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
      } else if (_exhaustedCalls.size > 0) {
        console.log(`[529 OK] degraded-within-tolerance lostViews=${_pvExhaustedCount}`);
      }
    }

    // Code-assembled Visible Damage Summary (Step 4c). COSTED PANELS ONLY — one block per
    // real repair line (action + finalised figure). Floored/flagged panels live in the
    // Inspection Flags surface, never here (one panel, one surface). No model-authored
    // per-panel prose survives. Reads the FINALISED ledger (post bumper-off, post gate).
    assessment._vdsParts = assembleVdsParts(coreObs.costedParts, gatedParts);
    console.log(`[VDS ASSEMBLE] ${assessment._vdsParts.length} code-assembled costed block(s)`);

    const parts_sum = sumPartsRealistic(gatedParts);

    // Instrumentation finalised post-gate: lamp_delta/lamp_inserted describe the
    // rows actually inside parts_sum — reality, never assumption (CB7 fix)
    const { lamp_delta, lamp_inserted, lamp_count } = finalizeLampInstrumentation(gatedParts, lampResult);

    if (gatedParts.length > 0) {
      assessment['Parts Breakdown'] = renderParts(gatedParts);
    }
    assessment._reconciledParts = gatedParts;
    assessment._preGateParts    = reconciledParts;
    assessment._allowanceParts  = allowanceParts;
    assessment._partsReconciliation = { parts_sum, lamp_delta, lamp_inserted, lamp_count };
    console.log(`[PARTS] repair=£${parts_sum} lamp_inserted=${lamp_inserted} lamps=${lamp_count} band_each=£${lampResult?.lampAllowance ?? 0} lamp_delta=£${lamp_delta}`);

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

    // Code-owned exit value: trade-low × band percentage keyed by category + model's 5-step position
    let exitValue = null;
    if (bregoData?.trade_low_valuation) {
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

    if (auctionSource === 'copart' && parts_sum > 0 && exitValue != null) {
      const marginScenarios = buildHammerLadder(exitValue).map(hammer => {
        const fees = feeStack(hammer);
        const hammerVat = lotIsVatQualifying ? Math.round(hammer * 0.20 * 100) / 100 : 0;
        const margin = Math.round((exitValue - parts_sum - hammer - hammerVat - fees.totalIncVat) * 100) / 100;
        return { hammer, exit_value: exitValue, repair: parts_sum, hammerVat, ...fees, margin };
      });
      assessment._marginScenarios = marginScenarios;
      console.log(`[MARGIN] exit=£${exitValue} repair=£${parts_sum} scenarios=${marginScenarios.length}`);
    } else if (auctionSource === 'copart') {
      console.warn(`[MARGIN] skipped — parts_sum=${parts_sum} exitValue=${exitValue}`);
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

    logEvent('assessment_submitted', { vrm: enrichedVd.vrm || '', metadata: { lot_number: enrichedVd.lotNumber || null } });

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
