// Structure-floor eligibility — THE single owner, shared by the engine and the buyer's edit layer.
//
// batch 147 X2 (Vincent, 16 Sep): "if there are no other detections of damage other than bumper
// ripped off then no structure charge." A detached bumper on its own is not evidence the structure
// behind it is bent — bumpers snag off on light impacts. The batch 106 £500 floor fires for a zone
// ONLY when that zone carries damage BEYOND its own bumper.
//
// batch 149 Y3: this lived in app/api/salvage/assess/route.js, which lib/ledgerEdits.mjs cannot
// import. The rule has to run TWICE — once when the engine builds the ledger, and again after the
// buyer strikes a row, because striking the last non-bumper panel at an end makes that zone
// bumper-only and the floor must drop with it. Two copies of a money rule is how they drift, so it
// moved here and BOTH import it. One owner, no copy.
//
// WHAT COUNTS as other damage: a panel of that zone that is COSTED — money in the repair total, or
// _repairNoPart (batch 116: a repaired panel is costed damage whose cost sits in panel work).
// WHAT DOES NOT COUNT: a flag-only or disagreeing panel. A flag is by definition unconfirmed, and
// charging £500 of structural work off a panel nobody has confirmed is damaged is exactly the
// over-charging this ruling removes. Nor does a buyer-ADDED line (batch 149 Y3) — the buyer's own
// figure is not an engine detection of damage.
//
// Zone membership is CODE-OWNED and explicit, never read from the per-view zone tag — that is the
// same unreliable field batch 147 X1 had to work around (a front wing arrives tagged by FLANK on
// some lots and by END on others).

export const STRUCT_FLOOR_ZONE = Object.freeze({
  FRONT_STRUCTURE: { bumper: 'FRONT_BUMPER', members: ['GRILLE', 'BONNET', 'SLAM_PANEL', 'FRONT_WING', 'HEADLAMP', 'FOG_LAMP', 'RADIATOR_PACK', 'WINDSCREEN'] },
  REAR_STRUCTURE:  { bumper: 'REAR_BUMPER',  members: ['REAR_PANEL', 'BOOT_LID', 'REAR_QUARTER', 'REAR_LAMP', 'REAR_GLASS'] },
});

// True when a row is a structure floor (the £500 jig/geometry line). Marker-keyed, never name-keyed.
export function isStructureFloorRow(row) {
  return !!(row && row._structFloor);
}

/**
 * Does the £500 structure floor apply to this zone?
 * @param panelId        'FRONT_STRUCTURE' | 'REAR_STRUCTURE' | anything else
 * @param damagedPanels  Set (or array) of panelIds that are COSTED damage
 * @returns { apply, otherDamage, bumperCosted }
 * A panel with no zone entry (not a structure panel) always applies — this rule governs the two
 * structure floors only and must never suppress anything else.
 */
export function structureFloorApplies(panelId, damagedPanels) {
  const zone = STRUCT_FLOOR_ZONE[panelId];
  if (!zone) return { apply: true, otherDamage: [], bumperCosted: false };
  const has = (p) => (damagedPanels instanceof Set ? damagedPanels.has(p) : Array.isArray(damagedPanels) && damagedPanels.includes(p));
  const otherDamage = zone.members.filter(has);
  return { apply: otherDamage.length > 0, otherDamage, bumperCosted: has(zone.bumper) };
}

// Buyer-facing reason shown on a floor the edit layer has dropped. Plain words: it says what changed
// and why, and never implies the structure is sound — the inspection flag for it still stands.
export function structureFloorStruckReason() {
  return 'no longer charged — the only remaining damage at this end is the bumper. The structure is still listed in the inspection flags; ask for it on the WhatsApp inspection.';
}
