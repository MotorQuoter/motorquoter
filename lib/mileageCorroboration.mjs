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
// caller counts the independent sources actually present for the lot (listing / dash-photo / DVSA MOT —
// Brego is not one, it consumes the figure) and passes the count on enrichedVd._mileageSourceCount.

import { buildSlot } from './coreSlots.js';

export const MILEAGE_SOURCE_LABELS = {
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
