// Panel identity + behaviour-class module — Step 1 of enum-native damage architecture.
// Consumed by NOTHING yet. Per-view, amalgamate, the gate, and the main call are all
// untouched; this file can be reviewed as a flat artifact and the engine runs unchanged.
//
// SIDE-BLIND by design: ONE entry per panel type; NO near/off-side field anywhere.
// "Which corner" is carried only in struck/opposite prose, never in an identity key.
// This structural absence is the reason the offside/nearside problem cannot recur.
//
// Design ref: MotorQuoter_Enum_Architecture_Design_19Jun2026.md §2, §2.1–2.6.

// ── Behaviour-class constants ─────────────────────────────────────────────────────────────
export const PANEL_CLASS = Object.freeze({
  COST:            'COST',            // carries a price when damaged; gate decides in/out
  STRUCTURAL_FLAG: 'STRUCTURAL_FLAG', // NEVER costed; always flag + inspect prose
  VISIBLE_FLAG:    'VISIBLE_FLAG',    // fires on visible geometric evidence only
  PRESENCE_CHECK:  'PRESENCE_CHECK',  // three states: present / absent (flag) / not-shown
  OTHER:           'OTHER',           // escape hatch — free-text name, always flag, never keyed-cost
  EV_CONDITIONAL:  'EV_CONDITIONAL',  // active only when isElectricFuelType() returns true
});

// ── Closed panel enum — the canonical vocabulary ──────────────────────────────────────────
// Every key is a stable ID. Labels/display strings live in consumers; they can change freely.
export const PANEL = Object.freeze({

  // ── COST entries (24) ─────────────────────────────────────────────────────────────────
  // Carry a price when damaged. The gate decides which are in the repair total.

  FRONT_BUMPER:  'FRONT_BUMPER',
  GRILLE:        'GRILLE',
  BONNET:        'BONNET',
  SLAM_PANEL:    'SLAM_PANEL',     // rad support / front upper tie bar
  FRONT_WING:    'FRONT_WING',
  HEADLAMP:      'HEADLAMP',       // HEADLAMP not FRONT_HEADLAMP — no rear headlamps exist
  FOG_LAMP:      'FOG_LAMP',
  RADIATOR_PACK: 'RADIATOR_PACK',  // rad / condenser / cooling — costed as a unit on frontal hits
  FRONT_DOOR:    'FRONT_DOOR',
  REAR_DOOR:     'REAR_DOOR',
  SILL:          'SILL',           // structural sill; distinct from SIDE_SKIRT (trim scrape)
  SIDE_SKIRT:    'SIDE_SKIRT',     // trim scrape; distinct from SILL (structural)
  DOOR_MIRROR:   'DOOR_MIRROR',
  SIDE_GLASS:    'SIDE_GLASS',
  REAR_BUMPER:   'REAR_BUMPER',
  REAR_QUARTER:  'REAR_QUARTER',
  REAR_LAMP:     'REAR_LAMP',      // qualifier kept: front/rear is a real distinction for lamps
  BOOT_LID:      'BOOT_LID',
  REAR_PANEL:    'REAR_PANEL',
  WINDSCREEN:    'WINDSCREEN',
  REAR_GLASS:    'REAR_GLASS',
  ROOF:          'ROOF',
  WHEEL:         'WHEEL',          // side-blind AND position-blind — all four corners identical cost
  TYRE:          'TYRE',           // side-blind AND position-blind — all four corners identical cost

  // ── STRUCTURAL-FLAG entries (3) ──────────────────────────────────────────────────────
  // NEVER costed under any circumstance. One flag per zone; the flag PROSE names the
  // specific members (chassis legs, inner wings, A/B/C-pillars, subframe, etc.).
  // Collapsed from individual members: members in a zone share a fate.

  FRONT_STRUCTURE: 'FRONT_STRUCTURE', // chassis legs, inner wing, subframe, front upper structure
  REAR_STRUCTURE:  'REAR_STRUCTURE',  // rear chassis legs, boot floor structure
  SIDE_STRUCTURE:  'SIDE_STRUCTURE',  // A/B/C-pillars, inner sill reinforcement

  // ── VISIBLE-FLAG entry (1) ────────────────────────────────────────────────────────────
  // Fires on visible geometric evidence only — never on surface deformation.
  // FLAG (suspension / geometry — inspect), not a cost entry.

  DISPLACED_WHEEL: 'DISPLACED_WHEEL', // wheel visibly out of position (wrong angle, pushed from arch)

  // ── PRESENCE-CHECK entries (2) ────────────────────────────────────────────────────────
  // Three states: visibly present (confirm) / visibly absent (flag + replacement budget) /
  // not shown (the common case — honest "not shown, confirm on inspection").
  // "Absent" and "not photographed" are indistinguishable on most sets; the not-shown state
  // exists so the closed vocabulary cannot manufacture a missing-part claim from empty photos.

  SPARE_WHEEL:   'SPARE_WHEEL',
  PARCEL_SHELF:  'PARCEL_SHELF',

  // ── ESCAPE (1) ───────────────────────────────────────────────────────────────────────
  // Free-text name; always surfaced as a flag; never keyed-cost.
  // Non-negotiable for safety: a closed enum without an escape silently eats real damage
  // it didn't anticipate (interior trim, upholstery, dash panels, inner panels, screens).

  OTHER: 'OTHER',

  // ── EV-CONDITIONAL entries (2) ────────────────────────────────────────────────────────
  // Active ONLY when isElectricFuelType(fuelType) returns true.
  // An ICE vehicle NEVER sees these entries; an EV always has both considered.

  EV_BATTERY_ZONE:     'EV_BATTERY_ZONE',     // structural-flag behaviour when active
  EV_BATTERY_PRESENCE: 'EV_BATTERY_PRESENCE', // presence-check behaviour when active
});

// ── Behaviour-class lookup ────────────────────────────────────────────────────────────────
// Given a PANEL key, returns its PANEL_CLASS. EV_CONDITIONAL entries are tagged as such
// regardless of whether the EV gate is active — callers that need the resolved class use
// EV_PANEL_RESOLVED_CLASS.
export const PANEL_BEHAVIOUR = Object.freeze({
  [PANEL.FRONT_BUMPER]:  PANEL_CLASS.COST,
  [PANEL.GRILLE]:        PANEL_CLASS.COST,
  [PANEL.BONNET]:        PANEL_CLASS.COST,
  [PANEL.SLAM_PANEL]:    PANEL_CLASS.COST,
  [PANEL.FRONT_WING]:    PANEL_CLASS.COST,
  [PANEL.HEADLAMP]:      PANEL_CLASS.COST,
  [PANEL.FOG_LAMP]:      PANEL_CLASS.COST,
  [PANEL.RADIATOR_PACK]: PANEL_CLASS.COST,
  [PANEL.FRONT_DOOR]:    PANEL_CLASS.COST,
  [PANEL.REAR_DOOR]:     PANEL_CLASS.COST,
  [PANEL.SILL]:          PANEL_CLASS.COST,
  [PANEL.SIDE_SKIRT]:    PANEL_CLASS.COST,
  [PANEL.DOOR_MIRROR]:   PANEL_CLASS.COST,
  [PANEL.SIDE_GLASS]:    PANEL_CLASS.COST,
  [PANEL.REAR_BUMPER]:   PANEL_CLASS.COST,
  [PANEL.REAR_QUARTER]:  PANEL_CLASS.COST,
  [PANEL.REAR_LAMP]:     PANEL_CLASS.COST,
  [PANEL.BOOT_LID]:      PANEL_CLASS.COST,
  [PANEL.REAR_PANEL]:    PANEL_CLASS.COST,
  [PANEL.WINDSCREEN]:    PANEL_CLASS.COST,
  [PANEL.REAR_GLASS]:    PANEL_CLASS.COST,
  [PANEL.ROOF]:          PANEL_CLASS.COST,
  [PANEL.WHEEL]:         PANEL_CLASS.COST,
  [PANEL.TYRE]:          PANEL_CLASS.COST,

  [PANEL.FRONT_STRUCTURE]: PANEL_CLASS.STRUCTURAL_FLAG,
  [PANEL.REAR_STRUCTURE]:  PANEL_CLASS.STRUCTURAL_FLAG,
  [PANEL.SIDE_STRUCTURE]:  PANEL_CLASS.STRUCTURAL_FLAG,

  [PANEL.DISPLACED_WHEEL]: PANEL_CLASS.VISIBLE_FLAG,

  [PANEL.SPARE_WHEEL]:  PANEL_CLASS.PRESENCE_CHECK,
  [PANEL.PARCEL_SHELF]: PANEL_CLASS.PRESENCE_CHECK,

  [PANEL.OTHER]: PANEL_CLASS.OTHER,

  [PANEL.EV_BATTERY_ZONE]:     PANEL_CLASS.EV_CONDITIONAL,
  [PANEL.EV_BATTERY_PRESENCE]: PANEL_CLASS.EV_CONDITIONAL,
});

// Resolved behaviour classes for EV-conditional entries when the gate is active.
// EV_BATTERY_ZONE behaves as STRUCTURAL_FLAG; EV_BATTERY_PRESENCE behaves as PRESENCE_CHECK.
export const EV_PANEL_RESOLVED_CLASS = Object.freeze({
  [PANEL.EV_BATTERY_ZONE]:     PANEL_CLASS.STRUCTURAL_FLAG,
  [PANEL.EV_BATTERY_PRESENCE]: PANEL_CLASS.PRESENCE_CHECK,
});

// ── EV gate ──────────────────────────────────────────────────────────────────────────────
// Returns true when the two EV-conditional entries (EV_BATTERY_ZONE, EV_BATTERY_PRESENCE)
// are active. Input: enrichedVd.fuelType — the DVLA Vehicle Enquiry API string, stored in
// vehicle_details at session-creation time; GB/DVLA path only (IE/ROI is out of scope).
//
// Three-way DVLA string mapping (confirmed 19 Jun 2026):
//   "ELECTRIC"                               → true  (BEV — active)
//   "PLUG-IN HYBRID ELECTRIC VEHICLE (PHEV)" → true  (PHEV — real HV pack — active)
//   "HYBRID ELECTRIC"                        → false (self-charging, no large HV pack — INACTIVE)
//
// /electric/i alone is WRONG — it matches "HYBRID ELECTRIC" and would incorrectly activate
// EV_BATTERY_ZONE / EV_BATTERY_PRESENCE for self-charging hybrids.
export function isElectricFuelType(fuelType) {
  if (!fuelType) return false;
  if (/plug-?in/i.test(fuelType)) return true;         // PHEV → active
  if (/^\s*electric\s*$/i.test(fuelType)) return true; // BEV  → active
  return false;                                         // "HYBRID ELECTRIC" and all else → inactive
}

// ── Convenience sets (derived — not authoritative; the above maps are the source of truth) ─
export const BASE_PANEL_IDS  = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] !== PANEL_CLASS.EV_CONDITIONAL);
export const EV_PANEL_IDS    = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] === PANEL_CLASS.EV_CONDITIONAL);
export const COST_PANEL_IDS  = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] === PANEL_CLASS.COST);
