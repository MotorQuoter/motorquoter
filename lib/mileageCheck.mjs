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
// Exported: lib/dvsa.js resolves the recorded unit at the boundary with this same parser, so casing
// ("MI"/"KM"/"Km") is handled in exactly one place. Do not introduce a second, stricter one.
export function normUnit(u) {
  const s = String(u || '').toLowerCase();
  if (s === 'km' || s.includes('kilomet')) return 'km';
  return 'mi';
}

// Normalise a DVSA odometer reading to integer miles, or null when it is not a genuine reading
// (absent / 0 / non-numeric). km → mi via KM_TO_MI. THIS IS THE SINGLE CONVERSION in the codebase —
// every consumer imports this rather than multiplying by 0.621371 locally. Applied once at the DVSA
// boundary (lib/dvsa.js → odometerMiles) so no downstream reader ever sees a raw, unit-ambiguous
// odometerValue. A 0 reading is a tester mis-entry, not "zero miles" → null (same rule the timeline uses).
export function toMiles(value, unit) {
  const raw = parseOdometer(value);
  if (raw == null || raw === 0) return null;
  return normUnit(unit) === 'km' ? Math.round(raw * KM_TO_MI) : raw;
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
// MOT-vs-MOT: a record disagreeing with ITSELF — the genuine clocking signal. Tight.
// 150mi absorbs MOT-station keying noise; genuine rollbacks run to thousands. DO NOT tighten toward
// zero — a mis-keyed MOT entry must never read as a clocking allegation against a vehicle (that is the
// exact failure mode this whole batch removed). Confirmed 150, Vincent 20 Aug.
export const MOT_ROLLBACK_TOLERANCE_MILES = 150;
// Entered-vs-MOT: a USER ESTIMATE, which people round to the nearest thousand. Generous, and pegged
// to the point the difference stops moving the valuation — Vincent, 20 Aug: "1,000 wouldn't have any
// material effect on value." At the old 150, someone typing 74,000 for a car reading 74,438 was
// warned for being approximately right.
export const ENTERED_VS_MOT_TOLERANCE_MILES = 1000;
// Entered ABOVE the last MOT is normal — miles driven since the test — so a flat gap is the wrong
// test (a car MOT'd in March reads thousands higher by August, honestly). What is implausible is the
// RATE: a transposed digit (74,438 → 174,438 in five months) implies ~20,000 mi/month. So query on
// implied miles-per-month, not on the gap. Confirmed 3,000/month (~36k/year), Vincent 20 Aug: UK
// average ~600–700 mi/month; a 3-year-old rep's car at 90k is ~2,500/mo, inside; transposition is
// ~20,000/mo, an order of magnitude clear.
// TRADE-OFF (by design, NOT a bug): 3,000/mo WILL query genuine taxi/PHV use (40–60k/yr = 3.3–5k/mo).
// That is deliberate — the asymmetry favours the tighter number. A taxi owner asked "is 180,000 right?"
// answers yes: one click. A transposed digit that slips through prices a paid valuation wrongly: a
// refund, or a customer acting on a bad figure. Change here only.
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
      // Prefer the boundary-normalised miles (lib/dvsa.js sets odometerMiles once, at the DVSA seam)
      // so a km reading is NEVER converted twice. Fall back to computing it here for callers that pass
      // un-normalised tests: fixtures, this validator, and rows cached before this change (no odometerMiles).
      const preNorm = t?.odometerMiles !== undefined;
      const raw = parseOdometer(preNorm ? (t?.odometerRecordedValue ?? t?.odometerValue) : t?.odometerValue);
      const unit = normUnit(preNorm ? (t?.odometerRecordedUnit ?? t?.odometerUnit) : t?.odometerUnit);
      let miles, na;
      if (preNorm) {
        miles = t.odometerMiles == null ? null : Math.round(t.odometerMiles);
        na = miles == null || miles === 0;                  // 0 / blank / null → not a real reading
      } else {
        na = raw == null || raw === 0;                      // 0 / blank / null → not a real reading
        miles = na ? null : (unit === 'km' ? Math.round(raw * KM_TO_MI) : raw);
      }
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

// batch 75 §2b — resolve a photo-odometer reading from the Haiku dash read, as a CROSS-CHECK against
// the listing figure rather than a discard. A cluster shot routinely shows odometer + trip + range;
// the old `uniq.length === 1 ? uniq[0] : NaN` gate threw a legible reading away whenever a second
// number appeared. Per assessmentEngine.js:24 the photo is the CROSS-CHECK, not the valuation basis:
//   • exactly one number                 → use it
//   • several, exactly ONE ≈ listing(±tol) → that IS the odometer (the rest were trip/range)
//   • several, none/ambiguous ≈ listing    → real divergence → { value:null, diverged:true } (flag, never silently drop)
//   • none, or several with no listing     → { value:null, diverged:false } (fall back to listing)
// PURE: no side effects; the caller sets the §24 divergence flag and the valuation source.
export const PHOTO_ODO_MATCH_TOLERANCE_MILES = 500;
export function resolvePhotoOdometerReading(uniqNumbers, listedMileage, tol = PHOTO_ODO_MATCH_TOLERANCE_MILES) {
  const uniq = Array.isArray(uniqNumbers) ? [...new Set(uniqNumbers.filter(n => Number.isFinite(n)))] : [];
  if (uniq.length === 0) return { value: null, diverged: false };
  if (uniq.length === 1) return { value: uniq[0], diverged: false };
  const listed = Number.isFinite(listedMileage) ? listedMileage : NaN;
  if (isNaN(listed)) return { value: null, diverged: false };   // multi-number, nothing to check against
  const matches = uniq.filter(n => Math.abs(n - listed) <= tol);
  if (matches.length === 1) return { value: matches[0], diverged: false };
  return { value: null, diverged: true };                       // none, or ambiguously several, match → divergence
}

// ── batch 248 B2 (Vincent, 18 Nov) — A MILEAGE FIGURE IN THE AUCTION NOTES IS COMPARED, NEVER DROPPED SILENTLY ──────────
// LC72NZV: the notes said "ODOMETER READING 20735"; the listing and the dash photo both read 95,139. The notes reader
// called the line spec, so it reached the buyer only under "Notes — as written". This is the one owner:
//   • the figure is read by CODE from the note text (never by a model);
//   • it is NEVER a mileage source — it does not raise _mileageSourceCount, feed the valuation mileage, or make the
//     Mileage slot "corroborated" (the route never passes it to countIndependentMileageSources / getMileageForValuation);
//   • it is compared with the listing figure (with no listing figure, the dash read), using the same tolerance the
//     dash-vs-listing discrepancy flag uses (DASH_LISTING_DIVERGENCE_MILES); agreement → no line;
//   • a disagreement gets one code-owned line (Red Flags + checklist, via lib/copartNotes.mjs stampCopartNotes) and
//     makes the Mileage slot "unconfirmed" (lib/mileageCorroboration.mjs).
import { notesConcernLead } from './copartNotes.mjs';

// The dash-vs-listing discrepancy threshold (route.js photoMileageFlag). One constant, read by both checks.
export const DASH_LISTING_DIVERGENCE_MILES = 3000;

// A note line that gives an odometer / mileage figure: a mileage word plus a number, either order. Digits may be grouped
// with a comma, a space or a full stop ("20,735", "20 735", "20.735"). A line with no figure ("VIEW FULL VEHICLE MILEAGE
// HISTORY VIA VEHICLE REPORT") is not a figure line. Kilometres are converted with toMiles (the one conversion).
const MILEAGE_WORD = String.raw`(?:ODOMETER|ODO|MILEAGE|MILAGE|MILES|MILE|CLOCKED|CLOCK|KM|KMS|KILOMET(?:RE|ER)S?)`;
const FIGURE = String.raw`(\d{1,3}(?:[,. ]\d{3})+|\d+)`;
const FIG_AFTER_WORD = new RegExp(String.raw`\b${MILEAGE_WORD}\b[^\d\n]{0,30}?${FIGURE}(?:\s*(KM|KMS|KILOMET(?:RE|ER)S?|MILES?|MI)\b)?`, 'i');
const FIG_BEFORE_WORD = new RegExp(String.raw`${FIGURE}\s*(MILES?|MI|KM|KMS|KILOMET(?:RE|ER)S?)\b`, 'i');
const isKm = (u) => /^K/i.test(u || '');

/** [{ line, miles }] — every note line that states an odometer / mileage figure, in note order. */
export function notesMileageFigures(lines) {
  const out = [];
  for (const line of lines || []) {
    const s = String(line ?? '');
    let m = s.match(FIG_AFTER_WORD), unit = null, num = null;
    if (m) {
      num = m[1];
      const word = (s.slice(m.index).match(new RegExp(`^${MILEAGE_WORD}`, 'i')) || [''])[0];
      unit = m[2] || (/^K/i.test(word) ? 'km' : null);
    } else if ((m = s.match(FIG_BEFORE_WORD))) { num = m[1]; unit = m[2]; }
    if (num == null) continue;
    const miles = toMiles(num.replace(/[,. ]/g, ''), isKm(unit) ? 'km' : 'mi');
    if (miles == null) continue;
    out.push({ line: s, miles });
  }
  return out;
}

const fmtN = (n) => Number(n).toLocaleString('en-GB');
const toNum = (v) => { const m = String(v ?? '').replace(/,/g, '').match(/\d+/); const n = m ? parseInt(m[0], 10) : NaN; return n >= 1 ? n : null; };

/**
 * The notes-mileage check. `listing` = the listing figure (number or "95,139" string), `dash` = the resolved dash-photo
 * read (number or null), `source` = copartNotes().source (wording only). Returns one entry per disagreeing note line:
 * { line, miles, against: 'listing'|'dash', text, reason } — `text` is the buyer line, `reason` the Mileage-slot detail.
 * Agreement (within tol), or nothing to compare against → no entry.
 */
export function notesMileageCheck(lines, { listing = null, dash = null, source = 'box', tol = DASH_LISTING_DIVERGENCE_MILES } = {}) {
  const L = toNum(listing), D = Number.isFinite(dash) && dash >= 1 ? dash : null;
  const ref = L ?? D;
  if (ref == null) return [];
  const out = [];
  for (const f of notesMileageFigures(lines)) {
    if (Math.abs(f.miles - ref) <= tol) continue;
    let what;
    if (L != null && D != null) what = Math.abs(L - D) <= tol
      ? `The listing and the dash photo both read ${fmtN(L)}.`
      : `The listing reads ${fmtN(L)}; the dash photo reads ${fmtN(D)}.`;
    else if (L != null) what = `The listing reads ${fmtN(L)}.`;
    else what = `The dash photo reads ${fmtN(D)}.`;
    out.push({
      line: f.line, miles: f.miles, against: L != null ? 'listing' : 'dash',
      text: `${notesConcernLead(f.line, source)} ${what}`,
      reason: `The auction notes give ${fmtN(f.miles)} miles ("${f.line}"); ${L != null ? `the listing reads ${fmtN(L)}` : `the dash photo reads ${fmtN(D)}`}. The mileage is not confirmed.`,
    });
  }
  return out;
}

// ── batch 252 C1/C2 (Vincent, 19 Nov) — A PROBABLE DASH MISREAD IS NOT A DISCREPANCY ─────────────────────────────────────
// GF25WHJ: listing 6,514, Haiku replied "66514" → "discrepancy of 60,000 miles", which was false. This is the one owner.
// When the dash read and the listing differ by more than DASH_LISTING_DIVERGENCE_MILES and EITHER
//   C1 the dash figure is the listing figure with one digit added, one digit dropped, two adjacent digits swapped, or a
//      tenths digit appended (dash / 10 within 1 of the listing — a "4709.5"-style read as 47095), OR
//   C2 the listing and the last MOT agree: the listing is at or above the last MOT (the route's existing MOT sanity rule,
//      route.js "photo < last MOT → falling back", applied to the listing) by a plausible step — at most
//      MOT_STEP_MILES_PER_YEAR per year since that MOT (a whole year at least; 2× the 15,000-mile/year age estimate in
//      lib/getMileageForValuation.js), or at most one year's step when no MOT date is held,
// the photo reading is treated as ABSENT: the route sets photoOdometer = null (so no photoMileageFlag, no slot
// "discrepancy", no PHOTO MILEAGE DISCREPANCY line to Call 1/2) and prints misreadText() where the flag used to print.
// It never sets a discrepancy or "unconfirmed" on its own: the slot verdict is whatever the remaining sources give.
export const MOT_STEP_MILES_PER_YEAR = 30000;

/** The Haiku reply's numbers, from its LAST non-empty line only — prose above it ("…in the 10th image…") adds nothing. */
export function odometerReplyNumbers(raw) {
  const lines = String(raw ?? '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return [...new Set((last.replace(/,/g, '').match(/\d+/g) || []).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 999999))];
}

/** C1: 'digit added' | 'digit dropped' | 'adjacent digits swapped' | 'tenths digit appended' | null. Pure. */
export function digitSlip(dash, listing) {
  const d = String(dash), l = String(listing);
  if (!/^\d+$/.test(d) || !/^\d+$/.test(l) || d === l) return null;
  const oneDeleted = (long, short) => long.length === short.length + 1 && [...long].some((_, i) => long.slice(0, i) + long.slice(i + 1) === short);
  if (oneDeleted(d, l)) return 'digit added';
  if (oneDeleted(l, d)) return 'digit dropped';
  if (d.length === l.length) {
    const at = [...d].map((c, i) => (c !== l[i] ? i : -1)).filter(i => i >= 0);
    if (at.length === 2 && at[1] === at[0] + 1 && d[at[0]] === l[at[1]] && d[at[1]] === l[at[0]]) return 'adjacent digits swapped';
  }
  if (Math.abs(Number(d) / 10 - Number(l)) <= 1) return 'tenths digit appended';
  return null;
}

/** The most recent MOT test date (ms) from a DVSA motHistory array (completedDate "dd/mm/yyyy" or ISO), or null. */
export function lastMotDateMs(motHistory) {
  const t = Array.isArray(motHistory) ? motHistory : (Array.isArray(motHistory?.motTests) ? motHistory.motTests : []);
  let best = null;
  for (const x of t) {
    const s = String(x?.completedDate ?? '');
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    const ms = m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : Date.parse(s);
    if (Number.isFinite(ms) && (best == null || ms > best)) best = ms;
  }
  return best;
}

/** C2: the listing sits at or above the last MOT by a plausible step. */
export function listingAgreesWithMot(listing, lastMot, lastMotMs = null, now = Date.now()) {
  const L = toNum(listing), M = toNum(lastMot);
  if (L == null || M == null || L < M) return false;
  const years = Number.isFinite(lastMotMs) ? Math.max(1, (now - lastMotMs) / (365.25 * 24 * 3600 * 1000)) : 1;
  return L - M <= MOT_STEP_MILES_PER_YEAR * years;
}

export function misreadText(dash, listing) {
  return `The dash photo could not be read reliably (it reads as ${fmtN(dash)} against a listed ${fmtN(listing)}). Check the odometer on inspection.`;
}

/** null, or { reason, rule: 'C1'|'C2', dash, listing, text } — the route then treats the photo reading as absent. */
export function photoOdometerMisread({ dash, listing, lastMot = null, lastMotMs = null, now = Date.now(), tol = DASH_LISTING_DIVERGENCE_MILES } = {}) {
  const L = toNum(listing);
  if (L == null || !Number.isFinite(dash) || dash < 1 || Math.abs(dash - L) <= tol) return null;
  const slip = digitSlip(dash, L);
  if (slip) return { reason: slip, rule: 'C1', dash, listing: L, text: misreadText(dash, L) };
  if (listingAgreesWithMot(L, lastMot, lastMotMs, now)) return { reason: 'listing and last MOT agree', rule: 'C2', dash, listing: L, text: misreadText(dash, L) };
  return null;
}
