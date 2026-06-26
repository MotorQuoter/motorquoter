// Price-band deriver + static panel price table.
// Source: Vincent trade-knowledge price grid, Jun 2026.
//
// Boundary rule: a value exactly on a boundary belongs to the LOWER band.
//   £5,000 = Economy   £5,001 = Mid-range
//   £10,000 = Mid-range  £10,001 = Executive   (etc.)

// ── Band key strings — SINGLE SOURCE OF TRUTH ────────────────────────────────────────────
// Referenced from BOTH derivePriceBand and PANEL_PRICE_TABLE. Never hand-type these strings
// elsewhere: a mismatch causes a silent lookup miss (panel falls to Q2 model-figure fallback
// with no error). The canonical keys are Title Case with hyphens as shown.
export const BAND_KEYS = Object.freeze({
  ECONOMY:    'Economy',
  MID_RANGE:  'Mid-range',
  EXECUTIVE:  'Executive',
  UPPER_EXEC: 'Upper-exec',
  PRESTIGE:   'Prestige',
  LUXURY:     'Luxury',
  SUPER_LUX:  'Super-lux',
});

export const PRICE_BAND_KEYS = Object.freeze(Object.values(BAND_KEYS));

// Threshold array: each entry [ceiling, bandKey]. First ceiling >= value wins.
// Encodes the boundary rule directly — value <= ceiling falls into that band.
const BAND_THRESHOLDS = [
  [5000,  BAND_KEYS.ECONOMY],
  [10000, BAND_KEYS.MID_RANGE],
  [15000, BAND_KEYS.EXECUTIVE],
  [20000, BAND_KEYS.UPPER_EXEC],
  [25000, BAND_KEYS.PRESTIGE],
  [40000, BAND_KEYS.LUXURY],
];

// Returns one of the PRICE_BAND_KEYS, or null when tradeAvg is absent/non-numeric.
// Null signals the Q2 fallback: caller must retain the model figure and NOT apply the table.
export function derivePriceBand(tradeAvg) {
  if (tradeAvg == null) return null;
  if (typeof tradeAvg === 'string' && tradeAvg.trim() === '') return null;
  const v = Number(tradeAvg);
  if (!isFinite(v) || v < 0) return null;
  for (const [ceiling, key] of BAND_THRESHOLDS) {
    if (v <= ceiling) return key;
  }
  return BAND_KEYS.SUPER_LUX;
}

// ── PANEL_PRICE_TABLE ─────────────────────────────────────────────────────────────────────
// Static code-owned parts costs keyed by panelId × value-band.
// Source: Vincent trade-knowledge price grid, Jun 2026.
// 22 cost panels — HEADLAMP and GRILLE excluded (both keep their existing code-owned logic).
// used = S/H figure used in repair total; oem = new figure carried for future use only.
// All figures are £5-rounded, trade-validated. No S/H figure exceeds its OEM.
// WINDSCREEN: figures are band central values; tech-spread (HUD/rain/ADAS) is a future
// variance item — no logic here.
export const PANEL_PRICE_TABLE = Object.freeze({
  FRONT_BUMPER: {
    [BAND_KEYS.ECONOMY]:      { oem: 220, used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 290, used: 160 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 365, used: 200 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 435, used: 240 },
    [BAND_KEYS.PRESTIGE]:     { oem: 545, used: 300 },
    [BAND_KEYS.LUXURY]:       { oem: 655, used: 360 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 875, used: 480 },
  },
  BONNET: {
    [BAND_KEYS.ECONOMY]:      { oem: 165, used: 90 },
    [BAND_KEYS.MID_RANGE]:    { oem: 220, used: 120 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 300, used: 165 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 400, used: 220 },
    [BAND_KEYS.PRESTIGE]:     { oem: 510, used: 280 },
    [BAND_KEYS.LUXURY]:       { oem: 620, used: 340 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 820, used: 450 },
  },
  SLAM_PANEL: {
    [BAND_KEYS.ECONOMY]:      { oem: 60, used: 35 },
    [BAND_KEYS.MID_RANGE]:    { oem: 75, used: 40 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 95, used: 50 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 120, used: 65 },
    [BAND_KEYS.PRESTIGE]:     { oem: 160, used: 90 },
    [BAND_KEYS.LUXURY]:       { oem: 220, used: 120 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 300, used: 165 },
  },
  FRONT_WING: {
    [BAND_KEYS.ECONOMY]:      { oem: 125, used: 70 },
    [BAND_KEYS.MID_RANGE]:    { oem: 175, used: 95 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 235, used: 130 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 300, used: 165 },
    [BAND_KEYS.PRESTIGE]:     { oem: 380, used: 210 },
    [BAND_KEYS.LUXURY]:       { oem: 475, used: 260 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 655, used: 360 },
  },
  FOG_LAMP: {
    [BAND_KEYS.ECONOMY]:      { oem: 55, used: 30 },
    [BAND_KEYS.MID_RANGE]:    { oem: 70, used: 40 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 95, used: 50 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 120, used: 65 },
    [BAND_KEYS.PRESTIGE]:     { oem: 150, used: 80 },
    [BAND_KEYS.LUXURY]:       { oem: 190, used: 105 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 260, used: 145 },
  },
  RADIATOR_PACK: {
    [BAND_KEYS.ECONOMY]:      { oem: 325, used: 180 },
    [BAND_KEYS.MID_RANGE]:    { oem: 420, used: 230 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 545, used: 300 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 690, used: 380 },
    [BAND_KEYS.PRESTIGE]:     { oem: 875, used: 480 },
    [BAND_KEYS.LUXURY]:       { oem: 1055, used: 580 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1420, used: 780 },
  },
  FRONT_DOOR: {
    [BAND_KEYS.ECONOMY]:      { oem: 290, used: 160 },
    [BAND_KEYS.MID_RANGE]:    { oem: 365, used: 200 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 490, used: 270 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 600, used: 330 },
    [BAND_KEYS.PRESTIGE]:     { oem: 765, used: 420 },
    [BAND_KEYS.LUXURY]:       { oem: 945, used: 520 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1275, used: 700 },
  },
  REAR_DOOR: {
    [BAND_KEYS.ECONOMY]:      { oem: 275, used: 150 },
    [BAND_KEYS.MID_RANGE]:    { oem: 345, used: 190 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 455, used: 250 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 565, used: 310 },
    [BAND_KEYS.PRESTIGE]:     { oem: 725, used: 400 },
    [BAND_KEYS.LUXURY]:       { oem: 910, used: 500 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1235, used: 680 },
  },
  SILL: {
    [BAND_KEYS.ECONOMY]:      { oem: 90, used: 50 },
    [BAND_KEYS.MID_RANGE]:    { oem: 110, used: 60 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 140, used: 75 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 190, used: 105 },
    [BAND_KEYS.PRESTIGE]:     { oem: 240, used: 130 },
    [BAND_KEYS.LUXURY]:       { oem: 300, used: 165 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 400, used: 220 },
  },
  SIDE_SKIRT: {
    [BAND_KEYS.ECONOMY]:      { oem: 100, used: 55 },
    [BAND_KEYS.MID_RANGE]:    { oem: 125, used: 70 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 175, used: 95 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 220, used: 120 },
    [BAND_KEYS.PRESTIGE]:     { oem: 275, used: 150 },
    [BAND_KEYS.LUXURY]:       { oem: 345, used: 190 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 475, used: 260 },
  },
  DOOR_MIRROR: {
    [BAND_KEYS.ECONOMY]:      { oem: 110, used: 60 },
    [BAND_KEYS.MID_RANGE]:    { oem: 165, used: 90 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 235, used: 130 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 325, used: 180 },
    [BAND_KEYS.PRESTIGE]:     { oem: 435, used: 240 },
    [BAND_KEYS.LUXURY]:       { oem: 580, used: 320 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 820, used: 450 },
  },
  SIDE_GLASS: {
    [BAND_KEYS.ECONOMY]:      { oem: 80, used: 45 },
    [BAND_KEYS.MID_RANGE]:    { oem: 120, used: 65 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 175, used: 95 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 235, used: 130 },
    [BAND_KEYS.PRESTIGE]:     { oem: 310, used: 170 },
    [BAND_KEYS.LUXURY]:       { oem: 400, used: 220 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 545, used: 300 },
  },
  REAR_BUMPER: {
    [BAND_KEYS.ECONOMY]:      { oem: 200, used: 110 },
    [BAND_KEYS.MID_RANGE]:    { oem: 265, used: 145 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 335, used: 185 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 410, used: 225 },
    [BAND_KEYS.PRESTIGE]:     { oem: 525, used: 290 },
    [BAND_KEYS.LUXURY]:       { oem: 655, used: 360 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 875, used: 480 },
  },
  REAR_QUARTER: {
    [BAND_KEYS.ECONOMY]:      { oem: 220, used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 260, used: 145 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 320, used: 175 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 400, used: 220 },
    [BAND_KEYS.PRESTIGE]:     { oem: 500, used: 275 },
    [BAND_KEYS.LUXURY]:       { oem: 620, used: 340 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 850, used: 470 },
  },
  REAR_LAMP: {
    [BAND_KEYS.ECONOMY]:      { oem: 70, used: 40 },
    [BAND_KEYS.MID_RANGE]:    { oem: 90, used: 50 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 120, used: 65 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 160, used: 90 },
    [BAND_KEYS.PRESTIGE]:     { oem: 210, used: 115 },
    [BAND_KEYS.LUXURY]:       { oem: 280, used: 155 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 380, used: 210 },
  },
  BOOT_LID: {
    [BAND_KEYS.ECONOMY]:      { oem: 200, used: 110 },
    [BAND_KEYS.MID_RANGE]:    { oem: 255, used: 140 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 325, used: 180 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 420, used: 230 },
    [BAND_KEYS.PRESTIGE]:     { oem: 545, used: 300 },
    [BAND_KEYS.LUXURY]:       { oem: 690, used: 380 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 945, used: 520 },
  },
  REAR_PANEL: {
    [BAND_KEYS.ECONOMY]:      { oem: 150, used: 80 },
    [BAND_KEYS.MID_RANGE]:    { oem: 175, used: 95 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 200, used: 110 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 240, used: 130 },
    [BAND_KEYS.PRESTIGE]:     { oem: 290, used: 160 },
    [BAND_KEYS.LUXURY]:       { oem: 360, used: 200 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 480, used: 265 },
  },
  WINDSCREEN: {
    [BAND_KEYS.ECONOMY]:      { oem: 220, used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 250, used: 140 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 300, used: 165 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 380, used: 210 },
    [BAND_KEYS.PRESTIGE]:     { oem: 480, used: 265 },
    [BAND_KEYS.LUXURY]:       { oem: 620, used: 340 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 850, used: 470 },
  },
  REAR_GLASS: {
    [BAND_KEYS.ECONOMY]:      { oem: 165, used: 90 },
    [BAND_KEYS.MID_RANGE]:    { oem: 220, used: 120 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 290, used: 160 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 380, used: 210 },
    [BAND_KEYS.PRESTIGE]:     { oem: 510, used: 280 },
    [BAND_KEYS.LUXURY]:       { oem: 655, used: 360 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 910, used: 500 },
  },
  ROOF: {
    [BAND_KEYS.ECONOMY]:      { oem: 180, used: 100 },
    [BAND_KEYS.MID_RANGE]:    { oem: 220, used: 120 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 280, used: 155 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 360, used: 200 },
    [BAND_KEYS.PRESTIGE]:     { oem: 460, used: 255 },
    [BAND_KEYS.LUXURY]:       { oem: 600, used: 330 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 850, used: 470 },
  },
  WHEEL: {
    [BAND_KEYS.ECONOMY]:      { oem: 200, used: 110 },
    [BAND_KEYS.MID_RANGE]:    { oem: 275, used: 150 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 365, used: 200 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 475, used: 260 },
    [BAND_KEYS.PRESTIGE]:     { oem: 620, used: 340 },
    [BAND_KEYS.LUXURY]:       { oem: 800, used: 440 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1125, used: 620 },
  },
  TYRE: {
    [BAND_KEYS.ECONOMY]:      { oem: 60, used: 35 },
    [BAND_KEYS.MID_RANGE]:    { oem: 80, used: 45 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 110, used: 60 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 150, used: 80 },
    [BAND_KEYS.PRESTIGE]:     { oem: 200, used: 110 },
    [BAND_KEYS.LUXURY]:       { oem: 280, used: 155 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 400, used: 220 },
  },

  // ── Van/pickup body panels — anchored derivations, Jun 2026 ─────────────────
  // Basis: FRONT_DOOR/BOOT_LID/REAR_PANEL/SIDE_GLASS/REAR_GLASS/REAR_QUARTER/ROOF
  // anchors × panel-specific multipliers; used = MROUND(oem × 0.55, 5).

  SLIDING_DOOR_SOLID: {
    [BAND_KEYS.ECONOMY]:      { oem: 305,  used: 170 },
    [BAND_KEYS.MID_RANGE]:    { oem: 385,  used: 210 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 515,  used: 285 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 630,  used: 345 },
    [BAND_KEYS.PRESTIGE]:     { oem: 805,  used: 445 },
    [BAND_KEYS.LUXURY]:       { oem: 990,  used: 545 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1340, used: 735 },
  },
  SLIDING_DOOR_GLAZED: {
    [BAND_KEYS.ECONOMY]:      { oem: 370,  used: 205 },
    [BAND_KEYS.MID_RANGE]:    { oem: 485,  used: 265 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 665,  used: 365 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 835,  used: 460 },
    [BAND_KEYS.PRESTIGE]:     { oem: 1075, used: 590 },
    [BAND_KEYS.LUXURY]:       { oem: 1345, used: 740 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1820, used: 1000 },
  },
  BARN_DOOR_L: {
    [BAND_KEYS.ECONOMY]:      { oem: 120,  used: 65 },
    [BAND_KEYS.MID_RANGE]:    { oem: 155,  used: 85 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 195,  used: 105 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 250,  used: 140 },
    [BAND_KEYS.PRESTIGE]:     { oem: 325,  used: 180 },
    [BAND_KEYS.LUXURY]:       { oem: 415,  used: 230 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 565,  used: 310 },
  },
  BARN_DOOR_R: {
    [BAND_KEYS.ECONOMY]:      { oem: 120,  used: 65 },
    [BAND_KEYS.MID_RANGE]:    { oem: 155,  used: 85 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 195,  used: 105 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 250,  used: 140 },
    [BAND_KEYS.PRESTIGE]:     { oem: 325,  used: 180 },
    [BAND_KEYS.LUXURY]:       { oem: 415,  used: 230 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 565,  used: 310 },
  },
  LOAD_BULKHEAD: {
    [BAND_KEYS.ECONOMY]:      { oem: 150,  used: 80 },
    [BAND_KEYS.MID_RANGE]:    { oem: 175,  used: 95 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 200,  used: 110 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 240,  used: 130 },
    [BAND_KEYS.PRESTIGE]:     { oem: 290,  used: 160 },
    [BAND_KEYS.LUXURY]:       { oem: 360,  used: 200 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 480,  used: 265 },
  },
  CREW_WINDOW: {
    [BAND_KEYS.ECONOMY]:      { oem: 80,   used: 45 },
    [BAND_KEYS.MID_RANGE]:    { oem: 120,  used: 65 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 175,  used: 95 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 235,  used: 130 },
    [BAND_KEYS.PRESTIGE]:     { oem: 310,  used: 170 },
    [BAND_KEYS.LUXURY]:       { oem: 400,  used: 220 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 545,  used: 300 },
  },
  BODY_SIDE_GLAZING: {
    [BAND_KEYS.ECONOMY]:      { oem: 130,  used: 70 },
    [BAND_KEYS.MID_RANGE]:    { oem: 175,  used: 95 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 230,  used: 125 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 305,  used: 170 },
    [BAND_KEYS.PRESTIGE]:     { oem: 410,  used: 225 },
    [BAND_KEYS.LUXURY]:       { oem: 525,  used: 290 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 730,  used: 400 },
  },
  TAILGATE_GLAZED: {
    [BAND_KEYS.ECONOMY]:      { oem: 220,  used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 280,  used: 155 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 360,  used: 200 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 460,  used: 255 },
    [BAND_KEYS.PRESTIGE]:     { oem: 600,  used: 330 },
    [BAND_KEYS.LUXURY]:       { oem: 760,  used: 420 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 1040, used: 570 },
  },

  // ── Pickup-only panels ────────────────────────────────────────────────────

  BED_SIDE_L: {
    [BAND_KEYS.ECONOMY]:      { oem: 220,  used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 260,  used: 145 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 320,  used: 175 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 400,  used: 220 },
    [BAND_KEYS.PRESTIGE]:     { oem: 500,  used: 275 },
    [BAND_KEYS.LUXURY]:       { oem: 620,  used: 340 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 850,  used: 470 },
  },
  BED_SIDE_R: {
    [BAND_KEYS.ECONOMY]:      { oem: 220,  used: 120 },
    [BAND_KEYS.MID_RANGE]:    { oem: 260,  used: 145 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 320,  used: 175 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 400,  used: 220 },
    [BAND_KEYS.PRESTIGE]:     { oem: 500,  used: 275 },
    [BAND_KEYS.LUXURY]:       { oem: 620,  used: 340 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 850,  used: 470 },
  },
  BED_FLOOR: {
    [BAND_KEYS.ECONOMY]:      { oem: 155,  used: 85 },
    [BAND_KEYS.MID_RANGE]:    { oem: 185,  used: 100 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 240,  used: 130 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 305,  used: 170 },
    [BAND_KEYS.PRESTIGE]:     { oem: 390,  used: 215 },
    [BAND_KEYS.LUXURY]:       { oem: 510,  used: 280 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 720,  used: 395 },
  },
  DROP_TAILGATE: {
    [BAND_KEYS.ECONOMY]:      { oem: 200,  used: 110 },
    [BAND_KEYS.MID_RANGE]:    { oem: 255,  used: 140 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 325,  used: 180 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 420,  used: 230 },
    [BAND_KEYS.PRESTIGE]:     { oem: 545,  used: 300 },
    [BAND_KEYS.LUXURY]:       { oem: 690,  used: 380 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 945,  used: 520 },
  },
  CAB_REAR_PANEL: {
    [BAND_KEYS.ECONOMY]:      { oem: 150,  used: 80 },
    [BAND_KEYS.MID_RANGE]:    { oem: 175,  used: 95 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 200,  used: 110 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 240,  used: 130 },
    [BAND_KEYS.PRESTIGE]:     { oem: 290,  used: 160 },
    [BAND_KEYS.LUXURY]:       { oem: 360,  used: 200 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 480,  used: 265 },
  },

  // Flat price across all bands by design — pickups don't span the value range,
  // so the rear cab window is band-invariant (Vincent ruling, Jun 2026).
  CAB_REAR_GLASS: {
    [BAND_KEYS.ECONOMY]:      { oem: 250,  used: 135 },
    [BAND_KEYS.MID_RANGE]:    { oem: 250,  used: 135 },
    [BAND_KEYS.EXECUTIVE]:    { oem: 250,  used: 135 },
    [BAND_KEYS.UPPER_EXEC]:   { oem: 250,  used: 135 },
    [BAND_KEYS.PRESTIGE]:     { oem: 250,  used: 135 },
    [BAND_KEYS.LUXURY]:       { oem: 250,  used: 135 },
    [BAND_KEYS.SUPER_LUX]:    { oem: 250,  used: 135 },
  },
});
