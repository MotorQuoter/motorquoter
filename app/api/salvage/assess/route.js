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
  needsLampBackstop,
} from '@/lib/parts.mjs';
import { sanitizeSideTerms } from '@/lib/sanitizeProse';

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
    // Date is the required primary gate — a record excludes ONLY IF within 14 days AND mileage+category match.
    // Any record older than 14 days is ALWAYS a genuine prior regardless of mileage proximity.
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
    if (daysDelta === null || daysDelta > 14) return false; // date gate: required AND condition

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

// Reads the windscreen-sticker letter the MODEL saw (vision-only — Vincent confirmed 06 Jun
// the suffix is on the sticker photo, never in listing text) and resolves it through the
// code-owned VENDOR_SUFFIX_MAP. source: 'model' so two-pass cross-checks the sticker read.
function resolveVendorSuffix(coreObs) {
  const sticker = coreObs.windscreenSticker || {};
  const visible = Boolean(sticker.visible);
  const letter = sticker.suffixLetter || 'UNREADABLE';
  if (!visible || letter === 'UNREADABLE') return { status: 'unreadable', letter: null, mapped: null };
  if (letter === 'OTHER') return { status: 'other', letter, mapped: null };
  return { status: 'mapped', letter, mapped: VENDOR_SUFFIX_MAP[letter] || null };
}

function buildVendorSuffixSlot(vendorSuffix) {
  if (vendorSuffix.status === 'unreadable') {
    return buildSlot({
      id: 'vendor-suffix', label: 'Vendor type (windscreen sticker suffix)',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: 'Vendor suffix not readable — provenance signal unavailable',
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
  const m = String(text).match(/(\d)\s*[- ]?\s*door/i);
  return m ? parseInt(m[1], 10) : null;
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
  const listing = (enrichedVd.bodyStyle || '').trim();
  const observed = (coreObs.bodyStyle?.observed || '').trim();
  const listingDoors = extractDoorCount(listing);
  const observedDoors = extractDoorCount(observed);

  if (!observed) {
    return buildSlot({
      id: 'body-style', label: 'Body style matches listing',
      kind: 'confirmation', verdict: 'unconfirmed',
      detail: listing
        ? `Listing says ${listing} — body style not clearly visible in the photos`
        : 'No body style given on the listing and none clearly visible in the photos',
      confidence: listing ? 'inferred' : 'hidden', source: 'code+model',
    });
  }
  if (listing && listingDoors != null && observedDoors != null && listingDoors !== observedDoors) {
    return buildSlot({
      id: 'body-style', label: 'Body style matches listing',
      kind: 'confirmation', verdict: 'discrepancy',
      detail: `Listing says ${listing} (${listingDoors}-door) — photos look like a ${observedDoors}-door ${observed}`,
      confidence: 'visible', source: 'code+model',
      flag: { severity: 'caution', whatsapp: `Listing says ${listingDoors}-door but the car in the photos looks like a ${observedDoors}-door — confirm the derivative/body style before bidding`, tier: 1 },
    });
  }
  return buildSlot({
    id: 'body-style', label: 'Body style matches listing',
    kind: 'confirmation', verdict: 'confirmed',
    detail: listing
      ? `Listing: ${listing} · Photos: ${observed} — consistent`
      : `Photos clearly show a ${observed} — listing carries no body style to compare against, but the photo read is confident`,
    confidence: listing ? 'corroborated' : 'visible', source: 'code+model',
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

function buildProvenanceContradictionSlot(enrichedVd, vendorSuffix, brMileage, brAgeYears, proseFlags) {
  const currentYear = new Date().getFullYear();
  const listedYear = enrichedVd.year ? parseInt(String(enrichedVd.year), 10) : NaN;
  const ageYears = !isNaN(listedYear) ? (currentYear - listedYear) : (brAgeYears ?? null);
  const cat = (enrichedVd.category || '').trim();
  const hasDamageText = Boolean((enrichedVd.primaryDamage || '').trim() || (enrichedVd.secondaryDamage || '').trim());

  const proseFlagged = proseFlags?.provenanceConcernFlagged === true;
  const proseNull    = proseFlags?.provenanceConcernFlagged === null; // Call 2 unavailable

  if (ageYears == null || brMileage == null || !cat) {
    // Code arithmetic impossible — surface prose concern if present
    if (proseFlagged) {
      return buildSlot({
        id: 'provenance-contradiction', label: '"Why is it here?" — provenance concern flagged',
        kind: 'confirmation', verdict: 'discrepancy',
        detail: 'Provenance concern flagged in assessment body (insufficient listing data for code arithmetic)',
        confidence: 'inferred', source: 'code+model',
        flag: { severity: 'red', whatsapp: 'Assessment flagged a provenance concern — ask the handler directly why this vehicle is in salvage before bidding', tier: 1 },
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
    if (proseFlagged) signals.push('provenance concern flagged in assessment body');
    const whatsappParts = [];
    if (codePathA)    whatsappParts.push(`unusually clean for salvage — low mileage for its age, ${cat}, minimal damage described`);
    if (qcCatSFlag)   whatsappParts.push('non-insurer vendor entry (Q/C suffix) on a Cat S structural write-off');
    if (proseFlagged) whatsappParts.push('assessment body flagged a provenance concern');
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
  if (excl === 1 && !sh.isSelfReferenceFirstWriteOff && proseCorroboratesSelf) {
    console.error('[SALVAGE SELF-REF OVERRIDE] Prose confirmed self-reference that code missed — effectiveExcl forced from 1 to 0. Review tagSelfReference() criteria for this lot.');
    excl = 0;
    proseOverrideApplied = true;
  }
  if (excl >= 2 && proseCorroboratesSelf) {
    console.error('[SALVAGE SELF-REF MISMATCH] Prose claims self-reference but code found 2+ records excluding self. Code wins upward — override not applied. Investigate.');
  }

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

async function runLampDetection(images) {
  try {
    const imageBlocks = images.slice(0, 20).map(img => {
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    });
    if (!res.ok) { console.warn('[LAMP DETECT] API error:', res.status); return null; }
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

  const checklistEntry = 'Show the struck-side front headlamp aperture with the bumper pulled clear — confirm the actual headlamp type and that a serviceable unit is fitted, not just an exposed recess.';
  const checklistEntry2nd = lampCount === 2
    ? `Inspect the opposite-side front headlamp — on a full-width frontal impact both lamps are implicated; check for displacement, cracking, or moisture ingress and confirm serviceability. Budget ~£${bandValue} if replacement needed — flagged as inspection allowance, not included in repair total.`
    : null;

  if (effectiveVerdict === 'present') {
    // Cost always applies on apertureExposed — a displaced-bumper aperture makes photo evidence
    // unreliable regardless of what appears present. Verdict controls wording only.
    let verdictLine = `Struck front corner headlamp — the front headlamp on the damaged corner appears present; however, on a displaced-bumper impact the aperture is unreliable and serviceability cannot be confirmed from photos. Replacement costed at £${bandValue} (${resolvedType}) as a precautionary allowance.`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, checklistEntry2nd, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
  }

  if (effectiveVerdict === 'missing') {
    let verdictLine = `Struck front corner headlamp — the front headlamp on the damaged corner is missing. Replacement costed at £${bandValue} (${resolvedType}).`;
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
    result.push({ name: name.trim(), action: action.trim(), oem: parsePrice(col3), used: parsePrice(col4) });
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
        `^PART:\\s+(.+?)\\s*\\|\\s*iv:(true|false|na)\\s*\\|\\s*z:(${ZONES})(?:\\s*\\|\\s*ph:(low|mid|high))?\\s*$`,
        'i'
      )
    );
    if (pm) {
      const [, partName, ivRaw, zone, phRaw] = pm;
      costedParts.push({
        partName:             partName.trim(),
        zone,
        independentlyVisible: ivRaw === 'true' ? true : ivRaw === 'false' ? false : null,
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
      const [, partName, zone, weight, reason] = fm;
      flaggedParts.push({ partName: partName.trim(), zone, weight, reason: reason.trim() });
    }
    // Unmatched lines silently skipped. Absent block → both arrays [].
  }

  return { costedParts, flaggedParts };
}

// isLampLine / reconcileParts / sumPartsRealistic / normName / the visibility
// gate live in lib/parts.mjs (CB7 fix, 12 Jun 2026) so the regression harness
// imports the literal shipped functions.

function renderParts(parts) {
  return parts.map((p, i) => {
    const oem  = p.oem  != null ? `£${p.oem}`  : '—';
    const used = p.used != null ? `£${p.used}` : '—';
    return `${i + 1}. ${p.name} | ${p.action} | ${oem} | ${used}`;
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const stripeSessionId = searchParams.get('session_id');
  const salvageId = searchParams.get('salvage_id');
  const promoToken = searchParams.get('promo_token');

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

    function cleanCopartNotes(raw) {
      if (!raw) return '';
      return raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !/thumbnail/i.test(l))
        .filter(l => !/^https?:\/\//i.test(l))
        .filter(l => !/^VIN:/i.test(l))
        .filter(l => !/^Lot number:/i.test(l))
        .filter(l => !/^Lane\/Item:/i.test(l))
        .filter(l => !/^Sale name:/i.test(l))
        .filter(l => !/^Sale date:/i.test(l))
        .filter(l => !/^Location:/i.test(l))
        .filter(l => !/^\d+\/\d+$/.test(l))
        .filter(l => !/^Watchlist$/i.test(l))
        .filter(l => !/^HD$/i.test(l))
        .filter(l => !/VIEW FULL VEHICLE/i.test(l))
        .filter(l => !/^Estimated retail value:\s*$/i.test(l))
        .filter(l => !/^Transmission:\s*$/i.test(l))
        .filter(l => !/^2 AXLE RIGID BODY/i.test(l))
        .filter(l => !/^Drive:/i.test(l))
        .filter(l => !/^Transmission engages/i.test(l))
        .filter(l => !/^1 Speed/i.test(l))
        .filter(l => !/^2 Speed/i.test(l))
        .filter(l => !/^\d+ Speed/i.test(l))
        .filter(l => !/^Gears engage/i.test(l))
        .filter(l => !/^Physical V5/i.test(l))
        .filter(l => !/^Auction countdown/i.test(l))
        .filter(l => !/^Minimum bid/i.test(l))
        .filter(l => !/^Seller reserve/i.test(l))
        .filter(l => !/^Minor Dents/i.test(l))
        .filter(l => !/^Front End$/i.test(l))
        .filter(l => !/^Rear End$/i.test(l))
        .filter(l => !/^No V5/i.test(l))
        .filter(l => !/^N REPAIRABLE/i.test(l))
        .filter(l => !/^S REPAIRABLE/i.test(l))
        .filter(l => !/^Water\/flood/i.test(l))
        .filter(l => !/^VAT to be added/i.test(l))
        .filter(l => !/^Yes$/i.test(l))
        .filter(l => !/^No$/i.test(l))
        .filter(l => /[a-zA-Z]{4,}/.test(l))
        .join('\n')
        .trim();
    }

    const cleanedVd = { ...vd, damageDescription: cleanCopartNotes(vd.damageDescription) };

    function parseCopartListing(raw) {
      if (!raw) return {};
      const get = (pattern) => {
        const m = raw.match(pattern);
        return m ? m[1].trim() : null;
      };
      return {
        category:         get(/^Category:\s*([^\n]+)/im),
        runCondition:     get(/Run condition:\s*\n?([^\n]+)/i),
        odometer:         get(/Odometer:\s*\n?([^\n]+)/i),
        keys:             get(/Has key:\s*\n?([^\n]+)/i),
        fuel:             get(/Fuel:\s*\n?([^\n]+)/i),
        transmission:     get(/Transmission:\s*\n?([^\n]+)/i),
        bodyStyle:        get(/Body style:\s*\n?([^\n]+)/i),
        colour:           get(/Colour:\s*\n?([^\n]+)/i),
        engineSize:       get(/Engine type:\s*\n?([^\n]+)/i),
        primaryDamage:    get(/Primary damage:\s*\n?([^\n]+)/i),
        secondaryDamage:  get(/Secondary damage:\s*\n?([^\n]+)/i),
        additionalDamage: get(/Additional damage[^:]*:\s*\n?([^\n]+)/i),
        estimatedRetail:  get(/Estimated retail value:\s*\n?([^\n]+)/i),
        vatOnSale:        get(/VAT to be added[^:\n]*(?::\s*|\s*\r?\n\s*)(Yes|No)/i),
        v5Status:         get(/V5 available:\s*\n?([^\n]+)/i),
        lotNumber:        get(/Lot number:\s*\n?([^\n]+)/i),
      };
    }

    const parsed = parseCopartListing(vd.damageDescription || '');
    const enrichedVd = {
      ...cleanedVd,
      category:         cleanedVd.category        || parsed.category,
      runCondition:     cleanedVd.runCondition     || parsed.runCondition,
      odometer:         cleanedVd.odometer         || parsed.odometer,
      keys:             cleanedVd.keys             || parsed.keys,
      fuel:             cleanedVd.fuel             || parsed.fuel,
      transmission:     cleanedVd.transmission     || parsed.transmission,
      colour:           cleanedVd.colour           || parsed.colour,
      engineSize:       cleanedVd.engineSize       || parsed.engineSize,
      primaryDamage:    cleanedVd.primaryDamage    || parsed.primaryDamage,
      secondaryDamage:  cleanedVd.secondaryDamage  || parsed.secondaryDamage,
      additionalDamage: cleanedVd.additionalDamage || parsed.additionalDamage,
      estimatedRetail:  cleanedVd.estimatedRetail  || parsed.estimatedRetail,
      vatOnSale:        cleanedVd.vatOnSale        || parsed.vatOnSale,
      v5Status:         cleanedVd.v5Status         || parsed.v5Status,
      lotNumber:        cleanedVd.lotNumber        || parsed.lotNumber || vd.lotNumber,
    };

    if (!enrichedVd.vatOnSale && /VAT\s+to\s+be\s+added/i.test(vd.damageDescription || '')) {
      console.warn('[VAT PARSE] possible missed VAT flag: "VAT to be added" found in listing but vatOnSale parsed as null');
    }

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
      const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
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
      });
      if (haikuRes.ok) {
        const haikuData = await haikuRes.json();
        const raw = (haikuData.content?.[0]?.text || '').trim();
        const nums = (raw.replace(/,/g, '').match(/\d+/g) || [])
          .map(n => parseInt(n, 10))
          .filter(n => n >= 1 && n <= 999999);
        const uniq = [...new Set(nums)];
        const parsed = uniq.length === 1 ? uniq[0] : NaN;
        if (!isNaN(parsed)) photoOdometer = parsed;
      } else {
        // non-2xx from Haiku — photoOdometer stays null, downstream hierarchy takes over
      }
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
        if (diff > 500) {
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
      enrichedVd.category && `Category: ${enrichedVd.category}`,
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
          rec.salvage_auction_lot_desc && `  Category: ${rec.salvage_auction_lot_desc}`,
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
      name: 'recordLampObservation',
      description: 'Call exactly once on any front-struck lot, before writing your assessment. Also call if the rear bumper is visibly torn away or displaced. Pass your plate-anchor side determination, bumper displacement observations, and damage span. After calling, include each implicated front headlamp as a separate Parts Breakdown line. The engine reconciles costs to the authoritative band — do NOT pre-adjust your repair figure. Do not write lamp commentary outside the Parts Breakdown lines.',
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
            description: 'True if the front bumper is visibly displaced or removed on the struck corner, exposing the lamp mounting recess.',
          },
          damageSpan: {
            type: 'string',
            enum: ['single_corner', 'full_width'],
            description: 'Structural extent of damage across the front. single_corner: damage confined to one side (one wing, one bumper corner). full_width: damage spans the full front width — bonnet crumpled, slam panel or front panel affected, both front corners involved. Judge from structural damage footprint (bonnet, slam panel, wing, bumper reach), NOT from lamp absence or presence.',
          },
          rearApertureExposed: {
            type: 'boolean',
            description: 'True if the rear bumper is torn away or displaced from the body on the struck corner, exposing the rear-quarter-to-bumper seam or fold. Set on lots with rear bumper displacement; omit or set false if the rear bumper is intact.',
          },
        },
        required: ['struckSide', 'apertureExposed', 'damageSpan'],
      },
    };

    const frontStruck = /front/i.test(enrichedVd.primaryDamage || '') || /front/i.test(enrichedVd.secondaryDamage || '');

    // Fire lamp detection in parallel with the Claude assess call — joins after
    const lampDetectionPromise = frontStruck ? runLampDetection(images) : Promise.resolve(null);

    // Call 1 tools: LAMP_OBS_TOOL always offered (item 14 — trigger input-integrity).
    // Force guard (iter===0 && frontStruck) unchanged — forced only when text fields confirm front.
    // On non-front lots the model sees the tool but the description instructs "front-struck lots
    // only" — voluntary, will not call it; lampObs stays null correctly.
    const claudeTools = [LAMP_OBS_TOOL];
    const messages = [{ role: 'user', content: userContent }];
    let lampObs = null;
    let lampObsSource = null;
    let coreObs = null;
    let rawText = '';

    const callClaude = (withTools, forced = false) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 16000,
        system: [{ type: 'text', text: ASSESSMENT_ENGINE_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages,
        ...(withTools && claudeTools.length > 0 ? {
          tools: claudeTools,
          ...(forced ? { tool_choice: { type: 'any' } } : {}),
        } : {}),
      }),
    }).then(res => res.json().then(data => ({ res, data })));

    // Tool-use loop — keep calling with tools while the model keeps recording observations,
    // then a final no-tools call forces the prose (mirrors the existing lamp two-call shape,
    // generalised so either/both forced tools can fire in one round or across several).
    // iter=0 on frontStruck lots: forced=true so the model MUST call recordLampObservation
    // (tool_choice:{type:'any'}). iter>=1: forced=false — continuation rounds have tool_result
    // context and must be free to end_turn into prose naturally.
    const MAX_TOOL_ROUNDS = 4;
    for (let iter = 0; iter < MAX_TOOL_ROUNDS; iter++) {
      const { res: apiRes, data: apiData } = await callClaude(true, iter === 0 && frontStruck);
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
          if (block.name === 'recordLampObservation') {
            lampObs = {
              struckSide:          block.input?.struckSide     || 'central',
              apertureExposed:     Boolean(block.input?.apertureExposed),
              damageSpan:          block.input?.damageSpan     || 'single_corner',
              rearApertureExposed: block.input?.rearApertureExposed === true,
            };
            lampObsSource = (iter === 0 && frontStruck) ? 'text-forced' : 'voluntary-iter0';
            console.log(`[LAMP] recordLampObservation: struckSide=${lampObs.struckSide} apertureExposed=${lampObs.apertureExposed} rearApertureExposed=${lampObs.rearApertureExposed} damageSpan=${lampObs.damageSpan}`);
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
    if (!rawText) {
      const { res: finalRes, data: finalData } = await callClaude(false);
      console.log('[TOKEN LOG] iter=final Input:', finalData.usage?.input_tokens, '| Output:', finalData.usage?.output_tokens, '| Stop:', finalData.stop_reason, '| Model:', finalData.model || 'unknown');
      console.log('[CACHE] iter=final write=' + (finalData.usage?.cache_creation_input_tokens ?? 0) + ' read=' + (finalData.usage?.cache_read_input_tokens ?? 0) + ' input=' + (finalData.usage?.input_tokens ?? 0));
      if (!finalRes.ok) throw new Error(finalData.error?.message || 'Claude API error (final)');
      if (finalData.stop_reason === 'max_tokens') throw new Error('[MAX_TOKENS] main assess call truncated (final) — response ceiling hit');
      if (finalData.stop_reason === 'refusal')   throw new Error('[REFUSAL] main assess call refused (final) — content policy');
      rawText = (finalData.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }

    // Call 2 — Haiku structured extraction from committed prose
    // Text-only (no images re-sent), forced tool_choice. Extracts windscreenSticker + bodyStyle
    // from the prose Call 1 just produced. Structurally decoupled: slots derive from prose
    // conclusions, cannot diverge from what the model actually wrote.
    const CORE_EXTRACTION_TOOL = {
      name: 'recordCoreObservations',
      description: 'Extract windscreen sticker suffix letter, body style, two prose-faithfulness verdicts, and per-zone damage event classification from the assessment text below. Transcribe exactly what the assessment states — do not interpret, infer, or add anything beyond what is written.',
      input_schema: {
        type: 'object',
        properties: {
          windscreenSticker: {
            type: 'object',
            properties: {
              visible: { type: 'boolean' },
              suffixLetter: { type: 'string', enum: ['X', 'P', 'C', 'Q', 'OTHER', 'UNREADABLE'] },
            },
            required: ['visible', 'suffixLetter'],
          },
          bodyStyle: {
            type: 'object',
            properties: {
              observed: { type: 'string' },
              doorCountVisible: { type: 'boolean' },
            },
            required: ['observed', 'doorCountVisible'],
          },
          provenanceConcernFlagged: {
            type: 'boolean',
            description: 'Set true ONLY if the assessment explicitly raises a concern about why this vehicle is in salvage, the vendor entry channel (Q- or C-suffix non-insurer risk, Copart re-entry risk), or uses language such as "establish why before bidding" or "provenance concern". Set false if the assessment is silent on provenance risk or gives the vehicle a clean provenance read. Default false when uncertain.',
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
        required: ['windscreenSticker', 'bodyStyle', 'provenanceConcernFlagged', 'salvageSelfReferenceConfirmed', 'perZone'],
      },
    };

    const call2Start = Date.now();
    const call2Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        tools: [CORE_EXTRACTION_TOOL],
        tool_choice: { type: 'tool', name: 'recordCoreObservations' },
        messages: [{
          role: 'user',
          content: `Extract the windscreen sticker, body style, provenance verdicts, and per-zone damage classification from this vehicle assessment. Report only what the text explicitly states — do not interpret, infer, or add anything beyond what is written.\nFor provenanceConcernFlagged: set true ONLY if the text explicitly raises a concern about why the vehicle is in salvage or its vendor entry channel; false otherwise.\nFor salvageSelfReferenceConfirmed: set true ONLY if the text explicitly concludes the single salvage record is this lot's own current first write-off entry; false otherwise.\nFor perZone: one entry per damage zone mentioned in the prose; zone must be one of: front, rear, flank-damaged-side, roof, underside, interior; heightBand must be null for non-impact eventTypes.\n\n${rawText}`,
        }],
      }),
    });
    const call2Data = await call2Response.json();
    const call2Latency = Date.now() - call2Start;
    console.log(`[CALL2] stop_reason=${call2Data.stop_reason} input=${call2Data.usage?.input_tokens} output=${call2Data.usage?.output_tokens} latency=${call2Latency}ms`);
    if (call2Data.stop_reason === 'max_tokens') {
      console.error('[CALL2][TRUNCATED] stop_reason=max_tokens — extraction JSON cut mid-structure; perZone array may be incomplete or absent');
    }

    const call2ToolBlock = (call2Data.content || []).find(b => b.type === 'tool_use' && b.name === 'recordCoreObservations');
    if (call2ToolBlock?.input) {
      console.log('[CALL2] raw tool_use input:', JSON.stringify(call2ToolBlock.input));
      const inp = call2ToolBlock.input;
      coreObs = {
        windscreenSticker: {
          visible:      Boolean(inp.windscreenSticker?.visible),
          suffixLetter: inp.windscreenSticker?.suffixLetter || 'UNREADABLE',
        },
        bodyStyle: {
          observed:         inp.bodyStyle?.observed || '',
          doorCountVisible: Boolean(inp.bodyStyle?.doorCountVisible),
        },
        corners: [],
        proseFlags: {
          provenanceConcernFlagged:     typeof inp.provenanceConcernFlagged === 'boolean'     ? inp.provenanceConcernFlagged     : null,
          salvageSelfReferenceConfirmed: typeof inp.salvageSelfReferenceConfirmed === 'boolean' ? inp.salvageSelfReferenceConfirmed : null,
        },
        perZone: Array.isArray(inp.perZone) ? inp.perZone : [],
      };
      console.log(`[CALL2] extracted sticker=${coreObs.windscreenSticker.suffixLetter}(visible=${coreObs.windscreenSticker.visible}) bodyStyle="${coreObs.bodyStyle.observed}" provenanceConcernFlagged=${coreObs.proseFlags.provenanceConcernFlagged} salvageSelfReferenceConfirmed=${coreObs.proseFlags.salvageSelfReferenceConfirmed} perZone=${coreObs.perZone.length}`);
    } else {
      console.error(`[CALL2] EXTRACTION FAILURE — no tool block returned despite forced tool_choice. stop_reason=${call2Data.stop_reason} latency=${call2Latency}ms`);
      // coreObs floor default fires below
    }

    // Guarantee CORE observations — floor defaults if Call 2 failed to return a tool block.
    if (!coreObs) {
      coreObs = {
        windscreenSticker: { visible: false, suffixLetter: 'UNREADABLE' },
        bodyStyle: { observed: '', doorCountVisible: false },
        corners: [],
        proseFlags: { provenanceConcernFlagged: null, salvageSelfReferenceConfirmed: null },
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

    // Layer 2 backstop (item 14): perZone identifies front/impact but no lampObs from Call 1.
    // Uses the full Call-1 thread (Opus — thread carries 1568px images, Haiku-safe resize not applicable).
    // Expected input: ~22–33K tokens (system prefix cached + messages thread). max_tokens=512 covers
    // one tool_use block; observed backstop output at BL75JAU iter=0: 97 tokens.
    if (needsLampBackstop(coreObs.perZone, lampObs)) {
      console.log('[LAMP] Layer 2 backstop triggered — front/impact in perZone, no observation from Call 1');
      const backstopFetch = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 512,
          system: [{ type: 'text', text: ASSESSMENT_ENGINE_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [
            ...messages,
            { role: 'assistant', content: rawText },
            { role: 'user', content: 'You identified front impact damage in your assessment above. Call recordLampObservation now to record your observation of the struck front corner — bumper displacement (apertureExposed) and damage span — based on the photos and your assessment.' },
          ],
          tools: [LAMP_OBS_TOOL],
          tool_choice: { type: 'any' },
        }),
      });
      const backstopData = await backstopFetch.json();
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

    // Per-part verdicts — parsed from the separate Part Verdicts block; never touches buyer-facing output
    const { costedParts, flaggedParts } = parsePartVerdicts(assessment['Part Verdicts'] || '');

    // Labour-safety: mark gate-inert any costedParts entry that corresponds to a dash-action
    // parseParts row. Primary signal: positional (same index, per prompt instruction).
    // Fallback: normalised name match (catches position drift within normalisation tolerance).
    // independentlyVisible=null → gate ignores entry regardless of Phase 2 visibility gate logic.
    // Accepted residual: entry stays gate-eligible only when BOTH position AND normalised name drift
    // — requires prompt non-compliance on a line that is also mispositioned.
    const dashIndices = rawParts.reduce((acc, rp, i) => {
      if (/^[-–—]+$/.test(rp.action)) acc.add(i);
      return acc;
    }, new Set());
    const labourNamesNorm = new Set(
      rawParts.filter((_, i) => dashIndices.has(i)).map(rp => normName(rp.name))
    );
    costedParts.forEach((cp, i) => {
      if (dashIndices.has(i) || labourNamesNorm.has(normName(cp.partName))) {
        cp.independentlyVisible = null;
        cp._labourSafe = true; // deliberate null — gate must PASS, not strip
      }
    });
    coreObs.costedParts  = costedParts;
    coreObs.flaggedParts = flaggedParts;
    console.log(`[PART VERDICTS] costedParts=${costedParts.length} flaggedParts=${flaggedParts.length}`);
    console.log('[PART VERDICTS] costedParts:', JSON.stringify(costedParts));
    console.log('[PART VERDICTS] flaggedParts:', JSON.stringify(flaggedParts));

    // Shared across all probe calls: same system text so probe-2/3 can read probe-1's
    // image cache (cache key = system + messages prefix up to cache_control block).
    const PROBE_SYSTEM = 'You are an independent vehicle damage reviewer. Your sole task is to answer visibility questions about specific panels from auction photos — describe only what you directly observe. Do not provide repair estimates, cost opinions, or any information beyond what the photos show.';
    // probeImageBlocks: same bytes as the main assess, cache_control on the last block.
    // Probe-1 writes the image cache; probe-2+ read it warm (saving ~90% of image token cost).
    const probeImageBlocks = imageBlocks.length > 0
      ? [...imageBlocks.slice(0, -1), { ...imageBlocks.at(-1), cache_control: { type: 'ephemeral' } }]
      : imageBlocks;

    // ── Two-pass Phase 1: Perception-Fabrication Probe ─────────────────────────
    // Runs AFTER costedParts is populated, BEFORE reconcileParts/gate.
    // Blind: sends photos + numbered part names only — NO verdicts, prose, reasoning,
    // listing description, or side labels. Challenges each iv===true non-lamp entry
    // independently; sets iv=false + _probeStripped=true on challenged panels.
    // Gate at line 1906 handles the rest: strips challenged panels from the floor,
    // surfaces them as inspection notes with distinct probe-stripped wording.
    // Three states: 'ok' (ran), 'refusal' (abstained — lines stand), 'error' (abstained).
    let _perceptionProbeResult = null;
    {
      const PROBE_TOOL = {
        name: 'recordPanelVisibility',
        description: 'Record your independent visibility verdict for every numbered panel. Return one entry per panel — every panel in the list must have an entry.',
        input_schema: {
          type: 'object',
          properties: {
            panels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index:    { type: 'integer', description: 'Panel number as given in the list (1, 2, 3 …)' },
                  visible:  { type: 'boolean', description: 'True if you can independently see damage to this panel in at least one photo. False if you cannot.' },
                  photoRef: { type: 'string',  description: 'Which photo(s) show the evidence (e.g. "photo 3"). Write "none" if not visible.' },
                  whatISee: { type: 'string',  description: 'What you actually observe in the photo that constitutes damage — or why you cannot see it.' },
                },
                required: ['index', 'visible', 'photoRef', 'whatISee'],
              },
            },
          },
          required: ['panels'],
        },
      };

      // Only challenge iv===true entries; skip lamps (gate-mandated) and labour rows (_labourSafe).
      const checkable = costedParts
        .map((cp, arrayIdx) => ({ cp, arrayIdx }))
        .filter(({ cp }) => cp.independentlyVisible === true && !cp._labourSafe && !isLampLine(cp.partName));

      if (checkable.length === 0) {
        _perceptionProbeResult = { status: 'ok', challenged: [], usage: null };
        console.log('[PERCEPTION PROBE] no iv=true non-lamp panels — probe skipped');
      } else {
        const panelListText = checkable.map(({ cp }, i) => `Panel ${i + 1}: ${cp.partName}`).join('\n');
        const probeInstruction = `You are performing a blind independent review of vehicle auction photos.\n\nFor each panel listed below, answer ONLY from what you can directly observe in the photos:\n- Is damage to this panel independently visible in any photo?\n- Cite which photo number shows it (photo 1, photo 2, etc.).\n- Describe exactly what you see, or state plainly that you cannot see it.\n\nJudge solely from the photos. Do not use assumptions about the damage type, vehicle history, or incident.\n\n${panelListText}\n\nCall recordPanelVisibility with your verdict for every panel in the list.`;

        try {
          const probeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-opus-4-8',
              max_tokens: 2048,
              system: [{ type: 'text', text: PROBE_SYSTEM }],
              messages: [{ role: 'user', content: [...probeImageBlocks, { type: 'text', text: probeInstruction }] }],
              tools: [PROBE_TOOL],
              tool_choice: { type: 'tool', name: 'recordPanelVisibility' },
            }),
          });
          const probeData = await probeRes.json();
          console.log(`[PERCEPTION PROBE] stop=${probeData.stop_reason} input=${probeData.usage?.input_tokens} output=${probeData.usage?.output_tokens} cache_read=${probeData.usage?.cache_read_input_tokens ?? 0} model=${probeData.model || 'unknown'}`);

          if (probeData.stop_reason === 'refusal') {
            console.warn('[PERCEPTION PROBE] refusal — probe abstained; pass-1 lines unchanged');
            _perceptionProbeResult = { status: 'refusal', challenged: [], usage: probeData.usage ?? null };
          } else if (!probeRes.ok || probeData.error) {
            console.error('[PERCEPTION PROBE] API error:', probeData.error?.message || probeRes.status);
            _perceptionProbeResult = { status: 'error', error: probeData.error?.message || `HTTP ${probeRes.status}`, challenged: [], usage: null };
          } else {
            const probeBlock = (probeData.content || []).find(b => b.type === 'tool_use' && b.name === 'recordPanelVisibility');
            if (!probeBlock?.input?.panels) {
              console.error('[PERCEPTION PROBE] no tool block returned — probe abstained');
              _perceptionProbeResult = { status: 'error', error: 'no tool block', challenged: [], usage: probeData.usage ?? null };
            } else {
              const challenged = [];
              for (const verdict of probeBlock.input.panels) {
                if (typeof verdict.index !== 'number') continue;
                const entry = checkable[verdict.index - 1]; // probe is 1-indexed
                if (!entry) continue;
                if (verdict.visible === false) {
                  costedParts[entry.arrayIdx].independentlyVisible = false;
                  costedParts[entry.arrayIdx]._probeStripped = true;
                  challenged.push({ index: verdict.index, arrayIdx: entry.arrayIdx, partName: entry.cp.partName, photoRef: verdict.photoRef, whatISee: verdict.whatISee });
                }
              }
              _perceptionProbeResult = { status: 'ok', challenged, usage: probeData.usage ?? null };
              console.log(`[PERCEPTION PROBE] ok — checked=${checkable.length} stripped=${challenged.length}${challenged.length ? ': ' + challenged.map(c => c.partName).join(', ') : ''}`);
            }
          }
        } catch (probeErr) {
          console.error('[PERCEPTION PROBE] threw:', probeErr.message);
          _perceptionProbeResult = { status: 'error', error: probeErr.message, challenged: [], usage: null };
        }
      }
    }
    // ── End perception probe ────────────────────────────────────────────────────

    const { parts: reconciledParts, allowanceParts } = reconcileParts(rawParts, lampResult, coreObs.costedParts);

    // Phase 2 — visibility gate (Test 1); lamp rows are rule-B paired and the
    // mandated lamp row is band-retained, never removed (CB7 fix, lib/parts.mjs)
    const { gatedParts } = applyVisibilityGate(reconciledParts, coreObs.costedParts, coreObs.flaggedParts, lampResult);

    assessment._flaggedParts = [...coreObs.flaggedParts].sort((a, b) =>
      ({'high': 0, 'medium': 1, 'low': 2}[a.weight] ?? 1) -
      ({'high': 0, 'medium': 1, 'low': 2}[b.weight] ?? 1)
    );

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
    if (_perceptionProbeResult) {
      assessment._perceptionProbe = {
        status:     _perceptionProbeResult.status,
        challenged: _perceptionProbeResult.challenged,
        usage:      _perceptionProbeResult.usage,
        capturedAt: new Date().toISOString(),
      };
    }
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
    const proseFlags = coreObs.proseFlags ?? { provenanceConcernFlagged: null, salvageSelfReferenceConfirmed: null };
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
