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

  // ── COST entries (38) ────────────────────────────────────────────────────────────────
  // Carry a price when damaged. The gate decides which are in the repair total.

  // Car/universal panels (24)
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

  // Van/passenger body panels (8)
  SLIDING_DOOR_SOLID:   'SLIDING_DOOR_SOLID',   // panel-van solid sliding door; track/runner folded in
  SLIDING_DOOR_GLAZED:  'SLIDING_DOOR_GLAZED',  // passenger-van glazed sliding door
  BARN_DOOR_L:          'BARN_DOOR_L',           // left rear barn door (solid; glazed variant deferred)
  BARN_DOOR_R:          'BARN_DOOR_R',           // right rear barn door
  LOAD_BULKHEAD:        'LOAD_BULKHEAD',         // cab/load divider panel
  CREW_WINDOW:          'CREW_WINDOW',            // glazed 2nd-row body-side window (crew vans)
  BODY_SIDE_GLAZING:    'BODY_SIDE_GLAZING',     // bonded body-side glazing (people-carrier/minibus)
  TAILGATE_GLAZED:      'TAILGATE_GLAZED',       // single top-hinged glazed rear closure

  // Pickup-only panels (6)
  BED_SIDE_L:      'BED_SIDE_L',      // load-bed left side
  BED_SIDE_R:      'BED_SIDE_R',      // load-bed right side
  BED_FLOOR:       'BED_FLOOR',       // load-bed floor
  DROP_TAILGATE:   'DROP_TAILGATE',   // pickup bed rear closure (distinct from barn door / car tailgate)
  CAB_REAR_PANEL:  'CAB_REAR_PANEL',  // pickup cab rear wall (body-on-frame)
  CAB_REAR_GLASS:  'CAB_REAR_GLASS',  // pickup double-cab rear cab window — bonded fixed glazing behind seats

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

  [PANEL.SLIDING_DOOR_SOLID]:  PANEL_CLASS.COST,
  [PANEL.SLIDING_DOOR_GLAZED]: PANEL_CLASS.COST,
  [PANEL.BARN_DOOR_L]:         PANEL_CLASS.COST,
  [PANEL.BARN_DOOR_R]:         PANEL_CLASS.COST,
  [PANEL.LOAD_BULKHEAD]:       PANEL_CLASS.COST,
  [PANEL.CREW_WINDOW]:         PANEL_CLASS.COST,
  [PANEL.BODY_SIDE_GLAZING]:   PANEL_CLASS.COST,
  [PANEL.TAILGATE_GLAZED]:     PANEL_CLASS.COST,

  [PANEL.BED_SIDE_L]:     PANEL_CLASS.COST,
  [PANEL.BED_SIDE_R]:     PANEL_CLASS.COST,
  [PANEL.BED_FLOOR]:      PANEL_CLASS.COST,
  [PANEL.DROP_TAILGATE]:  PANEL_CLASS.COST,
  [PANEL.CAB_REAR_PANEL]: PANEL_CLASS.COST,
  [PANEL.CAB_REAR_GLASS]: PANEL_CLASS.COST,

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

// ── BEV gate ─────────────────────────────────────────────────────────────────────────────
// Determines whether a lot is full BATTERY-ELECTRIC (BEV). This is the code-derived "isBev"
// fact the downstream EV-integrity rules (presence check, dash branch, cooling/HV verdict)
// read. BEV = full battery-electric ONLY — self-charging HYBRID ELECTRIC stays on the ICE path.
//
// SOURCE OF TRUTH — live feed enumeration, 226 lots (19 Jun 2026), NOT assumed strings:
//   DVLA  vehicle_details.fuelType ∈ { "PETROL" 91, "ELECTRICITY" 58, "DIESEL" 58,
//                                      "HYBRID ELECTRIC" 14, absent 5 }   ← authoritative
//   listing vehicle_details.fuel   ∈ { "Petrol", "Electric", "Diesel", absent }  ← soft/scraped
//   The ONLY BEV string the feed produces is "ELECTRICITY" (DVLA) / "Electric" (listing).
//   No PHEV / plug-in / hydrogen string occurs. A loose /electric/ substring is WRONG — it
//   would also catch "HYBRID ELECTRIC"; the BEV match is the explicit token "ELECTRICITY".
//
// DVLA descriptors the feed is known to return — when fuelType is one of these, DVLA is
// definite and decides outright; the scraped listing field is ignored.
const DVLA_DEFINITE = /^\s*(PETROL|DIESEL|ELECTRICITY|HYBRID\s+ELECTRIC)\s*$/i;
const DVLA_BEV      = /^\s*ELECTRICITY\s*$/i;   // the live DVLA BEV string
const LISTING_BEV   = /^\s*electric\s*$/i;      // the live listing BEV string (fallback only)

// Production BEV gate. DVLA PRECEDENCE, not pure OR:
//   - DVLA fuelType present AND definite → DVLA decides; listing ignored.
//       "ELECTRICITY" → true; PETROL/DIESEL/HYBRID ELECTRIC → false.
//   - DVLA fuelType absent / empty / unrecognised → fall back to listing fuel ("Electric" → true).
// Accepts the lot/vehicle_details object (carries both fuelType and fuel).
export function isBevLot(vd, hvLabelSeen = false) {
  const fuelType = vd?.fuelType;
  const fuel     = vd?.fuel;
  if (fuelType && DVLA_DEFINITE.test(fuelType)) {
    return DVLA_BEV.test(fuelType);            // link 1: DVLA definite → decides; listing/HV ignored
  }
  if (LISTING_BEV.test(fuel || '')) return true;           // link 2: DVLA absent → listing fallback
  return hvLabelSeen === true;                              // link 3: listing inconclusive → HV sticker fallback
}

// Legacy single-arg form — retained for back-compat; delegates to the two-field gate so the
// single DVLA string still resolves under the same BEV rule ("ELECTRICITY" → true). Now
// matches the live BEV descriptor, not the fabricated "ELECTRIC".
export function isElectricFuelType(fuelType) {
  return isBevLot({ fuelType });
}

// ── Convenience sets (derived — not authoritative; the above maps are the source of truth) ─
export const BASE_PANEL_IDS  = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] !== PANEL_CLASS.EV_CONDITIONAL);
export const EV_PANEL_IDS    = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] === PANEL_CLASS.EV_CONDITIONAL);
export const COST_PANEL_IDS  = Object.values(PANEL).filter(id => PANEL_BEHAVIOUR[id] === PANEL_CLASS.COST);

// ── Display-string lookup ─────────────────────────────────────────────────────────────────
// Maps every enum ID to its buyer-facing label. Used by amalgamate (Step 2+) to set the
// partName field on costedParts entries so the gate join (normKey/normName on partName)
// matches the main call's free-text part names. SOLE source of display strings — never
// hand-spell a panel label anywhere else; change it here and it propagates everywhere.
export const PANEL_DISPLAY = Object.freeze({
  [PANEL.FRONT_BUMPER]:  'Front bumper',
  [PANEL.GRILLE]:        'Grille',
  [PANEL.BONNET]:        'Bonnet',
  [PANEL.SLAM_PANEL]:    'Slam panel',
  [PANEL.FRONT_WING]:    'Front wing',
  [PANEL.HEADLAMP]:      'Headlamp',
  [PANEL.FOG_LAMP]:      'Fog lamp',
  [PANEL.RADIATOR_PACK]: 'Radiator pack',
  [PANEL.FRONT_DOOR]:    'Front door',
  [PANEL.REAR_DOOR]:     'Rear door',
  [PANEL.SILL]:          'Sill',
  [PANEL.SIDE_SKIRT]:    'Side skirt',
  [PANEL.DOOR_MIRROR]:   'Door mirror',
  [PANEL.SIDE_GLASS]:    'Side glass',
  [PANEL.REAR_BUMPER]:   'Rear bumper',
  [PANEL.REAR_QUARTER]:  'Rear quarter panel',
  [PANEL.REAR_LAMP]:     'Rear lamp',
  [PANEL.BOOT_LID]:      'Boot lid',
  [PANEL.REAR_PANEL]:    'Rear panel',
  [PANEL.WINDSCREEN]:    'Windscreen',
  [PANEL.REAR_GLASS]:    'Rear glass',
  [PANEL.ROOF]:          'Roof',
  [PANEL.WHEEL]:         'Wheel',
  [PANEL.TYRE]:          'Tyre',
  [PANEL.SLIDING_DOOR_SOLID]:  'Sliding door (solid)',
  [PANEL.SLIDING_DOOR_GLAZED]: 'Sliding door (glazed)',
  [PANEL.BARN_DOOR_L]:         'Barn door (left)',
  [PANEL.BARN_DOOR_R]:         'Barn door (right)',
  [PANEL.LOAD_BULKHEAD]:       'Load bulkhead',
  [PANEL.CREW_WINDOW]:         'Crew window',
  [PANEL.BODY_SIDE_GLAZING]:   'Body-side glazing',
  [PANEL.TAILGATE_GLAZED]:     'Tailgate (glazed)',
  [PANEL.BED_SIDE_L]:     'Bed side (left)',
  [PANEL.BED_SIDE_R]:     'Bed side (right)',
  [PANEL.BED_FLOOR]:      'Bed floor',
  [PANEL.DROP_TAILGATE]:  'Drop tailgate',
  [PANEL.CAB_REAR_PANEL]: 'Cab rear panel',
  [PANEL.CAB_REAR_GLASS]: 'Cab rear glass',
  [PANEL.FRONT_STRUCTURE]: 'Front structure',
  [PANEL.REAR_STRUCTURE]:  'Rear structure',
  [PANEL.SIDE_STRUCTURE]:  'Side structure',
  [PANEL.DISPLACED_WHEEL]: 'Displaced wheel',
  [PANEL.SPARE_WHEEL]:   'Spare wheel',
  [PANEL.PARCEL_SHELF]:  'Parcel shelf',
  [PANEL.OTHER]:         'Other',
  [PANEL.EV_BATTERY_ZONE]:     'EV battery zone',
  [PANEL.EV_BATTERY_PRESENCE]: 'EV battery presence',
});
