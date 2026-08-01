// ─────────────────────────────────────────────────────────────────────────────
// Mileage / clocking check — pure, deterministic. From DVSA MOT history only
// (already pulled; no One Auto, no new cost). Full-timeline rollback detection.
// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE (Vincent, GY67LLD): DVSA readings can be recorded in DIFFERENT UNITS
// across a vehicle's history (some 'mi', some 'km'). Comparing raw odometer values
// across a unit switch FALSE-FLAGS a clean car (an 88,000 km reading looks like a
// rollback next to a later 60,000 mi one). So EVERY reading is normalised to miles
// BEFORE any comparison. km → mi via ×0.621371.

const KM_TO_MI = 0.621371;

// Parse a DVSA odometer value ("62,000", 62000, " 62000 mi") → integer miles-agnostic number, or null.
function parseOdometer(v) {
  if (v == null) return null;
  const n = String(v).replace(/[^\d.]/g, '');
  if (!n) return null;
  const f = parseFloat(n);
  return Number.isFinite(f) ? Math.round(f) : null;
}

// Normalise the unit string → 'km' | 'mi'. Missing/unknown defaults to 'mi' (DVSA GB default).
function normUnit(u) {
  const s = String(u || '').toLowerCase();
  if (s === 'km' || s.includes('kilomet')) return 'km';
  return 'mi';
}

// Parse a date that may be DVSA-formatted (DD/MM/YYYY) or ISO (YYYY-MM-DD / full ISO). Returns ms epoch or null.
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);          // DD/MM/YYYY
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);                 // YYYY-MM-DD[...]
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

const fmtDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
const fmtMi = (n) => `${Number(n).toLocaleString('en-GB')} mi`;

/**
 * checkMileageTimeline — rollback detection across the MOT history, unit-normalised.
 * @param {Array} motTests  DVSA tests: { odometerValue, odometerUnit, completedDate, testResult }.
 * @param {object} [opts]
 *   toleranceMiles  a later reading must fall MORE than this below an earlier one to flag
 *                   (absorbs km→mi conversion rounding + odometer granularity). Default 150.
 *   currentMileage / currentUnit  optional user-entered "now" reading — checked against the latest MOT.
 * @returns {{status:'consistent'|'discrepancy'|'insufficient', verdict:string, anomalies:Array,
 *            readings:Array, mixedUnits:boolean}}
 */
export function checkMileageTimeline(motTests, opts = {}) {
  const tol = opts.toleranceMiles ?? 150;
  const readings = (Array.isArray(motTests) ? motTests : [])
    .map((t) => {
      const raw = parseOdometer(t?.odometerValue);
      if (raw == null) return null;
      const unit = normUnit(t?.odometerUnit);
      const miles = unit === 'km' ? Math.round(raw * KM_TO_MI) : raw;
      const date = parseDate(t?.completedDate);
      return date == null ? null : { date, miles, raw, unit, result: t?.testResult ?? null };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date); // oldest → newest

  const anomalies = [];
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1], cur = readings[i];
    if (cur.miles < prev.miles - tol) {
      anomalies.push({
        fromDate: fmtDate(prev.date), fromMiles: prev.miles,
        toDate: fmtDate(cur.date),   toMiles: cur.miles,
        dropMiles: prev.miles - cur.miles,
      });
    }
  }

  // Optional: the user's entered current mileage vs the latest MOT reading (the old guard, unit-aware).
  if (opts.currentMileage != null) {
    const cur = parseOdometer(opts.currentMileage);
    const curMi = cur == null ? null : (normUnit(opts.currentUnit) === 'km' ? Math.round(cur * KM_TO_MI) : cur);
    const last = readings[readings.length - 1];
    if (curMi != null && last && curMi < last.miles - tol) {
      anomalies.push({
        fromDate: fmtDate(last.date), fromMiles: last.miles,
        toDate: 'entered', toMiles: curMi, dropMiles: last.miles - curMi, _userEntered: true,
      });
    }
  }

  const mixedUnits = new Set(readings.map((r) => r.unit)).size > 1;
  let status, verdict;
  if (readings.length < 2 && opts.currentMileage == null) {
    status = 'insufficient';
    verdict = 'Not enough MOT readings to check mileage consistency.';
  } else if (anomalies.length) {
    status = 'discrepancy';
    const a = anomalies[0];
    verdict = `⚠️ Mileage discrepancy — dropped from ${fmtMi(a.fromMiles)} (${a.fromDate}) to ${fmtMi(a.toMiles)} (${a.toDate}).`;
  } else {
    status = 'consistent';
    verdict = `✓ Mileage consistent across ${readings.length} MOT reading${readings.length === 1 ? '' : 's'}${mixedUnits ? ' (mixed mi/km, normalised)' : ''}.`;
  }

  return {
    status, verdict, anomalies, mixedUnits,
    readings: readings.map((r) => ({ date: fmtDate(r.date), miles: r.miles, unit: r.unit, raw: r.raw })),
  };
}
