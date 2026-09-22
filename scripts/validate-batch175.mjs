// validate-batch175.mjs — batch 175: the binder keeps true damage and puts the panel on the inspection list. £0, pure.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch175.mjs
// Vincent, 22 Sep: every sentence the part-status class deleted in batches 172/174 was TRUE against his labels. So a
// sentence that says an uncosted panel is damaged is KEPT; the panel is recorded (_proseDamageUncosted) and gets ONE
// inspection line unless a flag or checklist line already covers it. No money moves.
// The cases are batch 172's 22 P3 drops plus batch 174's extras, each as the verbatim source line, the lot's UNCOSTED
// panels (demoted, and not charged in the replayed ledger by isChargedRow) and the expected record.
import { readFileSync } from 'fs';
import { bindClaimClasses, findProseDamageUncosted, addProseDamageInspection, PROSE_DAMAGE_UNCOSTED_REASON } from '@/lib/parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const page  = readFileSync(new URL('../app/salvage/success/page.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// A neutral second line, so a one-line field is never kept whole by the batch 136 C2 never-blank rule.
const PAD = '\nThe listing photographs are clear.';
const ctxOf = () => ({ lampType: null, allowedFigures: [], partActions: [], evVerdict: null });
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const CASES = [
  {
    "id": "#1",
    "lot": "DL72FVX",
    "surface": "Key Cost Drivers",
    "mode": "redflags",
    "line": "- Wheel arch moulding: trim cracked/marked at the arch — replace and blend.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [],
    "note": "wheel arch moulding is CHARGED; \"Wheel\" inside it is not the road wheel (G1)"
  },
  {
    "id": "#2",
    "lot": "DL72FVX",
    "surface": "Alternative Damage Scenario",
    "mode": "speculation",
    "line": "The visible damage is minor and cosmetic (lower front bumper, rear corner cladding, arch trim). For a structural write-off category this is inconsistent with the light external damage — the underlying reason may be underfloor/HV battery related rather than the visible panels, which is not photographable. Establish the actual reason for salvage before bidding.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [
      "FRONT_BUMPER"
    ]
  },
  {
    "id": "#3",
    "lot": "DL72FVX",
    "surface": "Visible Damage Summary",
    "mode": "redflags",
    "line": "This is a current-generation 2023 Hyundai IONIQ 5 Premium 77kWh BEV at ~31k miles — a desirable low-mileage current-model electric hatchback — presenting light lower-front cosmetic damage (a displaced/split lower front bumper section with the plate-support bracket fitted) plus scuffing to lower cladding at the rear corner, with both flanks otherwise straight; the headlamp on the struck front corner appears intact and undisturbed. The biggest unseeable risk is high-voltage battery/underfloor integrity after any frontal contact — not confirmable from photographs on a BEV — though the impact here reads as low-speed and cosmetic.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [
      "FRONT_BUMPER"
    ]
  },
  {
    "id": "#4",
    "lot": "DL72FVX",
    "surface": "Visible Damage Summary",
    "mode": "redflags",
    "line": "This is a current-generation 2023 Hyundai IONIQ 5 Premium 77kWh BEV at ~31k miles — a desirable low-mileage current-model electric hatchback — presenting light lower-front cosmetic damage (a displaced/split lower front bumper section with the plate-support bracket fitted) plus scuffing to lower cladding at the rear corner, with both flanks otherwise straight; the headlamp on the struck front corner appears intact and undisturbed. The biggest unseeable risk is high-voltage battery/underfloor integrity after any frontal contact — not confirmable from photographs on a BEV — though the impact here reads as low-speed and cosmetic.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [
      "FRONT_BUMPER"
    ],
    "note": "same sentence as #3 — the record is the front bumper; the headlamp clause records nothing"
  },
  {
    "id": "#5",
    "lot": "DMZ4614",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Struck-corner front wheel arch liner is displaced and the tyre shows scuffing; suspension geometry at that corner is unconfirmed — a running vehicle can still carry hidden steering/suspension damage from a side hit at wheel height.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [
      "TYRE"
    ],
    "note": "same line as #6: \"the tyre shows scuffing\" sits in the clause with \"displaced\" — the tyre is labelled damaged; the Wheel is not recorded (G1)"
  },
  {
    "id": "#6",
    "lot": "DMZ4614",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Struck-corner front wheel arch liner is displaced and the tyre shows scuffing; suspension geometry at that corner is unconfirmed — a running vehicle can still carry hidden steering/suspension damage from a side hit at wheel height.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [
      "TYRE"
    ],
    "note": "same line as #5"
  },
  {
    "id": "#7",
    "lot": "DMZ4614",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Run Condition is engine-start; no wheel/underside damage is shown that would prevent it driving, but a side impact at wheel height can disturb tracking/geometry — confirm the vehicle drives straight.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": []
  },
  {
    "id": "#8",
    "lot": "EA17HDN",
    "surface": "Key Cost Drivers",
    "mode": "redflags",
    "line": "- Door mirror: mirror glass and cap gone on the body-side, exposing the motor housing — replacement unit and paint.",
    "panels": [
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": [],
    "note": "the door mirror is CHARGED on EA17HDN (isChargedRow) — not uncosted, so no line; the sentence is kept"
  },
  {
    "id": "#9",
    "lot": "EN23NJX",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- The front door on the damaged side sits within the swipe path; no independent damage is visible on its own shots but photo angles are limited — verify.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      }
    ],
    "expect": []
  },
  {
    "id": "#10",
    "lot": "EN23NJX",
    "surface": "Visible Damage Summary",
    "mode": "redflags",
    "line": "This is a 2023 Ford Puma ST-Line Vignale mHEV — a current-generation, well-specced petrol mild-hybrid crossover with genuinely low mileage for age (17,489 miles), a desirability signal that frames it strongly. The damage is a single-event flank swipe running along one side — a low-to-mid-height impact scuffing and the sill, rear quarter and rear wheel-arch moulding, with the trailing sweep dishing the rear bumper corner; the front and opposite flank are undamaged and the engine bay is intact. The biggest unseeable unknown is whether the flank impact has disturbed the structural inner sill/rocker reinforcement behind the visibly scuffed outer sill — a Cat-S-relevant structural question the photos cannot resolve, alongside HV mild-hybrid system integrity given the flank hit passes near underfloor components.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      }
    ],
    "expect": []
  },
  {
    "id": "#11",
    "lot": "FE68AOP",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Flank scuffing extends forward along the body side toward the sill on the damaged side. The structural sill cannot be confirmed intact beneath the trim from these photos — inspect before bidding.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": []
  },
  {
    "id": "#12",
    "lot": "FE68AOP",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- MOT ladder runs cleanly upward — 12,769 → 15,100 → 29,693 → 54,312 → 58,033 → 60,542 miles — consistent with the declared mileage; no rollback or implausible jump detected. Recent test (Jan 2026) notes rear inner tyre wear near the limit and rear brake discs worn/pitted (advisory) — worth budgeting for consumables. Earlier windscreen \"damaged but not adversely affecting view\" advisories were minor; no windscreen crack is visible in the current photos.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": []
  },
  {
    "id": "#13",
    "lot": "KT73YAJ",
    "surface": "Key Cost Drivers",
    "mode": "redflags",
    "line": "- Front wheel and tyre: the corner absorbed the impact; alloy and tyre replacement plus geometry set-up.",
    "panels": [
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "OTHER",
        "name": "Other"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      }
    ],
    "expect": [
      "TYRE"
    ],
    "note": "the wheel is CHARGED on KT73YAJ; the tyre (\"tyre replacement\") is not"
  },
  {
    "id": "#14",
    "lot": "KT73YAJ",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Non-runner with keys present: the dash shows a \"Teaching in transmission / operate selector lever\" message and the vehicle is listed as does-not-run. There is no visible wheel/underside reason for a running car not to move beyond the front-corner suspension damage, so a drivetrain or transmission-adaptation fault is an unseeable unknown — establish why it does not run before bidding.",
    "panels": [
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "OTHER",
        "name": "Other"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      }
    ],
    "expect": []
  },
  {
    "id": "#15",
    "lot": "KT73YAJ",
    "surface": "Visible Damage Summary",
    "mode": "redflags",
    "line": "A 2023 Mercedes-Benz CLA 200 AMG Line Premium MHEV coupé with genuinely low delivery mileage, showing a single front-corner impact confined to one side — front bumper, wing/arch trim and one front wheel/tyre — with the opposite flank, roof, rear and engine bay all intact; the wing liner is torn back exposing the bumper-to-wing seam. The front corner impact drove into the wheel and suspension, so the biggest unseeable risk is front suspension and steering-geometry integrity behind the displaced arch, which photos cannot resolve; the headlamp on the struck corner appears intact and undisturbed in the front and corner shots. Damage is contained to one front corner and one front wheel/tyre — corner uncertain from the mix of angles, so treat as the damaged-side front corner.",
    "panels": [
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "OTHER",
        "name": "Other"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      }
    ],
    "expect": [
      "TYRE"
    ],
    "note": "the wheel is CHARGED on KT73YAJ; \"wheel/tyre\" records the tyre"
  },
  {
    "id": "#16",
    "lot": "SA26KVT",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Vehicle is a non-runner despite keys being present; no wheel, suspension or underside damage is visible to explain immobility. The cause is not established from photos — treat drivetrain/ancillary condition as an inspection-class unknown.",
    "panels": [
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "WHEEL_ARCH_MOULDING",
        "name": "Wheel arch moulding"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": []
  },
  {
    "id": "#17",
    "lot": "SD75YGC",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Driver's frontal airbag deployed and windscreen fractured — collateral behind the dashboard (steering column, wiring, sensors) is not scopeable from photos and the extent of SRS components requiring replacement is a floor, not a ceiling.",
    "panels": [
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "WHEEL_ARCH_MOULDING",
        "name": "Wheel arch moulding"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      }
    ],
    "expect": [
      "WINDSCREEN"
    ]
  },
  {
    "id": "#18",
    "lot": "SF69YBB",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Bonnet leading edge sits slightly proud in the front photos; the skin appears intact (an alignment consequence, not necessarily a replacement) but the latch/shut-line area behind should be verified.",
    "panels": [
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      }
    ],
    "expect": []
  },
  {
    "id": "#19",
    "lot": "SF69YBB",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- MOT advisory history: front tyres repeatedly noted worn close to legal limit (2023, 2025, 2026) and an damaged front lower bumper skirt noted insecure at consecutive earlier tests — this area carried a pre-existing condition into the current period; the damaged-side front tyre should be confirmed serviceable.",
    "panels": [
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      }
    ],
    "expect": []
  },
  {
    "id": "#20",
    "lot": "URZ7545",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Windscreen is starred/cracked, consistent with the curtain deployment — replacement likely.",
    "panels": [
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": [
      "WINDSCREEN"
    ]
  },
  {
    "id": "#21",
    "lot": "YH23NVW",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Chalk arrows run along the lower body/sill line and the front arch moulding — these mark yard-noted points; the sill is not independently confirmed as damaged on its own shots. Verify.",
    "panels": [
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "WHEEL_ARCH_MOULDING",
        "name": "Wheel arch moulding"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      }
    ],
    "expect": []
  },
  {
    "id": "#22",
    "lot": "YH23NVW",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Chalk arrows run along the lower body/sill line and the front arch moulding — these mark yard-noted points; the sill is not independently confirmed as damaged on its own shots. Verify.",
    "panels": [
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "WHEEL_ARCH_MOULDING",
        "name": "Wheel arch moulding"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      },
      {
        "panelId": "REAR_PANEL",
        "name": "Rear panel"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      }
    ],
    "expect": []
  },
  {
    "id": "x1",
    "lot": "URZ7545",
    "surface": "Visible Damage Summary",
    "mode": "redflags",
    "line": "A 2023 Škoda Octavia SE L estate mild-hybrid, near-new and current-generation with a desirable spec, carrying a single full-width frontal impact — bonnet buckled across its width, front bumper and grille detached to the ground, and the cooling pack exposed — with the driver's frontal and curtain airbags deployed and the windscreen starred; the biggest unseeable risk is the integrity of the front upper structure and slam-panel-area metal behind the exposed cooling pack, which photos cannot confirm and which governs whether this stays a bolt-on repair. Both front headlamps sit in a disturbed, exposed recess and their serviceability cannot be confirmed from the photos.",
    "panels": [
      {
        "panelId": "FRONT_WING",
        "name": "Front wing"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "PARCEL_SHELF",
        "name": "Parcel shelf"
      }
    ],
    "expect": [
      "WINDSCREEN"
    ],
    "note": "batch 174 extra: \"the windscreen starred\""
  },
  {
    "id": "x2",
    "lot": "AMZ3790",
    "surface": "Red Flags",
    "mode": "redflags",
    "line": "- Windscreen chip present under chalk marking — confirm whether in driver's eyeline (MOT implication) and whether it needs repair or full replacement.",
    "panels": [
      {
        "panelId": "FRONT_DOOR",
        "name": "Front door"
      },
      {
        "panelId": "REAR_DOOR",
        "name": "Rear door"
      },
      {
        "panelId": "REAR_QUARTER",
        "name": "Rear quarter panel"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "EV_BATTERY_PRESENCE",
        "name": "EV battery presence"
      },
      {
        "panelId": "REAR_STRUCTURE",
        "name": "Rear structure"
      },
      {
        "panelId": "WHEEL_ARCH_MOULDING",
        "name": "Wheel arch moulding"
      }
    ],
    "expect": [
      "WINDSCREEN"
    ],
    "note": "batch 174 extra: \"Windscreen chip\" (label: clean — an extra line on a clean panel costs one check)"
  },
  {
    "id": "x3",
    "lot": "DMZ4614",
    "surface": "Margin Calculation",
    "mode": "speculation",
    "line": "The band position is mid: the lot has strong desirability signals (low mileage, current-generation N Line manual, petrol) offset by a moderate-to-heavy single-flank repair whose cost is dominated by two door shells, paint labour, and the sill zone. The repair is moderate in the outer-panel scope but carries meaningful upside risk if the inner sill or B-pillar base is deformed — that would convert this from a bolt-on-panel job to a structural one. The margin picture therefore hinges heavily on the structural inspection outcome: if the inner structure is straight the itemised panel repair stands as costed; if it is folded, add structural work not in this estimate.",
    "panels": [
      {
        "panelId": "FRONT_BUMPER",
        "name": "Front bumper"
      },
      {
        "panelId": "GRILLE",
        "name": "Grille"
      },
      {
        "panelId": "BONNET",
        "name": "Bonnet"
      },
      {
        "panelId": "HEADLAMP",
        "name": "Headlamp"
      },
      {
        "panelId": "FOG_LAMP",
        "name": "Fog lamp"
      },
      {
        "panelId": "DOOR_MIRROR",
        "name": "Door mirror"
      },
      {
        "panelId": "WINDSCREEN",
        "name": "Windscreen"
      },
      {
        "panelId": "SIDE_GLASS",
        "name": "Side glass"
      },
      {
        "panelId": "WHEEL",
        "name": "Wheel"
      },
      {
        "panelId": "TYRE",
        "name": "Tyre"
      },
      {
        "panelId": "ROOF",
        "name": "Roof"
      },
      {
        "panelId": "SILL",
        "name": "Sill"
      },
      {
        "panelId": "SIDE_SKIRT",
        "name": "Side skirt"
      },
      {
        "panelId": "SIDE_STRUCTURE",
        "name": "Side structure"
      },
      {
        "panelId": "REAR_BUMPER",
        "name": "Rear bumper"
      },
      {
        "panelId": "BOOT_LID",
        "name": "Boot lid"
      },
      {
        "panelId": "REAR_LAMP",
        "name": "Rear lamp"
      },
      {
        "panelId": "REAR_GLASS",
        "name": "Rear glass"
      },
      {
        "panelId": "AIRBAG",
        "name": "SRS airbag (deployed)"
      },
      {
        "panelId": "FRONT_STRUCTURE",
        "name": "Front structure"
      },
      {
        "panelId": "SLAM_PANEL",
        "name": "Slam panel"
      },
      {
        "panelId": "RADIATOR_PACK",
        "name": "Radiator pack"
      }
    ],
    "expect": [],
    "note": "batch 174 extra — KNOWN LIMIT, not ruled: the list comma (\"…, paint labour, and the sill zone\") separates the sill from \"cost is dominated\"; batch 174 open item 2"
  }
];

console.log('\n-- the 22 (batch 172 P3) + batch 174 extras: kept, and recorded only on a real claim --');
for (const c of CASES) {
  const r = bindClaimClasses(c.line + PAD, ctxOf(), c.mode);
  ok(`${c.id} ${c.lot} [${c.surface}] the line is KEPT verbatim`, r.dropped.length === 0 && r.text.includes(c.line.trim()));
  const got = [...new Set(findProseDamageUncosted(c.line, c.panels, c.mode).map((h) => h.panelId))];
  ok(`${c.id} ${c.lot} records ${JSON.stringify(c.expect)}${c.note ? ` — ${c.note}` : ''}`, same(got, c.expect));
}

console.log('\n-- detection on its own --');
const P = [{ panelId: 'WINDSCREEN', name: 'Windscreen' }, { panelId: 'SILL', name: 'Sill' }, { panelId: 'WHEEL', name: 'Wheel' }, { panelId: 'DOOR_MIRROR', name: 'Door mirror' }];
const rec = (s, mode) => findProseDamageUncosted(s, P, mode).map((h) => h.panelId);
for (const w of ['gone', 'missing', 'cracked', 'starred', 'chipped', 'fractured', 'displaced', 'broken', 'torn', 'split', 'dented', 'crushed', 'buckled', 'creased', 'smashed'])
  ok(`condition word "${w}" is a claim`, same(rec(`The windscreen is ${w}.`), ['WINDSCREEN']));
ok('the stems match their words ("damaged", "replacing")', same(rec('The sill is damaged.'), ['SILL']) && same(rec('The door mirror needs replacing.'), ['DOOR_MIRROR']));
ok('G1: "wheel arch liner is displaced" is not the road wheel', rec('The wheel arch liner is displaced.').length === 0);
ok('G2: a status word in another clause is not bound', rec('The sill looks straight; the rear bumper is damaged.').length === 0);
ok('G2: "at wheel height" / "the sill line" are locations', rec('Hidden damage from a side hit at wheel height.').length === 0 && rec('Chalk marks damage along the sill line.').length === 0);
ok('G2: a bracketed list is one clause', same(rec('The damage is cosmetic (sill, trim).'), ['SILL']));
ok('G3: negation, all-clear, inspection ask', rec('No wheel damage is visible.').length === 0 && rec('The sill appears intact and undamaged.').length === 0 && rec('Verify whether the sill is damaged.').length === 0);
ok('a hedged sentence in a speculation field records nothing', rec('The windscreen may be cracked.', 'speculation').length === 0 && same(rec('The windscreen may be cracked.', 'redflags'), ['WINDSCREEN']));

console.log('\n-- the inspection line: one per panel, code-owned wording, never a duplicate --');
const WORDS = 'The report describes damage to the Windscreen that is not in the repair total — check it on inspection and add it to the ledger if confirmed.';
ok('the wording, verbatim', PROSE_DAMAGE_UNCOSTED_REASON('Windscreen') === WORDS);
{
  const a = { _flaggedParts: [], 'WhatsApp Inspection Checklist': '1. Show the VIN plate.\n2. Show the dashboard with the engine running.' };
  const recs = [{ panel: 'Windscreen', panelId: 'WINDSCREEN', surface: 'Red Flags', sentence: 'Windscreen is starred.' },
                { panel: 'Windscreen', panelId: 'WINDSCREEN', surface: 'Visible Damage Summary', sentence: 'the windscreen starred' }];
  addProseDamageInspection(a, recs, () => 'front');
  ok('no flag and no checklist line → ONE flag with the wording', a._flaggedParts.length === 1 && a._flaggedParts[0].reason === WORDS && a._flaggedParts[0]._proseDamageUncosted === true && a._flaggedParts[0].panelId === 'WINDSCREEN' && a._flaggedParts[0].zone === 'front');
  ok('…and ONE numbered checklist line, the same words', a['WhatsApp Inspection Checklist'].endsWith(`\n3. ${WORDS}`) && a['WhatsApp Inspection Checklist'].split(WORDS).length === 2);
  ok('…both records say what happened (added, then added for the same panel)', recs.every((r) => r.inspection === 'added'));
  ok('the flag has no disagree / not-visible mark, so buildBuyerFlags always shows it', !a._flaggedParts[0]._amalgDisagree && !a._flaggedParts[0]._amalgNotVisible);
}
{
  const a = { _flaggedParts: [{ panelId: 'FRONT_BUMPER', partName: 'Front bumper', zone: 'front', weight: 'medium', reason: 'The photos show at most light marking on the Front bumper — not included in the repair total; check it on inspection.' }], 'WhatsApp Inspection Checklist': '1. x' };
  const recs = [{ panel: 'Front bumper', panelId: 'FRONT_BUMPER', surface: 'Visible Damage Summary', sentence: 'the front bumper is displaced' }];
  addProseDamageInspection(a, recs);
  ok('a panel that already has a flag (CK75ONW\'s probe-floored bumper) gets nothing new', a._flaggedParts.length === 1 && a['WhatsApp Inspection Checklist'] === '1. x' && recs[0].inspection === 'existing flag');
}
{
  const a = { _flaggedParts: [], 'WhatsApp Inspection Checklist': '1. Show the sill close-up along the damaged side.' };
  const recs = [{ panel: 'Sill', panelId: 'SILL', surface: 'Red Flags', sentence: 'The sill is dented.' }];
  addProseDamageInspection(a, recs);
  ok('a panel that already has a checklist line gets nothing new', a._flaggedParts.length === 0 && recs[0].inspection === 'existing checklist line');
}
{
  const a = { _flaggedParts: [], 'WhatsApp Inspection Checklist': '1. Show the rear wheel arch moulding close-up.' };
  const recs = [{ panel: 'Wheel', panelId: 'WHEEL', surface: 'Red Flags', sentence: 'The front wheel is buckled.' }];
  addProseDamageInspection(a, recs);
  ok('a checklist line about the wheel ARCH MOULDING does not cover the road wheel (G1)', a._flaggedParts.length === 1 && recs[0].inspection === 'added');
}

console.log('\n-- route and page wiring --');
ok('route: part status left the binder ctx (no demoted list)', !/demoted:\s*coreObs\.costedParts/.test(route));
ok('route: uncosted = demoted AND not charged (the one charged-row check)', route.includes('const _chargedIds = new Set(gatedParts.filter(isChargedRow).map(p => p.panelId).filter(Boolean));')
  && route.includes('.filter(cp => cp.independentlyVisible === false && !_chargedIds.has(cp.panelId))'));
ok('route: detection reads the text the buyer sees (after binding)', route.indexOf('findProseDamageUncosted(text, _uncostedPanels, mode)') > route.indexOf('assessment[field] = text;'));
ok('route: the inspection line runs after the checklist seed', route.indexOf('addProseDamageInspection(assessment, _proseDamage') > route.indexOf('seedChecklistFromFlags(checklistText, buyerFlags'));
ok('route: stamps _proseDamageUncosted', route.includes('assessment._proseDamageUncosted = addProseDamageInspection('));
ok('page: the flag pre-fills the add-line control with the panel, only when the ledger is editable',
  page.includes('f._proseDamageUncosted && ledgerEditable') && page.includes("setAddDraft({ text: f.partName, amount: '' })") && page.includes('id="ledger-add-line"'));

console.log(`\nbatch175: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
