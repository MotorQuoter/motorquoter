// Price-band deriver — maps Brego trade_average_valuation to one of seven band keys.
// Source: Vincent trade-knowledge price grid, Jun 2026.
//
// Boundary rule: a value exactly on a boundary belongs to the LOWER band.
//   £5,000 = economy   £5,001 = mid-range
//   £10,000 = mid-range  £10,001 = executive   (etc.)
//
// The BAND_THRESHOLDS array encodes this directly: each ceiling is the top of its band,
// so a value <= ceiling falls into that band. The first matching ceiling wins.

const BAND_THRESHOLDS = [
  [5000,  'economy'],
  [10000, 'mid-range'],
  [15000, 'executive'],
  [20000, 'upper-exec'],
  [25000, 'prestige'],
  [40000, 'luxury'],
];

export const PRICE_BAND_KEYS = Object.freeze([
  'economy', 'mid-range', 'executive', 'upper-exec', 'prestige', 'luxury', 'super-lux',
]);

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
  return 'super-lux';
}

// PANEL_PRICE_TABLE — added in Commit 2 once Vincent's grid figures are transcribed.
// Shape: panelId → bandKey → { oem: number, used: number }
// 22 panels (HEADLAMP and GRILLE excluded — those keep their existing code-owned logic).
