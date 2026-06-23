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
    [BAND_KEYS.ECONOMY]:    { oem: 275, used: 175 },
    [BAND_KEYS.MID_RANGE]:  { oem: 365, used: 200 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 455, used: 250 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 455, used: 250 },
    [BAND_KEYS.PRESTIGE]:   { oem: 545, used: 300 },
    [BAND_KEYS.LUXURY]:     { oem: 545, used: 300 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 725, used: 400 },
  },
  BONNET: {
    [BAND_KEYS.ECONOMY]:    { oem: 180, used: 100 },
    [BAND_KEYS.MID_RANGE]:  { oem: 180, used: 100 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 275, used: 150 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 455, used: 250 },
    [BAND_KEYS.PRESTIGE]:   { oem: 455, used: 250 },
    [BAND_KEYS.LUXURY]:     { oem: 545, used: 300 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 635, used: 350 },
  },
  SLAM_PANEL: {
    [BAND_KEYS.ECONOMY]:    { oem:  50, used:  30 },
    [BAND_KEYS.MID_RANGE]:  { oem:  50, used:  30 },
    [BAND_KEYS.EXECUTIVE]:  { oem:  75, used:  40 },
    [BAND_KEYS.UPPER_EXEC]: { oem:  75, used:  40 },
    [BAND_KEYS.PRESTIGE]:   { oem: 100, used:  55 },
    [BAND_KEYS.LUXURY]:     { oem: 150, used:  85 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 200, used: 110 },
  },
  FRONT_WING: {
    [BAND_KEYS.ECONOMY]:    { oem: 135, used:  75 },
    [BAND_KEYS.MID_RANGE]:  { oem: 135, used:  75 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 180, used: 100 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 225, used: 125 },
    [BAND_KEYS.PRESTIGE]:   { oem: 275, used: 150 },
    [BAND_KEYS.LUXURY]:     { oem: 275, used: 150 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 365, used: 200 },
  },
  FOG_LAMP: {
    [BAND_KEYS.ECONOMY]:    { oem:  60, used:  35 },
    [BAND_KEYS.MID_RANGE]:  { oem:  60, used:  35 },
    [BAND_KEYS.EXECUTIVE]:  { oem:  80, used:  45 },
    [BAND_KEYS.UPPER_EXEC]: { oem:  80, used:  45 },
    [BAND_KEYS.PRESTIGE]:   { oem:  90, used:  50 },
    [BAND_KEYS.LUXURY]:     { oem: 100, used:  55 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 125, used:  70 },
  },
  RADIATOR_PACK: {
    [BAND_KEYS.ECONOMY]:    { oem: 275, used: 150 },
    [BAND_KEYS.MID_RANGE]:  { oem: 275, used: 150 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 365, used: 200 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 455, used: 250 },
    [BAND_KEYS.PRESTIGE]:   { oem: 545, used: 300 },
    [BAND_KEYS.LUXURY]:     { oem: 545, used: 300 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 725, used: 400 },
  },
  FRONT_DOOR: {
    [BAND_KEYS.ECONOMY]:    { oem: 180, used: 100 },
    [BAND_KEYS.MID_RANGE]:  { oem: 180, used: 100 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 275, used: 150 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 365, used: 200 },
    [BAND_KEYS.PRESTIGE]:   { oem: 365, used: 200 },
    [BAND_KEYS.LUXURY]:     { oem: 410, used: 225 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 455, used: 250 },
  },
  REAR_DOOR: {
    [BAND_KEYS.ECONOMY]:    { oem: 100, used:  55 },
    [BAND_KEYS.MID_RANGE]:  { oem: 100, used:  55 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 150, used:  85 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 200, used: 110 },
    [BAND_KEYS.PRESTIGE]:   { oem: 200, used: 110 },
    [BAND_KEYS.LUXURY]:     { oem: 225, used: 125 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 250, used: 140 },
  },
  SILL: {
    [BAND_KEYS.ECONOMY]:    { oem: 100, used:  55 },
    [BAND_KEYS.MID_RANGE]:  { oem: 100, used:  55 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 100, used:  55 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 150, used:  85 },
    [BAND_KEYS.PRESTIGE]:   { oem: 175, used:  95 },
    [BAND_KEYS.LUXURY]:     { oem: 200, used: 110 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 225, used: 125 },
  },
  SIDE_SKIRT: {
    [BAND_KEYS.ECONOMY]:    { oem: 120, used:  65 },
    [BAND_KEYS.MID_RANGE]:  { oem: 120, used:  65 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 125, used:  70 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 125, used:  70 },
    [BAND_KEYS.PRESTIGE]:   { oem: 135, used:  75 },
    [BAND_KEYS.LUXURY]:     { oem: 145, used:  80 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 180, used: 100 },
  },
  DOOR_MIRROR: {
    [BAND_KEYS.ECONOMY]:    { oem: 135, used:  75 },
    [BAND_KEYS.MID_RANGE]:  { oem: 135, used:  75 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 180, used: 100 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 225, used: 125 },
    [BAND_KEYS.PRESTIGE]:   { oem: 275, used: 150 },
    [BAND_KEYS.LUXURY]:     { oem: 320, used: 175 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 365, used: 200 },
  },
  SIDE_GLASS: {
    [BAND_KEYS.ECONOMY]:    { oem:  90, used:  50 },
    [BAND_KEYS.MID_RANGE]:  { oem:  90, used:  50 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 135, used:  75 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 135, used:  75 },
    [BAND_KEYS.PRESTIGE]:   { oem: 165, used:  90 },
    [BAND_KEYS.LUXURY]:     { oem: 180, used: 100 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 225, used: 125 },
  },
  REAR_BUMPER: {
    [BAND_KEYS.ECONOMY]:    { oem: 135, used:  75 },
    [BAND_KEYS.MID_RANGE]:  { oem: 135, used:  75 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 145, used:  80 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 145, used:  80 },
    [BAND_KEYS.PRESTIGE]:   { oem: 180, used: 100 },
    [BAND_KEYS.LUXURY]:     { oem: 225, used: 125 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 275, used: 150 },
  },
  REAR_QUARTER: {
    [BAND_KEYS.ECONOMY]:    { oem: 250, used: 140 },
    [BAND_KEYS.MID_RANGE]:  { oem: 250, used: 140 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 300, used: 165 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 300, used: 165 },
    [BAND_KEYS.PRESTIGE]:   { oem: 350, used: 195 },
    [BAND_KEYS.LUXURY]:     { oem: 400, used: 220 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 450, used: 250 },
  },
  REAR_LAMP: {
    [BAND_KEYS.ECONOMY]:    { oem:  75, used:  40 },
    [BAND_KEYS.MID_RANGE]:  { oem:  75, used:  40 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 100, used:  55 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 125, used:  70 },
    [BAND_KEYS.PRESTIGE]:   { oem: 150, used:  85 },
    [BAND_KEYS.LUXURY]:     { oem: 175, used:  95 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 200, used: 110 },
  },
  BOOT_LID: {
    [BAND_KEYS.ECONOMY]:    { oem: 220, used: 120 },
    [BAND_KEYS.MID_RANGE]:  { oem: 220, used: 120 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 225, used: 125 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 275, used: 150 },
    [BAND_KEYS.PRESTIGE]:   { oem: 320, used: 175 },
    [BAND_KEYS.LUXURY]:     { oem: 365, used: 200 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 365, used: 200 },
  },
  REAR_PANEL: {
    [BAND_KEYS.ECONOMY]:    { oem: 160, used:  90 },
    [BAND_KEYS.MID_RANGE]:  { oem: 175, used:  95 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 175, used:  95 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 200, used: 110 },
    [BAND_KEYS.PRESTIGE]:   { oem: 200, used: 110 },
    [BAND_KEYS.LUXURY]:     { oem: 250, used: 140 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 250, used: 140 },
  },
  WINDSCREEN: {
    [BAND_KEYS.ECONOMY]:    { oem: 200, used: 110 },
    [BAND_KEYS.MID_RANGE]:  { oem: 200, used: 110 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 250, used: 140 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 300, used: 165 },
    [BAND_KEYS.PRESTIGE]:   { oem: 300, used: 165 },
    [BAND_KEYS.LUXURY]:     { oem: 375, used: 205 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 400, used: 220 },
  },
  REAR_GLASS: {
    [BAND_KEYS.ECONOMY]:    { oem: 180, used: 100 },
    [BAND_KEYS.MID_RANGE]:  { oem: 180, used: 100 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 225, used: 125 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 225, used: 125 },
    [BAND_KEYS.PRESTIGE]:   { oem: 275, used: 150 },
    [BAND_KEYS.LUXURY]:     { oem: 320, used: 175 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 365, used: 200 },
  },
  ROOF: {
    [BAND_KEYS.ECONOMY]:    { oem: 150, used:  85 },
    [BAND_KEYS.MID_RANGE]:  { oem: 150, used:  85 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 200, used: 110 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 250, used: 140 },
    [BAND_KEYS.PRESTIGE]:   { oem: 275, used: 150 },
    [BAND_KEYS.LUXURY]:     { oem: 300, used: 165 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 400, used: 220 },
  },
  WHEEL: {
    [BAND_KEYS.ECONOMY]:    { oem: 275, used: 150 },
    [BAND_KEYS.MID_RANGE]:  { oem: 275, used: 150 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 275, used: 150 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 365, used: 200 },
    [BAND_KEYS.PRESTIGE]:   { oem: 365, used: 200 },
    [BAND_KEYS.LUXURY]:     { oem: 455, used: 250 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 500, used: 275 },
  },
  TYRE: {
    [BAND_KEYS.ECONOMY]:    { oem:  50, used:  30 },
    [BAND_KEYS.MID_RANGE]:  { oem:  70, used:  40 },
    [BAND_KEYS.EXECUTIVE]:  { oem: 100, used:  55 },
    [BAND_KEYS.UPPER_EXEC]: { oem: 125, used:  70 },
    [BAND_KEYS.PRESTIGE]:   { oem: 150, used:  85 },
    [BAND_KEYS.LUXURY]:     { oem: 200, used: 110 },
    [BAND_KEYS.SUPER_LUX]:  { oem: 250, used: 140 },
  },
});
