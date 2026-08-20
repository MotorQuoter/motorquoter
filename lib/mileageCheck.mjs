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
// ── Mileage tolerances — TWO comparisons, TWO thresholds, because they are not the same evidence ──
// Any threshold that changes what a customer is told is a product decision: named, declared once,
// documented, and boundary-tested. Both the free verdict and the paid detail read these same
// constants because both call checkMileageTimeline — there is no second copy.
//
// MOT-vs-MOT: a record disagreeing with ITSELF — the genuine clocking signal. Tight. 150 mi is the
// value that has always been in force (was a single shared `tol`); left unchanged pending Vincent's
// review of a tighter number for this comparison specifically.
export const MOT_ROLLBACK_TOLERANCE_MILES = 150;
// Entered-vs-MOT: a USER ESTIMATE, which people round to the nearest thousand. Generous, and pegged
// to the point the difference stops moving the valuation — Vincent, 20 Aug: "1,000 wouldn't have any
// material effect on value." At the old 150, someone typing 74,000 for a car reading 74,438 was
// warned for being approximately right.
export const ENTERED_VS_MOT_TOLERANCE_MILES = 1000;
// Entered ABOVE the last MOT is normal — miles driven since the test — so a flat gap is the wrong
// test (a car MOT'd in March reads thousands higher by August, honestly). What is implausible is the
// RATE: a transposed digit (74,438 → 174,438 in five months) implies ~20,000 mi/month. So query on
// implied miles-per-month, not on the gap. ⚠️ PROPOSED value pending Vincent — see the handoff: UK
// average is ~600–700 mi/month; heavy commercial runs a few thousand. 3,000/month (~36k/year) clears
// genuine high-mileage drivers while catching a transposed digit or a gross typo. Change here only.
export const ENTERED_IMPLIED_USAGE_QUERY_PER_MONTH = 3000;

export function checkMileageTimeline(motTests, opts = {}) {
  const rollbackTol = opts.toleranceMiles ?? MOT_ROLLBACK_TOLERANCE_MILES;
  const enteredTol = opts.enteredToleranceMiles ?? ENTERED_VS_MOT_TOLERANCE_MILES;
  const usageQueryPerMonth = opts.enteredUsagePerMonth ?? ENTERED_IMPLIED_USAGE_QUERY_PER_MONTH;
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
    if (cur.miles < prev.miles - rollbackTol) {
      anomalies.push({
        fromDate: fmtDate(prev.date), fromMiles: prev.miles,
        toDate: fmtDate(cur.date),   toMiles: cur.miles,
        dropMiles: prev.miles - cur.miles,
      });
    }
  }

  // Optional: the user's entered current mileage vs the latest GENUINE MOT reading (unit-aware). This
  // is NOT clocking detection — the entered figure feeds the VALUATION, so the purpose is to catch a
  // wrong figure before it prices the car. Two asymmetric checks:
  //   • BELOW the last MOT by more than the tolerance → impossible (odometers don't run backwards);
  //     query. HARD FLOOR.
  //   • ABOVE the last MOT at an implausible implied monthly rate → likely a typo/transposed digit;
  //     query. SOFT CEILING on rate, not gap.
  // Both are neutral "please confirm this figure" queries, never a clocking allegation.
  if (opts.currentMileage != null) {
    const cur = parseOdometer(opts.currentMileage);
    const curMi = cur == null ? null : (normUnit(opts.currentUnit) === 'km' ? Math.round(cur * KM_TO_MI) : cur);
    const last = genuine[genuine.length - 1];
    if (curMi != null && last) {
      if (curMi < last.miles - enteredTol) {
        anomalies.push({
          fromDate: fmtDate(last.date), fromMiles: last.miles,
          toDate: 'entered', toMiles: curMi, dropMiles: last.miles - curMi, _userEntered: true, _enteredBelow: true,
        });
      } else if (curMi > last.miles) {
        const asOf = opts.asOf ?? Date.now();
        const monthsSince = Math.max((asOf - last.date) / (1000 * 60 * 60 * 24 * 30.44), 0.5); // floor 0.5mo
        const impliedPerMonth = (curMi - last.miles) / monthsSince;
        if (impliedPerMonth > usageQueryPerMonth) {
          anomalies.push({
            fromDate: fmtDate(last.date), fromMiles: last.miles,
            toDate: 'entered', toMiles: curMi, gainMiles: curMi - last.miles,
            impliedPerMonth: Math.round(impliedPerMonth), _userEntered: true, _enteredAbove: true,
          });
        }
      }
    }
  }

  const mixedUnits = new Set(genuine.map((r) => r.unit)).size > 1;
  const readingCount = genuine.length;
  // Two very different anomalies share this array and MUST NOT read the same. An MOT reading below an
  // earlier MOT reading is a genuine rollback indicator (serious). The user's own entered figure being
  // below the last MOT is almost always a typo — telling a customer their car may be clocked on the
  // strength of their own estimate is a false accusation. Both are flagged (status 'discrepancy', so
  // every surface shows a warning), but the wording names which one it is.
  // Three distinct outcomes, three distinct meanings — they MUST NOT read the same:
  //   'discrepancy' — an MOT reading below an EARLIER MOT reading. A record disagreeing with itself:
  //                   the genuine clocking signal. Warning styling, its own tight tolerance.
  //   'query'       — the user's OWN entered figure looks off (below the last MOT, or an implausible
  //                   implied usage above it). Not an allegation — a "please confirm, this values the
  //                   car" prompt. Neutral styling, never implies clocking.
  //   'consistent'  — nothing to flag.
  const rollbacks = anomalies.filter((a) => !a._userEntered);
  const enteredAnom = anomalies.find((a) => a._userEntered) || null;
  const hasRollback = rollbacks.length > 0;
  const enteredQuery = enteredAnom != null;
  const enteredBelowMot = !!enteredAnom?._enteredBelow;
  const enteredAboveRate = !!enteredAnom?._enteredAbove;

  let status, verdict;
  if (readingCount < 2 && opts.currentMileage == null) {
    status = 'insufficient';
    verdict = 'Not enough MOT readings to check mileage consistency.';
  } else if (hasRollback) {
    status = 'discrepancy';
    const a = rollbacks[0];
    verdict = `⚠️ Mileage discrepancy — dropped from ${fmtMi(a.fromMiles)} (${a.fromDate}) to ${fmtMi(a.toMiles)} (${a.toDate}).`;
  } else if (enteredBelowMot) {
    status = 'query';
    const a = enteredAnom;
    verdict = `This figure is used to value the car — is it right? You entered ${fmtMi(a.toMiles)}; the most recent MOT reading was ${fmtMi(a.fromMiles)} on ${a.fromDate}.`;
  } else if (enteredAboveRate) {
    status = 'query';
    const a = enteredAnom;
    verdict = `This figure is used to value the car — is it right? You entered ${fmtMi(a.toMiles)}, about ${fmtMi(a.impliedPerMonth)}/month since the last MOT reading of ${fmtMi(a.fromMiles)} on ${a.fromDate}.`;
  } else {
    status = 'consistent';
    verdict = `✓ Mileage consistent across ${readingCount} MOT reading${readingCount === 1 ? '' : 's'}${mixedUnits ? ' (mixed mi/km, normalised)' : ''}.`;
  }

  return {
    status, verdict, anomalies, mixedUnits, readingCount, hasRollback, enteredQuery, enteredBelowMot, enteredAboveRate,
    readings: readings.map((r) => ({ date: fmtDate(r.date), miles: r.na ? null : r.miles, unit: r.unit, raw: r.raw, na: r.na })),
  };
}
