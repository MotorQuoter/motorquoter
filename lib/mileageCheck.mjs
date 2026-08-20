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
  // Keep every dated test as a timeline row, but a 0 / null / blank odometer is a tester mis-entry,
  // NOT a genuine reading (e.g. S50VNY's 2020 MOT recorded 0 mi on a 19-year-old bike). Such a row
  // is marked N/A: shown in the timeline, but EXCLUDED from the rollback comparison and the tally,
  // so it can never masquerade as a rollback or inflate the reading count.
  const readings = (Array.isArray(motTests) ? motTests : [])
    .map((t) => {
      const date = parseDate(t?.completedDate);
      if (date == null) return null;                        // no date → can't place → drop
      const raw = parseOdometer(t?.odometerValue);
      const unit = normUnit(t?.odometerUnit);
      const na = raw == null || raw === 0;                  // 0 / blank / null → not a real reading
      const miles = na ? null : (unit === 'km' ? Math.round(raw * KM_TO_MI) : raw);
      return { date, miles, raw, unit, na, result: t?.testResult ?? null };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date); // oldest → newest

  // Genuine readings only drive the comparison + tally — N/A rows are skipped, so a 0-mile
  // mis-entry sitting between two real readings never reads as a rollback.
  const genuine = readings.filter((r) => !r.na);

  const anomalies = [];
  for (let i = 1; i < genuine.length; i++) {
    const prev = genuine[i - 1], cur = genuine[i];
    if (cur.miles < prev.miles - tol) {
      anomalies.push({
        fromDate: fmtDate(prev.date), fromMiles: prev.miles,
        toDate: fmtDate(cur.date),   toMiles: cur.miles,
        dropMiles: prev.miles - cur.miles,
      });
    }
  }

  // Optional: the user's entered current mileage vs the latest GENUINE MOT reading (unit-aware).
  if (opts.currentMileage != null) {
    const cur = parseOdometer(opts.currentMileage);
    const curMi = cur == null ? null : (normUnit(opts.currentUnit) === 'km' ? Math.round(cur * KM_TO_MI) : cur);
    const last = genuine[genuine.length - 1];
    if (curMi != null && last && curMi < last.miles - tol) {
      anomalies.push({
        fromDate: fmtDate(last.date), fromMiles: last.miles,
        toDate: 'entered', toMiles: curMi, dropMiles: last.miles - curMi, _userEntered: true,
      });
    }
  }

  const mixedUnits = new Set(genuine.map((r) => r.unit)).size > 1;
  const readingCount = genuine.length;
  // Two very different anomalies share this array and MUST NOT read the same. An MOT reading below an
  // earlier MOT reading is a genuine rollback indicator (serious). The user's own entered figure being
  // below the last MOT is almost always a typo — telling a customer their car may be clocked on the
  // strength of their own estimate is a false accusation. Both are flagged (status 'discrepancy', so
  // every surface shows a warning), but the wording names which one it is.
  const rollbacks = anomalies.filter((a) => !a._userEntered);
  const enteredAnom = anomalies.find((a) => a._userEntered) || null;
  const hasRollback = rollbacks.length > 0;
  const enteredBelowMot = enteredAnom != null;

  let status, verdict;
  if (readingCount < 2 && opts.currentMileage == null) {
    status = 'insufficient';
    verdict = 'Not enough MOT readings to check mileage consistency.';
  } else if (hasRollback) {
    status = 'discrepancy';
    const a = rollbacks[0];
    verdict = `⚠️ Mileage discrepancy — dropped from ${fmtMi(a.fromMiles)} (${a.fromDate}) to ${fmtMi(a.toMiles)} (${a.toDate}).`;
  } else if (enteredBelowMot) {
    status = 'discrepancy';
    const a = enteredAnom;
    verdict = `⚠️ The mileage you entered (${fmtMi(a.toMiles)}) is lower than the most recent MOT reading (${fmtMi(a.fromMiles)} on ${a.fromDate}). Please double-check — this is usually a typo, not a sign the vehicle has been clocked.`;
  } else {
    status = 'consistent';
    verdict = `✓ Mileage consistent across ${readingCount} MOT reading${readingCount === 1 ? '' : 's'}${mixedUnits ? ' (mixed mi/km, normalised)' : ''}.`;
  }

  return {
    status, verdict, anomalies, mixedUnits, readingCount, hasRollback, enteredBelowMot,
    readings: readings.map((r) => ({ date: fmtDate(r.date), miles: r.na ? null : r.miles, unit: r.unit, raw: r.raw, na: r.na })),
  };
}
