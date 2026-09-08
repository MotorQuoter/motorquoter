// Mileage-corroboration CORE slot — extracted from the assess route (batch 106 §2 / EO-01) so the
// verdict logic is a pure, importable function the mileage validator can assert against.
//
// The defect this fixes: the old third branch returned verdict:'confirmed' / confidence:'corroborated'
// whenever no discrepancy FLAG had fired — but a single source has nothing to disagree with, so that
// scored silence as agreement (the same fault the £0 rule kills, wearing different clothes). A lot with
// a listing figure and NO MOT ladder was told its mileage was "corroborated against other sources" when
// there were no other sources at all — directly contradicting the Red Flags line on the same report.
//
// The rule now: "confirmed" REQUIRES at least one INDEPENDENT source to have positively agreed. The
// caller counts the independent sources actually present for the lot and passes the count on
// enrichedVd._mileageSourceCount.
//
// batch 106 §4 (Vincent's ruling, 8 Sep) — what counts as independent. The listing mileage IS the
// dashboard reading, transcribed by the member of auction staff who photographed the cluster. So the
// listing field and the dash-photo read are ONE source, not two, and the caller now counts them as
// one: dashboard (listing OR photo) + DVSA MOT record. Brego is not a source either — it consumes
// brMileage as input, it does not originate a figure. The >=2 rule below is unchanged; only the
// arithmetic feeding it was wrong.
//
//   A dash/listing DISAGREEMENT is real information — it catches a transcription error, a swapped
//   cluster, a wrong lot. AGREEMENT between a figure and its own origin is not corroboration.
//
// That asymmetry is deliberate: the discrepancy branch below is untouched and keeps its job, while
// agreement between the two readings of one dashboard no longer buys a "corroborated".

import { buildSlot } from './coreSlots.js';

export const MILEAGE_SOURCE_LABELS = {
  copart_listed: 'the Copart listing field',
  listing_odometer: 'the listing description',
  photo_odometer: 'the dashboard photo',
  dvsa_mot: 'the last DVSA MOT record',
  default_fallback: 'a default estimate',
};

// batch 106 §4 — the counting rule, extracted so the ruling itself is testable (the §2 fix corrected
// the branch and left this arithmetic inline in the route, where no validator could reach it, which is
// how the defect survived its own fix). The dashboard is ONE source however many of its two readings
// landed; DVSA is the second. Never returns 0 when only the photo read survived — a 0 would mis-route
// the slot into the age-estimate branch, which claims no mileage was available at all.
export function countIndependentMileageSources({
  listingMileagePresent = false,
  photoOdometerPresent = false,
  dvsaMileagePresent = false,
} = {}) {
  const dashboardPresent = Boolean(listingMileagePresent) || Boolean(photoOdometerPresent);
  return (dashboardPresent ? 1 : 0) + (dvsaMileagePresent ? 1 : 0);
}

// Reuses the code's EXISTING mileage-hygiene signals (motMileageFlag / photoMileageFlag /
// age-estimate source) rather than re-deriving comparison logic — those flags already ARE the
// corroboration check; this slot just forces them into a verdict instead of leaving them as
// prose the model might restate inconsistently.
export function buildMileageCorroborationSlot(enrichedVd, brMileage, brMileageSource) {
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
  const sourceCount = enrichedVd._mileageSourceCount ?? 0;

  // batch 106 §2 (EO-01): "confirmed" REQUIRES at least one independent source to have agreed — not
  // merely the absence of a discrepancy flag. With a single source there was nothing to disagree, so
  // "corroborated" would be silence scored as agreement. Two or more present, none flagged → genuine
  // agreement (the discrepancy branch above would have fired otherwise) → the wording is true.
  if (sourceCount >= 2) {
    return buildSlot({
      id: 'mileage-corroboration', label: 'Mileage corroborated against other sources',
      kind: 'confirmation', verdict: 'confirmed',
      detail: `${fmtMiles(brMileage)} from ${sourceLabel} — cross-checked against ${sourceCount - 1} other source${sourceCount - 1 === 1 ? '' : 's'} with no discrepancy`,
      confidence: 'corroborated', source: 'code',
    });
  }

  // Single source only — the figure is REPORTED, not corroborated. Say which source it rests on and
  // that nothing independent confirms it, so the checklist agrees with the Red Flags line instead of
  // contradicting it, and carry the same tier-1 odometer-photo ask the age-estimate branch uses.
  return buildSlot({
    id: 'mileage-corroboration', label: 'Mileage corroborated against other sources',
    kind: 'confirmation', verdict: 'unconfirmed',
    detail: `${fmtMiles(brMileage)} from ${sourceLabel} — this is the only mileage source available for this lot; nothing independent corroborates it`,
    confidence: 'inferred', source: 'code',
    flag: { severity: 'caution', whatsapp: 'Only one mileage source is available for this lot — photograph the odometer clearly and confirm it against the V5/MOT paperwork before bidding', tier: 1 },
  });
}
